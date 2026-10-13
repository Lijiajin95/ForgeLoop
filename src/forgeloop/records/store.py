"""本地任务与决定记录：进程退出后仍可回查的权威业务记录。

职责（架构 §3 最小持久化）：任务与配置快照、方案、批准与消费、
失败轮次与授权、工时账目、停止记录与交付引用。
图检查点由 LangGraph checkpointer 单独保存，本存储只放领域记录。
"""

import json
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.approval import (
    Approval,
    ApprovalBook,
    ApprovalStage,
    ConsumeResult,
    Plan,
)
from forgeloop.domain.counting import FailureRound, FailureStage, GrantLedger
from forgeloop.domain.limits import ExecutionBudget
from forgeloop.domain.release import ReleaseRecord

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    original_input TEXT NOT NULL,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
    task_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    goal TEXT NOT NULL,
    scope TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    test_command_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, version)
);
CREATE TABLE IF NOT EXISTS approvals (
    task_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    stage TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (task_id, stage, plan_version)
);
CREATE TABLE IF NOT EXISTS approval_consumption (
    task_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    stage TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY (task_id, plan_version, stage)
);
CREATE TABLE IF NOT EXISTS failure_rounds (
    round_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (task_id, round_id)
);
CREATE TABLE IF NOT EXISTS grants (
    task_id TEXT NOT NULL,
    grant_index INTEGER NOT NULL,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (task_id, grant_index)
);
CREATE TABLE IF NOT EXISTS budget (
    task_id TEXT PRIMARY KEY,
    limit_seconds REAL NOT NULL,
    consumed_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (
    task_id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    confirmed_at TEXT,
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS merges (
    task_id TEXT PRIMARY KEY,
    merge_commit TEXT NOT NULL,
    pushed INTEGER NOT NULL DEFAULT 0,
    push_detail TEXT NOT NULL DEFAULT '',
    merged_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
    task_id TEXT PRIMARY KEY,
    diff_path TEXT NOT NULL,
    report_path TEXT NOT NULL,
    delivered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
    task_id TEXT PRIMARY KEY,
    tag TEXT NOT NULL,
    merge_commit TEXT NOT NULL,
    baseline_commit TEXT NOT NULL,
    diff_sha256 TEXT NOT NULL,
    receipt_path TEXT NOT NULL,
    pushed INTEGER NOT NULL DEFAULT 0,
    push_detail TEXT NOT NULL DEFAULT '',
    released_at TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class TaskRecord:
    id: str
    project: str
    original_input: str
    config: dict[str, str]
    status: str
    created_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _release_from_row(row: Sequence[object]) -> ReleaseRecord:
    """发布记录行 → 领域对象（两处查询共用，避免重复映射）。"""

    return ReleaseRecord(
        task_id=str(row[0]),
        tag=str(row[1]),
        merge_commit=str(row[2]),
        baseline_commit=str(row[3]),
        diff_sha256=str(row[4]),
        receipt_path=str(row[5]),
        pushed=bool(row[6]),
        push_detail=str(row[7]),
        released_at=_parse(str(row[8])),
    )


class RecordStore:
    """SQLite 权威记录存储；CLI 查询由本存储生成。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    # ---- 任务 ----

    def create_task(
        self,
        task_id: str,
        project: str,
        original_input: str,
        config: dict[str, str],
        limit_seconds: float,
    ) -> TaskRecord:
        record = TaskRecord(task_id, project, original_input, config, "created", _now())
        self._db.execute(
            "INSERT INTO tasks (id, project, original_input, config_json, status, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                task_id,
                project,
                original_input,
                json.dumps(config, ensure_ascii=False, sort_keys=True),
                record.status,
                _iso(record.created_at),
            ),
        )
        self._db.execute(
            "INSERT INTO budget (task_id, limit_seconds, consumed_seconds) VALUES (?, ?, 0.0)",
            (task_id, limit_seconds),
        )
        return record

    def get_task(self, task_id: str) -> TaskRecord | None:
        row = self._db.execute(
            "SELECT id, project, original_input, config_json, status, created_at"
            " FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return TaskRecord(row[0], row[1], row[2], json.loads(row[3]), row[4], _parse(row[5]))

    def set_task_status(self, task_id: str, status: str) -> None:
        changed = self._db.execute(
            "UPDATE tasks SET status = ? WHERE id = ?", (status, task_id)
        ).rowcount
        if changed == 0:
            raise KeyError(f"Unknown task {task_id}")

    # ---- 方案 ----

    def save_plan(self, plan: Plan) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO plans"
            " (task_id, version, goal, scope, acceptance, test_command_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                plan.task_id,
                plan.version,
                plan.goal,
                plan.scope,
                plan.acceptance,
                json.dumps(list(plan.test_command), ensure_ascii=False),
                _iso(_now()),
            ),
        )

    def latest_plan(self, task_id: str) -> Plan | None:
        row = self._db.execute(
            "SELECT task_id, version, goal, scope, acceptance, test_command_json"
            " FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return Plan(row[0], row[1], row[2], row[3], row[4], tuple(json.loads(row[5])))

    # ---- 批准（领域对象由存储重建，消费落库） ----

    def _load_approval_book(self, task_id: str) -> ApprovalBook:
        rows = self._db.execute(
            "SELECT task_id, plan_version, stage, decided_at FROM approvals WHERE task_id = ?"
            " ORDER BY plan_version",
            (task_id,),
        ).fetchall()
        approvals = tuple(
            Approval(row[0], row[1], ApprovalStage(row[2]), _parse(row[3])) for row in rows
        )
        book = ApprovalBook(approvals)
        for row in self._db.execute(
            "SELECT task_id, plan_version, stage FROM approval_consumption WHERE task_id = ?",
            (task_id,),
        ).fetchall():
            book.mark_consumed(row[0], row[1], ApprovalStage(row[2]))
        return book

    def record_approval(self, approval: Approval) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO approvals (task_id, plan_version, stage, decided_at)"
            " VALUES (?, ?, ?, ?)",
            (
                approval.task_id,
                approval.plan_version,
                approval.stage.value,
                _iso(approval.decided_at),
            ),
        )

    def effective_approval(self, task_id: str, stage: ApprovalStage) -> Approval | None:
        return self._load_approval_book(task_id).effective(task_id, stage)

    def consume_approval(
        self, task_id: str, plan_version: int, stage: ApprovalStage
    ) -> ConsumeResult:
        book = self._load_approval_book(task_id)
        result = book.consume(task_id, plan_version, stage)
        if result.status.value == "ok":
            self._db.execute(
                "INSERT OR REPLACE INTO approval_consumption"
                " (task_id, plan_version, stage, consumed_at) VALUES (?, ?, ?, ?)",
                (task_id, plan_version, stage.value, _iso(_now())),
            )
        return result

    # ---- 失败轮次与授权 ----

    def _load_ledger(self, task_id: str) -> GrantLedger:
        grant_rows = self._db.execute(
            "SELECT grant_index FROM grants WHERE task_id = ? ORDER BY grant_index",
            (task_id,),
        ).fetchall()
        round_rows = self._db.execute(
            "SELECT round_id, stage, summary, occurred_at FROM failure_rounds"
            " WHERE task_id = ? ORDER BY occurred_at",
            (task_id,),
        ).fetchall()
        rounds = tuple(
            FailureRound(row[0], FailureStage(row[1]), row[2], _parse(row[3])) for row in round_rows
        )
        grants = len(grant_rows)
        if grants == 0:
            grants = 1
            self._db.execute(
                "INSERT INTO grants (task_id, grant_index, granted_at) VALUES (?, 1, ?)",
                (task_id, _iso(_now())),
            )
        return GrantLedger(grants, rounds)

    def ledger(self, task_id: str) -> GrantLedger:
        return self._load_ledger(task_id)

    def record_failure(self, task_id: str, round_id: str, stage: FailureStage, summary: str) -> int:
        """计入失败轮次并落库；返回累计失败数。额度用尽时抛 GrantExhaustedError。"""

        ledger = self._load_ledger(task_id)
        outcome = ledger.record_failure(round_id, stage, summary, _now())
        if outcome.recorded:
            self._db.execute(
                "INSERT INTO failure_rounds (round_id, task_id, stage, summary, occurred_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (round_id, task_id, stage.value, summary, _iso(_now())),
            )
        return outcome.cumulative_failures

    def append_grant(self, task_id: str) -> None:
        ledger = self._load_ledger(task_id)
        ledger.append_grant()
        self._db.execute(
            "INSERT OR REPLACE INTO grants (task_id, grant_index, granted_at) VALUES (?, ?, ?)",
            (task_id, ledger.grant_count, _iso(_now())),
        )

    # ---- 工时 ----

    def budget(self, task_id: str) -> ExecutionBudget:
        row = self._db.execute(
            "SELECT limit_seconds, consumed_seconds FROM budget WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"No budget for task {task_id}")
        return ExecutionBudget(limit_seconds=row[0], consumed_seconds=row[1])

    def charge_budget(self, task_id: str, seconds: float) -> None:
        budget = self.budget(task_id)
        budget.charge(seconds)
        self._save_budget(task_id, budget)

    def extend_budget(self, task_id: str, new_limit_seconds: float) -> None:
        budget = self.budget(task_id)
        budget.extend(new_limit_seconds)
        self._save_budget(task_id, budget)

    def _save_budget(self, task_id: str, budget: ExecutionBudget) -> None:
        self._db.execute(
            "UPDATE budget SET limit_seconds = ?, consumed_seconds = ? WHERE task_id = ?",
            (budget.limit_seconds, budget.consumed_seconds, task_id),
        )

    # ---- 终态产物（停止/交付/归并）委托 OutcomeStore ----

    @property
    def outcomes(self) -> "OutcomeStore":
        """停止、交付与 main 归并等终态记录（同一连接的独立内聚类）。"""

        return OutcomeStore(self._db)


class OutcomeStore:
    """任务终态产物记录：停止、交付与 main 归并（B04）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def request_stop(self, task_id: str, note: str) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO stops (task_id, requested_at, confirmed_at, note)"
            " VALUES (?, ?, NULL, ?)",
            (task_id, _iso(_now()), note),
        )

    def confirm_stop(self, task_id: str, note: str) -> None:
        changed = self._db.execute(
            "UPDATE stops SET confirmed_at = ?, note = ? WHERE task_id = ?",
            (_iso(_now()), note, task_id),
        ).rowcount
        if changed == 0:
            raise KeyError(f"No stop request for task {task_id}")

    def stop_record(self, task_id: str) -> tuple[datetime, datetime | None, str] | None:
        row = self._db.execute(
            "SELECT requested_at, confirmed_at, note FROM stops WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return _parse(row[0]), _parse(row[1]) if row[1] else None, row[2]

    def record_delivery(self, task_id: str, diff_path: str, report_path: str) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO deliveries (task_id, diff_path, report_path, delivered_at)"
            " VALUES (?, ?, ?, ?)",
            (task_id, diff_path, report_path, _iso(_now())),
        )

    def delivery(self, task_id: str) -> tuple[str, str, datetime] | None:
        row = self._db.execute(
            "SELECT diff_path, report_path, delivered_at FROM deliveries WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return row[0], row[1], _parse(row[2])

    def record_merge(self, task_id: str, merge_commit: str, pushed: bool, push_detail: str) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO merges (task_id, merge_commit, pushed, push_detail, merged_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (task_id, merge_commit, 1 if pushed else 0, push_detail, _iso(_now())),
        )

    def merge_record(self, task_id: str) -> tuple[str, bool, str, datetime] | None:
        row = self._db.execute(
            "SELECT merge_commit, pushed, push_detail, merged_at FROM merges WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return row[0], bool(row[1]), row[2], _parse(row[3])

    def record_release(self, record: ReleaseRecord) -> None:
        """固化一次发布（S1）：标签、归并提交、基线与候选 diff 校验值。"""

        self._db.execute(
            "INSERT OR REPLACE INTO releases"
            " (task_id, tag, merge_commit, baseline_commit, diff_sha256, receipt_path,"
            " pushed, push_detail, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                record.task_id,
                record.tag,
                record.merge_commit,
                record.baseline_commit,
                record.diff_sha256,
                record.receipt_path,
                1 if record.pushed else 0,
                record.push_detail,
                _iso(record.released_at),
            ),
        )

    def release_record(self, task_id: str) -> ReleaseRecord | None:
        row = self._db.execute(
            "SELECT task_id, tag, merge_commit, baseline_commit, diff_sha256, receipt_path,"
            " pushed, push_detail, released_at FROM releases WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return _release_from_row(row)

    def release_by_tag(self, tag: str) -> ReleaseRecord | None:
        """按标签取发布回执（部署端据此核对标签指向的归并提交）。"""

        row = self._db.execute(
            "SELECT task_id, tag, merge_commit, baseline_commit, diff_sha256, receipt_path,"
            " pushed, push_detail, released_at FROM releases WHERE tag = ?"
            " ORDER BY released_at DESC LIMIT 1",
            (tag,),
        ).fetchone()
        if row is None:
            return None
        return _release_from_row(row)
