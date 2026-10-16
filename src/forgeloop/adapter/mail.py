"""IMAP 轮询与 SMTP 发送适配器：真实邮箱边界，只依赖标准库与调用方注入的接缝。

职责（外部边界，不知道领域规则与记录结构）：

- **入向**：``ImapMailReceiver`` 用邮箱地址 + 授权码/应用专用密码登录 IMAP，
  ``poll_once`` 单次拉取未读邮件，逐封解析为 ``InboundMail``。
- **关联**：需求编号的解析通过注入的 ``resolve_requirement`` 完成（领域规则不在
  本层），无法关联的邮件不纳入需求并出现在报告里。
- **出向**：``SmtpMailSender`` 用同一授权码登录 SMTP 发出反馈邮件，``send_feedback``
  先生成并写入自己的 ``Message-ID`` 再发送，发送成功后把该 Message-ID 交给注入的
  ``record_outbound`` 落库；发送失败抛 ``MailSendError``，绝不静默丢弃、也不落库。
- **幂等**：入向去重与出向幂等由注入的记录接缝按 Message-ID 保证；``poll_once``
  对同一封邮件重复执行不重复登记。
- **附件**：只提取文件名、内容类型与字节数元数据，不解析内容，也不参与需求关联。

分层：本模块位于 ``adapter`` 叶子层，不 import 任何 ``forgeloop.*``；记录与关联
以函数参数注入，真实实现由上层（CLI）提供。
"""

from __future__ import annotations

import contextlib
import email
import imaplib
import smtplib
import ssl
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from email.message import EmailMessage, Message
from email.utils import make_msgid, parseaddr, parsedate_to_datetime
from typing import Any, cast

__all__ = [
    "ImapMailReceiver",
    "ImapSettings",
    "InboundMail",
    "InboundResult",
    "MailAdapterError",
    "MailAttachment",
    "MailAuthenticationError",
    "MailConnectionError",
    "MailParseError",
    "MailSendError",
    "OutboundReceipt",
    "PollReport",
    "SmtpMailSender",
    "SmtpSettings",
    "parse_inbound",
]


class MailAdapterError(RuntimeError):
    """邮件适配器失败基类：所有失败都必须可观测，不静默吞掉。"""


class MailAuthenticationError(MailAdapterError):
    """授权码/应用专用密码认证失败。"""


class MailConnectionError(MailAdapterError):
    """IMAP/SMTP 连接或协议交互失败。"""


class MailParseError(MailAdapterError):
    """邮件无法解析（缺少 Message-ID、结构损坏等），不能登记为需求。"""


class MailSendError(MailAdapterError):
    """SMTP 发送失败：调用方据此重试或如实报告，绝不静默丢弃。"""


@dataclass(frozen=True)
class ImapSettings:
    """IMAP 入向配置；``secret`` 是授权码/应用专用密码，不落盘、不进日志。"""

    host: str
    username: str
    secret: str
    port: int = 993
    use_ssl: bool = True
    folder: str = "INBOX"
    timeout: float = 30.0

    def __post_init__(self) -> None:
        if not self.host.strip():
            raise MailAdapterError("IMAP 主机不能为空")
        if not self.username.strip():
            raise MailAdapterError("IMAP 用户名不能为空")
        if not self.secret:
            raise MailAdapterError("IMAP 授权码/应用专用密码不能为空")


@dataclass(frozen=True)
class SmtpSettings:
    """SMTP 出向配置；``sender`` 是发件地址，``recipient`` 是默认收件地址。"""

    host: str
    username: str
    secret: str
    sender: str
    recipient: str
    port: int = 465
    use_ssl: bool = True
    starttls: bool = False
    timeout: float = 30.0

    def __post_init__(self) -> None:
        if not self.host.strip():
            raise MailAdapterError("SMTP 主机不能为空")
        if not self.username.strip():
            raise MailAdapterError("SMTP 用户名不能为空")
        if not self.secret:
            raise MailAdapterError("SMTP 授权码/应用专用密码不能为空")
        if "@" not in parseaddr(self.sender)[1]:
            raise MailAdapterError(f"发件地址不合法：{self.sender}")
        if "@" not in parseaddr(self.recipient)[1]:
            raise MailAdapterError(f"收件地址不合法：{self.recipient}")


