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

import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from forgeloop.domain.requirement import BLOCKED, RequirementError
from forgeloop.domain.status import ActionActor, NextAction
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.records.actions import ActionRecord, ActionStore, ExecutionSlotBusyError
from forgeloop.records.requirements import RequirementStore, TaskArtifact

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
    """交给执行器的一次任务执行请求，携带已落库的前置产物身份。"""

    task: PlannedTask
    dependencies: tuple[TaskArtifact, ...] = ()


@dataclass(frozen=True)
class TaskResult:
    """执行器返回的结果；交付状态必须带已确认产物。"""

    state: TaskRunState
    artifact: TaskArtifact | None = None
    reason: str = ""


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
