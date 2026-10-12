"""执行时间限额的单元测试（V0-09 关键路径）。"""

import pytest

from forgeloop.domain.limits import DEFAULT_LIMIT_SECONDS, ExecutionBudget


class TestExecutionBudget:
    def test_default_limit_is_two_hours(self) -> None:
        budget = ExecutionBudget(limit_seconds=DEFAULT_LIMIT_SECONDS)
        assert budget.limit_seconds == 7200.0
        assert budget.can_start_action()

    def test_charge_accumulates_and_exhausts(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0)
        budget.charge(60.0)
        assert budget.consumed_seconds == 60.0
        assert budget.can_start_action()
        budget.charge(40.0)
        assert budget.exhausted
        assert not budget.can_start_action()
        assert budget.remaining_seconds == 0.0

    def test_negative_charge_is_rejected(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0)
        with pytest.raises(ValueError, match="negative"):
            budget.charge(-1.0)

    def test_non_positive_limit_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            ExecutionBudget(limit_seconds=0.0)

    def test_sub_second_limit_is_valid(self) -> None:
        # 正数即合法：亚秒级限额用于极小预算场景。
        budget = ExecutionBudget(limit_seconds=0.5)
        assert budget.can_start_action()

    def test_zero_consumed_default_is_valid(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0)
        assert budget.consumed_seconds == 0.0
        budget.charge(0.0)  # 零耗时动作合法（如瞬时完成的工具）
        assert budget.consumed_seconds == 0.0

    def test_extend_raises_limit_without_resetting_consumption(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0)
        budget.charge(100.0)
        assert budget.exhausted
        budget.extend(200.0)
        assert budget.consumed_seconds == 100.0  # 消耗不清零
        assert budget.can_start_action()

    def test_extend_must_exceed_consumed_time(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0)
        budget.charge(80.0)
        with pytest.raises(ValueError, match="exceed"):
            budget.extend(80.0)
