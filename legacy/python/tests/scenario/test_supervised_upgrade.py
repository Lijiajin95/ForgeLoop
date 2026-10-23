"""受控热升级场景：真实启动器进程、真实 Unix socket、真实业务子进程与 SQLite。

业务版本用可执行的 Python 替身实现（真实子进程、真实就绪/排空报告协议），不访问模型，
也不调用 systemd；切换、失败恢复、延期与拒绝都由生产启动器代码处理。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from project_support import register_project

from forgeloop.adapter.upgrade_control import (
    ControlError,
    control_request,
    write_owner,
)
from forgeloop.domain.project import project_data_root
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.upgrade import (
    PHASE_COMMITTED,
    PHASE_DEFERRED,
    PHASE_RECOVERY_REQUIRED,
    PHASE_ROLLED_BACK,
    PROTOCOL_VERSION,
    OwnerBinding,
)
from forgeloop.records.projects import ProjectLocation
from forgeloop.records.store import RecordStore
from forgeloop.records.upgrade_state import UpgradeStateStore, write_json_atomic

ROOT = Path(__file__).resolve().parents[2]
OLD_DIGEST = "a" * 64
NEW_DIGEST = "b" * 64
OTHER_DIGEST = "c" * 64
PROJECT = "forgeloop"
WAIT_SECONDS = 15.0


FAKE_SERVE = r"""#!/usr/bin/env python3
import json, os, pathlib, sys, time

release = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((release / "artifact.json").read_text(encoding="utf-8"))
generation = os.environ["FORGELOOP_UPGRADE_GENERATION"]
state_path = pathlib.Path(os.environ["FORGELOOP_UPGRADE_STATE"])
ready_path = pathlib.Path(os.environ["FORGELOOP_UPGRADE_READY"])
drain_path = pathlib.Path(os.environ["FORGELOOP_UPGRADE_DRAIN_REPORT"])

if __FAIL_ON_START__ and (release / ".fail-on-start").exists():
    sys.exit(1)
if __FAIL_READY__:
    sys.exit(1)

module = release / "lib" / "forgeloop" / "__init__.py"
module.parent.mkdir(parents=True, exist_ok=True)
module.write_text("", encoding="utf-8")
module_path = "__BAD_MODULE__" if __BAD_MODULE__ else str(module)
ready_path.write_text(json.dumps({
    "schema_version": 1,
    "ready": True,
    "pid": os.getpid(),
    "generation": generation,
    "version": manifest["version"],
    "tag": manifest["tag"],
    "artifact_sha256": manifest["artifact_sha256"],
    "build_commit": manifest["build_commit"],
    "project": os.environ["FORGELOOP_UPGRADE_PROJECT"],
    "prefix": os.environ["FORGELOOP_UPGRADE_PREFIX"],
    "records_root": os.environ["FORGELOOP_UPGRADE_RECORDS_ROOT"],
    "module_path": module_path,
    "http_host": "127.0.0.1",
    "http_port": 0,
}), encoding="utf-8")

drained = False
while True:
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        time.sleep(0.05)
        continue
    phase = state.get("phase")
    if state.get("generation") != generation:
        if phase in ("starting", "probing", "committed"):
            sys.exit(0)
        time.sleep(0.05)
        continue
    if phase == "draining" and not drained and not __IGNORE_DRAIN__:
        drain_path.write_text(json.dumps({
            "schema_version": 1,
            "generation": generation,
            "pid": os.getpid(),
            "completed": True,
            "active_calls": 0,
            "active_turns": 0,
            "active_agent_processes": 0,
            "pending_requests": 0,
            "detail": "",
        }), encoding="utf-8")
        drained = True
    if phase == "deferred":
        drained = False
    time.sleep(0.05)
