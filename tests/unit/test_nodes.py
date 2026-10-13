"""节点函数的行为级单元测试：方案守卫与状态更新语义。"""

import json
from pathlib import Path

import pytest

from forgeloop.adapter.pi_rpc import PIProcess
from forgeloop.graph.nodes import (
    NodeContext,
    make_dev_node,
    make_gate_plan_approval,
    make_plan_node,
    make_review_node,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture()
def store(tmp_path):
    from forgeloop.records.store import RecordStore

    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


def context(
    store, tmp_path: Path, task_id: str, config: dict[str, str] | None = None
) -> NodeContext:
    base = {
        "pi_command": json.dumps(["unused"]),
        "test_command": json.dumps(["true"]),
        "goal": "g",
        "scope": "s",
        "acceptance": "a",
    }
    base.update(config or {})
    store.create_task(task_id, "p", "input", base, limit_seconds=60.0)
    return NodeContext.for_task(store, tmp_path, task_id)


class TestPlanNode:
    def test_second_invocation_bumps_version(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-plan")
        plan_node = make_plan_node(ctx)
        first = plan_node({"task_id": "task-plan"})
        second = plan_node({"task_id": "task-plan"})
        assert first["plan_version"] == 1
        assert second["plan_version"] == 2
        assert store.latest_plan("task-plan").version == 2

    def test_invalid_test_command_is_rejected(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-bad", {"test_command": '"not-a-list"'})
        with pytest.raises(ValueError, match="non-empty JSON array"):
            make_plan_node(ctx)({"task_id": "task-bad"})


class TestMissingPlanGuards:
    def test_gate_plan_approval_without_plan_halts(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-noplan")
        result = make_gate_plan_approval(ctx)({"task_id": "task-noplan"})
        assert result == {"halted_reason": "plan_missing"}
        assert store.get_task("task-noplan").status == "interrupted"

    def test_dev_without_plan_halts(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-noplan2")
        result = make_dev_node(ctx)({"task_id": "task-noplan2"})
        assert result == {"halted_reason": "plan_missing"}

    def test_review_without_plan_uses_empty_diff(self, store, tmp_path: Path, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        ctx = context(
            store,
            tmp_path,
            "task-noplan3",
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        result = make_review_node(ctx)({"task_id": "task-noplan3"})
        assert result == {"last_review_blocking": False}


class TestReviewResultShapes:
    """审查结果契约：无结构化阻断列表时不得判为"无阻断"（禁止错误放行）。"""

    def _review(self, store, tmp_path: Path, task_id: str, mode: str, monkeypatch):
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", mode)
        ctx = context(
            store,
            tmp_path,
            task_id,
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": task_id})
        result = make_review_node(ctx)({"task_id": task_id})
        entry = json.loads(
            (tmp_path / task_id / "reviews.jsonl").read_text(encoding="utf-8").splitlines()[0]
        )
        return result, entry, store.get_task(task_id).status

    def test_explicit_empty_blocking_issues_passes(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        result, entry, status = self._review(store, tmp_path, "task-ok", "ok", monkeypatch)
        assert result == {"last_review_blocking": False}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is True
        assert status == "reviewing"

    def test_non_empty_blocking_issues_is_blocking(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-blocking", "blocking", monkeypatch
        )
        assert result == {"last_review_blocking": True}
        assert entry["blocking_issues"]
        assert entry["blocking_issues_valid"] is True
        assert status == "reviewing"

    def test_non_list_blocking_issues_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-bad-issues", "review-bad-issues", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is False
        assert status == "interrupted"

    def test_missing_blocking_issues_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-no-issues", "review-no-issues", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues_valid"] is False
        assert status == "interrupted"

    def test_missing_review_text_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-empty-text", "review-empty-text", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is False
        assert entry["summary"] == ""
        assert status == "interrupted"


class TestPreamble:
    def test_fake_pi_process_contract_import(self) -> None:
        # 保持适配器可直接构造（会话文件路径派生）。
        process = PIProcess(("echo",), "t", "dev", Path("/tmp/fl-sessions"))
        assert process.events == ()
