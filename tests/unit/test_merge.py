"""main 受控归并领域规则的单元测试（B04 验收要求）。"""

from forgeloop.domain.merge import MergeDecision, check_merge_readiness

BASE = "a" * 40
OTHER = "b" * 40


def check(**overrides) -> MergeDecision:
    kwargs = {
        "task_status": "delivered",
        "acceptance_recorded": True,
        "baseline_commit": BASE,
        "main_head": BASE,
        "diff_text": "diff --git a/x b/x\n+new\n",
    }
    kwargs.update(overrides)
    return check_merge_readiness(**kwargs)


class TestMergeReadiness:
    def test_delivered_matching_baseline_allows_merge(self) -> None:
        decision = check()
        assert decision.allowed

    def test_not_delivered_is_rejected(self) -> None:
        decision = check(task_status="awaiting_acceptance")
        assert not decision.allowed
        assert "未经验收" in decision.reason

    def test_missing_acceptance_record_is_rejected(self) -> None:
        decision = check(acceptance_recorded=False)
        assert not decision.allowed
        assert "验收批准" in decision.reason

    def test_missing_baseline_is_rejected(self) -> None:
        decision = check(baseline_commit="")
        assert not decision.allowed
        assert "基线" in decision.reason

    def test_empty_diff_is_rejected(self) -> None:
        decision = check(diff_text="   \n")
        assert not decision.allowed
        assert "diff 为空" in decision.reason

    def test_main_drift_is_rejected(self) -> None:
        decision = check(main_head=OTHER)
        assert not decision.allowed
        assert "漂移" in decision.reason
        assert BASE[:12] in decision.reason and OTHER[:12] in decision.reason
