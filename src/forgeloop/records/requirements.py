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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

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