@dataclass(frozen=True)
class MailAttachment:
    """附件元数据：只记录文件名、内容类型与字节数，不持有内容。"""

    filename: str
    content_type: str
    size_bytes: int


@dataclass(frozen=True)
class InboundMail:
    """一封已解析的入向邮件；附件只在 ``attachments`` 留元数据。"""

    message_id: str
    sender: str
    subject: str
    body: str
    received_at: datetime
    in_reply_to: str | None
    references: tuple[str, ...]
    attachments: tuple[MailAttachment, ...]
    folder: str


@dataclass(frozen=True)
class InboundResult:
    """单封入向邮件的处理结果，供调用方审计。"""

    message_id: str
    req_id: str | None
    registered: bool
    reason: str
    attachments_recorded: int = 0


@dataclass(frozen=True)
class PollReport:
    """一次 ``poll_once`` 的可观测结果；未纳入与未解析都在这里有交代。"""

    fetched: int
    registered: int
    results: tuple[InboundResult, ...]
    errors: tuple[str, ...]

    @property
    def skipped(self) -> tuple[InboundResult, ...]:
        """未被纳入需求的邮件（未关联到需求编号等）。"""

        return tuple(result for result in self.results if not result.registered)


@dataclass(frozen=True)
class OutboundReceipt:
    """一封出向反馈的发送与落库回执。"""

    message_id: str
    req_id: str
    kind: str
    recorded: bool


