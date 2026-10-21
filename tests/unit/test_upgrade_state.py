"""升级现场持久化：原子写、追加审计、报告与只读准入。

方案 §3.2：启动器独占写现场；业务进程只读。状态缺失/损坏/代际不符一律失败关闭。
"""

import json
import os
import stat
from pathlib import Path

import pytest

from forgeloop.domain.upgrade import (
    PHASE_COMMITTED,
    PHASE_DRAINING,
    PHASE_RECOVERY_REQUIRED,
    UpgradeError,
    UpgradeIdentity,
    UpgradeState,
)
from forgeloop.records.upgrade_state import (
    UpgradeStateStore,
    read_managed_admission,
    write_json_atomic,
)

PREFIX = "/tmp/forgeloop-prefix"
RECORDS = "/tmp/forgeloop-prefix/records"
DIGEST = "a" * 64
COMMIT = "b" * 40


def _state(phase: str = PHASE_COMMITTED, generation: str = "gen-000001") -> UpgradeState:
    return UpgradeState(
        identity=UpgradeIdentity(
            version="0.0.4",
            tag="v0.0.4",
            artifact_sha256=DIGEST,
            build_commit=COMMIT,
            generation=generation,
        ),
        project="forgeloop",
        prefix=PREFIX,
        records_root=RECORDS,
        phase=phase,
        generation=generation,
    )


class TestStateFile:
    def test_round_trip_and_permissions(self, tmp_path: Path) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        written = store.write(_state(PHASE_DRAINING))

        assert store.read() == written
        mode = stat.S_IMODE(os.stat(store.state_path).st_mode)
        assert mode == 0o600
        assert stat.S_IMODE(os.stat(store.control_dir).st_mode) == 0o700
        assert json.loads(store.state_path.read_text(encoding="utf-8"))["schema_version"] == 1

    def test_corrupt_state_is_not_guessed(self, tmp_path: Path) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        store.state_path.write_text("{not json", encoding="utf-8")
        with pytest.raises(UpgradeError):
            store.read()

    def test_missing_state_is_none(self, tmp_path: Path) -> None:
        assert UpgradeStateStore(tmp_path / "control").read() is None

    def test_atomic_write_replaces_whole_document(self, tmp_path: Path) -> None:
        path = tmp_path / "document.json"
        write_json_atomic(path, {"a": 1})
        write_json_atomic(path, {"b": 2})
        assert json.loads(path.read_text(encoding="utf-8")) == {"b": 2}
        assert list(tmp_path.glob(".document.json.*")) == []


class TestEventsAndReports:
    def test_events_append_only(self, tmp_path: Path) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        state = store.write(_state())
        store.append_event("prepared", state=state, detail="request-1")
        store.append_event("draining", state=state, detail="request-1")

        events = store.events()

        assert [item["kind"] for item in events] == ["prepared", "draining"]
        assert all(item["request_id"] == "" for item in events)
        assert events[0]["phase"] == PHASE_COMMITTED

    def test_reports_are_separate_from_state(self, tmp_path: Path) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        store.write(_state())
        store.write_report("ready", "gen-000001", {"ready": True})
        store.write_report("drain", "gen-000001", {"completed": True})

        assert store.read_report("ready", "gen-000001") == {"ready": True}
        assert store.read_report("drain", "gen-000001") == {"completed": True}
        assert store.read_report("ready", "gen-000002") is None

    def test_report_path_rejects_traversal(self, tmp_path: Path) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        with pytest.raises(ValueError):
            store.report_path("ready", "../escape")
        with pytest.raises(ValueError):
            store.report_path("other", "gen-000001")


class TestAdmissionFromEnvironment:
    def test_unmanaged_is_allowed(self) -> None:
        admission = read_managed_admission({})
        assert admission.managed is False
        assert admission.allowed is True

    @pytest.mark.parametrize(
        ("phase", "same_generation", "allowed"),
        [
            (PHASE_COMMITTED, True, True),
            (PHASE_COMMITTED, False, False),
            (PHASE_DRAINING, True, False),
            (PHASE_RECOVERY_REQUIRED, True, False),
        ],
    )
    def test_managed_requires_phase_and_generation(
        self, tmp_path: Path, phase: str, same_generation: bool, allowed: bool
    ) -> None:
        store = UpgradeStateStore(tmp_path / "control")
        store.write(_state(phase))
        environment = {
            "FORGELOOP_UPGRADE_MANAGED": "1",
            "FORGELOOP_UPGRADE_STATE": str(store.state_path),
            "FORGELOOP_UPGRADE_GENERATION": "gen-000001" if same_generation else "gen-000002",
        }

        admission = read_managed_admission(environment)

        assert admission.managed is True
        assert admission.allowed is allowed
        if not allowed:
            assert admission.reason


