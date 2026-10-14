"""A05 场景：多个需求并行推进、同项目交付串行。

用真实记录层（SQLite 权威记录 + 执行槽位）与注入的确定性替身执行器，验证四类
业务不变量：

- **不串记录**：不同需求可同时推进，各自的推进记录与前置产物只落在自己的
  ``req_id`` 命名空间下；
- **同需求不重复运行**：同一需求并发启动（含跨 dispatcher 实例）只有一个能拿到
  执行槽位，其余明确拒绝；
- **限制并发资源**：调度器按 ``max_concurrent`` 上限并行，不无限扩张；
- **同项目交付串行**：同项目的归并/发布通过程序互斥排队，不同项目可并行；
- **批准与工时不变量**：并行推进不改批准绑定，实际执行工时只累计一次，已交付
  任务不被重放。

真实 PI 与容器边界不在本用例覆盖：这里只验证调度层与记录层的并发正确性。
"""

import argparse
import json
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.cli.merge import cmd_merge
from forgeloop.cli.release import cmd_release
from forgeloop.cli.requirements import (
    cmd_requirement_dispatch,
    cmd_requirement_slot_clear,
    cmd_requirement_slot_list,
)
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.dispatch import (
    ProjectDeliveryBusyError,
    RequirementDispatcher,
)
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.actions import ActionStore, ExecutionSlotBusyError
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


class ActiveCounter:
    """并发进入计数：记录当前与历史最大同时在场的调用数。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.value = 0
        self.max_active = 0

    def enter(self) -> None:
        with self._lock:
            self.value += 1
            self.max_active = max(self.max_active, self.value)

    def leave(self) -> None:
        with self._lock:
            self.value -= 1


class FakeClock:
    """可推进的单调时钟；只在替身执行器「实际工作」时前进。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


def planned(task_id: str, *, limit_seconds: float = 7200.0) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/forgeloop/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=("uv", "run", "pytest", f"tests/{task_id}.py", "-q"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=limit_seconds, max_failure_rounds=3),
    )


def artifact(task_id: str, marker: str) -> TaskArtifact:
    return TaskArtifact(
        task_id=task_id,
        candidate_sha256=marker * 64,
        test_evidence_sha256=marker.upper() * 64,
        review_sha256="r" * 64,
        acceptance="accepted",
        authorization_source=f"plan-approval:{task_id}:v1:owner",
    )


