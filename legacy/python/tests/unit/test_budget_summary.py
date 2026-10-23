"""工时摘要纯规则的单元测试（V0-09 关键判断）。

摘要只依据权威 budget 行与任务状态派生：无 budget 行且状态表明尚未开始时
标记未开始且不把「无记录」伪装成 0 秒；有 budget 行时输出 limit/consumed/
exhausted；存在性与状态冲突时以存在 budget 行为准输出 unknown 并说明冲突。
"""

import pytest

from forgeloop.domain.budget_summary import (
    BudgetSummary,
    BudgetSummaryState,
    summarize_budget,
)
from forgeloop.domain.limits import ExecutionBudget

SECONDS = ("seconds",)


def _summary(status: str, budget: ExecutionBudget | None = None) -> BudgetSummary:
    return summarize_budget(status, budget)


class TestNotStartedWithoutBudgetRow:
    """无 budget 行且状态明确未开始：标记未开始，不产生 0 秒歧义。"""

    @pytest.mark.parametrize("status", ["pending", "created", "awaiting_plan_approval"])
    def test_unstarted_status_without_budget_is_not_started(self, status: str) -> None:
        summary = _summary(status)
        assert summary.state is BudgetSummaryState.NOT_STARTED
        assert summary.note.strip()

    @pytest.mark.parametrize("status", ["pending", "created", "awaiting_plan_approval"])
    def test_not_started_reports_unknown_values_not_zero(self, status: str) -> None:
        summary = _summary(status)
        assert summary.consumed_seconds is None
        assert summary.limit_seconds is None
        assert summary.exhausted is None

    def test_not_started_note_says_not_started(self) -> None:
        assert "未开始" in _summary("pending").note


class TestBudgetRowPresent:
    """有 budget 行：按权威行输出 limit、consumed 与 exhausted。"""

    def test_partially_consumed_reports_in_progress(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=30.0)
        summary = _summary("implementing", budget)
        assert summary.state is BudgetSummaryState.IN_PROGRESS
        assert summary.consumed_seconds == 30.0
        assert summary.limit_seconds == 100.0
        assert summary.exhausted is False

    def test_exhausted_reports_exhausted(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=100.0)
        summary = _summary("time_exhausted", budget)
        assert summary.state is BudgetSummaryState.EXHAUSTED
        assert summary.consumed_seconds == 100.0
        assert summary.limit_seconds == 100.0
        assert summary.exhausted is True

    def test_over_consumed_is_exhausted(self) -> None:
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=150.0)
        summary = _summary("implementing", budget)
        assert summary.state is BudgetSummaryState.EXHAUSTED
        assert summary.exhausted is True

    def test_zero_consumed_with_budget_row_is_in_progress_not_not_started(self) -> None:
        # 有预算行即已分配工时：0 消耗是真实读数，不是「未开始」。
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=0.0)
        summary = _summary("implementing", budget)
        assert summary.state is BudgetSummaryState.IN_PROGRESS
        assert summary.consumed_seconds == 0.0


class TestExistenceStatusConflict:
    """状态与 budget 行存在性冲突：以存在 budget 行为准，输出 unknown 并说明冲突。"""

    @pytest.mark.parametrize("status", ["implementing", "testing", "delivered", "mystery"])
    def test_started_status_without_budget_is_unknown_conflict(self, status: str) -> None:
        summary = _summary(status)
        assert summary.state is BudgetSummaryState.UNKNOWN
        assert summary.consumed_seconds is None
        assert summary.limit_seconds is None
        assert summary.exhausted is None
        assert "冲突" in summary.note
        assert status in summary.note

    @pytest.mark.parametrize("status", ["pending", "created", "awaiting_plan_approval"])
    def test_budget_row_with_unstarted_status_is_unknown_conflict(self, status: str) -> None:
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=10.0)
        summary = _summary(status, budget)
        assert summary.state is BudgetSummaryState.UNKNOWN
        assert "冲突" in summary.note
        assert status in summary.note

    def test_conflict_takes_existing_budget_row_as_authoritative(self) -> None:
        # 存在 budget 行是更强的信号：冲突时仍输出该行的权威读数，状态标记为 unknown。
        budget = ExecutionBudget(limit_seconds=100.0, consumed_seconds=10.0)
        summary = _summary("pending", budget)
        assert summary.consumed_seconds == 10.0
        assert summary.limit_seconds == 100.0
        assert summary.exhausted is False


class TestDimensions:
    """dimensions 当前仅含 seconds，不推测、不臆造其他维度。"""

    @pytest.mark.parametrize(
        ("status", "budget"),
        [
            ("pending", None),
            ("implementing", ExecutionBudget(limit_seconds=100.0, consumed_seconds=10.0)),
            ("time_exhausted", ExecutionBudget(limit_seconds=100.0, consumed_seconds=100.0)),
            ("implementing", None),
        ],
    )
    def test_only_seconds_dimension_is_declared(
        self, status: str, budget: ExecutionBudget | None
    ) -> None:
        assert _summary(status, budget).dimensions == SECONDS
