"""常驻服务配置的纯规则（R1）。

职责边界：

- **只做判定**：监听地址、端口、轮询间隔、并发上限、自动推进开关与项目档案的合法性
  都在这里判定。读取 TOML、检查 PI HOME 目录是否存在留给 ``cli.serve``：本模块不碰
  文件系统，也不启动任何进程。
- **非法即失败**：配置损坏时显式抛 :class:`ServiceConfigError`，不静默回落到默认值
  （与 ``domain.progress`` 的刷新间隔同一口径）。
- **只允许回环**：这是单用户本地工具；把服务暴露到其他地址会让「本机、同源」这一前提
  失效，因此非回环地址一律拒绝，而不是留一个「先跑起来再补鉴权」的缺口。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import cast

from forgeloop.domain.toml_fields import (
    command_field,
    flag_field,
    integer_field,
    optional_text_field,
    project_name_field,
    reject_unknown_keys,
    text_field,
)

SERVICE_SCHEMA_VERSION = 1
"""``config/service.toml`` 的 schema 版本；不匹配即拒绝启动。"""

DEFAULT_SERVICE_HOST = "127.0.0.1"
DEFAULT_SERVICE_PORT = 8712
"""默认监听回环 8712（``web`` 用 8710、前端浏览器用例用 8711，互不占用）。"""

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
DEFAULT_POLL_SECONDS = 2
DEFAULT_MAX_CONCURRENT = 2
DEFAULT_PANEL_CONCURRENCY = 2
MAX_PANEL_CONCURRENCY = 8
"""面板会话并发上限：每一轮都会启动一个 PI 子进程，不设上限等于不设护栏。"""
DEFAULT_TURN_TIMEOUT_SECONDS = 900
MIN_PORT = 0
"""``0`` 表示由系统分配端口（供测试与临时实例使用），启动后打印实际端口。"""

MAX_PORT = 65535

_TOP_LEVEL_KEYS = frozenset(
    {
        "schema_version",
        "host",
        "port",
        "poll_seconds",
        "max_concurrent",
        "auto_advance",
        "projects",
        "panel",
        # [upgrade] 的排空/就绪/恢复时限由 domain.upgrade 独立校验（常驻服务与
        # 固定启动器共用同一份配置）；这里只承认该键，避免把合法配置判成未知键。
        "upgrade",
    }
)
_PROJECT_KEYS = frozenset({"path", "pi_command", "test_command", "baseline", "pi_home"})
_PANEL_KEYS = frozenset(
    {
        "concurrency",
        "turn_timeout_seconds",
        "session_idle_seconds",
        "max_live_sessions",
        "tool_approval",
    }
)
TOOL_APPROVAL_POLICIES = ("off", "write", "all")
DEFAULT_SESSION_IDLE_SECONDS = 900
DEFAULT_MAX_LIVE_SESSIONS = 4
MAX_LIVE_SESSIONS = 16
DEFAULT_TOOL_APPROVAL = "write"


class ServiceConfigError(ValueError):
    """常驻服务配置非法：显式失败，不静默回落到默认值。"""


@dataclass(frozen=True)
class ProjectProfile:
    """一个被常驻服务托管的项目档案：被开发项目路径与执行器命令。

    ``pi_home`` 是 PI 子进程使用的隔离 HOME（见工程可靠性方案第 22.2 节）：目录本身
    是否存在、``.pi/agent/models.json`` 是否可用由 ``cli.serve`` 检查，本模块只要求非空。
    """

    name: str
    path: str
    pi_command: tuple[str, ...]
    test_command: tuple[str, ...]
    baseline: str
    pi_home: str


@dataclass(frozen=True)
class PanelSettings:
    """页面会话面板的执行设置：并发、单轮超时、常驻进程与工具审批策略。"""

    concurrency: int
    turn_timeout_seconds: int
    session_idle_seconds: int
    max_live_sessions: int
    tool_approval: str


@dataclass(frozen=True)
class ServiceSettings:
    """生效的常驻服务设置；``projects`` 为空表示只提供只读页面、不执行任务。"""

    host: str
    port: int
    poll_seconds: int
    max_concurrent: int
    auto_advance: bool
    projects: Mapping[str, ProjectProfile]
    panel: PanelSettings


def resolve_service_settings(
    document: Mapping[str, object] | None = None,
    *,
    host: object | None = None,
    port: object | None = None,
) -> ServiceSettings:
    """解析生效设置：CLI 参数 → 配置文件 → 内建默认。

    ``document`` 为 ``config/service.toml`` 的原始文档（``None`` 表示没有配置文件，
    使用内建默认）；``host``/``port`` 为命令行显式传入的值（``None`` 表示未传）。
    """

    config: Mapping[str, object] = {} if document is None else document
    reject_unknown_keys(config, _TOP_LEVEL_KEYS, "常驻服务配置", error=ServiceConfigError)
    if document is not None:
        version = document.get("schema_version")
        if version != SERVICE_SCHEMA_VERSION:
            raise ServiceConfigError(
                f"常驻服务配置的 schema_version 必须是 {SERVICE_SCHEMA_VERSION}，实际 {version!r}"
            )
    return ServiceSettings(
        host=_resolve_host(host if host is not None else config.get("host")),
        port=_resolve_port(port if port is not None else config.get("port")),
        poll_seconds=integer_field(
            config.get("poll_seconds", DEFAULT_POLL_SECONDS),
            "poll_seconds",
            minimum=1,
            error=ServiceConfigError,
        ),
        max_concurrent=integer_field(
            config.get("max_concurrent", DEFAULT_MAX_CONCURRENT),
            "max_concurrent",
            minimum=1,
            error=ServiceConfigError,
        ),
        auto_advance=flag_field(
            config.get("auto_advance", False), "auto_advance", error=ServiceConfigError
        ),
        projects=_resolve_projects(config.get("projects")),
        panel=resolve_panel_settings(config.get("panel")),
    )


def host_is_loopback(host: str) -> bool:
    """判断是否是允许的监听地址（页面操作入口依赖「只有本机能访问」这一前提）。"""

    return host in LOOPBACK_HOSTS


def _resolve_host(value: object | None) -> str:
    if value is None:
        return DEFAULT_SERVICE_HOST
    text = text_field(value, "host", error=ServiceConfigError)
    if not host_is_loopback(text):
        allowed = "、".join(sorted(LOOPBACK_HOSTS))
        raise ServiceConfigError(
            f"host 只允许回环地址（{allowed}），实际 {text}；常驻服务不对外暴露"
        )
    return text


def _resolve_port(value: object | None) -> int:
    if value is None:
        return DEFAULT_SERVICE_PORT
    return integer_field(
        value, "port", minimum=MIN_PORT, maximum=MAX_PORT, error=ServiceConfigError
    )


def _resolve_projects(value: object | None) -> Mapping[str, ProjectProfile]:
    if value is None:
        return MappingProxyType({})
    if not isinstance(value, Mapping):
        raise ServiceConfigError("projects 必须是表（形如 [projects.<名字>]）")
    raw_projects = cast("Mapping[str, object]", value)
    profiles: dict[str, ProjectProfile] = {}
    for name in sorted(raw_projects):
        raw = raw_projects[name]
        project_name_field(name, "项目名", error=ServiceConfigError)
        if not isinstance(raw, Mapping):
            raise ServiceConfigError(f"projects.{name} 必须是表")
        fields = cast("Mapping[str, object]", raw)
        reject_unknown_keys(fields, _PROJECT_KEYS, f"projects.{name}", error=ServiceConfigError)
        profiles[name] = ProjectProfile(
            name=name,
            path=text_field(fields.get("path"), f"projects.{name}.path", error=ServiceConfigError),
            pi_command=command_field(
                fields.get("pi_command"), f"projects.{name}.pi_command", error=ServiceConfigError
            ),
            test_command=command_field(
                fields.get("test_command"),
                f"projects.{name}.test_command",
                error=ServiceConfigError,
            ),
            baseline=optional_text_field(
                fields.get("baseline"), f"projects.{name}.baseline", error=ServiceConfigError
            ),
            pi_home=text_field(
                fields.get("pi_home"), f"projects.{name}.pi_home", error=ServiceConfigError
            ),
        )
    return MappingProxyType(profiles)


def resolve_panel_settings(value: object | None = None) -> PanelSettings:
    """解析面板会话设置：``[panel]`` 表缺省即用内建默认，出现非法值则显式失败。

    ``turn_timeout_seconds`` 是**单轮**上限（一轮要跑完 PI 的 dev/review/测试，分钟级），
    超时按失败处理并登记「待人工决定」，不静默重试。
    """

    if value is None:
        return PanelSettings(
            concurrency=DEFAULT_PANEL_CONCURRENCY,
            turn_timeout_seconds=DEFAULT_TURN_TIMEOUT_SECONDS,
            session_idle_seconds=DEFAULT_SESSION_IDLE_SECONDS,
            max_live_sessions=DEFAULT_MAX_LIVE_SESSIONS,
            tool_approval=DEFAULT_TOOL_APPROVAL,
        )
    if not isinstance(value, Mapping):
        raise ServiceConfigError("panel 必须是表（形如 [panel]）")
    fields = cast("Mapping[str, object]", value)
    reject_unknown_keys(fields, _PANEL_KEYS, "panel", error=ServiceConfigError)
    return PanelSettings(
        concurrency=integer_field(
            fields.get("concurrency", DEFAULT_PANEL_CONCURRENCY),
            "panel.concurrency",
            minimum=1,
            maximum=MAX_PANEL_CONCURRENCY,
            error=ServiceConfigError,
        ),
        turn_timeout_seconds=integer_field(
            fields.get("turn_timeout_seconds", DEFAULT_TURN_TIMEOUT_SECONDS),
            "panel.turn_timeout_seconds",
            minimum=1,
            error=ServiceConfigError,
        ),
        session_idle_seconds=integer_field(
            fields.get("session_idle_seconds", DEFAULT_SESSION_IDLE_SECONDS),
            "panel.session_idle_seconds",
            minimum=1,
            error=ServiceConfigError,
        ),
        max_live_sessions=integer_field(
            fields.get("max_live_sessions", DEFAULT_MAX_LIVE_SESSIONS),
            "panel.max_live_sessions",
            minimum=1,
            maximum=MAX_LIVE_SESSIONS,
            error=ServiceConfigError,
        ),
        tool_approval=_tool_approval(fields.get("tool_approval", DEFAULT_TOOL_APPROVAL)),
    )


def _tool_approval(value: object) -> str:
    """工具审批策略：``off``（不审）、``write``（写文件与执行）、``all``（全部工具）。"""

    text = text_field(value, "panel.tool_approval", error=ServiceConfigError)
    if text not in TOOL_APPROVAL_POLICIES:
        allowed = "、".join(TOOL_APPROVAL_POLICIES)
        raise ServiceConfigError(f"panel.tool_approval 必须是 {allowed} 之一，实际 {text!r}")
    return text
