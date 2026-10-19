"""面板集成测试：真实回环端口 + 真实 SQLite + 真实假 PI 子进程。

核对的是「面板这套入口真的能跑」：一轮消息确实驱动了 PI 子进程并把结果落进记录、
HITL 停得住也接得上、终止真的中止了在跑的一轮、写请求的令牌与同源闸门不漏。
一轮执行是**异步受理**（202）加轮询，因此这里用真实等待而不是假设立即完成。
"""

import http.client
import json
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.serve import (
    ServeOperations,
    ServeSettings,
    build_panel_context,
    build_server,
)
from forgeloop.cli.web import ProgressDocuments, WebSettings, load_web_config
from forgeloop.domain.progress import resolve_refresh_seconds
from forgeloop.domain.service import resolve_service_settings
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.conversations import ConversationStore

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
FAKE_PI = (sys.executable, str(FIXTURES / "fake_pi.py"))
TOKEN = "panel-integration-token"
WAIT_SECONDS = 30.0

DOCUMENTS = ProgressDocuments(_requirement_document, _status_document)


def _stub(args: object) -> int:
    del args
    return 0


STUB_OPERATIONS = ServeOperations(
    approve_requirement=_stub, accept_requirement=_stub, stop_task=_stub
)


class Panel:
    """一套跑在真实端口上的服务，外加它的事务性数据（记录库、项目档案）。"""

    def __init__(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, tool_approval: str = "write"
    ) -> None:
        self._monkeypatch = monkeypatch
        self.root = tmp_path / "records"
        self.root.mkdir()
        self.project_path = tmp_path / "demo-repo"
        self.project_path.mkdir()
        (self.project_path / ".git").mkdir()
        self.pi_home = tmp_path / "pi-home"
        (self.pi_home / ".pi" / "agent").mkdir(parents=True)
        (self.pi_home / ".pi" / "agent" / "models.json").write_text(
            '{"providers": {}}', encoding="utf-8"
        )
        self.projects_path = tmp_path / "projects.toml"
        service = resolve_service_settings(
            {
                "schema_version": 1,
                "host": "127.0.0.1",
                "port": 0,
                "panel": {
                    "concurrency": 2,
                    "turn_timeout_seconds": 30,
                    "session_idle_seconds": 60,
                    "max_live_sessions": 2,
                    "tool_approval": tool_approval,
                },
            }
        )
        web = WebSettings(
            records_root=self.root,
            host=service.host,
            port=0,
            refresh=resolve_refresh_seconds(
                load_web_config(ROOT / "config" / "web.toml"), cli_value=None
            ),
            config_path=ROOT / "config" / "web.toml",
            documents=DOCUMENTS,
        )
        self.settings = ServeSettings(
            web=web,
            service=service,
            config_path=ROOT / "config" / "service.toml",
            operations=STUB_OPERATIONS,
            projects_path=self.projects_path,
        )
        self.worker = ServiceWorker(self.root, poll_seconds=1, auto_advance=False)
        self.panel = build_panel_context(self.settings)
        self.server = build_server(self.settings, self.worker, self.panel, token=TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        host, port = self.server.server_address[:2]
        self.address = (str(host), int(port))

    def start(self) -> None:
        self.worker.start()
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.worker.stop()
        self.panel.runner.shutdown()

    def set_fake_mode(self, mode: str) -> None:
        """切换假 PI 的行为：子进程启动时读环境变量，因此从下一轮开始生效。"""

        self._monkeypatch.setenv("FAKE_PI_MODE", mode)

    def store(self) -> ConversationStore:
        return ConversationStore(self.root / "records.sqlite")

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        token: str | None = TOKEN,
        origin: str | None = None,
    ) -> tuple[int, dict]:
        host, port = self.address
        connection = http.client.HTTPConnection(host, port, timeout=20)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["X-Forgeloop-Token"] = token
        headers["Origin"] = origin if origin is not None else f"http://{host}:{port}"
        try:
            payload = None if body is None else json.dumps(body).encode("utf-8")
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw or b"{}")
        finally:
            connection.close()

    def get(self, path: str) -> tuple[int, dict]:
        return self.request("GET", path, token=None)

    def wait_for(self, predicate: Callable[[], bool], *, what: str) -> None:
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        raise AssertionError(f"等待超时: {what}")

    def wait_turn_done(self, session_id: str) -> dict:
        """一轮结束的判据：会话不再被标记为 running（面板文档与详情同源）。"""

        def done() -> bool:
            status, detail = self.get(f"/api/panel/sessions/{session_id}")
            return status == 200 and detail["session"]["running"] is False

        self.wait_for(done, what=f"会话 {session_id} 的一轮结束")
        status, detail = self.get(f"/api/panel/sessions/{session_id}")
        assert status == 200
        return detail

    def create_project(self, name: str = "demo") -> tuple[int, dict]:
        return self.request(
            "POST",
            "/api/panel/projects",
            body={
                "by": "owner",
                "name": name,
                "path": str(self.project_path),
                "description": "集成测试项目",
                "pi_command": list(FAKE_PI),
                "pi_home": str(self.pi_home),
            },
        )

    def create_session(self, title: str = "排查失败") -> str:
        status, payload = self.request(
            "POST", "/api/panel/sessions", body={"by": "owner", "project": "demo", "title": title}
        )
        assert status == 201
        return str(payload["session_id"])

    def send(self, session_id: str, text: str = "看一下仓库状态") -> tuple[int, dict]:
        return self.request(
            "POST", f"/api/panel/sessions/{session_id}/messages", body={"by": "owner", "text": text}
        )


