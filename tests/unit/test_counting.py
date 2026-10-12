"""失败轮次与追加授权账本的单元测试（V0-06 关键路径）。"""

from datetime import UTC, datetime

import pytest

from forgeloop.domain.counting import (
    MAX_ROUNDS_PER_GRANT,
    FailureStage,
    GrantExhaustedError,
    GrantLedger,
)


def moment(minute: int) -> datetime:
    return datetime(2026, 10, 12, 12, minute, tzinfo=UTC)


class TestInitialGrant:
    def test_initial_grant_allows_three_rounds(self) -> None:
        ledger = GrantLedger()
        assert ledger.grant_count == 1
        assert ledger.cumulative_failures == 0
        assert ledger.remaining_in_current_grant == MAX_ROUNDS_PER_GRANT
        assert not ledger.awaiting_grant_decision

    def test_three_failures_exhaust_the_grant(self) -> None:
        ledger = GrantLedger()
        for index in range(3):
            outcome = ledger.record_failure(
                f"candidate-{index + 1}", FailureStage.FORMAL_TEST, "test failed", moment(index)
            )
            assert outcome.recorded
            assert outcome.cumulative_failures == index + 1
        assert ledger.cumulative_failures == 3
        assert ledger.awaiting_grant_decision
        assert ledger.consumed_in_current_grant == 3

    def test_fourth_failure_is_rejected_without_grant(self) -> None:
        ledger = GrantLedger()
        for index in range(3):
            ledger.record_failure(
                f"candidate-{index + 1}", FailureStage.FORMAL_TEST, "failed", moment(index)
            )
        with pytest.raises(GrantExhaustedError):
            ledger.record_failure("candidate-4", FailureStage.FORMAL_TEST, "failed", moment(9))


class TestDedup:
    def test_repeated_feedback_within_same_round_counts_once(self) -> None:
        ledger = GrantLedger()
        ledger.record_failure(
            "candidate-1", FailureStage.FORMAL_TEST, "two cases failed", moment(1)
        )
        outcome = ledger.record_failure(
            "candidate-1", FailureStage.USER_ACCEPTANCE, "重复反馈", moment(2)
        )
        assert outcome.recorded is False  # 严格布尔契约
        assert ledger.cumulative_failures == 1

    def test_recorded_round_preserves_all_fields(self) -> None:
        ledger = GrantLedger()
        at = moment(7)
        outcome = ledger.record_failure("candidate-9", FailureStage.FORMAL_TEST, "summary", at)
        assert outcome.recorded is True
        round_ = ledger.rounds[0]
        assert round_.round_id == "candidate-9"
        assert round_.stage is FailureStage.FORMAL_TEST
        assert round_.summary == "summary"
        assert round_.occurred_at == at

    def test_user_acceptance_failure_counts_as_round(self) -> None:
        ledger = GrantLedger()
        ledger.record_failure(
            "candidate-1", FailureStage.USER_ACCEPTANCE, "用户验收拒绝", moment(1)
        )
        assert ledger.cumulative_failures == 1
        assert ledger.rounds[0].stage is FailureStage.USER_ACCEPTANCE


class TestAppendGrant:
    def test_append_grant_extends_quota_without_reset(self) -> None:
        ledger = GrantLedger()
        for index in range(3):
            ledger.record_failure(
                f"candidate-{index + 1}", FailureStage.FORMAL_TEST, "failed", moment(index)
            )
        ledger.append_grant()
        assert ledger.grant_count == 2
        assert ledger.cumulative_failures == 3  # 累计不清零
        assert ledger.remaining_in_current_grant == 3
        assert not ledger.awaiting_grant_decision
        outcome = ledger.record_failure(
            "candidate-4", FailureStage.FORMAL_TEST, "failed", moment(9)
        )
        assert outcome.recorded
        assert ledger.cumulative_failures == 4  # 第二次授权的累计范围 4-6

    def test_cumulative_ranges_follow_documented_sequence(self) -> None:
        ledger = GrantLedger()
        for grant in range(3):  # 初始 + 两次追加
            for index in range(3):
                round_index = grant * 3 + index + 1
                if ledger.awaiting_grant_decision:
                    ledger.append_grant()
                ledger.record_failure(
                    f"candidate-{round_index}", FailureStage.FORMAL_TEST, "failed", moment(1)
                )
        assert ledger.grant_count == 3
        assert ledger.cumulative_failures == 9  # 1-3, 4-6, 7-9


class TestConstruction:
    def test_at_least_one_grant_required(self) -> None:
        with pytest.raises(ValueError, match="initial grant"):
            GrantLedger(grants=0)

    def test_rounds_exceeding_quota_rejected(self) -> None:
        from forgeloop.domain.counting import FailureRound

        rounds = tuple(
            FailureRound(f"candidate-{n}", FailureStage.FORMAL_TEST, "failed", moment(1))
            for n in range(4)
        )
        with pytest.raises(ValueError, match="exceed the granted quota"):
            GrantLedger(grants=1, rounds=rounds)
