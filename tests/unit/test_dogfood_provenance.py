"""DogFood 来源回执与门禁的单元测试（C04）。

覆盖纯规则：回执签名/解码、字段与受控身份校验、回执 trailer 提取、缺密钥的
fail-closed 行为，以及禁用策略只报告“待启用”。真实 git 现场、内容漂移与端到端
拒绝在 tests/scenario/test_dogfood_gate.py 覆盖。
"""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

from forgeloop.cli.merge import (
    DEFAULT_PROVENANCE_POLICY,
    ProvenancePolicy,
    attach_provenance,
    build_provenance_payload,
    canonical_payload,
    decode_receipt,
    load_provenance_policy,
    receipt_values,
    sign_payload,
    validate_provenance_payload,
)
from forgeloop.domain.delivery import DeliveryBinding

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
KEY = b"unit-test-signing-key"


def load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "check_dogfood_provenance", SCRIPTS / "check_dogfood_provenance.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


def payload(**overrides: object) -> dict[str, object]:
    document: dict[str, object] = {
        "schema": 1,
        "task_id": "task-20261014120000-abcdef",
        "requirement_id": "req-forgeloop-1",
        "plan_version": 1,
        "baseline_commit": "d" * 40,
        "candidate_sha256": "a" * 64,
        "test_evidence_sha256": "b" * 64,
        "review_sha256": "c" * 64,
        "approval_fingerprint": "e" * 64,
    }
    document.update(overrides)
    return document


def binding() -> DeliveryBinding:
    return DeliveryBinding(
        task_id="task-20261014120000-abcdef",
        plan_version=3,
        candidate_sha256="a" * 64,
        test_evidence_sha256="b" * 64,
        review_sha256="c" * 64,
        baseline_commit="d" * 40,
    )


class TestReceiptSignature:
    def test_canonical_payload_ignores_key_order(self) -> None:
        assert canonical_payload({"b": 1, "a": 2}) == canonical_payload({"a": 2, "b": 1})

    def test_signed_receipt_round_trips(self) -> None:
        decoded, reason = decode_receipt(sign_payload(payload(), KEY), KEY)
        assert reason == ""
        assert decoded == payload()

    def test_wrong_key_is_rejected(self) -> None:
        decoded, reason = decode_receipt(sign_payload(payload(), KEY), b"attacker-key")
        assert decoded is None
        assert "签名无效" in reason

    def test_tampered_payload_is_rejected(self) -> None:
        value = sign_payload(payload(), KEY)
        encoded, _, digest = value.rpartition(".")
        tampered = ("A" if encoded[0] != "A" else "B") + encoded[1:] + "." + digest
        decoded, reason = decode_receipt(tampered, KEY)
        assert decoded is None
        assert reason

    def test_malformed_receipt_is_rejected(self) -> None:
        for value in ("", "not-a-receipt", "abc.def"):
            decoded, reason = decode_receipt(value, KEY)
            assert decoded is None
            assert reason

    def test_receipt_values_extracts_all_trailers(self) -> None:
        assert receipt_values("feat: x\n", "ForgeLoop-Provenance") == []
        assert receipt_values("feat: x\n\nForgeLoop-Provenance: one\n", "ForgeLoop-Provenance") == [
            "one",
        ]
        assert receipt_values(
            "ForgeLoop-Provenance: one\nForgeLoop-Provenance: two\n",
            "ForgeLoop-Provenance",
        ) == ["one", "two"]


class TestPayloadValidation:
    def test_well_formed_payload_passes(self) -> None:
        assert validate_provenance_payload(DEFAULT_PROVENANCE_POLICY, payload()) == (True, "")

    def test_missing_field_is_rejected(self) -> None:
        document = payload()
        del document["test_evidence_sha256"]
        valid, reason = validate_provenance_payload(DEFAULT_PROVENANCE_POLICY, document)
        assert valid is False
        assert "缺少字段" in reason

    def test_non_controlled_task_id_is_rejected(self) -> None:
        valid, reason = validate_provenance_payload(
            DEFAULT_PROVENANCE_POLICY, payload(task_id="manual-补挂")
        )
        assert valid is False
        assert "补挂" in reason

    def test_invalid_plan_version_is_rejected(self) -> None:
        for value in (0, -1, "1", True):
            valid, _ = validate_provenance_payload(
                DEFAULT_PROVENANCE_POLICY, payload(plan_version=value)
            )
            assert valid is False

    def test_bad_baseline_and_digest_are_rejected(self) -> None:
        assert (
            validate_provenance_payload(DEFAULT_PROVENANCE_POLICY, payload(baseline_commit="xyz"))[
                0
            ]
            is False
        )
        assert (
            validate_provenance_payload(
                DEFAULT_PROVENANCE_POLICY, payload(candidate_sha256="short")
            )[0]
            is False
        )


