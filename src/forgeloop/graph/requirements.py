"""需求执行编排（A04）：按依赖串行推进任务并汇总需求状态。

职责边界（DogFood 执行计划 A04 与业务交接约定 §4、§6）：

- **按依赖串行推进**：已批准任务包内的任务按 ``execution_order`` 拓扑序执行；
  已交付任务不重放，未交付任务交给注入的执行器继续推进。
- **前置门**：任一依赖未交付（失败、等待或未运行）时不启动下游；下游因此不会
  读到缺失或不一致的产物。
- **依赖产物落库**：上游交付时把已确认产物身份（候选 diff、正式测试证据、审查
  结论、验收结论与授权来源）写入权威记录；下游从记录读取，进程重开仍可读，
  并以显式字段 ``TaskExecution.dependencies`` 交给执行器。
- **等待不消耗执行工时**：本模块只用 ``clock`` 度量一次 ``run_task`` 调用本身的
  实际执行段并累计到需求工时账目；依赖等待、人工决定等待与两次推进之间的用户
  等待都不计时，状态只说明下一步需要谁做什么。
- **状态汇总**：``RequirementProgress`` 给出当前任务、已完成任务、阻塞原因与
  ``NextAction``（动作、主体 user/agent、原因）；全部任务交付后需求仍等待整体
  验收（``executing``，不新增状态词）。

**执行器由调用方注入**：真实单任务业务图（PI 实现、审查、正式测试、验收）如何
接线不在本模块范围，属于 I01；``graph.requirements`` 只决定“谁可以开始、带什么
前置产物、何时停下”。盲重放防护由单任务动作生命周期（B03）负责，本模块只保证
已交付任务不再执行。
"""

import json
import sqlite3
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    applied_prerequisites,
    apply_diff_to_workspace,
    apply_diff_to_workspace_three_way,
    clear_applied_prerequisites,
    diff_is_applied,
    mark_prerequisite_applied,
    recorded_baseline,
    reset_workspace,
    workspace_head,
)
from forgeloop.domain.delivery import sha256_of_text
from forgeloop.domain.requirement import BLOCKED, RequirementError
from forgeloop.domain.status import ActionActor, NextAction
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.records.actions import ActionRecord, ActionStore, ExecutionSlotBusyError
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import OutcomeStore, RecordStore

# 需求生命周期（契约 §4 精简集合）：A04 不新增状态词。
# approved（任务包已批准）后进入 executing；全部任务交付后仍为 executing，
# 等待所有者做需求整体验收，由 B04 决定 accepted。
EXECUTING = "executing"

# 默认执行工时上限：所有任务限额之和；调用方可显式覆盖。
Clock = Callable[[], float]


class RequirementExecutionError(RuntimeError):
    """需求执行编排的前提被破坏（例如已批准的记录不一致）。"""


class RequirementAlreadyRunningError(RuntimeError):
    """同一需求的执行槽位仍被占用：拒绝重复启动（A05）。

    占用未必代表真有推进在运行：进程被强杀会留下未完成的槽位，语义与 B03 的未完成
    动作一致。错误信息应给出占用者与开始时间，并指向查看/清理入口，避免把中断残留
    误报成「已有推进在执行」而堵死恢复路径。
    """

    def __init__(
        self, req_id: str, *, owner: str = "", started_at: str = "", reason: str = ""
    ) -> None:
        detail = f"（占用者 {owner or '未知'}，开始于 {started_at or '未知'}）"
        residue = f"残留判定：{reason}。" if reason else ""
        super().__init__(
            f"需求 {req_id} 的执行槽位仍被占用{detail}；{residue}"
            "可能是上一进程被中断的残留，不代表一定有推进在运行。"
            "请用 `forgeloop requirement slot list` 核对现场，确认无推进在运行后"
            f"用 `forgeloop requirement slot clear --slot requirement:{req_id}` 清理再重试；"
            "若为中断残留，清理后推进会把未完成动作标记为 interrupted，供人工核对。"
        )
        self.req_id = req_id


