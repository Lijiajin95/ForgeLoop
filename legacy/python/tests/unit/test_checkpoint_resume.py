"""检查点读取、可续跑判定与幂等续跑的行为测试。

覆盖本任务验收的核心行为：

- 只读读取记录根下 ``checkpoints.sqlite`` 的 LangGraph 检查点：给出待执行节点与
  ``halted_reason``；缺库、空库、无记录时如实返回 ``None``，读取不产生写副作用；
- ``next`` 非空且全部落在可续跑业务节点（``dev``/``review``/``test``）且无中止原因
  时判为可续跑；决策门、终态、``halted_reason`` 与未核对 ``started`` 动作保持等待
  人工决定；
- 推进器据此把 ``TaskExecution.resume`` 置真交给执行器，续跑至终态；
- 重复推进按 ``actions.action_id`` 去重、不重复计入执行工时；动作记录缺失时在
  原因里输出 ``unknown``，既不估算也不补零。
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

from forgeloop.domain.status import ActionActor
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.requirements import (
    EXECUTING,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
    TaskRunState,
    _keeps_waiting,
    _waiting_reason,
)
from forgeloop.records.checkpoints import (
    UNKNOWN,
    AdvanceFingerprint,
    CheckpointState,
    ResumeDecision,
    advance_fingerprint,
    classify_checkpoint,
    completed_action_ids,
    halted_node_of,
    read_checkpoint,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)


def _write_checkpoint(
    root: Path,
    thread_id: str,
    nodes: tuple[str, ...],
    halted_reason: str = "",
    checkpoint_id: str = "cp-1",
) -> None:
    """在记录根下写一条真实 LangGraph 检查点，供只读读取与判定用例使用。"""

    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        checkpoint["id"] = checkpoint_id
        values = {f"branch:to:{node}": node for node in nodes}
        if halted_reason:
            values["halted_reason"] = halted_reason
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


def _complete_action(root: Path, task_id: str, node: str) -> str:
    """登记并完成一个真实动作，返回其 ``action_id``（幂等去重的身份）。"""

    store = RecordStore(root / "records.sqlite")
    try:
        action = store.actions.begin(task_id, node)
        store.actions.finish(action.action_id)
        return action.action_id
    finally:
        store.close()


def _checkpoint(
    nodes: tuple[str, ...],
    checkpoint_id: str = "cp-1",
    halted_reason: str = "",
    outstanding_node: str = "",
    completed: frozenset[str] | str = frozenset(),
) -> CheckpointState:
    return CheckpointState(
        task_id="task-x",
        checkpoint_id=checkpoint_id,
        next_nodes=nodes,
        halted_reason=halted_reason,
        outstanding_node=outstanding_node,
        completed_actions=completed,
    )


class TestReadCheckpoint:
    def test_missing_database_returns_none(self, tmp_path: Path) -> None:
        assert read_checkpoint(tmp_path, "task-x") is None

    def test_empty_database_is_not_enlarged_by_reading(self, tmp_path: Path) -> None:
        path = tmp_path / "checkpoints.sqlite"
        path.write_bytes(b"")

        assert read_checkpoint(tmp_path, "task-x") is None
        # 只读读取不得触发 SqliteSaver.setup 的建表写入。
        assert path.stat().st_size == 0

    def test_unknown_thread_returns_none(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "other-thread", ("dev",))

        assert read_checkpoint(tmp_path, "task-x") is None

    def test_reads_pending_nodes_and_halted_reason(self, tmp_path: Path) -> None:
        _write_checkpoint(
            tmp_path, "task-x", ("review", "dev"), halted_reason="boom", checkpoint_id="cp-9"
        )

        state = read_checkpoint(tmp_path, "task-x")

        assert state is not None
        assert state.task_id == "task-x"
        assert state.checkpoint_id == "cp-9"
        assert state.next_nodes == ("dev", "review")  # 待执行节点集合，与顺序无关
        assert state.halted_reason == "boom"

    def test_records_outstanding_started_action(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "task-x", ("dev",))
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.begin("task-x", "review")
        finally:
            store.close()

        state = read_checkpoint(tmp_path, "task-x")

        assert state is not None
        assert state.outstanding_node == "review"

    def test_missing_action_records_report_unknown(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "task-x", ("dev",))

        state = read_checkpoint(tmp_path, "task-x")

        assert state is not None
        assert state.completed_actions is UNKNOWN
        assert state.outstanding_node == ""

    def test_completed_actions_are_read_by_action_id(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "task-x", ("dev",))
        first = _complete_action(tmp_path, "task-x", "dev")
        second = _complete_action(tmp_path, "task-x", "review")

        state = read_checkpoint(tmp_path, "task-x")

        assert state is not None
        assert state.completed_actions == frozenset({first, second})

    def test_action_sequence_started_then_completed_changes_fingerprint(
        self, tmp_path: Path
    ) -> None:
        """未完成动作改成已完成，是检查点身份之外的真实进展。"""

        _write_checkpoint(tmp_path, "task-x", ("test",))
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            action = store.actions.begin("task-x", "test")
            started = read_checkpoint(tmp_path, "task-x")
        finally:
            store.close()

        assert started is not None
        assert started.outstanding_node == "test"
        assert started.completed_actions == frozenset()
        before = advance_fingerprint(started)

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.finish(action.action_id)
        finally:
            store.close()
        completed = read_checkpoint(tmp_path, "task-x")

        assert completed is not None
        assert completed.outstanding_node == ""
        assert action.action_id in completed.completed_actions
        assert before.same_as(advance_fingerprint(completed)) is False

    def test_reads_halted_reason_from_checkpoint(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "task-x", (), halted_reason="pi_unsettled")

        state = read_checkpoint(tmp_path, "task-x")

        assert state is not None
        assert state.halted_reason == "pi_unsettled"
        assert state.next_nodes == ()

    def test_completed_action_ids_unknown_without_records(self, tmp_path: Path) -> None:
        assert completed_action_ids(tmp_path, "task-x") is UNKNOWN


class TestClassifyCheckpoint:
    def test_no_checkpoint_is_fresh(self) -> None:
        assert classify_checkpoint(None) is ResumeDecision.FRESH

    def test_business_nodes_are_resumable(self) -> None:
        for node in ("dev", "review", "test"):
            assert classify_checkpoint(_checkpoint((node,))) is ResumeDecision.RESUME, node

    def test_halted_reason_wins_over_business_node(self) -> None:
        state = _checkpoint(("dev",), halted_reason="pi_unsettled")

        assert classify_checkpoint(state) is ResumeDecision.HALTED

    def test_unchecked_action_keeps_waiting(self) -> None:
        state = _checkpoint(("dev",), outstanding_node="dev")

        assert classify_checkpoint(state) is ResumeDecision.WAIT_USER

    def test_decision_gates_and_terminal_keep_waiting(self) -> None:
        for node in (
            "gate_plan_approval",
            "gate_grant",
            "gate_acceptance",
            "deliver",
        ):
            assert classify_checkpoint(_checkpoint((node,))) is ResumeDecision.WAIT_USER, node

    def test_empty_next_is_waiting(self) -> None:
        assert classify_checkpoint(_checkpoint(())) is ResumeDecision.WAIT_USER

    def test_non_business_node_is_not_resumable(self) -> None:
        assert classify_checkpoint(_checkpoint(("plan",))) is ResumeDecision.WAIT_USER


class TestKeepsWaiting:
    def test_fresh_and_resume_are_not_blocked(self) -> None:
        assert not _keeps_waiting(None, ResumeDecision.FRESH)
        assert not _keeps_waiting(_checkpoint(("dev",)), ResumeDecision.RESUME)

    def test_halted_is_blocked(self) -> None:
        assert _keeps_waiting(_checkpoint(("dev",), halted_reason="boom"), ResumeDecision.HALTED)

    def test_plan_gate_is_blocked(self) -> None:
        state = _checkpoint(("gate_plan_approval",))
        decision = classify_checkpoint(state)

        assert _keeps_waiting(state, decision)

    def test_unchecked_action_is_blocked(self) -> None:
        state = _checkpoint(("dev",), outstanding_node="dev")
        decision = classify_checkpoint(state)

        assert _keeps_waiting(state, decision)

    def test_halted_reason_is_preserved(self) -> None:
        state = _checkpoint(("dev",), halted_reason="pi_unsettled")

        reason = _waiting_reason(state, ResumeDecision.HALTED)

        assert "pi_unsettled" in reason

    def test_unchecked_action_reason_names_node(self) -> None:
        state = _checkpoint(("dev",), outstanding_node="review")

        reason = _waiting_reason(state, ResumeDecision.WAIT_USER)

        assert "review" in reason


class TestAdvanceFingerprint:
    def test_same_checkpoint_and_actions_are_equal(self) -> None:
        before = advance_fingerprint(_checkpoint(("dev",), "cp-1", completed=frozenset({"a"})))
        after = advance_fingerprint(_checkpoint(("review",), "cp-1", completed=frozenset({"a"})))

        assert before.same_as(after) is True

    def test_progress_changes_are_detected(self) -> None:
        before = advance_fingerprint(_checkpoint(("dev",), "cp-1", completed=frozenset({"a"})))
        by_checkpoint = advance_fingerprint(
            _checkpoint(("review",), "cp-2", completed=frozenset({"a"}))
        )
        by_action = advance_fingerprint(
            _checkpoint(("review",), "cp-1", completed=frozenset({"a", "b"}))
        )

        assert before.same_as(by_checkpoint) is False
        assert before.same_as(by_action) is False

    def test_unknown_actions_cannot_be_compared(self) -> None:
        unknown = AdvanceFingerprint("cp-1", UNKNOWN)
        known = AdvanceFingerprint("cp-1", ("a",))

        assert unknown.same_as(known) is UNKNOWN


class FakeClock:
    """可推进的单调时钟：只在替身执行器「实际工作」时前进。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