@pytest.fixture()
def panel(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Panel]:
    monkeypatch.setenv("FAKE_PI_MODE", "chat")
    instance = Panel(tmp_path, monkeypatch)
    instance.start()
    try:
        yield instance
    finally:
        instance.stop()


@pytest.fixture()
def streaming_panel(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Panel]:
    """放慢推流的现场：一轮里能稳定观察到「文字在增长」的流式消息。"""

    monkeypatch.setenv("FAKE_PI_MODE", "panel-stream")
    monkeypatch.setenv("FAKE_PI_CHUNK_DELAY_MS", "300")
    instance = Panel(tmp_path, monkeypatch)
    instance.start()
    try:
        yield instance
    finally:
        instance.stop()


class TestReadModel:
    def test_panel_document_reports_the_registered_project(self, panel: Panel) -> None:
        assert panel.create_project()[0] == 201
        status, document = panel.get("/api/panel")
        assert status == 200
        assert document["schema_version"] == 1
        project = document["projects"][0]
        assert project["name"] == "demo"
        assert project["source"] == "panel"
        assert project["editable"] is True
        assert project["is_git_repo"] is True
        assert project["problems"] == []
        assert project["runtime"]["ready"] is True
        assert project["runtime"]["pi_command"] == list(FAKE_PI)
        assert document["runtime"]["concurrency"] == 2
        assert document["sessions"] == []

    def test_unknown_session_detail_is_404_json(self, panel: Panel) -> None:
        status, payload = panel.get("/api/panel/sessions/cs-nope")
        assert status == 404
        assert payload["error"] == "session_not_found"

    def test_panel_uses_the_same_records_as_the_rest_of_the_page(self, panel: Panel) -> None:
        """面板不新建第二份状态：它的会话记录就在同一份 records.sqlite 里。"""

        panel.create_project()
        session_id = panel.create_session()
        store = panel.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            assert session.project == "demo"
            assert session.cwd == str(panel.project_path)
        finally:
            store.close()


class TestWriteGates:
    def test_missing_token_is_refused_without_records(self, panel: Panel) -> None:
        status, payload = panel.request(
            "POST",
            "/api/panel/sessions",
            body={"by": "owner", "project": "demo", "title": "t"},
            token=None,
        )
        assert status == 403
        assert payload["error"] == "token_required"
        store = panel.store()
        try:
            assert store.list_sessions() == ()
        finally:
            store.close()

    def test_cross_origin_is_refused(self, panel: Panel) -> None:
        status, payload = panel.request(
            "POST",
            "/api/panel/sessions",
            body={"by": "owner", "project": "demo", "title": "t"},
            origin="http://evil.example",
        )
        assert status == 403
        assert payload["error"] == "cross_origin"

    def test_missing_by_is_refused(self, panel: Panel) -> None:
        status, payload = panel.request(
            "POST", "/api/panel/sessions", body={"project": "demo", "title": "t"}
        )
        assert status == 400
        assert payload["error"] == "by_required"

    def test_unknown_write_route_is_404(self, panel: Panel) -> None:
        status, payload = panel.request("POST", "/api/panel/whatever", body={"by": "owner"})
        assert status == 404
        assert payload["error"] == "not_found"


