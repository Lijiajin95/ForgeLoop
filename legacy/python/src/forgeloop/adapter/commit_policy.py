"""本机提交策略配置的 IO 边界：发现并读取生效配置与年历。

仓库只发布模板 ``config/commit-policy.template.toml``；**实际生效的配置不入库**，
只从本机按固定优先级二选一读取：

1. ``<repo>/.cache/forgeloop/commit-policy.toml``（仓库内缓存，已被 gitignore）
2. ``~/.config/forgeloop/commit-policy.toml``（用户级，位于仓库之外）

高优先级文件存在时只读取它，低优先级文件即使存在也不参与，因此同一机器上只有
一个确定的配置来源，不会把两份配置叠加。两者都不存在时返回“没有生效配置”，
由调用方放行并显式标注未强制，不假装规则仍然生效。

历史路径 ``commit-policy.local.toml``（旧“本地覆盖”命名）已废弃：只存在旧文件时
本模块报错要求迁移，而不是静默忽略——静默忽略会让原本受强制的机器在无提示下
变成不强制。本模块只负责 IO 与原始文档；策略构造是
``forgeloop.domain.commit_policy`` 的纯规则——作为叶子层的 ``adapter`` 不 import
任何 ``forgeloop.*``。
"""

from __future__ import annotations

import json
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

POLICY_CONFIG_RELATIVES = (
    Path(".cache/forgeloop/commit-policy.toml"),
    Path(".config/forgeloop/commit-policy.toml"),
)
LEGACY_OVERRIDE_RELATIVES = (
    Path(".cache/forgeloop/commit-policy.local.toml"),
    Path(".config/forgeloop/commit-policy.local.toml"),
)

# 生效配置来源标签：仓库内缓存或用户级配置。
ORIGIN_REPOSITORY_LOCAL = "repository_local"
ORIGIN_USER_LOCAL = "user_local"


@dataclass(frozen=True)
class PolicyConfigCandidate:
    """一个生效配置候选：来源标签与具体路径。"""

    origin: str
    path: Path


@dataclass(frozen=True)
class PolicyDocuments:
    """一次加载得到的原始文档：生效配置（可能缺失）与年历。"""

    config_path: Path | None = None
    config: Mapping[str, Any] | None = None
    calendars: Mapping[int, Mapping[str, Any]] = field(default_factory=dict[int, Mapping[str, Any]])
    origin: str | None = None

    @property
    def has_policy(self) -> bool:
        return self.config is not None


def policy_config_candidates(repo_root: Path, home: Path) -> tuple[PolicyConfigCandidate, ...]:
    """按优先级从高到低列出生效配置候选（列表顺序即解析顺序）。"""

    return (
        PolicyConfigCandidate(ORIGIN_REPOSITORY_LOCAL, repo_root / POLICY_CONFIG_RELATIVES[0]),
        PolicyConfigCandidate(ORIGIN_USER_LOCAL, home / POLICY_CONFIG_RELATIVES[1]),
    )


def select_policy_config(
    candidates: tuple[PolicyConfigCandidate, ...],
) -> PolicyConfigCandidate | None:
    """二选一：返回第一个存在的候选，全部缺失时返回 ``None``。"""

    for candidate in candidates:
        if candidate.path.is_file():
            return candidate
    return None


def legacy_override_paths(repo_root: Path, home: Path) -> tuple[Path, ...]:
    """已废弃的旧“本地覆盖”路径，用于发现未迁移的机器。"""

    return (
        repo_root / LEGACY_OVERRIDE_RELATIVES[0],
        home / LEGACY_OVERRIDE_RELATIVES[1],
    )


def read_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def load_calendars(directory: Path) -> dict[int, Mapping[str, Any]]:
    """读取年历目录下的 JSON，按年份索引；重复年份或非法来源即拒绝。"""

    calendars: dict[int, Mapping[str, Any]] = {}
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        year = data["year"]
        if type(year) is not int or year in calendars:
            raise ValueError("Invalid or duplicate calendar year")
        if not str(data.get("source_url", "")).startswith("https://"):
            raise ValueError("Invalid calendar source")
        calendars[year] = data
    return calendars


def resolve_calendar_directory(repo_root: Path, configured: str) -> Path:
    """年历目录：相对路径按仓库根解析，绝对路径原样使用。"""

    directory = Path(configured)
    return directory if directory.is_absolute() else repo_root / directory


def load_policy_documents(repo_root: Path, *, home: Path | None = None) -> PolicyDocuments:
    """加载生效配置与年历；没有生效配置时返回空文档而不是报错。"""

    home = Path.home() if home is None else home
    selected = select_policy_config(policy_config_candidates(repo_root, home))
    if selected is None:
        stale = [path for path in legacy_override_paths(repo_root, home) if path.is_file()]
        if stale:
            joined = ", ".join(str(path) for path in stale)
            raise ValueError(
                f"Legacy commit policy override found at {joined}; migrate it to "
                f"{POLICY_CONFIG_RELATIVES[0]} (repository cache) or "
                f"~/{POLICY_CONFIG_RELATIVES[1]} (user level)"
            )
        return PolicyDocuments()
    config = read_toml(selected.path)
    calendars = load_calendars(
        resolve_calendar_directory(repo_root, str(config["calendar_directory"]))
    )
    return PolicyDocuments(
        config_path=selected.path,
        config=config,
        calendars=calendars,
        origin=selected.origin,
    )
