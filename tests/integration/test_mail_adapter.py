"""IMAP 轮询与 SMTP 发送适配器的真实边界集成测试。

测试在本地起真实的 IMAP/SMTP 服务端（socket 层，讲够用的真实协议），让适配器
通过标准库 ``imaplib``/``smtplib`` 真实完成认证、拉取、解析、发送与落库；不
打桩标准库，也不直接调用内部函数替代边界。

覆盖验收点：

- 授权码认证成功与失败（``MailAuthenticationError``）；
- ``poll_once`` 重复执行按 Message-ID 幂等，不重复登记；
- 含附件邮件只记录元数据、不解析内容，附件文件名不参与需求关联；
- 无法解析（缺 Message-ID）与非需求邮件不被纳入，并在报告中可观测；
- 发送失败抛 ``MailSendError``，不静默丢弃也不落库；
- 出向反馈邮件把自身 ``Message-ID`` 交给 ``MailThreadStore`` 落库，供线索关联。
"""

from __future__ import annotations

import base64
import socketserver
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime

import pytest

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    ImapSettings,
    InboundMail,
    MailAdapter,
    MailAuthenticationError,
    MailParseError,
    MailSendError,
    SmtpMailSender,
    SmtpSettings,
    parse_inbound,
)
from forgeloop.domain.mail import Attachment, MailReply, parse_reply_reference
from forgeloop.records.mail_threads import MailThreadStore

pytestmark = pytest.mark.integration

REQ = "req-20261016071651-c4f6e4"
OTHER_REQ = "req-20261016120000-abcdef"
USERNAME = "owner@example.com"
SECRET = "app-specific-password"
RECIPIENT = "owner@example.com"
WHEN = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)


# --------------------------------------------------------------------------- #
# 假的服务端：真实 socket，讲出 imaplib / smtplib 需要的最小真实协议
# --------------------------------------------------------------------------- #


def _imap_tokens(text: str) -> list[str]:
    """把一行 IMAP 命令切成 token，处理双引号与反斜杠转义。"""

    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == '"':
            index += 1
            buffer: list[str] = []
            while index < len(text) and text[index] != '"':
                if text[index] == "\\" and index + 1 < len(text):
                    index += 1
                buffer.append(text[index])
                index += 1
            index += 1
            tokens.append("".join(buffer))
        elif char == " ":
            index += 1
        else:
            start = index
            while index < len(text) and text[index] != " ":
                index += 1
            tokens.append(text[start:index])
    return tokens


class _ImapHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.wfile.write(b"* OK IMAP4rev1 ready\r\n")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if not text:
                continue
            parts = _imap_tokens(text)
            tag = parts[0]
            command = parts[1].upper() if len(parts) > 1 else ""
            args = parts[2:]
            self.server.commands.append((command, tuple(args)))  # type: ignore[attr-defined]
            if command == "LOGIN":
                self._handle_login(tag, args)
            elif command == "CAPABILITY":
                self.wfile.write(b"* CAPABILITY IMAP4rev1\r\n")
                self.wfile.write(f"{tag} OK CAPABILITY completed\r\n".encode())
            elif command == "SELECT":
                count = len(self.server.messages)  # type: ignore[attr-defined]
                self.wfile.write(f"* {count} EXISTS\r\n".encode())
                self.wfile.write(b"* 0 RECENT\r\n")
                self.wfile.write(f"{tag} OK [READ-WRITE] SELECT completed\r\n".encode())
            elif command == "SEARCH":
                numbers = " ".join(
                    str(index)
                    for index in range(1, len(self.server.messages) + 1)  # type: ignore[attr-defined]
                )
                self.wfile.write(f"* SEARCH {numbers}\r\n".encode())
                self.wfile.write(f"{tag} OK SEARCH completed\r\n".encode())
            elif command == "FETCH":
                self._handle_fetch(tag, args)
            elif command == "LOGOUT":
                self.wfile.write(b"* BYE logging out\r\n")
                self.wfile.write(f"{tag} OK LOGOUT completed\r\n".encode())
                return
            else:
                self.wfile.write(f"{tag} OK {command} completed\r\n".encode())

    def _handle_login(self, tag: str, args: list[str]) -> None:
        username = args[0] if args else ""
        password = args[1] if len(args) > 1 else ""
        self.server.logins.append((username, password))  # type: ignore[attr-defined]
        accepted = (
            not self.server.fail_auth  # type: ignore[attr-defined]
            and username == self.server.username  # type: ignore[attr-defined]
            and password == self.server.password  # type: ignore[attr-defined]
        )
        response = "OK LOGIN completed" if accepted else "NO LOGIN failed"
        self.wfile.write(f"{tag} {response}\r\n".encode())

    def _handle_fetch(self, tag: str, args: list[str]) -> None:
        number = int(args[0])
        raw = self.server.messages[number - 1]  # type: ignore[attr-defined]
        prefix = f"* {number} FETCH (BODY[] {{{len(raw)}}}\r\n"
        self.wfile.write(prefix.encode())
        self.wfile.write(raw)
        self.wfile.write(b")\r\n")
        self.wfile.write(f"{tag} OK FETCH completed\r\n".encode())


