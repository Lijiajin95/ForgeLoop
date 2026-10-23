"""面板一轮执行的单元测试：多轮上下文、流式落库、工具留痕、审批闸门与压缩。

执行器不直接起子进程（真实 PI RPC 边界在集成与系统层），这里注入替身进程，并用**真实
事件形状**（见 ``.cache/dogfood`` 的 206 份轨迹）驱动它：文本增量、工具执行、上下文编辑。
因此本层校验的是「一轮到底发生了什么、记录成了什么」，而不是「某个函数被调用过」。
"""

import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

from forgeloop.adapter.pi_rpc import PIEvent, PIInvocationResult, PIProcess
from forgeloop.domain.conversation import (
    ConversationError,
    DecisionKind,
    MessageRole,
    MessageState,
    SessionStatus,
    ToolApprovalPolicy,
)
from forgeloop.domain.projects import SOURCE_PANEL, ProjectEntry
from forgeloop.graph.conversation import ConversationRunner
from forgeloop.records.conversations import ConversationStore, MessageRecord

WAIT_SECONDS = 10.0
TICK_SECONDS = 0.01


class FakePI:
    """替身 PI 进程：按脚本回答一轮，并把增量事件交给与真实进程同一个回调。"""

    _pids = iter(range(1000, 9999))

    def __init__(
        self,
        outcome: Callable[["FakePI"], PIInvocationResult],
        on_event: Callable[[PIEvent], None],
    ) -> None:
        self.prompts: list[str] = []
        self.started = False
        self.stop_requests = 0
        self.closed = False
        self.pid = next(FakePI._pids)
        self.abort_event = threading.Event()
        self.release_event = threading.Event()
        self._on_event = on_event
        self._outcome = outcome

    def start(self) -> None:
        self.started = True

    def is_alive(self) -> bool:
        return self.started and not self.closed

    def send_prompt(self, text: str) -> None:
        self.prompts.append(text)

    def request_stop(self) -> None:
        self.stop_requests += 1
        self.abort_event.set()
        self.release_event.set()

    def close(self) -> None:
        self.closed = True

    def emit(self, event_type: str, payload: dict) -> None:
        self._on_event(PIEvent(type=event_type, payload=payload, received_at=datetime.now(UTC)))

    def wait_until_settled(self, timeout_seconds: float) -> PIInvocationResult:
        del timeout_seconds
        return self._outcome(self)


def settled(text: str) -> PIInvocationResult:
    return PIInvocationResult(settled=True, aborted=False, text=text, result=None, events=())


def aborted_result() -> PIInvocationResult:
    return PIInvocationResult(settled=True, aborted=True, text=None, result=None, events=())


def failure(error: str = "timeout", *, model_error: str | None = None) -> PIInvocationResult:
    return PIInvocationResult(
        settled=False,
        aborted=False,
        text=None,
        result=None,
        events=(),
        error=error,
        model_error=model_error,
    )


def scripted_reply(
    text: str,
    *,
    tools: tuple[tuple[str, str, dict, dict], ...] = (),
    compactions: int = 0,
    chunk: int = 4,
) -> Callable[[FakePI], PIInvocationResult]:
    """一轮脚本：助手消息 +（可选）工具执行 +（可选）上下文压缩，最后 settled。

    ``tools`` 每项是 ``(tool_call_id, tool_name, args, result)``——与真实事件同形。
    """

    def outcome(process: FakePI) -> PIInvocationResult:
        process.emit("message_start", {"message": {"role": "assistant", "content": []}})
        for start in range(0, len(text), chunk):
            process.emit(
                "message_update",
                {
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": text[start : start + chunk],
                    }
                },
            )
        for index, (call_id, name, args, result) in enumerate(tools):
            process.emit("message_end", {"message": {"role": "assistant", "content": []}})
            process.emit(
                "tool_execution_start", {"toolCallId": call_id, "toolName": name, "args": args}
            )
            process.emit(
                "tool_execution_end",
                {
                    "toolCallId": call_id,
                    "toolName": name,
                    "result": result,
                    "isError": False,
                    "durationMs": 12 + index,
                },
            )
        for index in range(compactions):
            process.emit(
                "entry_appended",
                {
                    "entry": {
                        "type": "context_edit",
                        "targetId": f"entry-{index}",
                        "replacement": None,
                    }
                },
            )
        process.emit("message_end", {"message": {"role": "assistant", "content": []}})
        return settled(text)

    return outcome


