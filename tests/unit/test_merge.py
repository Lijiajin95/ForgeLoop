"""main 受控归并领域规则的单元测试（B04 验收要求）。

覆盖两部分：归并前置判定（验收、基线、漂移）与 S3 候选分支流程所需的
"必需检查判定"（通过/未完成/失败/缺失）和候选分支命名规则。
"""

from forgeloop.cli.merge import CHECK_POLL_MAX_SECONDS, check_poll_delay
from forgeloop.domain.delivery import build_binding
from forgeloop.domain.merge import (
    ChecksDecision,
    MergeDecision,
    candidate_branch_name,
    check_acceptance_content,
    check_merge_readiness,
    check_required_checks,
)

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
    decision = check_merge_readiness(**kwargs)
    assert isinstance(decision.allowed, bool)
    assert isinstance(decision.reason, str) and decision.reason
    return decision


def refused(**overrides) -> MergeDecision:
    decision = check(**overrides)
    assert decision.allowed is False
    return decision


def checks(required, runs) -> ChecksDecision:
    decision = check_required_checks(required, runs)
    assert isinstance(decision.passed, bool)
    assert isinstance(decision.pending, bool)
    assert isinstance(decision.reason, str) and decision.reason
    return decision


class TestMergeReadiness:
    def test_delivered_matching_baseline_allows_merge(self) -> None:
        assert check().allowed is True

    def test_not_delivered_is_rejected(self) -> None:
        assert "未经验收" in refused(task_status="awaiting_acceptance").reason

    def test_missing_acceptance_record_is_rejected(self) -> None:
        assert "验收批准" in refused(acceptance_recorded=False).reason

    def test_missing_baseline_is_rejected(self) -> None:
        assert "基线" in refused(baseline_commit="").reason

    def test_empty_diff_is_rejected(self) -> None:
        assert "diff 为空" in refused(diff_text="   \n").reason

    def test_main_drift_is_rejected(self) -> None:
        decision = refused(main_head=OTHER)
        assert "漂移" in decision.reason
        assert BASE[:12] in decision.reason and OTHER[:12] in decision.reason


REQUIRED = ("quality", "security", "commit-policy")


class TestCandidateBranchName:
    def test_branch_name_is_derived_from_task(self) -> None:
        assert candidate_branch_name("task-20261013-abcdef") == "forgeloop/task-20261013-abcdef"


class TestRequiredChecks:
    """S3 候选分支流程的检查判定：全部必需检查成功才允许快进 main。"""

    def test_all_successful_passes(self) -> None:
        runs: dict[str, str] = dict.fromkeys(REQUIRED, "success")
        decision = checks(REQUIRED, runs)
        assert decision.passed is True
        assert decision.pending is False
        assert decision.reason

    def test_neutral_and_skipped_count_as_passing(self) -> None:
        runs = {"quality": "success", "security": "neutral", "commit-policy": "skipped"}
        assert checks(REQUIRED, runs).passed is True

    def test_in_progress_is_pending(self) -> None:
        runs = {"quality": "success", "security": "pending", "commit-policy": "success"}
        decision = checks(REQUIRED, runs)
        assert decision.passed is False
        assert decision.pending is True
        assert "security" in decision.reason

    def test_missing_check_is_pending(self) -> None:
        decision = checks(REQUIRED, {"quality": "success"})
        assert decision.passed is False
        assert decision.pending is True
        assert "security" in decision.reason and "commit-policy" in decision.reason

    def test_failed_check_is_not_pending(self) -> None:
        runs = {"quality": "success", "security": "failure", "commit-policy": "success"}
        decision = checks(REQUIRED, runs)
        assert decision.passed is False
        assert decision.pending is False
        assert "security" in decision.reason

    def test_cancelled_check_counts_as_failure(self) -> None:
        runs = {"quality": "cancelled", "security": "success", "commit-policy": "success"}
        decision = checks(REQUIRED, runs)
        assert decision.passed is False
        assert decision.pending is False

    def test_unknown_conclusion_is_rejected(self) -> None:
        # 结论不在已知集合内（如 GitHub 的 startup_failure）既不算通过也不算等待。
        runs = {"quality": "success", "security": "startup_failure", "commit-policy": "success"}
        decision = checks(REQUIRED, runs)
        assert decision.passed is False
        assert decision.pending is False
        assert "security" in decision.reason

    def test_unrecognized_conclusion_is_rejected(self) -> None:
        runs = {"quality": "success", "security": "mystery", "commit-policy": "success"}
        decision = checks(REQUIRED, runs)
        assert decision.passed is False
        assert decision.pending is False
        assert "未知" in decision.reason and "security" in decision.reason

    def test_no_required_checks_passes_immediately(self) -> None:
        decision = checks((), {})
        assert decision.passed is True
        assert decision.pending is False


class TestAcceptanceContent:
    """K11：归并必须绑定与验收同一候选；材料被换掉即拒绝。"""

    @staticmethod
    def approved(**overrides):
        kwargs = {
            "candidate_text": "diff --git a/x b/x\n+new\n",
            "test_evidence_text": '{"exit_code": 0}\n',
            "review_text": '{"blocking_issues": []}\n',
            "baseline_commit": BASE,
        }
        kwargs.update(overrides)
        return build_binding("task-1", 1, **kwargs)

    def test_matching_content_passes(self) -> None:
        approved = self.approved()
        current = self.approved()
        decision = check_acceptance_content(approved, current)
        assert decision.allowed is True
        assert isinstance(decision.reason, str) and decision.reason

    def test_replaced_candidate_is_rejected(self) -> None:
        approved = self.approved()
        current = self.approved(candidate_text="diff --git a/x b/x\n+tampered\n")
        decision = check_acceptance_content(approved, current)
        assert decision.allowed is False
        assert "漂移" in decision.reason

    def test_changed_baseline_is_rejected(self) -> None:
        approved = self.approved()
        current = self.approved(baseline_commit=OTHER)
        decision = check_acceptance_content(approved, current)
        assert decision.allowed is False
        assert "基线" in decision.reason

    def test_artifact_digest_difference_is_not_drift(self) -> None:
        """产物校验值在验收时可能尚未生成：归并阶段不据它判漂移。"""

        approved = self.approved(artifact_sha256="a" * 64)
        current = self.approved(artifact_sha256="b" * 64)
        decision = check_acceptance_content(approved, current)
        assert decision.allowed is True

    def test_changed_test_evidence_is_rejected(self) -> None:
        approved = self.approved()
        current = self.approved(test_evidence_text='{"exit_code": 1}\n')
        decision = check_acceptance_content(approved, current)
        assert decision.allowed is False
        assert "漂移" in decision.reason


class TestCheckPollDelay:
    """轮询等待：线性退避，保证匿名检查读取不耗尽 60 次/小时的配额。"""

    def test_delay_grows_linearly(self) -> None:
        assert [check_poll_delay(n, 30.0) for n in (1, 2, 3, 4)] == [30.0, 60.0, 90.0, 120.0]

    def test_delay_is_capped(self) -> None:
        assert check_poll_delay(50, 30.0) == CHECK_POLL_MAX_SECONDS

    def test_zero_base_disables_waiting(self) -> None:
        assert check_poll_delay(3, 0.0) == 0.0

    def test_full_timeout_wait_stays_within_anonymous_quota(self) -> None:
        waited = 0.0
        polls = 0
        while waited < 1800.0:
            polls += 1
            waited += check_poll_delay(polls, 30.0)
        assert polls <= 15, f"1800s 内轮询 {polls} 次，接近匿名配额 60 次/小时"
