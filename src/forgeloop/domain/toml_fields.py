"""TOML 配置字段的公共校验原语（domain 层，纯判定）。

常驻服务配置（``domain.service``）与页面项目档案（``domain.projects``）校验的是同一类
字段——字符串、整数、布尔、argv 数组与项目名。规则只写一份，两边各自传入自己的异常
类型（``ServiceConfigError`` 与 ``PanelProjectError``），因此错误消息能指明是哪个配置
文件，而校验口径不会各自漂移。

本模块不读文件、不认识路径，也不做任何服务化检查（目录是否存在由调用方负责）。
"""

from collections.abc import Callable, Mapping, Sequence
from typing import cast

ErrorFactory = Callable[[str], Exception]
"""把失败消息包装成调用方自己的异常类型（配置损坏必须显式失败，不静默回落）。"""

_SAFE_NAME_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def reject_unknown_keys(
    mapping: Mapping[str, object],
    allowed: frozenset[str],
    where: str,
    *,
    error: ErrorFactory,
) -> None:
    """拒绝未知键：配置写错名字时失败，而不是静默忽略。"""

    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise error(f"{where} 含未知配置项: {'、'.join(unknown)}")


def text_field(value: object, name: str, *, error: ErrorFactory) -> str:
    if not isinstance(value, str) or not value.strip():
        raise error(f"{name} 必须是非空字符串")
    return value


def optional_text_field(value: object, name: str, *, error: ErrorFactory) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise error(f"{name} 必须是字符串")
    return value


def integer_field(
    value: object,
    name: str,
    *,
    minimum: int,
    maximum: int | None = None,
    error: ErrorFactory,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise error(f"{name} 必须是整数")
    if value < minimum or (maximum is not None and value > maximum):
        bound = f"{minimum}..{maximum}" if maximum is not None else f">= {minimum}"
        raise error(f"{name} 必须在 {bound} 范围内，实际 {value}")
    return value


def number_field(
    value: object,
    name: str,
    *,
    minimum: float,
    maximum: float,
    error: ErrorFactory,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error(f"{name} 必须是数字")
    number = float(value)
    if number < minimum or number > maximum:
        raise error(f"{name} 必须在 {minimum}..{maximum} 范围内，实际 {number}")
    return number


def flag_field(value: object, name: str, *, error: ErrorFactory) -> bool:
    if not isinstance(value, bool):
        raise error(f"{name} 必须是布尔值")
    return value


def command_field(value: object, name: str, *, error: ErrorFactory) -> tuple[str, ...]:
    """校验 argv 数组：不接受字符串（拆词歧义），也不接受空数组。"""

    if isinstance(value, str) or not isinstance(value, Sequence):
        raise error(f"{name} 必须是字符串数组")
    raw_items = cast("Sequence[object]", value)
    if not raw_items:
        raise error(f"{name} 不能为空")
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str) or not item.strip():
            raise error(f"{name} 的每一项都必须是非空字符串")
        items.append(item)
    return tuple(items)


def project_name_field(value: str, name: str, *, error: ErrorFactory) -> str:
    """项目名：非空、无空白、只用安全字符（写进 TOML 表名时不产生歧义）。"""

    if not value.strip() or any(character.isspace() for character in value):
        raise error(f"{name} 必须非空且不含空白字符，实际 {value!r}")
    if not set(value) <= _SAFE_NAME_CHARS:
        raise error(f"{name} 只能包含字母、数字与 - _ . ，实际 {value!r}")
    return value
