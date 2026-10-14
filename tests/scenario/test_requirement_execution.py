"""A04 需求执行场景：按依赖串行推进、传递前置产物、等待不耗工时、状态汇总。

用确定性的替身执行器（注入 ``run_task``）驱动 ``graph.requirements``，验证四类业务
不变量：

- 需求任务包经真实记录层批准后，任务按依赖拓扑序串行执行；
- 前置任务失败或等待人工决定时不启动下游；
- 下游读取已落库的前置任务产物身份，进程重开仍可读；
- 等待（依赖未完成、或两次推进之间用户等待）不计入执行工时；
- 汇总状态说明当前任务、阻塞原因与下一步需要谁做什么。

真实 PI 与容器边界不在此用例覆盖：那属于 I01 的真实运行入口接线与集成验证。
"""

from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.requirement import BLOCKED as REQUIREMENT_BLOCKED
from forgeloop.domain.status import ActionActor
from forgeloop.domain.task_plan import (
    PLAN_PROPOSED,
    PlannedTask,
    TaskLimits,
    TaskPlan,
)
from forgeloop.graph.requirements import (
    EXECUTING,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


class FakeClock:
    """可推进的单调时钟：只在替身执行器「实际工作」时前进。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


class ScriptedRunner:
    """按任务身份给出结果并记录调用；执行期间推进假时钟模拟真实耗时。"""

    def __init__(
        self,
        clock: FakeClock,
        script: dict[str, tuple[float, TaskResult]],
    ) -> None:
        self._clock = clock
        self._script = script
        self.calls: list[TaskExecution] = []

    def __call__(self, execution: TaskExecution) -> TaskResult:
        self.calls.append(execution)
        duration, result = self._script[execution.task.task_id]
        self._clock.tick(duration)
        return result

    @property
    def called_tasks(self) -> list[str]:
        return [execution.task.task_id for execution in self.calls]


def artifact(task_id: str, marker: str) -> TaskArtifact:
    """一条已确认前置产物：候选 diff、测试证据、审查结论与验收结论身份。"""

    return TaskArtifact(
        task_id=task_id,
        candidate_sha256=marker * 64,
        test_evidence_sha256=(marker.upper()) * 64,
        review_sha256="r" * 64,
        acceptance="accepted",
        authorization_source=f"plan-approval:{task_id}:v1:owner",
    )


def planned(
    task_id: str,
    *,
    depends_on: tuple[str, ...] = (),
    limit_seconds: float = 7200.0,
) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/forgeloop/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=("uv", "run", "pytest", f"tests/{task_id}.py", "-q"),
        depends_on=depends_on,
        limits=TaskLimits(limit_seconds=limit_seconds, max_failure_rounds=3),
    )


def approved_scene(
    tmp_path: Path,
    tasks: tuple[PlannedTask, ...],
) -> tuple[RequirementStore, str]:
    """真实记录层：提交需求、记录任务包并取得所有者批准。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：按依赖推进任务并汇总状态")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=tasks,
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, 1, "owner", source="batch-A04")
    return store, requirement.req_id


def two_task_plan() -> tuple[PlannedTask, PlannedTask]:
    return planned("first"), planned("second", depends_on=("first",))


class TestDependencyExecution:
    def test_runs_ready_tasks_in_dependency_order(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (5.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "a"))),
                "second": (3.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        assert runner.called_tasks == ["first", "second"]
        assert progress.completed_tasks == ("first", "second")
        assert progress.current_task is None
        assert progress.consumed_seconds == 8.0
        assert progress.requirement_status == EXECUTING

    def test_downstream_receives_prerequisite_artifact(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        first_artifact = artifact("first", "a")
        runner = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED, first_artifact)),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        downstream = runner.calls[1]
        assert downstream.task.task_id == "second"
        assert downstream.dependencies == (first_artifact,)

    def test_all_delivered_still_waits_for_overall_acceptance(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "a"))),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        assert progress.requirement_status == EXECUTING
        assert progress.next_step.actor is ActionActor.USER
        assert "验收" in progress.next_step.action


class TestPrerequisiteGatesDownstream:
    def test_failed_prerequisite_does_not_start_downstream(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (2.0, TaskResult(TaskRunState.FAILED, reason="正式测试失败，额度用尽")),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
            persisted_second = store.task_run(req_id, 1, "second")
        finally:
            store.close()

        assert runner.called_tasks == ["first"]
        assert persisted_second is None
        assert progress.current_task == "first"
        assert progress.requirement_status == REQUIREMENT_BLOCKED
        assert "额度用尽" in progress.blocked_reason
        assert progress.next_step.actor is ActionActor.USER

    def test_awaiting_prerequisite_does_not_start_downstream(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (0.0, TaskResult(TaskRunState.AWAITING_USER, reason="等待追加授权")),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        assert runner.called_tasks == ["first"]
        assert progress.current_task == "first"
        assert progress.next_step.actor is ActionActor.USER
        assert "追加授权" in progress.next_step.reason

    def test_delivered_without_artifact_blocks_downstream(self, tmp_path: Path) -> None:
        """交付却拿不出前置产物身份：不得放行下游（fail-closed）。"""

        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED)),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
            stored_first = store.task_artifact(req_id, 1, "first")
        finally:
            store.close()

        assert runner.called_tasks == ["first"]
        assert stored_first is None
        assert progress.requirement_status == REQUIREMENT_BLOCKED
        assert "artifact" in progress.blocked_reason


