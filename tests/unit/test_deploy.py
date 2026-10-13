"""本机部署与回滚领域规则的单元测试（S2 验收要求）。

规则来源：P1 ② 本机部署——只使用同一份已验收产物（校验值不匹配即拒绝，
禁止重新构建）；安装到独立版本目录并原子切换；保留上一版本与可核对的回滚
入口。部署判定必须是布尔契约（allowed 为 bool、reason 恒为非空字符串），
幂等（同版本同产物已激活时不重复安装）与"已激活但产物不同"必须区分。
"""

import hashlib
from dataclasses import replace

from forgeloop.domain.deploy import (
    DeployDecision,
    DeployRequest,
    RollbackRequest,
    check_deploy_readiness,
    check_rollback_readiness,
    parse_checksum_file,
    select_wheel,
)

TAG = "v0.0.1"
VERSION = "0.0.1"
MERGE_COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40
DIGEST = hashlib.sha256(b"wheel-bytes").hexdigest()
OTHER_DIGEST = hashlib.sha256(b"other-bytes").hexdigest()


def _contract(decision: DeployDecision) -> DeployDecision:
    assert isinstance(decision.allowed, bool)
    assert isinstance(decision.noop, bool)
    assert isinstance(decision.reason, str) and decision.reason
    return decision


def deploy_request(**overrides) -> DeployRequest:
    base = DeployRequest(
        tag=TAG,
        version=VERSION,
        source="release",
        release_recorded=True,
        tag_commit=MERGE_COMMIT,
        release_merge_commit=MERGE_COMMIT,
        artifact_sha256=DIGEST,
        published_sha256=DIGEST,
        active_version=None,
        active_sha256=None,
    )
    return replace(base, **overrides)


def deploy(**overrides) -> DeployDecision:
    return _contract(check_deploy_readiness(deploy_request(**overrides)))


def refused_deploy(**overrides) -> DeployDecision:
    decision = deploy(**overrides)
    assert decision.allowed is False
    return decision


def rollback_request(**overrides) -> RollbackRequest:
    base = RollbackRequest(
        target_version="0.0.1",
        active_version="0.0.2",
        installed_digests={"0.0.1": DIGEST, "0.0.2": OTHER_DIGEST},
    )
    return replace(base, **overrides)


def rollback(**overrides) -> DeployDecision:
    return _contract(check_rollback_readiness(rollback_request(**overrides)))


def refused_rollback(**overrides) -> DeployDecision:
    decision = rollback(**overrides)
    assert decision.allowed is False
    return decision


class TestChecksumParsing:
    def test_parses_sha256sum_lines(self) -> None:
        text = f"{DIGEST}  forgeloop-0.0.1-py3-none-any.whl\n{OTHER_DIGEST} *other.tar.gz\n"
        parsed = parse_checksum_file(text)
        assert parsed == {
            "forgeloop-0.0.1-py3-none-any.whl": DIGEST,
            "other.tar.gz": OTHER_DIGEST,
        }

    def test_ignores_blank_and_comment_lines(self) -> None:
        text = f"\n# comment\n{DIGEST}  wheel.whl\n   \n"
        assert parse_checksum_file(text) == {"wheel.whl": DIGEST}

    def test_ignores_malformed_lines(self) -> None:
        assert parse_checksum_file("not-a-checksum-line\n") == {}

    def test_keeps_parsing_after_malformed_line(self) -> None:
        text = f"not-a-checksum-line\n{DIGEST}  wheel.whl\n"
        assert parse_checksum_file(text) == {"wheel.whl": DIGEST}


class TestWheelSelection:
    def test_selects_version_wheel(self) -> None:
        checksums = {
            "forgeloop-0.0.1-py3-none-any.whl": DIGEST,
            "forgeloop-0.0.1.tar.gz": OTHER_DIGEST,
        }
        assert select_wheel(checksums, "0.0.1") == "forgeloop-0.0.1-py3-none-any.whl"

    def test_missing_wheel_returns_none(self) -> None:
        assert select_wheel({"forgeloop-0.0.1.tar.gz": DIGEST}, "0.0.1") is None