class _ImapServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[socketserver.BaseRequestHandler],
        *,
        messages: list[bytes],
        username: str,
        password: str,
        fail_auth: bool,
    ) -> None:
        super().__init__(address, handler)
        self.messages = list(messages)
        self.username = username
        self.password = password
        self.fail_auth = fail_auth
        self.commands: list[tuple[str, tuple[str, ...]]] = []
        self.logins: list[tuple[str, str]] = []


class _SmtpHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.wfile.write(b"220 forgeloop-test ESMTP\r\n")
        data_mode = False
        data_lines: list[bytes] = []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            if data_mode:
                if line in (b".\r\n", b".\n"):
                    data_mode = False
                    self.server.messages.append(b"".join(data_lines))  # type: ignore[attr-defined]
                    self.wfile.write(b"250 OK queued\r\n")
                    continue
                if line.startswith(b".."):
                    line = line[1:]
                data_lines.append(line)
                continue
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            command = text.split(" ", 1)[0].upper()
            rest = text.split(" ", 1)[1] if " " in text else ""
            if command in ("EHLO", "HELO"):
                self.wfile.write(b"250-forgeloop-test\r\n")
                self.wfile.write(b"250-AUTH PLAIN\r\n")
                self.wfile.write(b"250 SIZE 10485760\r\n")
            elif command == "AUTH":
                self._handle_auth(rest)
            elif command == "MAIL":
                if self.server.fail_mail:  # type: ignore[attr-defined]
                    self.wfile.write(b"550 sender rejected\r\n")
                else:
                    self.wfile.write(b"250 OK\r\n")
            elif command == "RCPT":
                self.wfile.write(b"250 OK\r\n")
            elif command == "DATA":
                self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                data_mode = True
                data_lines = []
            elif command == "QUIT":
                self.wfile.write(b"221 Bye\r\n")
                return
            else:
                self.wfile.write(b"250 OK\r\n")

    def _handle_auth(self, rest: str) -> None:
        """支持 smtplib 默认的 ``AUTH PLAIN <base64>`` 初始响应形式。"""

        tokens = rest.split(" ", 1)
        mechanism = tokens[0].upper() if tokens else ""
        if mechanism != "PLAIN" or len(tokens) < 2:
            self.wfile.write(b"504 Unrecognized authentication type\r\n")
            return
        try:
            decoded = base64.b64decode(tokens[1]).decode("utf-8", "replace")
            _, username, password = decoded.split("\x00", 2)
        except (ValueError, UnicodeError):
            self.wfile.write(b"535 Authentication failed\r\n")
            return
        self.server.auth_attempts.append((username, password))  # type: ignore[attr-defined]
        accepted = (
            username == self.server.username  # type: ignore[attr-defined]
            and password == self.server.password  # type: ignore[attr-defined]
        )
        if accepted:
            self.server.authenticated = True  # type: ignore[attr-defined]
            self.wfile.write(b"235 Authentication successful\r\n")
        else:
            self.wfile.write(b"535 Authentication failed\r\n")


class _SmtpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[socketserver.BaseRequestHandler],
        *,
        fail_mail: bool,
        username: str,
        password: str,
    ) -> None:
        super().__init__(address, handler)
        self.messages: list[bytes] = []
        self.fail_mail = fail_mail
        self.username = username
        self.password = password
        self.auth_attempts: list[tuple[str, str]] = []
        self.authenticated = False


