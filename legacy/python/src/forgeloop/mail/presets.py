"""QQ/Gmail provider 预设：端点与加密差异的唯一来源。

新增 provider 只需在此增加预设与适配器，端口与组合根不需要改动。首版只
内建 QQ 与 Gmail，不预留通用自定义 SMTP 参数（简单优先）。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from forgeloop.mail.ports import MailConfigurationError, MailEncryption


@dataclass(frozen=True)
class SmtpEndpoint:
    """一个 SMTP 端点：主机、端口与加密方式。"""

    host: str
    port: int
    encryption: MailEncryption


@dataclass(frozen=True)
class ProviderPreset:
    """一个邮箱 provider 的端点与凭据说明。"""

    name: str
    display_name: str
    smtp_endpoints: tuple[SmtpEndpoint, ...]
    imap_host: str
    imap_port: int
    credential_label: str

    @property
    def default_smtp_endpoint(self) -> SmtpEndpoint:
        return self.smtp_endpoints[0]


QQ_PRESET = ProviderPreset(
    name="qq",
    display_name="QQ 邮箱",
    smtp_endpoints=(SmtpEndpoint("smtp.qq.com", 465, MailEncryption.SSL),),
    imap_host="imap.qq.com",
    imap_port=993,
    credential_label="邮箱授权码（非登录密码）",
)

GMAIL_PRESET = ProviderPreset(
    name="gmail",
    display_name="Gmail",
    smtp_endpoints=(
        SmtpEndpoint("smtp.gmail.com", 465, MailEncryption.SSL),
        SmtpEndpoint("smtp.gmail.com", 587, MailEncryption.STARTTLS),
    ),
    imap_host="imap.gmail.com",
    imap_port=993,
    credential_label="应用专用密码",
)

PROVIDER_PRESETS: Mapping[str, ProviderPreset] = MappingProxyType(
    {QQ_PRESET.name: QQ_PRESET, GMAIL_PRESET.name: GMAIL_PRESET}
)


def preset_for(provider: str) -> ProviderPreset:
    """按 provider 名取预设；未知 provider 明确失败（fail-closed）。"""

    key = provider.strip().lower()
    try:
        return PROVIDER_PRESETS[key]
    except KeyError:
        known = "、".join(sorted(PROVIDER_PRESETS))
        raise MailConfigurationError(
            f"未知邮箱 provider：{provider!r}；首版仅支持 {known}"
        ) from None
