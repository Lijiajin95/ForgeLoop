"""需求续跑的组件级真实用例：真实检查点、真实动作记录、真实业务图。

覆盖本任务验收的核心行为（不依赖 fixture 伪造成功）：

- 停在 ``test`` 节点、状态词仍为 ``testing`` 且无 halted 原因的任务，经
  ``requirement advance``（真实 ``RequirementTaskRunner``）就地续跑到验收门，
  ``dev``/``review``/``test`` 各执行一次并产生真实候选现场；
- 停在人工决策节点或存在 halted 原因的任务保持等待，不自动续跑，也不重放节点；
- 连续推进但检查点身份与已完成动作身份都不变时，报告包含阻塞原因与建议动作，
  工时与动作记录幂等：不重复执行、不重复计入。

判定只看记录事实（``checkpoints.sqlite`` 的 ``checkpoint_id`` 与 ``records.sqlite``
的 ``actions`` 序列），不依赖可能滞后的状态词。
"""

import json
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
from forgeloop.graph.builder import RequirementTaskRunner, build_graph, requirement_task_id
from forgeloop.graph.nodes import NodeContext
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id="first",
        goal="实现 first",
        files=("src/first.py",),
        acceptance="first 的验收标准",
        # 不依赖外部测试替身：真实子进程立即成功。
        test_command=(sys.executable, "-c", "print('ok')"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _runner(tmp_path: Path, req_id: str) -> RequirementTaskRunner:
    return RequirementTaskRunner(
        records_root=tmp_path,
        req_id=req_id,
        plan_version=1,
        project=PROJECT,
        pi_command=tuple(FAKE_PI_COMMAND),
        pi_timeout_seconds=120.0,
    )


def _approved(tmp_path: Path) -> str:
    """真实记录层：提交需求并批准含单个任务的任务包，返回 ``req_id``。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：检查点续跑")
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
        return requirement.req_id
    finally:
        store.close()


def _write_checkpoint(
    root: Path,
    thread_id: str,
    nodes: tuple[str, ...],
    *,
    halted_reason: str = "",
) -> None:
    """写一条真实 LangGraph 检查点，供不触发业务图执行的等待用例使用。"""

    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        # LangGraph 要求检查点身份是可解析的 UUID：沿用空检查点生成的真实身份。
        checkpoint_id = str(checkpoint["id"])
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


def _park_at_test(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """建立已批准需求，并用真实业务图把单任务图停到 ``test`` 之前。

    先用真实图走完 plan 与方案批准门，再让 ``dev``/``review`` 真正执行，然后以
    ``interrupt_before=['test']`` 落一条 ``next=('test',)`` 的检查点，等价于「进程
    在测试节点被中断」：检查点在 ``test``、任务记录状态词仍是 ``testing``。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "ok")
    req_id = _approved(tmp_path)
    task = _planned()
    runner = _runner(tmp_path, req_id)
    task_id = requirement_task_id(req_id, runner.plan_version, task.task_id)
    store = RecordStore(tmp_path / "records.sqlite")
    graph = None
    try:
        store.create_task(
            task_id, PROJECT, task.goal, runner._config(task), task.limits.limit_seconds
        )
        context = NodeContext.for_task(store, tmp_path, task_id)
        graph = build_graph(context, tmp_path / "checkpoints.sqlite")
        config: RunnableConfig = {"configurable": {"thread_id": task_id}}
        graph.invoke({"task_id": task_id}, config)
        runner._approve_plan(store, task_id)
        graph.invoke(
            Command(resume={"decision": "approved"}),
            config,
            interrupt_before=["test"],
        )
        snapshot = graph.get_state(config)
        assert set(snapshot.next) == {"test"}, snapshot.next
        # 现场状态词滞后于检查点：停在 test 之前，但记录仍可能是 testing。
        store.set_task_status(task_id, "testing")
    finally:
        if graph is not None:
            conn = getattr(graph.checkpointer, "conn", None)
            if conn is not None:
                conn.close()
        store.close()

    return req_id, task_id


def _advance(tmp_path: Path, req_id: str, capsys) -> tuple[int, str]:
    """走真实 ``requirement advance`` CLI，返回退出码与合并输出。"""

    code = cli_main(
        [
            "requirement",
            "advance",
            req_id,
            "--pi-command",
            json.dumps(FAKE_PI_COMMAND),
            "--records-root",
            str(tmp_path),
        ]
    )
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def _budget(tmp_path: Path, req_id: str) -> float:
    store = RequirementStore(tmp_path / "records.sqlite")
    try:
        return store.requirement_budget(req_id).consumed_seconds
    finally:
        store.close()


def _history(tmp_path: Path, task_id: str) -> tuple[tuple[str, str], ...]:
    store = RecordStore(tmp_path / "records.sqlite")
    try:
        return tuple((action.node, action.state.value) for action in store.actions.history(task_id))
    finally:
        store.close()


