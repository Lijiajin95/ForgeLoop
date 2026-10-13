"""需求受理的持久化：分配身份、保存原文与追加版本、按身份与项目回查。

记录层只做持久化与重放，规则来自 ``domain.requirement``：
- 首次提交分配全局唯一身份，原文是版本 1；追加只新增行，不覆盖历史。
- 未知身份按身份回查必须明确失败。
- 项目是查询边界，不同项目的需求不混用。

本模块管理自己的 SQLite 连接与表；与 ``records.store`` 使用同一数据库文件时
各表独立，不修改既有任务记录实现。
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.requirement import (
    Requirement,
    RequirementNotFoundError,
    RequirementVersion,
    allocate_requirement_id,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS requirements (
    req_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_versions (
    req_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, version)
);
"""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


class RequirementStore:
    """需求身份与修订版本的 SQLite 权威记录。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def submit(self, project: str, text: str) -> Requirement:
        """提交首次原文：分配需求身份并保存版本 1。"""

        requirement = Requirement(
            allocate_requirement_id(),
            project,
            (RequirementVersion(1, text, _now()),),
        )
        self._db.execute(
            "INSERT INTO requirements (req_id, project, created_at) VALUES (?, ?, ?)",
            (
                requirement.req_id,
                requirement.project,
                _iso(requirement.versions[0].created_at),
            ),
        )
        self._insert_version(requirement.req_id, requirement.versions[0])
        return requirement

    def append(self, req_id: str, text: str) -> Requirement:
        """为已有身份追加一个修订版本；未知身份明确失败。"""

        updated = self.get(req_id).append(text, _now())
        self._insert_version(req_id, updated.latest)
        return updated

    def get(self, req_id: str) -> Requirement:
        """按身份回查全部版本；未知身份抛 RequirementNotFoundError。"""

        row = self._db.execute(
            "SELECT project FROM requirements WHERE req_id = ?", (req_id,)
        ).fetchone()
        if row is None:
            raise RequirementNotFoundError(f"未知需求身份: {req_id}")
        rows = self._db.execute(
            "SELECT version, text, created_at FROM requirement_versions"
            " WHERE req_id = ? ORDER BY version",
            (req_id,),
        ).fetchall()
        versions = tuple(
            RequirementVersion(int(version), str(text), _parse(str(created_at)))
            for version, text, created_at in rows
        )
        return Requirement(req_id, str(row[0]), versions)

    def for_project(self, project: str) -> tuple[Requirement, ...]:
        """按项目回查需求；不同项目的需求不混用。"""

        rows = self._db.execute(
            "SELECT req_id FROM requirements WHERE project = ? ORDER BY created_at, req_id",
            (project,),
        ).fetchall()
        return tuple(self.get(str(row[0])) for row in rows)

    def _insert_version(self, req_id: str, version: RequirementVersion) -> None:
        self._db.execute(
            "INSERT INTO requirement_versions (req_id, version, text, created_at)"
            " VALUES (?, ?, ?, ?)",
            (req_id, version.version, version.text, _iso(version.created_at)),
        )