def entry(name: str = "demo") -> ProjectEntry:
    return ProjectEntry(
        name=name,
        path=f"/srv/{name}",
        description="",
        pi_command=("pi", "--mode", "rpc"),
        pi_home=f"/home/{name}/pi-home",
        source=SOURCE_PANEL,
    )


def wait_idle(runner: ConversationRunner, session_id: str) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if not runner.is_running(session_id):
            return
        time.sleep(TICK_SECONDS)
    raise AssertionError("会话轮次没有在超时内结束")


def wait_for(predicate: Callable[[], bool], what: str) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(TICK_SECONDS)
    raise AssertionError(f"等待超时: {what}")


class Fixture:
    """一套装配好的执行器 + 记录库，连同注入的替身进程工厂。"""

    def __init__(
        self,
        tmp_path: Path,
        *,
        outcome: Callable[[FakePI], PIInvocationResult] | None = None,
        projects: dict[str, ProjectEntry] | None = None,
        readiness: Callable[[ProjectEntry], tuple[str, ...]] | None = None,
        concurrency: int = 2,
        policy: str = "write",
        idle_seconds: float = 900.0,
        max_live: int = 4,
    ) -> None:
        self.db_path = tmp_path / "records.sqlite"
        self.projects = projects if projects is not None else {"demo": entry()}
        self.readiness = readiness or (lambda _: ())
        self.created: list[FakePI] = []
        self.outcome = outcome or scripted_reply("好的。")
        self.runner = ConversationRunner(
            records_path=self.db_path,
            session_root=tmp_path / "panel",
            projects=lambda: self.projects,
            readiness=self.readiness,
            concurrency=concurrency,
            turn_timeout_seconds=30,
            tool_approval=ToolApprovalPolicy(policy),
            session_idle_seconds=idle_seconds,
            max_live_sessions=max_live,
            pi_factory=self._factory,
        )

    def _factory(
        self, project: ProjectEntry, session_id: str, on_event: Callable[[PIEvent], None]
    ) -> PIProcess:
        del project, session_id
        process = FakePI(self.outcome, on_event)
        self.created.append(process)
        return cast("PIProcess", process)

    def store(self) -> ConversationStore:
        return ConversationStore(self.db_path)

    def session(self, **overrides: object) -> str:
        store = self.store()
        try:
            fields: dict = {"project": "demo", "title": "排查失败", "by": "owner"}
            fields.update(overrides)
            return store.create_session(**fields).session_id
        finally:
            store.close()

    def turn(self, session_id: str, text: str = "看一下", by: str = "owner"):
        ticket = self.runner.start_turn(session_id, text, by)
        wait_idle(self.runner, session_id)
        return ticket

    def messages(self, session_id: str) -> tuple[MessageRecord, ...]:
        store = self.store()
        try:
            return store.list_messages(session_id)
        finally:
            store.close()

    def status(self, session_id: str) -> SessionStatus:
        store = self.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            return session.status
        finally:
            store.close()


@pytest.fixture()
def fixture(tmp_path: Path) -> Iterator[Fixture]:
    instance = Fixture(tmp_path)
    try:
        yield instance
    finally:
        instance.runner.shutdown()


