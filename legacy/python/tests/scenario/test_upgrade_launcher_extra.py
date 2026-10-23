"""启动器分支覆盖补充：全部在进程内驱动，不启动真实业务端口。

真实子进程路径由 test_supervised_upgrade.py 与系统用例覆盖；本文件只补启动器
错误分支、产物下载/安装与主入口，避免 CI 的 changed-line/分支门禁被子进程边界挡住。
"""

import hashlib
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, cast

import pytest
from test_supervised_upgrade import (
    NEW_DIGEST,
    PROJECT,
    SupervisedUpgradeScene,
    _FakeProcess,
)

from forgeloop.adapter.deployment import DeploymentError
from forgeloop.adapter.upgrade_control import read_owner
from forgeloop.cli import launcher as module
from forgeloop.domain.upgrade import DrainDecision, OwnerBinding, UpgradeRequest
from forgeloop.records.projects import ProjectLocation


class TestLauncherCoverage:
    def _launcher(self, scene: SupervisedUpgradeScene, monkeypatch):
        owner = OwnerBinding.from_document(read_owner(scene.prefix))
        launcher = module.Launcher(owner, scene.prefix.resolve())
        monkeypatch.setattr(launcher, "_spawn", lambda identity: _FakeProcess())
        monkeypatch.setattr(launcher, "_wait_ready", lambda process, identity: "")
        monkeypatch.setattr(
            launcher, "_wait_for_drain", lambda generation: DrainDecision(True, "排空完成")
        )
        monkeypatch.setattr(launcher, "_terminate_and_confirm", lambda process: None)
        return launcher

    def _request(self, scene: SupervisedUpgradeScene) -> UpgradeRequest:
        return UpgradeRequest(
            request_id="upg-" + hashlib.sha256(scene.prefix.name.encode()).hexdigest()[:12],
            project=PROJECT,
            prefix=str(scene.prefix.resolve()),
            tag="v0.0.2",
            artifact_sha256=NEW_DIGEST,
            by="owner",
            reason="覆盖测试",
        )

    def test_run_success_and_failures(self, monkeypatch) -> None:
        from types import SimpleNamespace

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            control = SimpleNamespace(start=lambda: None, stop=lambda: None)
            monkeypatch.setattr(module, "ControlServer", lambda *a, **k: control)
            monkeypatch.setattr(launcher, "_reconcile_and_start", lambda: state)
            monkeypatch.setattr(launcher, "_supervise", lambda: 0)
            monkeypatch.setattr(launcher, "_stop_child", lambda: None)
            assert launcher.run() == 0

            def refuse():
                raise module.LauncherRefused("拒绝")

            monkeypatch.setattr(launcher, "_reconcile_and_start", refuse)
            assert launcher.run() == 1

            monkeypatch.setattr(launcher, "_reconcile_and_start", lambda: state)
            monkeypatch.setattr(control, "start", lambda: (_ for _ in ()).throw(OSError("busy")))
            assert launcher.run() == 1
        finally:
            scene.cleanup()

    def test_main_unmanaged_and_project_mismatch(self, tmp_path: Path) -> None:
        assert module.main(["--prefix", str(tmp_path / "missing")]) == 1

        scene = SupervisedUpgradeScene()
        try:
            assert module.main(["--prefix", str(scene.prefix), "--project", "other"]) == 1
        finally:
            scene.cleanup()

    def test_download_artifact_path(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            payload = b"wheel-bytes"
            digest = hashlib.sha256(payload).hexdigest()
            target = module.UpgradeIdentity(
                version="0.0.5",
                tag="v0.0.5",
                artifact_sha256=digest,
                build_commit="a" * 40,
                generation="",
            )
            location: Any = type(
                "L",
                (),
                {
                    "project": type("P", (), {"repo_path": ".", "project_id": PROJECT})(),
                    "root": scene.project_root,
                },
            )()
            monkeypatch.setattr(module, "remote_slug", lambda repo: "owner/repo")
            monkeypatch.setattr(
                module,
                "release_assets",
                lambda slug, tag: {
                    "SHA256SUMS": "https://example/SHA256SUMS",
                    "forgeloop-0.0.5-py3-none-any.whl": "https://example/wheel",
                },
            )

            def fake_download(url: str, destination: Path) -> Path:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if url.endswith("SHA256SUMS"):
                    destination.write_text(
                        f"{digest}  forgeloop-0.0.5-py3-none-any.whl\n", encoding="utf-8"
                    )
                else:
                    destination.write_bytes(payload)
                return destination

            monkeypatch.setattr(module, "download_asset", fake_download)
            found = launcher._candidate_artifact(
                target,
                cast("ProjectLocation", location),
                self._request(scene),
            )
            assert found.read_bytes() == payload
        finally:
            scene.cleanup()

    def test_install_failure_and_restore_failure(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            payload = b"wheel-6"
            digest = hashlib.sha256(payload).hexdigest()
            target = module.UpgradeIdentity(
                version="0.0.6",
                tag="v0.0.6",
                artifact_sha256=digest,
                build_commit="a" * 40,
                generation="",
            )
            (scene.prefix / "artifacts").mkdir(parents=True)
            (scene.prefix / "artifacts" / "forgeloop-0.0.6-py3-none-any.whl").write_bytes(payload)
            location: Any = type(
                "L",
                (),
                {
                    "project": type("P", (), {"repo_path": "", "project_id": PROJECT})(),
                    "root": scene.project_root,
                },
            )()
            monkeypatch.setattr(
                module, "install_wheel", lambda *a: (_ for _ in ()).throw(DeploymentError("坏包"))
            )
            with pytest.raises(module.LauncherRefused, match="候选安装失败"):
                launcher._ensure_candidate(
                    target,
                    cast("ProjectLocation", location),
                    self._request(scene),
                )

            state = launcher._adopt_current()
            monkeypatch.setattr(
                module, "activate", lambda *a: (_ for _ in ()).throw(DeploymentError("指针坏"))
            )
            with pytest.raises(module.LauncherRefused):
                launcher._restore_previous(state.identity, state)
        finally:
            scene.cleanup()

    def test_wait_for_drain_proceed_and_unreadable(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            identity = launcher._adopt_current().identity
            fake = _FakeProcess()
            fake.pid = os.getpid()
            launcher._child = cast("subprocess.Popen[bytes]", fake)
            launcher.store.write_report(
                "drain",
                identity.generation,
                {
                    "schema_version": 1,
                    "generation": identity.generation,
                    "pid": fake.pid,
                    "completed": True,
                    "active_calls": 0,
                    "active_turns": 0,
                    "active_agent_processes": 0,
                    "pending_requests": 0,
                },
            )
            wait_for_drain = type(launcher)._wait_for_drain.__get__(launcher)
            assert wait_for_drain(identity.generation).proceed is True

            monkeypatch.setattr(
                launcher, "settings", module.UpgradeSettings(drain_timeout_seconds=1)
            )
            launcher.store.report_path("drain", identity.generation).write_text(
                "{broken", encoding="utf-8"
            )
            decision = wait_for_drain(identity.generation)
            assert decision.proceed is False
            assert "不可读" in decision.reason
        finally:
            scene.cleanup()

    def test_terminate_timeout_kills_process(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)

            class Stubborn(_FakeProcess):
                def __init__(self) -> None:
                    super().__init__()
                    self.waits = 0

                def wait(self, timeout: float | None = None) -> int:
                    del timeout
                    self.waits += 1
                    if self.waits == 1:
                        raise subprocess.TimeoutExpired("x", 1)
                    self.returncode = -9
                    return -9

            process = Stubborn()
            terminate = type(launcher)._terminate_and_confirm.__get__(launcher)
            terminate(process)
            assert process.returncode == -9
        finally:
            scene.cleanup()

    def test_init_owner_and_verify_errors(self, tmp_path: Path) -> None:
        from project_support import register_project

        records = tmp_path / "records"
        register_project(records)
        prefix = Path(tempfile.mkdtemp(prefix="flup-owner-", dir="/tmp"))
        service = tmp_path / "service.toml"
        service.write_text("[upgrade]\ndrain_timeout_seconds = 2\n", encoding="utf-8")
        args = [
            "--prefix",
            str(prefix),
            "--init-owner",
            "--project",
            PROJECT,
            "--records-root",
            str(records),
            "--service-config",
            str(service),
            "--web-config",
            str(tmp_path / "web.toml"),
            "--projects-file",
            str(tmp_path / "projects.toml"),
        ]
        assert module.main(args) == 0
        assert (prefix / "control" / "owner.json").is_file()
        assert module.main(args) == 1

    def test_verify_missing_release_and_digest(self, monkeypatch) -> None:
        from dataclasses import replace

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            request = self._request(scene)
            with pytest.raises(module.LauncherRefused, match="发布回执"):
                module._verify_release_and_approval(launcher.owner, replace(request, tag="v0.0.9"))
            with pytest.raises(module.LauncherRefused, match="发布回执不符"):
                module._verify_release_and_approval(
                    launcher.owner, replace(request, artifact_sha256="c" * 64)
                )
            with pytest.raises(module.LauncherRefused, match="请求项目"):
                module._verify_release_and_approval(
                    launcher.owner, replace(request, project="other")
                )
        finally:
            scene.cleanup()

    def test_reconcile_adopt_restart_and_hold(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import PHASE_RECOVERY_REQUIRED

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            state = launcher.state
            assert state is not None
            assert state.phase == "committed"

            launcher.store.write(replace(state, child_pid=99999999))
            restarted = launcher._reconcile_and_start()
            assert restarted.child_pid is not None
            assert restarted.generation != state.generation

            launcher.store.write(replace(state, phase=PHASE_RECOVERY_REQUIRED))
            held = launcher._reconcile_and_start()
            assert held.phase == PHASE_RECOVERY_REQUIRED
        finally:
            scene.cleanup()

    def test_receipt_digest_variants(self, tmp_path: Path) -> None:
        from datetime import UTC, datetime
        from types import SimpleNamespace

        from forgeloop.domain.release import ReleaseRecord

        location = SimpleNamespace(root=tmp_path)
        record = ReleaseRecord(
            task_id="t",
            tag="v0.0.2",
            merge_commit="a" * 40,
            baseline_commit="b" * 40,
            diff_sha256="c" * 64,
            receipt_path="missing.json",
            pushed=True,
            push_detail="",
            released_at=datetime.now(UTC),
        )
        assert module._receipt_digest(location, record) == ""  # type: ignore[arg-type]

        absolute = tmp_path / "absolute.json"
        absolute.write_text('{"artifact_sha256": "' + "d" * 64 + '"}', encoding="utf-8")
        absolute_record = ReleaseRecord(
            task_id="t",
            tag="v0.0.2",
            merge_commit="a" * 40,
            baseline_commit="b" * 40,
            diff_sha256="c" * 64,
            receipt_path=str(absolute),
            pushed=True,
            push_detail="",
            released_at=datetime.now(UTC),
        )
        assert module._receipt_digest(location, absolute_record) == "d" * 64  # type: ignore[arg-type]

        task_dir = tmp_path / "task"
        task_dir.mkdir()
        (task_dir / "receipt.json").write_text("{broken", encoding="utf-8")
        broken = ReleaseRecord(
            task_id="t",
            tag="v0.0.2",
            merge_commit="a" * 40,
            baseline_commit="b" * 40,
            diff_sha256="c" * 64,
            receipt_path="receipt.json",
            pushed=True,
            push_detail="",
            released_at=datetime.now(UTC),
        )
        assert module._receipt_digest(location, broken) == ""  # type: ignore[arg-type]

    def test_switch_refusals_and_rollback_results(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import PHASE_DRAINING, PHASE_RECOVERY_REQUIRED

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            state = launcher.state
            assert state is not None
            request = self._request(scene)
            launcher.state = replace(state, phase=PHASE_RECOVERY_REQUIRED)
            launcher.store.write(launcher.state)
            assert launcher._switch_locked(request)["code"] == "refused"

            launcher.state = replace(state, phase=PHASE_DRAINING, upgrade_key=request.upgrade_key)
            launcher.store.write(launcher.state)
            assert launcher._switch_locked(request)["code"] == "in_progress"

            same = replace(
                state,
                identity=replace(
                    state.identity,
                    version=request.version,
                    tag=request.tag,
                    artifact_sha256=request.artifact_sha256,
                ),
            )
            launcher.state = same
            launcher.store.write(same)
            noop = launcher._switch_locked(request)
            assert noop["ok"] is True and noop["noop"] is True

            monkeypatch.setattr(
                launcher,
                "_restore_previous",
                lambda previous, current: current,
            )
            rolled = launcher._rollback(
                state, previous=state.identity, failed=state.identity, reason="测试"
            )
            assert rolled["code"] == "rolled_back"

            monkeypatch.setattr(
                launcher,
                "_restore_previous",
                lambda previous, current: {"ok": False, "code": "x", "message": "x"},
            )
            failed = launcher._rollback(
                state, previous=state.identity, failed=state.identity, reason="测试"
            )
            assert failed["code"] == "x"
        finally:
            scene.cleanup()

    def test_switch_old_child_timeout_and_missing_pid(self, monkeypatch) -> None:
        from dataclasses import replace

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            state = launcher.state
            assert state is not None
            launcher.store.write(replace(state, child_pid=None))
            launcher._child = None
            launcher._adopted_pid = None
            missing = launcher._switch_locked(self._request(scene))
            assert missing["code"] == "recovery_required"

            launcher._start_committed(launcher._adopt_current())

            class Stubborn(_FakeProcess):
                def wait(self, timeout: float | None = None) -> int:
                    raise subprocess.TimeoutExpired("x", 1)

            launcher._child = cast("subprocess.Popen[bytes]", Stubborn())
            timed_out = launcher._switch_locked(self._request(scene))
            assert timed_out["code"] == "recovery_required"
        finally:
            scene.cleanup()

    def test_candidate_artifact_error_branches(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            target = module.UpgradeIdentity(
                version="0.0.7",
                tag="v0.0.7",
                artifact_sha256="d" * 64,
                build_commit="a" * 40,
                generation="",
            )
            location: Any = type(
                "L",
                (),
                {
                    "project": type("P", (), {"repo_path": "", "project_id": PROJECT})(),
                    "root": scene.project_root,
                },
            )()
            with pytest.raises(module.LauncherRefused, match="无法从项目仓库"):
                launcher._candidate_artifact(
                    target, cast("ProjectLocation", location), self._request(scene)
                )

            location.project.repo_path = "."
            monkeypatch.setattr(module, "remote_slug", lambda repo: "owner/repo")
            monkeypatch.setattr(module, "release_assets", lambda slug, tag: {})
            with pytest.raises(module.LauncherRefused, match="SHA256SUMS"):
                launcher._candidate_artifact(
                    target, cast("ProjectLocation", location), self._request(scene)
                )

            monkeypatch.setattr(
                module,
                "release_assets",
                lambda slug, tag: {
                    "SHA256SUMS": "https://example/SHA256SUMS",
                    "forgeloop-0.0.7-py3-none-any.whl": "https://example/wheel",
                },
            )

            def download(url: str, destination: Path) -> Path:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("deadbeef  other.whl\n", encoding="utf-8")
                return destination

            monkeypatch.setattr(module, "download_asset", download)
            with pytest.raises(module.LauncherRefused, match="没有 forgeloop"):
                launcher._candidate_artifact(
                    target, cast("ProjectLocation", location), self._request(scene)
                )
        finally:
            scene.cleanup()

    def test_verify_missing_digest_approval_and_tag(self, monkeypatch) -> None:
        from forgeloop.records.store import RecordStore

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            request = self._request(scene)
            (scene.project_root / "release-receipt.json").unlink()
            with pytest.raises(module.LauncherRefused, match="没有可核对"):
                module._verify_release_and_approval(launcher.owner, request)
        finally:
            scene.cleanup()

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            store = RecordStore(scene.project_root / "records.sqlite")
            try:
                store._db.execute("DELETE FROM deploy_approvals")
                store._db.commit()
            finally:
                store.close()
            with pytest.raises(module.LauncherRefused, match="部署批准"):
                module._verify_release_and_approval(launcher.owner, self._request(scene))
        finally:
            scene.cleanup()

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            monkeypatch.setattr(module, "tag_commit", lambda repo, tag: "f" * 40)
            with pytest.raises(module.LauncherRefused, match="标签提交"):
                module._verify_release_and_approval(launcher.owner, self._request(scene))
        finally:
            scene.cleanup()

    def test_ensure_candidate_existing_bad_manifest_and_missing_binary(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            target = module.UpgradeIdentity(
                version="0.0.8",
                tag="v0.0.8",
                artifact_sha256="e" * 64,
                build_commit="a" * 40,
                generation="",
            )
            location: Any = type(
                "L",
                (),
                {
                    "project": type("P", (), {"repo_path": "", "project_id": PROJECT})(),
                    "root": scene.project_root,
                },
            )()
            version_dir = scene.prefix / "releases" / "0.0.8"
            version_dir.mkdir(parents=True)
            (version_dir / "artifact.json").write_text(
                '{"schema_version": 1, "version": "0.0.9", "tag": "v0.0.9", '
                '"artifact_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
                encoding="utf-8",
            )
            with pytest.raises(module.LauncherRefused):
                launcher._ensure_candidate(
                    target, cast("ProjectLocation", location), self._request(scene)
                )
        finally:
            scene.cleanup()

    def test_adopt_and_restore_fail_without_current_or_manifest(self, tmp_path: Path) -> None:
        prefix = Path(tempfile.mkdtemp(prefix="flup-empty-", dir="/tmp"))
        owner = OwnerBinding(
            project=PROJECT,
            prefix=str(prefix),
            registration_root=str(tmp_path / "records"),
            records_root=str(tmp_path / "records" / "projects" / PROJECT),
            service_config=str(tmp_path / "service.toml"),
            web_config=str(tmp_path / "web.toml"),
            projects_file=str(tmp_path / "projects.toml"),
        )
        (tmp_path / "service.toml").write_text("[upgrade]\n", encoding="utf-8")
        launcher = module.Launcher(owner, prefix)
        with pytest.raises(module.LauncherRefused, match="current"):
            launcher._adopt_current()

        (prefix / "releases" / "0.0.1" / "bin").mkdir(parents=True)
        (prefix / "releases" / "0.0.1" / "bin" / "forgeloop").write_text("#!/bin/sh\n")
        (prefix / "current").symlink_to(prefix / "releases" / "0.0.1")
        with pytest.raises(module.LauncherRefused, match="artifact"):
            launcher._adopt_current()

    def test_supervise_adopted_and_process_exit(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            fake = _FakeProcess()
            fake.pid = os.getpid()
            launcher._child = None
            launcher._adopted_pid = fake.pid

            monkeypatch.setattr(launcher._stop, "wait", lambda timeout: True)
            assert launcher._supervise() == 0

            launcher._adopted_pid = 99999999
            monkeypatch.setattr(launcher._stop, "wait", lambda timeout: False)
            assert launcher._supervise() == 1
        finally:
            scene.cleanup()

    def test_receipt_short_digest_and_duplicate_release(self, monkeypatch) -> None:
        from datetime import UTC, datetime
        from types import SimpleNamespace

        from forgeloop.domain.release import ReleaseRecord

        scene = SupervisedUpgradeScene()
        try:
            receipt = scene.project_root / "short.json"
            receipt.write_text('{"artifact_sha256": "abc"}', encoding="utf-8")
            record = ReleaseRecord(
                task_id="t",
                tag="v0.0.2",
                merge_commit="a" * 40,
                baseline_commit="b" * 40,
                diff_sha256="c" * 64,
                receipt_path=str(receipt),
                pushed=True,
                push_detail="",
                released_at=datetime.now(UTC),
            )
            assert module._receipt_digest(SimpleNamespace(root=scene.project_root), record) == ""  # type: ignore[arg-type]

            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            location = SimpleNamespace(
                root=scene.project_root,
                project=SimpleNamespace(project_id=PROJECT),
            )
            monkeypatch.setattr(
                module,
                "releases_by_tag",
                lambda root, tag: [(location, record), (location, record)],
            )
            with pytest.raises(module.LauncherRefused, match="多条发布回执"):
                module._verify_release_and_approval(launcher.owner, self._request(scene))
        finally:
            scene.cleanup()

    def test_main_normal_path_and_reconcile_rollback(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import PHASE_STARTING

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            state = launcher.state
            assert state is not None
            previous = replace(
                state.identity,
                version="0.0.2",
                tag="v0.0.2",
                generation="gen-000000",
            )
            launcher.store.write(
                replace(state, phase=PHASE_STARTING, child_pid=99999999, previous=previous)
            )
            rolled = launcher._reconcile_and_start()
            assert rolled.phase == "rolled_back"

            monkeypatch.setattr(module.Launcher, "run", lambda self: 0)
            assert module.main(["--prefix", str(scene.prefix)]) == 0
        finally:
            scene.cleanup()