class SequenceReader:
    """按调用顺序返回检查点；超出后重复最后一项，模拟推进前后的状态变化。"""

    def __init__(self, states: list[CheckpointState | None]) -> None:
        self._states = states
        self.calls = 0

    def __call__(self, task_id: str) -> CheckpointState | None:
        index = min(self.calls, len(self._states) - 1)
        self.calls += 1
        return self._states[index]


class RecordingRunner:
    """记录每次执行请求；执行期间推进假时钟模拟真实耗时。"""

    def __init__(self, clock: FakeClock, result: TaskResult, duration: float = 4.0) -> None:
        self._clock = clock
        self._result = result
        self._duration = duration
        self.calls: list[TaskExecution] = []

    def __call__(self, execution: TaskExecution) -> TaskResult:
        self.calls.append(execution)
        self._clock.tick(self._duration)
        return self._result


def _planned(task_id: str = "first") -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/forgeloop/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=("uv", "run", "pytest", "-q"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved(tmp_path: Path) -> tuple[RequirementStore, str]:
    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：检查点续跑")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=(_planned(),),
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, 1, "owner", source="batch-resume")
    return store, requirement.req_id


def _artifact(task_id: str) -> TaskArtifact:
    return TaskArtifact(
        task_id=task_id,
        candidate_sha256="a" * 64,
        test_evidence_sha256="b" * 64,
        review_sha256="c" * 64,
        acceptance="accepted",
        authorization_source="plan-approval:first:v1:owner",
    )