class TestParkedTestResume:
    def test_parked_test_resumes_to_acceptance_gate(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        req_id, task_id = _park_at_test(tmp_path, monkeypatch)

        code, out = _advance(tmp_path, req_id, capsys)

        assert code == 0, out
        assert "当前任务: first" in out
        assert "下一步:" in out
        assert "原因:" in out
        # dev/review/test 真正执行：候选 diff 与验收门现场由真实业务图产生。
        assert (tmp_path / task_id / "candidate.diff").is_file()
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            record = store.get_task(task_id)
            history = store.actions.history(task_id)
        finally:
            store.close()
        assert record is not None
        assert record.status == "awaiting_acceptance"
        completed = [action.node for action in history if action.state.value == "completed"]
        assert sorted(completed) == ["dev", "review", "test"]

    def test_resume_reaches_gate_and_charges_real_work(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        req_id, _ = _park_at_test(tmp_path, monkeypatch)

        code, out = _advance(tmp_path, req_id, capsys)

        assert code == 0, out
        # 真实执行了 test，工时按实际执行段落库，不为零。
        assert _budget(tmp_path, req_id) > 0.0


class TestDecisionAndHaltedDoNotResume:
    def test_halted_checkpoint_keeps_waiting_without_running(self, tmp_path: Path, capsys) -> None:
        req_id = _approved(tmp_path)
        task_id = requirement_task_id(req_id, 1, "first")
        _write_checkpoint(tmp_path, task_id, ("test",), halted_reason="pi_dev_unsettled:timeout")

        code, out = _advance(tmp_path, req_id, capsys)

        assert code == 0, out
        # 报告保留原始 halted 原因，且没有启动任何业务节点。
        assert "pi_dev_unsettled:timeout" in out
        assert not (tmp_path / task_id / "candidate.diff").exists()
        assert _history(tmp_path, task_id) == ()
        assert _budget(tmp_path, req_id) == 0.0

    def test_acceptance_gate_is_not_auto_accepted(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        req_id, task_id = _park_at_test(tmp_path, monkeypatch)
        code, out = _advance(tmp_path, req_id, capsys)
        assert code == 0, out

        # 第一次续跑已停在验收门；再次推进不得自动放行。
        code, again = _advance(tmp_path, req_id, capsys)

        assert code == 0, again
        assert "下一步:" in again
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            record = store.get_task(task_id)
        finally:
            store.close()
        assert record is not None
        assert record.status == "awaiting_acceptance"

    def test_plan_gate_is_not_auto_approved(self, tmp_path: Path, capsys) -> None:
        req_id = _approved(tmp_path)
        task_id = requirement_task_id(req_id, 1, "first")
        _write_checkpoint(tmp_path, task_id, ("gate_plan_approval",))

        code, out = _advance(tmp_path, req_id, capsys)

        assert code == 0, out
        assert "gate_plan_approval" in out
        assert not (tmp_path / task_id / "candidate.diff").exists()
        assert _history(tmp_path, task_id) == ()


class TestRepeatedAdvanceIdempotent:
    def test_repeated_advance_does_not_repeat_nodes_or_hours(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        req_id, task_id = _park_at_test(tmp_path, monkeypatch)

        first_code, first_out = _advance(tmp_path, req_id, capsys)
        assert first_code == 0, first_out
        budget_after_resume = _budget(tmp_path, req_id)
        history_after_resume = _history(tmp_path, task_id)

        second_code, second_out = _advance(tmp_path, req_id, capsys)

        assert second_code == 0, second_out
        # 已在验收门：重复推进不重放节点、不再计入工时，动作记录保持一致。
        assert _history(tmp_path, task_id) == history_after_resume
        assert _budget(tmp_path, req_id) == budget_after_resume
        assert "下一步:" in second_out


class TestNoProgressReport:
    def test_two_no_change_advances_report_blocking_reason_and_action(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        req_id, task_id = _park_at_test(tmp_path, monkeypatch)
        first_code, first_out = _advance(tmp_path, req_id, capsys)
        assert first_code == 0, first_out
        budget_at_gate = _budget(tmp_path, req_id)

        # 停在验收门后连续推进两次：checkpoint_id 与 actions 序列都不再变化。
        second_code, second_out = _advance(tmp_path, req_id, capsys)
        third_code, third_out = _advance(tmp_path, req_id, capsys)

        assert second_code == 0, second_out
        assert third_code == 0, third_out
        # 无进展不静默等待：报告给出阻塞原因与建议动作（主体为人工）。
        assert "原因:" in third_out
        assert "下一步:" in third_out
        assert "（user）" in third_out
        # 连续无变化不重复计入工时，也不产生新动作。
        assert _budget(tmp_path, req_id) == budget_at_gate
        assert _history(tmp_path, task_id) == (
            ("dev", "completed"),
            ("review", "completed"),
            ("test", "completed"),
        )