class TestDeployReadiness:
    def test_controlled_deploy_is_allowed(self) -> None:
        decision = deploy()
        assert decision.allowed is True
        assert decision.noop is False

    def test_missing_release_record_is_rejected(self) -> None:
        assert "发布回执" in refused_deploy(release_recorded=False).reason

    def test_tag_commit_must_match_release(self) -> None:
        assert "标签" in refused_deploy(tag_commit=OTHER_COMMIT).reason

    def test_artifact_digest_must_match_published(self) -> None:
        assert "校验值" in refused_deploy(artifact_sha256=OTHER_DIGEST).reason

    def test_malformed_digest_is_rejected(self) -> None:
        assert "校验值" in refused_deploy(published_sha256="not-a-digest").reason

    def test_illegal_tag_is_rejected(self) -> None:
        assert "标签" in refused_deploy(tag="0.0.1").reason

    def test_tag_version_mismatch_is_rejected(self) -> None:
        assert "不一致" in refused_deploy(version="0.0.2").reason

    def test_already_active_same_digest_is_noop(self) -> None:
        decision = deploy(active_version=VERSION, active_sha256=DIGEST)
        assert decision.allowed is True
        assert decision.noop is True

    def test_already_active_other_digest_is_rejected(self) -> None:
        decision = refused_deploy(active_version=VERSION, active_sha256=OTHER_DIGEST)
        assert "已激活" in decision.reason
        # 原因里必须能读出两侧的实际校验值（不丢信息、不写成 None）。
        assert OTHER_DIGEST[:12] in decision.reason
        assert DIGEST[:12] in decision.reason


class TestBootstrapDeploy:
    """引导路径：工具自身首次安装没有发布回执，但必须显式标注来源。"""

    def test_bootstrap_without_release_record_is_allowed(self) -> None:
        decision = deploy(source="bootstrap", release_recorded=False)
        assert decision.allowed is True
        assert decision.noop is False

    def test_bootstrap_still_requires_valid_digest(self) -> None:
        decision = refused_deploy(source="bootstrap", artifact_sha256="not-a-digest")
        assert "校验值" in decision.reason

    def test_bootstrap_conflicting_active_version_is_rejected(self) -> None:
        decision = refused_deploy(
            source="bootstrap", active_version=VERSION, active_sha256=OTHER_DIGEST
        )
        assert "已激活" in decision.reason

    def test_unknown_source_is_rejected(self) -> None:
        assert "来源" in refused_deploy(source="whatever").reason


class TestRollbackReadiness:
    def test_rollback_to_installed_version_is_allowed(self) -> None:
        decision = rollback()
        assert decision.allowed is True
        assert decision.noop is False

    def test_rollback_to_active_version_is_rejected(self) -> None:
        assert "当前版本" in refused_rollback(target_version="0.0.2").reason

    def test_rollback_to_uninstalled_version_is_rejected(self) -> None:
        assert "未安装" in refused_rollback(target_version="0.0.9").reason

    def test_rollback_without_digest_record_is_rejected(self) -> None:
        request = rollback_request(installed_digests={"0.0.2": OTHER_DIGEST})
        decision = _contract(check_rollback_readiness(request))
        assert decision.allowed is False
        assert "校验" in decision.reason

    def test_rollback_with_malformed_digest_record_is_rejected(self) -> None:
        request = rollback_request(installed_digests={"0.0.1": "not-a-digest"})
        decision = _contract(check_rollback_readiness(request))
        assert decision.allowed is False
        assert "格式错误" in decision.reason

    def test_rollback_illegal_version_is_rejected(self) -> None:
        assert "版本号" in refused_rollback(target_version="0.1").reason
