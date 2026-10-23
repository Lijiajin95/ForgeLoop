"""槽位残留判定与安全清理的单元测试。

覆盖以权威动作记录为准的四种判定（空闲/已死/存活/不确定）、仅清理已死残留并
持久化清理记录、记录不足时不清理并报告原因、判定不依赖等待时长，以及重复与并发
清理的幂等性。
"""

import os
import sqlite3
import threading
from datetime import UTC, datetime

import pytest

from forgeloop.records.actions import (
    SLOT_PREFIX,
    ActionRecord,
    ActionState,
    ProcessLiveness,
    SlotResidue,
    assess_slot_occupant,
    default_process_probe,
)
from forgeloop.records.store import RecordStore


@pytest.fixture()
def store(tmp_path):
    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


def probe_dead(_pid: int) -> ProcessLiveness:
    return ProcessLiveness.DEAD


def probe_alive(_pid: int) -> ProcessLiveness:
    return ProcessLiveness.ALIVE


def probe_unknown(_pid: int) -> ProcessLiveness:
    return ProcessLiveness.UNKNOWN


def legacy_slot(store: RecordStore, slot: str, owner: str = "owner") -> ActionRecord:
    """登记一个没有进程身份的槽位占用，模拟旧记录或缺少权威身份的情形。"""

    return store.actions.begin(f"{SLOT_PREFIX}{slot}", "execution_slot", role=owner)


class TestResidueAssessment:
    def test_free_slot_has_no_residue(self, store: RecordStore) -> None:
        assessment = store.actions.assess_slot_residue("empty", probe=probe_dead)
        assert assessment.residue is SlotResidue.FREE
        assert assessment.occupant is None
        assert "空闲" in assessment.reason

    def test_dead_process_is_dead_residue(self, store: RecordStore) -> None:
        slot = store.actions.claim_slot("req-1", owner="req-1")
        assessment = store.actions.assess_slot_residue("req-1", probe=probe_dead)
        assert assessment.residue is SlotResidue.DEAD
        assert assessment.occupant is not None
        assert assessment.occupant.action_id == slot.action_id
        assert str(slot.pid) in assessment.reason

    def test_live_process_is_live_occupant(self, store: RecordStore) -> None:
        store.actions.claim_slot("req-1", owner="req-1")
        assessment = store.actions.assess_slot_residue("req-1", probe=probe_alive)
        assert assessment.residue is SlotResidue.LIVE
        assert "仍存活" in assessment.reason

    def test_unreadable_process_is_uncertain_with_reason(self, store: RecordStore) -> None:
        store.actions.claim_slot("req-1", owner="req-1")
        assessment = store.actions.assess_slot_residue("req-1", probe=probe_unknown)
        assert assessment.residue is SlotResidue.UNCERTAIN
        assert "无法确认" in assessment.reason

    def test_missing_process_identity_is_uncertain(self, store: RecordStore) -> None:
        legacy_slot(store, "req-1")
        assessment = store.actions.assess_slot_residue("req-1", probe=probe_dead)
        assert assessment.residue is SlotResidue.UNCERTAIN
        assert "缺少进程身份" in assessment.reason

    def test_assessment_ignores_started_at_and_heartbeat(self) -> None:
        """判定只看进程身份，槽位持有多久、心跳新旧都不改变结论。"""

        common = {
            "action_id": "a",
            "task_id": f"{SLOT_PREFIX}req-1",
            "node": "execution_slot",
            "role": "req-1",
            "state": ActionState.STARTED,
            "finished_at": None,
            "detail": "",
            "pid": 4242,
        }
        ancient = ActionRecord(
            started_at=datetime(2000, 1, 1, tzinfo=UTC),
            heartbeat_at=datetime(2000, 1, 1, tzinfo=UTC),
            **common,
        )
        future = ActionRecord(
            started_at=datetime(2100, 1, 1, tzinfo=UTC),
            heartbeat_at=datetime(2100, 1, 1, tzinfo=UTC),
            **common,
        )
        assert assess_slot_occupant("req-1", ancient, probe_dead).residue is SlotResidue.DEAD
        assert assess_slot_occupant("req-1", future, probe_dead).residue is SlotResidue.DEAD
        assert assess_slot_occupant("req-1", ancient, probe_alive).residue is SlotResidue.LIVE
        assert assess_slot_occupant("req-1", future, probe_alive).residue is SlotResidue.LIVE


