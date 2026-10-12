"""批准绑定规则：重复或旧版本决定不能重复执行（V0-02/V0-03 关键路径）。"""

from datetime import UTC, datetime

import pytest

from forgeloop.domain.approval import (
    Approval,
    ApprovalBook,
    ApprovalStage,
    ConsumeStatus,
    Plan,
)


def decided_at(minute: int) -> datetime:
    return datetime(2026, 10, 12, 12, minute, tzinfo=UTC)


class TestPlan:
    def test_plan_requires_test_command(self) -> None:
        with pytest.raises(ValueError, match="test command"):
            Plan("task-1", 1, "goal", "scope", "acceptance", ())

    def test_plan_version_must_be_positive(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            Plan("task-1", 0, "goal", "scope", "acceptance", ("pytest",))


class TestApprovalBook:
    def test_consume_ok_marks_used_once(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        first = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert first.status is ConsumeStatus.OK
        assert first.approval is not None and first.approval.plan_version == 1
        assert first.reason == ""
        second = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert second.status is ConsumeStatus.ALREADY_USED
        assert second.approval is not None  # 拒绝结果仍携带对应批准
        assert second.reason  # 拒绝原因非空（供人工核对）

    def test_missing_approval_blocks_execution(self) -> None:
        book = ApprovalBook()
        result = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert result.status is ConsumeStatus.MISSING
        assert "未批准" in result.reason

    def test_stale_version_is_rejected(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        result = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert result.status is ConsumeStatus.STALE
        assert result.approval is not None and result.approval.plan_version == 2
        assert result.reason

    def test_newer_version_consumes_normally(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        assert book.consume("task-1", 2, ApprovalStage.PLAN).status is ConsumeStatus.OK

    def test_recording_older_approval_than_effective_is_rejected(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        with pytest.raises(ValueError, match="older"):
            book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))

    def test_recording_same_version_is_idempotent_update(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(5)))  # 同版本不视为降级
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.decided_at == decided_at(5)

    def test_stages_are_independent(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 3, ApprovalStage.PLAN, decided_at(0)))
        assert book.effective("task-1", ApprovalStage.ACCEPTANCE) is None
        assert book.consume("task-1", 3, ApprovalStage.ACCEPTANCE).status is ConsumeStatus.MISSING

    def test_mark_consumed_rebuilds_state_without_new_approval(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.mark_consumed("task-1", 1, ApprovalStage.PLAN)
        assert book.consume("task-1", 1, ApprovalStage.PLAN).status is ConsumeStatus.ALREADY_USED

    def test_rebuild_keeps_highest_version_effective(self) -> None:
        approvals = (
            Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)),
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.plan_version == 2

    def test_rebuild_is_input_order_independent(self) -> None:
        approvals = (
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)),
            Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.plan_version == 2

    def test_rebuild_keeps_latest_same_version_approval(self) -> None:
        approvals = (
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(0)),
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(5)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.decided_at == decided_at(5)
