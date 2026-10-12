"""失败轮次计数的属性测试：任意失败序列下不变量始终成立。

不变量（V0-06）：
- 累计失败数等于去重后的轮次数量（重复反馈不加数）。
- 累计失败数不超过 3 x 授权次数（追加前）。
- 第 n 次授权允许的累计范围为 3n-2 .. 3n。
- 追加授权只增加额度，不清零、不减少累计。
"""

from datetime import UTC, datetime

import pytest
from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.counting import FailureStage, GrantExhaustedError, GrantLedger

MOMENT = datetime(2026, 10, 12, 12, 0, tzinfo=UTC)

round_ids = st.integers(min_value=1, max_value=200).map(lambda n: f"candidate-{n}")
failure_lists = st.lists(round_ids, min_size=0, max_size=60)


@given(failure_lists)
def test_cumulative_equals_unique_round_count(rounds: list[str]) -> None:
    ledger = GrantLedger()
    for index, round_id in enumerate(rounds):
        if ledger.awaiting_grant_decision:
            ledger.append_grant()
        ledger.record_failure(round_id, FailureStage.FORMAL_TEST, "failed", MOMENT)
        assert ledger.cumulative_failures == len(set(rounds[: index + 1]))
    assert ledger.cumulative_failures == len(set(rounds))


@given(st.lists(st.integers(min_value=0, max_value=10), min_size=1, max_size=8))
def test_quota_never_exceeds_three_per_grant(grant_sequence: list[int]) -> None:
    ledger = GrantLedger()
    total = 0
    for failures in grant_sequence:
        for _ in range(failures):
            if ledger.awaiting_grant_decision:
                ledger.append_grant()
            ledger.record_failure(f"r-{total}", FailureStage.FORMAL_TEST, "failed", MOMENT)
            total += 1
            assert ledger.cumulative_failures <= 3 * ledger.grant_count
    assert ledger.remaining_in_current_grant <= 3


@given(st.integers(min_value=1, max_value=20))
def test_after_n_grants_cumulative_range_is_bounded(append_count: int) -> None:
    ledger = GrantLedger()
    failures = 0
    for _ in range(3):
        failures += 1
        ledger.record_failure(f"r-{failures}", FailureStage.FORMAL_TEST, "failed", MOMENT)
    assert ledger.awaiting_grant_decision
    for grants_added in range(1, append_count + 1):
        ledger.append_grant()
        # 追加授权不清零：累计保留为 3 x 已授权次数，本次额度恢复为 3。
        assert ledger.cumulative_failures == 3 * grants_added
        assert ledger.remaining_in_current_grant == 3
        for _ in range(3):
            failures += 1
            ledger.record_failure(f"r-{failures}", FailureStage.FORMAL_TEST, "failed", MOMENT)
        assert ledger.awaiting_grant_decision
    assert ledger.grant_count == append_count + 1
    assert ledger.cumulative_failures == 3 * (append_count + 1)


@given(round_ids)
def test_duplicate_round_id_never_increases_cumulative(round_id: str) -> None:
    ledger = GrantLedger()
    ledger.record_failure(round_id, FailureStage.FORMAL_TEST, "failed", MOMENT)
    before = ledger.cumulative_failures
    outcome = ledger.record_failure(round_id, FailureStage.USER_ACCEPTANCE, "repeat", MOMENT)
    assert not outcome.recorded
    assert ledger.cumulative_failures == before


@given(failure_lists)
def test_exhausted_ledger_never_accepts_without_grant(rounds: list[str]) -> None:
    ledger = GrantLedger()
    for round_id in rounds:
        if ledger.awaiting_grant_decision:
            break
        ledger.record_failure(round_id, FailureStage.FORMAL_TEST, "failed", MOMENT)
    # 只有真实计满三轮（去重后）才会等待追加；此时新失败必须被拒绝。
    if ledger.awaiting_grant_decision:
        with pytest.raises(GrantExhaustedError):
            ledger.record_failure("extra", FailureStage.FORMAL_TEST, "failed", MOMENT)
        assert ledger.cumulative_failures == 3