class TestTurnExecution:
    def test_message_runs_one_real_fake_pi_turn(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        status, accepted = panel.send(session_id, "看一下仓库状态")
        assert status == 202
        assert accepted["queued"] is False
        detail = panel.wait_turn_done(session_id)
        assert detail["session"]["status"] == "active"
        assert detail["session"]["turn_count"] == 1
        roles = [item["role"] for item in detail["messages"]]
        assert roles == ["human", "agent"]
        assert "假 PI" in detail["messages"][1]["content"]

        # 一轮的真实轨迹按会话身份落盘（与任务现场同一口径：原始记录可回查）。
        session_dir = panel.root / "panel" / session_id
        assert (session_dir / f"{session_id}-chat.events.jsonl").is_file()
        assert (session_dir / f"{session_id}-chat.requests.jsonl").is_file()

    def test_second_message_replays_history(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "第一问")
        panel.wait_turn_done(session_id)
        panel.send(session_id, "第二问")
        detail = panel.wait_turn_done(session_id)
        assert detail["session"]["turn_count"] == 2
        assert [item["role"] for item in detail["messages"]] == [
            "human",
            "agent",
            "human",
            "agent",
        ]

    def test_message_on_terminated_session_is_refused(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/terminate",
            body={"by": "owner", "reason": "不做了"},
        )
        status, payload = panel.send(session_id, "再来一句")
        assert status == 409
        assert payload["error"] == "refused"

    def test_session_creation_needs_a_ready_project(self, panel: Panel) -> None:
        status, payload = panel.request(
            "POST", "/api/panel/sessions", body={"by": "owner", "project": "ghost", "title": "t"}
        )
        assert status == 404
        assert payload["error"] == "project_not_found"


class TestHumanInTheLoop:
    def open_pending(self, panel: Panel, mode: str) -> tuple[str, dict]:
        panel.set_fake_mode(mode)
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "需要你判断的一步")

        def has_pending() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            return detail["session"]["pending_decisions"] == 1

        panel.wait_for(has_pending, what="待人工决定出现")
        _, detail = panel.get(f"/api/panel/sessions/{session_id}")
        return session_id, detail

    def test_agent_request_waits_for_a_human(self, panel: Panel) -> None:
        session_id, detail = self.open_pending(panel, "chat-hitl")
        assert detail["session"]["status"] == "awaiting_human"
        decision = detail["decisions"][-1]
        assert decision["kind"] == "agent_request"
        assert "是否继续" in decision["question"]
        assert detail["messages"][-1]["content"] == decision["question"]

        # 停在等待态时新消息被拒绝（先处理决定）。
        status, payload = panel.send(session_id, "顺手再做一件事")
        assert (status, payload["error"]) == (409, "refused")

    def test_approve_with_instruction_starts_a_new_turn(self, panel: Panel) -> None:
        # 常驻会话进程下，假 PI 的模式由进程启动时决定、不再随环境变量变化，因此用有状态
        # 的 chat-hitl-first：首轮请求人工决定，同一进程的后续轮次正常回复。
        session_id, detail = self.open_pending(panel, "chat-hitl-first")
        decision_id = detail["decisions"][-1]["decision_id"]
        status, accepted = panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            body={
                "by": "owner",
                "decision": "approve",
                "reason": "按方案 B 继续",
                "text": "改用方案 B",
            },
        )
        assert status == 202
        assert accepted["queued"] is False
        detail = panel.wait_turn_done(session_id)
        assert detail["session"]["status"] == "active"
        assert detail["decisions"][-1]["status"] == "approved"
        assert detail["decisions"][-1]["decided_by"] == "owner"
        assert [item["content"] for item in detail["messages"] if item["role"] == "human"] == [
            "需要你判断的一步",
            "改用方案 B",
        ]

    def test_reject_terminates_the_session(self, panel: Panel) -> None:
        session_id, detail = self.open_pending(panel, "chat-hitl")
        decision_id = detail["decisions"][-1]["decision_id"]
        status, payload = panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            body={"by": "owner", "decision": "reject", "reason": "这一步不做"},
        )
        assert status == 200
        assert payload["session_status"] == "terminated"
        _, after = panel.get(f"/api/panel/sessions/{session_id}")
        assert after["session"]["status"] == "terminated"
        assert after["session"]["terminate_reason"] == "拒绝待人工决定：这一步不做"

    def test_failed_turn_becomes_a_pending_decision(self, panel: Panel) -> None:
        panel.set_fake_mode("model-error")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "跑一轮")

        def has_pending() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            return detail["session"]["pending_decisions"] == 1

        panel.wait_for(has_pending, what="失败后的待人工决定")
        _, detail = panel.get(f"/api/panel/sessions/{session_id}")
        assert detail["session"]["status"] == "awaiting_human"
        assert detail["decisions"][-1]["kind"] == "turn_failed"
        assert "模型错误" in detail["session"]["last_error"]

        # 批准=重试本轮（带补充指令），失败后仍然可继续。
        decision_id = detail["decisions"][-1]["decision_id"]
        status, _ = panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            body={
                "by": "owner",
                "decision": "approve",
                "reason": "再试一次",
                "text": "换个方式再试",
            },
        )
        assert status == 202