class TestSafeCleanup:
    def test_dead_occupant_is_cleaned_and_recorded(self, store: RecordStore) -> None:
        slot = store.actions.claim_slot("req-1", owner="req-1")
        heartbeat = datetime(2026, 6, 1, tzinfo=UTC)
        store.actions.heartbeat(slot.action_id, at=heartbeat)
        outcome = store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
        assert outcome.cleaned
        record = outcome.cleanup
        assert record is not None
        # 清理记录必须含：槽位名、原占用者、判定依据、清理时间。
        assert record.slot == "req-1"
        assert record.occupant_action_id == slot.action_id
        assert record.occupant_owner == "req-1"
        assert record.occupant_pid == slot.pid
        assert str(slot.pid) in record.reason
        assert record.cleaned_at.tzinfo is not None
        # 占用已释放；历史记录保留，且最后一次心跳作为审计证据不被改写。
        assert store.actions.slot_owner("req-1") is None
        history = store.actions.cleanup_history("req-1")
        assert history == (record,)
        completed = store.actions.history(f"{SLOT_PREFIX}req-1")
        assert completed[0].heartbeat_at == heartbeat

    def test_live_occupant_is_never_cleaned(self, store: RecordStore) -> None:
        slot = store.actions.claim_slot("req-1", owner="req-1")
        outcome = store.actions.cleanup_slot_residue("req-1", probe=probe_alive)
        assert not outcome.cleaned
        assert outcome.cleanup is None
        assert outcome.assessment.residue is SlotResidue.LIVE
        owner = store.actions.slot_owner("req-1")
        assert owner is not None and owner.action_id == slot.action_id
        assert store.actions.cleanup_history("req-1") == ()

    def test_uncertain_occupant_is_not_cleaned_and_reports_reason(self, store: RecordStore) -> None:
        legacy_slot(store, "req-1")
        outcome = store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
        assert not outcome.cleaned
        assert outcome.assessment.residue is SlotResidue.UNCERTAIN
        assert "缺少进程身份" in outcome.assessment.reason
        assert store.actions.slot_owner("req-1") is not None
        assert store.actions.cleanup_history("req-1") == ()

    def test_unreadable_process_is_not_cleaned(self, store: RecordStore) -> None:
        store.actions.claim_slot("req-1", owner="req-1")
        outcome = store.actions.cleanup_slot_residue("req-1", probe=probe_unknown)
        assert not outcome.cleaned
        assert outcome.assessment.residue is SlotResidue.UNCERTAIN
        assert store.actions.slot_owner("req-1") is not None

    def test_repeated_cleanup_is_idempotent(self, store: RecordStore) -> None:
        store.actions.claim_slot("req-1", owner="req-1")
        first = store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
        second = store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
        third = store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
        assert first.cleaned
        assert not second.cleaned and not third.cleaned
        assert second.assessment.residue is SlotResidue.FREE
        assert len(store.actions.cleanup_history("req-1")) == 1


class TestConcurrentCleanup:
    def test_concurrent_cleanup_writes_single_record(self, tmp_path) -> None:
        db_path = tmp_path / "records.sqlite"
        seed = RecordStore(db_path)
        try:
            seed.actions.claim_slot("req-1", owner="req-1")
        finally:
            seed.close()

        barrier = threading.Barrier(4)
        outcomes = []
        errors: list[BaseException] = []

        def worker() -> None:
            worker_store = RecordStore(db_path)
            try:
                barrier.wait()
                outcomes.append(
                    worker_store.actions.cleanup_slot_residue("req-1", probe=probe_dead)
                )
            except BaseException as error:
                errors.append(error)
            finally:
                worker_store.close()

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)

        assert errors == []
        assert sum(1 for outcome in outcomes if outcome.cleaned) == 1
        verify = RecordStore(db_path)
        try:
            assert verify.actions.slot_owner("req-1") is None
            assert len(verify.actions.cleanup_history("req-1")) == 1
        finally:
            verify.close()