class TestMultiTurnContext:
    def test_first_turn_is_cold_and_replays_history(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        ticket = fixture.turn(session_id, "第一问")
        assert ticket.turn_count == 1
        prompt = fixture.created[-1].prompts[0]
        assert "/srv/demo" in prompt
        assert "[人工] 第一问" in prompt
        assert "本次人工输入" in prompt
        assert fixture.messages(session_id)[0].context_mode == "cold"

    def test_second_turn_reuses_the_process_and_skips_replay(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.turn(session_id, "第一问")
        fixture.turn(session_id, "第二问")
        assert len(fixture.created) == 1
        second_prompt = fixture.created[0].prompts[1]
        assert "第一问" not in second_prompt
        assert "后续输入" in second_prompt
        assert second_prompt.rstrip().endswith("第二问")
        human = [item for item in fixture.messages(session_id) if item.role is MessageRole.HUMAN]
        assert [item.context_mode for item in human] == ["cold", "warm"]

    def test_dead_process_is_replaced_and_replays_again(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.turn(session_id, "第一问")
        fixture.created[0].close()
        fixture.turn(session_id, "第二问")
        assert len(fixture.created) == 2
        assert "[人工] 第一问" in fixture.created[1].prompts[0]
        human = [item for item in fixture.messages(session_id) if item.role is MessageRole.HUMAN]
        assert [item.context_mode for item in human] == ["cold", "cold"]

    def test_idle_sessions_are_reaped_then_cold_start(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path, idle_seconds=0.0)
        try:
            session_id = fixture.session()
            fixture.turn(session_id, "第一问")
            assert fixture.runner.reap_idle_sessions() == (session_id,)
            assert fixture.created[0].closed is True
            fixture.turn(session_id, "第二问")
            assert len(fixture.created) == 2
        finally:
            fixture.runner.shutdown()

    def test_max_live_evicts_the_least_recently_used(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path, max_live=1)
        try:
            first = fixture.session(title="第一条")
            second = fixture.session(title="第二条")
            fixture.turn(first, "第一会话")
            fixture.turn(second, "第二会话")
            assert fixture.runner.status()["live_sessions"] == 1
            assert fixture.created[0].closed is True
        finally:
            fixture.runner.shutdown()

    def test_status_reports_live_sessions(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.turn(session_id)
        status = fixture.runner.status()
        assert status["live_sessions"] == 1
        live = cast("list[dict[str, object]]", status["live"])
        assert live[0]["session_id"] == session_id
        assert live[0]["cold_starts"] == 1
        assert live[0]["busy"] is False
        assert status["tool_approval"] == "write"


class TestStreaming:
    def test_deltas_grow_one_message_then_finalize(self, tmp_path: Path) -> None:
        release = threading.Event()
        started = threading.Event()

        def outcome(process: FakePI) -> PIInvocationResult:
            process.emit("message_start", {"message": {"role": "assistant", "content": []}})
            process.emit(
                "message_update",
                {"assistantMessageEvent": {"type": "text_delta", "delta": "第一段"}},
            )
            started.set()
            assert release.wait(WAIT_SECONDS)
            process.emit(
                "message_update",
                {"assistantMessageEvent": {"type": "text_delta", "delta": "第二段"}},
            )
            process.emit("message_end", {"message": {"role": "assistant", "content": []}})
            return settled("第一段第二段")

        fixture = Fixture(tmp_path, outcome=outcome)
        try:
            session_id = fixture.session()
            fixture.runner.start_turn(session_id, "开始", "owner")
            assert started.wait(WAIT_SECONDS)
            wait_for(
                lambda: any(
                    item.state is MessageState.STREAMING for item in fixture.messages(session_id)
                ),
                "流式消息出现",
            )
            partial = [
                item
                for item in fixture.messages(session_id)
                if item.state is MessageState.STREAMING
            ]
            assert partial[0].content == "第一段"
            release.set()
            wait_idle(fixture.runner, session_id)
            final = [
                item for item in fixture.messages(session_id) if item.role is MessageRole.AGENT
            ]
            assert [item.content for item in final] == ["第一段第二段"]
            assert final[0].state is MessageState.OK
        finally:
            release.set()
            fixture.runner.shutdown()

    def test_thinking_deltas_stay_out_of_the_transcript(self, fixture: Fixture) -> None:
        def outcome(process: FakePI) -> PIInvocationResult:
            process.emit("message_start", {"message": {"role": "assistant", "content": []}})
            process.emit(
                "message_update",
                {"assistantMessageEvent": {"type": "thinking_delta", "delta": "内部思考"}},
            )
            process.emit(
                "message_update",
                {"assistantMessageEvent": {"type": "text_delta", "delta": "给用户的话"}},
            )
            process.emit("message_end", {"message": {"role": "assistant", "content": []}})
            return settled("给用户的话")

        fixture.outcome = outcome
        session_id = fixture.session()
        fixture.turn(session_id)
        agents = [
            item.content for item in fixture.messages(session_id) if item.role is MessageRole.AGENT
        ]
        assert agents == ["给用户的话"]

    def test_two_assistant_messages_become_two_rows(self, fixture: Fixture) -> None:
        def outcome(process: FakePI) -> PIInvocationResult:
            for text in ("先看目录。", "然后改文件。"):
                process.emit("message_start", {"message": {"role": "assistant", "content": []}})
                process.emit(
                    "message_update",
                    {"assistantMessageEvent": {"type": "text_delta", "delta": text}},
                )
                process.emit("message_end", {"message": {"role": "assistant", "content": []}})
            return settled("然后改文件。")

        fixture.outcome = outcome
        session_id = fixture.session()
        fixture.turn(session_id)
        agents = [
            item.content for item in fixture.messages(session_id) if item.role is MessageRole.AGENT
        ]
        assert agents == ["先看目录。", "然后改文件。"]


class TestToolVisibilityAndApproval:
    def tool_script(self, name: str = "bash") -> Callable[[FakePI], PIInvocationResult]:
        return scripted_reply(
            "跑完了。",
            tools=(
                (
                    f"call-{name}",
                    name,
                    {"command": "ls -la"},
                    {"content": [{"type": "text", "text": "ok"}]},
                ),
            ),
        )

    def test_tool_call_is_recorded_and_gates_the_next_turn(self, fixture: Fixture) -> None:
        fixture.outcome = self.tool_script()
        session_id = fixture.session()
        fixture.turn(session_id)

        store = fixture.store()
        try:
            calls = store.list_tool_calls(session_id)
            assert len(calls) == 1
            assert calls[0].tool_name == "bash"
            assert calls[0].risk == "execute"
            assert calls[0].status == "ok"
            assert calls[0].requires_approval is True
            assert calls[0].approval_status == "pending"
            assert calls[0].duration_ms == 12
            assert "ls -la" in calls[0].args_excerpt
            assert calls[0].result_excerpt == "ok"
            decision = store.pending_decision(session_id)
            assert decision is not None
            assert decision.kind is DecisionKind.TOOL_REVIEW
            assert "轮次边界" in decision.question
            assert "bash" in decision.question
        finally:
            store.close()
        assert fixture.status(session_id) is SessionStatus.AWAITING_HUMAN

    def test_read_only_tools_do_not_gate(self, fixture: Fixture) -> None:
        fixture.outcome = scripted_reply(
            "看完了。",
            tools=(("call-read", "read", {"path": "/srv/demo/a.py"}, {"content": []}),),
        )
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            calls = store.list_tool_calls(session_id)
            assert calls[0].risk == "read"
            assert calls[0].requires_approval is False
            assert calls[0].approval_status == "none"
            assert store.count_pending_tool_approvals(session_id) == 0
            assert store.pending_decision(session_id) is None
        finally:
            store.close()
        assert fixture.status(session_id) is SessionStatus.ACTIVE

    def test_unknown_tools_need_approval(self, fixture: Fixture) -> None:
        fixture.outcome = scripted_reply(
            "用了个插件。",
            tools=(("call-x", "custom_browser", {"url": "https://example.test"}, {"content": []}),),
        )
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            calls = store.list_tool_calls(session_id)
            assert calls[0].risk == "unknown"
            assert calls[0].requires_approval is True
        finally:
            store.close()

    def test_policy_off_disables_the_gate(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path, policy="off")
        try:
            fixture.outcome = self.tool_script()
            session_id = fixture.session()
            fixture.turn(session_id)
            store = fixture.store()
            try:
                assert store.list_tool_calls(session_id)[0].requires_approval is False
                assert store.pending_decision(session_id) is None
            finally:
                store.close()
            assert fixture.status(session_id) is SessionStatus.ACTIVE
        finally:
            fixture.runner.shutdown()

    def test_policy_all_gates_read_only_tools_too(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path, policy="all")
        try:
            fixture.outcome = scripted_reply(
                "看完了。", tools=(("call-read", "read", {"path": "/a"}, {"content": []}),)
            )
            session_id = fixture.session()
            fixture.turn(session_id)
            store = fixture.store()
            try:
                assert store.list_tool_calls(session_id)[0].requires_approval is True
            finally:
                store.close()
            assert fixture.status(session_id) is SessionStatus.AWAITING_HUMAN
        finally:
            fixture.runner.shutdown()

    def test_approval_marks_tools(self, fixture: Fixture) -> None:
        fixture.outcome = self.tool_script()
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            assert store.count_pending_tool_approvals(session_id) == 1
            assert store.mark_tool_approval(session_id, "approved") == 1
            assert store.count_pending_tool_approvals(session_id) == 0
            assert store.mark_tool_approval(session_id, "approved") == 0
            assert store.list_tool_calls(session_id)[0].approval_status == "approved"
        finally:
            store.close()

    def test_tool_end_without_start_is_recorded_as_unknown(self, fixture: Fixture) -> None:
        def outcome(process: FakePI) -> PIInvocationResult:
            process.emit(
                "tool_execution_end",
                {
                    "toolCallId": "orphan",
                    "toolName": "bash",
                    "result": {"content": [{"type": "text", "text": "输出"}]},
                    "isError": True,
                    "durationMs": 5,
                },
            )
            return settled("完成")

        fixture.outcome = outcome
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            calls = store.list_tool_calls(session_id)
            assert calls[0].tool_call_id == "orphan"
            assert calls[0].status == "error"
            assert calls[0].risk == "unknown"
        finally:
            store.close()


class TestCompaction:
    def test_context_edit_is_noticed_and_counted(self, fixture: Fixture) -> None:
        fixture.outcome = scripted_reply("压缩过了。", compactions=2)
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            assert session.compaction_count == 2
        finally:
            store.close()
        notices = [
            item.content for item in fixture.messages(session_id) if item.role is MessageRole.SYSTEM
        ]
        assert len(notices) == 2
        assert "上下文" in notices[0]
        contents = [item.content for item in fixture.messages(session_id)]
        assert "看一下" in contents
        assert "压缩过了。" in contents


class TestFailuresAndTermination:
    def test_failed_turn_waits_for_human(self, fixture: Fixture) -> None:
        fixture.outcome = lambda process: failure("timeout")
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            decision = store.pending_decision(session_id)
            assert decision is not None
            assert decision.kind is DecisionKind.TURN_FAILED
            session = store.get_session(session_id)
            assert session is not None
            assert session.last_error == "PI timeout"
        finally:
            store.close()

    def test_model_error_is_reported_not_hidden(self, fixture: Fixture) -> None:
        fixture.outcome = lambda process: failure("", model_error="403: subscription")
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            assert "模型错误" in session.last_error
        finally:
            store.close()

    def test_empty_text_is_a_failure(self, fixture: Fixture) -> None:
        fixture.outcome = lambda process: settled("   ")
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            assert "没有回复文本" in session.last_error
        finally:
            store.close()

    def test_hitl_request_still_waits_for_human(self, fixture: Fixture) -> None:
        fixture.outcome = scripted_reply('{"awaiting_human": true, "question": "删掉旧接口?"}')
        session_id = fixture.session()
        fixture.turn(session_id)
        store = fixture.store()
        try:
            decision = store.pending_decision(session_id)
            assert decision is not None
            assert decision.kind is DecisionKind.AGENT_REQUEST
            assert decision.question == "删掉旧接口?"
        finally:
            store.close()
        assert fixture.status(session_id) is SessionStatus.AWAITING_HUMAN

    def test_unknown_project_fails_the_turn(self, fixture: Fixture) -> None:
        session_id = fixture.session(project="ghost")
        fixture.turn(session_id)
        store = fixture.store()
        try:
            session = store.get_session(session_id)
            assert session is not None
            assert "不在项目档案" in session.last_error
        finally:
            store.close()

    def test_not_ready_project_fails_the_turn(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path, readiness=lambda _: ("缺少模型配置",))
        try:
            session_id = fixture.session()
            fixture.turn(session_id)
            store = fixture.store()
            try:
                session = store.get_session(session_id)
                assert session is not None
                assert "缺少模型配置" in session.last_error
            finally:
                store.close()
        finally:
            fixture.runner.shutdown()

    def test_terminate_aborts_and_closes_the_process(self, tmp_path: Path) -> None:
        started = threading.Event()

        def outcome(process: FakePI) -> PIInvocationResult:
            started.set()
            assert process.abort_event.wait(WAIT_SECONDS)
            return aborted_result()

        fixture = Fixture(tmp_path, outcome=outcome)
        try:
            session_id = fixture.session()
            fixture.runner.start_turn(session_id, "长任务", "owner")
            assert started.wait(WAIT_SECONDS)
            result = fixture.runner.terminate(session_id, by="owner", reason="不要了")
            assert result.terminated is True
            assert result.aborted is True
            wait_idle(fixture.runner, session_id)
            assert fixture.status(session_id) is SessionStatus.TERMINATED
            assert fixture.messages(session_id)[-1].content == "本轮已被人工终止。"
            assert fixture.created[-1].closed is True
            assert fixture.runner.status()["live_sessions"] == 0
        finally:
            fixture.runner.shutdown()

    def test_terminate_without_live_process(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        result = fixture.runner.terminate(session_id, by="owner", reason="不做了")
        assert (result.terminated, result.aborted) == (True, False)

    def test_second_terminate_keeps_the_first_fact(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.runner.terminate(session_id, by="owner", reason="第一次")
        again = fixture.runner.terminate(session_id, by="other", reason="第二次")
        assert again.terminated is False

    def test_terminated_session_refuses_new_messages(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.runner.terminate(session_id, by="owner", reason="停")
        with pytest.raises(ConversationError) as error:
            fixture.runner.start_turn(session_id, "再来", "owner")
        assert "已终止" in str(error.value)

    def test_pending_decision_blocks_new_messages(self, fixture: Fixture) -> None:
        fixture.outcome = scripted_reply('{"awaiting_human": true, "question": "确认吗?"}')
        session_id = fixture.session()
        fixture.turn(session_id)
        with pytest.raises(ConversationError) as error:
            fixture.runner.start_turn(session_id, "再问一句", "owner")
        assert "待人工决定" in str(error.value)

    def test_shutdown_stops_processes_and_refuses_turns(self, tmp_path: Path) -> None:
        started = threading.Event()

        def outcome(process: FakePI) -> PIInvocationResult:
            started.set()
            assert process.abort_event.wait(WAIT_SECONDS)
            return aborted_result()

        fixture = Fixture(tmp_path, outcome=outcome)
        session_id = fixture.session()
        fixture.runner.start_turn(session_id, "长任务", "owner")
        assert started.wait(WAIT_SECONDS)
        fixture.runner.shutdown()
        assert fixture.created[-1].stop_requests == 1
        assert fixture.created[-1].closed is True
        with pytest.raises(ConversationError):
            fixture.runner.start_turn(session_id, "再来", "owner")

    def test_closed_runner_refuses_new_turns(self, fixture: Fixture) -> None:
        session_id = fixture.session()
        fixture.runner.shutdown()
        with pytest.raises(ConversationError) as error:
            fixture.runner.start_turn(session_id, "再来", "owner")
        # 关闭后可能处于「已停止」或「排空中」，两者都必须拒绝新轮次。
        assert "不再受理" in str(error.value)


class TestRunningVisibility:
    def test_running_turn_is_visible(self, tmp_path: Path) -> None:
        release = threading.Event()
        started = threading.Event()

        def outcome(process: FakePI) -> PIInvocationResult:
            del process
            started.set()
            assert release.wait(WAIT_SECONDS)
            return settled("完成")

        fixture = Fixture(tmp_path, outcome=outcome, concurrency=1)
        try:
            session_id = fixture.session()
            fixture.runner.start_turn(session_id, "长任务", "owner")
            assert started.wait(WAIT_SECONDS)
            assert fixture.runner.is_running(session_id) is True
            status = fixture.runner.status()
            assert status["running_sessions"] == [session_id]
            live = cast("list[dict[str, object]]", status["live"])
            assert live[0]["busy"] is True
        finally:
            release.set()
            fixture.runner.shutdown()

    def test_queued_ticket_when_concurrency_is_full(self, tmp_path: Path) -> None:
        release = threading.Event()
        started = threading.Event()

        def outcome(process: FakePI) -> PIInvocationResult:
            del process
            started.set()
            assert release.wait(WAIT_SECONDS)
            return settled("完成")

        fixture = Fixture(tmp_path, outcome=outcome, concurrency=1)
        try:
            first = fixture.session(title="第一条")
            second = fixture.session(title="第二条")
            fixture.runner.start_turn(first, "长任务", "owner")
            assert started.wait(WAIT_SECONDS)
            ticket = fixture.runner.start_turn(second, "排队", "owner")
            assert ticket.queued is True
        finally:
            release.set()
            fixture.runner.shutdown()
