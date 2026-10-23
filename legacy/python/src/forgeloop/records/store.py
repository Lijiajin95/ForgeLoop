"""本地任务与决定记录：进程退出后仍可回查的权威业务记录。

职责（架构 §6 持久化与记录）：任务与配置快照、方案、批准与消费、
失败轮次与授权、工时账目、动作启动/完成身份、停止记录与交付引用。
图检查点由 LangGraph checkpointer 单独保存，本存储只放领域记录。
"""

import json
import re
import sqlite3
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from forgeloop.domain.approval import (
    Approval,
    ApprovalBook,
    ApprovalStage,
    ConsumeResult,
    Plan,
)
from forgeloop.domain.counting import FailureRound, FailureStage, GrantLedger
from forgeloop.domain.delivery import DIGEST_PATTERN, DeliveryBinding, TaskDelivery, build_binding
from forgeloop.domain.dependency_facts import TerminalState
from forgeloop.domain.limits import ExecutionBudget
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.status_reason import TaskFacts
from forgeloop.records.actions import ActionState, ActionStore

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
    -- 审计归属：谁作出的决定、从哪个入口来（页面写 web）。旧库由 _migrate 补列。
    approved_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (task_id, stage, plan_version)
);
CREATE TABLE IF NOT EXISTS approval_consumption (
    task_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    stage TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY (task_id, plan_version, stage)
);
CREATE TABLE IF NOT EXISTS acceptance_bindings (
    task_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    test_evidence_sha256 TEXT NOT NULL,
    review_sha256 TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL DEFAULT '',
    baseline_commit TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (task_id, plan_version)
);
CREATE TABLE IF NOT EXISTS task_commits (
    record_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    relation TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    recorded_by TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    UNIQUE (task_id, commit_sha, relation)
);
CREATE INDEX IF NOT EXISTS task_commits_by_task ON task_commits(task_id);
CREATE TABLE IF NOT EXISTS deploy_approvals (
    tag TEXT PRIMARY KEY,
    artifact_sha256 TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    approved_at TEXT NOT NULL
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
    note TEXT NOT NULL DEFAULT '',
    -- 审计归属：谁请求停止、从哪个入口来。旧库由 _migrate 补列。
    requested_by TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    node TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    detail TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS actions_by_task ON actions (task_id, started_at);
CREATE TABLE IF NOT EXISTS slot_cleanups (
    cleanup_id TEXT PRIMARY KEY,
    slot TEXT NOT NULL,
    occupant_action_id TEXT NOT NULL,
    occupant_owner TEXT NOT NULL,
    occupant_pid INTEGER,
    reason TEXT NOT NULL,
    cleaned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS slot_cleanups_by_slot ON slot_cleanups (slot, cleaned_at);
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
CREATE TABLE IF NOT EXISTS prerequisite_applications (
    task_id TEXT NOT NULL,
    prerequisite_task_id TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (task_id, prerequisite_task_id)
);
"""


# 任务与 commit 的关联关系（所有者 2026-10-18 决定）：任务产出、验收时点、归并结果。
# 一个任务可以关联多个 commit（验收不通过继续改即累加），只追加不覆盖。
TASK_COMMIT_RELATIONS: frozenset[str] = frozenset({"implementation", "acceptance", "merge"})

_COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{7,64}$")


@dataclass(frozen=True)
class TaskCommit:
    """任务与一个 commit 的关联记录（一对多，按时间累积）。"""

    task_id: str
    commit_sha: str
    relation: str
    source: str = ""
    recorded_by: str = ""
    recorded_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True)
class TaskRecord:
    id: str
    project: str
    original_input: str
    config: dict[str, str]
    status: str
    created_at: datetime


# 终态优先级：越靠后的记录越强；任一都视为前置已满足。
_TERMINAL_PRIORITY: dict[TerminalState, int] = {
    TerminalState.ACCEPTED: 1,
    TerminalState.DELIVERED: 2,
    TerminalState.MERGED: 3,
    TerminalState.RELEASED: 4,
}


@dataclass(frozen=True)
class TaskDependencyRecord:
    """单个任务的只读权威事实：存在性、终态、未完成动作与失败轮次。

    ``evidence`` 列出判定所依据的记录身份，``missing`` 列出缺少的记录身份；
    状态词只作为事实返回，不参与终态判定（状态滞后不是依据）。
    """

    task_id: str
    exists: bool
    status: str
    terminal: TerminalState | None
    outstanding_action: str | None
    failure_rounds: int
    evidence: tuple[str, ...]
    missing: tuple[str, ...]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _task_from_row(row: Sequence[object]) -> TaskRecord:
    """任务行 → 领域对象（单条查询与全量清单共用，避免两处映射漂移）。"""

    return TaskRecord(
        id=str(row[0]),
        project=str(row[1]),
        original_input=str(row[2]),
        config=json.loads(str(row[3])),
        status=str(row[4]),
        created_at=_parse(str(row[5])),
    )


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


def _binding_from_row(row: Sequence[object]) -> DeliveryBinding:
    """验收绑定行 → 领域对象；材料字段顺序与 SCHEMA 一致。"""

    return DeliveryBinding(
        task_id=str(row[0]),
        plan_version=int(str(row[1])),
        candidate_sha256=str(row[2]),
        test_evidence_sha256=str(row[3]),
        review_sha256=str(row[4]),
        artifact_sha256=str(row[5]),
        baseline_commit=str(row[6]),
    )


def _approval_from_row(
    row: Sequence[object], bindings: dict[tuple[str, int], DeliveryBinding]
) -> Approval:
    """批准行 → 领域对象；交付绑定只附加到验收批准，方案批准保持为空。"""

    stage = ApprovalStage(row[2])
    task_id = str(row[0])
    plan_version = int(str(row[1]))
    binding = bindings.get((task_id, plan_version)) if stage is ApprovalStage.ACCEPTANCE else None
    return Approval(
        task_id,
        plan_version,
        stage,
        _parse(str(row[3])),
        binding,
        str(row[4]) if len(row) > 4 else "",
        str(row[5]) if len(row) > 5 else "",
    )


def _read_text(path: Path) -> str:
    """读取交付材料；缺失按空内容处理，仍给出稳定的内容寻址校验值。"""

    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _read_artifact_sha256(path: Path) -> str:
    """从候选产物回执读取 sha256；缺失或格式不对时按未绑定产物处理。"""

    if not path.is_file():
        return ""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(document, dict):
        return ""
    payload = cast("dict[str, object]", document)
    digest = payload.get("sha256")
    if isinstance(digest, str) and DIGEST_PATTERN.match(digest):
        return digest
    return ""


def _read_baseline_commit(path: Path) -> str:
    """从最近的开发记录读取实际交付基线提交号；缺失、损坏或类型不对按未绑定处理。

    基线以开发副本 git HEAD 为唯一来源（与交付报告同源），不从任务配置猜测。
    """

    if not path.is_file():
        return ""
    try:
        document = json.loads(path.read_text(encoding="utf-8").splitlines()[-1])
    except (OSError, ValueError, IndexError):
        return ""
    if not isinstance(document, dict):
        return ""
    payload = cast("dict[str, object]", document)
    baseline = payload.get("baseline_commit")
    return baseline if isinstance(baseline, str) else ""


def _table_present(db: sqlite3.Connection, name: str) -> bool:
    """只读判断记录表是否存在；缺失表等价于记录缺失，不创建表。"""

    return (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone()
        is not None
    )


def _read_terminal_state(
    db: sqlite3.Connection, task_id: str, evidence: list[str]
) -> TerminalState | None:
    """从终态记录读取任务达成的最强终态；只看已消费验收、交付、归并与发布。"""

    candidates: list[tuple[TerminalState, str]] = []
    if _table_present(db, "approval_consumption"):
        row = db.execute(
            "SELECT plan_version FROM approval_consumption"
            " WHERE task_id = ? AND stage = ? ORDER BY consumed_at DESC LIMIT 1",
            (task_id, ApprovalStage.ACCEPTANCE.value),
        ).fetchone()
        if row is not None:
            candidates.append(
                (
                    TerminalState.ACCEPTED,
                    f"approval_consumption:{task_id}:v{int(row[0])}:acceptance",
                )
            )
    if (
        _table_present(db, "deliveries")
        and db.execute("SELECT 1 FROM deliveries WHERE task_id = ?", (task_id,)).fetchone()
    ):
        candidates.append((TerminalState.DELIVERED, f"deliveries:{task_id}"))
    if (
        _table_present(db, "merges")
        and db.execute("SELECT 1 FROM merges WHERE task_id = ?", (task_id,)).fetchone()
    ):
        candidates.append((TerminalState.MERGED, f"merges:{task_id}"))
    if (
        _table_present(db, "releases")
        and db.execute("SELECT 1 FROM releases WHERE task_id = ?", (task_id,)).fetchone()
    ):
        candidates.append((TerminalState.RELEASED, f"releases:{task_id}"))
    if not candidates:
        return None
    terminal, record_id = max(candidates, key=lambda item: _TERMINAL_PRIORITY[item[0]])
    evidence.append(record_id)
    return terminal


def _read_outstanding_action(
    db: sqlite3.Connection, task_id: str, evidence: list[str]
) -> str | None:
    """返回该任务最早的 ``started`` 未完成动作身份；没有则返回 ``None``。"""

    if not _table_present(db, "actions"):
        return None
    row = db.execute(
        "SELECT action_id FROM actions WHERE task_id = ? AND state = ? ORDER BY started_at LIMIT 1",
        (task_id, ActionState.STARTED.value),
    ).fetchone()
    if row is None:
        return None
    action_id = str(row[0])
    evidence.append(f"actions:{action_id}")
    return action_id


def _read_failure_rounds(db: sqlite3.Connection, task_id: str, evidence: list[str]) -> int:
    """累计失败轮次数；如实读取，不据此判定阻塞。"""

    if not _table_present(db, "failure_rounds"):
        return 0
    row = db.execute("SELECT COUNT(*) FROM failure_rounds WHERE task_id = ?", (task_id,)).fetchone()
    count = int(row[0]) if row is not None else 0
    if count:
        evidence.append(f"failure_rounds:{task_id}")
    return count


def _read_plan_and_approval_evidence(
    db: sqlite3.Connection, task_id: str, evidence: list[str]
) -> None:
    """补充方案与批准记录身份（判定依据上下文，不单独决定终态）。"""

    if _table_present(db, "plans"):
        row = db.execute(
            "SELECT version FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        if row is not None:
            evidence.append(f"plans:{task_id}:v{int(row[0])}")
    if _table_present(db, "approvals"):
        row = db.execute(
            "SELECT plan_version, stage FROM approvals WHERE task_id = ?"
            " ORDER BY decided_at DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        if row is not None:
            evidence.append(f"approvals:{task_id}:v{int(row[0])}:{row[1]}")


def read_task_dependency_record(db: sqlite3.Connection, task_id: str) -> TaskDependencyRecord:
    """只读汇总一个任务的依赖事实来源；缺失任务按缺少记录如实返回。

    这是 records 层对权威记录（``tasks``/``plans``/``approvals``/
    ``approval_consumption``/``actions``/``failure_rounds`` 及交付终态）的
    只读取数，不写入、不创建表；判定规则在 ``domain.dependency_facts``。
    """

    evidence: list[str] = []
    missing: list[str] = []
    row = (
        db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if _table_present(db, "tasks")
        else None
    )
    exists = row is not None
    status = str(row[0]) if row is not None else ""
    if exists:
        evidence.append(f"tasks:{task_id}")
    else:
        missing.append(f"tasks:{task_id}")

    terminal = _read_terminal_state(db, task_id, evidence)
    outstanding = _read_outstanding_action(db, task_id, evidence)
    failure_rounds = _read_failure_rounds(db, task_id, evidence)
    _read_plan_and_approval_evidence(db, task_id, evidence)
    return TaskDependencyRecord(
        task_id=task_id,
        exists=exists,
        status=status,
        terminal=terminal,
        outstanding_action=outstanding,
        failure_rounds=failure_rounds,
        evidence=tuple(evidence),
        missing=tuple(missing),
    )


class RecordStore:
    """SQLite 权威记录存储；CLI 查询由本存储生成。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._root: Path = db_path.parent
        self._db = sqlite3.connect(db_path, isolation_level=None)
        # 两个连接争用同一记录库时等待写锁而不是立刻报 database is locked。
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """为旧库补上槽位残留判定所需的动作列；对新建库是空操作。

        ``CREATE TABLE IF NOT EXISTS`` 不会给已存在的 ``actions`` 表加列，因此旧库
        升级时必须显式 ``ALTER TABLE``，否则读动作记录会因缺列失败。
        """

        columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(actions)")}
        if "pid" not in columns:
            self._db.execute("ALTER TABLE actions ADD COLUMN pid INTEGER")
        if "heartbeat_at" not in columns:
            self._db.execute("ALTER TABLE actions ADD COLUMN heartbeat_at TEXT")
        # 审计归属（2026-10-18）：谁作出决定 / 谁请求停止、从哪个入口来。旧库升级即补列，
        # 未补时读批准与停止记录会缺列失败，因此这里与建表语句保持同形。
        approval_columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(approvals)")}
        if "approved_by" not in approval_columns:
            self._db.execute(
                "ALTER TABLE approvals ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''"
            )
        if "source" not in approval_columns:
            self._db.execute("ALTER TABLE approvals ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        stop_columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(stops)")}
        if "requested_by" not in stop_columns:
            self._db.execute("ALTER TABLE stops ADD COLUMN requested_by TEXT NOT NULL DEFAULT ''")
        if "source" not in stop_columns:
            self._db.execute("ALTER TABLE stops ADD COLUMN source TEXT NOT NULL DEFAULT ''")

    @property
    def root(self) -> Path:
        """记录根目录；交付现场材料（候选/审查/测试）位于其下 ``<task_id>/``。"""

        return self._root

    def close(self) -> None:
        self._db.close()

    @contextmanager
    def _write_transaction(self) -> Generator[None]:
        """显式写事务：读-改-写要么整体提交，要么整体回滚，不留半条记录。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    # ---- 任务 ----

    def create_task(
        self,
        task_id: str,
        project: str,
        original_input: str,
        config: dict[str, str],
        limit_seconds: float,
    ) -> TaskRecord:
        if limit_seconds <= 0:
            raise ValueError("Execution limit must be positive")
        record = TaskRecord(task_id, project, original_input, config, "created", _now())
        with self._write_transaction():
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
        return _task_from_row(row)

    def all_tasks(self) -> tuple[TaskRecord, ...]:
        """列出全部项目的任务（只读），供状态页跨项目汇总。

        顺序为创建时间与身份，保证同一份记录每次读取顺序一致；空库返回空元组。
        """

        rows = self._db.execute(
            "SELECT id, project, original_input, config_json, status, created_at"
            " FROM tasks ORDER BY created_at, id"
        ).fetchall()
        return tuple(_task_from_row(row) for row in rows)

    def set_task_status(self, task_id: str, status: str) -> None:
        changed = self._db.execute(
            "UPDATE tasks SET status = ? WHERE id = ?", (status, task_id)
        ).rowcount
        if changed == 0:
            raise KeyError(f"Unknown task {task_id}")

    # ---- 只读依赖事实取数 ----

    def task_dependency_record(self, task_id: str) -> TaskDependencyRecord:
        """只读汇总单个任务的终态、未完成动作与失败轮次事实。"""

        return read_task_dependency_record(self._db, task_id)

    def status_reason_facts(
        self, task_id: str, *, unmet_prerequisites: Sequence[str] = ()
    ) -> TaskFacts:
        """只读汇总推导 ``blocked_reason_text`` 所需的权威事实。

        与 :meth:`task_dependency_record` 一样只读取数、不写记录也不隐式创建
        ``grants`` 行；缺少 ``tasks`` 行时按缺少记录返回，交给
        ``domain.status_reason`` 输出 unknown，而不是猜测为已满足或未满足。
        """

        dependency = read_task_dependency_record(self._db, task_id)
        budget = self._read_budget_facts(task_id)
        return TaskFacts(
            task_id=task_id,
            status=dependency.status,
            plan_version=self._latest_plan_version(task_id),
            plan_approval_version=self._latest_approval_version(task_id, ApprovalStage.PLAN),
            acceptance_approval_version=self._latest_approval_version(
                task_id, ApprovalStage.ACCEPTANCE
            ),
            outstanding_action=dependency.outstanding_action,
            failure_rounds=dependency.failure_rounds,
            grant_count=self._grant_count_readonly(task_id),
            budget_limit_seconds=budget[0] if budget is not None else None,
            budget_consumed_seconds=budget[1] if budget is not None else None,
            terminal=dependency.terminal,
            unmet_prerequisites=tuple(unmet_prerequisites),
            missing=dependency.missing,
            evidence=dependency.evidence,
        )

    def _latest_plan_version(self, task_id: str) -> int | None:
        """最高方案版本；没有方案记录时返回 ``None``，不臆造为 1。"""

        row = self._db.execute(
            "SELECT MAX(version) FROM plans WHERE task_id = ?", (task_id,)
        ).fetchone()
        return int(row[0]) if row is not None and row[0] is not None else None

    def _latest_approval_version(self, task_id: str, stage: ApprovalStage) -> int | None:
        """某阶段最近一次批准绑定的方案版本；未记录时返回 ``None``。"""

        row = self._db.execute(
            "SELECT plan_version FROM approvals WHERE task_id = ? AND stage = ?"
            " ORDER BY decided_at DESC, plan_version DESC LIMIT 1",
            (task_id, stage.value),
        ).fetchone()
        return int(row[0]) if row is not None else None

    def _grant_count_readonly(self, task_id: str) -> int:
        """只读授权次数；无 grants 行时按一次初始授权计，且不写入记录。"""

        row = self._db.execute(
            "SELECT COUNT(*) FROM grants WHERE task_id = ?", (task_id,)
        ).fetchone()
        count = int(row[0]) if row is not None else 0
        return count if count > 0 else 1

    def _read_budget_facts(self, task_id: str) -> tuple[float, float] | None:
        """只读工时读数 ``(limit_seconds, consumed_seconds)``；无行返回 ``None``。"""

        row = self._db.execute(
            "SELECT limit_seconds, consumed_seconds FROM budget WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return float(row[0]), float(row[1])

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
            "SELECT task_id, plan_version, stage, decided_at, approved_by, source"
            " FROM approvals WHERE task_id = ?"
            " ORDER BY plan_version",
            (task_id,),
        ).fetchall()
        bindings = self._acceptance_bindings(task_id)
        approvals = tuple(_approval_from_row(row, bindings) for row in rows)
        book = ApprovalBook(approvals)
        for row in self._db.execute(
            "SELECT task_id, plan_version, stage FROM approval_consumption WHERE task_id = ?",
            (task_id,),
        ).fetchall():
            book.mark_consumed(row[0], row[1], ApprovalStage(row[2]))
        return book

    def _acceptance_bindings(self, task_id: str) -> dict[tuple[str, int], DeliveryBinding]:
        rows = self._db.execute(
            "SELECT task_id, plan_version, candidate_sha256, test_evidence_sha256,"
            " review_sha256, artifact_sha256, baseline_commit FROM acceptance_bindings"
            " WHERE task_id = ?",
            (task_id,),
        ).fetchall()
        return {(str(row[0]), int(row[1])): _binding_from_row(row) for row in rows}

    def capture_delivery_binding(self, task_id: str, plan_version: int) -> DeliveryBinding:
        """读取当前交付材料并构造不可变绑定；材料缺失时按空内容固化。"""

        task_dir = self._root / task_id
        return build_binding(
            task_id,
            plan_version,
            candidate_text=_read_text(task_dir / "candidate.diff"),
            test_evidence_text=_read_text(task_dir / "test-run.jsonl"),
            review_text=_read_text(task_dir / "review-report.json"),
            artifact_sha256=_read_artifact_sha256(task_dir / "candidate-artifact.json"),
            baseline_commit=_read_baseline_commit(task_dir / "dev-reports.jsonl"),
        )

    def acceptance_binding(self, task_id: str) -> DeliveryBinding | None:
        """该任务生效的验收材料绑定（最高方案版本）；未验收时返回 ``None``。"""

        row = self._db.execute(
            "SELECT task_id, plan_version, candidate_sha256, test_evidence_sha256,"
            " review_sha256, artifact_sha256, baseline_commit FROM acceptance_bindings"
            " WHERE task_id = ? ORDER BY plan_version DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        return _binding_from_row(row) if row is not None else None

    def task_delivery(self, task_id: str) -> TaskDelivery | None:
        """汇总单个任务的业务验证：绑定材料 + 验收批准是否已消费。

        未记录验收批准时返回 ``None``；已记录但尚未消费时 ``accepted`` 为假，
        需求整体验收据此拒绝，而不是把“已有候选”当成已经验收。
        """

        binding = self.acceptance_binding(task_id)
        if binding is None:
            return None
        consumed = self._db.execute(
            "SELECT 1 FROM approval_consumption WHERE task_id = ? AND plan_version = ?"
            " AND stage = ?",
            (task_id, binding.plan_version, ApprovalStage.ACCEPTANCE.value),
        ).fetchone()
        return TaskDelivery(binding, accepted=consumed is not None)

    def _persist_acceptance_binding(self, binding: DeliveryBinding) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO acceptance_bindings"
            " (task_id, plan_version, candidate_sha256, test_evidence_sha256, review_sha256,"
            " artifact_sha256, baseline_commit, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                binding.task_id,
                binding.plan_version,
                binding.candidate_sha256,
                binding.test_evidence_sha256,
                binding.review_sha256,
                binding.artifact_sha256,
                binding.baseline_commit,
                _iso(_now()),
            ),
        )

    def record_deploy_approval(
        self,
        tag: str,
        artifact_sha256: str,
        *,
        by: str = "",
        source: str = "",
        reason: str = "",
        at: datetime | None = None,
    ) -> tuple[str, str]:
        """记录一次人工部署批准（发布前需确认，所有者 2026-10-18 决定）。

        绑定**版本标签与产物校验值**：批准只对这两者同时一致的那次部署生效。校验
        fail-closed——调用方标识与理由不能为空、产物校验值须为 64 位十六进制，否则
        ``ValueError`` 且不写记录（"谁批的、为什么"缺失时不得留下批准）。
        """

        if not by.strip():
            raise ValueError("部署批准必须给出调用方标识 --by")
        if not reason.strip():
            raise ValueError("部署批准必须给出理由 --reason")
        if not DIGEST_PATTERN.match(artifact_sha256):
            raise ValueError("产物校验值须为 64 位十六进制小写")
        stamp = at or datetime.now(UTC)
        with self._write_transaction():
            self._db.execute(
                "INSERT OR REPLACE INTO deploy_approvals"
                " (tag, artifact_sha256, approved_by, source, reason, approved_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (tag, artifact_sha256, by.strip(), source, reason, _iso(stamp)),
            )
        return (tag, artifact_sha256)

    def latest_release(self) -> tuple[str, str] | None:
        """最近一次发布 ``(tag, artifact_sha256)``；无记录或回执读不到时返回 ``None``。

        发布事实由 ``OutcomeStore`` 读写（同一张 ``releases`` 表），这里只做**只读**
        汇总：产物校验值以**发布回执**为准（与部署端核对的是同一份事实），回执里的相对
        路径按记录根下的任务目录解析；读不到就返回 ``None``，不猜校验值。
        """

        row = self._db.execute(
            "SELECT tag, receipt_path FROM releases ORDER BY released_at DESC, rowid DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        tag, receipt_path = str(row[0]), Path(str(row[1]))
        candidates: list[Path] = [receipt_path]
        if not receipt_path.is_absolute():
            candidates = sorted(self._root.glob(f"*/{receipt_path.name}")) + candidates
        for path in candidates:
            if not path.is_file():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            digest = str(payload.get("artifact_sha256", ""))
            if DIGEST_PATTERN.match(digest):
                return (tag, digest)
        return None

    def deploy_approval(self, tag: str) -> tuple[str, str] | None:
        """回查某标签的部署批准；没有批准时返回 ``None``（调用方据此 fail-closed）。"""

        row = self._db.execute(
            "SELECT tag, artifact_sha256 FROM deploy_approvals WHERE tag = ?", (tag,)
        ).fetchone()
        if row is None:
            return None
        return (str(row[0]), str(row[1]))

    def record_task_commit(
        self,
        task_id: str,
        commit_sha: str,
        relation: str,
        *,
        source: str = "",
        by: str = "",
        at: datetime | None = None,
    ) -> TaskCommit:
        """记录任务与 commit 的关联；同任务+同提交+同关系重复调用只保留一条。

        校验 fail-closed：关系必须是 :data:`TASK_COMMIT_RELATIONS` 之一，提交号必须是
        7-64 位十六进制（小写化后比对），否则抛 ``ValueError``，不写任何记录。
        """

        normalized = commit_sha.strip().lower()
        if relation not in TASK_COMMIT_RELATIONS:
            allowed = "、".join(sorted(TASK_COMMIT_RELATIONS))
            raise ValueError(f"未知的任务-提交关联关系: {relation!r}（允许 {allowed}）")
        if not _COMMIT_SHA_PATTERN.match(normalized):
            raise ValueError(f"提交号必须是 7-64 位十六进制: {commit_sha!r}")
        stamp = at or datetime.now(UTC)
        with self._write_transaction():
            self._db.execute(
                "INSERT OR IGNORE INTO task_commits"
                " (task_id, commit_sha, relation, source, recorded_by, recorded_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, normalized, relation, source, by, _iso(stamp)),
            )
        return TaskCommit(
            task_id=task_id,
            commit_sha=normalized,
            relation=relation,
            source=source,
            recorded_by=by,
            recorded_at=stamp,
        )

    def task_commits(self, task_id: str) -> tuple[TaskCommit, ...]:
        """按时间与写入顺序回查一个任务关联的全部 commit（含实现/验收/归并三类）。"""

        rows = self._db.execute(
            "SELECT task_id, commit_sha, relation, source, recorded_by, recorded_at"
            " FROM task_commits WHERE task_id = ? ORDER BY recorded_at, record_id",
            (task_id,),
        ).fetchall()
        return tuple(
            TaskCommit(
                task_id=str(row[0]),
                commit_sha=str(row[1]),
                relation=str(row[2]),
                source=str(row[3]),
                recorded_by=str(row[4]),
                recorded_at=datetime.fromisoformat(str(row[5])),
            )
            for row in rows
        )

    def record_approval(self, approval: Approval) -> None:
        # 验收批准自动绑定当前材料：CLI 记录决定时材料即已确定，替换后决定失效。
        binding = approval.binding
        if binding is None and approval.stage is ApprovalStage.ACCEPTANCE:
            binding = self.capture_delivery_binding(approval.task_id, approval.plan_version)
        with self._write_transaction():
            self._db.execute(
                "INSERT OR REPLACE INTO approvals"
                " (task_id, plan_version, stage, decided_at, approved_by, source)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    approval.task_id,
                    approval.plan_version,
                    approval.stage.value,
                    _iso(approval.decided_at),
                    approval.approved_by,
                    approval.source,
                ),
            )
            if binding is not None:
                self._persist_acceptance_binding(binding)

    def effective_approval(self, task_id: str, stage: ApprovalStage) -> Approval | None:
        return self._load_approval_book(task_id).effective(task_id, stage)

    def consume_approval(
        self,
        task_id: str,
        plan_version: int,
        stage: ApprovalStage,
        current_binding: DeliveryBinding | None = None,
    ) -> ConsumeResult:
        # 验收批准在消费时核对当前材料；材料文件读取在写事务之外完成。
        if current_binding is None and stage is ApprovalStage.ACCEPTANCE:
            current_binding = self.capture_delivery_binding(task_id, plan_version)
        # 读-改-写放进一个写事务：两个并发调用只有一个能看到"未消费"并落库。
        with self._write_transaction():
            book = self._load_approval_book(task_id)
            result = book.consume(task_id, plan_version, stage, current_binding)
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

    def find_budget(self, task_id: str) -> ExecutionBudget | None:
        """只读读取任务的工时账目；没有该行时返回 ``None``，不写入、不抛异常。

        查询输出需要区分「尚未分配工时（无 budget 行）」与「有 budget 行」，
        :meth:`budget` 的 ``KeyError`` 无法表达前者；本方法只读不写，供查询与
        排障派生摘要使用。
        """

        row = self._db.execute(
            "SELECT limit_seconds, consumed_seconds FROM budget WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            return None
        return ExecutionBudget(limit_seconds=row[0], consumed_seconds=row[1])

    def charge_budget(self, task_id: str, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("Charged duration cannot be negative")
        # 单条累加语句在 SQLite 内原子执行：并发计入不丢更新，累计如实保存。
        changed = self._db.execute(
            "UPDATE budget SET consumed_seconds = consumed_seconds + ? WHERE task_id = ?",
            (seconds, task_id),
        ).rowcount
        if changed == 0:
            raise KeyError(f"No budget for task {task_id}")

    def extend_budget(self, task_id: str, new_limit_seconds: float) -> None:
        with self._write_transaction():
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

    @property
    def actions(self) -> ActionStore:
        """动作启动/完成身份与单任务并发占用（同一连接的独立内聚类）。"""

        return ActionStore(self._db)


class OutcomeStore:
    """任务终态产物记录：停止、交付与 main 归并（B04）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def request_stop(
        self, task_id: str, note: str, *, requested_by: str = "", source: str = ""
    ) -> None:
        """记录停止请求：理由进 ``note``，操作人与入口进独立列（不混装进 note）。"""

        self._db.execute(
            "INSERT OR REPLACE INTO stops"
            " (task_id, requested_at, confirmed_at, note, requested_by, source)"
            " VALUES (?, ?, NULL, ?, ?, ?)",
            (task_id, _iso(_now()), note, requested_by, source),
        )

    def confirm_stop(self, task_id: str, note: str) -> None:
        changed = self._db.execute(
            "UPDATE stops SET confirmed_at = ?, note = ? WHERE task_id = ?",
            (_iso(_now()), note, task_id),
        ).rowcount
        if changed == 0:
            raise KeyError(f"No stop request for task {task_id}")

    def stop_attribution(self, task_id: str) -> tuple[str, str]:
        """停止请求的操作人与入口；没有记录时返回两个空串。"""

        row = self._db.execute(
            "SELECT requested_by, source FROM stops WHERE task_id = ?", (task_id,)
        ).fetchone()
        return ("", "") if row is None else (str(row[0]), str(row[1]))

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

    # ---- 前置候选应用记录（A04 幂等与回退的权威依据） ----

    def record_prerequisite_applications(
        self, task_id: str, applications: Sequence[tuple[str, str, str, str]]
    ) -> None:
        """逐条固化下游任务的前置候选应用结果：前置身份、校验值、状态与原因。

        同一前置身份覆盖为最新结果。回退后必须把先前的 ``applied`` 覆盖为
        ``failed``：否则下次启动会据陈旧记录跳过实际已回退的改动。
        """

        recorded_at = _iso(_now())
        for prerequisite_task_id, candidate_sha256, status, detail in applications:
            self._db.execute(
                "INSERT OR REPLACE INTO prerequisite_applications"
                " (task_id, prerequisite_task_id, candidate_sha256, status, detail, recorded_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, prerequisite_task_id, candidate_sha256, status, detail, recorded_at),
            )

    def prerequisite_applications(self, task_id: str) -> dict[str, tuple[str, str, str]]:
        """读取下游任务各前置候选的最新应用记录：``task_id -> (sha, 状态, 原因)``。

        只读、不创建表；无记录时返回空字典，调用方据此按「未应用」处理而不是猜测。
        """

        if not _table_present(self._db, "prerequisite_applications"):
            return {}
        rows = self._db.execute(
            "SELECT prerequisite_task_id, candidate_sha256, status, detail"
            " FROM prerequisite_applications WHERE task_id = ?",
            (task_id,),
        ).fetchall()
        return {str(row[0]): (str(row[1]), str(row[2]), str(row[3])) for row in rows}
