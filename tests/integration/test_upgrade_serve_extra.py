"""托管观察器分支补充：进程内驱动，不启动 HTTP 或真实业务进程。"""

from dataclasses import replace
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any, cast

import pytest

from forgeloop.domain.upgrade import UpgradeIdentity, UpgradeSettings, UpgradeState
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.upgrade_state import UpgradeStateStore


class _FakeRunner:
    def __init__(self) -> None:
        self.draining = False

    def drain(self, timeout: float):
        from forgeloop.graph.conversation import DrainReport

        del timeout
        self.draining = True
        return DrainReport(completed=True)

    def resume(self) -> None:
        self.draining = False


class TestServeCoverage:
    def _runtime(self, tmp_path: Path):
        from forgeloop.cli.serve import ManagedRuntime, RuntimeIdentity

        control = tmp_path / "prefix" / "control"
        store = UpgradeStateStore(control)
        identity = UpgradeIdentity(
            version="0.0.1",
            tag="v0.0.1",
            artifact_sha256="a" * 64,
            build_commit="b" * 40,
            generation="gen-000001",
        )
        store.write(
            UpgradeState(
                identity=identity,
                project="forgeloop",
                prefix="/tmp/forgeloop-prefix",
                records_root=str(tmp_path),
                phase="committed",
                generation="gen-000001",
            )
        )
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
        panel: Any = SimpleNamespace(runner=runner)
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False, projects={})
        return runtime, worker, panel, store

    def test_await_outcome_new_generation_sets_stop(self, tmp_path: Path) -> None:
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
        runtime.start_watchdog(Event(), worker, panel, None)
        assert runtime._thread is None

    def test_managed_prefix_from_env_and_state(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module

        admission: Any = SimpleNamespace(state_path=tmp_path / "prefix" / "control" / "state.json")
        monkeypatch.delenv(module.ENV_UPGRADE_PREFIX, raising=False)
        assert module._managed_prefix(admission) == tmp_path / "prefix"
        monkeypatch.setenv(module.ENV_UPGRADE_PREFIX, str(tmp_path / "explicit"))
        assert module._managed_prefix(admission) == (tmp_path / "explicit").resolve()

    def test_check_panel_reports_bad_pi_home(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module

        registry = SimpleNamespace(
            path=tmp_path / "projects.toml",
            entries=lambda: [
                SimpleNamespace(name="forgeloop", source=module.SOURCE_PANEL, pi_home=tmp_path)
            ],
        )
        monkeypatch.setattr(module, "pi_home_problems", lambda home: ["缺少 models.json"])
        with pytest.raises(module.ServeConfigError, match="PI HOME 不可用"):
            module.check_panel(cast("Any", registry))

    def test_runtime_identity_bad_artifact_and_workspace(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module

        package = tmp_path / "package"
        package.mkdir()
        (package / "artifact.json").write_text("{broken", encoding="utf-8")
        monkeypatch.setattr(module, "_package_dir", lambda: package)
        identity = module.runtime_identity()
        assert identity.source == "workspace"
        assert identity.release_dir == str(package)

    def test_ready_and_state_error_paths(self, tmp_path: Path, capsys) -> None:
        runtime, _worker, _panel, _store = self._runtime(tmp_path)
        runtime.ready_path = tmp_path / "ready-dir"
        runtime.ready_path.mkdir()
        runtime.write_ready("127.0.0.1", 1)
        assert "写就绪报告失败" in capsys.readouterr().out

        runtime.state_path.write_text("{broken", encoding="utf-8")
        assert runtime.read_state() is None
        assert "升级现场不可读" in capsys.readouterr().out

    def test_watchdog_thread_survives_observe_error(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        runtime, worker, panel, _store = self._runtime(tmp_path)

        def boom(*args) -> None:
            raise RuntimeError("observe-boom")

        monkeypatch.setattr(runtime, "_observe", boom)
        stop = Event()
        runtime.start_watchdog(stop, worker, panel, None)
        assert runtime._thread is not None
        import time

        time.sleep(0.3)
        stop.set()
        runtime.stop(timeout=1)
        assert "现场观察异常" in capsys.readouterr().out

    def test_perform_drain_write_error(self, tmp_path: Path, monkeypatch, capsys) -> None:
        runtime, worker, panel, _store = self._runtime(tmp_path)
        monkeypatch.setattr(
            type(runtime).__module__ and __import__("forgeloop.cli.serve", fromlist=["x"]),
            "write_json_atomic",
            lambda *a: (_ for _ in ()).throw(OSError("disk full")),
        )
        runtime._perform_drain(cast("Any", worker), cast("Any", panel), None)
        assert "写排空报告失败" in capsys.readouterr().out

    def test_deferred_outcome_and_observe_resume(self, tmp_path: Path) -> None:
        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        store.write(replace(state, phase="deferred"))
        worker.drain(timeout=0)
        runtime._await_outcome(Event(), worker, panel, None)
        assert worker.draining is False

        worker.drain(timeout=0)
        runtime._observe(Event(), worker, panel, None)
        assert worker.draining is False

    def test_await_outcome_none_state_times_out_and_resumes(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from forgeloop.cli import serve as module

        runtime, worker, panel, _store = self._runtime(tmp_path)
        monkeypatch.setattr(runtime, "read_state", lambda: None)
        monkeypatch.setattr(module, "DRAIN_OUTCOME_WAIT_SECONDS", 0.05)
        runtime.settings = replace(runtime.settings, poll_seconds=0.05)
        worker.drain(timeout=0)
        runtime._await_outcome(Event(), worker, panel, None)
        assert worker.draining is False

    def test_perform_drain_incomplete_components(self, tmp_path: Path) -> None:
        from forgeloop.graph.conversation import DrainReport
        from forgeloop.graph.worker import DrainReport as WorkerDrainReport

        runtime, _worker, panel, _store = self._runtime(tmp_path)
        worker = SimpleNamespace(
            drain=lambda timeout: WorkerDrainReport(completed=False),
            reconcile=lambda: [],
        )
        runtime._perform_drain(cast("Any", worker), cast("Any", panel), None)
        assert runtime._drained is False

        worker = SimpleNamespace(
            drain=lambda timeout: WorkerDrainReport(completed=True),
            reconcile=lambda: [{"kind": "outstanding_action"}],
        )
        runtime._perform_drain(cast("Any", worker), cast("Any", panel), None)
        assert runtime._drained is False

        worker = SimpleNamespace(
            drain=lambda timeout: WorkerDrainReport(completed=True), reconcile=lambda: []
        )
        bad_panel = SimpleNamespace(
            runner=SimpleNamespace(drain=lambda timeout: DrainReport(False))
        )
        runtime._perform_drain(cast("Any", worker), cast("Any", bad_panel), None)
        assert runtime._drained is False

    def test_resume_keeps_running_mail_worker(self, tmp_path: Path) -> None:
        runtime, worker, panel, _store = self._runtime(tmp_path)
        started: list[str] = []
        mail = SimpleNamespace(running=True, start=lambda: started.append("start"))
        worker.drain(timeout=0)
        runtime._resume(cast("Any", worker), cast("Any", panel), cast("Any", mail))
        assert started == []
        assert worker.draining is False

    def test_serve_until_stopped_with_mail_and_upgrade(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli import serve as module

        calls: list[str] = []
        runner = SimpleNamespace(shutdown=lambda: calls.append("runner"))
        server = SimpleNamespace(
            serve_forever=lambda: calls.append("serve"),
            shutdown=lambda: calls.append("shutdown"),
            server_close=lambda: calls.append("close"),
            panel=SimpleNamespace(runner=runner),
            server_address=("127.0.0.1", 0),
        )
        worker = SimpleNamespace(
            start=lambda: calls.append("worker-start"),
            stop=lambda: calls.append("worker-stop"),
            status=lambda: {"executable_projects": [], "startup_review": []},
        )
        mail = SimpleNamespace(
            interval_seconds=60.0,
            status=lambda: {"config": "x", "allowed_senders": 1},
            start=lambda: calls.append("mail-start"),
            stop=lambda: calls.append("mail-stop"),
        )
        upgrade = SimpleNamespace(
            write_ready=lambda host, port: calls.append("ready"),
            start_watchdog=lambda *a: calls.append("watchdog"),
            stop=lambda: calls.append("upgrade-stop"),
        )
        settings = SimpleNamespace(
            web=SimpleNamespace(
                records_root=tmp_path,
                refresh=module.resolve_refresh_seconds(None, cli_value=60),
            ),
            project_id="forgeloop",
            records_root=tmp_path,
            service=SimpleNamespace(
                panel=SimpleNamespace(
                    concurrency=1,
                    turn_timeout_seconds=1,
                    max_live_sessions=1,
                    session_idle_seconds=1,
                    tool_approval="never",
                ),
                poll_seconds=1,
                auto_advance=False,
            ),
            projects_path=tmp_path / "projects.toml",
            config_path=tmp_path / "service.toml",
        )

        def install(stop):
            stop.set()
            return {}

        monkeypatch.setattr(module, "_install_stop_handlers", install)
        code = module._serve_until_stopped(
            cast("Any", server),
            cast("Any", worker),
            cast("Any", settings),
            tmp_path / "web.toml",
            cast("Any", mail),
            cast("Any", upgrade),
        )
        assert code == 0
        assert "mail-start" in calls and "mail-stop" in calls
        assert "ready" in calls and "watchdog" in calls and "upgrade-stop" in calls

    def test_check_panel_ok_and_runtime_identity_release(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace

        from forgeloop.cli import serve as module

        registry = SimpleNamespace(
            path=tmp_path / "projects.toml",
            entries=lambda: [SimpleNamespace(name="ws", source="workspace", pi_home=tmp_path)],
        )
        module.check_panel(cast("Any", registry))

        package = tmp_path / "release" / "lib" / "forgeloop"
        package.mkdir(parents=True)
        manifest = {
            "schema_version": 1,
            "version": "0.0.2",
            "tag": "v0.0.2",
            "artifact_sha256": "a" * 64,
            "build_commit": "b" * 40,
            "source": "release",
        }
        import json

        (package.parent / "artifact.json").write_text(json.dumps(manifest), encoding="utf-8")
        monkeypatch.setattr(module, "_package_dir", lambda: package)
        identity = module.runtime_identity()
        assert identity.source == "release"
        assert identity.version == "0.0.2"

    def test_observe_other_generation_and_idle(self, tmp_path: Path) -> None:
        runtime, worker, panel, store = self._runtime(tmp_path)
        state = store.read()
        assert state is not None
        store.write(
            replace(
                state,
                generation="gen-000002",
                identity=replace(state.identity, generation="gen-000002"),
                phase="draining",
            )
        )
        stop = Event()
        runtime._observe(stop, worker, panel, None)
        assert stop.is_set() is False

        store.write(state)
        runtime._observe(Event(), worker, panel, None)

    def test_await_outcome_stop_already_set_and_stop_without_thread(self, tmp_path: Path) -> None:
        runtime, worker, panel, _store = self._runtime(tmp_path)
        stop = Event()
        stop.set()
        runtime._await_outcome(stop, worker, panel, None)
        runtime.stop()

    def test_cmd_serve_mail_project_and_error_paths(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace

        from forgeloop.cli import serve as module

        settings = SimpleNamespace(
            records_root=tmp_path,
            project=None,
            service=SimpleNamespace(
                poll_seconds=1,
                auto_advance=False,
                projects={},
                max_concurrent=1,
                host="127.0.0.1",
                port=0,
            ),
        )
        shutdowns: list[str] = []
        panel = SimpleNamespace(
            registry=object(), runner=SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        )
        monkeypatch.setattr(module, "_resolve_settings", lambda *a: settings)
        monkeypatch.setattr(module, "build_panel_context", lambda *a: panel)
        monkeypatch.setattr(module, "check_panel", lambda *a: None)
        monkeypatch.setattr(
            module, "ServiceWorker", lambda *a, **k: SimpleNamespace(survey=lambda: None)
        )
        monkeypatch.setattr(module, "build_service_document", lambda *a: {})
        monkeypatch.setattr(module, "_emit", lambda *a: None)
        args = SimpleNamespace(
            records_root=tmp_path,
            service_config=tmp_path / "service.toml",
            web_config=tmp_path / "web.toml",
            once=False,
            mail=True,
            mail_config="",
            mail_interval=60,
            project=None,
            json=False,
        )
        assert module.cmd_serve(cast("Any", args)) == 1
        assert shutdowns == ["down"]

        args.mail = False
        args.once = True
        assert module.cmd_serve(cast("Any", args)) == 0

        settings.project = "forgeloop"
        args.once = False
        args.mail = True
        monkeypatch.setattr(
            module, "build_mail_worker", lambda **k: (_ for _ in ()).throw(ValueError("bad mail"))
        )
        assert module.cmd_serve(cast("Any", args)) == 1

        args.mail = False
        monkeypatch.setattr(
            module, "build_server", lambda *a, **k: (_ for _ in ()).throw(OSError("port busy"))
        )
        assert module.cmd_serve(cast("Any", args)) == 1
