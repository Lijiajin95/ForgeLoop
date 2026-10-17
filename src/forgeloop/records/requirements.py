"""需求受理的持久化：分配身份、保存原文与追加版本、按身份与项目回查。

记录层只做持久化与重放，规则来自 ``domain.requirement``：
- 首次提交分配全局唯一身份，原文是版本 1；追加只新增行，不覆盖历史。
- 未知身份按身份回查必须明确失败。
- 项目是查询边界，不同项目的需求不混用。
- 结构化分析按版本保存；需求状态与阻塞原因可回查（A02）。
- 任务包按版本与批准绑定保存；批准绑定需求身份与任务包版本，任务级授权来源只由真实批准写入；未批准或旧版本批准不能驱动执行（A03）。

本模块管理自己的 SQLite 连接与表；与 ``records.store`` 使用同一数据库文件时
各表独立，不修改既有任务记录实现。
"""

import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from forgeloop.domain.dependency_facts import (
    DependencyFacts,
    PrerequisiteFact,
    assess_dependency,
)
from forgeloop.domain.limits import ExecutionBudget
from forgeloop.domain.requirement import (
    DRAFT,
    Requirement,
    RequirementAnalysis,
    RequirementError,
    RequirementNotFoundError,
    RequirementVersion,
    allocate_requirement_id,
    status_for_analysis,
)
from forgeloop.domain.task_plan import (
    APPROVED,
    PLAN_PROPOSED,
    PlanAuthorization,
    PlanAuthorizationStatus,
    TaskPlan,
    TaskPlanApproval,
    TaskPlanError,
    TaskPlanNotAuthorizedError,
    TaskPlanNotFoundError,
    authorize_plan,
    bind_authorization,
    task_plan_from_payload,
    task_plan_to_payload,
)
from forgeloop.records.store import TaskDependencyRecord, read_task_dependency_record

SCHEMA = """
CREATE TABLE IF NOT EXISTS requirements (
    req_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    blocked_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS requirement_versions (
    req_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, version)
);
CREATE TABLE IF NOT EXISTS requirement_analyses (
    req_id TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    requirement_version INTEGER NOT NULL,
    goal TEXT NOT NULL,
    scenarios TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    clarifications TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, analysis_version)
);
CREATE TABLE IF NOT EXISTS requirement_task_plans (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_plan_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS requirement_plan_approvals (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    approved_by TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    approved_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version)
);
CREATE TABLE IF NOT EXISTS requirement_task_runs (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    executed_seconds REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, task_id)
);
CREATE TABLE IF NOT EXISTS requirement_task_artifacts (
    req_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    candidate_sha256 TEXT NOT NULL DEFAULT '',
    test_evidence_sha256 TEXT NOT NULL DEFAULT '',
    review_sha256 TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    authorization_source TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (req_id, plan_version, task_id)
);
CREATE TABLE IF NOT EXISTS requirement_budget (
    req_id TEXT PRIMARY KEY,
    limit_seconds REAL NOT NULL,
    consumed_seconds REAL NOT NULL
);
"""

_ANALYSIS_COLUMNS = (
    "analysis_version",
    "requirement_version",
    "goal",
    "scenarios",
    "acceptance_criteria",
    "clarifications",
    "created_at",
)


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _parse_string_list(raw: str) -> tuple[str, ...]:
    """读取一条分析记录里的字符串数组；记录损坏时明确失败，不静默给空值。"""

    data: object = json.loads(raw)
    if not isinstance(data, list):
        raise RequirementError("分析记录损坏：期望字符串数组")
    raw_items = cast("list[object]", data)
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str):
            raise RequirementError("分析记录损坏：期望字符串数组")
        items.append(item)
    return tuple(items)


def _row_to_analysis(row: tuple[Any, ...]) -> RequirementAnalysis:
    return RequirementAnalysis(
        analysis_version=int(row[0]),
        requirement_version=int(row[1]),
        goal=str(row[2]),
        scenarios=_parse_string_list(str(row[3])),
        acceptance_criteria=_parse_string_list(str(row[4])),
        clarifications=_parse_string_list(str(row[5])),
        created_at=_parse(str(row[6])),
    )


@dataclass(frozen=True)
class TaskArtifact:
    """A04 前置任务的已确认产物身份：候选 diff、正式测试、审查与验收结论。

    记录层只保存身份字符串，内容本体留在任务现场，由下游按身份读取。
    """

    task_id: str
    candidate_sha256: str
    test_evidence_sha256: str
    review_sha256: str
    acceptance: str
    authorization_source: str = ""

    def __post_init__(self) -> None:
        if not self.task_id.strip():
            raise RequirementError("前置产物必须绑定任务身份")
        if not self.acceptance.strip():
            raise RequirementError("前置产物必须给出验收结论")


