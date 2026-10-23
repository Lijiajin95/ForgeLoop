"""项目身份与项目记录根的纯规则。

一个项目是一段独立代码仓及其研发记录的受管对象。项目身份（``project_id``）是
稳定、可出现在路径与命令行里的 ASCII 标识；显示名与仓库路径可以变化，但身份
不能。项目记录根固定为 ``<records_root>/projects/<project_id>/``，需求、任务、
检查点、会话、worktree 与 git 镜像都在该目录内，从而形成物理隔离。

本模块只做字符串与路径组合校验，不访问文件系统：仓库是否存在、项目是否已登记
由 ``records.projects`` 与 CLI 判定。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

PROJECT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
"""项目身份：小写字母开头，2-63 位小写字母/数字/连字符。"""

MAX_PROJECT_NAME_LENGTH = 100
PROJECTS_DIRNAME = "projects"
"""项目记录根在记录根下的目录名。"""


class ProjectError(ValueError):
    """项目规则不满足：身份、显示名或仓库路径非法。"""


class ProjectNotFoundError(ProjectError):
    """按身份回查项目时项目未登记。"""


@dataclass(frozen=True)
class Project:
    """一个已登记项目：稳定身份、显示名、仓库路径与默认分支。

    ``legacy_project`` 只在一次性迁移后非空：它是旧记录里使用过的项目名，
    用于把既有 ``tasks.project``/``requirements.project`` 值解析回本项目。
    """

    project_id: str
    name: str
    repo_path: str
    default_branch: str
    created_at: datetime
    legacy_project: str = ""


def validate_project_id(value: str) -> str:
    """校验并返回项目身份；非法时抛 :class:`ProjectError`。

    禁止大小写混用、路径分隔符、点段、连续或结尾连字符：身份会直接成为目录名，
    宽松规则会把 ``../`` 之类的输入变成路径穿越。
    """

    if not PROJECT_ID_PATTERN.fullmatch(value):
        raise ProjectError(
            f"项目身份必须是 2-63 位小写字母/数字/连字符，并以小写字母开头: {value!r}"
        )
    if "--" in value or value.endswith("-"):
        raise ProjectError(f"项目身份不能包含连续或结尾连字符: {value!r}")
    return value


def validate_project_name(value: str) -> str:
    """校验并返回显示名；去掉首尾空白，禁止换行与空白名。"""

    name = value.strip()
    if not name:
        raise ProjectError("项目显示名不能为空")
    if "\n" in name or "\r" in name:
        raise ProjectError("项目显示名不能包含换行")
    if len(name) > MAX_PROJECT_NAME_LENGTH:
        raise ProjectError(f"项目显示名不能超过 {MAX_PROJECT_NAME_LENGTH} 个字符")
    return name


def validate_repo_path(value: str) -> str:
    """校验并返回仓库路径字符串；只查形状，不查存在性。"""

    if not value.strip():
        raise ProjectError("项目仓库路径不能为空")
    if "\x00" in value or "\n" in value or "\r" in value:
        raise ProjectError("项目仓库路径不能包含 NUL 或换行")
    return value.strip()


def validate_default_branch(value: str) -> str:
    """校验并返回默认分支名；空串表示由仓库 HEAD 决定。"""

    branch = value.strip()
    if not branch:
        return ""
    if branch.startswith("-") or ".." in branch or "\n" in branch or "\r" in branch:
        raise ProjectError(f"默认分支名非法: {value!r}")
    return branch


def project_data_root(records_root: Path, project_id: str) -> Path:
    """项目记录根：``<records_root>/projects/<project_id>``。

    身份先经校验，调用方不能借路径参数跳出 ``projects`` 目录。
    """

    return records_root / PROJECTS_DIRNAME / validate_project_id(project_id)