class TestRequirementResume:
    def test_resumable_checkpoint_resumes_to_terminal(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.DELIVERED, _artifact("first")))
        reader = SequenceReader(
            [
                _checkpoint(("review",), "cp-1"),
                _checkpoint(("test",), "cp-2"),
            ]
        )

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        assert progress.completed_tasks == ("first",)
        assert progress.consumed_seconds == 4.0

    def test_repeated_advance_does_not_double_count(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待验收"))
        reader = SequenceReader(
            [
                _checkpoint(("review",), "cp-1"),
                _checkpoint(("test",), "cp-2"),
                _checkpoint(("test",), "cp-2"),
                _checkpoint(("test",), "cp-2"),
            ]
        )
        executor = RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader)
        first = executor.advance()
        second = executor.advance()
        store.close()

        assert len(runner.calls) == 2
        assert all(call.resume for call in runner.calls)
        assert first.consumed_seconds == 4.0
        assert second.consumed_seconds == 4.0

    def test_action_identity_dedup_avoids_recharging(self, tmp_path: Path) -> None:
        """同一检查点身份下，只有新增 ``action_id`` 才计入工时；旧身份不重复计。"""

        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待验收"))
        reader = SequenceReader(
            [
                _checkpoint(("dev",), "cp-1", completed=frozenset({"a1"})),
                _checkpoint(("dev",), "cp-1", completed=frozenset({"a1", "a2"})),
                _checkpoint(("dev",), "cp-1", completed=frozenset({"a1", "a2"})),
                _checkpoint(("dev",), "cp-1", completed=frozenset({"a1", "a2"})),
            ]
        )
        executor = RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader)
        first = executor.advance()
        second = executor.advance()
        store.close()

        assert first.consumed_seconds == 4.0  # 新增 a2：本轮真的产生了新动作
        assert second.consumed_seconds == 4.0  # 重复推进无新动作：不重复计入

    def test_decision_gate_does_not_resume(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待追加授权")
        )
        reader = SequenceReader([_checkpoint(("gate_grant",), "cp-1")])

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is False
        assert progress.consumed_seconds == 0.0
        assert progress.requirement_status == EXECUTING

    def test_terminal_node_does_not_resume(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待交付"))
        reader = SequenceReader([_checkpoint(("deliver",), "cp-1")])

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is False
        assert progress.consumed_seconds == 0.0

    def test_plan_gate_is_not_auto_approved(self, tmp_path: Path) -> None:
        """停在计划批准门时不交给真实执行器，避免派生批准被自动放行。"""

        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待派生批准")
        )
        reader = SequenceReader([_checkpoint(("gate_plan_approval",), "cp-1")])

        RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader).advance()
        run = store.task_run(req_id, 1, "first")
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "gate_plan_approval" in run.reason

    def test_halted_checkpoint_keeps_waiting_without_running(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.DELIVERED, _artifact("first")))
        reader = SequenceReader([_checkpoint(("dev",), "cp-1", halted_reason="pi_unsettled")])

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        run = store.task_run(req_id, 1, "first")
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "pi_unsettled" in run.reason
        assert run.executed_seconds == 0.0
        assert progress.current_task == "first"

    def test_unchecked_action_keeps_waiting_without_running(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.DELIVERED, _artifact("first")))
        reader = SequenceReader([_checkpoint(("dev",), "cp-1", outstanding_node="dev")])

        RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader).advance()
        run = store.task_run(req_id, 1, "first")
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "dev" in run.reason

    def test_missing_action_records_output_unknown(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待验收"))
        reader = SequenceReader(
            [
                _checkpoint(("dev",), "cp-1", completed=UNKNOWN),
                _checkpoint(("dev",), "cp-1", completed=UNKNOWN),
            ]
        )

        RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader).advance()
        run = store.task_run(req_id, 1, "first")
        store.close()

        assert run is not None
        assert "unknown" in run.reason
        assert run.executed_seconds == 0.0


