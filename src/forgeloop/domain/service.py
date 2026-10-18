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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import cast

SERVICE_SCHEMA_VERSION = 1
"""``config/service.toml`` 的 schema 版本；不匹配即拒绝启动。"""

DEFAULT_SERVICE_HOST = "127.0.0.1"
DEFAULT_SERVICE_PORT = 8712
"""默认监听回环 8712（``web`` 用 8710、前端浏览器用例用 8711，互不占用）。"""

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
DEFAULT_POLL_SECONDS = 2
DEFAULT_MAX_CONCURRENT = 2
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
    }
)
_PROJECT_KEYS = frozenset({"path", "pi_command", "test_command", "baseline", "pi_home"})


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
class ServiceSettings:
    """生效的常驻服务设置；``projects`` 为空表示只提供只读页面、不执行任务。"""

    host: str
    port: int
    poll_seconds: int
    max_concurrent: int
    auto_advance: bool
    projects: Mapping[str, ProjectProfile]


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
    _reject_unknown(config, _TOP_LEVEL_KEYS, "常驻服务配置")
    if document is not None:
        version = document.get("schema_version")
        if version != SERVICE_SCHEMA_VERSION:
            raise ServiceConfigError(
                f"常驻服务配置的 schema_version 必须是 {SERVICE_SCHEMA_VERSION}，实际 {version!r}"
            )
    return ServiceSettings(
        host=_resolve_host(host if host is not None else config.get("host")),
        port=_resolve_port(port if port is not None else config.get("port")),
        poll_seconds=_integer(
            config.get("poll_seconds", DEFAULT_POLL_SECONDS), "poll_seconds", minimum=1
        ),
        max_concurrent=_integer(
            config.get("max_concurrent", DEFAULT_MAX_CONCURRENT), "max_concurrent", minimum=1
        ),
        auto_advance=_flag(config.get("auto_advance", False), "auto_advance"),
        projects=_resolve_projects(config.get("projects")),
    )


def host_is_loopback(host: str) -> bool:
    """判断是否是允许的监听地址（页面操作入口依赖「只有本机能访问」这一前提）。"""

    return host in LOOPBACK_HOSTS


def _reject_unknown(mapping: Mapping[str, object], allowed: frozenset[str], where: str) -> None:
    """拒绝未知键：配置写错名字时失败，而不是静默忽略。"""

    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise ServiceConfigError(f"{where} 含未知配置项: {'、'.join(unknown)}")


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ServiceConfigError(f"{name} 必须是非空字符串")
    return value


def _optional_text(value: object, name: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ServiceConfigError(f"{name} 必须是字符串")
    return value


def _integer(value: object, name: str, *, minimum: int, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ServiceConfigError(f"{name} 必须是整数")
    if value < minimum or (maximum is not None and value > maximum):
        bound = f"{minimum}..{maximum}" if maximum is not None else f">= {minimum}"
        raise ServiceConfigError(f"{name} 必须在 {bound} 范围内，实际 {value}")
    return value


def _flag(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ServiceConfigError(f"{name} 必须是布尔值")
    return value


def _command(value: object, name: str) -> tuple[str, ...]:
    """校验 argv 数组：不接受字符串（拆词歧义），也不接受空数组。"""

    if isinstance(value, str) or not isinstance(value, Sequence):
        raise ServiceConfigError(f"{name} 必须是字符串数组")
    raw_items = cast("Sequence[object]", value)
    if not raw_items:
        raise ServiceConfigError(f"{name} 不能为空")
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str) or not item.strip():
            raise ServiceConfigError(f"{name} 的每一项都必须是非空字符串")
        items.append(item)
    return tuple(items)


def _resolve_host(value: object | None) -> str:
    if value is None:
        return DEFAULT_SERVICE_HOST
    text = _text(value, "host")
    if not host_is_loopback(text):
        allowed = "、".join(sorted(LOOPBACK_HOSTS))
        raise ServiceConfigError(
            f"host 只允许回环地址（{allowed}），实际 {text}；常驻服务不对外暴露"
        )
    return text


def _resolve_port(value: object | None) -> int:
    if value is None:
        return DEFAULT_SERVICE_PORT
    return _integer(value, "port", minimum=MIN_PORT, maximum=MAX_PORT)


def _resolve_projects(value: object | None) -> Mapping[str, ProjectProfile]:
    if value is None:
        return MappingProxyType({})
    if not isinstance(value, Mapping):
        raise ServiceConfigError("projects 必须是表（形如 [projects.<名字>]）")
    raw_projects = cast("Mapping[str, object]", value)
    profiles: dict[str, ProjectProfile] = {}
    for name in sorted(raw_projects):
        raw = raw_projects[name]
        if not name.strip() or any(character.isspace() for character in name):
            raise ServiceConfigError(f"项目名必须非空且不含空白字符，实际 {name!r}")
        if not isinstance(raw, Mapping):
            raise ServiceConfigError(f"projects.{name} 必须是表")
        fields = cast("Mapping[str, object]", raw)
        _reject_unknown(fields, _PROJECT_KEYS, f"projects.{name}")
        profiles[name] = ProjectProfile(
            name=name,
            path=_text(fields.get("path"), f"projects.{name}.path"),
            pi_command=_command(fields.get("pi_command"), f"projects.{name}.pi_command"),
            test_command=_command(fields.get("test_command"), f"projects.{name}.test_command"),
            baseline=_optional_text(fields.get("baseline"), f"projects.{name}.baseline"),
            pi_home=_text(fields.get("pi_home"), f"projects.{name}.pi_home"),
        )
    return MappingProxyType(profiles)
