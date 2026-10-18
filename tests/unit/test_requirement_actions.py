"""人工核对并释放未完成动作的行为测试。

覆盖本任务验收的核心行为：

- 只有在动作身份明确、动作存在且属于目标任务、动作仍是 ``started`` 未完成状态、
  调用方标识与理由都非空时才允许释放；缺理由、身份不明、任务不匹配或动作已完成
  时 fail-closed 拒绝，且不留下审计记录；
- 释放把动作身份、所属任务/节点、调用方、时间与理由持久化为可回查的审计记录；
  重复释放同一动作是幂等回查，不重复写审计行；
- 已释放动作不再计入「未完成动作」，``action_unchecked`` 中断原因随之与未完成动作
  判定解耦：带人工理由释放后推进不再因该动作阻塞，可按检查点续跑或从被释放动作
  所在业务节点就地重入；
- 未释放、缺理由、身份不明或任务不匹配时，推进仍保持等待人工核对。
"""

import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import RequirementTaskRunner, build_graph
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.requirements import (
    RequirementExecutor,
    TaskExecution,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.checkpoints import (
    ActionRelease,
    ResumeDecision,
    _ActionReleaseConflict,
    _record_action_release,
    action_releases,
    classify_checkpoint,
    outstanding_action_node,
    outstanding_actions,
    read_checkpoint,
    release_action,
    release_outstanding_action,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
REQ_VERSION = 3
TASK = "first"
BY = "owner"
REASON = "人工核对现场后确认该动作没有产生有效结果，释放以继续推进"
CHECKPOINT_ID = "cp-1"


def _thread(req_id: str, task_id: str = TASK, plan_version: int = REQ_VERSION) -> str:
    """需求内任务映射到单任务图的稳定线程身份（与 builder 同一约定）。"""

    return f"task-{req_id}-v{plan_version}-{task_id}"


def _write_checkpoint(
    root: Path,
    thread_id: str,
    *,
    nodes: tuple[str, ...] = (),
    halted_reason: str = "",
    checkpoint_id: str = CHECKPOINT_ID,
    plan_version: int | None = REQ_VERSION,
    recorded_task_id: str | None = None,
) -> None:
    """在记录根下写一条真实 LangGraph 检查点。"""

    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        checkpoint["id"] = checkpoint_id
        values: dict[str, object] = {f"branch:to:{node}": node for node in nodes}
        if halted_reason:
            values["halted_reason"] = halted_reason
        values["task_id"] = recorded_task_id if recorded_task_id is not None else thread_id
        if plan_version is not None:
            values["plan_version"] = plan_version
        checkpoint["channel_values"] = values
        config = cast(
            RunnableConfig,
            {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": "",
                    "checkpoint_id": checkpoint_id,
                }
            },
        )
        saver.put(
            config,
            checkpoint,
            cast(CheckpointMetadata, {"source": "loop", "step": 0, "parents": {}}),
            {},
        )
        conn.commit()
    finally:
        conn.close()


def _start_action(root: Path, task_id: str, node: str) -> str:
    """登记一个未完成（``started``）的真实动作，返回其 ``action_id``。"""

    store = RecordStore(root / "records.sqlite")
    try:
        return store.actions.begin(task_id, node).action_id
    finally:
        store.close()


def _complete_action(root: Path, task_id: str, node: str) -> str:
    """登记并完成一个真实动作，返回其 ``action_id``。"""

    store = RecordStore(root / "records.sqlite")
    try:
        action = store.actions.begin(task_id, node)
        store.actions.finish(action.action_id)
        return action.action_id
    finally:
        store.close()


def _planned(
    test_command: tuple[str, ...] = ("uv", "run", "pytest", "-q"),
) -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        test_command=test_command,
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved(root: Path, task: PlannedTask | None = None) -> tuple[RequirementStore, str]:
    """建立已批准的单任务需求（需求任务包版本非 1）。"""

    store = RequirementStore(root / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：人工核对并释放未完成动作")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-{REQ_VERSION}",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=REQ_VERSION,
        requirement_version=requirement.version_count,
        tasks=(task or _planned(),),
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, REQ_VERSION, "owner", source="batch-release")
    return store, requirement.req_id


def _artifact() -> TaskArtifact:
    return TaskArtifact(
        task_id=TASK,
        candidate_sha256="a" * 64,
        test_evidence_sha256="b" * 64,
        review_sha256="c" * 64,
        acceptance="accepted",
        authorization_source="plan-approval:first:v3:owner",
    )


class FakeClock:
    """可推进的单调时钟：只在替身执行器「实际工作」时前进。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


class RecordingRunner:
    def __init__(
        self,
        records_root: Path,
        req_id: str,
        clock: FakeClock,
        result: TaskResult,
        duration: float = 4.0,
    ) -> None:
        # 暴露与真实执行器一致的记录根/需求身份/任务包版本，让推进器走生产默认的
        # 只读检查点读取接缝（含释放审计的叠加）。
        self.records_root = records_root
        self.req_id = req_id
        self.plan_version = REQ_VERSION
        self._clock = clock
        self._result = result
        self._duration = duration
        self.calls: list[TaskExecution] = []

    def __call__(self, execution: TaskExecution) -> TaskResult:
        self.calls.append(execution)
        self._clock.tick(self._duration)
        return self._result


class TestActionReleaseRecords:
    def test_release_started_action_persists_audit_record(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path,
            task_id=TASK,
            action_id=action_id,
            by=BY,
            reason=REASON,
            at=WHEN,
        )

        assert authorization.allowed is True
        assert authorization.check.reasons == ()
        assert authorization.release is not None
        assert authorization.release.action_id == action_id
        assert authorization.release.task_id == TASK
        assert authorization.release.node == "dev"
        assert authorization.release.released_by == BY
        assert authorization.release.reason == REASON
        assert authorization.release.released_at == WHEN
        records = action_releases(tmp_path, TASK)
        assert len(records) == 1
        assert records[0] == authorization.release
        assert action_releases(tmp_path, TASK, action_id=action_id) == records

    def test_missing_reason_is_rejected_without_audit(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by=BY, reason="   ", at=WHEN
        )

        assert authorization.allowed is False
        assert "理由" in authorization.check.reason
        assert authorization.release is None
        assert action_releases(tmp_path, TASK) == ()

    def test_missing_caller_is_rejected_without_audit(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by="  ", reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "--by" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()

    def test_unknown_action_identity_is_rejected(self, tmp_path: Path) -> None:
        authorization = release_action(
            tmp_path,
            task_id=TASK,
            action_id="does-not-exist",
            by=BY,
            reason=REASON,
            at=WHEN,
        )

        assert authorization.allowed is False
        assert "身份不明" in authorization.check.reason
        assert authorization.release is None
        assert action_releases(tmp_path, TASK) == ()

    def test_task_mismatch_is_rejected(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path,
            task_id="other-task",
            action_id=action_id,
            by=BY,
            reason=REASON,
            at=WHEN,
        )

        assert authorization.allowed is False
        assert "不属于" in authorization.check.reason or "不匹配" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()
        assert outstanding_action_node(tmp_path, TASK) == "dev"

    def test_completed_action_cannot_be_released(self, tmp_path: Path) -> None:
        action_id = _complete_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by=BY, reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "completed" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()

    def test_repeated_release_is_idempotent(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")
        first = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by=BY, reason=REASON, at=WHEN
        )
        second = release_action(
            tmp_path,
            task_id=TASK,
            action_id=action_id,
            by=BY,
            reason=REASON,
            at=datetime(2026, 10, 17, 11, 0, tzinfo=UTC),
        )

        assert first.allowed is True
        assert second.allowed is True
        assert second.release == first.release
        assert len(action_releases(tmp_path, TASK)) == 1

    def test_released_action_is_not_reported_as_outstanding(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")
        assert outstanding_action_node(tmp_path, TASK) == "dev"

        release_action(tmp_path, task_id=TASK, action_id=action_id, by=BY, reason=REASON, at=WHEN)

        assert outstanding_action_node(tmp_path, TASK) == ""

    def test_release_outstanding_action_locates_action_identity(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_outstanding_action(
            tmp_path, task_id=TASK, by=BY, reason=REASON, at=WHEN
        )

        assert authorization.allowed is True
        assert authorization.release is not None
        assert authorization.release.action_id == action_id
        assert outstanding_action_node(tmp_path, TASK) == ""

    def test_release_outstanding_action_without_action_is_rejected(self, tmp_path: Path) -> None:
        authorization = release_outstanding_action(
            tmp_path, task_id=TASK, by=BY, reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "身份" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()

    def test_reading_releases_never_creates_the_audit_table(self, tmp_path: Path) -> None:
        assert action_releases(tmp_path, TASK) == ()
        assert action_releases(tmp_path / "missing", TASK) == ()
        database = tmp_path / "records.sqlite"
        if database.exists():
            conn = sqlite3.connect(database)
            try:
                names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
            finally:
                conn.close()
            assert "action_releases" not in names


class TestCheckpointActionRelease:
    def test_released_action_clears_action_unchecked_halt(self, tmp_path: Path) -> None:
        thread = "task-req-v3-first"
        _write_checkpoint(
            tmp_path,
            thread,
            nodes=("dev",),
            halted_reason="action_unchecked:dev",
            recorded_task_id=thread,
        )
        action_id = _start_action(tmp_path, thread, "dev")
        blocked = read_checkpoint(tmp_path, thread)
        assert blocked is not None
        assert blocked.outstanding_node == "dev"
        # 未释放时 halted_reason 仍是最高优先级的等待依据（禁止盲目重放）。
        assert classify_checkpoint(blocked) is ResumeDecision.HALTED

        release_action(tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN)
        released = read_checkpoint(tmp_path, thread)

        assert released is not None
        assert released.outstanding_node == ""
        assert released.halted_reason == ""
        assert released.resumed_from_halt is True
        assert released.halted_node == "dev"
        assert classify_checkpoint(released) is ResumeDecision.RESUME

    def test_released_action_on_empty_checkpoint_is_attributable_resume(
        self, tmp_path: Path
    ) -> None:
        thread = "task-req-v3-first"
        _write_checkpoint(
            tmp_path,
            thread,
            nodes=(),
            halted_reason="action_unchecked:review",
            recorded_task_id=thread,
        )
        action_id = _start_action(tmp_path, thread, "review")

        release_action(tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN)
        released = read_checkpoint(tmp_path, thread)

        assert released is not None
        assert released.outstanding_node == ""
        assert released.halted_reason == ""
        assert released.resumed_from_halt is True
        assert released.halted_node == "review"
        # 空 next 的中断现场由 halted_node 归因为可重入业务节点，而非当作全新任务。
        assert classify_checkpoint(released) is ResumeDecision.WAIT_USER

    def test_release_does_not_clear_other_halted_reasons(self, tmp_path: Path) -> None:
        thread = "task-req-v3-first"
        _write_checkpoint(
            tmp_path,
            thread,
            nodes=(),
            halted_reason="pi_dev_unsettled:process-exited",
            recorded_task_id=thread,
        )
        action_id = _start_action(tmp_path, thread, "dev")

        release_action(tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN)
        state = read_checkpoint(tmp_path, thread)

        assert state is not None
        assert state.outstanding_node == ""
        assert state.halted_reason == "pi_dev_unsettled:process-exited"
        assert classify_checkpoint(state) is ResumeDecision.HALTED


class TestAdvanceAfterRelease:
    def _blocked_setup(
        self, root: Path, *, nodes: tuple[str, ...] = ()
    ) -> tuple[RequirementStore, str, str, str]:
        store, req_id = _approved(root)
        thread = _thread(req_id)
        _write_checkpoint(
            root,
            thread,
            nodes=nodes,
            halted_reason="action_unchecked:dev",
            recorded_task_id=thread,
        )
        action_id = _start_action(root, thread, "dev")
        return store, req_id, thread, action_id

    def test_released_action_no_longer_blocks_advance(self, tmp_path: Path) -> None:
        store, req_id, thread, action_id = self._blocked_setup(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            tmp_path, req_id, clock, TaskResult(TaskRunState.DELIVERED, _artifact())
        )
        executor = RequirementExecutor(store, req_id, runner, clock=clock)

        blocked = executor.advance()
        blocked_run = store.task_run(req_id, REQ_VERSION, TASK)
        assert runner.calls == []
        assert blocked_run is not None
        assert blocked_run.state == TaskRunState.AWAITING_USER.value
        assert "未完成动作" in blocked_run.reason
        assert blocked.current_task == TASK

        authorization = release_action(
            tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN
        )
        assert authorization.allowed is True
        progress = executor.advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        # 真实中断现场 next 为空：按被释放动作所在节点就地重入，不重放更早节点。
        assert runner.calls[0].resume_node == "dev"
        assert progress.completed_tasks == (TASK,)
        assert progress.all_tasks_delivered is True

    def test_released_action_with_parked_next_resumes_from_checkpoint(self, tmp_path: Path) -> None:
        store, req_id, thread, action_id = self._blocked_setup(tmp_path, nodes=("dev",))
        clock = FakeClock()
        runner = RecordingRunner(
            tmp_path, req_id, clock, TaskResult(TaskRunState.DELIVERED, _artifact())
        )
        executor = RequirementExecutor(store, req_id, runner, clock=clock)

        release_action(tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN)
        executor.advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        assert runner.calls[0].resume_node == ""

    def test_missing_reason_keeps_advance_blocked(self, tmp_path: Path) -> None:
        store, req_id, thread, action_id = self._blocked_setup(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            tmp_path, req_id, clock, TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        authorization = release_action(
            tmp_path, task_id=thread, action_id=action_id, by=BY, reason="", at=WHEN
        )
        assert authorization.allowed is False
        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        run = store.task_run(req_id, REQ_VERSION, TASK)
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert progress.current_task == TASK

    def test_unknown_action_identity_keeps_advance_blocked(self, tmp_path: Path) -> None:
        store, req_id, _thread_id, _action_id = self._blocked_setup(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            tmp_path, req_id, clock, TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        authorization = release_action(
            tmp_path,
            task_id=_thread_id,
            action_id="unknown-action",
            by=BY,
            reason=REASON,
            at=WHEN,
        )
        assert authorization.allowed is False
        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []

    def test_task_mismatch_keeps_advance_blocked(self, tmp_path: Path) -> None:
        store, req_id, thread, action_id = self._blocked_setup(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            tmp_path, req_id, clock, TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        authorization = release_action(
            tmp_path,
            task_id="other-task",
            action_id=action_id,
            by=BY,
            reason=REASON,
            at=WHEN,
        )
        assert authorization.allowed is False
        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []
        assert outstanding_action_node(tmp_path, thread) == "dev"


FAKE_PI_COMMAND = [
    sys.executable,
    str(Path(__file__).resolve().parents[1] / "fixtures" / "fake_pi.py"),
]
# 真实图集成用例使用立即成功的真实子进程测试命令：本用例验证的是 B03 闸门，
# 不让仓库自身的正式测试命令在克隆副本里执行。
REAL_TEST_COMMAND = (sys.executable, "-c", "print('ok')")


def _real_runner(root: Path, req_id: str) -> RequirementTaskRunner:
    """真实单任务业务图执行器：假 PI 子进程，但图、检查点与动作记录都真实。"""

    return RequirementTaskRunner(
        records_root=root,
        req_id=req_id,
        plan_version=REQ_VERSION,
        project="ForgeLoop",
        pi_command=tuple(FAKE_PI_COMMAND),
        pi_timeout_seconds=120.0,
    )


def _halt_action_unchecked(root: Path, monkeypatch) -> tuple[RequirementStore, str, str, str]:
    """用真实业务图建立 ``action_unchecked:dev`` 的真实中断现场。

    先走完方案批准门，恢复前登记一个 ``started`` 动作：恢复后 ``dev`` 的 B03 闸门
    因该未完成动作落下 ``halted_reason=action_unchecked:dev``，图路由到 END、
    ``next`` 为空，正是生产中被强杀留下的现场。返回需求库、需求身份、线程身份与
    未完成动作身份。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "ok")
    store, req_id = _approved(root, _planned(REAL_TEST_COMMAND))
    runner = _real_runner(root, req_id)
    thread = _thread(req_id)
    task = _planned(REAL_TEST_COMMAND)
    record_store = RecordStore(root / "records.sqlite")
    graph = None
    action_id = ""
    try:
        record_store.create_task(
            thread, "ForgeLoop", task.goal, runner._config(task), task.limits.limit_seconds
        )
        context = NodeContext.for_task(record_store, root, thread)
        graph = build_graph(context, root / "checkpoints.sqlite")
        config = cast(RunnableConfig, {"configurable": {"thread_id": thread}})
        graph.invoke({"task_id": thread}, config)
        runner._approve_plan(record_store, thread)
        action_id = record_store.actions.begin(thread, "dev").action_id
        graph.invoke(Command(resume={"decision": "approved"}), config)
        snapshot = graph.get_state(config)
        assert snapshot.values.get("halted_reason") == "action_unchecked:dev"
        assert not set(snapshot.next)
    finally:
        if graph is not None:
            conn = getattr(graph.checkpointer, "conn", None)
            if conn is not None:
                conn.close()
        record_store.close()
    return store, req_id, thread, action_id


