"""排空集成：真实 SQLite + 真实子进程，验证“等调用结束”与“只消费一次”。

业务执行体用真实 `python -c sleep` 子进程代替长任务，排空逻辑、持久请求与
worker ticket 都是生产实现；不访问模型，也不伪造生产批准。
"""

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.service_requests import ServiceRequestStore


class SubprocessWorker(ServiceWorker):
    def __init__(self, root: Path, *, seconds: float, started: threading.Event) -> None:
        super().__init__(root, poll_seconds=1, auto_advance=False, projects={})
        self.seconds = seconds
        self.started = started

    def _advance_once_locked(self, *, only=None) -> dict:
        self.started.set()
        subprocess.run(
            [sys.executable, "-c", f"import time; time.sleep({self.seconds})"],
            check=True,
            shell=False,
        )
        return {}


def _record(root: Path) -> None:
    store = ServiceRequestStore(root / "records.sqlite")
    try:
        store.record(
            req_id="req-1",
            project="forgeloop",
            plan_version=1,
            requested_by="owner",
            source="web",
        )
    finally:
        store.close()


def _pending(root: Path) -> tuple[str, ...]:
    store = ServiceRequestStore(root / "records.sqlite")
    try:
        return tuple(item.req_id for item in store.pending())
    finally:
        store.close()


class TestDrainWithRealSubprocess:
    def test_tick_holds_ticket_until_subprocess_exits(self, tmp_path: Path) -> None:
        _record(tmp_path)
        started = threading.Event()
        worker = SubprocessWorker(tmp_path, seconds=0.6, started=started)
        thread = threading.Thread(target=worker._tick)
        thread.start()
        assert started.wait(3.0)
        began = time.monotonic()

        report = worker.drain(timeout=5.0)

        elapsed = time.monotonic() - began
        assert report.completed is True
        assert elapsed >= 0.3
        assert report.pending_requests == 0
        assert _pending(tmp_path) == ()
        thread.join(timeout=3.0)

    def test_timeout_defers_and_does_not_replay_claimed_request(self, tmp_path: Path) -> None:
        _record(tmp_path)
        started = threading.Event()
        worker = SubprocessWorker(tmp_path, seconds=1.2, started=started)
        thread = threading.Thread(target=worker._tick)
        thread.start()
        assert started.wait(3.0)

        report = worker.drain(timeout=0.1)

        assert report.completed is False
        assert report.active_calls == 1
        # 已 claim 的请求不会回到 pending：宁可人工重试，也不盲目重放。
        assert _pending(tmp_path) == ()
        thread.join(timeout=4.0)
        assert _pending(tmp_path) == ()


def _report(completed: bool):
    from forgeloop.graph.worker import DrainReport

    return DrainReport(completed=completed)


class _FakeRunner:
    def __init__(self) -> None:
        self.draining = False

    def drain(self, *, timeout: float):
        from forgeloop.graph.conversation import DrainReport

        return DrainReport(completed=True, active_turns=0, queued_turns=0, live_sessions=0)

    def resume(self) -> None:
        self.draining = False


