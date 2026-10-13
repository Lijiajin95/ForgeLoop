"""受控发布领域规则的单元测试（S1 验收要求）。

规则来源：P1 受控发布——只有已验收并归并、版本一致、main 未漂移、标签未被
占用，且已固化候选 diff 校验值的任务才允许发布；重复发布同标签幂等、换标签
拒绝；校验值必须是内容寻址的稳定值，供部署端核对"同一份验收产物"。

判定契约：``allowed`` 必须是布尔值（不是 None 等假值），``reason`` 必须始终是
非空字符串；漂移与版本不一致的原因里要能读出实际值（短 SHA 12 位、项目版本）。
"""

import hashlib
from dataclasses import replace

from forgeloop.domain.release import (
    ReleaseDecision,
    ReleaseRequest,
    check_release_readiness,
    check_repeat_release,
    parse_version,
    sha256_of_text,
)

MERGE_COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40
DIFF_DIGEST = hashlib.sha256(b"diff --git a/x b/x\n+new\n").hexdigest()


def _assert_decision_contract(decision: ReleaseDecision) -> ReleaseDecision:
    assert isinstance(decision.allowed, bool)
    assert isinstance(decision.reason, str) and decision.reason
    return decision


def request(**overrides) -> ReleaseRequest:
    base = ReleaseRequest(
        task_status="merged",
        acceptance_recorded=True,
        merge_commit=MERGE_COMMIT,
        main_head=MERGE_COMMIT,
        tag="v0.1.0",
        existing_tags=(),
        diff_sha256=DIFF_DIGEST,
        project_version="0.1.0",
    )
    return replace(base, **overrides)


def check(**overrides) -> ReleaseDecision:
    return _assert_decision_contract(check_release_readiness(request(**overrides)))


def refused(**overrides) -> ReleaseDecision:
    decision = check(**overrides)
    assert decision.allowed is False
    return decision


def repeat(existing_tag: str | None, requested_tag: str) -> ReleaseDecision:
    return _assert_decision_contract(check_repeat_release(existing_tag, requested_tag))


class TestVersionParsing:
    def test_accepts_v_semver(self) -> None:
        assert parse_version("v0.0.1") == (0, 0, 1)
        assert parse_version("v10.20.30") == (10, 20, 30)

    def test_rejects_non_semver(self) -> None:
        for tag in ("0.1.0", "v1", "v1.2", "v1.2.3-rc1", "v1.2.3.4", "vv1.2.3", "v1.2.x", ""):
            assert parse_version(tag) is None, tag


class TestDiffDigest:
    def test_digest_is_content_addressed(self) -> None:
        assert sha256_of_text("abc") == sha256_of_text("abc")
        assert sha256_of_text("abc") != sha256_of_text("abd")

    def test_digest_matches_known_vectors(self) -> None:
        assert sha256_of_text("") == (
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        assert sha256_of_text("abc") == (
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )


class TestReleaseReadiness:
    def test_merged_accepted_task_is_allowed(self) -> None:
        decision = check()
        assert decision.allowed is True

    def test_unmerged_task_is_rejected(self) -> None:
        assert "归并" in refused(task_status="delivered").reason

    def test_missing_acceptance_record_is_rejected(self) -> None:
        assert "验收" in refused(acceptance_recorded=False).reason

    def test_missing_merge_commit_is_rejected(self) -> None:
        assert "归并提交" in refused(merge_commit="").reason

    def test_illegal_version_tag_is_rejected(self) -> None:
        assert "版本号" in refused(tag="0.1.0").reason

    def test_existing_tag_is_rejected(self) -> None:
        assert "已存在" in refused(existing_tags=("v0.1.0",)).reason

    def test_tag_must_match_project_version(self) -> None:
        reason = refused(tag="v0.2.0").reason
        assert "项目版本" in reason
        assert "0.1.0" in reason  # 实际项目版本可读出

    def test_unknown_project_version_is_rejected(self) -> None:
        reason = refused(project_version="").reason
        assert "项目版本" in reason
        assert "未知" in reason  # 未知值如实标注，不伪装成具体版本

    def test_main_drift_is_rejected(self) -> None:
        reason = refused(main_head=OTHER_COMMIT).reason
        assert "漂移" in reason
        assert MERGE_COMMIT[:12] in reason and OTHER_COMMIT[:12] in reason

    def test_missing_diff_digest_is_rejected(self) -> None:
        assert "校验值" in refused(diff_sha256="").reason

    def test_malformed_diff_digest_is_rejected(self) -> None:
        assert "校验值" in refused(diff_sha256="not-a-digest").reason


class TestRepeatRelease:
    def test_first_release_is_allowed(self) -> None:
        assert repeat(None, "v0.1.0").allowed is True

    def test_same_tag_is_idempotent(self) -> None:
        decision = repeat("v0.1.0", "v0.1.0")
        assert decision.allowed is True
        assert "幂等" in decision.reason

    def test_other_tag_is_refused(self) -> None:
        decision = repeat("v0.1.0", "v0.2.0")
        assert decision.allowed is False
        assert "v0.1.0" in decision.reason