class TestDomainBranches:
    def test_identity_validation(self) -> None:
        from forgeloop.domain.upgrade import UpgradeIdentity, UpgradeStateError

        for kwargs in (
            {"version": "0.0.4", "tag": "v0.0.5", "artifact_sha256": DIGEST},
            {"version": "0.0.4", "tag": "v0.0.4", "artifact_sha256": "x"},
            {"version": "0.0.4", "tag": "v0.0.4", "artifact_sha256": DIGEST, "build_commit": "z"},
            {
                "version": "0.0.4",
                "tag": "v0.0.4",
                "artifact_sha256": DIGEST,
                "generation": "bad",
            },
        ):
            with pytest.raises(UpgradeStateError):
                UpgradeIdentity(**kwargs)

    def test_state_document_branches(self) -> None:
        from forgeloop.domain.upgrade import UpgradeState, UpgradeStateError

        document = _state().to_document()
        assert UpgradeState.from_document(document) == _state()
        for broken in (
            {**document, "schema_version": 99},
            {**document, "unknown": 1},
            {**document, "phase": "unknown"},
            {**document, "generation": "gen-000002"},
            {**document, "previous": document["identity"]},
            {**document, "candidate": document["identity"]},
            {**document, "child_pid": "not-int"},
        ):
            with pytest.raises(UpgradeStateError):
                UpgradeState.from_document(broken)

    def test_request_validation_branches(self) -> None:
        from forgeloop.domain.upgrade import (
            PROTOCOL_VERSION,
            UpgradeRequest,
            UpgradeRequestError,
        )

        base = {
            "request_id": "req-12345678",
            "project": "forgeloop",
            "prefix": "/tmp/prefix",
            "tag": "v0.0.4",
            "artifact_sha256": DIGEST,
            "by": "owner",
            "reason": "升级",
        }
        assert UpgradeRequest(**base).version == "0.0.4"  # type: ignore[arg-type]
        for overrides in (
            {"protocol_version": 99},
            {"request_id": "short"},
            {"project": "BAD"},
            {"prefix": "relative"},
            {"tag": "0.0.4"},
            {"artifact_sha256": "bad"},
            {"by": ""},
            {"reason": ""},
            {"by": "x" * 200},
            {"reason": "x" * 2000},
        ):
            with pytest.raises(UpgradeRequestError):
                UpgradeRequest(**{**base, **overrides})
        assert PROTOCOL_VERSION == 1

    def test_switch_decisions(self) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import (
            PHASE_COMMITTED,
            PHASE_DRAINING,
            PHASE_RECOVERY_REQUIRED,
            UpgradeRequest,
            switch_decision,
        )

        request = UpgradeRequest(
            request_id="req-12345678",
            project="forgeloop",
            prefix=PREFIX,
            tag="v0.0.4",
            artifact_sha256=DIGEST,
            by="owner",
            reason="升级",
        )
        assert switch_decision(None, request).allowed is True
        same = _state(PHASE_COMMITTED)
        assert switch_decision(same, request).noop is True
        other = replace(request, project="other")
        assert switch_decision(same, other).allowed is False
        recovery = _state(PHASE_RECOVERY_REQUIRED)
        assert switch_decision(recovery, request).allowed is False
        transient = _state(PHASE_DRAINING)
        assert switch_decision(transient, replace(request, prefix="/tmp/other")).allowed is False
        same_request = replace(
            transient,
            request_id=request.request_id,
            upgrade_key=request.upgrade_key,
        )
        assert switch_decision(same_request, request).in_progress is True
        same_version_other = replace(request, artifact_sha256="c" * 64)
        assert switch_decision(same, same_version_other).allowed is False

    def test_settings_and_owner_validation(self) -> None:
        from forgeloop.domain.upgrade import (
            ArtifactManifest,
            OwnerBinding,
            UpgradeSettings,
            UpgradeSettingsError,
            manifest_problem,
            parse_upgrade_request,
            resolve_upgrade_settings,
        )

        assert resolve_upgrade_settings(None) == UpgradeSettings()
        assert resolve_upgrade_settings({"schema_version": 1}).drain_timeout_seconds == 300.0
        for document in (
            {"unknown": 1},
            {"schema_version": 2},
            {"drain_timeout_seconds": True},
            {"drain_timeout_seconds": 0},
            {"readiness_timeout_seconds": 0},
            {"recovery_timeout_seconds": 0},
            {"poll_seconds": 0},
        ):
            with pytest.raises(UpgradeSettingsError):
                resolve_upgrade_settings(document)
        with pytest.raises(UpgradeSettingsError):
            UpgradeSettings(drain_timeout_seconds=0)

        owner = OwnerBinding(
            project="forgeloop",
            prefix=PREFIX,
            registration_root="/tmp/forgeloop-records",
            records_root="/tmp/forgeloop-records/projects/forgeloop",
            service_config="/tmp/service.toml",
            web_config="/tmp/web.toml",
            projects_file="/tmp/projects.toml",
        )
        assert OwnerBinding.from_document(owner.to_document()) == owner
        with pytest.raises(ValueError):
            OwnerBinding(
                project="forgeloop",
                prefix="relative",
                registration_root=owner.registration_root,
                records_root=owner.records_root,
                service_config=owner.service_config,
                web_config=owner.web_config,
                projects_file=owner.projects_file,
            )

        manifest = ArtifactManifest(
            version="0.0.4",
            tag="v0.0.4",
            artifact_sha256=DIGEST,
            build_commit=COMMIT,
        )
        assert ArtifactManifest.from_document(manifest.to_document()) == manifest
        assert manifest_problem(None, _state().identity) != ""
        assert manifest_problem(manifest, _state().identity) == ""
        assert (
            manifest_problem(
                manifest,
                _state().identity.__class__(
                    **{**_state().identity.to_document(), "artifact_sha256": "c" * 64}
                ),
            )
            != ""
        )

        with pytest.raises(ValueError):
            parse_upgrade_request({"protocol_version": 1})

    def test_readiness_and_reconcile_branches(self) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import (
            PHASE_RECOVERY_REQUIRED,
            PHASE_STARTING,
            readiness_problem,
            reconcile_restart,
        )

        expected = _state().identity
        report = {
            "schema_version": 1,
            "ready": True,
            "pid": 4321,
            "generation": expected.generation,
            "version": expected.version,
            "tag": expected.tag,
            "artifact_sha256": expected.artifact_sha256,
            "build_commit": expected.build_commit,
            "project": "forgeloop",
            "prefix": PREFIX,
            "records_root": RECORDS,
            "module_path": f"{PREFIX}/releases/0.0.4/lib/forgeloop/__init__.py",
        }
        kwargs = dict(
            expected=expected,
            expected_pid=4321,
            project="forgeloop",
            prefix=PREFIX,
            records_root=RECORDS,
            release_dir=f"{PREFIX}/releases/0.0.4",
        )
        assert readiness_problem(report, **kwargs) == ""  # type: ignore[arg-type]
        for field, value in (
            ("schema_version", 2),
            ("ready", False),
            ("pid", 1),
            ("generation", "gen-000002"),
            ("version", "0.0.5"),
            ("tag", "v0.0.5"),
            ("artifact_sha256", "c" * 64),
            ("build_commit", "d" * 40),
            ("project", "other"),
            ("prefix", "/tmp/other"),
            ("records_root", "/tmp/other"),
            ("module_path", "/workspace/forgeloop/__init__.py"),
        ):
            assert readiness_problem({**report, field: value}, **kwargs) != ""  # type: ignore[arg-type]
        assert readiness_problem(None, **kwargs) != ""  # type: ignore[arg-type]

        committed = _state()
        assert reconcile_restart(committed, child_alive=True).action == "adopt"
        assert reconcile_restart(committed, child_alive=False).action == "restart"
        previous_identity = replace(
            _state().identity, version="0.0.3", tag="v0.0.3", generation="gen-000000"
        )
        starting = replace(committed, phase=PHASE_STARTING, previous=previous_identity)
        assert reconcile_restart(starting, child_alive=True).action == "hold"
        assert reconcile_restart(starting, child_alive=False).action == "rollback"
        recovery = replace(committed, phase=PHASE_RECOVERY_REQUIRED)
        assert reconcile_restart(recovery, child_alive=False).action == "hold"
        assert reconcile_restart(None, child_alive=False).action == "start"

    def test_parsers_and_timestamps(self) -> None:
        from datetime import UTC, datetime

        from forgeloop.domain.upgrade import (
            UpgradeError,
            iso_now,
            parse_drain_report,
            parse_ready_report,
            parse_timestamp,
        )

        assert iso_now(None) == ""
        moment = datetime(2026, 10, 21, tzinfo=UTC)
        assert parse_timestamp(iso_now(moment)) == moment
        assert parse_timestamp("not-a-time") is None
        assert parse_timestamp("") is None
        with pytest.raises(UpgradeError):
            parse_drain_report([])
        with pytest.raises(UpgradeError):
            parse_ready_report({"unknown": 1})

    def test_drain_and_readiness_unknown_fields(self) -> None:
        from forgeloop.domain.upgrade import drain_decision, readiness_problem

        with pytest.raises(UpgradeError):
            drain_decision(
                {"unknown": 1},
                expected_generation="gen-000001",
                expected_pid=1,
                outstanding_actions=0,
            )
        assert (
            readiness_problem(
                {"unknown": 1},
                expected=_state().identity,
                expected_pid=1,
                project="forgeloop",
                prefix=PREFIX,
                records_root=RECORDS,
                release_dir=PREFIX,
            )
            != ""
        )

    def test_owner_and_manifest_invalid_documents(self) -> None:
        from forgeloop.domain.upgrade import (
            ArtifactManifest,
            OwnerBinding,
            OwnerBindingError,
            UpgradeStateError,
        )

        with pytest.raises(OwnerBindingError):
            OwnerBinding.from_document({"project": "forgeloop"})
        with pytest.raises(OwnerBindingError):
            OwnerBinding.from_document(
                {
                    "schema_version": 2,
                    "project": "forgeloop",
                    "prefix": PREFIX,
                    "registration_root": "/tmp/records",
                    "records_root": "/tmp/records/projects/forgeloop",
                    "service_config": "/tmp/service.toml",
                    "web_config": "/tmp/web.toml",
                    "projects_file": "/tmp/projects.toml",
                }
            )
        with pytest.raises(UpgradeStateError):
            ArtifactManifest.from_document(
                {
                    "schema_version": 2,
                    "version": "0.0.4",
                    "tag": "v0.0.4",
                    "artifact_sha256": DIGEST,
                }
            )

    def test_generation_and_transition_edges(self) -> None:
        from forgeloop.domain.upgrade import (
            ALL_PHASES,
            PHASE_COMMITTED,
            PHASE_RECOVERY_REQUIRED,
            next_generation,
            transition_problem,
        )

        for phase in sorted(ALL_PHASES):
            assert transition_problem(phase, phase) != ""
        assert next_generation("") == "gen-000001"
        with pytest.raises(ValueError):
            next_generation("bad")
        assert transition_problem(PHASE_RECOVERY_REQUIRED, PHASE_COMMITTED) != ""
        assert transition_problem(PHASE_COMMITTED, PHASE_COMMITTED) != ""

    def test_missing_or_corrupt_state_fails_closed(self, tmp_path: Path) -> None:
        missing = read_managed_admission(
            {
                "FORGELOOP_UPGRADE_MANAGED": "1",
                "FORGELOOP_UPGRADE_STATE": str(tmp_path / "control" / "upgrade-state.json"),
                "FORGELOOP_UPGRADE_GENERATION": "gen-000001",
            }
        )
        assert missing.allowed is False

        store = UpgradeStateStore(tmp_path / "control")
        store.state_path.write_text("broken", encoding="utf-8")
        corrupt = read_managed_admission(
            {
                "FORGELOOP_UPGRADE_MANAGED": "1",
                "FORGELOOP_UPGRADE_STATE": str(store.state_path),
                "FORGELOOP_UPGRADE_GENERATION": "gen-000001",
            }
        )
        assert corrupt.allowed is False
        assert "不可读" in corrupt.reason