class TaskRunState(StrEnum):
    """一次任务推进的结果：交付、等待人工、失败或阻塞。"""

    DELIVERED = "delivered"
    AWAITING_USER = "awaiting_user"
    FAILED = "failed"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class TaskExecution:
    """交给执行器的一次任务执行请求，携带已落库的前置产物身份。

    ``covered_dependencies`` 是直接依赖中「被其他直接依赖传递包含」的祖先任务：
    后建任务的候选 diff 相对基线采集，已带上祖先的全部改动，因此只需应用极大
    依赖；被覆盖的依赖照常校验与记录，但不单独应用（其改动随极大依赖一并带入）。
    """

    task: PlannedTask
    dependencies: tuple[TaskArtifact, ...] = ()
    covered_dependencies: tuple[str, ...] = ()


@dataclass(frozen=True)
class TaskResult:
    """执行器返回的结果；交付状态必须带已确认产物。"""

    state: TaskRunState
    artifact: TaskArtifact | None = None
    reason: str = ""


# 前置候选应用记录文件名：落在下游任务现场，记录逐条应用结果与校验值。
PREREQUISITE_RECORD_NAME = "prerequisite-applications.json"


class PrerequisiteApplyStatus(StrEnum):
    """一处前置候选的应用结果；成功、已完成与各类失败分别如实记录。"""

    APPLIED = "applied"
    ALREADY_APPLIED = "already_applied"
    SKIPPED = "skipped"
    MISSING = "missing"
    CHECKSUM_MISMATCH = "checksum_mismatch"
    FAILED = "failed"


@dataclass(frozen=True)
class PrerequisiteCandidate:
    """一处待应用的前置候选：任务身份、记录校验值与候选 diff 现场路径。

    ``covered`` 为真表示该前置被另一直接依赖传递包含（属于菱形/冗余依赖的祖先）：
    它仍参与校验与记录，但不单独应用，避免对同一新文件重复 apply 失败或冲突。
    """

    task_id: str
    candidate_sha256: str
    diff_path: Path
    covered: bool = False


@dataclass(frozen=True)
class PrerequisiteApplication:
    """一条前置候选的应用记录：标识、校验值与结果。"""

    task_id: str
    candidate_sha256: str
    status: PrerequisiteApplyStatus
    detail: str = ""


@dataclass(frozen=True)
class PrerequisiteApplyReport:
    """一次下游启动前的前置应用汇总；``blocked_reason`` 非空表示拒绝启动。"""

    applications: tuple[PrerequisiteApplication, ...] = ()
    blocked_reason: str = ""

    @property
    def blocked(self) -> bool:
        return bool(self.blocked_reason)

    @property
    def applied_count(self) -> int:
        return sum(
            1
            for item in self.applications
            if item.status
            in (PrerequisiteApplyStatus.APPLIED, PrerequisiteApplyStatus.ALREADY_APPLIED)
        )


def _write_report(record_path: Path, report: PrerequisiteApplyReport) -> None:
    """把逐条应用结果写入下游任务现场；记录失败不掩盖业务结论。"""

    payload = {
        "applications": [
            {
                "task_id": item.task_id,
                "candidate_sha256": item.candidate_sha256,
                "status": item.status.value,
                "detail": item.detail,
            }
            for item in report.applications
        ],
        "blocked_reason": report.blocked_reason,
    }
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _downstream_task_id(record_path: Path) -> str:
    """下游任务身份：记录现场落在 ``<records_root>/<task_id>/`` 下，取目录名。"""

    return record_path.parent.name


def _open_outcomes(record_path: Path) -> RecordStore | None:
    """从记录现场路径推出并打开权威记录库；库不存在时返回 ``None``。

    ``record_path`` 落在 ``<records_root>/<task_id>/`` 下，记录库是同根的
    ``records.sqlite``。只打开已存在的库，避免无关调用意外创建记录文件；
    打不开（文件损坏等）按无记录处理，业务结论不被记录副作用掩盖。
    """

    db_path = record_path.parent.parent / "records.sqlite"
    if not db_path.is_file():
        return None
    try:
        return RecordStore(db_path)
    except (OSError, sqlite3.Error):
        return None


