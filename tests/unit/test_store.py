"""记录存储的单元测试：SQLite 权威记录的边界与幂等。"""

from datetime import UTC, datetime

import pytest

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.domain.counting import FailureStage, GrantExhaustedError
from forgeloop.domain.limits import ExecutionBudget
from forgeloop.records.store import RecordStore


@pytest.fixture()
def store(tmp_path):
    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


def make_task(store: RecordStore, task_id: str = "task-x") -> None:
    store.create_task(
        task_id,
        "forgeloop",
        "原始需求文本",
        {"pi_command": '["pi"]', "test_command": '["pytest"]'},
        limit_seconds=100.0,
    )


class TestTaskRecords:
    def test_unknown_task_is_none(self, store: RecordStore) -> None:
        assert store.get_task("missing") is None

    def test_set_status_on_unknown_task_raises(self, store: RecordStore) -> None:
        with pytest.raises(KeyError):
            store.set_task_status("missing", "x")

    def test_config_snapshot_is_persisted(self, store: RecordStore) -> None:
        make_task(store)
        task = store.get_task("task-x")
        assert task is not None
        assert task.config["pi_command"] == '["pi"]'
        assert task.status == "created"


class TestBudget:
    def test_missing_budget_raises(self, store: RecordStore) -> None:
        with pytest.raises(KeyError):
            store.budget("missing")

    def test_charge_and_extend_persist(self, store: RecordStore) -> None:
        make_task(store)
        store.charge_budget("task-x", 40.0)
        budget = store.budget("task-x")
        assert budget.consumed_seconds == 40.0
        store.extend_budget("task-x", 200.0)
        assert store.budget("task-x").limit_seconds == 200.0
        assert ExecutionBudget(limit_seconds=200.0, consumed_seconds=40.0).remaining_seconds


class TestStopsAndDelivery:
    def test_stop_record_missing_is_none(self, store: RecordStore) -> None:
        assert store.outcomes.stop_record("task-x") is None

    def test_confirm_without_request_raises(self, store: RecordStore) -> None:
        with pytest.raises(KeyError):
            store.outcomes.confirm_stop("task-x", "note")

    def test_request_then_confirm_roundtrip(self, store: RecordStore) -> None:
        make_task(store)
        store.outcomes.request_stop("task-x", "计划停止")
        record = store.outcomes.stop_record("task-x")
        assert record is not None
        _requested_at, confirmed_at, note = record
        assert confirmed_at is None
        assert note == "计划停止"
        store.outcomes.confirm_stop("task-x", "已核对")
        record = store.outcomes.stop_record("task-x")
        assert record is not None
        _requested_at, confirmed_at, note = record
        assert confirmed_at is not None
        assert note == "已核对"

    def test_delivery_missing_is_none(self, store: RecordStore) -> None:
        assert store.outcomes.delivery("task-x") is None


class TestLedgerAndApprovals:
    def test_ledger_initial_grant_is_created_lazily(self, store: RecordStore) -> None:
        make_task(store)
        ledger = store.ledger("task-x")
        assert ledger.grant_count == 1

    def test_failure_rounds_and_grants_persist(self, store: RecordStore) -> None:
        make_task(store)
        for index in range(3):
            store.record_failure("task-x", f"c-{index + 1}", FailureStage.FORMAL_TEST, "failed")
        with pytest.raises(GrantExhaustedError):
            store.record_failure("task-x", "c-4", FailureStage.FORMAL_TEST, "failed")
        store.append_grant("task-x")
        reloaded = store.ledger("task-x")
        assert reloaded.grant_count == 2
        assert reloaded.cumulative_failures == 3  # 重载后累计仍保留

    def test_duplicate_round_id_is_idempotent_across_reload(self, store: RecordStore) -> None:
        make_task(store)
        store.record_failure("task-x", "c-1", FailureStage.FORMAL_TEST, "failed")
        total = store.record_failure("task-x", "c-1", FailureStage.FORMAL_TEST, "repeat")
        assert total == 1

    def test_approval_effective_and_consumption_persist(self, store: RecordStore) -> None:
        make_task(store)
        store.record_approval(Approval("task-x", 1, ApprovalStage.PLAN, datetime.now(UTC)))
        first = store.consume_approval("task-x", 1, ApprovalStage.PLAN)
        second = store.consume_approval("task-x", 1, ApprovalStage.PLAN)
        assert first.status.value == "ok"
        assert second.status.value == "already_used"

    def test_stale_approval_version_persists(self, store: RecordStore) -> None:
        make_task(store)
        store.record_approval(Approval("task-x", 1, ApprovalStage.PLAN, datetime.now(UTC)))
        store.record_approval(Approval("task-x", 2, ApprovalStage.PLAN, datetime.now(UTC)))
        result = store.consume_approval("task-x", 1, ApprovalStage.PLAN)
        assert result.status.value == "stale"