class TestTermination:
    def test_terminate_aborts_a_hanging_turn(self, panel: Panel) -> None:
        panel.set_fake_mode("hang")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "长任务")

        def running() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            return detail["session"]["running"] is True

        panel.wait_for(running, what="一轮开始执行")
        status, payload = panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/terminate",
            body={"by": "owner", "reason": "不要了"},
        )
        assert status == 200
        assert payload["terminated"] is True
        assert payload["aborted"] is True

        def stopped() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            return (
                detail["session"]["status"] == "terminated"
                and detail["session"]["running"] is False
            )

        panel.wait_for(stopped, what="终止生效且轮次收尾")
        _, detail = panel.get(f"/api/panel/sessions/{session_id}")
        assert detail["messages"][-1]["content"] == "本轮已被人工终止。"
        assert detail["session"]["terminated_by"] == "owner"
        assert detail["session"]["terminate_reason"] == "不要了"

    def test_repeat_terminate_keeps_the_first_fact(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        route = f"/api/panel/sessions/{session_id}/terminate"
        assert (
            panel.request("POST", route, body={"by": "owner", "reason": "第一次"})[1]["terminated"]
            is True
        )
        status, payload = panel.request("POST", route, body={"by": "other", "reason": "第二次"})
        assert status == 200
        assert payload["terminated"] is False
        assert payload["already_terminated"] is True
        _, detail = panel.get(f"/api/panel/sessions/{session_id}")
        assert detail["session"]["terminated_by"] == "owner"
        assert detail["session"]["terminate_reason"] == "第一次"

    def test_terminate_requires_reason(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        status, payload = panel.request(
            "POST", f"/api/panel/sessions/{session_id}/terminate", body={"by": "owner"}
        )
        assert (status, payload["error"]) == (400, "reason_required")


class TestProjectManagement:
    def test_project_lifecycle_over_http(self, panel: Panel) -> None:
        assert panel.create_project()[0] == 201
        assert panel.projects_path.is_file()

        status, payload = panel.request(
            "POST",
            "/api/panel/projects/demo/update",
            body={
                "by": "owner",
                "name": "demo",
                "path": str(panel.project_path),
                "description": "改过的说明",
                "pi_command": list(FAKE_PI),
                "pi_home": str(panel.pi_home),
            },
        )
        assert status == 200
        assert payload["operation"] == "project_update"
        _, document = panel.get("/api/panel")
        assert document["projects"][0]["description"] == "改过的说明"

        status, payload = panel.request(
            "POST", "/api/panel/projects/demo/remove", body={"by": "owner", "reason": "清理"}
        )
        assert status == 200
        _, document = panel.get("/api/panel")
        assert document["projects"] == []

    def test_project_creation_rejects_unusable_path(self, panel: Panel) -> None:
        status, payload = panel.request(
            "POST",
            "/api/panel/projects",
            body={
                "by": "owner",
                "name": "ghost",
                "path": str(panel.project_path / "missing"),
                "pi_command": list(FAKE_PI),
                "pi_home": str(panel.pi_home),
            },
        )
        assert (status, payload["error"]) == (400, "runtime_not_ready")
        assert not panel.projects_path.exists() or "ghost" not in panel.projects_path.read_text(
            encoding="utf-8"
        )

    def test_project_creation_rejects_bad_pi_home(self, panel: Panel) -> None:
        broken = panel.project_path.parent / "broken-home"
        broken.mkdir()
        status, payload = panel.request(
            "POST",
            "/api/panel/projects",
            body={
                "by": "owner",
                "name": "broken",
                "path": str(panel.project_path),
                "pi_command": list(FAKE_PI),
                "pi_home": str(broken),
            },
        )
        assert (status, payload["error"]) == (400, "runtime_not_ready")
        assert "models.json" in payload["detail"]

    def test_duplicate_project_name_is_refused(self, panel: Panel) -> None:
        panel.create_project()
        status, payload = panel.create_project()
        assert (status, payload["error"]) == (409, "name_conflict")

    def test_project_removal_is_refused_while_sessions_are_live(self, panel: Panel) -> None:
        panel.create_project()
        session_id = panel.create_session()
        status, payload = panel.request(
            "POST", "/api/panel/projects/demo/remove", body={"by": "owner", "reason": "清理"}
        )
        assert (status, payload["error"]) == (409, "sessions_live")
        assert session_id in payload["detail"]

        panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/terminate",
            body={"by": "owner", "reason": "收尾"},
        )
        status, _ = panel.request(
            "POST", "/api/panel/projects/demo/remove", body={"by": "owner", "reason": "清理"}
        )
        assert status == 200

    def test_projects_file_is_read_back_on_restart(self, panel: Panel) -> None:
        """档案是配置而不是内存状态：重启后仍能按同一份档案建会话。"""

        panel.create_project()
        settings = ServeSettings(
            web=panel.settings.web,
            service=panel.settings.service,
            config_path=panel.settings.config_path,
            operations=panel.settings.operations,
            projects_path=panel.projects_path,
        )
        reloaded = build_panel_context(settings)
        try:
            entries = reloaded.registry.entries()
            assert [entry.name for entry in entries] == ["demo"]
            assert entries[0].pi_home == str(panel.pi_home)
        finally:
            reloaded.runner.shutdown()


class TestReadOnlyServerHasNoPanel:
    def test_web_server_does_not_expose_the_panel(self, tmp_path: Path) -> None:
        """只读的 ``forgeloop web`` 不装配面板：/api/panel 必须 404，杜绝第二条写路径。"""

        from http.server import ThreadingHTTPServer

        from forgeloop.cli.web import ProgressRequestHandler

        web = WebSettings(
            records_root=tmp_path,
            host="127.0.0.1",
            port=0,
            refresh=resolve_refresh_seconds(
                load_web_config(ROOT / "config" / "web.toml"), cli_value=None
            ),
            config_path=ROOT / "config" / "web.toml",
            documents=DOCUMENTS,
        )

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def __init__(self) -> None:
                self.settings = web
                super().__init__(("127.0.0.1", 0), ProgressRequestHandler)

        server = Server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        host, port = server.server_address[:2]
        try:
            connection = http.client.HTTPConnection(str(host), int(port), timeout=10)
            try:
                connection.request("GET", "/api/panel")
                response = connection.getresponse()
                assert response.status == 404
                response.read()
            finally:
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_fake_pi_fixture_is_available() -> None:
    """集成层的真实边界：假 PI 必须真的存在（缺了就说清楚，而不是静默跳过）。"""

    assert os.path.isfile(FIXTURES / "fake_pi.py")


class TestStreamingOutput:
    def test_message_grows_while_the_turn_is_running(self, streaming_panel: Panel) -> None:
        panel = streaming_panel
        panel.create_project()
        session_id = panel.create_session()
        status, _ = panel.send(session_id, "开始干活")
        assert status == 202

        # 整轮还没结束：详情里已经有一条 streaming 消息，且内容随推流变长。
        seen_lengths: list[int] = []

        def poll_streaming() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            streaming = [item for item in detail["messages"] if item["state"] == "streaming"]
            if streaming:
                seen_lengths.append(len(str(streaming[0]["content"])))
                return len(seen_lengths) >= 2 and seen_lengths[-1] > seen_lengths[0]
            return False

        panel.wait_for(poll_streaming, what="流式内容增长")
        assert seen_lengths[-1] > seen_lengths[0]

        detail = panel.wait_turn_done(session_id)
        final = [item for item in detail["messages"] if item["role"] == "agent"]
        assert final[-1]["state"] == "ok"
        assert "整理改动方案" in str(final[-1]["content"])


class TestToolVisibilityAndApproval:
    def test_tools_are_recorded_and_the_gate_stops_the_next_step(self, panel: Panel) -> None:
        panel.set_fake_mode("panel-tools")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "看一下目录")

        def has_pending() -> bool:
            _, detail = panel.get(f"/api/panel/sessions/{session_id}")
            return detail["session"]["pending_decisions"] == 1

        panel.wait_for(has_pending, what="工具审批闸门出现")
        _, detail = panel.get(f"/api/panel/sessions/{session_id}")
        calls = {item["tool_name"]: item for item in detail["tool_calls"]}
        assert calls["bash"]["risk"] == "execute"
        assert calls["bash"]["requires_approval"] is True
        assert calls["bash"]["approval_status"] == "pending"
        assert calls["bash"]["status"] == "ok"
        assert calls["bash"]["duration_ms"] == 8
        assert "ls -la" in calls["bash"]["args_excerpt"]
        assert calls["read"]["risk"] == "read"
        assert calls["read"]["requires_approval"] is False

        decision = detail["decisions"][-1]
        assert decision["kind"] == "tool_review"
        assert "轮次边界" in decision["question"]
        assert detail["session"]["status"] == "awaiting_human"

        # 批准后工具转为已批准，会话回到可对话；再发消息仍能跑（同一常驻进程）。
        status, _ = panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/decisions/{decision['decision_id']}",
            body={"by": "owner", "decision": "approve", "reason": "这台机器上的 ls 可以跑"},
        )
        assert status == 200
        _, after = panel.get(f"/api/panel/sessions/{session_id}")
        assert after["session"]["status"] == "active"
        # 批准只放行需要确认的那一次；只读调用不会被标成已批准。
        assert {item["tool_name"]: item["approval_status"] for item in after["tool_calls"]} == {
            "bash": "approved",
            "read": "none",
        }

        panel.set_fake_mode("chat")
        panel.send(session_id, "继续")
        detail = panel.wait_turn_done(session_id)
        assert detail["session"]["turn_count"] == 2

    def test_two_sessions_record_their_own_tool_calls(self, panel: Panel) -> None:
        """两个会话各跑一次同名工具：各记各的行（PI 的 toolCallId 只在会话内唯一）。

        这是真实试验（.cache/manual-panel）抓到的缺陷：早期把 ``tool_call_id`` 当全局主键，
        第二个会话的同名调用会把第一条的归属覆盖掉，工具行在面板上直接消失。
        """

        panel.set_fake_mode("panel-tools")
        panel.create_project()
        sessions = []
        for title in ("第一个工具会话", "第二个工具会话"):
            session_id = panel.create_session(title=title)
            panel.send(session_id, "看一下目录")
            detail = panel.wait_turn_done(session_id)
            sessions.append((session_id, detail))

        for _session_id, detail in sessions:
            calls = {item["tool_name"]: item for item in detail["tool_calls"]}
            assert set(calls) == {"bash", "read"}
            assert calls["bash"]["requires_approval"] is True
            assert calls["bash"]["args_excerpt"] != ""
        # 两条记录各归各的会话，互不覆盖。
        first_calls = panel.get(f"/api/panel/sessions/{sessions[0][0]}")[1]["tool_calls"]
        second_calls = panel.get(f"/api/panel/sessions/{sessions[1][0]}")[1]["tool_calls"]
        assert len(first_calls) == 2
        assert len(second_calls) == 2
        assert {item["tool_call_id"] for item in first_calls} == {
            item["tool_call_id"] for item in second_calls
        }  # 同名 id：这是缺陷成立的前提，也正是必须按会话区分的原因

    def test_tool_approval_can_be_turned_off(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "panel-tools")
        instance = Panel(tmp_path, monkeypatch, tool_approval="off")
        instance.start()
        try:
            instance.create_project()
            session_id = instance.create_session()
            instance.send(session_id, "看一下目录")
            detail = instance.wait_turn_done(session_id)
            assert detail["session"]["status"] == "active"
            assert all(item["requires_approval"] is False for item in detail["tool_calls"])
            assert instance.get(f"/api/panel/sessions/{session_id}")[1]["decisions"] == []
        finally:
            instance.stop()