class TestHeartbeat:
    def test_heartbeat_updates_unfinished_action(self, store: RecordStore) -> None:
        action = store.actions.begin("task-x", "dev", pid=os.getpid())
        assert action.heartbeat_at == action.started_at
        moment = datetime(2030, 1, 1, tzinfo=UTC)
        updated = store.actions.heartbeat(action.action_id, at=moment)
        assert updated.heartbeat_at == moment
        assert updated.pid == os.getpid()

    def test_heartbeat_defaults_to_now(self, store: RecordStore) -> None:
        action = store.actions.begin("task-x", "dev")
        updated = store.actions.heartbeat(action.action_id)
        assert updated.heartbeat_at is not None
        assert updated.heartbeat_at >= action.started_at

    def test_heartbeat_unknown_action_is_rejected(self, store: RecordStore) -> None:
        with pytest.raises(KeyError):
            store.actions.heartbeat("missing")

    def test_heartbeat_finished_action_is_rejected(self, store: RecordStore) -> None:
        action = store.actions.begin("task-x", "dev")
        store.actions.finish(action.action_id)
        with pytest.raises(KeyError):
            store.actions.heartbeat(action.action_id)


class TestDefaultProcessProbe:
    def test_current_process_is_alive(self) -> None:
        assert default_process_probe(os.getpid()) is ProcessLiveness.ALIVE

    def test_non_positive_pid_is_unknown(self) -> None:
        assert default_process_probe(0) is ProcessLiveness.UNKNOWN
        assert default_process_probe(-1) is ProcessLiveness.UNKNOWN

    def test_lookup_error_is_dead(self, monkeypatch) -> None:
        def fake_kill(_pid: int, _signal: int) -> None:
            raise ProcessLookupError

        monkeypatch.setattr(os, "kill", fake_kill)
        assert default_process_probe(12345) is ProcessLiveness.DEAD

    def test_permission_error_is_alive(self, monkeypatch) -> None:
        def fake_kill(_pid: int, _signal: int) -> None:
            raise PermissionError

        monkeypatch.setattr(os, "kill", fake_kill)
        assert default_process_probe(12345) is ProcessLiveness.ALIVE

    def test_other_oserror_is_unknown(self, monkeypatch) -> None:
        def fake_kill(_pid: int, _signal: int) -> None:
            raise OSError("cannot probe")

        monkeypatch.setattr(os, "kill", fake_kill)
        assert default_process_probe(12345) is ProcessLiveness.UNKNOWN


class TestSchemaMigration:
    def test_old_actions_table_is_migrated(self, tmp_path) -> None:
        """旧库缺 pid/heartbeat_at 列时自动补列，旧记录按不确定处理。"""

        db_path = tmp_path / "records.sqlite"
        raw = sqlite3.connect(db_path)
        raw.execute(
            "CREATE TABLE actions ("
            " action_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node TEXT NOT NULL,"
            " role TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, started_at TEXT NOT NULL,"
            " finished_at TEXT, detail TEXT NOT NULL DEFAULT '')"
        )
        raw.execute(
            "INSERT INTO actions (action_id, task_id, node, role, state, started_at, detail)"
            " VALUES (?, ?, ?, ?, ?, ?, '')",
            (
                "legacy-1",
                f"{SLOT_PREFIX}legacy",
                "execution_slot",
                "owner",
                "started",
                "2026-01-01T00:00:00+00:00",
            ),
        )
        raw.commit()
        raw.close()

        store = RecordStore(db_path)
        try:
            assessment = store.actions.assess_slot_residue("legacy", probe=probe_dead)
            assert assessment.residue is SlotResidue.UNCERTAIN
            fresh = store.actions.claim_slot("fresh", owner="owner")
            assert fresh.pid == os.getpid()
            assert fresh.heartbeat_at is not None
        finally:
            store.close()
