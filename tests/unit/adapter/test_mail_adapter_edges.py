"""邮件适配器边界用例：配置校验、解析辅助与收发失败分支。

补齐集成用例（真实回环 IMAP/SMTP）覆盖不到的分支：无效配置、畸形邮件、
连接/搜索/拉取/发送失败的确定性错误，以及 starttls 路径。
"""

import imaplib
import smtplib
from dataclasses import replace
from datetime import UTC, datetime
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

import pytest

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    ImapSettings,
    MailAdapterError,
    MailConnectionError,
    MailSendError,
    SmtpMailSender,
    SmtpSettings,
    _decode_header_value,
    _decode_part,
    _extract_attachments,
    _extract_body,
    _extract_received_at,
)

BASE_IMAP = ImapSettings(host="imap.example.com", username="u@example.com", secret="s")
BASE_SMTP = SmtpSettings(
    host="smtp.example.com",
    username="u@example.com",
    secret="s",
    sender="u@example.com",
    recipient="owner@example.com",
)
WHEN = datetime(2026, 10, 19, 10, 0, tzinfo=UTC)


class TestSettingsValidation:
    def test_imap_host_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="IMAP 主机"):
            replace(BASE_IMAP, host="  ")

    def test_imap_username_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="IMAP 用户名"):
            replace(BASE_IMAP, username="")

    def test_imap_secret_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="IMAP 授权码"):
            replace(BASE_IMAP, secret="")

    def test_smtp_host_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="SMTP 主机"):
            replace(BASE_SMTP, host=" ")

    def test_smtp_username_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="SMTP 用户名"):
            replace(BASE_SMTP, username="")

    def test_smtp_secret_blank_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="SMTP 授权码"):
            replace(BASE_SMTP, secret="")

    def test_smtp_sender_without_at_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="发件地址不合法"):
            replace(BASE_SMTP, sender="not-an-address")

    def test_smtp_recipient_without_at_is_rejected(self) -> None:
        with pytest.raises(MailAdapterError, match="收件地址不合法"):
            replace(BASE_SMTP, recipient="not-an-address")


class TestPureHelpers:
    def test_decode_part_falls_back_to_utf8_for_unknown_charset(self) -> None:
        part = MIMEText("中文")
        part.replace_header("Content-Type", 'text/plain; charset="x-unknown-charset"')

        assert _decode_part(part) == "中文"

    def test_decode_part_returns_empty_when_payload_is_not_bytes(self) -> None:
        # 多部分容器自身没有可解码的字节载荷：如实返回空串而不是抛错。
        assert _decode_part(MIMEMultipart()) == ""

    def test_decode_header_value_decodes_rfc2047(self) -> None:
        assert "中文" in _decode_header_value("=?utf-8?B?5Lit5paH?=")

    def test_decode_header_value_keeps_raw_on_failure(self) -> None:
        # 未知字符集在 make_header 阶段抛 LookupError：保留原文，不猜内容。
        raw = "=?x-unknown?B?5Lit5paH?="

        assert _decode_header_value(raw) == raw

    def test_decode_header_value_empty_returns_empty(self) -> None:
        assert _decode_header_value("") == ""

    def test_extract_body_prefers_plain_text_and_skips_attachments(self) -> None:
        message = MIMEMultipart()
        message.attach(MIMEText("正文", "plain"))
        attachment = MIMEText("附件内容", "plain")
        attachment.add_header("Content-Disposition", "attachment", filename="a.txt")
        message.attach(attachment)

        assert _extract_body(message) == "正文"

    def test_extract_body_returns_empty_when_only_attachments(self) -> None:
        message = MIMEMultipart()
        attachment = MIMEText("附件内容", "plain")
        attachment.add_header("Content-Disposition", "attachment", filename="a.txt")
        message.attach(attachment)

        assert _extract_body(message) == ""

    def test_extract_attachments_records_metadata_and_unnamed_fallback(self) -> None:
        message = MIMEMultipart()
        named = MIMEText("hello", "plain")
        named.add_header("Content-Disposition", "attachment", filename="a.txt")
        unnamed = MIMEText("hi", "plain")
        unnamed.add_header("Content-Disposition", "attachment")
        message.attach(named)
        message.attach(unnamed)

        attachments = _extract_attachments(message)

        assert [item.filename for item in attachments] == ["a.txt", "(未命名附件)"]

    def test_extract_attachments_reports_zero_size_when_payload_missing(self) -> None:
        message = MIMEMultipart()
        empty = EmailMessage()
        empty.add_header("Content-Disposition", "attachment", filename="empty.bin")
        message.attach(empty)

        attachments = _extract_attachments(message)

        assert len(attachments) == 1 and attachments[0].size_bytes == 0

    def test_extract_received_at_uses_default_without_date(self) -> None:
        assert _extract_received_at(EmailMessage(), WHEN) == WHEN

    def test_extract_received_at_uses_default_on_invalid_date(self) -> None:
        message = EmailMessage()
        message["Date"] = "not a date"

        assert _extract_received_at(message, WHEN) == WHEN

    def test_extract_received_at_treats_naive_date_as_utc(self) -> None:
        message = EmailMessage()
        message["Date"] = "Mon, 19 Oct 2026 10:00:00"

        assert _extract_received_at(message, WHEN) == WHEN


