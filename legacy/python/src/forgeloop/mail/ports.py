"""邮箱模块端口：抽象接口、消息模型与错误族。

本模块只依赖标准库，是 ``mail`` 层对外的最小契约。适配器（SMTP/IMAP）与
组合根只通过这里的抽象接口交互；QQ/Gmail 的端点与加密差异由
:mod:`forgeloop.mail.presets` 以预设表达，不在端口中硬编码。

``--config``、配置查找与口令候选解析不在这里，分别见
:mod:`forgeloop.mail.config` 与 :mod:`forgeloop.mail.secret`。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum


class MailError(RuntimeError):
    """邮箱业务错误基类：组合根据此给出可诊断输出。"""


class MailConfigurationError(MailError):
    """配置或凭据缺失、非法：fail-closed，不静默、不重试。"""


class MailAuthenticationError(MailError):
    """SMTP/IMAP 认证失败（账号或授权码/应用专用密码错误）。"""


class MailNetworkError(MailError):
    """连接、超时或传输层失败。"""


class MailRecipientError(MailError):
    """收件人不合法（缺失、格式错误或不被接受）。"""


class MailEncryption(StrEnum):
    """邮件连接加密方式。"""

    SSL = "ssl"
    STARTTLS = "starttls"


@dataclass(frozen=True)
class Secret:
    """不透明口令值：repr/str 只显示占位符，须显式 ``reveal`` 才取值。"""

    value: str = field(repr=False)

    def reveal(self) -> str:
        return self.value

    def __bool__(self) -> bool:
        return bool(self.value)

    def __repr__(self) -> str:
        return "Secret(***)"

    def __str__(self) -> str:
        return "***"


@dataclass(frozen=True)
class MailAccount:
    """邮箱账号身份；端点与加密方式由 provider 预设给出。"""

    provider: str
    address: str
    secret: Secret

    def __post_init__(self) -> None:
        if not self.provider.strip():
            raise MailConfigurationError("邮箱 provider 不能为空")
        if "@" not in self.address:
            raise MailConfigurationError(f"邮箱地址不合法：{self.address!r}")
        if not self.secret:
            raise MailConfigurationError("邮箱口令为空")


@dataclass(frozen=True)
class OutgoingMessage:
    """一封待发送邮件；首版收件人为单一地址，模型仍保留显式列表。"""

    sender: str
    recipients: tuple[str, ...]
    subject: str
    body: str
    event_id: str | None = None
    reply_to: str | None = None

    def __post_init__(self) -> None:
        if "@" not in self.sender:
            raise MailConfigurationError(f"发件人地址不合法：{self.sender!r}")
        if not self.recipients:
            raise MailRecipientError("至少需要一个收件人")
        for recipient in self.recipients:
            if recipient.strip() != recipient or " " in recipient or "@" not in recipient:
                raise MailRecipientError(f"收件人地址不合法：{recipient!r}")

    @property
    def primary_recipient(self) -> str:
        return self.recipients[0]


@dataclass(frozen=True)
class IncomingMessage:
    """一封已接收邮件；附件首版只记录名称，不改写内容。"""

    message_id: str
    sender: str
    subject: str
    body: str
    received_at: datetime
    folder: str = "INBOX"
    attachments: tuple[str, ...] = ()


@dataclass(frozen=True)
class Receipt:
    """发送回执：可核验的 Message-ID 与发送时间。"""

    message_id: str
    sent_at: datetime
    recipients: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.message_id.strip():
            raise MailConfigurationError("发送回执缺少 Message-ID")


class MailSender(ABC):
    """发信端口：实现只把消息交给真实 SMTP 服务，不做幂等或事件判定。"""

    @abstractmethod
    def send(self, message: OutgoingMessage) -> Receipt:
        """发送一封邮件并返回可核验回执。"""


class MailReceiver(ABC):
    """收信端口：实现只负责拉取与解码，不做白名单或需求创建规则。"""

    @abstractmethod
    def list_folders(self) -> tuple[str, ...]:
        """列出服务器上的可读文件夹名。"""

    @abstractmethod
    def fetch(self, folder: str) -> tuple[IncomingMessage, ...]:
        """拉取指定文件夹中的邮件（调用方负责过滤规则）。"""