@contextmanager
def serve_imap(
    messages: list[bytes],
    *,
    username: str = USERNAME,
    password: str = SECRET,
    fail_auth: bool = False,
) -> Iterator[tuple[str, int, _ImapServer]]:
    server = _ImapServer(
        ("127.0.0.1", 0),
        _ImapHandler,
        messages=messages,
        username=username,
        password=password,
        fail_auth=fail_auth,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = str(server.server_address[0]), int(server.server_address[1])
    try:
        yield host, port, server
    finally:
        server.shutdown()
        server.server_close()


@contextmanager
def serve_smtp(
    *,
    fail_mail: bool = False,
    username: str = USERNAME,
    password: str = SECRET,
) -> Iterator[tuple[str, int, _SmtpServer]]:
    server = _SmtpServer(
        ("127.0.0.1", 0),
        _SmtpHandler,
        fail_mail=fail_mail,
        username=username,
        password=password,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = str(server.server_address[0]), int(server.server_address[1])
    try:
        yield host, port, server
    finally:
        server.shutdown()
        server.server_close()


# --------------------------------------------------------------------------- #
# 邮件构造、记录接缝与适配器装配
# --------------------------------------------------------------------------- #


def build_message(
    message_id: str | None,
    *,
    subject: str = "",
    body: str = "",
    sender: str = "user@example.com",
    in_reply_to: str | None = None,
    references: tuple[str, ...] = (),
    attachment: tuple[str, bytes] | None = None,
    date: datetime = WHEN,
    auto_submitted: str | None = None,
) -> bytes:
    message = EmailMessage()
    if message_id is not None:
        message["Message-ID"] = message_id
    message["From"] = sender
    message["To"] = USERNAME
    message["Subject"] = subject
    message["Date"] = format_datetime(date)
    if in_reply_to is not None:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = " ".join(references)
    if auto_submitted is not None:
        message["Auto-Submitted"] = auto_submitted
    message.set_content(body)
    if attachment is not None:
        filename, content = attachment
        message.add_attachment(
            content, maintype="application", subtype="octet-stream", filename=filename
        )
    return message.as_bytes()


def resolve_requirement(mail: InboundMail) -> str | None:
    """用领域规则把入向邮件关联到需求编号（适配器不内建领域规则）。"""

    reply = MailReply(
        received_at=mail.received_at,
        in_reply_to=mail.in_reply_to,
        references=mail.references,
        subject=mail.subject,
        body=mail.body,
        attachments=tuple(
            Attachment(attachment.filename, attachment.content_type, attachment.size_bytes)
            for attachment in mail.attachments
        ),
    )
    return parse_reply_reference(reply)


def make_recorder(store: MailThreadStore):
    def record_inbound(mail: InboundMail, req_id: str) -> bool:
        return store.record_inbound(
            mail.message_id,
            req_id,
            mail.received_at,
            sender=mail.sender,
            subject=mail.subject,
            folder=mail.folder,
        ).created

    def record_outbound(message_id: str, req_id: str, kind: str, sent_at: datetime) -> bool:
        return store.record_outbound(message_id, req_id, kind, sent_at).created

    return record_inbound, record_outbound


@pytest.fixture
def store() -> Iterator[MailThreadStore]:
    connection = sqlite3.connect(":memory:")
    connection.isolation_level = None
    thread_store = MailThreadStore(connection)
    yield thread_store
    connection.close()


@contextmanager
def running_mail(
    store: MailThreadStore,
    *,
    messages: list[bytes],
    imap_secret: str = SECRET,
    imap_user: str = USERNAME,
    imap_fail_auth: bool = False,
    smtp_secret: str = SECRET,
    smtp_fail_mail: bool = False,
) -> Iterator[tuple[MailAdapter, _ImapServer, _SmtpServer]]:
    with (
        serve_imap(
            messages,
            username=imap_user,
            password=SECRET,
            fail_auth=imap_fail_auth,
        ) as (imap_host, imap_port, imap_server),
        serve_smtp(fail_mail=smtp_fail_mail) as (smtp_host, smtp_port, smtp_server),
    ):
        receiver = ImapMailReceiver(
            ImapSettings(
                host=imap_host,
                port=imap_port,
                username=imap_user,
                secret=imap_secret,
                use_ssl=False,
            )
        )
        sender = SmtpMailSender(
            SmtpSettings(
                host=smtp_host,
                port=smtp_port,
                username=USERNAME,
                secret=smtp_secret,
                sender=USERNAME,
                recipient=RECIPIENT,
                use_ssl=False,
            )
        )
        record_inbound, record_outbound = make_recorder(store)
        adapter = MailAdapter(
            receiver,
            sender,
            resolve_requirement=resolve_requirement,
            record_inbound=record_inbound,
            record_outbound=record_outbound,
            now=lambda: WHEN,
        )
        try:
            yield adapter, imap_server, smtp_server
        finally:
            adapter.close()


# --------------------------------------------------------------------------- #
# 用例
# --------------------------------------------------------------------------- #


class TestAuthentication:
    def test_authorization_code_login_succeeds(self) -> None:
        with serve_imap([]) as (host, port, server):
            receiver = ImapMailReceiver(
                ImapSettings(host=host, port=port, username=USERNAME, secret=SECRET, use_ssl=False)
            )
            try:
                receiver.authenticate()
                assert server.logins == [(USERNAME, SECRET)]
            finally:
                receiver.close()

    def test_wrong_authorization_code_fails_loudly(self) -> None:
        with serve_imap([]) as (host, port, _server):
            receiver = ImapMailReceiver(
                ImapSettings(
                    host=host,
                    port=port,
                    username=USERNAME,
                    secret="wrong-code",
                    use_ssl=False,
                )
            )
            with pytest.raises(MailAuthenticationError, match="IMAP 认证失败"):
                receiver.authenticate()
            receiver.close()

    def test_poll_with_wrong_code_raises_authentication_error(self, store: MailThreadStore) -> None:
        with (
            running_mail(
                store,
                messages=[],
                imap_fail_auth=True,
                imap_secret="wrong-code",
            ) as (adapter, _imap, _smtp),
            pytest.raises(MailAuthenticationError),
        ):
            adapter.poll_once()


class TestPollOnce:
    def test_requirement_mail_is_registered_and_linked(self, store: MailThreadStore) -> None:
        raw = build_message(
            "<in-1@example.com>",
            subject=f"[ForgeLoop][{REQ}] 新需求",
            body="请实现邮件闭环",
        )
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.fetched == 1
        assert report.registered == 1
        assert report.errors == ()
        result = report.results[0]
        assert result.registered is True
        assert result.req_id == REQ
        assert store.inbound(REQ)[0].message_id == "<in-1@example.com>"

    def test_repeated_poll_is_idempotent_by_message_id(self, store: MailThreadStore) -> None:
        raw = build_message(
            "<in-1@example.com>",
            subject=f"[ForgeLoop][{REQ}] 新需求",
            body="请实现邮件闭环",
        )
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            first = adapter.poll_once()
            second = adapter.poll_once()

        assert first.registered == 1
        assert second.registered == 0
        assert second.results[0].registered is False
        assert "重复" in second.results[0].reason
        assert len(store.inbound(REQ)) == 1
        assert len(store.trace(REQ).inbound) == 1

    def test_association_falls_back_from_headers_to_body(self, store: MailThreadStore) -> None:
        header_reply = build_message(
            "<in-1@example.com>", in_reply_to=f"<{REQ}@forgeloop.local>", body="补充说明"
        )
        body_reply = build_message(
            "<in-2@example.com>", subject="无编号", body=f"见 {REQ} 的上下文"
        )
        with running_mail(store, messages=[header_reply, body_reply]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.registered == 2
        assert {result.req_id for result in report.results} == {REQ}
        assert {record.message_id for record in store.inbound(REQ)} == {
            "<in-1@example.com>",
            "<in-2@example.com>",
        }

    def test_non_requirement_mail_is_not_admitted_but_observable(
        self, store: MailThreadStore
    ) -> None:
        raw = build_message("<in-9@example.com>", subject="闲聊", body="与需求无关")
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.registered == 0
        assert len(report.skipped) == 1
        assert report.skipped[0].message_id == "<in-9@example.com>"
        assert "未关联到需求" in report.skipped[0].reason
        assert store.inbound(REQ) == ()

    def test_unparseable_mail_is_reported_and_not_admitted(self, store: MailThreadStore) -> None:
        raw = b"From: user@example.com\r\nSubject: no message id\r\n\r\nbody"
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.fetched == 1
        assert report.registered == 0
        assert report.results == ()
        assert len(report.errors) == 1
        assert "无法解析" in report.errors[0]
        assert store.trace(REQ).inbound == ()


class TestAttachments:
    def test_attachment_metadata_is_recorded_without_parsing_content(self) -> None:
        raw = build_message(
            "<in-3@example.com>",
            subject=f"[ForgeLoop][{REQ}] 需求",
            body="正文没有附件内容",
            attachment=("设计说明.pdf", b"attachment-secret-bytes"),
        )
        parsed = parse_inbound(raw, folder="INBOX", default_received_at=WHEN)

        assert len(parsed.attachments) == 1
        attachment = parsed.attachments[0]
        assert attachment.filename == "设计说明.pdf"
        assert attachment.content_type == "application/octet-stream"
        assert attachment.size_bytes == len(b"attachment-secret-bytes")
        # 附件内容不进入正文，也不被任何解析环节读出。
        assert "attachment-secret-bytes" not in parsed.body

    def test_attachment_filename_does_not_create_requirement_link(
        self, store: MailThreadStore
    ) -> None:
        raw = build_message(
            "<in-4@example.com>",
            subject="普通邮件",
            body="正文没有需求编号",
            attachment=(f"{OTHER_REQ}-notes.txt", b"data"),
        )
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.registered == 0
        assert report.skipped[0].attachments_recorded == 1
        assert store.trace(REQ).inbound == ()
        assert store.trace(OTHER_REQ).inbound == ()

    def test_attachment_mail_with_reference_is_registered_and_metadata_counted(
        self, store: MailThreadStore
    ) -> None:
        raw = build_message(
            "<in-5@example.com>",
            subject=f"[ForgeLoop][{REQ}] 带附件需求",
            body="请查收附件",
            attachment=("notes.txt", b"data"),
        )
        with running_mail(store, messages=[raw]) as (adapter, _imap, _smtp):
            report = adapter.poll_once()

        assert report.registered == 1
        assert report.results[0].attachments_recorded == 1
        assert store.inbound(REQ)[0].message_id == "<in-5@example.com>"


class TestSendFeedback:
    def test_outbound_message_id_is_persisted_for_thread_linking(
        self, store: MailThreadStore
    ) -> None:
        with running_mail(store, messages=[]) as (adapter, _imap, smtp_server):
            receipt = adapter.send_feedback(
                req_id=REQ,
                kind="disambiguate",
                subject=f"[ForgeLoop][{REQ}] 请补充信息",
                body="请补充使用场景",
            )
            captured = smtp_server.messages[0]

        assert receipt.req_id == REQ
        assert receipt.recorded is True
        outbound = store.outbound(REQ)
        assert [record.message_id for record in outbound] == [receipt.message_id]
        assert store.delivery(receipt.message_id) is not None
        # 真实发出的报文里带着我们落库的同一个 Message-ID。
        assert f"Message-ID: {receipt.message_id}".encode() in captured

    def test_feedback_authenticates_with_authorization_code(self, store: MailThreadStore) -> None:
        with running_mail(store, messages=[]) as (adapter, _imap, smtp_server):
            adapter.send_feedback(req_id=REQ, kind="disambiguate", subject="s", body="b")

        assert smtp_server.auth_attempts == [(USERNAME, SECRET)]
        assert smtp_server.authenticated is True

    def test_wrong_smtp_authorization_code_fails_loudly(self, store: MailThreadStore) -> None:
        with (
            running_mail(store, messages=[], smtp_secret="wrong-code") as (
                adapter,
                _imap,
                smtp_server,
            ),
            pytest.raises(MailSendError, match="发送邮件失败"),
        ):
            adapter.send_feedback(req_id=REQ, kind="disambiguate", subject="s", body="b")

        assert smtp_server.authenticated is False
        assert store.outbound(REQ) == ()

    def test_send_failure_is_observable_and_not_persisted(self, store: MailThreadStore) -> None:
        with (
            running_mail(store, messages=[], smtp_fail_mail=True) as (adapter, _imap, _smtp),
            pytest.raises(MailSendError, match="发送邮件失败"),
        ):
            adapter.send_feedback(
                req_id=REQ,
                kind="accept_success",
                subject=f"[ForgeLoop][{REQ}] 已接纳",
                body="需求已接纳",
            )

        assert store.outbound(REQ) == ()
        assert store.trace(REQ).entries == ()

    def test_feedback_requires_requirement_identity(self, store: MailThreadStore) -> None:
        with (
            running_mail(store, messages=[]) as (adapter, _imap, _smtp),
            pytest.raises(Exception, match="需求编号"),
        ):
            adapter.send_feedback(req_id="  ", kind="disambiguate", subject="x", body="y")


class TestSendReply:
    def test_reply_keeps_thread_headers_and_stable_message_id(self, store: MailThreadStore) -> None:
        with running_mail(store, messages=[]) as (adapter, _imap, smtp_server):
            delivered = adapter.send_reply(
                to="owner@example.com",
                subject=f"[ForgeLoop][{REQ}][状态]",
                body="状态：executing",
                message_id="<reply-1@forgeloop.local>",
                in_reply_to="<in-1@example.com>",
                references=("<root@example.com>", "<in-1@example.com>"),
            )
            captured = smtp_server.messages[0]

        assert delivered == "<reply-1@forgeloop.local>"
        assert b"Message-ID: <reply-1@forgeloop.local>" in captured
        assert b"In-Reply-To: <in-1@example.com>" in captured
        assert b"References: <root@example.com> <in-1@example.com>" in captured
        # 交互回信不进入分类反馈账（出向绑定由交互记录负责）。
        assert store.outbound(REQ) == ()

    def test_reply_generates_message_id_when_missing(self, store: MailThreadStore) -> None:
        with running_mail(store, messages=[]) as (adapter, _imap, smtp_server):
            delivered = adapter.send_reply(to="owner@example.com", subject="s", body="b")

        assert delivered.startswith("<")
        assert delivered.endswith(">")
        assert f"Message-ID: {delivered}".encode() in smtp_server.messages[0]

    def test_reply_requires_recipient_and_subject(self, store: MailThreadStore) -> None:
        with running_mail(store, messages=[]) as (adapter, _imap, _smtp):
            with pytest.raises(Exception, match="收件地址"):
                adapter.send_reply(to=" ", subject="s", body="b")
            with pytest.raises(Exception, match="主题"):
                adapter.send_reply(to="owner@example.com", subject=" ", body="b")


class TestParsing:
    def test_missing_message_id_is_a_parse_error(self) -> None:
        with pytest.raises(MailParseError, match="Message-ID"):
            parse_inbound(b"From: a@b\r\nSubject: x\r\n\r\nbody", folder="INBOX")

    def test_references_are_extracted_as_tuple(self) -> None:
        raw = build_message(
            "<in-6@example.com>",
            references=("<a@x>", "<b@x>"),
            body="body",
        )
        parsed = parse_inbound(raw, folder="INBOX", default_received_at=WHEN)
        assert parsed.references == ("<a@x>", "<b@x>")

    def test_auto_submitted_header_is_preserved(self) -> None:
        raw = build_message(
            "<in-7@example.com>",
            body="休假自动回复",
            auto_submitted="auto-replied",
        )
        parsed = parse_inbound(raw, folder="INBOX", default_received_at=WHEN)
        assert parsed.auto_submitted == "auto-replied"

    def test_absent_auto_submitted_is_empty(self) -> None:
        parsed = parse_inbound(
            build_message("<in-8@example.com>", body="正常回复"),
            folder="INBOX",
            default_received_at=WHEN,
        )
        assert parsed.auto_submitted == ""

    def test_encoded_subject_is_decoded_for_linking(self) -> None:
        # 中文主题会被邮件客户端编码；不解码会丢失主题里的需求编号与线程线索。
        parsed = parse_inbound(
            build_message(
                "<in-9@example.com>",
                subject="[ForgeLoop][req-20261016071651-c4f6e4][任务包]",
                body="status",
            ),
            folder="INBOX",
            default_received_at=WHEN,
        )
        assert parsed.subject == "[ForgeLoop][req-20261016071651-c4f6e4][任务包]"
