"""人工授权后就地续跑的行为测试（graph 层）。

覆盖本任务验收的核心行为：

- records 层判定可信且人工决定已记录后，推进器把 ``TaskExecution.resume`` 置真，
  并把业务节点返回 ``halted_reason`` 后真正落库的中断现场（检查点 ``next`` 为空）
  归因为可重入的业务节点（``resume_node``），交给执行器就地续跑；
- 检查点已有待执行节点（进程在节点前被中断）时同样续跑，但不需要节点提示；
- 已完成节点不重放、已交付任务不重复执行、无新进展不重复计入执行工时；
- 缺少人工决定、授权校验失败、检查点被替换、中断原因无法归因时一律拒绝续跑，
  保持等待人工核对，不把任务当可续跑交给执行器；
- 续跑成功后需求状态从 blocked 恢复推进直至整体验收；
- 真实业务图从「dev 返回 halted_reason」的中断现场续跑：只重入 dev 及其后续，
  不经过 plan/gate，不重放更早节点，检查点版本对齐需求任务包版本。

用例默认使用真实 LangGraph 检查点、真实记录库与真实人工决定记录；执行器多数为
确定性替身，只观察推进器交出了什么。``TestRealGraphResume`` 另用真实业务图与假 PI
子进程端到端验证生产入口。
"""

import sqlite3
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

from forgeloop.domain.requirement import BLOCKED as REQUIREMENT_BLOCKED
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import RequirementTaskRunner, requirement_task_id
from forgeloop.graph.requirements import (
    EXECUTING,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.checkpoints import (
    INTERRUPTED,
    authorize_retry,
    inspect_checkpoint,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 16, 10, 0, tzinfo=UTC)
# 故意不用 1：真实中断现场的检查点版本是需求任务包版本（如 v3），单任务本地版本
# 恒从 1 开始；绑定口径必须对齐需求版本，否则授权会被 fail-closed 误拒。
REQ_VERSION = 3
TASK = "first"
BY = "owner"
REASON = "人工核对后确认可续跑"
CHECKPOINT_ID = "cp-1"
HALTED_REASON = "pi_dev_unsettled:process-exited"

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]


# ---- 现场构造：真实检查点、动作记录与人工决定 ----


def _thread(req_id: str, task_id: str = TASK, plan_version: int = REQ_VERSION) -> str:
    """需求内任务映射到单任务图的稳定线程身份（与 builder 同一约定）。"""

    return f"task-{req_id}-v{plan_version}-{task_id}"


def _write_checkpoint(
    root: Path,
    thread_id: str,
    *,
    nodes: tuple[str, ...] = (),
    halted_reason: str = HALTED_REASON,
    checkpoint_id: str = CHECKPOINT_ID,
    plan_version: int | None = REQ_VERSION,
    recorded_task_id: str | None = None,
) -> None:
    """在记录根下写一条真实 LangGraph 检查点。

    缺省现场即业务节点返回 ``halted_reason`` 后路由到 END 的真实形态：``next`` 为空
    （``nodes=()``），中断原因已落库。``nodes`` 非空用于模拟进程在节点前被中断的
    「停在 next 里」现场。
    """

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


def _complete_action(root: Path, task_id: str, node: str) -> str:
    """登记并完成一个真实动作，返回其 ``action_id``（幂等去重的身份）。"""

    store = RecordStore(root / "records.sqlite")
    try:
        action = store.actions.begin(task_id, node)
        store.actions.finish(action.action_id)
        return action.action_id
    finally:
        store.close()


def _start_action(root: Path, task_id: str, node: str) -> str:
    """登记一个未完成（``started``）的真实动作，返回其 ``action_id``。"""

    store = RecordStore(root / "records.sqlite")
    try:
        return store.actions.begin(task_id, node).action_id
    finally:
        store.close()


def _authorize(
    root: Path,
    thread_id: str,
    *,
    task_id: str | None = None,
    plan_version: int = REQ_VERSION,
    task_status: str = INTERRUPTED,
    at: datetime = WHEN,
) -> bool:
    """按已记录的真实检查点记录一次人工续跑决定；返回授权是否通过。"""

    outcome = authorize_retry(
        root,
        inspection=inspect_checkpoint(root, thread_id),
        requirement_id=_requirement_of(thread_id),
        task_id=task_id if task_id is not None else thread_id,
        plan_version=plan_version,
        task_status=task_status,
        by=BY,
        reason=REASON,
        at=at,
    )
    return outcome.allowed


