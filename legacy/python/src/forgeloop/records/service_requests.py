"""持久操作请求（T1）：受理前落库、同需求幂等、消费只一次。

方案 §3.4：页面的 `_pending` 只是进程内调度提示；需要跨切换保留的显式请求必须在
入口返回 202 之前写进**项目库**。本表只保存“谁在何时请求对哪条需求执行哪个动作
（推进/分析/规划）”这一受理事实，不复制任务状态、不建立第二套队列，也不代替批准。

状态只有三种：`pending`（已受理、待消费）、`consumed`（已交给执行器一次）、
`dismissed`（需求已终态/明确撤销，不再执行）。消费是 `UPDATE … WHERE state='pending'`
的单事务操作，崩溃时不会把同一条请求重放两次。
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS service_requests (
    request_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    project TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    action TEXT NOT NULL DEFAULT 'advance',
    state TEXT NOT NULL,
    requested_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_pending_by_requirement
    ON service_requests(req_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS service_requests_by_state
    ON service_requests(state, created_at);
"""

STATE_PENDING = "pending"
STATE_CONSUMED = "consumed"
STATE_DISMISSED = "dismissed"
STATES: frozenset[str] = frozenset({STATE_PENDING, STATE_CONSUMED, STATE_DISMISSED})
ACTION_ADVANCE = "advance"
ACTION_ANALYZE = "analyze"
ACTION_PLAN = "plan"
ACTIONS: frozenset[str] = frozenset({ACTION_ADVANCE, ACTION_ANALYZE, ACTION_PLAN})


@dataclass(frozen=True)
class ServiceRequest:
    """一条持久推进请求的受理事实。"""

    request_id: str
    req_id: str
    project: str
    plan_version: int
    state: str
    requested_by: str = ""
    source: str = ""
    created_at: str = ""
    resolved_at: str = ""
    detail: str = ""
    action: str = ACTION_ADVANCE


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _validated(
    *,
    req_id: str,
    project: str,
    plan_version: int,
    requested_by: str,
    source: str,
    action: str,
) -> None:
    if not req_id.strip():
        raise ValueError("操作请求必须给出需求身份")
    if not project.strip():
        raise ValueError("操作请求必须给出项目身份")
    if isinstance(plan_version, bool) or plan_version < 0:
        raise ValueError("操作请求的任务包版本必须是非负整数（0 表示尚无任务包）")
    if not requested_by.strip():
        raise ValueError("操作请求必须给出调用方身份")
    if not source.strip():
        raise ValueError("操作请求必须给出来源")
    if action not in ACTIONS:
        allowed = "、".join(sorted(ACTIONS))
        raise ValueError(f"操作请求的动作必须是 {allowed} 之一，实际 {action!r}")