def apply_prerequisite_candidates(
    workspace: Path,
    candidates: Sequence[PrerequisiteCandidate],
    record_path: Path,
    *,
    outcomes: OutcomeStore | None = None,
) -> PrerequisiteApplyReport:
    """把已完成前置任务的候选改动作为代码输入应用到下游任务副本。

    先逐条读取候选 diff 并核对记录校验值，任一缺失或校验不符即整体阻塞、
    不写入任何代码；全部通过后才按依赖顺序应用。已记录成功且现场仍生效的
    候选按幂等跳过，不重复应用。应用失败时回退到应用前的干净副本并如实记录。

    幂等判定与回退均以持久记录为准：副本本地标记（现场证明）+ 权威记录库
    （``OutcomeStore``，由 ``record_path`` 同根推导或显式注入）。重复启动时读取
    记录；记录与现场都确认才跳过，只有记录而副本已被重新克隆/回退时仍重新应用。
    应用与回退的逐条结果同时写入记录库与任务现场 JSON，进程重开仍可读。
    """

    candidates = tuple(candidates)
    if not candidates:
        return PrerequisiteApplyReport()
    opened = _open_outcomes(record_path) if outcomes is None else None
    outcome_store = (
        outcomes if outcomes is not None else (opened.outcomes if opened is not None else None)
    )
    task_id = _downstream_task_id(record_path)
    recorded = outcome_store.prerequisite_applications(task_id) if outcome_store is not None else {}

    def _emit(report: PrerequisiteApplyReport) -> PrerequisiteApplyReport:
        """落盘一次应用结果：现场 JSON + 权威记录库；记录失败不掩盖业务结论。"""

        _write_report(record_path, report)
        if outcome_store is not None:
            outcome_store.record_prerequisite_applications(
                task_id,
                tuple(
                    (item.task_id, item.candidate_sha256, item.status.value, item.detail)
                    for item in report.applications
                ),
            )
        return report

    try:
        # 幂等判定以权威记录为准：有记录库时，必须记录确认已应用且副本现场有证据
        # （本地标记或反向校验通过）才跳过。下游在首轮修改了前置文件后反向校验会
        # 失败，但标记与记录仍成立，据此跳过重复 apply，避免回退并丢弃下游改动；
        # 记录未确认（缺失、failed 或不符）时即便有残留标记也重新应用。
        workspace_applied = applied_prerequisites(workspace)
        outcomes_by_task: dict[str, PrerequisiteApplication] = {}
        verified: list[tuple[PrerequisiteCandidate, str]] = []
        problems: list[str] = []
        # 本轮确实存在于工作副本（已应用或先前已应用）的前置：回退会一并丢弃其改动，
        # 失败时这些前置的记录必须同步改为 failed，不能声称成功。
        present_in_workspace: list[str] = []
        for candidate in candidates:
            if not candidate.diff_path.is_file():
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.MISSING,
                    f"前置候选产物缺失: {candidate.diff_path}",
                )
                problems.append(f"前置候选产物缺失: {candidate.task_id}")
                continue
            diff_text = candidate.diff_path.read_text(encoding="utf-8")
            if not diff_text.strip():
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.MISSING,
                    "前置候选产物为空",
                )
                problems.append(f"前置候选产物为空: {candidate.task_id}")
                continue
            actual = sha256_of_text(diff_text)
            if actual != candidate.candidate_sha256:
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.CHECKSUM_MISMATCH,
                    f"校验值不符: 记录 {candidate.candidate_sha256[:12]}，实际 {actual[:12]}",
                )
                problems.append(f"前置候选校验值不符: {candidate.task_id}")
                continue
            if candidate.covered:
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.SKIPPED,
                    "已被其他直接依赖传递包含，其改动随该前置一并带入，不单独应用",
                )
                continue
            key = (candidate.task_id, candidate.candidate_sha256)
            recorded_entry = recorded.get(candidate.task_id)
            recorded_applied = (
                recorded_entry is not None
                and recorded_entry[0] == candidate.candidate_sha256
                and recorded_entry[1]
                in (
                    PrerequisiteApplyStatus.APPLIED.value,
                    PrerequisiteApplyStatus.ALREADY_APPLIED.value,
                )
            )
            # 有权威记录库时必须先由记录确认已应用，再叠加副本现场证据；只有本地标记
            # 命中而记录未确认（缺失、failed 或不符）时不跳过——回退后残留的标记会让
            # 实际已消失的改动被误判为已应用。没有记录库（旧流程）时才退回纯现场标记判定。
            workspace_contains = key in workspace_applied or diff_is_applied(workspace, diff_text)
            record_confirms = recorded_applied or outcome_store is None
            if workspace_contains and record_confirms:
                mark_prerequisite_applied(workspace, candidate.task_id, candidate.candidate_sha256)
                detail = (
                    "权威记录与本工作副本均确认该前置候选已应用，跳过重复应用"
                    if recorded_applied
                    else "本工作副本已包含该前置候选，跳过重复应用"
                )
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.ALREADY_APPLIED,
                    detail,
                )
                present_in_workspace.append(candidate.task_id)
                continue
            if diff_is_applied(workspace, diff_text):
                mark_prerequisite_applied(workspace, candidate.task_id, candidate.candidate_sha256)
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.ALREADY_APPLIED,
                    "前序前置候选已带出同一改动，现场反向校验通过，跳过重复应用",
                )
                present_in_workspace.append(candidate.task_id)
                continue
            verified.append((candidate, diff_text))
        if problems:
            for candidate, _ in verified:
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.SKIPPED,
                    "同一批前置校验未通过，未应用任何代码",
                )
            report = PrerequisiteApplyReport(
                tuple(outcomes_by_task[c.task_id] for c in candidates), "; ".join(problems)
            )
            return _emit(report)

        snapshot = recorded_baseline(workspace) or workspace_head(workspace)
        for index, (candidate, diff_text) in enumerate(verified):
            detail = ""
            # 前序候选（尤其是后建的前置，其 diff 已含祖先改动）可能已把本候选带出：
            # 应用前再按现场反向校验一次，避免对已生效改动重复 apply。
            if diff_is_applied(workspace, diff_text):
                mark_prerequisite_applied(workspace, candidate.task_id, candidate.candidate_sha256)
                outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                    candidate.task_id,
                    candidate.candidate_sha256,
                    PrerequisiteApplyStatus.ALREADY_APPLIED,
                    "前序前置候选已带出同一改动，现场反向校验通过，跳过重复应用",
                )
                present_in_workspace.append(candidate.task_id)
                continue
            try:
                apply_diff_to_workspace(workspace, diff_text)
            except WorkspaceError:
                # 普通应用失败不一定是真失败：菱形/冗余依赖下，后一个前置候选的 diff
                # 已包含前一个的改动（在已应用前者的副本里采集），直接 apply 会因 hunk
                # 已存在而失败。此时用三方合并只补上尚未应用的部分；真实冲突仍按失败
                # 处理并回退，既不静默放行也不误阻塞。
                try:
                    apply_diff_to_workspace_three_way(workspace, diff_text)
                except WorkspaceError as error:
                    for applied_id in present_in_workspace:
                        outcomes_by_task[applied_id] = PrerequisiteApplication(
                            applied_id,
                            outcomes_by_task[applied_id].candidate_sha256,
                            PrerequisiteApplyStatus.FAILED,
                            "应用后因后续候选失败已回退到干净副本",
                        )
                    outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                        candidate.task_id,
                        candidate.candidate_sha256,
                        PrerequisiteApplyStatus.FAILED,
                        str(error)[:200],
                    )
                    # 失败点之后的候选尚未处理，也必须逐条落盘结果，不能缺条导致 KeyError
                    # 或让报告漏报：标记为「前序失败未应用」。
                    for remaining, _ in verified[index + 1 :]:
                        outcomes_by_task.setdefault(
                            remaining.task_id,
                            PrerequisiteApplication(
                                remaining.task_id,
                                remaining.candidate_sha256,
                                PrerequisiteApplyStatus.SKIPPED,
                                "前序候选应用失败，未应用",
                            ),
                        )
                    problems.append(f"前置候选应用失败: {candidate.task_id}")
                    report = PrerequisiteApplyReport(
                        tuple(outcomes_by_task[c.task_id] for c in candidates),
                        "; ".join(problems),
                    )
                    # 先把失败记录写入权威记录库，再清理标记并回退工作区：进程若在
                    # 回退与记录之间中断，记录已是 failed，下次启动不会据陈旧的成功
                    # 记录或残留标记把已回退的改动误判为已应用。
                    _emit(report)
                    try:
                        clear_applied_prerequisites(workspace)
                        reset_workspace(workspace, snapshot)
                    except WorkspaceError as reset_error:
                        problems.append(f"回退失败: {reset_error}")
                        failed = PrerequisiteApplyReport(
                            tuple(outcomes_by_task[c.task_id] for c in candidates),
                            "; ".join(problems),
                        )
                        return _emit(failed)
                    return report
                detail = "普通应用失败，经三方合并补齐其余改动（部分改动已由其他前置带出）"
            outcomes_by_task[candidate.task_id] = PrerequisiteApplication(
                candidate.task_id,
                candidate.candidate_sha256,
                PrerequisiteApplyStatus.APPLIED,
                detail,
            )
            present_in_workspace.append(candidate.task_id)
            mark_prerequisite_applied(workspace, candidate.task_id, candidate.candidate_sha256)
        report = PrerequisiteApplyReport(tuple(outcomes_by_task[c.task_id] for c in candidates))
        return _emit(report)
    finally:
        if opened is not None:
            opened.close()