class TestRealGraphReleaseUnblocks:
    """真实图回归：释放后 B03 闸门不再因旧 ``started`` 动作拦下续跑。"""

    def test_released_action_lets_real_graph_resume(self, tmp_path: Path, monkeypatch) -> None:
        store, req_id, thread, action_id = _halt_action_unchecked(tmp_path, monkeypatch)
        try:
            runner = _real_runner(tmp_path, req_id)
            # 未释放时真实推进器只读取检查点，不启动图：现场与未完成动作事实不变。
            RequirementExecutor(store, req_id, runner).advance()
            assert outstanding_action_node(tmp_path, thread) == "dev"
            assert not (tmp_path / thread / "candidate.diff").exists()

            authorization = release_action(
                tmp_path, task_id=thread, action_id=action_id, by=BY, reason=REASON, at=WHEN
            )
            assert authorization.allowed is True

            # 释放把权威 ``started`` 事实结束为 ``released``：B03 闸门与 ``begin``
            # 都不再看到它，真实图得以从被释放动作所在节点就地重入。
            record_store = RecordStore(tmp_path / "records.sqlite")
            try:
                assert record_store.actions.outstanding(thread) is None
            finally:
                record_store.close()
            progress = RequirementExecutor(store, req_id, runner).advance()
            run = store.task_run(req_id, REQ_VERSION, TASK)
        finally:
            store.close()

        assert (tmp_path / thread / "candidate.diff").is_file()
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert progress.current_task == TASK
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            completed = [
                action.node
                for action in record_store.actions.history(thread)
                if action.state.value == "completed"
            ]
        finally:
            record_store.close()
        # dev 重入后继续 review/test；被释放的旧动作不算 completed。
        assert sorted(completed) == ["dev", "review", "test"]

    def test_missing_reason_keeps_real_graph_blocked(self, tmp_path: Path, monkeypatch) -> None:
        store, req_id, thread, action_id = _halt_action_unchecked(tmp_path, monkeypatch)
        try:
            rejection = release_action(
                tmp_path, task_id=thread, action_id=action_id, by=BY, reason="   ", at=WHEN
            )
            assert rejection.allowed is False
            runner = _real_runner(tmp_path, req_id)
            RequirementExecutor(store, req_id, runner).advance()
            run = store.task_run(req_id, REQ_VERSION, TASK)
        finally:
            store.close()

        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "未完成动作" in run.reason
        assert outstanding_action_node(tmp_path, thread) == "dev"


