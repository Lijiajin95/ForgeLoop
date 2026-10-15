"""槽位残留判定与安全清理的属性测试：任意探测结果与重复序列下不变量始终成立。

不变量：
- 只有「进程身份存在且探测为已死」才清理；存活、不确定与空闲一律不清理。
- 缺少进程身份时永远判不确定，绝不判已死。
- 判定只依赖进程身份，与 started_at/heartbeat_at 无关（不依赖等待时长）。
- 重复清理幂等：一个死占用者最多写一条清理记录，且不误清存活占用者。
"""

from datetime import UTC, datetime
from uuid import uuid4

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from forgeloop.records.actions import (
    SLOT_PREFIX,
    ActionRecord,
    ActionState,
    ProcessLiveness,
    SlotResidue,
    assess_slot_occupant,
)
from forgeloop.records.store import RecordStore

MOMENT = datetime(2026, 1, 1, tzinfo=UTC)

livenesses = st.sampled_from([ProcessLiveness.ALIVE, ProcessLiveness.DEAD, ProcessLiveness.UNKNOWN])

_EXPECTED = {
    ProcessLiveness.ALIVE: SlotResidue.LIVE,
    ProcessLiveness.DEAD: SlotResidue.DEAD,
    ProcessLiveness.UNKNOWN: SlotResidue.UNCERTAIN,
}


def fresh_store(tmp_path) -> RecordStore:
    """每个属性示例一个独立记录库，避免示例之间共享状态。"""

    return RecordStore(tmp_path / uuid4().hex / "records.sqlite")


def _occupant(pid: int | None, started_at: datetime, heartbeat_at: datetime) -> ActionRecord:
    return ActionRecord(
        action_id="a",
        task_id=f"{SLOT_PREFIX}x",
        node="execution_slot",
        role="owner",
        state=ActionState.STARTED,
        started_at=started_at,
        finished_at=None,
        detail="",
        pid=pid,
        heartbeat_at=heartbeat_at,
    )


@given(livenesses, st.booleans())
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_cleanup_only_clears_dead(tmp_path, liveness: ProcessLiveness, has_pid: bool) -> None:
    store = fresh_store(tmp_path)
    try:
        slot = f"slot-{uuid4().hex}"
        store.actions.begin(
            f"{SLOT_PREFIX}{slot}",
            "execution_slot",
            role="owner",
            pid=1234 if has_pid else None,
        )
        outcome = store.actions.cleanup_slot_residue(slot, probe=lambda _pid: liveness)
        should_clean = has_pid and liveness is ProcessLiveness.DEAD
        assert outcome.cleaned is should_clean
        if should_clean:
            assert store.actions.slot_owner(slot) is None
            assert len(store.actions.cleanup_history(slot)) == 1
        else:
            assert store.actions.slot_owner(slot) is not None
            assert store.actions.cleanup_history(slot) == ()
    finally:
        store.close()


@given(livenesses)
def test_missing_process_identity_is_always_uncertain(liveness: ProcessLiveness) -> None:
    record = _occupant(pid=None, started_at=MOMENT, heartbeat_at=MOMENT)
    # 缺少进程身份：探测结果再明确也不能判已死或存活。
    assessment = assess_slot_occupant("x", record, lambda _pid: liveness)
    assert assessment.residue is SlotResidue.UNCERTAIN


@given(
    livenesses,
    st.datetimes(timezones=st.just(UTC)),
    st.datetimes(timezones=st.just(UTC)),
    st.integers(min_value=1, max_value=2**31 - 1),
)
def test_assessment_ignores_timestamps(
    liveness: ProcessLiveness, started_at: datetime, heartbeat_at: datetime, pid: int
) -> None:
    record = _occupant(pid=pid, started_at=started_at, heartbeat_at=heartbeat_at)
    assessment = assess_slot_occupant("x", record, lambda _pid: liveness)
    assert assessment.residue is _EXPECTED[liveness]


@given(st.integers(min_value=2, max_value=8))
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_repeated_cleanup_is_idempotent(tmp_path, repetitions: int) -> None:
    store = fresh_store(tmp_path)
    try:
        slot = f"slot-{uuid4().hex}"
        store.actions.claim_slot(slot, owner="owner")
        cleaned = 0
        for _ in range(repetitions):
            outcome = store.actions.cleanup_slot_residue(
                slot, probe=lambda _pid: ProcessLiveness.DEAD
            )
            cleaned += int(outcome.cleaned)
        assert cleaned == 1
        assert len(store.actions.cleanup_history(slot)) == 1
    finally:
        store.close()


@given(st.booleans())
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_live_occupant_survives_repeated_cleanup_attempts(tmp_path, has_pid: bool) -> None:
    store = fresh_store(tmp_path)
    try:
        slot = f"slot-{uuid4().hex}"
        store.actions.begin(
            f"{SLOT_PREFIX}{slot}",
            "execution_slot",
            role="owner",
            pid=1234 if has_pid else None,
        )
        for _ in range(5):
            outcome = store.actions.cleanup_slot_residue(
                slot, probe=lambda _pid: ProcessLiveness.ALIVE
            )
            assert not outcome.cleaned
            assert store.actions.slot_owner(slot) is not None
        assert store.actions.cleanup_history(slot) == ()
    finally:
        store.close()
