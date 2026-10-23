"""动作生命周期集成测试：真实 SQLite 双连接、故障注入与动作重放守卫。

覆盖 B03 交付条件：两个调用只有一个消费成功、2 秒累计保存 2 秒、创建失败
无半条任务、开发中杀进程后再次批准不重放。外部边界（SQLite、PI 子进程、
LangGraph 检查点）都走真实实现；只有「进程被杀」这一时刻用未完成动作记录模拟。
"""

import json
import sqlite3
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.graph.nodes import (
    NodeContext,
    make_dev_node,
    make_gate_acceptance,
    make_plan_node,
    make_review_node,
    make_test_node,
)
from forgeloop.records.actions import ActionInFlightError, ActionStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]


def _create_task(store: RecordStore, task_id: str = "task-it", limit: float = 60.0) -> None:
    store.create_task(
        task_id,
        "forgeloop",
        "输入",
        {
            "pi_command": json.dumps(FAKE_PI),
            "test_command": json.dumps(["true"]),
            "goal": "g",
            "scope": "s",
            "acceptance": "a",
        },
        limit_seconds=limit,
    )


class TestConcurrentApprovalConsumption:
    def test_only_one_of_two_connections_consumes(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        setup = RecordStore(db)
        try:
            _create_task(setup)
            setup.record_approval(Approval("task-it", 1, ApprovalStage.PLAN, datetime.now(UTC)))
        finally:
            setup.close()

        results: list[str] = []
        barrier = threading.Barrier(2)

        def consume() -> None:
            store = RecordStore(db)
            try:
                barrier.wait()
                result = store.consume_approval("task-it", 1, ApprovalStage.PLAN)
                results.append(result.status.value)
            finally:
                store.close()

        threads = [threading.Thread(target=consume) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert sorted(results) == ["already_used", "ok"]


class TestConcurrentBudgetCharge:
    def test_two_connections_charge_two_seconds_total(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        setup = RecordStore(db)
        try:
            _create_task(setup)
        finally:
            setup.close()

        barrier = threading.Barrier(2)

        def charge() -> None:
            store = RecordStore(db)
            try:
                barrier.wait()
                store.charge_budget("task-it", 1.0)
            finally:
                store.close()

        threads = [threading.Thread(target=charge) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        check = RecordStore(db)
        try:
            assert check.budget("task-it").consumed_seconds == 2.0
        finally:
            check.close()


class TestConcurrentActionStart:
    def test_two_connections_only_one_starts_an_action(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        setup = RecordStore(db)
        try:
            _create_task(setup)
        finally:
            setup.close()

        outcomes: list[str] = []
        barrier = threading.Barrier(2)

        def start() -> None:
            store = RecordStore(db)
            try:
                barrier.wait()
                try:
                    store.actions.begin("task-it", "dev")
                    outcomes.append("started")
                except ActionInFlightError:
                    outcomes.append("refused")
            finally:
                store.close()

        threads = [threading.Thread(target=start) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert sorted(outcomes) == ["refused", "started"]
        check = RecordStore(db)
        try:
            history = check.actions.history("task-it")
            assert [record.state.value for record in history] == ["started"]
        finally:
            check.close()


class TestCreateTaskAtomicity:
    def test_failed_budget_insert_rolls_back_the_task(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        store = RecordStore(db)
        try:
            # 故障注入：先放一条与任务同 id 的预算行，使 create_task 的第二步失败。
            raw = sqlite3.connect(db)
            try:
                raw.execute(
                    "INSERT INTO budget (task_id, limit_seconds, consumed_seconds)"
                    " VALUES (?, ?, ?)",
                    ("task-half", 10.0, 0.0),
                )
                raw.commit()
            finally:
                raw.close()
            with pytest.raises(sqlite3.IntegrityError):
                _create_task(store, "task-half")
            assert store.get_task("task-half") is None  # 没有半条任务
            assert store.budget("task-half").limit_seconds == 10.0  # 注入行未被改写
        finally:
            store.close()


class TestActionReplayGuard:
    def test_unfinished_action_blocks_dev_and_skips_pi(self, tmp_path: Path, monkeypatch) -> None:
        prompt_log = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(prompt_log))
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            _create_task(store)
            ctx = NodeContext.for_task(store, tmp_path, "task-it")
            make_plan_node(ctx)({"task_id": "task-it"})
            # 模拟进程在 dev 动作中途被杀：只留下 started 记录。
            store.actions.begin("task-it", "dev")
            update = make_dev_node(ctx)({"task_id": "task-it"})
            assert str(update["halted_reason"]).startswith("action_unchecked:")
            task = store.get_task("task-it")
            assert task is not None and task.status == "interrupted"
            assert not (ctx.task_dir / "candidate.diff").exists()
            assert not prompt_log.exists()  # 没有启动新的 PI 会话
            assert store.actions.outstanding("task-it") is not None  # 现场保留待核对
        finally:
            store.close()

    def test_completed_action_allows_the_next_attempt(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            _create_task(store)
            ctx = NodeContext.for_task(store, tmp_path, "task-it")
            make_plan_node(ctx)({"task_id": "task-it"})
            first = make_dev_node(ctx)({"task_id": "task-it"})
            second = make_dev_node(ctx)({"task_id": "task-it"})
            assert "halted_reason" not in first
            assert "halted_reason" not in second
            history = store.actions.history("task-it")
            assert [record.state.value for record in history] == ["completed", "completed"]
        finally:
            store.close()


class TestActionPreemptionAtNode:
    """门检查与动作登记之间被并发抢占：节点不启动第二次动作，如实标记中断。

    真实并发已由 ``TestConcurrentActionStart`` 用双连接证明；本类只把「抢占发生在
    门检查之后」这一时刻用 ``begin`` 抛错固定下来，确定性地覆盖动作节点的守卫分支。
    """

    @pytest.mark.parametrize("factory_name", ["dev", "review", "test"])
    def test_competing_start_halts_the_node_without_side_effects(
        self, tmp_path: Path, monkeypatch, factory_name: str
    ) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            _create_task(store)
            ctx = NodeContext.for_task(store, tmp_path, "task-it")
            make_plan_node(ctx)({"task_id": "task-it"})

            def preempted_begin(self, task_id: str, node: str, role: str = "") -> None:
                # 另一个进程已抢占同一动作槽：真实 begin 会在事务内抛出该异常。
                raise ActionInFlightError(task_id, "review")

            monkeypatch.setattr(ActionStore, "begin", preempted_begin)
            factories = {
                "dev": make_dev_node,
                "review": make_review_node,
                "test": make_test_node,
            }
            update = factories[factory_name](ctx)({"task_id": "task-it"})
            assert update["halted_reason"] == "action_unchecked:review"
            task = store.get_task("task-it")
            assert task is not None and task.status == "interrupted"
            assert store.actions.outstanding("task-it") is None  # 没有半条动作
        finally:
            store.close()


class TestAcceptanceGateUncheckedAction:
    """整体验收门以未核对动作为先：不消费验收批准，也不重放旧动作。"""

    def test_outstanding_action_blocks_acceptance_gate(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            _create_task(store)
            ctx = NodeContext.for_task(store, tmp_path, "task-it")
            make_plan_node(ctx)({"task_id": "task-it"})
            store.actions.begin("task-it", "dev")
            update = make_gate_acceptance(ctx)({"task_id": "task-it"})
            assert update["halted_reason"] == "action_unchecked:dev"
            task = store.get_task("task-it")
            assert task is not None and task.status == "interrupted"
        finally:
            store.close()


class TestGraphResumeAfterCrash:
    def test_resuming_the_graph_does_not_replay_the_unchecked_dev(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from langgraph.types import Command

        from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        prompt_log = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(prompt_log))
        setup = RecordStore(tmp_path / "records.sqlite")
        try:
            _create_task(setup)
        finally:
            setup.close()

        store, _ctx, graph = _build_runtime(tmp_path, "task-it")
        try:
            graph.invoke({"task_id": "task-it"}, _run_config("task-it"))  # plan + 批准门
            store.record_approval(Approval("task-it", 1, ApprovalStage.PLAN, datetime.now(UTC)))
            # 模拟批准后、dev 动作中途进程被杀。
            store.actions.begin("task-it", "dev")
            graph.invoke(Command(resume={"decision": "approved"}), _run_config("task-it"))
            task = store.get_task("task-it")
            assert task is not None and task.status == "interrupted"
            assert not (tmp_path / "task-it" / "candidate.diff").exists()
            assert not prompt_log.exists()
        finally:
            _close_runtime(graph)
            store.close()