class ServiceRequestStore:
    """项目库里的持久推进请求；每个项目独立一个 `records.sqlite`。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """旧库补上 ``action`` 列：历史请求都是显式推进。"""

        columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(service_requests)")}
        if "action" not in columns:
            self._db.execute(
                "ALTER TABLE service_requests ADD COLUMN action TEXT NOT NULL DEFAULT 'advance'"
            )

    def close(self) -> None:
        self._db.close()

    def record(
        self,
        *,
        req_id: str,
        project: str,
        plan_version: int,
        requested_by: str,
        source: str,
        request_id: str = "",
        action: str = ACTION_ADVANCE,
    ) -> ServiceRequest:
        """记录一次受理；同需求已有 pending 或同 request_id 重复调用都返回既有事实。

        `request_id` 可由调用方提供（页面幂等键）；缺省时生成新的稳定身份。重复的
        request_id 若指向不同需求/版本，说明调用方在复用身份——明确拒绝，不覆盖。
        """

        _validated(
            req_id=req_id,
            project=project,
            plan_version=plan_version,
            requested_by=requested_by,
            source=source,
            action=action,
        )
        if request_id and not request_id.strip():
            raise ValueError("request_id 不能是空白字符串")
        self._db.execute("BEGIN IMMEDIATE")
        try:
            if request_id:
                existing = self._get_locked(request_id)
                if existing is not None:
                    if (
                        existing.req_id,
                        existing.project,
                        existing.plan_version,
                        existing.action,
                    ) != (
                        req_id,
                        project,
                        plan_version,
                        action,
                    ):
                        raise ValueError(
                            f"request_id {request_id} 已用于不同需求/版本/动作；拒绝复用"
                        )
                    self._db.execute("COMMIT")
                    return existing
            pending = self._db.execute(
                "SELECT request_id, req_id, project, plan_version, state, requested_by,"
                " source, created_at, resolved_at, detail, action FROM service_requests"
                " WHERE req_id = ? AND state = ? LIMIT 1",
                (req_id, STATE_PENDING),
            ).fetchone()
            if pending is not None:
                existing = _from_row(pending)
                if existing.action != action:
                    raise ValueError(
                        f"需求 {req_id} 已有待处理的操作 {existing.action}；"
                        f"不能同时排队 {action}，请等待它执行完再试"
                    )
                self._db.execute("COMMIT")
                return existing
            new_id = request_id or f"{action[:3]}-{uuid.uuid4().hex}"
            created_at = _now()
            self._db.execute(
                "INSERT INTO service_requests"
                " (request_id, req_id, project, plan_version, action, state, requested_by,"
                " source, created_at, resolved_at, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')",
                (
                    new_id,
                    req_id,
                    project,
                    plan_version,
                    action,
                    STATE_PENDING,
                    requested_by.strip(),
                    source.strip(),
                    created_at,
                ),
            )
            row = self._get_locked(new_id)
            assert row is not None
            self._db.execute("COMMIT")
            return row
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    def _get_locked(self, request_id: str) -> ServiceRequest | None:
        row = self._db.execute(
            "SELECT request_id, req_id, project, plan_version, state, requested_by, source,"
            " created_at, resolved_at, detail, action FROM service_requests"
            " WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        return None if row is None else _from_row(row)

    def get(self, request_id: str) -> ServiceRequest | None:
        return self._get_locked(request_id)

    def pending(self) -> tuple[ServiceRequest, ...]:
        rows = self._db.execute(
            "SELECT request_id, req_id, project, plan_version, state, requested_by, source,"
            " created_at, resolved_at, detail, action FROM service_requests"
            " WHERE state = ? ORDER BY created_at, rowid",
            (STATE_PENDING,),
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    def all(self) -> tuple[ServiceRequest, ...]:
        rows = self._db.execute(
            "SELECT request_id, req_id, project, plan_version, state, requested_by, source,"
            " created_at, resolved_at, detail, action FROM service_requests"
            " ORDER BY created_at, rowid"
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    def consume(self, request_id: str, *, detail: str = "") -> bool:
        """把 pending 原子地消费一次；已消费/已撤销/不存在都返回 False。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            cursor = self._db.execute(
                "UPDATE service_requests SET state = ?, resolved_at = ?, detail = ?"
                " WHERE request_id = ? AND state = ?",
                (STATE_CONSUMED, _now(), detail, request_id, STATE_PENDING),
            )
            changed = cursor.rowcount == 1
            self._db.execute("COMMIT")
            return changed
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    def dismiss(self, req_id: str, *, reason: str = "") -> bool:
        """撤销该需求所有 pending 请求（终态/人工取消）；返回是否真的改了行。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            cursor = self._db.execute(
                "UPDATE service_requests SET state = ?, resolved_at = ?, detail = ?"
                " WHERE req_id = ? AND state = ?",
                (STATE_DISMISSED, _now(), reason, req_id, STATE_PENDING),
            )
            changed = cursor.rowcount > 0
            self._db.execute("COMMIT")
            return changed
        except BaseException:
            self._db.execute("ROLLBACK")
            raise


def _from_row(row: tuple[object, ...]) -> ServiceRequest:
    return ServiceRequest(
        request_id=str(row[0]),
        req_id=str(row[1]),
        project=str(row[2]),
        plan_version=int(str(row[3])),
        state=str(row[4]),
        requested_by=str(row[5]),
        source=str(row[6]),
        created_at=str(row[7]),
        resolved_at=str(row[8] or ""),
        detail=str(row[9]),
        action=str(row[10] if len(row) > 10 else ACTION_ADVANCE),
    )
