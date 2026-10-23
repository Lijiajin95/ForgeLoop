"""ForgeLoop 邮箱模块：抽象端口、provider 预设、配置/口令解析与事件渲染。

本层只依赖标准库（同层模块之间可互相引用），不依赖 ``cli``、``graph``、
``records``、``adapter`` 或 ``langgraph``；分层契约见 ``docs/architecture.md``
与 ``pyproject.toml`` 的 import-linter 配置。对外只暴露抽象接口、消息/错误
模型与纯函数；SMTP/IMAP 适配器与组合根在 ``adapter``/``cli`` 层。
"""

from forgeloop.mail.config import (
    DEFAULT_FOLDER,
    DEFAULT_SUBJECT_PREFIX,
    TEMPLATE_PATH,
    ConfigCandidate,
    MailConfig,
    load_mail_config,
    parse_mail_config,
)
from forgeloop.mail.ports import (
    IncomingMessage,
    MailAccount,
    MailAuthenticationError,
    MailConfigurationError,
    MailEncryption,
    MailError,
    MailNetworkError,
    MailReceiver,
    MailRecipientError,
    MailSender,
    OutgoingMessage,
    Receipt,
    Secret,
)
from forgeloop.mail.presets import (
    GMAIL_PRESET,
    PROVIDER_PRESETS,
    QQ_PRESET,
    ProviderPreset,
    SmtpEndpoint,
    preset_for,
)
from forgeloop.mail.render import (
    MAIL_SUBJECT_PREFIX,
    KeyEvent,
    NotificationEvent,
    RenderedMessage,
    event_label,
    render,
    render_body,
    render_subject,
    to_outgoing_message,
)
from forgeloop.mail.secret import (
    SecretCandidate,
    SecretCandidateKind,
    SecretCandidateReport,
    SecretResolution,
    SecretStatus,
    parse_secret_content,
    resolve_secret,
    secret_candidates,
)

__all__ = [
    "DEFAULT_FOLDER",
    "DEFAULT_SUBJECT_PREFIX",
    "GMAIL_PRESET",
    "MAIL_SUBJECT_PREFIX",
    "PROVIDER_PRESETS",
    "QQ_PRESET",
    "TEMPLATE_PATH",
    "ConfigCandidate",
    "IncomingMessage",
    "KeyEvent",
    "MailAccount",
    "MailAuthenticationError",
    "MailConfig",
    "MailConfigurationError",
    "MailEncryption",
    "MailError",
    "MailNetworkError",
    "MailReceiver",
    "MailRecipientError",
    "MailSender",
    "NotificationEvent",
    "OutgoingMessage",
    "ProviderPreset",
    "Receipt",
    "RenderedMessage",
    "Secret",
    "SecretCandidate",
    "SecretCandidateKind",
    "SecretCandidateReport",
    "SecretResolution",
    "SecretStatus",
    "SmtpEndpoint",
    "event_label",
    "load_mail_config",
    "parse_mail_config",
    "parse_secret_content",
    "preset_for",
    "render",
    "render_body",
    "render_subject",
    "resolve_secret",
    "secret_candidates",
    "to_outgoing_message",
]