def approve_requirement(tmp_path: Path, project: str, tasks: tuple[PlannedTask, ...]) -> str:
    """真实记录层：提交需求、记录任务包并取得所有者批准，返回 ``req_id``。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    try:
        requirement = store.submit(project, f"需求：{project}")
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
        store.record_plan_approval(requirement.req_id, 1, "owner", source="batch-A05")
        return requirement.req_id
    finally:
        store.close()


class TestParallelAdvanceIsolation:
    def test_two_requirements_advance_concurrently_without_mixing_records(
        self, tmp_path: Path
    ) -> None:
        req_a = approve_requirement(tmp_path, "project-a", (planned("alpha"),))
        req_b = approve_requirement(tmp_path, "project-b", (planned("beta"),))
        barrier = threading.Barrier(2, timeout=10)
        active = ActiveCounter()

        def runner(execution) -> TaskResult:
            active.enter()
            try:
                # 两个需求必须同时在执行段内，否则 barrier 超时。
                barrier.wait()
                time.sleep(0.02)
                task_id = execution.task.task_id
                return TaskResult(TaskRunState.DELIVERED, artifact(task_id, task_id[0]))
            finally:
                active.leave()

        dispatcher = RequirementDispatcher(tmp_path, max_concurrent=2)
        results = dispatcher.advance_all({req_a: runner, req_b: runner})

        assert active.max_active == 2
        assert results[req_a].completed_tasks == ("alpha",)
        assert results[req_b].completed_tasks == ("beta",)

        reopened = RequirementStore(tmp_path / "records.sqlite")
        try:
            assert [run.task_id for run in reopened.task_runs(req_a, 1)] == ["alpha"]
            assert [run.task_id for run in reopened.task_runs(req_b, 1)] == ["beta"]
            # 记录身份隔离：一条需求看不到另一条需求的任务与产物。
            assert reopened.task_run(req_a, 1, "beta") is None
            assert reopened.task_run(req_b, 1, "alpha") is None
            assert reopened.task_artifact(req_a, 1, "beta") is None
            assert reopened.task_artifact(req_b, 1, "alpha") is None
            artifact_a = reopened.task_artifact(req_a, 1, "alpha")
            artifact_b = reopened.task_artifact(req_b, 1, "beta")
            assert artifact_a is not None and artifact_a.task_id == "alpha"
            assert artifact_b is not None and artifact_b.task_id == "beta"
        finally:
            reopened.close()


class TestSameRequirementNotRepeated:
    def test_second_concurrent_start_is_rejected_across_dispatchers(self, tmp_path: Path) -> None:
        req_id = approve_requirement(tmp_path, "project-a", (planned("alpha"),))
        started = threading.Event()
        release = threading.Event()
        results: list[object] = []
        errors: list[BaseException] = []

        def slow_runner(execution) -> TaskResult:
            started.set()
            release.wait(10)
            return TaskResult(TaskRunState.DELIVERED, artifact(execution.task.task_id, "a"))

        holder = RequirementDispatcher(tmp_path)
        contender = RequirementDispatcher(tmp_path)

        def run_holder() -> None:
            try:
                results.append(holder.advance(req_id, slow_runner))
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=run_holder)
        thread.start()
        try:
            assert started.wait(10)
            with pytest.raises(RequirementAlreadyRunningError):
                contender.advance(req_id, slow_runner)
        finally:
            release.set()
            thread.join(10)

        assert not thread.is_alive()
        assert errors == []
        assert len(results) == 1


class TestConcurrencyLimit:
    def test_max_concurrent_bounds_simultaneous_requirements(self, tmp_path: Path) -> None:
        req_ids = [
            approve_requirement(tmp_path, f"project-{index}", (planned(f"task-{index}"),))
            for index in range(3)
        ]
        active = ActiveCounter()
        release = threading.Event()
        results: dict[str, object] = {}
        errors: list[BaseException] = []

        def runner(execution) -> TaskResult:
            active.enter()
            try:
                release.wait(10)
                return TaskResult(TaskRunState.DELIVERED, artifact(execution.task.task_id, "x"))
            finally:
                active.leave()

        def run_all() -> None:
            try:
                results.update(
                    RequirementDispatcher(tmp_path, max_concurrent=2).advance_all(
                        {req_id: runner for req_id in req_ids}
                    )
                )
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=run_all)
        thread.start()
        deadline = time.monotonic() + 10
        while active.value < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        # 留出足够时间让第三个需求尝试启动；上限为 2 时它必须仍在等待。
        time.sleep(0.1)
        observed = active.max_active
        release.set()
        thread.join(10)

        assert errors == []
        assert observed == 2
        assert set(results) == set(req_ids)


class TestProjectDeliverySerialization:
    def test_same_project_delivery_is_serialized_across_dispatchers(self, tmp_path: Path) -> None:
        first = RequirementDispatcher(tmp_path)
        second = RequirementDispatcher(tmp_path, delivery_timeout=0.2)
        inside = threading.Event()
        second_inside = threading.Event()
        release = threading.Event()
        active = ActiveCounter()
        errors: list[BaseException] = []

        def hold(dispatcher: RequirementDispatcher, entered: threading.Event) -> None:
            try:
                with dispatcher.project_delivery("shared"):
                    entered.set()
                    active.enter()
                    try:
                        release.wait(10)
                    finally:
                        active.leave()
            except BaseException as error:
                errors.append(error)

        holder = threading.Thread(target=hold, args=(first, inside))
        holder.start()
        assert inside.wait(10)

        # 第二个 dispatcher（模拟另一进程）在有界等待内拿不到同项目槽位，明确失败。
        contender = threading.Thread(target=hold, args=(second, second_inside))
        contender.start()
        contender.join(10)

        assert errors and isinstance(errors[0], ProjectDeliveryBusyError)
        assert not second_inside.is_set()
        assert active.max_active == 1

        release.set()
        holder.join(10)
        assert not holder.is_alive()

    def test_different_projects_deliver_concurrently(self, tmp_path: Path) -> None:
        dispatcher = RequirementDispatcher(tmp_path)
        barrier = threading.Barrier(2, timeout=10)
        errors: list[BaseException] = []

        def deliver(project: str) -> None:
            try:
                with dispatcher.project_delivery(project):
                    # 不同项目必须能同时进入交付段，否则 barrier 超时。
                    barrier.wait()
            except BaseException as error:
                errors.append(error)

        threads = [
            threading.Thread(target=deliver, args=(project,)) for project in ("p-one", "p-two")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)

        assert errors == []


class TestExecutionSlotRecord:
    def test_slot_rejects_second_claim_until_released(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            actions: ActionStore = store.actions
            slot = actions.claim_slot("requirement:req-x", owner="req-x")
            with pytest.raises(ExecutionSlotBusyError):
                actions.claim_slot("requirement:req-x", owner="req-x")
            assert actions.slot_owner("requirement:req-x") is not None
            actions.release_slot(slot.action_id)
            assert actions.slot_owner("requirement:req-x") is None
            # 释放后可再次占用。
            actions.claim_slot("requirement:req-x", owner="req-x")
        finally:
            store.close()


class TestStaleSlotRecovery:
    """硬杀留下的槽位可查看、可清理；清理后业务图重新可达（B03 恢复路径）。"""

    def test_stale_requirement_slot_blocks_then_clear_restores_advance(
        self, tmp_path: Path, capsys
    ) -> None:
        req_id = approve_requirement(tmp_path, "project-a", (planned("alpha"),))
        # 模拟上一进程在推进中途被 SIGKILL：槽位停在 started，没有释放。
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(f"requirement:{req_id}", owner=req_id)
        finally:
            seed.close()

        dispatcher = RequirementDispatcher(tmp_path)
        calls: list[str] = []

        def runner(execution) -> TaskResult:
            calls.append(execution.task.task_id)
            return TaskResult(TaskRunState.DELIVERED, artifact(execution.task.task_id, "a"))

        with pytest.raises(RequirementAlreadyRunningError) as excinfo:
            dispatcher.advance(req_id, runner)
        # 错误必须如实说明可能只是中断残留，并指向查看/清理入口。
        assert "slot clear" in str(excinfo.value)
        assert calls == []  # 被拒绝时没有启动业务图

        listed = cmd_requirement_slot_list(argparse.Namespace(records_root=str(tmp_path)))
        assert listed == 0
        listing = capsys.readouterr().out
        assert f"requirement:{req_id}" in listing
        assert "清理" in listing

        cleared = cmd_requirement_slot_clear(
            argparse.Namespace(records_root=str(tmp_path), slot=f"requirement:{req_id}")
        )
        assert cleared == 0

        # 清理后推进恢复：业务图重新运行，不再被误拒。
        progress = dispatcher.advance(req_id, runner)
        assert calls == ["alpha"]
        assert progress.completed_tasks == ("alpha",)

    def test_clear_absent_slot_fails_loudly(self, tmp_path: Path, capsys) -> None:
        code = cmd_requirement_slot_clear(
            argparse.Namespace(records_root=str(tmp_path), slot="requirement:missing")
        )
        assert code == 1
        assert "未被占用" in capsys.readouterr().err


class TestDeliveryEntryUsesProjectSlot:
    """归并/发布真实入口获取同项目交付互斥，而不是只在测试里演示。"""

    def _task(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task(
                "task-delivery",
                "proj-x",
                "输入",
                {"project_path": str(tmp_path)},
                7200.0,
            )
        finally:
            store.close()

    def test_merge_refuses_while_project_slot_held(self, tmp_path: Path, capsys) -> None:
        self._task(tmp_path)
        holder = RequirementDispatcher(tmp_path, delivery_timeout=None)
        with holder.project_delivery("proj-x"):
            args = argparse.Namespace(
                task_id="task-delivery",
                records_root=str(tmp_path),
                message="",
                no_push=True,
                direct_push=False,
                require_checks="none",
                checks_timeout=0.0,
                delivery_timeout=0.0,
            )
            code = cmd_merge(args)
        assert code == 1
        err = capsys.readouterr().err
        assert "同项目交付" in err
        assert "project-delivery:proj-x" in err

    def test_release_refuses_while_project_slot_held(self, tmp_path: Path, capsys) -> None:
        self._task(tmp_path)
        holder = RequirementDispatcher(tmp_path, delivery_timeout=None)
        with holder.project_delivery("proj-x"):
            args = argparse.Namespace(
                task_id="task-delivery",
                tag="v0.0.1",
                records_root=str(tmp_path),
                message="",
                no_push=True,
                delivery_timeout=0.0,
            )
            code = cmd_release(args)
        assert code == 1
        err = capsys.readouterr().err
        assert "同项目交付" in err


class TestDispatchCliEntry:
    def test_dispatch_rejects_unknown_requirement(self, tmp_path: Path) -> None:
        """``requirement dispatch`` 的公共入口对未知需求明确失败，不静默启动。"""

        args = argparse.Namespace(
            records_root=str(tmp_path),
            req_ids=["req-missing"],
            pi_command=json.dumps(["pi", "--mode", "rpc"]),
            project_path="",
            baseline="",
            pi_timeout_seconds=0.0,
            max_concurrent=2,
        )
        with pytest.raises(SystemExit, match="需求不存在"):
            cmd_requirement_dispatch(args)


class TestApprovalAndBudgetInvariants:
    def test_repeated_advance_does_not_replay_or_recharge(self, tmp_path: Path) -> None:
        req_id = approve_requirement(tmp_path, "project-a", (planned("alpha"),))
        clock = FakeClock()
        calls: list[str] = []

        def runner(execution) -> TaskResult:
            calls.append(execution.task.task_id)
            clock.tick(5.0)
            return TaskResult(TaskRunState.DELIVERED, artifact(execution.task.task_id, "a"))

        dispatcher = RequirementDispatcher(tmp_path, max_concurrent=1, clock=clock)
        first = dispatcher.advance(req_id, runner)
        second = dispatcher.advance(req_id, runner)

        assert calls == ["alpha"]
        assert first.consumed_seconds == 5.0
        assert second.consumed_seconds == 5.0
        assert second.completed_tasks == ("alpha",)

        reopened = RequirementStore(tmp_path / "records.sqlite")
        try:
            assert reopened.plan_authorization(req_id).can_execute is True
            budget = reopened.requirement_budget(req_id)
            assert budget.consumed_seconds == 5.0
        finally:
            reopened.close()