class TestMultiTurnContext:
    def test_second_turn_reuses_the_same_live_process(self, panel: Panel) -> None:
        panel.set_fake_mode("panel-multi")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "第一问")
        panel.wait_turn_done(session_id)
        _, document = panel.get("/api/panel")
        runtime = document["runtime"]
        assert runtime["live_sessions"] == 1
        live = runtime["live"][0]
        assert live["session_id"] == session_id
        pid = live["pid"]
        assert isinstance(pid, int) and pid > 0

        panel.send(session_id, "第二问")
        second = panel.wait_turn_done(session_id)
        agents = [item["content"] for item in second["messages"] if item["role"] == "agent"]
        assert "第 1 轮回复" in str(agents[-2])
        assert "第 2 轮回复" in str(agents[-1])

        # 第二轮由同一个进程承接：pid 不变、冷启动只有一次。
        _, document = panel.get("/api/panel")
        live = document["runtime"]["live"][0]
        assert live["pid"] == pid
        assert live["cold_starts"] == 1

        # 记录里写明这一轮的上下文模式：首轮 cold（回放历史），次轮 warm（同一进程）。
        human = [item for item in second["messages"] if item["role"] == "human"]
        assert [item["context_mode"] for item in human] == ["cold", "warm"]

        # 第二轮提示词里没有历史回放（上下文由常驻进程保持）。
        prompt = _last_prompt(panel, session_id)
        assert "第二问" in prompt
        assert "第一问" not in prompt

    def test_session_process_is_released_on_terminate(self, panel: Panel) -> None:
        panel.set_fake_mode("panel-multi")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "跑一轮")
        panel.wait_turn_done(session_id)
        assert panel.get("/api/panel")[1]["runtime"]["live_sessions"] == 1

        panel.request(
            "POST",
            f"/api/panel/sessions/{session_id}/terminate",
            body={"by": "owner", "reason": "收工"},
        )
        assert panel.get("/api/panel")[1]["runtime"]["live_sessions"] == 0


class TestCompactionVisibility:
    def test_context_edit_is_recorded_and_counted(self, panel: Panel) -> None:
        panel.set_fake_mode("panel-compact")
        panel.create_project()
        session_id = panel.create_session()
        panel.send(session_id, "继续做")
        detail = panel.wait_turn_done(session_id)

        assert detail["session"]["compaction_count"] == 1
        notices = [item for item in detail["messages"] if item["role"] == "system"]
        assert any("上下文" in str(item["content"]) for item in notices)
        # 压缩不删本会话流水：人工消息与回复都还在。
        contents = [item["content"] for item in detail["messages"]]
        assert "继续做" in contents
        assert any("上下文压缩过了" in str(item) for item in contents)


def _last_prompt(panel: Panel, session_id: str) -> str:
    """读该会话 PI 请求日志里的最后一次**提示词**（真实落盘的原始记录）。

    日志里同时记着 ``get_last_assistant_text`` 这类请求，因此按类型筛，而不是取下一条。
    """

    path = panel.root / "panel" / session_id / f"{session_id}-chat.requests.jsonl"
    prompts = [
        json.loads(line)["request"]["message"]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and json.loads(line)["request"].get("type") == "prompt"
    ]
    return str(prompts[-1])