def _requirement_of(thread_id: str) -> str:
    """从稳定线程身份还原需求身份（``task-<req>-v<n>-<task>``）。"""

    body = thread_id[len("task-") :]
    return body.rsplit("-v", 1)[0]


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        # 不依赖外部测试替身：真实子进程立即成功。
        test_command=(sys.executable, "-c", "print('ok')"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved(root: Path) -> tuple[RequirementStore, str]:
    """建立已批准的单任务需求（需求任务包版本非 1），返回记录库与需求身份。"""

    store = RequirementStore(root / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：人工授权后就地续跑")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-{REQ_VERSION}",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=REQ_VERSION,
        requirement_version=requirement.version_count,
        tasks=(_planned(),),
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, REQ_VERSION, "owner", source="batch-retry")
    return store, requirement.req_id


def _artifact(task_id: str = TASK) -> TaskArtifact:
    return TaskArtifact(
        task_id=task_id,
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


class RunnableStub:
    """具备默认读者派生属性的可调用执行器替身。

    ``_default_reader`` 通过执行器的 ``records_root``/``req_id``/``plan_version``
    派生只读检查点接缝；本替身刻意暴露同样的属性，让未显式注入 ``checkpoints`` 的
    调用走生产默认路径。
    """

    def __init__(
        self,
        records_root: Path,
        req_id: str,
        clock: FakeClock,
        *,
        result: TaskResult,
        duration: float = 4.0,
        on_call: Callable[[TaskExecution], None] | None = None,
    ) -> None:
        self.records_root = records_root
        self.req_id = req_id
        self.plan_version = REQ_VERSION
        self._clock = clock
        self._result = result
        self._duration = duration
        self._on_call = on_call
        self.calls: list[TaskExecution] = []

    def __call__(self, execution: TaskExecution) -> TaskResult:
        self.calls.append(execution)
        self._clock.tick(self._duration)
        if self._on_call is not None:
            self._on_call(execution)
        return self._result


def _completed_nodes(root: Path, task_id: str) -> list[str]:
    store = RecordStore(root / "records.sqlite")
    try:
        return [
            action.node
            for action in store.actions.history(task_id)
            if action.state.value == "completed"
        ]
    finally:
        store.close()


class TestAuthorizedHaltResume:
    """真实中断现场（halted_reason + 空 next）在授权后重入业务节点。"""

    def test_authorized_halt_resumes_unfinished_node(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        # 真实现场：dev 返回 halted_reason 后路由到 END，检查点 next 为空。
        _write_checkpoint(tmp_path, thread)
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        # 归因到产生中断的 dev：执行器据此清空持久化 halted_reason 并重入 dev。
        assert runner.calls[0].resume_node == "dev"
        assert progress.completed_tasks == (TASK,)
        assert progress.all_tasks_delivered is True

    def test_parked_checkpoint_resumes_without_node_hint(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        # 进程在节点前被中断：检查点 next=('dev',)，没有 halted_reason。
        _write_checkpoint(tmp_path, thread, nodes=("dev",), halted_reason="")
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        # 已有 next：按检查点续跑即可，不需要重入节点提示。
        assert runner.calls[0].resume_node == ""

    def test_unfinished_node_is_the_only_one_executed(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        # 已完成 dev：只有 review 未完成，检查点因 review 中断而 next 为空。
        _complete_action(tmp_path, thread, "dev")
        _write_checkpoint(tmp_path, thread, halted_reason="pi_review_unsettled:process-exited")
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()

        def only_review(execution: TaskExecution) -> None:
            _complete_action(tmp_path, thread, "review")

        runner = RunnableStub(
            tmp_path,
            req_id,
            clock,
            result=TaskResult(TaskRunState.AWAITING_USER, reason="等待验收"),
            on_call=only_review,
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is True
        assert runner.calls[0].resume_node == "review"
        # dev 未被重放：动作历史没有第二次 dev。
        assert _completed_nodes(tmp_path, thread) == ["dev", "review"]

    def test_no_new_progress_is_not_recharged(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _complete_action(tmp_path, thread, "dev")
        _write_checkpoint(tmp_path, thread, halted_reason="pi_review_unsettled:process-exited")
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        executed = {"count": 0}

        def progress_once(execution: TaskExecution) -> None:
            # 只在本轮真的向前推进一次；第二轮没有新动作，模拟重复推进同一现场。
            if executed["count"] == 0:
                _complete_action(tmp_path, thread, "review")
            executed["count"] += 1

        runner = RunnableStub(
            tmp_path,
            req_id,
            clock,
            result=TaskResult(TaskRunState.AWAITING_USER, reason="等待验收"),
            on_call=progress_once,
        )
        executor = RequirementExecutor(store, req_id, runner, clock=clock)

        first = executor.advance()
        second = executor.advance()
        run = store.task_run(req_id, REQ_VERSION, TASK)
        store.close()

        assert first.consumed_seconds == 4.0  # 新动作 review：计入一次
        assert second.consumed_seconds == 4.0  # 无新动作：不重复累加
        assert run is not None
        assert run.executed_seconds == 4.0
        assert len(runner.calls) == 2
        assert all(call.resume for call in runner.calls)

    def test_delivered_task_is_not_re_executed(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        store.record_task_run(req_id, REQ_VERSION, TASK, TaskRunState.DELIVERED.value)
        store.record_task_artifact(req_id, REQ_VERSION, TASK, _artifact())
        _write_checkpoint(tmp_path, thread)
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []
        assert progress.all_tasks_delivered is True


class TestResumeRefusal:
    def test_missing_decision_keeps_waiting(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread)
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        run = store.task_run(req_id, REQ_VERSION, TASK)
        store.close()

        # 没有可信决定：不交给执行器，保留中断现场等待人工。
        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "pi_dev_unsettled" in run.reason
        assert progress.current_task == TASK

    def test_rejected_authorization_refuses_resume(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread)
        # 授权校验失败（plan_version 与检查点不一致）：不记录决定。
        assert _authorize(tmp_path, thread, plan_version=REQ_VERSION + 1) is False
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []

    def test_replaced_checkpoint_does_not_apply_stale_decision(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread)
        assert _authorize(tmp_path, thread) is True
        # 授权后同一线程被替换为新检查点现场：过期决定不再匹配，拒绝续跑。
        _write_checkpoint(tmp_path, thread, checkpoint_id="cp-2")
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []

    def test_unattributable_halt_refuses_resume(self, tmp_path: Path) -> None:
        """中断原因无法归因到业务节点时，即使有决定也 fail-closed 等待人工。"""

        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread, halted_reason="time_exhausted")
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        run = store.task_run(req_id, REQ_VERSION, TASK)
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert progress.current_task == TASK

    def test_decision_requires_trusted_checkpoint_identity(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread)
        assert _authorize(tmp_path, thread) is True
        # 授权后检查点被替换为缺少任务身份的现场：决定虽在，仍拒绝续跑。
        _write_checkpoint(tmp_path, thread, recorded_task_id="")
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert runner.calls == []

    def test_authorized_halt_with_outstanding_action_refuses_resume(self, tmp_path: Path) -> None:
        """未完成动作结果不明确：即使授权清除中断也不自动重放（B03 红线）。"""

        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        _write_checkpoint(tmp_path, thread, halted_reason="action_unchecked:dev")
        _start_action(tmp_path, thread, "dev")
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        run = store.task_run(req_id, REQ_VERSION, TASK)
        store.close()

        assert runner.calls == []
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "dev" in run.reason

    def test_untrusted_checkpoint_is_not_marked_resume(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        (tmp_path / "checkpoints.sqlite").write_bytes(b"this is not a sqlite database")
        # 即使有人为损坏现场留下了决定，也不能据此续跑。
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path,
            req_id,
            clock,
            result=TaskResult(TaskRunState.AWAITING_USER, reason="现场不可信"),
        )

        RequirementExecutor(store, req_id, runner, clock=clock).advance()
        store.close()

        assert len(runner.calls) == 1
        assert runner.calls[0].resume is False
        assert runner.calls[0].resume_node == ""


class TestBlockedRequirementRecovery:
    def test_authorized_resume_recovers_requirement_from_blocked(self, tmp_path: Path) -> None:
        store, req_id = _approved(tmp_path)
        thread = _thread(req_id)
        store.set_requirement_status(req_id, REQUIREMENT_BLOCKED, "任务中断，等待人工核对")
        _write_checkpoint(tmp_path, thread)
        assert _authorize(tmp_path, thread) is True
        clock = FakeClock()
        runner = RunnableStub(
            tmp_path, req_id, clock, result=TaskResult(TaskRunState.DELIVERED, _artifact())
        )

        progress = RequirementExecutor(store, req_id, runner, clock=clock).advance()
        final_status = store.requirement_status(req_id)
        store.close()

        assert runner.calls[0].resume is True
        assert runner.calls[0].resume_node == "dev"
        assert final_status == EXECUTING
        assert progress.requirement_status == EXECUTING
        assert progress.all_tasks_delivered is True


# ---- 真实业务图端到端：从 halted 现场续跑 ----


def _runner(root: Path, req_id: str, plan_version: int = REQ_VERSION) -> RequirementTaskRunner:
    return RequirementTaskRunner(
        records_root=root,
        req_id=req_id,
        plan_version=plan_version,
        project="ForgeLoop",
        pi_command=tuple(FAKE_PI_COMMAND),
        pi_timeout_seconds=120.0,
    )


def _halted_requirement(root: Path, monkeypatch) -> tuple[RequirementTaskRunner, str, str]:
    """用真实业务图把 dev 跑到返回 ``halted_reason`` 的中断现场。

    返回执行器、需求身份与单任务线程身份。检查点由真实 ``SqliteSaver`` 落库：
    ``next`` 为空、``halted_reason`` 为 ``pi_dev_unsettled``，与生产中断现场一致。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "unsettled")
    store, req_id = _approved(root)
    store.close()
    runner = _runner(root, req_id)
    task = _planned()

    result = runner(TaskExecution(task=task))
    assert result.state is TaskRunState.FAILED, result
    thread = requirement_task_id(req_id, REQ_VERSION, task.task_id)
    return runner, req_id, thread


class TestRealGraphResume:
    def test_halted_checkpoint_carries_requirement_plan_version(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """真实中断检查点的 plan_version 对齐需求任务包版本，授权校验才有意义。"""

        _runner_obj, _req_id, thread = _halted_requirement(tmp_path, monkeypatch)
        inspection = inspect_checkpoint(tmp_path, thread)

        assert inspection.state is not None
        assert inspection.state.next_nodes == ()
        assert inspection.state.halted_reason.startswith("pi_dev_unsettled")
        assert inspection.state.plan_version == REQ_VERSION
        assert inspection.state.recorded_task_id == thread
        assert inspection.state.halted_node == "dev"

    def test_authorized_resume_reenters_dev_without_replaying_plan(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        runner, req_id, thread = _halted_requirement(tmp_path, monkeypatch)
        inspection = inspect_checkpoint(tmp_path, thread)
        assert (
            authorize_retry(
                tmp_path,
                inspection=inspection,
                requirement_id=req_id,
                task_id=thread,
                plan_version=REQ_VERSION,
                task_status=INTERRUPTED,
                by=BY,
                reason=REASON,
                at=WHEN,
            ).allowed
            is True
        )
        store = RequirementStore(tmp_path / "records.sqlite")
        store.set_requirement_status(req_id, REQUIREMENT_BLOCKED, "dev 中断，等待人工核对")
        store.close()

        # 授权后现场恢复可用：dev 重跑并继续 review/test，不再依赖中断模式。
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        requirement_store = RequirementStore(tmp_path / "records.sqlite")
        try:
            progress = RequirementExecutor(requirement_store, req_id, runner).advance()
            run = requirement_store.task_run(req_id, REQ_VERSION, TASK)
            final_status = requirement_store.requirement_status(req_id)
        finally:
            requirement_store.close()

        # dev 重入一次（原中断 + 续跑），随后 review/test 正常；plan 未重放。
        assert _completed_nodes(tmp_path, thread) == ["dev", "dev", "review", "test"]
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            plan = record_store.latest_plan(thread)
        finally:
            record_store.close()
        assert plan is not None
        assert plan.version == 1  # 未从 START 重放 plan（否则版本会递增）
        assert (tmp_path / thread / "candidate.diff").is_file()
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert progress.current_task == TASK
        assert final_status == EXECUTING

    def test_resume_without_decision_does_not_reenter_graph(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        runner, req_id, thread = _halted_requirement(tmp_path, monkeypatch)
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            progress = RequirementExecutor(store, req_id, runner).advance()
            run = store.task_run(req_id, REQ_VERSION, TASK)
        finally:
            store.close()

        # 无决定：不重入，保留中断现场；dev 只执行过中断的那一次。
        assert _completed_nodes(tmp_path, thread) == ["dev"]
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert "pi_dev_unsettled" in run.reason
        assert progress.current_task == TASK
