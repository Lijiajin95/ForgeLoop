"""worker 排空：等真实在途调用结束、超时如实延期、持久请求不被中途消费。

方案 §3.4/§5：`stop(timeout)` 返回不是排空证明；排空超时只能延期升级，旧进程
继续运行，不能强杀在途动作，也不能把已持久化的请求消费掉却不执行。
"""

import threading
import time
from pathlib import Path
from typing import cast

import pytest

from forgeloop.adapter.pi_rpc import PIProcess
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.service_requests import ServiceRequestStore


class SlowWorker(ServiceWorker):
    """用可控阻塞代替真实任务执行，验证排空计时与 ticket 语义。"""

    def __init__(self, root: Path, *, delay: float, started: threading.Event) -> None:
        super().__init__(root, poll_seconds=1, auto_advance=False, projects={})
        self.delay = delay
        self.started = started

    def _advance_once_locked(self, *, only=None) -> dict:
        self.started.set()
        time.sleep(self.delay)
        return {}


class TestDrain:
    def test_drain_waits_for_inflight_call_and_reports_completed(self, tmp_path: Path) -> None:
        started = threading.Event()
        worker = SlowWorker(tmp_path, delay=0.5, started=started)
        thread = threading.Thread(target=worker.advance_once)
        thread.start()
        assert started.wait(2.0)

        report = worker.drain(timeout=5.0)

        assert report.completed is True
        assert report.active_calls == 0
        thread.join(timeout=2.0)

    def test_drain_timeout_reports_incomplete_without_killing(self, tmp_path: Path) -> None:
        started = threading.Event()
        worker = SlowWorker(tmp_path, delay=1.0, started=started)
        thread = threading.Thread(target=worker.advance_once)
        thread.start()
        assert started.wait(2.0)

        report = worker.drain(timeout=0.1)

        assert report.completed is False
        assert report.active_calls == 1
        assert "超时" in report.detail
        thread.join(timeout=3.0)

    def test_stop_timeout_is_not_a_drain_proof(self, tmp_path: Path) -> None:
        started = threading.Event()
        worker = SlowWorker(tmp_path, delay=0.8, started=started)
        thread = threading.Thread(target=worker.advance_once)
        thread.start()
        assert started.wait(2.0)

        worker.stop(timeout=0.01)

        assert worker.drain(timeout=0.01).completed is False
        thread.join(timeout=3.0)

    def test_drain_does_not_consume_persisted_request(self, tmp_path: Path) -> None:
        store = ServiceRequestStore(tmp_path / "records.sqlite")
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
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False, projects={})
        assert worker.drain(timeout=0).completed is True

        worker._tick()

        assert worker.pending_advance() == ("req-1",)

    def test_resume_allows_new_execution(self, tmp_path: Path) -> None:
        started = threading.Event()
        worker = SlowWorker(tmp_path, delay=0.0, started=started)
        assert worker.drain(timeout=0).completed is True
        assert worker.advance_once() == {}
        assert not started.is_set()

        worker.resume()

        assert worker.advance_once() == {}
        assert started.wait(1.0)


class BlockingPI:
    """替身 PI：一轮等待 release_event；用于验证面板排空等待而非中止。"""

    def __init__(self, started: threading.Event, release: threading.Event) -> None:
        self.started = started
        self.release = release
        self.closed = False
        self.pid = 4321

    def start(self) -> None:
        return

    def is_alive(self) -> bool:
        return not self.closed

    def send_prompt(self, text: str) -> None:
        del text

    def request_stop(self) -> None:
        self.release.set()

    def close(self) -> None:
        self.closed = True

    def wait_until_settled(self, timeout_seconds: float):
        del timeout_seconds
        from forgeloop.adapter.agent_runtime import AgentInvocationResult

        self.started.set()
        self.release.wait(10.0)
        return AgentInvocationResult(
            settled=True, aborted=False, text="完成", result=None, events=()
        )


class TestConversationDrain:
    def _runner(self, tmp_path: Path, started: threading.Event, release: threading.Event):
        from forgeloop.domain.conversation import ToolApprovalPolicy
        from forgeloop.domain.projects import SOURCE_PANEL, ProjectEntry
        from forgeloop.graph.conversation import ConversationRunner
        from forgeloop.records.conversations import ConversationStore

        entry = ProjectEntry(
            name="demo",
            path=str(tmp_path),
            description="",
            pi_command=("pi",),
            pi_home=str(tmp_path),
            source=SOURCE_PANEL,
        )
        runner = ConversationRunner(
            records_path=tmp_path / "records.sqlite",
            session_root=tmp_path / "panel",
            projects=lambda: {"demo": entry},
            readiness=lambda _: (),
            concurrency=1,
            turn_timeout_seconds=30,
            tool_approval=ToolApprovalPolicy.WRITE,
            pi_factory=lambda *_: cast("PIProcess", BlockingPI(started, release)),
        )
        store = ConversationStore(tmp_path / "records.sqlite")
        try:
            session_id = store.create_session(project="demo", title="排空", by="owner").session_id
        finally:
            store.close()
        return runner, session_id

    def test_drain_waits_for_running_turn_and_closes_idle_processes(self, tmp_path: Path) -> None:
        started, release = threading.Event(), threading.Event()
        runner, session_id = self._runner(tmp_path, started, release)
        try:
            runner.start_turn(session_id, "跑一轮", "owner")
            assert started.wait(2.0)

            report = runner.drain(timeout=0.1)

            assert report.completed is False
            assert report.active_turns == 1
            release.set()
            report = runner.drain(timeout=3.0)
            assert report.completed is True
            assert report.live_sessions >= 0
        finally:
            runner.shutdown()


