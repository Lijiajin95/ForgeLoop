"""集成测试：槽位残留判定与安全清理在真实持久化与真实进程边界上的行为。

与本仓单元/组件测试的区别：这里不替换 ``os.kill`` 探测，也不共用同一连接，
而是用真实子进程身份（已退出进程判死、当前进程判活）与独立 SQLite 连接验证
三类结论，且清理记录跨连接、跨进程可读；并发清理只写一条记录，绝不误清存活占用。
"""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from forgeloop.records.actions import (
    SLOT_PREFIX,
    ProcessLiveness,
    SlotCleanupOutcome,
    SlotResidue,
    default_process_probe,
)
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

# 独立进程里做一次真实残留清理，结果以 JSON 回传；父进程再回查持久化结果。
CLEANUP_SCRIPT = r"""
import json
import sys
from pathlib import Path

from forgeloop.records.store import RecordStore

db, slot = sys.argv[1], sys.argv[2]
store = RecordStore(Path(db))
try:
    outcome = store.actions.cleanup_slot_residue(slot)
    print(
        json.dumps(
            {
                "cleaned": outcome.cleaned,
                "residue": outcome.assessment.residue.value,
                "reason": outcome.assessment.reason,
            }
        )
    )
finally:
    store.close()
"""


@pytest.fixture()
def exited_pid() -> int:
    """真实启动一个子进程并等它退出，返回已回收、``os.kill`` 必判死的 pid。"""

    child = subprocess.Popen([sys.executable, "-c", "pass"])
    pid = child.pid
    child.wait(timeout=10)
    return pid


def cleanup_in_subprocess(db: Path, slot: str) -> dict:
    result = subprocess.run(
        [sys.executable, "-c", CLEANUP_SCRIPT, str(db), slot],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class TestRealProcessProbe:
    def test_exited_process_is_dead_and_current_process_is_alive(self, exited_pid: int) -> None:
        # 判定依据是真实进程身份，不是等待时长：同一进程先活后死，结论随之改变。
        assert default_process_probe(exited_pid) is ProcessLiveness.DEAD
        assert default_process_probe(os.getpid()) is ProcessLiveness.ALIVE


class TestDeadResidueCleanup:
    def test_dead_residue_is_cleaned_and_recorded_persistently(
        self, tmp_path: Path, exited_pid: int
    ) -> None:
        db = tmp_path / "records.sqlite"
        slot = "requirement:req-it"
        seed = RecordStore(db)
        try:
            slot_record = seed.actions.claim_slot(slot, owner="req-it", pid=exited_pid)
        finally:
            seed.close()

        cleanup = RecordStore(db)
        try:
            outcome = cleanup.actions.cleanup_slot_residue(slot)
            assert outcome.cleaned
            assert outcome.assessment.residue is SlotResidue.DEAD
            record = outcome.cleanup
            assert record is not None
            assert record.occupant_action_id == slot_record.action_id
            assert record.occupant_pid == exited_pid
        finally:
            cleanup.close()

        # 新连接回查：占用已释放、清理记录仍在（跨连接持久化）。
        verify = RecordStore(db)
        try:
            assert verify.actions.slot_owner(slot) is None
            history = verify.actions.cleanup_history(slot)
            assert len(history) == 1
            assert history[0].cleanup_id == record.cleanup_id
        finally:
            verify.close()

    def test_cleanup_crosses_a_real_process_boundary(self, tmp_path: Path, exited_pid: int) -> None:
        db = tmp_path / "records.sqlite"
        slot = "project-delivery:proj-it"
        seed = RecordStore(db)
        try:
            seed.actions.claim_slot(slot, owner="proj-it", pid=exited_pid)
        finally:
            seed.close()

        # 由另一个真实进程完成清理（真实探测），父进程只负责回查结果。
        outcome = cleanup_in_subprocess(db, slot)
        assert outcome["cleaned"] is True
        assert outcome["residue"] == SlotResidue.DEAD.value
        assert str(exited_pid) in outcome["reason"]

        verify = RecordStore(db)
        try:
            assert verify.actions.slot_owner(slot) is None
            assert len(verify.actions.cleanup_history(slot)) == 1
        finally:
            verify.close()


class TestNotCleanedOccupants:
    def test_live_residue_is_never_cleaned(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        slot = "requirement:req-live"
        seed = RecordStore(db)
        try:
            occupied = seed.actions.claim_slot(slot, owner="req-live", pid=os.getpid())
        finally:
            seed.close()

        store = RecordStore(db)
        try:
            outcome = store.actions.cleanup_slot_residue(slot)
            assert not outcome.cleaned
            assert outcome.assessment.residue is SlotResidue.LIVE
            assert "仍存活" in outcome.assessment.reason
            owner = store.actions.slot_owner(slot)
            assert owner is not None and owner.action_id == occupied.action_id
            assert store.actions.cleanup_history(slot) == ()
        finally:
            store.close()

    def test_unknown_and_legacy_identity_are_not_cleaned(self, tmp_path: Path) -> None:
        db = tmp_path / "records.sqlite"
        unknown_slot = "requirement:req-unknown"
        legacy_slot = "requirement:req-legacy"
        seed = RecordStore(db)
        try:
            seed.actions.claim_slot(unknown_slot, owner="req-unknown", pid=0)
            seed.actions.begin(f"{SLOT_PREFIX}{legacy_slot}", "execution_slot", role="req-legacy")
        finally:
            seed.close()

        store = RecordStore(db)
        try:
            unknown = store.actions.cleanup_slot_residue(unknown_slot)
            assert not unknown.cleaned
            assert unknown.assessment.residue is SlotResidue.UNCERTAIN
            assert "无法确认" in unknown.assessment.reason
            assert store.actions.slot_owner(unknown_slot) is not None

            legacy = store.actions.cleanup_slot_residue(legacy_slot)
            assert not legacy.cleaned
            assert legacy.assessment.residue is SlotResidue.UNCERTAIN
            assert "缺少进程身份" in legacy.assessment.reason
            assert store.actions.slot_owner(legacy_slot) is not None

            assert store.actions.cleanup_history(unknown_slot) == ()
            assert store.actions.cleanup_history(legacy_slot) == ()
        finally:
            store.close()


class TestConcurrentCleanup:
    def test_concurrent_cleanup_writes_single_record_with_real_probe(
        self, tmp_path: Path, exited_pid: int
    ) -> None:
        db = tmp_path / "records.sqlite"
        slot = "requirement:req-race"
        seed = RecordStore(db)
        try:
            seed.actions.claim_slot(slot, owner="req-race", pid=exited_pid)
        finally:
            seed.close()

        barrier = threading.Barrier(4)
        outcomes: list[SlotCleanupOutcome] = []
        errors: list[BaseException] = []

        def worker() -> None:
            worker_store = RecordStore(db)
            try:
                barrier.wait()
                outcomes.append(worker_store.actions.cleanup_slot_residue(slot))
            except BaseException as error:  # 记录后统一断言，避免线程静默失败
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

        verify = RecordStore(db)
        try:
            assert verify.actions.slot_owner(slot) is None
            assert len(verify.actions.cleanup_history(slot)) == 1
        finally:
            verify.close()
