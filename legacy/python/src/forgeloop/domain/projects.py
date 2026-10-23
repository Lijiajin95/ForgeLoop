"""页面项目档案的纯规则（domain 层）：校验、合并与 TOML 序列化。

职责边界：

- **谁能改项目**：``config/service.toml`` 的 ``[projects.<名字>]`` 是所有者手写的执行档案，
  页面**只读**；页面新增/编辑/删除的是本模块的**面板项目档案**
  （默认 ``config/projects.toml``，由页面独占写入）。两处同名视为配置冲突，显式失败，
  不静默覆盖——项目身份只能有一个来源。
- **只做判定与文本生成**：字段校验、合并、确定性 TOML 文本都在这里。路径是否存在、
  是不是 git 仓库、PI HOME 是否可用由 ``cli.serve`` 检查（本模块不碰文件系统）。
- **确定性序列化**：面板档案整份由页面生成，因此可以做「同内容 → 同文本」的输出：
  键按名字排序、字符串统一转义，便于人工复核 diff。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import cast

from forgeloop.domain.service import ProjectProfile
from forgeloop.domain.toml_fields import (
    command_field,
    optional_text_field,
    project_name_field,
    reject_unknown_keys,
    text_field,
)

PANEL_PROJECTS_SCHEMA_VERSION = 1
"""``config/projects.toml`` 的 schema 版本；不匹配即拒绝读取，不猜旧格式。"""

DEFAULT_PROJECTS_FILE = "config/projects.toml"
SOURCE_PANEL = "panel"
SOURCE_SERVICE = "service"
_PANEL_PROJECT_KEYS = frozenset({"path", "description", "pi_command", "pi_home"})
_TOP_LEVEL_KEYS = frozenset({"schema_version", "projects"})


class PanelProjectError(ValueError):
    """项目档案非法（未知键、字段缺失、同名冲突）：显式失败，不静默回落。"""


@dataclass(frozen=True)
class PanelProject:
    """一份页面管理的项目档案：被开发项目路径与它的执行器命令、隔离 HOME。"""

    name: str
    path: str
    description: str
    pi_command: tuple[str, ...]
    pi_home: str


@dataclass(frozen=True)
class ProjectEntry:
    """面板展示用的项目视图：``source`` 说明它由页面还是手写配置管理。"""

    name: str
    path: str
    description: str
    pi_command: tuple[str, ...]
    pi_home: str
    source: str

    @property
    def editable(self) -> bool:
        """只有页面管理的档案能在页面上改；手写配置改文件，不由页面代笔。"""

        return self.source == SOURCE_PANEL


def resolve_panel_projects(document: Mapping[str, object] | None) -> Mapping[str, PanelProject]:
    """解析面板项目档案文档；``None``（文件不存在）表示空档案。"""

    if document is None:
        return MappingProxyType({})
    reject_unknown_keys(document, _TOP_LEVEL_KEYS, "面板项目档案", error=PanelProjectError)
    version = document.get("schema_version")
    if version != PANEL_PROJECTS_SCHEMA_VERSION:
        raise PanelProjectError(
            f"面板项目档案的 schema_version 必须是 {PANEL_PROJECTS_SCHEMA_VERSION}，实际 {version!r}"
        )
    raw_projects = document.get("projects")
    if raw_projects is None:
        return MappingProxyType({})
    if not isinstance(raw_projects, Mapping):
        raise PanelProjectError("projects 必须是表（形如 [projects.<名字>]）")
    projects: dict[str, PanelProject] = {}
    for name, raw in sorted(cast("Mapping[str, object]", raw_projects).items()):
        if not isinstance(raw, Mapping):
            raise PanelProjectError(f"projects.{name} 必须是表")
        projects[name] = project_from_fields(name, cast("Mapping[str, object]", raw))
    return MappingProxyType(projects)


def project_from_fields(name: str, fields: Mapping[str, object]) -> PanelProject:
    """由页面传入的字段构造一份项目档案：字段缺失或非法即失败（写路径的唯一入口）。"""

    project_name_field(name, "项目名", error=PanelProjectError)
    reject_unknown_keys(fields, _PANEL_PROJECT_KEYS, f"projects.{name}", error=PanelProjectError)
    path = text_field(fields.get("path"), f"projects.{name}.path", error=PanelProjectError)
    pi_home = text_field(fields.get("pi_home"), f"projects.{name}.pi_home", error=PanelProjectError)
    return PanelProject(
        name=name,
        path=path,
        description=optional_text_field(
            fields.get("description"), f"projects.{name}.description", error=PanelProjectError
        ),
        pi_command=command_field(
            fields.get("pi_command"), f"projects.{name}.pi_command", error=PanelProjectError
        ),
        pi_home=pi_home,
    )


def merge_projects(
    service_projects: Mapping[str, ProjectProfile],
    panel_projects: Mapping[str, PanelProject],
) -> tuple[ProjectEntry, ...]:
    """合并两个来源的项目档案，按名字排序；同名视为冲突（项目身份只能有一个来源）。"""

    duplicates = sorted(set(service_projects) & set(panel_projects))
    if duplicates:
        raise PanelProjectError(
            "项目名在 config/service.toml 与面板项目档案中重复："
            + "、".join(duplicates)
            + "；同一项目只能有一个来源"
        )
    entries = [
        ProjectEntry(
            name=name,
            path=profile.path,
            description="",
            pi_command=profile.pi_command,
            pi_home=profile.pi_home,
            source=SOURCE_SERVICE,
        )
        for name, profile in service_projects.items()
    ]
    entries.extend(
        ProjectEntry(
            name=project.name,
            path=project.path,
            description=project.description,
            pi_command=project.pi_command,
            pi_home=project.pi_home,
            source=SOURCE_PANEL,
        )
        for project in panel_projects.values()
    )
    return tuple(sorted(entries, key=lambda entry: entry.name))


def serialize_panel_projects(projects: Mapping[str, PanelProject]) -> str:
    """把面板项目档案写成确定性 TOML 文本（键排序、字符串转义、可人工复核）。"""

    lines = [
        "# 页面「开发项目管理」维护的项目档案；手工编辑同样生效。",
        "# config/service.toml 的 [projects.<名字>] 由所有者手写，本文件不得与它同名。",
        f"schema_version = {PANEL_PROJECTS_SCHEMA_VERSION}",
        "",
    ]
    for name in sorted(projects):
        project = projects[name]
        lines.append(f"[projects.{_toml_key(name)}]")
        lines.append(f"path = {_toml_string(project.path)}")
        lines.append(f"description = {_toml_string(project.description)}")
        lines.append(
            "pi_command = [" + ", ".join(_toml_string(item) for item in project.pi_command) + "]"
        )
        lines.append(f"pi_home = {_toml_string(project.pi_home)}")
        lines.append("")
    return "\n".join(lines)


def _toml_key(name: str) -> str:
    """表名一律加引号：项目名里的 ``.`` 否则会被解析成嵌套表。"""

    return _toml_string(name)


def _toml_string(value: str) -> str:
    """基本字符串转义：反斜杠、引号与控制字符（``\\uXXXX``）逐字转义。"""

    escaped: list[str] = ['"']
    for character in value:
        if character == "\\":
            escaped.append("\\\\")
        elif character == '"':
            escaped.append('\\"')
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\r":
            escaped.append("\\r")
        elif character == "\t":
            escaped.append("\\t")
        elif ord(character) < 0x20:
            escaped.append(f"\\u{ord(character):04X}")
        else:
            escaped.append(character)
    escaped.append('"')
    return "".join(escaped)