class TestAdmissionBranches:
    _runner = TestConversationDrain._runner

    def _draining_state(self, tmp_path: Path, generation: str = "gen-000001") -> Path:
        from forgeloop.domain.upgrade import UpgradeIdentity, UpgradeState
        from forgeloop.records.upgrade_state import UpgradeStateStore

        store = UpgradeStateStore(tmp_path / "control")
        state = UpgradeState(
            identity=UpgradeIdentity(
                version="0.0.1",
                tag="v0.0.1",
                artifact_sha256="a" * 64,
                build_commit="b" * 40,
                generation=generation,
            ),
            project="forgeloop",
            prefix="/tmp/forgeloop-prefix",
            records_root=str(tmp_path),
            phase="draining",
            generation=generation,
        )
        store.write(state)
        return store.state_path

    def test_worker_rejects_execution_and_tick_while_draining(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        path = self._draining_state(tmp_path)
        monkeypatch.setenv("FORGELOOP_UPGRADE_MANAGED", "1")
        monkeypatch.setenv("FORGELOOP_UPGRADE_STATE", str(path))
        monkeypatch.setenv("FORGELOOP_UPGRADE_GENERATION", "gen-000001")
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=True, projects={})
        worker.drain(timeout=0)

        assert worker.advance_once() == {}
        assert worker.advance_eligibility("req-missing").eligible is False
        worker._tick()
        assert worker.status()["active_calls"] == 0

    def test_pending_advance_falls_back_when_database_is_unreadable(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False, projects={})
        (tmp_path / "records.sqlite").mkdir()
        assert worker.pending_advance() == ()

    def test_agent_session_refuses_admission_before_spawn(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from forgeloop.domain.agent_runtime import AgentRuntimeError
        from forgeloop.graph.agent_execution import run_agent_session

        path = self._draining_state(tmp_path)
        monkeypatch.setenv("FORGELOOP_UPGRADE_MANAGED", "1")
        monkeypatch.setenv("FORGELOOP_UPGRADE_STATE", str(path))
        monkeypatch.setenv("FORGELOOP_UPGRADE_GENERATION", "gen-000001")
        with pytest.raises(AgentRuntimeError, match="热升级"):
            run_agent_session(
                object(),  # type: ignore[arg-type]
                task_id="task",
                role="dev",
                session_dir=tmp_path,
                options=object(),  # type: ignore[arg-type]
                prompt="x",
                timeout_seconds=1,
            )

    def test_conversation_rejects_new_turn_while_draining(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from forgeloop.domain.conversation import ConversationError
        from forgeloop.domain.projects import SOURCE_PANEL, ProjectEntry
        from forgeloop.graph.conversation import ConversationRunner
        from forgeloop.records.conversations import ConversationStore

        path = self._draining_state(tmp_path)
        monkeypatch.setenv("FORGELOOP_UPGRADE_MANAGED", "1")
        monkeypatch.setenv("FORGELOOP_UPGRADE_STATE", str(path))
        monkeypatch.setenv("FORGELOOP_UPGRADE_GENERATION", "gen-000001")
        entry = ProjectEntry(
            name="demo",
            path=str(tmp_path),
            description="",
            pi_command=("pi",),
            pi_home=str(tmp_path),
            source=SOURCE_PANEL,
        )
        runner = ConversationRunner(
            records_path=tmp_path / "records.sqlite",
            session_root=tmp_path / "panel",
            projects=lambda: {"demo": entry},
            readiness=lambda _: (),
            concurrency=1,
            turn_timeout_seconds=30,
        )
        store = ConversationStore(tmp_path / "records.sqlite")
        try:
            session_id = store.create_session(project="demo", title="排空", by="owner").session_id
        finally:
            store.close()
        try:
            with pytest.raises(ConversationError, match="热升级"):
                runner.start_turn(session_id, "不应受理", "owner")
        finally:
            runner.shutdown()

    def test_draining_rejects_new_turns_and_resume_restores(self, tmp_path: Path) -> None:
        from forgeloop.domain.conversation import ConversationError

        started, release = threading.Event(), threading.Event()
        release.set()
        runner, session_id = self._runner(tmp_path, started, release)
        try:
            assert runner.drain(timeout=0.0).completed is True
            try:
                runner.start_turn(session_id, "不应受理", "owner")
            except ConversationError as error:
                assert "排空" in str(error) or "停止" in str(error)
            else:  # pragma: no cover - 失败信息比静默受理更清楚
                raise AssertionError("排空期间仍受理了新轮次")
            runner.resume()
            runner.start_turn(session_id, "恢复受理", "owner")
        finally:
            runner.shutdown()