"""


def _script(
    *,
    fail_ready: bool = False,
    bad_module: bool = False,
    ignore_drain: bool = False,
    fail_on_start: bool = False,
) -> str:
    return (
        FAKE_SERVE.replace("__FAIL_READY__", "True" if fail_ready else "False")
        .replace("__BAD_MODULE__", "True" if bad_module else "False")
        .replace("__IGNORE_DRAIN__", "True" if ignore_drain else "False")
        .replace("__FAIL_ON_START__", "True" if fail_on_start else "False")
    )


def _wait(predicate, what: str, timeout: float = WAIT_SECONDS) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"等待超时: {what}")


def _alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class SupervisedUpgradeScene:
    """一套真实受控升级现场：启动器 + 两个版本 + 发布回执/批准 + 项目库。"""

    def __init__(
        self,
        *,
        approve: bool = True,
        old_ignore_drain: bool = False,
        candidate_fail_ready: bool = False,
        candidate_bad_module: bool = False,
        old_fail_on_restart: bool = False,
        drain_timeout: float = 1.0,
        readiness_timeout: float = 10.0,
        recovery_timeout: float = 3.0,
    ) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="flup-upg-", dir="/tmp"))
        self.prefix = self.root / "prefix"
        self.records = self.root / "records"
        self.repo = self.root / "repo"
        self.project_root = project_data_root(self.records, PROJECT)
        self._launcher: subprocess.Popen[bytes] | None = None
        self._log_handle = None
        self.old_ignore_drain = old_ignore_drain
        self.candidate_fail_ready = candidate_fail_ready
        self.candidate_bad_module = candidate_bad_module
        self.old_fail_on_restart = old_fail_on_restart
        self._build_repo()
        self._build_records(approve=approve)
        self._build_versions()
        self._build_config(drain_timeout, readiness_timeout, recovery_timeout)
        self._write_owner()

    # ---- 现场 ---------------------------------------------------------------

    def _build_repo(self) -> None:
        self.repo.mkdir(parents=True)
        (self.repo / "README.md").write_text("baseline\n", encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.root)}

        def git(*args: str) -> None:
            subprocess.run(
                ["git", "-C", str(self.repo), *args],
                check=True,
                capture_output=True,
                env=env,
            )

        git("init", "-b", "main")
        git("config", "user.name", "forgeloop-tests")
        git("config", "user.email", "tests@example.com")
        git("add", "-A")
        git("commit", "-m", "chore: baseline")
        git("tag", "v0.0.2")
        self.commit = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        ).stdout.strip()
        register_project(self.records, repo_path=str(self.repo))

    def _build_records(self, *, approve: bool) -> None:
        write_json_atomic(
            self.project_root / "release-receipt.json", {"artifact_sha256": NEW_DIGEST}
        )
        store = RecordStore(self.project_root / "records.sqlite")
        try:
            store.create_task(
                "task-1",
                PROJECT,
                "input",
                {"pi_command": "[]", "test_command": "[]"},
                7200.0,
            )
            store.outcomes.record_release(
                ReleaseRecord(
                    task_id="task-1",
                    tag="v0.0.2",
                    merge_commit=self.commit,
                    baseline_commit=self.commit,
                    diff_sha256="d" * 64,
                    receipt_path="release-receipt.json",
                    pushed=True,
                    push_detail="",
                    released_at=datetime.now(UTC),
                )
            )
            if approve:
                store.record_deploy_approval(
                    "v0.0.2",
                    NEW_DIGEST,
                    by="owner",
                    reason="场景测试：确认切换",
                )
        finally:
            store.close()

    def _version_dir(
        self,
        version: str,
        digest: str,
        *,
        build_commit: str,
        script: str,
    ) -> Path:
        target = self.prefix / "releases" / version
        (target / "bin").mkdir(parents=True)
        write_json_atomic(
            target / "artifact.json",
            {
                "schema_version": 1,
                "version": version,
                "tag": f"v{version}",
                "artifact_sha256": digest,
                "build_commit": build_commit,
                "build_commit_source": "test",
                "installed_at": datetime.now(UTC).isoformat(),
                "source": "test",
            },
        )
        entry = target / "bin" / "forgeloop"
        entry.write_text(script, encoding="utf-8")
        entry.chmod(0o755)
        return target

    def _build_versions(self) -> None:
        old = _script(
            ignore_drain=self.old_ignore_drain,
            fail_on_start=self.old_fail_on_restart,
        )
        new = _script(
            fail_ready=self.candidate_fail_ready,
            bad_module=self.candidate_bad_module,
        )
        self._version_dir("0.0.1", OLD_DIGEST, build_commit="a" * 40, script=old)
        self._version_dir("0.0.2", NEW_DIGEST, build_commit=self.commit, script=new)
        self.prefix.mkdir(parents=True, exist_ok=True)
        (self.prefix / "current").symlink_to(
            self.prefix / "releases" / "0.0.1", target_is_directory=True
        )

    def _build_config(self, drain: float, readiness: float, recovery: float) -> None:
        self.service_config = self.root / "service.toml"
        self.service_config.write_text(
            "[upgrade]\n"
            f"drain_timeout_seconds = {drain}\n"
            f"readiness_timeout_seconds = {readiness}\n"
            f"recovery_timeout_seconds = {recovery}\n"
            "poll_seconds = 0.05\n",
            encoding="utf-8",
        )
        self.web_config = self.root / "web.toml"
        self.web_config.write_text("refresh_seconds = 60\n", encoding="utf-8")
        self.projects_file = self.root / "projects.toml"
        self.projects_file.write_text("", encoding="utf-8")

    def _write_owner(self) -> None:
        binding = OwnerBinding(
            project=PROJECT,
            prefix=str(self.prefix.resolve()),
            registration_root=str(self.records.resolve()),
            records_root=str(self.project_root.resolve()),
            service_config=str(self.service_config.resolve()),
            web_config=str(self.web_config.resolve()),
            projects_file=str(self.projects_file.resolve()),
        )
        write_owner(self.prefix, binding.to_document())

    # ---- 启动器 -------------------------------------------------------------

    def start(self) -> None:
        log_path = self.root / "launcher.log"
        self._log_handle = log_path.open("ab")
        self._launcher = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "forgeloop.cli.launcher",
                "--prefix",
                str(self.prefix),
            ],
            cwd=ROOT,
            stdout=self._log_handle,
            stderr=subprocess.STDOUT,
        )
        _wait(
            lambda: self._probe_status() is not None,
            "启动器控制接口就绪",
        )

    def _probe_status(self) -> dict[str, object] | None:
        try:
            return dict(
                control_request(
                    self.prefix,
                    {"protocol_version": PROTOCOL_VERSION, "operation": "status"},
                    timeout=1.0,
                )
            )
        except ControlError:
            return None

    def stop(self) -> None:
        process, self._launcher = self._launcher, None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None

    def kill_launcher(self) -> None:
        process, self._launcher = self._launcher, None
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None

    def status(self) -> dict:
        response = self._probe_status()
        assert response is not None, "启动器控制接口不可用"
        return response

    def state(self):
        return UpgradeStateStore(self.prefix / "control").read()

    def switch(
        self,
        *,
        tag: str = "v0.0.2",
        digest: str = NEW_DIGEST,
        project: str = PROJECT,
        prefix: str | None = None,
        request_id: str | None = None,
        timeout: float = 30.0,
    ) -> dict:
        request = {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id or f"upg-{uuid.uuid4().hex}",
            "project": project,
            "prefix": prefix or str(self.prefix.resolve()),
            "tag": tag,
            "artifact_sha256": digest,
            "by": "owner",
            "reason": "场景测试：受控升级",
        }
        return dict(
            control_request(
                self.prefix,
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "operation": "switch",
                    "request": request,
                },
                timeout=timeout,
            )
        )

    def current_version(self) -> str:
        return (self.prefix / "current").resolve().name

    def log(self) -> str:
        return (self.root / "launcher.log").read_text(encoding="utf-8", errors="replace")

    def cleanup(self) -> None:
        self.stop()
        shutil.rmtree(self.root, ignore_errors=True)


@pytest.fixture()
def scene():
    instance = SupervisedUpgradeScene()
    try:
        instance.start()
        yield instance
    finally:
        instance.cleanup()


class TestIdleUpgrade:
    def test_switch_changes_business_identity_but_not_launcher(self, scene) -> None:
        before = scene.status()
        old_child = int(before["child_pid"])
        before_state = scene.state()
        assert before_state is not None
        assert before_state.phase == PHASE_COMMITTED
        assert before_state.identity.version == "0.0.1"
        assert _alive(old_child)

        response = scene.switch()

        assert response["ok"] is True, response
        state = scene.state()
        assert state is not None
        assert state.phase == PHASE_COMMITTED
        assert state.identity.version == "0.0.2"
        assert state.identity.artifact_sha256 == NEW_DIGEST
        assert state.generation > before_state.generation
        assert scene.current_version() == "0.0.2"
        after = scene.status()
        assert after["launcher_pid"] == before["launcher_pid"]
        assert int(after["child_pid"]) != old_child
        assert after["child_alive"] is True
        assert _alive(old_child) is False

    def test_same_request_is_idempotent_noop(self, scene) -> None:
        request_id = f"upg-{uuid.uuid4().hex}"
        first = scene.switch(request_id=request_id)
        assert first["ok"] is True, first
        generation = scene.state().generation
        child = scene.status()["child_pid"]

        second = scene.switch(request_id=request_id)

        assert second["ok"] is True, second
        assert second.get("noop") is True
        assert scene.state().generation == generation
        assert scene.status()["child_pid"] == child

    def test_launcher_restart_adopts_running_child(self, scene) -> None:
        before = scene.status()
        child = int(before["child_pid"])
        scene.kill_launcher()
        assert _alive(child)

        scene.start()
        after = scene.status()

        assert after["launcher_pid"] != before["launcher_pid"]
        assert after["child_pid"] == child
        assert after["child_alive"] is True
        assert _alive(child)

    def test_upgrade_status_cli_reports_state(self, scene, capsys) -> None:
        from forgeloop.cli.main import main

        code = main(["upgrade", "status", "--prefix", str(scene.prefix), "--json"])
        captured = capsys.readouterr()
        assert code == 0, captured.out + captured.err
        document = json.loads(captured.out)
        assert document["state"]["identity"]["version"] == "0.0.1"

    def test_direct_deploy_on_managed_prefix_is_refused(self, scene, capsys) -> None:
        from forgeloop.cli.main import main

        code = main(
            [
                "deploy",
                "--tag",
                "v0.0.2",
                "--prefix",
                str(scene.prefix),
                "--records-root",
                str(scene.records),
            ]
        )
        captured = capsys.readouterr()
        assert code == 1
        assert "已由固定启动器托管" in captured.out + captured.err
        assert "upgrade apply" in captured.out + captured.err
        assert scene.current_version() == "0.0.1"


class TestFailureRecovery:
    def test_candidate_failure_rolls_back_to_old_process(self) -> None:
        scene = SupervisedUpgradeScene(candidate_fail_ready=True)
        try:
            scene.start()
            old_state = scene.state()
            assert old_state is not None
            response = scene.switch()
            assert response["ok"] is False, response
            assert response["code"] == "rolled_back", response
            state = scene.state()
            assert state is not None
            assert state.phase == PHASE_ROLLED_BACK
            assert state.identity.version == "0.0.1"
            assert state.identity.generation != old_state.generation
            assert scene.current_version() == "0.0.1"
            status = scene.status()
            assert status["child_alive"] is True
            assert _alive(int(status["child_pid"]))
        finally:
            scene.cleanup()

    def test_bad_module_path_is_not_ready_and_rolls_back(self) -> None:
        scene = SupervisedUpgradeScene(candidate_bad_module=True)
        try:
            scene.start()
            response = scene.switch()
            assert response["ok"] is False, response
            assert response["code"] == "rolled_back", response
            assert "模块加载路径" in response["message"] or "未就绪" in response["message"]
            assert scene.current_version() == "0.0.1"
        finally:
            scene.cleanup()

    def test_rollback_failure_enters_recovery_required(self) -> None:
        scene = SupervisedUpgradeScene(candidate_fail_ready=True, old_fail_on_restart=True)
        try:
            scene.start()
            (scene.prefix / "releases" / "0.0.1" / ".fail-on-start").write_text(
                "fail", encoding="utf-8"
            )
            response = scene.switch()
            assert response["ok"] is False, response
            assert response["code"] == "recovery_required", response
            state = scene.state()
            assert state is not None
            assert state.phase == PHASE_RECOVERY_REQUIRED
            assert state.identity.version == "0.0.1"
            # 恢复失败后不再自动启动第二个可执行实例。
            assert scene.status()["child_alive"] is False
            refused = scene.switch(digest=OTHER_DIGEST)
            assert refused["ok"] is False
            assert "recovery_required" in str(refused["message"])
        finally:
            scene.cleanup()


class _FakeProcess:
    def __init__(self) -> None:
        self.pid = 9999
        self.returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.returncode = -15

    def kill(self) -> None:
        self.returncode = -9


class TestLauncherInProcess:
    """在进程内驱动启动器分支；真实子进程路径由 TestIdleUpgrade/系统用例覆盖。"""

    def _launcher(self, scene: SupervisedUpgradeScene, monkeypatch):
        from forgeloop.adapter.upgrade_control import read_owner
        from forgeloop.cli.launcher import Launcher
        from forgeloop.domain.upgrade import DrainDecision, OwnerBinding

        owner = OwnerBinding.from_document(read_owner(scene.prefix))
        launcher = Launcher(owner, scene.prefix.resolve())
        monkeypatch.setattr(launcher, "_spawn", lambda identity: _FakeProcess())
        monkeypatch.setattr(launcher, "_wait_ready", lambda process, identity: "")
        monkeypatch.setattr(
            launcher,
            "_wait_for_drain",
            lambda generation: DrainDecision(True, "排空完成"),
        )
        monkeypatch.setattr(launcher, "_terminate_and_confirm", lambda process: None)
        return launcher

    def _request(self, scene: SupervisedUpgradeScene, **overrides):
        from forgeloop.domain.upgrade import UpgradeRequest

        data: dict[str, str] = {
            "request_id": f"upg-{uuid.uuid4().hex}",
            "project": PROJECT,
            "prefix": str(scene.prefix.resolve()),
            "tag": "v0.0.2",
            "artifact_sha256": NEW_DIGEST,
            "by": "owner",
            "reason": "进程内测试",
        }
        data.update(overrides)
        return UpgradeRequest(
            request_id=data["request_id"],
            project=data["project"],
            prefix=data["prefix"],
            tag=data["tag"],
            artifact_sha256=data["artifact_sha256"],
            by=data["by"],
            reason=data["reason"],
        )

    def test_adopt_and_commit_switch(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            launcher._start_committed(state)
            assert launcher.state is not None
            assert launcher.state.phase == PHASE_COMMITTED

            result = launcher._switch_locked(self._request(scene))

            assert result["ok"] is True, result
            state = scene.state()
            assert state is not None
            assert state.phase == PHASE_COMMITTED
            assert state.identity.version == "0.0.2"
            assert state.previous is not None
            assert state.previous.version == "0.0.1"
            assert scene.current_version() == "0.0.2"
            noop = launcher._switch_locked(self._request(scene))
            assert noop["ok"] is True and noop.get("noop") is True
        finally:
            scene.cleanup()

    def test_candidate_failure_rolls_back_in_process(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            monkeypatch.setattr(
                launcher,
                "_wait_ready",
                lambda process, identity: "候选未就绪" if identity.version == "0.0.2" else "",
            )

            result = launcher._switch_locked(self._request(scene))

            assert result["ok"] is False
            assert result["code"] == "rolled_back", result
            state = scene.state()
            assert state is not None
            assert state.phase == PHASE_ROLLED_BACK
            assert state.identity.version == "0.0.1"
            assert scene.current_version() == "0.0.1"
        finally:
            scene.cleanup()

    def test_restore_failure_enters_recovery_in_process(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            monkeypatch.setattr(launcher, "_wait_ready", lambda process, identity: "一直未就绪")

            result = launcher._switch_locked(self._request(scene))

            assert result["ok"] is False
            assert result["code"] == "recovery_required", result
            state = scene.state()
            assert state is not None and state.phase == PHASE_RECOVERY_REQUIRED
        finally:
            scene.cleanup()

    def test_missing_approval_is_refused_before_state_change(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene(approve=False)
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            before = scene.state()

            result = launcher._switch(self._request(scene))

            assert result["ok"] is False
            assert "部署批准" in str(result["message"])
            assert scene.state() == before
        finally:
            scene.cleanup()

    def test_helper_error_branches(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import launcher as module

        assert module._prefix("") == module.default_prefix()
        assert module._read_service_document(Path("/definitely/missing.toml")) is None
        bad = Path(tempfile.mkdtemp(prefix="flup-badcfg-", dir="/tmp")) / "bad.toml"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text("not = [", encoding="utf-8")
        with pytest.raises(module.LauncherRefused):
            module._read_service_document(bad)
        with pytest.raises(module.LauncherRefused):
            module._upgrade_settings(bad)
        assert module._manifest_for(tmp_path / "missing") is None

        scene = SupervisedUpgradeScene()
        try:
            version_dir = scene.prefix / "releases" / "0.0.2"
            (version_dir / "artifact.json").write_text("{broken", encoding="utf-8")
            with pytest.raises(module.LauncherRefused):
                module._manifest_for(version_dir)
        finally:
            scene.cleanup()

    def test_status_and_control_failures(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            status = launcher._status_response()
            assert status["ok"] is True
            assert status["child_pid"] == 9999
            assert launcher._handle_control("status", {})["ok"] is True
            invalid = launcher._handle_control("switch", {"request": {}})
            assert invalid["ok"] is False and invalid["code"] == "invalid_request"
            unsupported = launcher._handle_control("exec", {})
            assert unsupported["code"] == "unsupported_operation"
            launcher._child = None
            launcher._adopted_pid = None
            empty = launcher._status_response()
            assert empty["child_pid"] is None
            assert empty["child_alive"] is False
        finally:
            scene.cleanup()

    def test_reconcile_restart_and_hold_branches(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import (
            PHASE_DRAINING,
            PHASE_PREPARED,
            PHASE_PROBING,
            PHASE_RECOVERY_REQUIRED,
            PHASE_STARTING,
        )

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            for phase in (PHASE_PREPARED, PHASE_DRAINING, PHASE_STARTING, PHASE_PROBING):
                restarted = launcher._restart_state(replace(state, phase=phase), "gen-000009")
                assert restarted.generation == "gen-000009"
            launcher.store.write(replace(state, phase=PHASE_RECOVERY_REQUIRED))
            held = launcher._reconcile_and_start()
            assert held.phase == PHASE_RECOVERY_REQUIRED
            previous = replace(state.identity, generation="gen-000000")
            rolled = launcher._rollback_after_restart(
                replace(state, phase=PHASE_STARTING, previous=previous)
            )
            assert rolled.phase == PHASE_ROLLED_BACK
        finally:
            scene.cleanup()

    def test_rollback_after_restart_without_previous(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.domain.upgrade import PHASE_RECOVERY_REQUIRED, PHASE_STARTING

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            result = launcher._rollback_after_restart(
                replace(state, phase=PHASE_STARTING, previous=None)
            )
            assert result.phase == PHASE_RECOVERY_REQUIRED
        finally:
            scene.cleanup()

    def test_ready_failures_and_spawn_refusal(self, monkeypatch) -> None:
        import time

        from forgeloop.cli import launcher as module

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            identity = launcher._adopt_current().identity
            dead = _FakeProcess()
            dead.returncode = 1
            wait_ready = type(launcher)._wait_ready.__get__(launcher)
            assert "已退出" in wait_ready(dead, identity)

            alive = _FakeProcess()
            monkeypatch.setattr(
                launcher, "settings", module.UpgradeSettings(readiness_timeout_seconds=1)
            )
            started = time.monotonic()
            problem = wait_ready(alive, identity)
            assert "超时" in problem
            assert time.monotonic() - started >= 0.9

            monkeypatch.setattr(launcher, "_wait_ready", lambda process, ident: "未就绪")
            with pytest.raises(module.LauncherRefused):
                launcher._start_committed(launcher._adopt_current())
        finally:
            scene.cleanup()

    def test_drain_failures_and_candidate_errors(self, monkeypatch) -> None:
        from forgeloop.cli import launcher as module

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            launcher.state = state
            launcher._child = None
            launcher._adopted_pid = None
            wait_for_drain = type(launcher)._wait_for_drain.__get__(launcher)
            result = wait_for_drain(state.generation)
            assert result.proceed is False

            launcher._child = cast("subprocess.Popen[bytes]", _FakeProcess())
            (scene.prefix / "control" / f"drain-{state.generation}.json").write_text(
                "{}", encoding="utf-8"
            )
            result = wait_for_drain(state.generation)
            assert result.proceed is False

            with pytest.raises(module.LauncherRefused):
                module._count_outstanding_actions(scene.root / "missing")
        finally:
            scene.cleanup()

    def test_candidate_artifact_errors(self, monkeypatch) -> None:
        from forgeloop.cli import launcher as module

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            target = launcher._adopt_current().identity
            location = type(
                "L",
                (),
                {"project": type("P", (), {"repo_path": "", "project_id": PROJECT})()},
            )()
            request = self._request(scene)
            with pytest.raises(module.LauncherRefused):
                launcher._candidate_artifact(target, location, request)  # type: ignore[arg-type]

            bad_dir = scene.prefix / "releases" / "0.0.9"
            bad_dir.mkdir(parents=True)
            (bad_dir / "artifact.json").write_text("{}", encoding="utf-8")
            monkeypatch.setattr(launcher, "_candidate_artifact", lambda *a: scene.root / "x.whl")
            with pytest.raises(module.LauncherRefused):
                launcher._ensure_candidate(
                    module.UpgradeIdentity(
                        version="0.0.9",
                        tag="v0.0.9",
                        artifact_sha256="a" * 64,
                        build_commit="b" * 40,
                        generation="",
                    ),
                    location,  # type: ignore[arg-type]
                    request,
                )
        finally:
            scene.cleanup()

    def test_stop_child_and_terminate_pid(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            fake = _FakeProcess()
            launcher._child = cast("subprocess.Popen[bytes]", fake)
            launcher._stop_child()
            assert fake.returncode == 0
            assert launcher._terminate_pid(99999999, 0.1) is True
            launcher._adopted_pid = 99999999
            launcher._stop_child()
        finally:
            scene.cleanup()

    def test_supervise_exit_branch(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            fake = _FakeProcess()
            fake.returncode = 7
            launcher._child = cast("subprocess.Popen[bytes]", fake)
            assert launcher._supervise() == 7
        finally:
            scene.cleanup()

    def test_receipt_digest_variants(self, tmp_path: Path) -> None:
        from datetime import UTC, datetime
        from types import SimpleNamespace

        from forgeloop.cli import launcher as module
        from forgeloop.domain.release import ReleaseRecord

        location = SimpleNamespace(root=tmp_path)
        release = ReleaseRecord(
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
        assert module._receipt_digest(location, release) == ""  # type: ignore[arg-type]

        absolute = tmp_path / "absolute.json"
        absolute.write_text('{"artifact_sha256": "' + "d" * 64 + '"}', encoding="utf-8")
        absolute_release = ReleaseRecord(
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
        assert module._receipt_digest(location, absolute_release) == "d" * 64  # type: ignore[arg-type]

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

    def test_approval_mismatch_and_unknown_phase(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.cli import launcher as module
        from forgeloop.domain.upgrade import PHASE_DRAINING
        from forgeloop.records.store import RecordStore

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            record = RecordStore(scene.project_root / "records.sqlite")
            try:
                record.record_deploy_approval("v0.0.2", "c" * 64, by="owner", reason="错误绑定")
            finally:
                record.close()
            with pytest.raises(module.LauncherRefused, match="批准与请求不符"):
                module._verify_release_and_approval(launcher.owner, self._request(scene))
            record = RecordStore(scene.project_root / "records.sqlite")
            try:
                record.record_deploy_approval(
                    "v0.0.2", NEW_DIGEST, by="owner", reason="恢复正确绑定"
                )
            finally:
                record.close()

            launcher.state = state
            launcher._child = cast("subprocess.Popen[bytes]", _FakeProcess())
            result = launcher._switch_locked(self._request(scene))
            assert result["ok"] is True

            launcher.store.write(replace(state, phase=PHASE_DRAINING))
            refused = launcher._switch_locked(self._request(scene))
            assert refused["ok"] is False
        finally:
            scene.cleanup()

    def test_local_artifact_install_and_candidate_lookup(self, tmp_path: Path, monkeypatch) -> None:
        import hashlib
        from types import SimpleNamespace

        from forgeloop.cli import launcher as module

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            target = module.UpgradeIdentity(
                version="0.0.3",
                tag="v0.0.3",
                artifact_sha256=hashlib.sha256(b"wheel").hexdigest(),
                build_commit="a" * 40,
                generation="",
            )
            (scene.prefix / "artifacts").mkdir(parents=True)
            artifact = scene.prefix / "artifacts" / "forgeloop-0.0.3-py3-none-any.whl"
            artifact.write_bytes(b"wheel")
            location = cast(
                "ProjectLocation",
                SimpleNamespace(
                    project=SimpleNamespace(repo_path="", project_id=PROJECT),
                    root=scene.project_root,
                ),
            )

            def fake_install(source: Path, destination: Path) -> None:
                (destination / "bin").mkdir(parents=True)
                (destination / "bin" / "forgeloop").write_text("#!/bin/sh\n")

            monkeypatch.setattr(module, "install_wheel", fake_install)
            launcher._ensure_candidate(target, location, self._request(scene))
            assert (scene.prefix / "releases" / "0.0.3" / "artifact.json").is_file()

            found = launcher._candidate_artifact(
                target,
                location,
                self._request(scene),
            )
            assert found.resolve() == artifact.resolve()
        finally:
            scene.cleanup()

    def test_wait_ready_bad_report_and_drain_outstanding(self, monkeypatch) -> None:

        from forgeloop.records.store import RecordStore

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            identity = launcher._adopt_current().identity
            wait_ready = type(launcher)._wait_ready.__get__(launcher)
            launcher.store.report_path("ready", identity.generation).write_text(
                "{broken", encoding="utf-8"
            )
            assert "不可读" in wait_ready(_FakeProcess(), identity)

            store = RecordStore(scene.project_root / "records.sqlite")
            try:
                store.create_task(
                    "task-x", PROJECT, "input", {"pi_command": "[]", "test_command": "[]"}, 7200.0
                )
                store.actions.begin("task-x", "dev", pid=1)
            finally:
                store.close()
            fake_child = _FakeProcess()
            import os

            fake_child.pid = os.getpid()
            launcher._child = cast("subprocess.Popen[bytes]", fake_child)
            launcher.store.write_report(
                "drain",
                identity.generation,
                {
                    "schema_version": 1,
                    "generation": identity.generation,
                    "pid": launcher._child.pid,
                    "completed": True,
                    "active_calls": 0,
                    "active_turns": 0,
                    "active_agent_processes": 0,
                    "pending_requests": 0,
                },
            )
            wait_for_drain = type(launcher)._wait_for_drain.__get__(launcher)
            decision = wait_for_drain(identity.generation)
            assert decision.proceed is False
            assert "未核对" in decision.reason
        finally:
            scene.cleanup()

    def test_control_switch_and_supervise_adopted(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            request = self._request(scene)
            payload = {
                "protocol_version": 1,
                "request_id": request.request_id,
                "project": request.project,
                "prefix": request.prefix,
                "tag": request.tag,
                "artifact_sha256": request.artifact_sha256,
                "by": request.by,
                "reason": request.reason,
            }
            response = launcher._handle_control("switch", {"request": payload})
            assert response["ok"] is True

            launcher._child = None
            launcher._adopted_pid = 99999999
            assert launcher._supervise() == 1
        finally:
            scene.cleanup()

    def test_verify_refusal_variants(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.cli import launcher as module

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._adopt_current()
            request = self._request(scene)
            for broken, needle in (
                (replace(request, project="other"), "请求项目"),
                (replace(request, prefix="/tmp/other-prefix"), "请求前缀"),
                (replace(request, tag="v0.0.9"), "发布回执"),
                (replace(request, artifact_sha256="c" * 64), "发布回执不符"),
            ):
                with pytest.raises(module.LauncherRefused, match=needle):
                    module._verify_release_and_approval(launcher.owner, broken)

            from forgeloop.records.store import RecordStore

            record = RecordStore(scene.project_root / "records.sqlite")
            try:
                record._db.execute("DELETE FROM deploy_approvals")
                record._db.commit()
            finally:
                record.close()
            with pytest.raises(module.LauncherRefused, match="部署批准"):
                module._verify_release_and_approval(launcher.owner, request)
        finally:
            scene.cleanup()

    def test_switch_phase_refusals_and_recovery(self, monkeypatch) -> None:
        from dataclasses import replace

        from forgeloop.cli import launcher as module
        from forgeloop.domain.upgrade import PHASE_RECOVERY_REQUIRED

        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            state = launcher._adopt_current()
            launcher.state = state
            launcher.store.write(replace(state, phase=PHASE_RECOVERY_REQUIRED))
            refused = launcher._switch(self._request(scene))
            assert refused["ok"] is False
            assert "recovery_required" in str(refused["message"])

            launcher.store.write(state)
            result = launcher._enter_recovery(state, "人工核对")
            assert result["code"] == "recovery_required"
            recovered = launcher.store.read()
            assert recovered is not None
            assert recovered.phase == PHASE_RECOVERY_REQUIRED

            module._write_manifest(
                scene.prefix / "releases" / "0.0.2",
                module.ArtifactManifest(
                    version="0.0.2",
                    tag="v0.0.2",
                    artifact_sha256=NEW_DIGEST,
                    build_commit="a" * 40,
                ),
            )
            assert (scene.prefix / "releases" / "0.0.2" / "artifact.json").is_file()
        finally:
            scene.cleanup()

    def test_init_owner_cli(self, tmp_path: Path, capsys) -> None:
        from forgeloop.cli import launcher as module

        prefix = Path(tempfile.mkdtemp(prefix="flup-owner-", dir="/tmp"))
        records = tmp_path / "records"
        register_project(records)
        service = tmp_path / "service.toml"
        service.write_text("[upgrade]\ndrain_timeout_seconds = 2\n", encoding="utf-8")
        code = module.main(
            [
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
        )
        captured = capsys.readouterr()
        assert code == 0, captured.out + captured.err
        assert (prefix / "control" / "owner.json").is_file()
        duplicate = module.main(
            [
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
        )
        assert duplicate == 1

    def test_download_artifact_path(self, monkeypatch) -> None:
        import hashlib

        from forgeloop.cli import launcher as module

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
            location = type(
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
            found = launcher._candidate_artifact(target, location, self._request(scene))  # type: ignore[arg-type]
            assert found.read_bytes() == payload
        finally:
            scene.cleanup()

    def test_install_failure_and_restore_failure(self, monkeypatch) -> None:
        import hashlib

        from forgeloop.adapter.deployment import DeploymentError
        from forgeloop.cli import launcher as module

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
            location = type(
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
                launcher._ensure_candidate(target, location, self._request(scene))  # type: ignore[arg-type]

            state = launcher._adopt_current()
            monkeypatch.setattr(
                module, "activate", lambda *a: (_ for _ in ()).throw(DeploymentError("指针坏"))
            )
            with pytest.raises(module.LauncherRefused):
                launcher._restore_previous(state.identity, state)
        finally:
            scene.cleanup()

    def test_wait_for_drain_proceed_and_timeout(self, monkeypatch) -> None:
        import os

        from forgeloop.cli import launcher as module

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
            decision = wait_for_drain(identity.generation)
            assert decision.proceed is True

            monkeypatch.setattr(
                launcher,
                "settings",
                module.UpgradeSettings(drain_timeout_seconds=1),
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
        import subprocess

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

    def test_reconcile_hold_and_restart(self, monkeypatch) -> None:
        scene = SupervisedUpgradeScene()
        try:
            launcher = self._launcher(scene, monkeypatch)
            launcher._start_committed(launcher._adopt_current())
            state = launcher.state
            assert state is not None
            launcher._adopted_pid = 9999
            with __import__("unittest").mock.patch(
                "forgeloop.cli.launcher.process_alive", return_value=True
            ):
                adopted = launcher._reconcile_and_start()
                assert adopted.generation == state.generation
        finally:
            scene.cleanup()

    def test_drain_timeout_defers_and_old_process_keeps_running(self) -> None:
        scene = SupervisedUpgradeScene(old_ignore_drain=True, drain_timeout=1.0)
        try:
            scene.start()
            old_child = int(scene.status()["child_pid"])
            response = scene.switch()
            assert response["ok"] is False, response
            assert response["code"] == "deferred", response
            state = scene.state()
            assert state is not None
            assert state.phase == PHASE_DEFERRED
            assert scene.current_version() == "0.0.1"
            assert _alive(old_child)
            assert scene.status()["child_pid"] == old_child
        finally:
            scene.cleanup()