class FakeImap:
    """最小 IMAP 替身：按预设响应覆盖 select、search、fetch 的成功与失败分支。"""

    def __init__(
        self,
        *,
        select: tuple[str, list[Any]] = ("OK", [b"1"]),
        search: tuple[str, list[Any]] = ("OK", [b"1"]),
        fetch: list[Any] | None = None,
        raise_on: str = "",
    ) -> None:
        self._select = select
        self._search = search
        self._fetch = list(fetch or [])
        self._raise_on = raise_on

    def select(self, folder: str) -> tuple[str, list[Any]]:
        if self._raise_on == "select":
            raise imaplib.IMAP4.error("boom")
        return self._select

    def search(self, *args: Any) -> tuple[str, list[Any]]:
        if self._raise_on == "search":
            raise imaplib.IMAP4.error("boom")
        return self._search

    def fetch(self, number: str, spec: str) -> Any:
        if self._raise_on == "fetch":
            raise imaplib.IMAP4.error("boom")
        return self._fetch.pop(0) if self._fetch else ("OK", [])

    def logout(self) -> None:
        return None


def receiver_with(connection: Any) -> ImapMailReceiver:
    receiver = ImapMailReceiver(ImapSettings(host="h", username="u", secret="s"))
    receiver._connection = connection
    return receiver


class TestFetchUnseen:
    def test_fetch_without_authenticate_is_rejected(self) -> None:
        with pytest.raises(MailConnectionError, match="尚未认证"):
            ImapMailReceiver(ImapSettings(host="h", username="u", secret="s")).fetch_unseen()

    def test_select_failure_is_reported(self) -> None:
        receiver = receiver_with(FakeImap(select=("NO", [])))

        with pytest.raises(MailConnectionError, match="无法打开文件夹"):
            receiver.fetch_unseen()

    def test_search_failure_is_reported(self) -> None:
        receiver = receiver_with(FakeImap(search=("NO", [])))

        with pytest.raises(MailConnectionError, match="SEARCH UNSEEN"):
            receiver.fetch_unseen()

    def test_search_without_bytes_is_reported(self) -> None:
        receiver = receiver_with(FakeImap(search=("OK", ["1"])))

        with pytest.raises(MailConnectionError, match="SEARCH UNSEEN"):
            receiver.fetch_unseen()

    def test_fetch_failure_is_reported(self) -> None:
        receiver = receiver_with(FakeImap(fetch=[("NO", [])]))

        with pytest.raises(MailConnectionError, match="FETCH"):
            receiver.fetch_unseen()

    def test_literal_pair_is_returned_and_missing_literal_is_skipped(self) -> None:
        receiver = receiver_with(
            FakeImap(fetch=[("OK", [(b"1 (BODY[] {5}", b"hello")]), ("OK", [])])
        )

        assert receiver.fetch_unseen() == (b"hello",)

    def test_imaplib_error_is_wrapped(self) -> None:
        receiver = receiver_with(FakeImap(raise_on="search"))

        with pytest.raises(MailConnectionError, match="拉取未读邮件失败"):
            receiver.fetch_unseen()


class FakeSmtp:
    """最小 SMTP 替身：记录 starttls、login、send_message，可按需抛出协议错误。"""

    def __init__(self, *, fail_login: bool = False) -> None:
        self.fail_login = fail_login
        self.starttls_context: Any = None
        self.sent: list[EmailMessage] = []

    def __enter__(self) -> "FakeSmtp":
        return self

    def __exit__(self, *args: object) -> bool:
        return False

    def starttls(self, context: Any = None) -> None:
        self.starttls_context = context

    def login(self, username: str, secret: str) -> None:
        if self.fail_login:
            raise smtplib.SMTPAuthenticationError(535, b"bad credentials")

    def send_message(self, message: EmailMessage) -> None:
        self.sent.append(message)


class TestSmtpSend:
    def test_connect_failure_is_reported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        sender = SmtpMailSender(BASE_SMTP)

        def _boom(self: SmtpMailSender) -> Any:
            raise OSError("connection refused")

        monkeypatch.setattr(SmtpMailSender, "_new_client", _boom)

        with pytest.raises(MailSendError, match="无法连接 SMTP"):
            sender.send(EmailMessage())

    def test_login_failure_is_reported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        sender = SmtpMailSender(BASE_SMTP)
        client = FakeSmtp(fail_login=True)
        monkeypatch.setattr(SmtpMailSender, "_new_client", lambda self: client)

        with pytest.raises(MailSendError, match="发送邮件失败"):
            sender.send(EmailMessage())

    def test_message_id_is_generated_when_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        sender = SmtpMailSender(BASE_SMTP)
        client = FakeSmtp()
        monkeypatch.setattr(SmtpMailSender, "_new_client", lambda self: client)
        message = EmailMessage()

        message_id = sender.send(message)

        assert message_id
        assert message["Message-ID"] == message_id
        assert client.sent and client.sent[0] is message

    def test_existing_message_id_is_kept_and_starttls_runs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sender = SmtpMailSender(replace(BASE_SMTP, starttls=True, use_ssl=False))
        client = FakeSmtp()
        monkeypatch.setattr(SmtpMailSender, "_new_client", lambda self: client)
        message = EmailMessage()
        message["Message-ID"] = "<kept@example.com>"

        assert sender.send(message) == "<kept@example.com>"
        assert client.starttls_context is not None