@dataclass(frozen=True)
class RequirementTaskRun:
    """A04 任务推进记录：最近结果、原因与累计实际执行工时。"""

    req_id: str
    plan_version: int
    task_id: str
    state: str
    reason: str
    executed_seconds: float
    updated_at: datetime


def _row_to_task_run(row: tuple[Any, ...]) -> RequirementTaskRun:
    return RequirementTaskRun(
        req_id=str(row[0]),
        plan_version=int(row[1]),
        task_id=str(row[2]),
        state=str(row[3]),
        reason=str(row[4]),
        executed_seconds=float(row[5]),
        updated_at=_parse(str(row[6])),
    )


def _row_to_task_artifact(row: tuple[Any, ...]) -> TaskArtifact:
    return TaskArtifact(
        task_id=str(row[0]),
        candidate_sha256=str(row[1]),
        test_evidence_sha256=str(row[2]),
        review_sha256=str(row[3]),
        acceptance=str(row[4]),
        authorization_source=str(row[5]),
    )


class RequirementStore:
    """需求身份与修订版本的 SQLite 权威记录。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        self._db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """为 A01 旧库补上状态列；对新建库是空操作，不重建表。"""

        columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(requirements)")}
        if "status" not in columns:
            self._db.execute(
                "ALTER TABLE requirements ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'"
            )
        if "blocked_reason" not in columns:
            self._db.execute(
                "ALTER TABLE requirements ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT ''"
            )

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
        """为已有身份追加一个修订版本；未知身份明确失败。

        新增材料会让既有分析过期：状态回到 ``draft``，等待重新分析。
        """

        updated = self.get(req_id).append(text, _now())
        self._insert_version(req_id, updated.latest)
        self._set_status(req_id, DRAFT)
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

    def all_requirements(self) -> tuple[Requirement, ...]:
        """列出全部项目的需求（只读），供状态页跨项目汇总。

        顺序为创建时间与身份，保证同一份记录每次读取顺序一致；空库返回空元组。
        """

        rows = self._db.execute(
            "SELECT req_id FROM requirements ORDER BY created_at, req_id"
        ).fetchall()
        return tuple(self.get(str(row[0])) for row in rows)

    def _insert_version(self, req_id: str, version: RequirementVersion) -> None:
        self._db.execute(
            "INSERT INTO requirement_versions (req_id, version, text, created_at)"
            " VALUES (?, ?, ?, ?)",
            (req_id, version.version, version.text, _iso(version.created_at)),
        )

    # ---- A02 只读分析记录 ----

    def record_analysis(self, req_id: str, analysis: RequirementAnalysis) -> RequirementAnalysis:
        """保存一次结构化分析并更新需求状态；分析版本只追加，不覆盖。"""

        requirement = self.get(req_id)
        if analysis.requirement_version > requirement.version_count:
            raise RequirementError("分析绑定的需求版本不存在")
        self._db.execute(
            "INSERT INTO requirement_analyses ("
            "req_id, analysis_version, requirement_version, goal, scenarios,"
            " acceptance_criteria, clarifications, created_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                req_id,
                analysis.analysis_version,
                analysis.requirement_version,
                analysis.goal,
                json.dumps(list(analysis.scenarios), ensure_ascii=False),
                json.dumps(list(analysis.acceptance_criteria), ensure_ascii=False),
                json.dumps(list(analysis.clarifications), ensure_ascii=False),
                _iso(analysis.created_at),
            ),
        )
        status = status_for_analysis(analysis)
        self._set_status(req_id, status)
        return analysis

    def analyses(self, req_id: str) -> tuple[RequirementAnalysis, ...]:
        """按分析版本升序返回全部分析；未知身份明确失败。"""

        self._require(req_id)
        rows = self._db.execute(
            "SELECT "
            + ", ".join(_ANALYSIS_COLUMNS)
            + " FROM requirement_analyses WHERE req_id = ? ORDER BY analysis_version",
            (req_id,),
        ).fetchall()
        return tuple(_row_to_analysis(row) for row in rows)

    def latest_analysis(self, req_id: str) -> RequirementAnalysis | None:
        """返回最新一次分析；从未分析过时为 None。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT " + ", ".join(_ANALYSIS_COLUMNS) + " FROM requirement_analyses WHERE req_id = ?"
            " ORDER BY analysis_version DESC LIMIT 1",
            (req_id,),
        ).fetchone()
        return None if row is None else _row_to_analysis(row)

    def next_analysis_version(self, req_id: str) -> int:
        """下一个分析版本号：从 1 起，历史版本不覆盖。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT COALESCE(MAX(analysis_version), 0) FROM requirement_analyses WHERE req_id = ?",
            (req_id,),
        ).fetchone()
        assert row is not None
        return int(row[0]) + 1

    def requirement_status(self, req_id: str) -> str:
        """需求当前状态；未知身份明确失败。"""

        row = self._db.execute(
            "SELECT status FROM requirements WHERE req_id = ?", (req_id,)
        ).fetchone()
        if row is None:
            raise RequirementNotFoundError(f"未知需求身份: {req_id}")
        return str(row[0])

    def blocked_reason(self, req_id: str) -> str:
        """最近一次阻塞原因；未阻塞时为空串。未知身份明确失败。"""

        row = self._db.execute(
            "SELECT blocked_reason FROM requirements WHERE req_id = ?", (req_id,)
        ).fetchone()
        if row is None:
            raise RequirementNotFoundError(f"未知需求身份: {req_id}")
        return str(row[0])

    def set_requirement_status(self, req_id: str, status: str, reason: str = "") -> None:
        """显式落库需求状态与阻塞原因；未知身份明确失败。"""

        self._set_status(req_id, status, reason)

    # ---- A03 任务包与批准绑定 ----

    def next_plan_version(self, req_id: str) -> int:
        """下一个任务包版本号：从 1 起，历史版本不覆盖。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT COALESCE(MAX(plan_version), 0) FROM requirement_task_plans WHERE req_id = ?",
            (req_id,),
        ).fetchone()
        assert row is not None
        return int(row[0]) + 1

    def record_task_plan(self, req_id: str, plan: TaskPlan) -> TaskPlan:
        """保存一个任务包版本并置 ``plan_proposed``；跨项目与重复版本拒绝。"""

        requirement = self.get(req_id)
        if plan.requirement_id != req_id:
            raise TaskPlanError("任务包绑定的需求身份与记录不一致")
        if plan.project != requirement.project:
            raise TaskPlanError("任务包项目与需求项目不一致（跨项目引用拒绝）")
        if plan.requirement_version != requirement.version_count:
            raise TaskPlanError("任务包绑定的需求版本不是当前版本")
        existing = self._db.execute(
            "SELECT 1 FROM requirement_task_plans WHERE req_id = ? AND plan_version = ?",
            (req_id, plan.plan_version),
        ).fetchone()
        if existing is not None:
            raise TaskPlanError(f"任务包版本已存在: {plan.plan_version}")
        self._db.execute(
            "INSERT INTO requirement_task_plans"
            " (req_id, plan_version, task_plan_id, plan, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                req_id,
                plan.plan_version,
                plan.task_plan_id,
                json.dumps(task_plan_to_payload(plan), ensure_ascii=False),
                _iso(plan.created_at),
            ),
        )
        self._set_status(req_id, PLAN_PROPOSED)
        return plan

    def task_plans(self, req_id: str) -> tuple[TaskPlan, ...]:
        """按版本升序返回全部任务包；未知身份明确失败。"""

        self._require(req_id)
        rows = self._db.execute(
            "SELECT plan FROM requirement_task_plans WHERE req_id = ? ORDER BY plan_version",
            (req_id,),
        ).fetchall()
        return tuple(task_plan_from_payload(json.loads(str(row[0]))) for row in rows)

    def task_plan(self, req_id: str, plan_version: int) -> TaskPlan:
        """按版本回查任务包；不存在时明确失败。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT plan FROM requirement_task_plans WHERE req_id = ? AND plan_version = ?",
            (req_id, plan_version),
        ).fetchone()
        if row is None:
            raise TaskPlanNotFoundError(f"任务包不存在: {req_id} v{plan_version}")
        return task_plan_from_payload(json.loads(str(row[0])))

    def latest_task_plan(self, req_id: str) -> TaskPlan | None:
        """返回最新任务包；从未生成过时为 ``None``。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT plan FROM requirement_task_plans WHERE req_id = ?"
            " ORDER BY plan_version DESC LIMIT 1",
            (req_id,),
        ).fetchone()
        return None if row is None else task_plan_from_payload(json.loads(str(row[0])))

    def record_plan_approval(
        self,
        req_id: str,
        plan_version: int,
        approved_by: str,
        *,
        source: str = "",
        approved_at: datetime | None = None,
    ) -> TaskPlanApproval:
        """记录所有者对某任务包版本的实际批准，并绑定任务级授权来源。

        批准必须对应已存在的任务包版本，该任务包必须是最新版本且绑定当前需求
        版本；需求一经追加，旧任务包即作废，不能取得批准。批准后任务包内每个
        任务的 ``authorization_source`` 由该批准派生并落库，需求置 ``approved``。

        过期任务包、或已有更新任务包版本时对旧版本的批准，都在写入任何批准或
        状态前即被拒绝，避免状态机报告“已批准”却没有任何可执行授权
        （docs/dogfood-contracts.md §5.3）。
        """

        requirement = self.get(req_id)
        plan = self.task_plan(req_id, plan_version)
        if plan.requirement_version != requirement.version_count:
            raise TaskPlanNotAuthorizedError(
                f"任务包 v{plan_version} 绑定需求版本 v{plan.requirement_version}，"
                f"当前需求已是 v{requirement.version_count}；需求已修订，"
                "过期任务包不能取得批准"
            )
        latest_version = self.next_plan_version(req_id) - 1
        if plan_version != latest_version:
            raise TaskPlanNotAuthorizedError(
                f"任务包 v{plan_version} 不是最新版本（最新为 v{latest_version}）；"
                "旧版本批准不能驱动最新任务包，请批准最新任务包版本"
            )
        approval = TaskPlanApproval(
            requirement_id=req_id,
            plan_version=plan_version,
            approved_by=approved_by,
            approved_at=approved_at or _now(),
            source=source,
        )
        authorized = bind_authorization(plan, approval)
        self._db.execute(
            "UPDATE requirement_task_plans SET plan = ? WHERE req_id = ? AND plan_version = ?",
            (
                json.dumps(task_plan_to_payload(authorized), ensure_ascii=False),
                req_id,
                plan_version,
            ),
        )
        self._db.execute(
            "INSERT OR REPLACE INTO requirement_plan_approvals"
            " (req_id, plan_version, approved_by, source, approved_at) VALUES (?, ?, ?, ?, ?)",
            (
                req_id,
                plan_version,
                approval.approved_by,
                approval.source,
                _iso(approval.approved_at),
            ),
        )
        self._set_status(req_id, APPROVED)
        return approval

    def plan_approval(
        self, req_id: str, plan_version: int | None = None
    ) -> TaskPlanApproval | None:
        """回查任务包批准；未指定版本时返回最新一条。"""

        self._require(req_id)
        if plan_version is None:
            row = self._db.execute(
                "SELECT plan_version, approved_by, source, approved_at"
                " FROM requirement_plan_approvals WHERE req_id = ?"
                " ORDER BY plan_version DESC LIMIT 1",
                (req_id,),
            ).fetchone()
        else:
            row = self._db.execute(
                "SELECT plan_version, approved_by, source, approved_at"
                " FROM requirement_plan_approvals WHERE req_id = ? AND plan_version = ?",
                (req_id, plan_version),
            ).fetchone()
        if row is None:
            return None
        return TaskPlanApproval(
            requirement_id=req_id,
            plan_version=int(row[0]),
            approved_by=str(row[1]),
            source=str(row[2]),
            approved_at=_parse(str(row[3])),
        )

    def plan_authorization(self, req_id: str) -> PlanAuthorization:
        """判定当前任务包能否执行：未批准、旧版本或需求已修订都不放行。"""

        requirement = self.get(req_id)
        plan = self.latest_task_plan(req_id)
        if plan is None:
            return PlanAuthorization(
                PlanAuthorizationStatus.MISSING, None, "还没有任务包；未批准不执行"
            )
        if plan.requirement_version != requirement.version_count:
            return PlanAuthorization(
                PlanAuthorizationStatus.STALE,
                self.plan_approval(req_id),
                "需求已修订，任务包对当前版本过期；需重新分析并生成任务包",
            )
        return authorize_plan(plan, self.plan_approval(req_id))

    def authorized_task_plan(self, req_id: str) -> TaskPlan | None:
        """返回真实有效批准所驱动的任务包；未批准或旧版本批准返回 ``None``。"""

        requirement = self.get(req_id)
        plan = self.latest_task_plan(req_id)
        if plan is None or plan.requirement_version != requirement.version_count:
            return None
        approval = self.plan_approval(req_id)
        if authorize_plan(plan, approval).can_execute:
            return plan
        return None

    def task_authorization(self, req_id: str, task_id: str) -> str:
        """任务级授权来源：只来自真实批准；未批准或不在包内明确失败。"""

        plan = self.authorized_task_plan(req_id)
        if plan is None:
            reason = self.plan_authorization(req_id).reason
            raise TaskPlanError(f"任务未获有效授权: {reason}")
        return plan.task(task_id).authorization_source

    # ---- A04 需求内任务推进与依赖产物 ----

    def record_task_run(
        self,
        req_id: str,
        plan_version: int,
        task_id: str,
        state: str,
        *,
        reason: str = "",
        executed_seconds: float = 0.0,
    ) -> RequirementTaskRun:
        """记录一次任务推进结果；实际执行工时按任务累加，不清零。

        同一任务的重复推进只更新最近状态与原因，累计工时继续累加；这是
        “用户等待不计入执行工时”的落库依据：只有真正执行返回时才写入耗时。
        """

        self._require(req_id)
        if executed_seconds < 0:
            raise RequirementError("执行工时不能为负")
        now = _now()
        self._db.execute(
            "INSERT INTO requirement_task_runs"
            " (req_id, plan_version, task_id, state, reason, executed_seconds, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(req_id, plan_version, task_id) DO UPDATE SET"
            " state = excluded.state, reason = excluded.reason,"
            " executed_seconds = requirement_task_runs.executed_seconds"
            " + excluded.executed_seconds,"
            " updated_at = excluded.updated_at",
            (req_id, plan_version, task_id, state, reason, executed_seconds, _iso(now)),
        )
        run = self.task_run(req_id, plan_version, task_id)
        assert run is not None
        return run

    def task_run(self, req_id: str, plan_version: int, task_id: str) -> RequirementTaskRun | None:
        """按需求、任务包版本与任务身份回查最近一次推进记录。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT req_id, plan_version, task_id, state, reason, executed_seconds, updated_at"
            " FROM requirement_task_runs"
            " WHERE req_id = ? AND plan_version = ? AND task_id = ?",
            (req_id, plan_version, task_id),
        ).fetchone()
        if row is None:
            return None
        return _row_to_task_run(tuple(row))

    def task_runs(self, req_id: str, plan_version: int) -> tuple[RequirementTaskRun, ...]:
        """返回某任务包版本下全部任务的推进记录（按任务身份稳定排序）。"""

        self._require(req_id)
        rows = self._db.execute(
            "SELECT req_id, plan_version, task_id, state, reason, executed_seconds, updated_at"
            " FROM requirement_task_runs WHERE req_id = ? AND plan_version = ? ORDER BY task_id",
            (req_id, plan_version),
        ).fetchall()
        return tuple(_row_to_task_run(tuple(row)) for row in rows)

    def record_task_artifact(
        self, req_id: str, plan_version: int, task_id: str, artifact: TaskArtifact
    ) -> TaskArtifact:
        """落库一个任务的已确认产物身份；身份不一致时明确失败。"""

        self._require(req_id)
        if artifact.task_id != task_id:
            raise RequirementError("产物任务身份与写入位置不一致")
        self._db.execute(
            "INSERT OR REPLACE INTO requirement_task_artifacts"
            " (req_id, plan_version, task_id, candidate_sha256, test_evidence_sha256,"
            " review_sha256, acceptance, authorization_source, recorded_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                req_id,
                plan_version,
                task_id,
                artifact.candidate_sha256,
                artifact.test_evidence_sha256,
                artifact.review_sha256,
                artifact.acceptance,
                artifact.authorization_source,
                _iso(_now()),
            ),
        )
        return artifact

    def task_artifact(self, req_id: str, plan_version: int, task_id: str) -> TaskArtifact | None:
        """按任务身份回查已确认产物；未交付过时为 ``None``。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT task_id, candidate_sha256, test_evidence_sha256, review_sha256,"
            " acceptance, authorization_source FROM requirement_task_artifacts"
            " WHERE req_id = ? AND plan_version = ? AND task_id = ?",
            (req_id, plan_version, task_id),
        ).fetchone()
        if row is None:
            return None
        return _row_to_task_artifact(tuple(row))

    def task_artifacts(self, req_id: str, plan_version: int) -> tuple[TaskArtifact, ...]:
        """返回某任务包版本下全部已确认产物（按任务身份稳定排序）。"""

        self._require(req_id)
        rows = self._db.execute(
            "SELECT task_id, candidate_sha256, test_evidence_sha256, review_sha256,"
            " acceptance, authorization_source FROM requirement_task_artifacts"
            " WHERE req_id = ? AND plan_version = ? ORDER BY task_id",
            (req_id, plan_version),
        ).fetchall()
        return tuple(_row_to_task_artifact(tuple(row)) for row in rows)

    def dependency_facts(
        self,
        req_id: str,
        plan_version: int | None = None,
        *,
        single_task_id: Callable[[str], str] | None = None,
    ) -> tuple[DependencyFacts, ...]:
        """只读汇总任务包内每个任务的依赖事实与真实等待判定。

        任务包给出 ``depends_on`` 依赖边；每个前置任务的终态、未完成动作与失败
        轮次从单任务权威记录只读取数，判定交给 ``domain.dependency_facts``。
        ``single_task_id`` 把需求内任务身份映射到单任务记录身份（真实入口应传入
        ``graph.builder.requirement_task_id``）；缺省按同一身份。

        未开始的任务没有单任务记录，这不构成「缺少依据」——其 ``ready`` 与否只
        取决于前置；只有声明的前置任务记录缺失时才输出 ``unknown`` 并列出缺少的
        记录身份。
        """

        self._require(req_id)
        if plan_version is None:
            plan = self.latest_task_plan(req_id)
        else:
            plan = self.task_plan(req_id, plan_version)
        if plan is None:
            return ()
        mapper: Callable[[str], str] = single_task_id or (lambda task_id: task_id)
        records: dict[str, TaskDependencyRecord] = {
            task.task_id: read_task_dependency_record(self._db, mapper(task.task_id))
            for task in plan.tasks
        }
        facts: list[DependencyFacts] = []
        for task in plan.tasks:
            prerequisites = tuple(
                PrerequisiteFact(
                    task_id=dependency,
                    terminal=records[dependency].terminal,
                    recorded_status=records[dependency].status,
                    evidence=records[dependency].evidence,
                    missing=records[dependency].missing,
                )
                for dependency in task.depends_on
            )
            own = records[task.task_id]
            facts.append(
                assess_dependency(
                    task.task_id,
                    prerequisites,
                    outstanding_action=own.outstanding_action,
                    subject_evidence=own.evidence,
                    recorded_status=own.status,
                    failure_rounds=own.failure_rounds,
                )
            )
        return tuple(facts)

    def ensure_requirement_budget(self, req_id: str, limit_seconds: float) -> None:
        """首次为需求建立执行工时账目；已存在时保持不变（消耗不清零）。"""

        if limit_seconds <= 0:
            raise RequirementError("需求执行限额必须为正数")
        self._require(req_id)
        self._db.execute(
            "INSERT OR IGNORE INTO requirement_budget"
            " (req_id, limit_seconds, consumed_seconds) VALUES (?, ?, 0.0)",
            (req_id, limit_seconds),
        )

    def requirement_budget(self, req_id: str) -> ExecutionBudget:
        """需求执行工时账目；尚未建立时明确失败。"""

        self._require(req_id)
        row = self._db.execute(
            "SELECT limit_seconds, consumed_seconds FROM requirement_budget WHERE req_id = ?",
            (req_id,),
        ).fetchone()
        if row is None:
            raise RequirementError(f"需求还没有执行工时账目: {req_id}")
        return ExecutionBudget(limit_seconds=float(row[0]), consumed_seconds=float(row[1]))

    def charge_requirement_budget(self, req_id: str, seconds: float) -> None:
        """累计实际执行工时；单条原子累加，并发计入不丢更新。"""

        if seconds < 0:
            raise RequirementError("执行工时不能为负")
        changed = self._db.execute(
            "UPDATE requirement_budget SET consumed_seconds = consumed_seconds + ?"
            " WHERE req_id = ?",
            (seconds, req_id),
        ).rowcount
        if changed == 0:
            raise RequirementError(f"需求还没有执行工时账目: {req_id}")

    def _set_status(self, req_id: str, status: str, reason: str = "") -> None:
        cursor = self._db.execute(
            "UPDATE requirements SET status = ?, blocked_reason = ? WHERE req_id = ?",
            (status, reason, req_id),
        )
        if cursor.rowcount == 0:
            raise RequirementNotFoundError(f"未知需求身份: {req_id}")

    def _require(self, req_id: str) -> None:
        row = self._db.execute("SELECT 1 FROM requirements WHERE req_id = ?", (req_id,)).fetchone()
        if row is None:
            raise RequirementNotFoundError(f"未知需求身份: {req_id}")