class TestWaitingDoesNotConsumeBudget:
    def test_owner_wait_between_advances_is_not_charged(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        waiting = ScriptedRunner(
            clock,
            {
                "first": (0.0, TaskResult(TaskRunState.AWAITING_USER, reason="等待批准")),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        executor = RequirementExecutor(store, req_id, waiting, clock=clock)
        try:
            first = executor.advance()
            assert first.consumed_seconds == 0.0

            # 所有者等待一小时后再推进；等待时间不得计入执行工时。
            clock.tick(3600.0)
            delivering = ScriptedRunner(
                clock,
                {
                    "first": (5.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "a"))),
                    "second": (3.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
                },
            )
            final = RequirementExecutor(store, req_id, delivering, clock=clock).advance()
            budget = store.requirement_budget(req_id)
        finally:
            store.close()

        assert delivering.called_tasks == ["first", "second"]
        assert final.consumed_seconds == 8.0
        assert budget.consumed_seconds == 8.0

    def test_dependency_wait_is_not_charged(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (0.0, TaskResult(TaskRunState.FAILED, reason="实现失败")),
                "second": (9.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        # 下游从未启动，等待它的时间不产生任何工时。
        assert progress.consumed_seconds == 0.0

    def test_exhausted_budget_stops_starting_new_tasks(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (10.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "a"))),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(
                store, req_id, runner, clock=clock, budget_seconds=10.0
            ).advance()
        finally:
            store.close()

        assert runner.called_tasks == ["first"]
        assert progress.requirement_status == REQUIREMENT_BLOCKED
        assert "工时" in progress.blocked_reason or "限额" in progress.blocked_reason
        assert progress.next_step.actor is ActionActor.USER


class TestIdempotence:
    def test_delivered_tasks_are_not_replayed(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "a"))),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            executor = RequirementExecutor(store, req_id, runner, clock=clock)
            executor.advance()
            executor.advance()
        finally:
            store.close()

        assert runner.called_tasks == ["first", "second"]

    def test_progress_is_read_only(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(clock, {})
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).progress()
        finally:
            store.close()

        assert runner.calls == []
        assert progress.current_task == "first"
        assert progress.next_step.actor is ActionActor.AGENT

    def test_progress_names_next_actor_and_action(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        clock = FakeClock()
        runner = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.AWAITING_USER, reason="等待所有者决定")),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        assert progress.current_task == "first"
        assert progress.next_step.actor is ActionActor.USER
        assert progress.next_step.action
        assert progress.next_step.reason == "等待所有者决定"


class TestArtifactsSurviveReopen:
    def test_downstream_reads_prerequisite_artifact_after_reopen(self, tmp_path: Path) -> None:
        store, req_id = approved_scene(tmp_path, two_task_plan())
        first_artifact = artifact("first", "a")
        clock = FakeClock()
        first_run = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED, first_artifact)),
                "second": (0.0, TaskResult(TaskRunState.AWAITING_USER, reason="等待批准")),
            },
        )
        try:
            RequirementExecutor(store, req_id, first_run, clock=clock).advance()
        finally:
            store.close()

        # 进程重开：下游仍能读到上游已落库的产物身份。
        reopened = RequirementStore(tmp_path / "records.sqlite")
        clock = FakeClock()
        second_run = ScriptedRunner(
            clock,
            {
                "first": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("first", "different"))),
                "second": (1.0, TaskResult(TaskRunState.DELIVERED, artifact("second", "b"))),
            },
        )
        try:
            RequirementExecutor(reopened, req_id, second_run, clock=clock).advance()
            stored = reopened.task_artifact(req_id, 1, "first")
        finally:
            reopened.close()

        assert second_run.called_tasks == ["second"]
        assert second_run.calls[0].dependencies == (first_artifact,)
        assert stored == first_artifact


class TestAuthorizationGate:
    def test_unapproved_plan_is_not_executed(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        requirement = store.submit("ForgeLoop", "需求：未批准不执行")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-1",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=two_task_plan(),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        clock = FakeClock()
        runner = ScriptedRunner(clock, {})
        try:
            progress = RequirementExecutor(store, requirement.req_id, runner, clock=clock).advance()
        finally:
            store.close()

        assert runner.calls == []
        assert progress.requirement_status == PLAN_PROPOSED
        assert progress.next_step.actor is ActionActor.USER
        assert "批准" in progress.next_step.action