class TestPayloadBuildAndAttach:
    def test_payload_binds_acceptance_binding(self) -> None:
        current = binding()
        document = build_provenance_payload(current, "req-forgeloop-1", "d" * 40)
        assert document["task_id"] == current.task_id
        assert document["plan_version"] == current.plan_version
        assert document["candidate_sha256"] == current.candidate_sha256
        assert document["approval_fingerprint"] == current.fingerprint

    def test_attach_without_key_and_disabled_leaves_message(self) -> None:
        message, error = attach_provenance("feat: x", DEFAULT_PROVENANCE_POLICY, payload())
        assert message == "feat: x"
        assert error == ""

    def test_attach_disabled_with_key_appends_signed_trailer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(DEFAULT_PROVENANCE_POLICY.signing_key_env, KEY.decode())
        message, error = attach_provenance("feat: x", DEFAULT_PROVENANCE_POLICY, payload())
        assert error == ""
        values = receipt_values(message, DEFAULT_PROVENANCE_POLICY.trailer_name)
        assert len(values) == 1
        decoded, reason = decode_receipt(values[0], KEY)
        assert reason == ""
        assert decoded == payload()

    def test_attach_enabled_without_key_fails_closed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(DEFAULT_PROVENANCE_POLICY.signing_key_env, raising=False)
        policy = ProvenancePolicy(
            enabled=True,
            signing_key_env=DEFAULT_PROVENANCE_POLICY.signing_key_env,
            trailer_name=DEFAULT_PROVENANCE_POLICY.trailer_name,
            task_id_prefix=DEFAULT_PROVENANCE_POLICY.task_id_prefix,
            required_fields=DEFAULT_PROVENANCE_POLICY.required_fields,
        )
        message, error = attach_provenance("feat: x", policy, payload())
        assert message == "feat: x"
        assert "缺少签名密钥" in error


class TestPolicyLoading:
    def test_shipped_policy_is_disabled_and_names_key_env(self) -> None:
        policy = load_provenance_policy(ROOT / "config" / "dogfood-policy.toml")
        assert policy.enabled is False
        assert policy.signing_key_env == "FORGELOOP_DOGFOOD_SIGNING_KEY"
        assert policy.trailer_name == "ForgeLoop-Provenance"

    def test_missing_policy_file_is_disabled(self, tmp_path: Path) -> None:
        policy = load_provenance_policy(tmp_path / "missing.toml")
        assert policy == DEFAULT_PROVENANCE_POLICY

    def test_enabled_policy_read_from_file(self, tmp_path: Path) -> None:
        config = tmp_path / "policy.toml"
        config.write_text(
            'enabled = true\nsigning_key_env = "MY_KEY"\ntask_id_prefix = "dog-"\n',
            encoding="utf-8",
        )
        policy = load_provenance_policy(config)
        assert policy.enabled is True
        assert policy.signing_key_env == "MY_KEY"
        assert policy.task_id_prefix == "dog-"

    def test_non_boolean_enabled_is_rejected(self, tmp_path: Path) -> None:
        config = tmp_path / "policy.toml"
        config.write_text('enabled = "yes"\n', encoding="utf-8")
        with pytest.raises(ValueError, match="enabled"):
            load_provenance_policy(config)

    def test_invalid_required_fields_is_rejected(self, tmp_path: Path) -> None:
        config = tmp_path / "policy.toml"
        config.write_text('required_fields = "task_id"\n', encoding="utf-8")
        with pytest.raises(ValueError, match="required_fields"):
            load_provenance_policy(config)


class TestGateMain:
    def test_disabled_policy_reports_pending_and_allows(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
    ) -> None:
        config = tmp_path / "policy.toml"
        config.write_text("enabled = false\n", encoding="utf-8")
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "gate",
                "--policy",
                str(config),
                "--repo",
                str(ROOT),
                "--audit",
                "HEAD",
                "HEAD",
            ],
        )
        assert gate.main() == 0
        assert "未启用" in capsys.readouterr().err

    def test_enabled_policy_without_key_is_fail_closed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
    ) -> None:
        config = tmp_path / "policy.toml"
        config.write_text(
            'enabled = true\nsigning_key_env = "ABSENT_DOGFOOD_KEY"\n', encoding="utf-8"
        )
        monkeypatch.delenv("ABSENT_DOGFOOD_KEY", raising=False)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "gate",
                "--policy",
                str(config),
                "--repo",
                str(ROOT),
                "--audit",
                "HEAD",
                "HEAD",
            ],
        )
        assert gate.main() == 1
        assert "缺少签名密钥" in capsys.readouterr().err