class TestManagedRuntime:
    def _runtime(self, tmp_path: Path):
        from types import SimpleNamespace

        from forgeloop.cli.serve import ManagedRuntime, RuntimeIdentity
        from forgeloop.domain.upgrade import (
            UpgradeIdentity,
            UpgradeSettings,
            UpgradeState,
        )
        from forgeloop.records.upgrade_state import UpgradeStateStore

        control = tmp_path / "prefix" / "control"
        store = UpgradeStateStore(control)
        identity = UpgradeIdentity(
            version="0.0.1",
            tag="v0.0.1",
            artifact_sha256="a" * 64,
            build_commit="b" * 40,
            generation="gen-000001",
        )
        state = UpgradeState(
            identity=identity,
            project="forgeloop",
            prefix="/tmp/forgeloop-prefix",
            records_root=str(tmp_path),
            phase="committed",
            generation="gen-000001",
        )
        store.write(state)
        runtime = ManagedRuntime(
            state_path=store.state_path,
            generation="gen-000001",
            ready_path=store.report_path("ready", "gen-000001"),
            drain_path=store.report_path("drain", "gen-000001"),
            prefix=tmp_path / "prefix",
            settings=UpgradeSettings(drain_timeout_seconds=1.0),
            identity=RuntimeIdentity(
                version="0.0.1",
                tag="v0.0.1",
                artifact_sha256="a" * 64,
                build_commit="b" * 40,
                module_path=str(tmp_path / "forgeloop" / "__init__.py"),
                release_dir=str(tmp_path / "release"),
                source="test",
            ),
            project_id="forgeloop",
            records_root=str(tmp_path),
        )
        runner = _FakeRunner()
        from typing import Any

        panel: Any = SimpleNamespace(runner=runner)
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False, projects={})
        return runtime, worker, panel, store

    def test_ready_and_drain_reports_are_written(self, tmp_path: Path) -> None:
        import json

        runtime, worker, panel, _store = self._runtime(tmp_path)

        runtime.write_ready("127.0.0.1", 1234)
        ready = json.loads(runtime.ready_path.read_text(encoding="utf-8"))
        assert ready["ready"] is True
        assert ready["generation"] == "gen-000001"
        assert ready["module_path"].endswith("__init__.py")

        runtime._perform_drain(worker, panel, None)

        report = json.loads(runtime.drain_path.read_text(encoding="utf-8"))
        assert report["completed"] is True
        assert report["generation"] == "gen-000001"
        assert report["pending_requests"] == 0
        assert runtime._drained is True

    def test_admitted_and_deferred_phases_resume_the_old_generation(self, tmp_path: Path) -> None:
        from dataclasses import replace
        from threading import Event

        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        worker.drain(timeout=0)
        panel.runner.draining = True

        runtime._observe(Event(), worker, panel, None)

        assert worker.draining is False
        assert panel.runner.draining is False

        store.write(replace(state, phase="deferred"))
        runtime._drained = True
        runtime._await_outcome(Event(), worker, panel, None)
        assert worker.draining is False

    def test_perform_drain_marks_incomplete_for_mail_or_outstanding(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from types import SimpleNamespace

        runtime, worker, panel, _store = self._runtime(tmp_path)
        mail = SimpleNamespace(
            running=True,
            stop=lambda timeout: None,
        )
        monkeypatch.setattr(type(worker), "drain", lambda self, timeout: _report(False))
        runtime._perform_drain(worker, panel, mail)  # type: ignore[arg-type]
        assert runtime._drained is False
        assert "邮件" in runtime.drain_path.read_text(encoding="utf-8")

    def test_await_outcome_recovery_and_timeout(self, tmp_path: Path, monkeypatch) -> None:
        from dataclasses import replace
        from threading import Event

        from forgeloop.cli import serve as module

        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        store.write(replace(state, phase="recovery_required"))
        runtime._await_outcome(Event(), worker, panel, None)

        store.write(replace(state, phase="draining"))
        monkeypatch.setattr(module, "DRAIN_OUTCOME_WAIT_SECONDS", 0.01)
        worker.drain(timeout=0)
        runtime._await_outcome(Event(), worker, panel, None)
        assert worker.draining is False

    def test_observe_draining_runs_drain_once(self, tmp_path: Path, monkeypatch) -> None:
        from dataclasses import replace
        from threading import Event

        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        store.write(replace(state, phase="draining"))
        calls: list[str] = []
        monkeypatch.setattr(runtime, "_perform_drain", lambda *a: calls.append("drain"))
        monkeypatch.setattr(runtime, "_await_outcome", lambda *a: calls.append("await"))

        runtime._observe(Event(), worker, panel, None)

        assert calls == ["drain", "await"]

    def test_resume_restarts_stopped_mail_worker(self, tmp_path: Path) -> None:
        from types import SimpleNamespace

        runtime, worker, panel, _store = self._runtime(tmp_path)
        started: list[str] = []
        mail = SimpleNamespace(running=False, start=lambda: started.append("start"))
        worker.drain(timeout=0)
        runtime._resume(worker, panel, mail)  # type: ignore[arg-type]
        assert started == ["start"]
        assert worker.draining is False

    def test_await_outcome_new_generation_sets_stop(self, tmp_path: Path) -> None:
        from dataclasses import replace
        from threading import Event

        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        store.write(
            replace(
                state,
                generation="gen-000002",
                identity=replace(state.identity, generation="gen-000002"),
                phase="starting",
            )
        )
        stop = Event()
        runtime._await_outcome(stop, worker, panel, None)
        assert stop.is_set()

    def test_observe_none_and_new_generation(self, tmp_path: Path, monkeypatch) -> None:
        from dataclasses import replace
        from threading import Event

        runtime, worker, panel, store = self._runtime(tmp_path)
        monkeypatch.setattr(runtime, "read_state", lambda: None)
        runtime._observe(Event(), worker, panel, None)

        state = store.read()
        assert state is not None
        store.write(
            replace(
                state,
                generation="gen-000002",
                identity=replace(state.identity, generation="gen-000002"),
                phase="committed",
            )
        )
        monkeypatch.setattr(runtime, "read_state", lambda: store.read())
        stop = Event()
        runtime._observe(stop, worker, panel, None)
        assert stop.is_set()

    def test_missing_generation_guards(self, tmp_path: Path, capsys) -> None:
        runtime, worker, panel, _store = self._runtime(tmp_path)
        runtime.generation = ""
        runtime.write_ready("127.0.0.1", 1)
        captured = capsys.readouterr()
        assert "缺少 generation" in captured.out
        assert not runtime.ready_path.exists()
        runtime.start_watchdog(threading.Event(), worker, panel, None)
        assert runtime._thread is None

    def test_managed_prefix_from_env_and_state(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace
        from typing import Any

        from forgeloop.cli import serve as module

        admission: Any = SimpleNamespace(state_path=tmp_path / "prefix" / "control" / "state.json")
        monkeypatch.delenv(module.ENV_UPGRADE_PREFIX, raising=False)
        assert module._managed_prefix(admission) == tmp_path / "prefix"
        monkeypatch.setenv(module.ENV_UPGRADE_PREFIX, str(tmp_path / "explicit"))
        assert module._managed_prefix(admission) == (tmp_path / "explicit").resolve()

    def test_check_panel_reports_bad_pi_home(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace

        from forgeloop.cli import serve as module

        registry = SimpleNamespace(
            path=tmp_path / "projects.toml",
            entries=lambda: [
                SimpleNamespace(name="forgeloop", source=module.SOURCE_PANEL, pi_home=tmp_path)
            ],
        )
        monkeypatch.setattr(module, "pi_home_problems", lambda home: ["缺少 models.json"])
        with pytest.raises(module.ServeConfigError, match="PI HOME 不可用"):
            module.check_panel(registry)  # type: ignore[arg-type]

    def test_from_environment_and_unmanaged_document(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module
        from forgeloop.domain.service import resolve_panel_settings
        from forgeloop.domain.upgrade import UpgradeSettings

        settings = module.ServeSettings(
            web=module.WebSettings(
                tmp_path,
                "127.0.0.1",
                0,
                module.resolve_refresh_seconds(None, cli_value=60),
                tmp_path / "web.toml",
                module.ProgressDocuments(lambda *a: {}, lambda *a: {}),
                project_id="forgeloop",
            ),
            service=module.ServiceSettings(
                host="127.0.0.1",
                port=0,
                poll_seconds=1,
                max_concurrent=1,
                auto_advance=False,
                projects={},
                panel=resolve_panel_settings(None),
            ),
            config_path=tmp_path / "service.toml",
            operations=module.ServeOperations(
                approve_requirement=lambda args: 0,
                accept_requirement=lambda args: 0,
                stop_task=lambda args: 0,
            ),
            projects_path=tmp_path / "projects.toml",
            project=None,
            upgrade=UpgradeSettings(),
        )
        for key in (
            module.ENV_UPGRADE_MANAGED,
            module.ENV_UPGRADE_STATE,
            module.ENV_UPGRADE_GENERATION,
            module.ENV_UPGRADE_PREFIX,
        ):
            monkeypatch.delenv(key, raising=False)
        assert module.ManagedRuntime.from_environment(settings) is None
        monkeypatch.setenv(module.ENV_UPGRADE_MANAGED, "1")
        monkeypatch.setenv(
            module.ENV_UPGRADE_STATE, str(tmp_path / "control" / "upgrade-state.json")
        )
        monkeypatch.setenv(module.ENV_UPGRADE_GENERATION, "gen-000001")
        runtime = module.ManagedRuntime.from_environment(settings)
        assert runtime is not None
        assert runtime.generation == "gen-000001"

    def test_upgrade_document_unmanaged(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module
        from forgeloop.domain.service import resolve_panel_settings

        monkeypatch.delenv(module.ENV_UPGRADE_STATE, raising=False)
        document = module.upgrade_document(
            module.ServeSettings(
                web=module.WebSettings(
                    tmp_path,
                    "127.0.0.1",
                    0,
                    module.resolve_refresh_seconds(None, cli_value=60),
                    tmp_path / "web.toml",
                    module.ProgressDocuments(lambda *a: {}, lambda *a: {}),
                    project_id="",
                ),
                service=module.ServiceSettings(
                    host="127.0.0.1",
                    port=0,
                    poll_seconds=1,
                    max_concurrent=1,
                    auto_advance=False,
                    projects={},
                    panel=resolve_panel_settings(None),
                ),
                config_path=tmp_path / "service.toml",
                operations=module.ServeOperations(
                    approve_requirement=lambda args: 0,
                    accept_requirement=lambda args: 0,
                    stop_task=lambda args: 0,
                ),
                projects_path=tmp_path / "projects.toml",
            )
        )
        assert document["managed"] is False
        assert "running_version" in document

    def test_new_generation_requests_process_exit(self, tmp_path: Path) -> None:
        from dataclasses import replace
        from threading import Event

        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        next_identity = replace(state.identity, generation="gen-000002")
        store.write(
            replace(
                state,
                phase="starting",
                generation="gen-000002",
                identity=next_identity,
            )
        )
        stop = Event()

        runtime._observe(stop, worker, panel, None)

        assert stop.is_set() is True


class TestServeManagedDrain:
    """真实 serve 子进程：读取 draining、写排空报告、deferred 恢复、换代退出。"""

    def _state(self, phase: str, generation: str = "gen-000001"):
        from forgeloop.domain.upgrade import UpgradeIdentity, UpgradeState

        return UpgradeState(
            identity=UpgradeIdentity(
                version="0.0.1",
                tag="v0.0.1",
                artifact_sha256="a" * 64,
                build_commit="b" * 40,
                generation=generation,
            ),
            project="forgeloop",
            prefix="/tmp/forgeloop-prefix",
            records_root="/tmp/forgeloop-prefix/records",
            phase=phase,
            generation=generation,
        )

    def test_serve_drains_writes_report_and_exits_on_new_generation(self, tmp_path: Path) -> None:
        import json
        import os
        import subprocess
        import sys
        import time

        from project_support import register_project

        from forgeloop.records.upgrade_state import UpgradeStateStore

        root = tmp_path / "records"
        register_project(root)
        service = tmp_path / "service.toml"
        service.write_text(
            "schema_version = 1\n"
            'host = "127.0.0.1"\n'
            "port = 0\n"
            "poll_seconds = 1\n"
            "max_concurrent = 1\n"
            "auto_advance = false\n",
            encoding="utf-8",
        )
        web = tmp_path / "web.toml"
        web.write_text("schema_version = 1\nrefresh_seconds = 60\n", encoding="utf-8")
        projects = tmp_path / "projects.toml"
        projects.write_text("schema_version = 1\n", encoding="utf-8")
        control = tmp_path / "prefix" / "control"
        store = UpgradeStateStore(control)
        store.write(self._state("committed"))
        ready = store.report_path("ready", "gen-000001")
        drain = store.report_path("drain", "gen-000001")
        environment = dict(os.environ)
        environment.update(
            {
                "FORGELOOP_UPGRADE_MANAGED": "1",
                "FORGELOOP_UPGRADE_STATE": str(store.state_path),
                "FORGELOOP_UPGRADE_GENERATION": "gen-000001",
                "FORGELOOP_UPGRADE_READY": str(ready),
                "FORGELOOP_UPGRADE_DRAIN_REPORT": str(drain),
                "FORGELOOP_UPGRADE_PREFIX": str(tmp_path / "prefix"),
                "FORGELOOP_UPGRADE_PROJECT": "forgeloop",
                "FORGELOOP_UPGRADE_RECORDS_ROOT": str(root / "projects" / "forgeloop"),
            }
        )
        log = (tmp_path / "serve.log").open("wb")
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "forgeloop",
                "serve",
                "--project",
                "forgeloop",
                "--records-root",
                str(root),
                "--service-config",
                str(service),
                "--web-config",
                str(web),
                "--projects-file",
                str(projects),
            ],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not ready.is_file():
                time.sleep(0.05)
            if not ready.is_file():
                log.flush()
                raise AssertionError((tmp_path / "serve.log").read_text(errors="replace"))
            document = json.loads(ready.read_text(encoding="utf-8"))
            assert document["generation"] == "gen-000001"
            assert document["pid"] == process.pid

            state = store.read()
            assert state is not None
            from dataclasses import replace

            store.write(replace(state, phase="draining"))
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not drain.is_file():
                time.sleep(0.05)
            if not drain.is_file():
                log.flush()
                raise AssertionError((tmp_path / "serve.log").read_text(errors="replace"))
            report = json.loads(drain.read_text(encoding="utf-8"))
            assert report["completed"] is True
            assert report["pid"] == process.pid
            assert report["active_calls"] == 0
            assert report["active_turns"] == 0

            store.write(replace(state, phase="deferred"))
            # 延期后旧代恢复：进程仍活着，状态文件仍是 deferred。
            time.sleep(0.5)
            assert process.poll() is None

            next_identity = replace(state.identity, generation="gen-000002")
            store.write(
                replace(
                    state,
                    phase="starting",
                    generation="gen-000002",
                    identity=next_identity,
                )
            )
            assert process.wait(timeout=10) == 0
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            log.close()