@dataclass(frozen=True)
class RequirementProgress:
    """需求执行汇总：当前任务、已完成任务、阻塞原因与下一步动作。"""

    req_id: str
    plan_version: int
    requirement_status: str
    current_task: str | None
    completed_tasks: tuple[str, ...]
    blocked_reason: str
    next_step: NextAction
    consumed_seconds: float = 0.0
    limit_seconds: float = 0.0
    all_tasks_delivered: bool = False


def _delivered(run: object) -> bool:
    """推进记录是否处于已交付状态（``records`` 返回的记录或 ``None``）。"""

    return getattr(run, "state", None) == TaskRunState.DELIVERED.value


class RequirementExecutor:
    """按依赖推进一条需求的任务，并把前置产物传给下游执行器。

    ``run_task`` 是真实执行接缝（I01 接单任务业务图）；测试注入确定性的替身。
    ``clock`` 默认 ``time.monotonic``，只为度量单次调用的实际执行段，不度量等待。
    """

    def __init__(
        self,
        store: RequirementStore,
        req_id: str,
        run_task: Callable[[TaskExecution], TaskResult],
        *,
        budget_seconds: float | None = None,
        clock: Clock = time.monotonic,
        slots: ActionStore | None = None,
    ) -> None:
        self._store = store
        self._req_id = req_id
        self._run_task = run_task
        self._budget_seconds = budget_seconds
        self._clock = clock
        self._slots = slots

    def advance(self) -> RequirementProgress:
        """原子占用本需求执行槽位后推进；已被其他推进占用时明确拒绝。

        未注入 ``slots`` 时保持原有单进程行为（兼容既有调用与 A04 测试）；注入后
        以记录层槽位拒绝「同一需求并发推进」，并发只有一个调用能真正执行。获取
        槽位时先判定残留：占用者已证明死亡则自动清理并继续，存活或不确定则明确
        报告原因并保持等待（不启动业务图）。
        """

        if self._slots is None:
            return self._advance()
        slot_key = f"requirement:{self._req_id}"
        slot = self._claim_slot(slot_key)
        try:
            return self._advance()
        finally:
            self._slots.release_slot(slot.action_id)

    def _claim_slot(self, slot_key: str) -> ActionRecord:
        """占用需求槽位：占用者已证明死亡时自动清理后重试，否则报告原因。

        判定只依据权威动作记录里的进程身份，不依据等待时长；已死占用者由记录层
        安全清理并留档，存活或不确定一律不清理，抛出带具体原因的
        :class:`RequirementAlreadyRunningError`，交由人工核对后再决定。
        """

        slots = self._slots
        assert slots is not None
        while True:
            try:
                return slots.claim_slot(slot_key, owner=self._req_id)
            except ExecutionSlotBusyError as error:
                outcome = slots.cleanup_slot_residue(slot_key)
                if outcome.cleaned:
                    continue
                existing = slots.slot_owner(slot_key)
                raise RequirementAlreadyRunningError(
                    self._req_id,
                    owner=existing.role if existing is not None else "",
                    started_at=existing.started_at.isoformat() if existing is not None else "",
                    reason=outcome.assessment.reason,
                ) from error

    def _advance(self) -> RequirementProgress:
        """推进需求内所有可执行任务，直到交付完成、等待人工或阻塞。"""

        store = self._store
        req_id = self._req_id
        # 未知身份在第一步就明确失败，不留下任何半条推进记录。
        store.requirement_status(req_id)
        plan = store.authorized_task_plan(req_id)
        if plan is not None:
            self._ensure_budget(plan)
            store.set_requirement_status(req_id, EXECUTING)
            self._run_ready(plan)
        return self.progress()

    def progress(self) -> RequirementProgress:
        """只读汇总当前需求执行状态与下一步，不启动任何动作。"""

        store = self._store
        req_id = self._req_id
        status = store.requirement_status(req_id)
        plan = store.latest_task_plan(req_id)
        consumed, limit = self._budget_totals()
        if plan is None:
            return RequirementProgress(
                req_id=req_id,
                plan_version=0,
                requirement_status=status,
                current_task=None,
                completed_tasks=(),
                blocked_reason=store.blocked_reason(req_id),
                next_step=NextAction(
                    "生成或批准任务包", ActionActor.USER, "还没有任务包；未批准不执行"
                ),
                consumed_seconds=consumed,
                limit_seconds=limit,
            )
        authorization = store.plan_authorization(req_id)
        if not authorization.can_execute:
            return RequirementProgress(
                req_id=req_id,
                plan_version=plan.plan_version,
                requirement_status=status,
                current_task=None,
                completed_tasks=(),
                blocked_reason=authorization.reason,
                next_step=NextAction(
                    "批准或重新生成任务包", ActionActor.USER, authorization.reason
                ),
                consumed_seconds=consumed,
                limit_seconds=limit,
            )
        authorized = store.authorized_task_plan(req_id)
        if authorized is None:  # pragma: no cover - 上一步已判定可执行
            raise RequirementExecutionError("已判定可执行却取不到任务包")
        runs = {run.task_id: run for run in store.task_runs(req_id, authorized.plan_version)}
        order = authorized.execution_order()
        completed = tuple(task_id for task_id in order if _delivered(runs.get(task_id)))
        for task_id in order:
            run = runs.get(task_id)
            if _delivered(run):
                continue
            task = authorized.task(task_id)
            if any(not _delivered(runs.get(dep)) for dep in task.depends_on):
                reason = f"前置任务未交付，下游不启动: {task_id}"
                return self._blocked(authorized, task_id, completed, reason, consumed, limit)
            if limit > 0 and consumed >= limit:
                reason = "需求执行工时限额已耗尽"
                return self._blocked(authorized, task_id, completed, reason, consumed, limit)
            if run is None:
                return RequirementProgress(
                    req_id=req_id,
                    plan_version=authorized.plan_version,
                    requirement_status=status,
                    current_task=task_id,
                    completed_tasks=completed,
                    blocked_reason="",
                    next_step=NextAction(
                        "按依赖执行下一个任务",
                        ActionActor.AGENT,
                        "依赖已满足，可执行该任务",
                    ),
                    consumed_seconds=consumed,
                    limit_seconds=limit,
                )
            if run.state == TaskRunState.AWAITING_USER.value:
                return RequirementProgress(
                    req_id=req_id,
                    plan_version=authorized.plan_version,
                    requirement_status=status,
                    current_task=task_id,
                    completed_tasks=completed,
                    blocked_reason=run.reason,
                    next_step=NextAction(
                        "处理等待中的任务", ActionActor.USER, run.reason or "等待所有者决定"
                    ),
                    consumed_seconds=consumed,
                    limit_seconds=limit,
                )
            reason = run.reason or f"任务状态: {run.state}"
            return self._blocked(authorized, task_id, completed, reason, consumed, limit)
        return RequirementProgress(
            req_id=req_id,
            plan_version=authorized.plan_version,
            requirement_status=EXECUTING,
            current_task=None,
            completed_tasks=completed,
            blocked_reason="",
            next_step=NextAction(
                "需求整体验收", ActionActor.USER, "全部任务已交付，仍需需求整体验收"
            ),
            consumed_seconds=consumed,
            limit_seconds=limit,
            all_tasks_delivered=True,
        )

    def _run_ready(self, plan: TaskPlan) -> None:
        store = self._store
        req_id = self._req_id
        runs = {run.task_id: run for run in store.task_runs(req_id, plan.plan_version)}
        for task_id in plan.execution_order():
            run = runs.get(task_id)
            if _delivered(run):
                continue
            task = plan.task(task_id)
            if any(not _delivered(runs.get(dep)) for dep in task.depends_on):
                store.set_requirement_status(
                    req_id, BLOCKED, f"前置任务未交付，下游不启动: {task_id}"
                )
                return
            budget = store.requirement_budget(req_id)
            if not budget.can_start_action():
                store.set_requirement_status(req_id, BLOCKED, "需求执行工时限额已耗尽")
                return
            execution = TaskExecution(
                task=task,
                dependencies=self._dependencies(plan, task),
                covered_dependencies=self._covered_dependencies(plan, task),
            )
            started = self._clock()
            result = self._run_task(execution)
            elapsed = max(0.0, self._clock() - started)
            state = result.state
            reason = result.reason
            if state is TaskRunState.DELIVERED and result.artifact is None:
                # 交付却没有可传递产物：下游会读到缺失身份，按阻塞处理而不是放行。
                state = TaskRunState.BLOCKED
                reason = f"delivered_without_artifact:{task_id}"
            recorded = store.record_task_run(
                req_id,
                plan.plan_version,
                task_id,
                state.value,
                reason=reason,
                executed_seconds=elapsed,
            )
            if state is TaskRunState.DELIVERED and result.artifact is not None:
                store.record_task_artifact(req_id, plan.plan_version, task_id, result.artifact)
            if elapsed > 0:
                store.charge_requirement_budget(req_id, elapsed)
            runs[task_id] = recorded
            if state is not TaskRunState.DELIVERED:
                if state is TaskRunState.AWAITING_USER:
                    store.set_requirement_status(req_id, EXECUTING, reason)
                else:
                    store.set_requirement_status(req_id, BLOCKED, reason or state.value)
                return

    def _dependencies(self, plan: TaskPlan, task: PlannedTask) -> tuple[TaskArtifact, ...]:
        store = self._store
        artifacts: list[TaskArtifact] = []
        for dependency in task.depends_on:
            artifact = store.task_artifact(self._req_id, plan.plan_version, dependency)
            if artifact is None:  # pragma: no cover - 调用前已判定依赖已交付
                raise RequirementExecutionError(f"依赖产物缺失: {dependency}")
            artifacts.append(artifact)
        return tuple(artifacts)

    def _covered_dependencies(self, plan: TaskPlan, task: PlannedTask) -> tuple[str, ...]:
        """在直接依赖里找出被其他直接依赖传递包含的祖先任务。

        后建任务的候选 diff 相对批准基线采集，本就包含其全部祖先的改动。下游若把
        祖先与后代都当独立改动逐条 apply，会在同一新文件上重复或冲突（菱形/冗余
        依赖）。这里按任务包依赖拓扑剔除祖先，只保留极大依赖；被剔除项照常由调用
        方校验与记录。
        """

        direct = set(task.depends_on)
        covered: set[str] = set()
        for dependency in task.depends_on:
            covered |= self._ancestors(plan, dependency) & direct
        return tuple(dependency for dependency in task.depends_on if dependency in covered)

    @staticmethod
    def _ancestors(plan: TaskPlan, task_id: str) -> set[str]:
        """某任务的全部祖先任务身份（任务包构造时已保证无环）。"""

        ancestors: set[str] = set()
        stack = list(plan.task(task_id).depends_on)
        while stack:
            current = stack.pop()
            if current in ancestors:
                continue
            ancestors.add(current)
            stack.extend(plan.task(current).depends_on)
        return ancestors

    def _ensure_budget(self, plan: TaskPlan) -> None:
        limit = self._budget_seconds
        if limit is None:
            limit = sum(task.limits.limit_seconds for task in plan.tasks)
        self._store.ensure_requirement_budget(self._req_id, limit)

    def _budget_totals(self) -> tuple[float, float]:
        try:
            budget = self._store.requirement_budget(self._req_id)
        except RequirementError:
            return 0.0, 0.0
        return budget.consumed_seconds, budget.limit_seconds

    def _blocked(
        self,
        plan: TaskPlan,
        task_id: str,
        completed: tuple[str, ...],
        reason: str,
        consumed: float,
        limit: float,
    ) -> RequirementProgress:
        return RequirementProgress(
            req_id=self._req_id,
            plan_version=plan.plan_version,
            requirement_status=BLOCKED,
            current_task=task_id,
            completed_tasks=completed,
            blocked_reason=reason,
            next_step=NextAction("人工核对任务结果", ActionActor.USER, reason),
            consumed_seconds=consumed,
            limit_seconds=limit,
        )
