"""升级纯规则分支补充：非法输入、不可读证据与主入口拒绝路径。"""

from typing import Any

import pytest

from forgeloop.domain.upgrade import (
    ArtifactManifest,
    OwnerBinding,
    UpgradeError,
    UpgradeIdentity,
    UpgradeRequest,
    UpgradeRequestError,
    UpgradeState,
    UpgradeStateError,
    _absolute_path,
    _require_mapping,
    admission_decision,
    drain_decision,
    manifest_problem,
    parse_upgrade_request,
    readiness_problem,
    require_transition,
    switch_decision,
    transition_problem,
)

DIGEST = "a" * 64
COMMIT = "b" * 40
PREFIX = "/tmp/forgeloop-prefix"
RECORDS = "/tmp/records/projects/forgeloop"


def _identity(**overrides: Any) -> UpgradeIdentity:
    data: dict[str, Any] = {
        "version": "0.0.2",
        "tag": "v0.0.2",
        "artifact_sha256": DIGEST,
        "build_commit": COMMIT,
        "generation": "gen-000002",
    }
    data.update(overrides)
    return UpgradeIdentity(**data)


def _state(**overrides: Any) -> UpgradeState:
    data: dict[str, Any] = {
        "identity": _identity(),
        "project": "forgeloop",
        "prefix": PREFIX,
        "records_root": RECORDS,
        "phase": "committed",
        "generation": "gen-000002",
    }
    data.update(overrides)
    return UpgradeState(**data)


def _ready(**overrides: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schema_version": 1,
        "ready": True,
        "pid": 1,
        "generation": "gen-000002",
        "version": "0.0.2",
        "tag": "v0.0.2",
        "artifact_sha256": DIGEST,
        "build_commit": COMMIT,
        "project": "forgeloop",
        "prefix": PREFIX,
        "records_root": RECORDS,
        "module_path": "/tmp/release/lib/forgeloop/__init__.py",
    }
    report.update(overrides)
    return report


def test_absolute_path_and_unknown_fields() -> None:
    for value in ("/tmp/a\nb", "/tmp/a\x00b", "/tmp/../etc"):
        with pytest.raises(UpgradeError):
            _absolute_path(value, "prefix")
    with pytest.raises(UpgradeError):
        _require_mapping({1: "x"}, "测试")


def test_identity_and_state_document_errors() -> None:
    with pytest.raises(UpgradeStateError):
        UpgradeIdentity.from_document({"version": "0.0.2"})
    with pytest.raises(UpgradeStateError):
        UpgradeState.from_document({"identity": _identity().to_document()})
    with pytest.raises(UpgradeStateError):
        _state(project="bad id")
    with pytest.raises(UpgradeStateError):
        _state(child_pid=0)
    with pytest.raises(UpgradeStateError):
        _state(upgrade_key="not-hex")
    with pytest.raises(UpgradeStateError):
        _state(previous=_identity())


def test_transition_and_admission_edges() -> None:
    assert transition_problem("unknown", "committed")
    with pytest.raises(UpgradeStateError):
        require_transition("committed", "unknown")
    decision = admission_decision(
        managed=True,
        phase="unknown",
        generation="gen-000002",
        process_generation="gen-000002",
    )
    assert decision.allowed is False
    assert "未知升级阶段" in decision.reason


def test_switch_same_target_is_noop() -> None:
    state = _state()
    request = UpgradeRequest(
        request_id="req-12345678",
        project="forgeloop",
        prefix=PREFIX,
        tag="v0.0.2",
        artifact_sha256=DIGEST,
        by="owner",
        reason="test",
    )
    decision = switch_decision(state, request)
    assert decision.allowed is True
    assert decision.noop is True


def test_parse_request_wraps_path_error() -> None:
    with pytest.raises(UpgradeRequestError, match="prefix"):
        parse_upgrade_request(
            {
                "request_id": "req-12345678",
                "project": "forgeloop",
                "prefix": "/tmp/a\nb",
                "tag": "v0.0.2",
                "artifact_sha256": DIGEST,
                "by": "owner",
                "reason": "test",
                "protocol_version": 1,
            }
        )