def test_advance_fingerprint_unknown_roundtrip() -> None:
    """记录缺失时指纹比较输出 ``unknown``，不猜测为「有进展」或「无进展」。"""

    assert advance_fingerprint(None).same_as(advance_fingerprint(None)) is True
    assert (
        advance_fingerprint(_checkpoint(("dev",), completed=UNKNOWN)).same_as(
            advance_fingerprint(_checkpoint(("dev",), completed=UNKNOWN))
        )
        is UNKNOWN
    )


class TestParkedTestResume:
    """真实故障现场：停在 ``test`` 节点、状态词仍为 ``testing`` 且无 halted 原因。

    判定不看可能滞后的状态词，只看检查点 ``next`` 与动作记录；停在可续跑业务节点
    即就地续跑，到达终态或验收门，而不是被当成「等待人工决定」。
    """

    def test_status_testing_at_test_node_resumes_to_delivery(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        # 记录里的状态词滞后：进程在 test 节点被中断，真相在检查点 next=('test',)。
        store.record_task_run(req_id, 1, "first", "testing", reason="进程在测试节点被中断")
        clock = FakeClock()
        runner = RecordingRunner(clock, TaskResult(TaskRunState.DELIVERED, _artifact("first")))
        reader = SequenceReader(
            [
                _checkpoint(("test",), "cp-1"),
                _checkpoint(("deliver",), "cp-2"),
            ]
        )

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        assert progress.completed_tasks == ("first",)
        assert progress.all_tasks_delivered is True
        assert progress.consumed_seconds == 4.0

    def test_status_testing_at_test_node_stops_at_acceptance_gate(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        store.record_task_run(req_id, 1, "first", "testing", reason="进程在测试节点被中断")
        clock = FakeClock()
        runner = RecordingRunner(
            clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待决定: gate_acceptance")
        )
        reader = SequenceReader(
            [
                _checkpoint(("test",), "cp-1"),
                _checkpoint(("gate_acceptance",), "cp-2"),
            ]
        )

        progress = RequirementExecutor(
            store, req_id, runner, clock=clock, checkpoints=reader
        ).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        assert progress.blocked_reason == "等待决定: gate_acceptance"
        assert progress.current_task == "first"


class TestNoProgressReport:
    """检查点身份与已完成动作身份都不变时：不重复计工时，报告阻塞与建议动作。"""

    def test_two_no_change_advances_report_blocking_and_suggested_action(
        self, tmp_path: Path
    ) -> None:
        store, req_id = _approved(tmp_path)
        clock = FakeClock()
        runner = RecordingRunner(
            clock, TaskResult(TaskRunState.AWAITING_USER, reason="等待决定: gate_acceptance")
        )
        # checkpoint_id 与已完成动作集合在推进前后完全一致：判定为无进展。
        reader = SequenceReader([_checkpoint(("test",), "cp-1", completed=frozenset({"a1"}))])
        executor = RequirementExecutor(store, req_id, runner, clock=clock, checkpoints=reader)

        first = executor.advance()
        second = executor.advance()
        store.close()

        # 每轮都真的把任务交给执行器续跑，但没有新检查点 / 新动作，工时不计。
        assert len(runner.calls) == 2
        assert all(call.resume for call in runner.calls)
        assert first.consumed_seconds == 0.0
        assert second.consumed_seconds == 0.0
        # 无进展时不静默等待：报告给出阻塞原因与建议动作。
        assert "等待决定: gate_acceptance" in second.blocked_reason
        assert second.next_step.actor is ActionActor.USER
        assert second.next_step.action


class TestHaltedNodeAttribution:
    """中断原因 → 可续跑节点的归因：新前缀与旧检查点的历史前缀都识别。"""

    def test_agent_prefixes_map_to_nodes(self) -> None:
        assert halted_node_of("agent_dev_unsettled:process-exited") == "dev"
        assert halted_node_of("agent_review_unsettled:model_error:x") == "review"

    def test_legacy_pi_prefixes_still_map(self) -> None:
        # 旧检查点里写的是 pi_*：不追溯改写旧记录，续跑仍要能找到重入点。
        assert halted_node_of("pi_dev_unsettled:timeout") == "dev"
        assert halted_node_of("pi_review_unsettled:aborted") == "review"

    def test_unattributable_reason_returns_empty(self) -> None:
        assert halted_node_of("plan_missing") == ""
