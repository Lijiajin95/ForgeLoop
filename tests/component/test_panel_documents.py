"""面板文档与写端点分发的组件级用例：状态码、错误码与拒绝理由。

执行器在这里是替身（只记录调用）：一轮执行的真实行为在 ``tests/unit`` 与
``tests/integration`` 两层验证；本层只钉「请求进来之后，谁被调用、回什么状态码、
什么情况下不写任何记录」。
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

from forgeloop.cli.panel import (
    PanelContext,
    PanelRegistry,
    PanelRejected,
    handle_panel_post,
    panel_document,
    session_document,
)
from forgeloop.domain.conversation import (
    ConversationError,
    DecisionKind,
    DecisionStatus,
    MessageRole,
    SessionStatus,
)
from forgeloop.domain.projects import PanelProject, ProjectEntry
from forgeloop.domain.service import ProjectProfile
from forgeloop.graph.conversation import ConversationRunner, TurnTicket
from forgeloop.records.conversations import ConversationStore

MOMENT = datetime(2026, 10, 18, 12, 0, 0, tzinfo=UTC)


class StubRunner:
    """替身执行器：记录受理与终止调用，不启动任何真实轮次。"""

    def __init__(self, *, refused: str = "") -> None:
        self.turns: list[tuple[str, str, str]] = []
        self.terminations: list[tuple[str, str, str]] = []
        self.running: set[str] = set()
        self.refused = refused

    def start_turn(self, session_id: str, text: str, by: str) -> TurnTicket:
        if self.refused:
            raise ConversationError(self.refused)
        self.turns.append((session_id, text, by))
        return TurnTicket(session_id=session_id, turn_count=len(self.turns), queued=False)

    def terminate(self, session_id: str, *, by: str, reason: str):
        from forgeloop.graph.conversation import TerminateResult

        self.terminations.append((session_id, by, reason))
        return TerminateResult(terminated=True, aborted=session_id in self.running)

    def is_running(self, session_id: str) -> bool:
        return session_id in self.running

    def status(self) -> dict[str, object]:
        return {"concurrency": 2, "running_turns": 0, "queued_turns": 0}


class Harness:
    def __init__(self, tmp_path: Path, *, service: dict | None = None, refused: str = "") -> None:
        self.db_path = tmp_path / "records.sqlite"
        self.projects_path = tmp_path / "projects.toml"
        self.registry = PanelRegistry(service or {}, self.projects_path)
        self.stub = StubRunner(refused=refused)
        self.context = PanelContext(
            registry=self.registry,
            runner=cast("ConversationRunner", self.stub),
            readiness=self.readiness,
            db_path=self.db_path,
        )
        self.problems: dict[str, tuple[str, ...]] = {}

    def readiness(self, entry: ProjectEntry) -> tuple[str, ...]:
        return self.problems.get(entry.name, ())

    def add_project(self, name: str = "demo", **overrides: object) -> str:
        fields: dict = {
            "path": f"/srv/{name}",
            "description": "演示",
            "pi_command": ["pi", "--mode", "rpc"],
            "pi_home": f"/home/{name}/pi-home",
        }
        fields.update(overrides)
        self.registry.create(
            PanelProject(
                name=name,
                path=str(fields["path"]),
                description=str(fields["description"]),
                pi_command=tuple(cast("list[str]", fields["pi_command"])),
                pi_home=str(fields["pi_home"]),
            )
        )
        return name

    def store(self) -> ConversationStore:
        return ConversationStore(self.db_path)

    def session(self, **overrides: object) -> str:
        store = self.store()
        try:
            fields: dict = {"project": "demo", "title": "冒烟会话", "by": "owner"}
            fields.update(overrides)
            return store.create_session(**fields).session_id
        finally:
            store.close()

    def post(self, route: str, body: dict, by: str = "owner") -> tuple[int, dict]:
        return handle_panel_post(self.context, route, body, by)


@pytest.fixture()
def harness(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def projects_of(harness: Harness) -> list[dict[str, object]]:
    """面板总览里的项目清单（文档是 `dict[str, object]`，这里按已知形状取用）。"""

    return cast("list[dict[str, object]]", panel_document(harness.context)["projects"])


class TestPanelDocument:
    def test_document_shape_without_projects(self, harness: Harness) -> None:
        document = panel_document(harness.context)
        assert document["schema_version"] == 1
        assert document["projects"] == []
        assert document["sessions"] == []
        runtime = document["runtime"]
        assert isinstance(runtime, dict)
        assert runtime["concurrency"] == 2

    def test_project_entry_reports_readiness_and_source(self, harness: Harness) -> None:
        harness.add_project("demo")
        service = ProjectProfile(
            name="svc",
            path="/srv/svc",
            pi_command=("pi",),
            test_command=("pytest",),
            baseline="",
            pi_home="/home/svc",
        )
        harness.registry = PanelRegistry({"svc": service}, harness.projects_path)
        harness.context = PanelContext(
            registry=harness.registry,
            runner=harness.context.runner,
            readiness=harness.readiness,
            db_path=harness.db_path,
        )
        by_name = {entry["name"]: entry for entry in projects_of(harness)}
        assert by_name["demo"]["source"] == "panel"
        assert by_name["demo"]["editable"] is True
        assert by_name["svc"]["source"] == "service"
        assert by_name["svc"]["editable"] is False
        assert by_name["svc"]["description"] == ""
        runtime = by_name["demo"]["runtime"]
        assert isinstance(runtime, dict)
        assert runtime["ready"] is True
        assert runtime["pi_command"] == ["pi", "--mode", "rpc"]

    def test_project_problems_block_readiness(self, harness: Harness) -> None:
        harness.add_project("demo")
        harness.problems["demo"] = ("项目路径不存在或不是目录: /srv/demo",)
        entry = projects_of(harness)[0]
        assert entry["problems"] == ["项目路径不存在或不是目录: /srv/demo"]
        runtime = cast("dict[str, object]", entry["runtime"])
        assert runtime["ready"] is False

    def test_session_summary_and_counts(self, harness: Harness) -> None:
        harness.add_project("demo")
        session_id = harness.session()
        store = harness.store()
        try:
            store.append_message(session_id, role=MessageRole.HUMAN, content="你好")
            store.open_decision(session_id, kind=DecisionKind.TURN_FAILED, question="重试?")
        finally:
            store.close()
        sessions = cast("list[dict[str, object]]", panel_document(harness.context)["sessions"])
        summary = sessions[0]
        assert summary["session_id"] == session_id
        assert summary["message_count"] == 1
        assert summary["pending_decisions"] == 1
        assert summary["running"] is False
        assert projects_of(harness)[0]["live_sessions"] == 1

    def test_session_document_carries_messages_and_decisions(self, harness: Harness) -> None:
        session_id = harness.session()
        store = harness.store()
        try:
            store.append_message(session_id, role=MessageRole.HUMAN, content="你好", author="owner")
            store.append_message(session_id, role=MessageRole.AGENT, content="收到")
            store.open_decision(session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?")
        finally:
            store.close()
        document = session_document(harness.context, session_id)
        assert document is not None
        messages = cast("list[dict[str, object]]", document["messages"])
        decisions = cast("list[dict[str, object]]", document["decisions"])
        session = cast("dict[str, object]", document["session"])
        assert [item["role"] for item in messages] == ["human", "agent"]
        assert messages[0]["author"] == "owner"
        assert decisions[0]["kind"] == "agent_request"
        assert decisions[0]["status"] == "pending"
        assert session["status"] == "active"

    def test_unknown_session_document_is_none(self, harness: Harness) -> None:
        assert session_document(harness.context, "cs-nope") is None


class TestSessionDispatch:
    def test_create_session(self, harness: Harness) -> None:
        harness.add_project("demo")
        status, payload = harness.post(
            "/api/panel/sessions", {"project": "demo", "title": "排查失败"}
        )
        assert status == 201
        assert payload["operation"] == "session_create"
        assert payload["source"] == "web:owner"

    def test_create_session_requires_fields(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/sessions", {"project": "demo", "title": " "})
        assert (error.value.status, error.value.code) == (400, "invalid_request")

    def test_create_session_for_unknown_project(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/sessions", {"project": "ghost", "title": "t"})
        assert (error.value.status, error.value.code) == (404, "project_not_found")

    def test_create_session_for_not_ready_project(self, harness: Harness) -> None:
        harness.add_project("demo")
        harness.problems["demo"] = ("缺少模型配置 /home/demo/.pi/agent/models.json",)
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/sessions", {"project": "demo", "title": "t"})
        assert error.value.code == "runtime_not_ready"
        assert "缺少模型配置" in str(error.value)
        # 被拒绝的创建不留下任何会话记录。
        assert panel_document(harness.context)["sessions"] == []

    def test_post_message_is_accepted_and_delegated(self, harness: Harness) -> None:
        session_id = harness.session()
        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/messages", {"text": "看一下"}
        )
        assert status == 202
        assert payload["queued"] is False
        assert harness.stub.turns == [(session_id, "看一下", "owner")]

    def test_post_message_rejects_empty_text(self, harness: Harness) -> None:
        session_id = harness.session()
        with pytest.raises(PanelRejected) as error:
            harness.post(f"/api/panel/sessions/{session_id}/messages", {"text": "   "})
        assert error.value.code == "invalid_request"
        assert harness.stub.turns == []

    def test_post_message_maps_runner_refusal_to_409(self, tmp_path: Path) -> None:
        harness = Harness(tmp_path, refused="有未处理的待人工决定；先批准或拒绝它")
        session_id = harness.session()
        with pytest.raises(PanelRejected) as error:
            harness.post(f"/api/panel/sessions/{session_id}/messages", {"text": "再看"})
        assert (error.value.status, error.value.code) == (409, "refused")

    def test_terminate_requires_reason_and_records_it(self, harness: Harness) -> None:
        session_id = harness.session()
        with pytest.raises(PanelRejected) as error:
            harness.post(f"/api/panel/sessions/{session_id}/terminate", {})
        assert (error.value.status, error.value.code) == (400, "reason_required")

        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/terminate", {"reason": "不需要了"}
        )
        assert status == 200
        assert payload["terminated"] is True
        # 分发的职责是「校验 + 交给执行器」；终止事实落库由执行器写（unit/integration 层验证）。
        assert harness.stub.terminations == [(session_id, "owner", "不需要了")]

    def test_terminate_unknown_session(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/sessions/cs-nope/terminate", {"reason": "停"})
        assert error.value.status == 404

    def test_terminate_reports_idempotent_repeat(self, harness: Harness) -> None:
        session_id = harness.session()
        harness.post(f"/api/panel/sessions/{session_id}/terminate", {"reason": "停"})
        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/terminate", {"reason": "再停"}
        )
        assert status == 200
        assert payload["already_terminated"] is False  # 替身总是报「本次生效」


class TestDecisionDispatch:
    def pending(self, harness: Harness, kind: DecisionKind = DecisionKind.AGENT_REQUEST) -> tuple:
        harness.add_project("demo")
        session_id = harness.session()
        store = harness.store()
        try:
            decision = store.open_decision(session_id, kind=kind, question="继续吗?")
            store.set_status(session_id, SessionStatus.AWAITING_HUMAN)
        finally:
            store.close()
        return session_id, decision.decision_id

    def test_reject_terminates_the_session(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            {"decision": "reject", "reason": "不做这一步"},
        )
        assert status == 200
        assert payload["session_status"] == "terminated"
        assert harness.stub.terminations == [(session_id, "owner", "拒绝待人工决定：不做这一步")]
        store = harness.store()
        try:
            decision = store.get_decision(decision_id)
            assert decision is not None
            assert decision.status is DecisionStatus.REJECTED
            assert decision.decided_by == "owner"
            assert decision.reason == "不做这一步"
        finally:
            store.close()

    def test_approve_retries_the_last_human_message(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness, DecisionKind.TURN_FAILED)
        store = harness.store()
        try:
            store.append_message(session_id, role=MessageRole.HUMAN, content="重试这条")
        finally:
            store.close()
        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            {"decision": "approve", "reason": "继续"},
        )
        assert status == 202
        assert payload["turn_count"] == 1
        assert harness.stub.turns == [(session_id, "重试这条", "owner")]

    def test_approve_with_instruction_uses_it(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        status, _ = harness.post(
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            {"decision": "approve", "reason": "按这个方向", "text": "改用方案 B"},
        )
        assert status == 202
        assert harness.stub.turns == [(session_id, "改用方案 B", "owner")]

    def test_approve_without_any_human_message_returns_to_active(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        status, payload = harness.post(
            f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
            {"decision": "approve", "reason": "知道了"},
        )
        assert status == 200
        assert payload["session_status"] == "active"
        assert harness.stub.turns == []

    def test_invalid_choice_and_missing_reason(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        route = f"/api/panel/sessions/{session_id}/decisions/{decision_id}"
        with pytest.raises(PanelRejected) as error:
            harness.post(route, {"decision": "maybe", "reason": "x"})
        assert error.value.code == "invalid_decision"
        with pytest.raises(PanelRejected) as reason_error:
            harness.post(route, {"decision": "approve"})
        assert reason_error.value.code == "reason_required"

    def test_unknown_decision_or_mismatched_session(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        other = harness.session(title="另一个会话")
        with pytest.raises(PanelRejected) as error:
            harness.post(
                f"/api/panel/sessions/{other}/decisions/{decision_id}",
                {"decision": "approve", "reason": "x"},
            )
        assert error.value.status == 404
        with pytest.raises(PanelRejected) as unknown:
            harness.post(
                f"/api/panel/sessions/{session_id}/decisions/dc-nope",
                {"decision": "approve", "reason": "x"},
            )
        assert unknown.value.code == "decision_not_found"

    def test_already_decided_is_refused(self, harness: Harness) -> None:
        session_id, decision_id = self.pending(harness)
        route = f"/api/panel/sessions/{session_id}/decisions/{decision_id}"
        harness.post(route, {"decision": "approve", "reason": "同意"})
        with pytest.raises(PanelRejected) as error:
            harness.post(route, {"decision": "reject", "reason": "反悔"})
        assert (error.value.status, error.value.code) == (409, "refused")


class TestProjectDispatch:
    def body(self, **overrides: object) -> dict:
        fields: dict = {
            "name": "demo",
            "path": "/srv/demo",
            "description": "演示",
            "pi_command": ["pi", "--mode", "rpc"],
            "pi_home": "/home/demo/pi-home",
        }
        fields.update(overrides)
        return fields

    def test_create_update_remove(self, harness: Harness) -> None:
        status, payload = harness.post("/api/panel/projects", self.body())
        assert status == 201
        assert payload["name"] == "demo"
        assert harness.projects_path.is_file()

        status, _ = harness.post(
            "/api/panel/projects/demo/update", self.body(description="改过的说明")
        )
        assert status == 200
        assert harness.registry.entries()[0].description == "改过的说明"

        status, payload = harness.post("/api/panel/projects/demo/remove", {"reason": "清理"})
        assert status == 200
        assert harness.registry.entries() == ()

    def test_create_refuses_bad_path(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/projects", self.body(path=""))
        assert (error.value.status, error.value.code) == (400, "invalid_project")

    def test_create_refuses_not_ready_project(self, harness: Harness) -> None:
        harness.problems["demo"] = ("缺少模型配置",)
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/projects", self.body())
        assert error.value.code == "runtime_not_ready"
        assert harness.registry.entries() == ()

    def test_create_refuses_name_taken_by_hand_written_config(self, tmp_path: Path) -> None:
        service = ProjectProfile(
            name="demo",
            path="/srv/demo",
            pi_command=("pi",),
            test_command=("pytest",),
            baseline="",
            pi_home="/home/demo",
        )
        harness = Harness(tmp_path, service={"demo": service})
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/projects", self.body())
        assert error.value.code == "name_conflict"

    def test_update_and_remove_refuse_hand_written_projects(self, tmp_path: Path) -> None:
        service = ProjectProfile(
            name="svc",
            path="/srv/svc",
            pi_command=("pi",),
            test_command=("pytest",),
            baseline="",
            pi_home="/home/svc",
        )
        harness = Harness(tmp_path, service={"svc": service})
        with pytest.raises(PanelRejected) as update_error:
            harness.post("/api/panel/projects/svc/update", self.body(name="svc"))
        assert update_error.value.code == "service_managed"
        with pytest.raises(PanelRejected) as remove_error:
            harness.post("/api/panel/projects/svc/remove", {"reason": "清理"})
        assert remove_error.value.code == "service_managed"

    def test_remove_requires_reason_and_refuses_live_sessions(self, harness: Harness) -> None:
        harness.add_project("demo")
        session_id = harness.session()
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/projects/demo/remove", {"reason": "清理"})
        assert error.value.code == "sessions_live"
        assert session_id in str(error.value)
        assert harness.registry.entries() != ()

    def test_remove_unknown_project(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/projects/ghost/remove", {"reason": "清理"})
        assert error.value.status == 404

    def test_unknown_post_route_is_404(self, harness: Harness) -> None:
        with pytest.raises(PanelRejected) as error:
            harness.post("/api/panel/unknown", {})
        assert (error.value.status, error.value.code) == (404, "not_found")


class TestReadinessFunction:
    def test_problems_cover_missing_path_and_pi_home(self, tmp_path: Path) -> None:
        from forgeloop.cli.serve import panel_project_problems

        entry = ProjectEntry(
            name="demo",
            path=str(tmp_path / "missing"),
            description="",
            pi_command=("pi",),
            pi_home=str(tmp_path / "pi-home"),
            source="panel",
        )
        problems = panel_project_problems(entry)
        assert any("不是目录" in problem for problem in problems)
        assert any("models.json" in problem for problem in problems)
