"""本机提交策略覆盖的 IO 边界：发现并读取仓库默认配置与本地覆盖 TOML。

仓库默认来自 ``config/commit-policy.toml``（随版本分发）；本地覆盖只从仓库外
或未纳入版本控制的路径读取，并按固定优先级二选一：

1. ``<repo>/.cache/forgeloop/commit-policy.local.toml``（仓库内缓存，已被 gitignore）
2. ``~/.config/forgeloop/commit-policy.local.toml``（用户级，位于仓库之外）

高优先级文件存在时只读取它，低优先级文件即使存在也不参与，因此同一机器上
只有一个确定的覆盖来源，不会把两份覆盖叠加。本模块只负责 IO 与原始文档；
键级合并与生效策略构造是 ``forgeloop.domain.commit_policy`` 的纯规则——作为
叶子层的 ``adapter`` 不 import 任何 ``forgeloop.*``。
"""

from __future__ import annotations

import json
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_RELATIVE = Path("config/commit-policy.toml")
REPOSITORY_LOCAL_OVERRIDE_RELATIVE = Path(".cache/forgeloop/commit-policy.local.toml")
USER_LOCAL_OVERRIDE_RELATIVE = Path(".config/forgeloop/commit-policy.local.toml")

# 覆盖来源标签：仓库内缓存或用户级配置。
ORIGIN_REPOSITORY_LOCAL = "repository_local"
ORIGIN_USER_LOCAL = "user_local"


@dataclass(frozen=True)
class LocalOverrideCandidate:
    """一个本地覆盖候选：来源标签与具体路径。"""

    origin: str
    path: Path


@dataclass(frozen=True)
class PolicyDocuments:
    """一次加载得到的原始文档：默认配置、本地覆盖与年历。"""

    default_path: Path
    default: Mapping[str, Any]
    calendars: Mapping[int, Mapping[str, Any]]
    override_path: Path | None = None
    override: Mapping[str, Any] | None = None
    override_origin: str | None = None

    @property
    def has_local_override(self) -> bool:
        return self.override is not None


def local_override_candidates(repo_root: Path, home: Path) -> tuple[LocalOverrideCandidate, ...]:
    """按优先级从高到低列出本地覆盖候选（列表顺序即解析顺序）。"""

    return (
        LocalOverrideCandidate(
            ORIGIN_REPOSITORY_LOCAL, repo_root / REPOSITORY_LOCAL_OVERRIDE_RELATIVE
        ),
        LocalOverrideCandidate(ORIGIN_USER_LOCAL, home / USER_LOCAL_OVERRIDE_RELATIVE),
    )


def select_local_override(
    candidates: tuple[LocalOverrideCandidate, ...],
) -> LocalOverrideCandidate | None:
    """二选一：返回第一个存在的候选，全部缺失时返回 ``None``。"""

    for candidate in candidates:
        if candidate.path.is_file():
            return candidate
    return None


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


def load_policy_documents(repo_root: Path, *, home: Path | None = None) -> PolicyDocuments:
    """加载仓库默认配置、二选一后的本地覆盖与年历原始文档。"""

    home = Path.home() if home is None else home
    default_path = repo_root / DEFAULT_CONFIG_RELATIVE
    default = read_toml(default_path)
    calendars = load_calendars(repo_root / str(default["calendar_directory"]))
    selected = select_local_override(local_override_candidates(repo_root, home))
    if selected is None:
        return PolicyDocuments(default_path, default, calendars)
    return PolicyDocuments(
        default_path=default_path,
        default=default,
        calendars=calendars,
        override_path=selected.path,
        override=read_toml(selected.path),
        override_origin=selected.origin,
    )