def _decode_part(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if not isinstance(payload, (bytes, bytearray)):
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return bytes(payload).decode(charset, errors="replace")
    except LookupError:
        return bytes(payload).decode("utf-8", errors="replace")


def _is_attachment(part: Message) -> bool:
    disposition = part.get("Content-Disposition") or ""
    return "attachment" in disposition.lower() or bool(part.get_filename())


def _extract_body(message: Message) -> str:
    """取正文文本；附件内容不参与正文，也不参与关联。"""

    if message.is_multipart():
        parts = list(message.walk())
        for content_type in ("text/plain", "text/html"):
            for part in parts:
                if part.get_content_type() == content_type and not _is_attachment(part):
                    text = _decode_part(part)
                    if text:
                        return text
        return ""
    return _decode_part(message)


def _extract_attachments(message: Message) -> tuple[MailAttachment, ...]:
    """只收集附件元数据；内容原样丢弃，不做任何解析。"""

    attachments: list[MailAttachment] = []
    for part in message.walk():
        if part.is_multipart() or not _is_attachment(part):
            continue
        payload = part.get_payload(decode=True)
        size = len(payload) if isinstance(payload, (bytes, bytearray)) else 0
        attachments.append(
            MailAttachment(
                filename=part.get_filename() or "(未命名附件)",
                content_type=part.get_content_type(),
                size_bytes=size,
            )
        )
    return tuple(attachments)


def _extract_received_at(message: Message, default: datetime) -> datetime:
    raw = message.get("Date")
    if not raw:
        return default
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return default
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_inbound(
    raw: bytes,
    *,
    folder: str,
    default_received_at: datetime | None = None,
) -> InboundMail:
    """把一封 RFC822 原始邮件解析为 ``InboundMail``；无法登记时抛 ``MailParseError``。

    缺少 ``Message-ID`` 的邮件无法做入向去重与线索关联，判定为「无法解析」并让
    调用方如实记录，绝不猜一个 ID 纳入需求。
    """

    message = email.message_from_bytes(raw)
    message_id = (message.get("Message-ID") or "").strip()
    if not message_id:
        raise MailParseError("邮件缺少 Message-ID，无法登记与去重")
    sender = parseaddr(message.get("From") or "")[1]
    subject = str(message.get("Subject") or "")
    references = tuple(str(message.get("References") or "").split())
    in_reply_to = message.get("In-Reply-To")
    return InboundMail(
        message_id=message_id,
        sender=sender,
        subject=subject,
        body=_extract_body(message),
        received_at=_extract_received_at(
            message, default_received_at if default_received_at is not None else datetime.now(UTC)
        ),
        in_reply_to=str(in_reply_to) if in_reply_to else None,
        references=references,
        attachments=_extract_attachments(message),
        folder=folder,
    )


def _extract_literal(parts: Sequence[Any]) -> bytes | None:
    """从 ``imaplib.fetch`` 的返回里取出真正的邮件字节（literal）。"""

    for item in parts:
        if isinstance(item, tuple):
            pair = cast("tuple[Any, ...]", item)
            if len(pair) == 2 and isinstance(pair[1], (bytes, bytearray)):
                return bytes(pair[1])
    best: bytes | None = None
    for item in parts:
        if isinstance(item, (bytes, bytearray)):
            candidate = bytes(item)
            if best is None or len(candidate) > len(best):
                best = candidate
    return best


class ImapMailReceiver:
    """IMAP 入向边界：授权码认证 + 单次拉取未读邮件。"""

    def __init__(self, settings: ImapSettings) -> None:
        self._settings = settings
        self._connection: imaplib.IMAP4 | None = None

    @property
    def folder(self) -> str:
        return self._settings.folder

    def authenticate(self) -> None:
        """登录 IMAP；凭据错误抛 ``MailAuthenticationError``，连接问题抛 ``MailConnectionError``。"""

        if self._connection is not None:
            return
        try:
            connection: imaplib.IMAP4 = (
                imaplib.IMAP4_SSL(
                    self._settings.host, self._settings.port, timeout=self._settings.timeout
                )
                if self._settings.use_ssl
                else imaplib.IMAP4(
                    self._settings.host, self._settings.port, timeout=self._settings.timeout
                )
            )
        except (OSError, imaplib.IMAP4.error) as error:
            raise MailConnectionError(
                f"无法连接 IMAP {self._settings.host}:{self._settings.port}：{error}"
            ) from error
        try:
            connection.login(self._settings.username, self._settings.secret)
        except imaplib.IMAP4.error as error:
            with contextlib.suppress(OSError, imaplib.IMAP4.error):
                connection.logout()
            raise MailAuthenticationError(
                f"IMAP 认证失败（{self._settings.username}@{self._settings.host}）：{error}"
            ) from error
        self._connection = connection

    def fetch_unseen(self) -> tuple[bytes, ...]:
        """在已选文件夹里拉取未读邮件的原始字节；使用 ``BODY.PEEK[]`` 不标记已读，
        以便登记失败后重复轮询仍能看见同一封邮件（重复登记由记录接缝幂等处理）。"""

        connection = self._connection
        if connection is None:
            raise MailConnectionError("IMAP 尚未认证，先调用 authenticate()")
        try:
            status, _ = connection.select(self._settings.folder)
            if status != "OK":
                raise MailConnectionError(f"无法打开文件夹 {self._settings.folder}")
            status, data = connection.search(None, "UNSEEN")
            if status != "OK" or not data or not isinstance(data[0], (bytes, bytearray)):
                raise MailConnectionError("IMAP SEARCH UNSEEN 失败")
            messages: list[bytes] = []
            for number in bytes(data[0]).split():
                status, parts = connection.fetch(number.decode("ascii"), "(BODY.PEEK[])")
                if status != "OK":
                    raise MailConnectionError(f"IMAP FETCH {number!r} 失败")
                raw = _extract_literal(parts)
                if raw is not None:
                    messages.append(raw)
            return tuple(messages)
        except (imaplib.IMAP4.error, OSError) as error:
            raise MailConnectionError(f"IMAP 拉取未读邮件失败：{error}") from error

    def close(self) -> None:
        """登出并释放连接；重复调用无副作用。"""

        connection, self._connection = self._connection, None
        if connection is None:
            return
        with contextlib.suppress(OSError, imaplib.IMAP4.error):
            connection.logout()


class SmtpMailSender:
    """SMTP 出向边界：授权码认证 + 发送一封 ``EmailMessage``。"""

    def __init__(self, settings: SmtpSettings) -> None:
        self._settings = settings

    @property
    def sender(self) -> str:
        return self._settings.sender

    @property
    def recipient(self) -> str:
        return self._settings.recipient

    def send(self, message: EmailMessage) -> str:
        """发送邮件并返回其 ``Message-ID``；任何 SMTP 失败抛 ``MailSendError``。"""

        message_id = str(message.get("Message-ID") or "").strip()
        if not message_id:
            message_id = make_msgid(domain="forgeloop.local")
            message["Message-ID"] = message_id
        try:
            client = self._new_client()
        except (OSError, smtplib.SMTPException) as error:
            raise MailSendError(
                f"无法连接 SMTP {self._settings.host}:{self._settings.port}：{error}"
            ) from error
        try:
            with client:
                if self._settings.starttls:
                    client.starttls(context=ssl.create_default_context())
                client.login(self._settings.username, self._settings.secret)
                client.send_message(message)
        except (OSError, smtplib.SMTPException) as error:
            raise MailSendError(f"发送邮件失败（Message-ID {message_id}）：{error}") from error
        return message_id

    def _new_client(self) -> smtplib.SMTP:
        if self._settings.use_ssl:
            return smtplib.SMTP_SSL(
                self._settings.host,
                self._settings.port,
                timeout=self._settings.timeout,
                context=ssl.create_default_context(),
            )
        return smtplib.SMTP(
            self._settings.host, self._settings.port, timeout=self._settings.timeout
        )


@dataclass(frozen=True)
class _Recorder:
    """记录接缝：由上层注入真实记录（如 ``MailThreadStore``）。"""

    inbound: Callable[[InboundMail, str], bool]
    outbound: Callable[[str, str, str, datetime], bool]


class MailAdapter:
    """把 IMAP 轮询与 SMTP 发送接到注入的记录/关联接缝上的适配器。"""

    def __init__(
        self,
        receiver: ImapMailReceiver,
        sender: SmtpMailSender,
        *,
        resolve_requirement: Callable[[InboundMail], str | None],
        record_inbound: Callable[[InboundMail, str], bool],
        record_outbound: Callable[[str, str, str, datetime], bool],
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._receiver = receiver
        self._sender = sender
        self._resolve_requirement = resolve_requirement
        self._recorder = _Recorder(record_inbound, record_outbound)
        self._now = now if now is not None else lambda: datetime.now(UTC)

    def poll_once(self) -> PollReport:
        """单次幂等轮询：认证、拉取未读、逐封解析、关联并登记。

        重复执行时，已登记的 Message-ID 由记录接缝判为重复而不新增；无法解析的
        邮件记入 ``errors``，未关联到需求的邮件记入 ``skipped``，都不纳入需求。
        """

        self._receiver.authenticate()
        raw_messages = self._receiver.fetch_unseen()
        results: list[InboundResult] = []
        errors: list[str] = []
        for raw in raw_messages:
            try:
                mail = parse_inbound(
                    raw, folder=self._receiver.folder, default_received_at=self._now()
                )
            except MailParseError as error:
                errors.append(f"无法解析邮件：{error}")
                continue
            req_id = self._resolve_requirement(mail)
            if req_id is None:
                results.append(
                    InboundResult(
                        message_id=mail.message_id,
                        req_id=None,
                        registered=False,
                        reason="未关联到需求编号，未纳入需求",
                        attachments_recorded=len(mail.attachments),
                    )
                )
                continue
            created = self._recorder.inbound(mail, req_id)
            results.append(
                InboundResult(
                    message_id=mail.message_id,
                    req_id=req_id,
                    registered=created,
                    reason="已登记" if created else "重复轮询命中幂等，未重复登记",
                    attachments_recorded=len(mail.attachments),
                )
            )
        return PollReport(
            fetched=len(raw_messages),
            registered=sum(1 for result in results if result.registered),
            results=tuple(results),
            errors=tuple(errors),
        )

    def send_feedback(
        self,
        *,
        req_id: str,
        kind: str,
        subject: str,
        body: str,
        to: str | None = None,
    ) -> OutboundReceipt:
        """人工确认后发送一封反馈邮件，并把其 Message-ID 与需求绑定落库。

        先写自己的 ``Message-ID`` 再发送；只有发送成功才登记出向事实。发送失败抛
        ``MailSendError``，不产生记录，也不静默丢弃。
        """

        if not req_id.strip():
            raise MailAdapterError("反馈邮件必须绑定需求编号")
        if not kind.strip():
            raise MailAdapterError("反馈邮件必须有反馈类型")
        message = EmailMessage()
        message["From"] = self._sender.sender
        message["To"] = to if to is not None else self._sender.recipient
        message["Subject"] = subject
        message_id = make_msgid(domain="forgeloop.local")
        message["Message-ID"] = message_id
        message.set_content(body)
        delivered_id = self._sender.send(message)
        recorded = self._recorder.outbound(delivered_id, req_id, kind, self._now())
        return OutboundReceipt(message_id=delivered_id, req_id=req_id, kind=kind, recorded=recorded)

    def close(self) -> None:
        """释放 IMAP 连接。"""

        self._receiver.close()