def test_drain_decision_rejections() -> None:
    base = {
        "schema_version": 1,
        "generation": "gen-000002",
        "pid": 1,
        "completed": True,
        "active_calls": 0,
        "active_turns": 0,
        "active_agent_processes": 0,
        "pending_requests": 0,
    }
    kwargs: dict[str, Any] = dict(
        expected_generation="gen-000002", expected_pid=1, outstanding_actions=0
    )
    assert drain_decision(None, **kwargs).proceed is False
    assert drain_decision(base, **kwargs).proceed is True
    for changed in (
        {"schema_version": 2},
        {"generation": "gen-000003"},
        {"pid": 2},
        {"completed": False},
        {"active_calls": 1},
        {"unknown": 1},
    ):
        report = dict(base)
        report.update(changed)
        if changed == {"unknown": 1}:
            with pytest.raises(UpgradeError):
                drain_decision(report, **kwargs)
        else:
            assert drain_decision(report, **kwargs).proceed is False


def test_ready_report_errors(tmp_path) -> None:
    release = tmp_path / "release"
    release.mkdir()
    expected = _identity()
    kwargs: dict[str, Any] = dict(
        expected=expected,
        expected_pid=1,
        project="forgeloop",
        prefix=PREFIX,
        records_root=RECORDS,
        release_dir=release,
    )
    assert readiness_problem(None, **kwargs) == "尚未取得就绪报告"
    assert "schema_version" in readiness_problem(_ready(schema_version=2), **kwargs)
    assert "进程" in readiness_problem(_ready(pid=2), **kwargs)
    assert "generation" in readiness_problem(_ready(generation="gen-000003"), **kwargs)
    assert "缺少模块加载路径" in readiness_problem(_ready(module_path=""), **kwargs)
    assert "不在候选安装目录内" in readiness_problem(
        _ready(module_path="/tmp/other/forgeloop/__init__.py"), **kwargs
    )
    good = _ready(module_path=str(release / "lib" / "forgeloop" / "__init__.py"))
    assert readiness_problem(good, **kwargs) == ""


def test_manifest_errors_and_mismatch(tmp_path) -> None:
    for data in (
        {"version": "0.0.2", "tag": "v0.0.3", "artifact_sha256": DIGEST},
        {"version": "0.0.2", "tag": "v0.0.2", "artifact_sha256": "bad"},
        {
            "version": "0.0.2",
            "tag": "v0.0.2",
            "artifact_sha256": DIGEST,
            "build_commit": "bad",
        },
    ):
        with pytest.raises(UpgradeStateError):
            ArtifactManifest(**data)
    with pytest.raises(UpgradeStateError):
        ArtifactManifest.from_document({"schema_version": 1, "version": "0.0.2", "tag": "v0.0.2"})
    manifest = ArtifactManifest(version="0.0.2", tag="v0.0.2", artifact_sha256=DIGEST)
    assert manifest_problem(None, _identity())
    assert manifest_problem(manifest, _identity(version="0.0.3", tag="v0.0.3"))
    assert manifest_problem(manifest, _identity(artifact_sha256="c" * 64))
    assert manifest_problem(manifest, _identity(build_commit="d" * 40))


def test_owner_binding_rejects_bad_project_and_root(tmp_path) -> None:
    with pytest.raises(UpgradeError):
        OwnerBinding(
            project="bad id",
            prefix=PREFIX,
            registration_root="/tmp/records",
            records_root=RECORDS,
            service_config="/tmp/service.toml",
            web_config="/tmp/web.toml",
            projects_file="/tmp/projects.toml",
        )
    with pytest.raises(UpgradeError):
        OwnerBinding(
            project="forgeloop",
            prefix=PREFIX,
            registration_root="/tmp/records",
            records_root="/tmp/wrong",
            service_config="/tmp/service.toml",
            web_config="/tmp/web.toml",
            projects_file="/tmp/projects.toml",
        )