class TestOutstandingActionListingAndCli:
    """未完成动作列表与 ``requirement actions list|clear`` 正式入口。"""

    def test_outstanding_actions_lists_started_only(self, tmp_path: Path) -> None:
        _complete_action(tmp_path, TASK, "review")
        started = _start_action(tmp_path, TASK, "dev")
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.claim_slot("requirement:req-x", owner="req-x")
        finally:
            store.close()

        actions = outstanding_actions(tmp_path)
        assert [action.action_id for action in actions] == [started]
        assert [action.node for action in actions] == ["dev"]
        assert [action.action_id for action in outstanding_actions(tmp_path, TASK)] == [started]
        assert outstanding_actions(tmp_path, "other-task") == ()

        release_action(tmp_path, task_id=TASK, action_id=started, by=BY, reason=REASON, at=WHEN)
        assert outstanding_actions(tmp_path) == ()

    def test_cli_actions_list_shows_identity_and_release_hint(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        assert cli_main(["requirement", "actions", "list", "--records-root", str(tmp_path)]) == 0

        output = capsys.readouterr().out
        assert action_id in output
        assert TASK in output
        assert "dev" in output
        assert "actions clear" in output

    def test_cli_actions_clear_releases_and_records_audit(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        assert (
            cli_main(
                [
                    "requirement",
                    "actions",
                    "clear",
                    "--task",
                    TASK,
                    "--by",
                    BY,
                    "--reason",
                    REASON,
                    "--records-root",
                    str(tmp_path),
                ]
            )
            == 0
        )

        output = capsys.readouterr().out
        assert action_id in output
        assert BY in output
        records = action_releases(tmp_path, TASK)
        assert len(records) == 1
        assert records[0].action_id == action_id
        assert records[0].task_id == TASK
        assert records[0].released_by == BY
        assert records[0].reason == REASON
        assert outstanding_actions(tmp_path) == ()

    def test_cli_actions_clear_with_explicit_action(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        assert (
            cli_main(
                [
                    "requirement",
                    "actions",
                    "clear",
                    "--task",
                    TASK,
                    "--action",
                    action_id,
                    "--by",
                    BY,
                    "--reason",
                    REASON,
                    "--records-root",
                    str(tmp_path),
                ]
            )
            == 0
        )

        capsys.readouterr()
        assert action_releases(tmp_path, TASK)[0].action_id == action_id

    def test_cli_actions_clear_missing_reason_is_rejected(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        _start_action(tmp_path, TASK, "dev")

        assert (
            cli_main(
                [
                    "requirement",
                    "actions",
                    "clear",
                    "--task",
                    TASK,
                    "--by",
                    BY,
                    "--reason",
                    "  ",
                    "--records-root",
                    str(tmp_path),
                ]
            )
            == 1
        )

        error = capsys.readouterr().err
        assert "理由" in error
        assert action_releases(tmp_path, TASK) == ()
        assert outstanding_action_node(tmp_path, TASK) == "dev"


class TestActionReleaseRejections:
    """人工释放前置校验的各条 fail-closed 拒绝路径。"""

    def test_empty_task_identity_is_rejected(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id="  ", action_id=action_id, by=BY, reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "任务身份" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()
        assert outstanding_action_node(tmp_path, TASK) == "dev"

    def test_overlong_caller_is_rejected(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by="x" * 65, reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "长度" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()

    def test_non_printable_caller_is_rejected(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by="own\x00er", reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "可打印" in authorization.check.reason
        assert action_releases(tmp_path, TASK) == ()


class TestActionReleaseRecordConflicts:
    """写入事务内二次复核的冲突路径必须拒绝，不写半截状态。"""

    def _release(self, action_id: str, *, task_id: str = TASK, node: str = "dev") -> ActionRelease:
        return ActionRelease(
            action_id=action_id,
            task_id=task_id,
            node=node,
            released_by=BY,
            reason=REASON,
            released_at=WHEN,
        )

    def test_unknown_action_identity_conflicts(self, tmp_path: Path) -> None:
        _start_action(tmp_path, TASK, "dev")

        with pytest.raises(_ActionReleaseConflict):
            _record_action_release(tmp_path, self._release("missing-action"))

    def test_task_mismatch_conflicts(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        with pytest.raises(_ActionReleaseConflict):
            _record_action_release(tmp_path, self._release(action_id, task_id="other-task"))

    def test_node_mismatch_conflicts(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        with pytest.raises(_ActionReleaseConflict):
            _record_action_release(tmp_path, self._release(action_id, node="review"))

    def test_completed_action_conflicts(self, tmp_path: Path) -> None:
        action_id = _complete_action(tmp_path, TASK, "dev")

        with pytest.raises(_ActionReleaseConflict):
            _record_action_release(tmp_path, self._release(action_id))

    def test_existing_audit_is_returned_idempotently(self, tmp_path: Path) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")
        release = self._release(action_id)

        first = _record_action_release(tmp_path, release)
        second = _record_action_release(tmp_path, release)

        assert first == second
        assert len(action_releases(tmp_path, TASK)) == 1

    def test_release_action_maps_conflict_to_fail_closed(self, tmp_path: Path, monkeypatch) -> None:
        action_id = _start_action(tmp_path, TASK, "dev")

        def _conflict(records_root: Path, release: ActionRelease) -> ActionRelease:
            raise _ActionReleaseConflict("并发现场已变化，禁止释放")

        monkeypatch.setattr("forgeloop.records.checkpoints._record_action_release", _conflict)

        authorization = release_action(
            tmp_path, task_id=TASK, action_id=action_id, by=BY, reason=REASON, at=WHEN
        )

        assert authorization.allowed is False
        assert "并发现场已变化" in authorization.check.reason
        assert authorization.release is None


class TestActionsListEmpty:
    def test_cli_actions_list_without_outstanding(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert cli_main(["requirement", "actions", "list", "--records-root", str(tmp_path)]) == 0
        assert "没有未完成动作" in capsys.readouterr().out
