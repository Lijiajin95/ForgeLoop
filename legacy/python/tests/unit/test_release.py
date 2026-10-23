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
    check_release_artifact,
    check_release_readiness,
    check_release_retry,
    check_repeat_release,
    parse_version,
    sha256_of_text,
)

MERGE_COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40
DIFF_DIGEST = hashlib.sha256(b"diff --git a/x b/x\n+new\n").hexdigest()
ARTIFACT_DIGEST = hashlib.sha256(b"forgeloop-0.1.0-py3-none-any.whl").hexdigest()
OTHER_ARTIFACT_DIGEST = hashlib.sha256(b"forgeloop-0.1.0-py3-none-any.whl#rebuilt").hexdigest()


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


def artifact(
    version: str = "0.1.0",
    wheel_name: str | None = None,
    artifact_sha256: str | None = None,
    accepted_sha256: str | None = None,
) -> ReleaseDecision:
    """按版本推导规范 wheel 名，未显式给出校验值时用同一份已验收产物。"""

    return _assert_decision_contract(
        check_release_artifact(
            version,
            f"forgeloop-{version}-py3-none-any.whl" if wheel_name is None else wheel_name,
            ARTIFACT_DIGEST if artifact_sha256 is None else artifact_sha256,
            ARTIFACT_DIGEST if accepted_sha256 is None else accepted_sha256,
        )
    )


def retry(
    existing_tag: str | None = "v0.1.0",
    requested_tag: str = "v0.1.0",
    published: str | None = None,
    current: str | None = None,
) -> ReleaseDecision:
    return _assert_decision_contract(
        check_release_retry(
            existing_tag,
            requested_tag,
            ARTIFACT_DIGEST if published is None else published,
            ARTIFACT_DIGEST if current is None else current,
        )
    )


class TestReleaseArtifactIdentity:
    """发布必须复用 C01 已验收的同一份 wheel（K12）。"""

    def test_accepted_artifact_is_allowed(self) -> None:
        decision = artifact()
        assert decision.allowed is True
        assert ARTIFACT_DIGEST[:12] in decision.reason

    def test_wheel_name_is_derived_from_the_version(self) -> None:
        assert artifact(version="1.2.3").allowed is True
        assert (
            artifact(version="0.1.0", wheel_name="forgeloop-1.2.3-py3-none-any.whl").allowed
            is False
        )

    def test_absent_acceptance_digest_only_checks_the_artifact(self) -> None:
        # 没有验收绑定（accepted_sha256 为空）时只核对产物自身身份，不假装比对过。
        assert artifact(accepted_sha256="").allowed is True

    def test_missing_artifact_digest_is_refused(self) -> None:
        decision = artifact(artifact_sha256="")
        assert decision.allowed is False
        assert "校验值" in decision.reason

    def test_malformed_artifact_digest_is_refused(self) -> None:
        for digest in ("not-a-digest", ARTIFACT_DIGEST.upper(), ARTIFACT_DIGEST[:-1], "z" * 64):
            assert artifact(artifact_sha256=digest).allowed is False, digest

    def test_wheel_name_mismatch_is_refused(self) -> None:
        decision = artifact(wheel_name="forgeloop-0.1.0-py3-none-any.tar.gz")
        assert decision.allowed is False
        assert "forgeloop-0.1.0-py3-none-any.whl" in decision.reason

    def test_empty_wheel_name_is_refused(self) -> None:
        assert artifact(wheel_name="").allowed is False

    def test_malformed_acceptance_digest_is_refused(self) -> None:
        decision = artifact(accepted_sha256="x" * 64)
        assert decision.allowed is False
        assert "验收产物" in decision.reason

    def test_artifact_different_from_accepted_is_refused(self) -> None:
        decision = artifact(accepted_sha256=OTHER_ARTIFACT_DIGEST)
        assert decision.allowed is False
        assert ARTIFACT_DIGEST[:12] in decision.reason
        assert OTHER_ARTIFACT_DIGEST[:12] in decision.reason


class TestReleaseRetryIdentity:
    """同标签重试幂等，但重试产物必须仍是已发布的那一份（K12）。"""

    def test_other_tag_conflict_is_reported_as_a_tag_conflict(self) -> None:
        """换标签重复发布时先按标签冲突拒绝：原因里要能读出请求的标签。"""

        decision = retry(requested_tag="v0.2.0", current=OTHER_ARTIFACT_DIGEST)
        assert decision.allowed is False
        assert "v0.2.0" in decision.reason

    def test_first_release_delegates_to_repeat_release(self) -> None:
        decision = retry(existing_tag=None)
        assert decision.allowed is True
        assert "首次发布" in decision.reason

    def test_other_tag_is_refused(self) -> None:
        decision = retry(requested_tag="v0.2.0")
        assert decision.allowed is False
        assert "v0.1.0" in decision.reason

    def test_same_tag_with_the_same_artifact_is_idempotent(self) -> None:
        decision = retry()
        assert decision.allowed is True
        assert "幂等" in decision.reason

    def test_same_tag_with_another_artifact_is_refused(self) -> None:
        decision = retry(current=OTHER_ARTIFACT_DIGEST)
        assert decision.allowed is False
        assert ARTIFACT_DIGEST[:12] in decision.reason
        assert OTHER_ARTIFACT_DIGEST[:12] in decision.reason

    def test_malformed_published_digest_falls_back_to_idempotent(self) -> None:
        assert retry(published="not-a-digest").allowed is True

    def test_malformed_current_digest_falls_back_to_idempotent(self) -> None:
        assert retry(current="not-a-digest").allowed is True
