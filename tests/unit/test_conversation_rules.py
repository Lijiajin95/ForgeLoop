"""面板会话纯规则的单元测试：状态、HITL 判定、提示词与输出解释。

这些用例钉的是**可客观判定**的部分：什么情况允许继续、什么情况必须停下等人工、
提示词里有没有把人工决定契约说清楚、模型输出在什么条件下才算「请求人工决定」。
"""

from datetime import UTC, datetime

import pytest

from forgeloop.domain.conversation import (
    HISTORY_MESSAGES_MAX,
    PROMPT_CHARS_MAX,
    TOOL_ARG_CHARS_MAX,
    TOOL_RESULT_CHARS_MAX,
    ConversationError,
    DecisionStatus,
    MessageRole,
    SessionStatus,
    ToolApprovalPolicy,
    ToolRisk,
    approval_required,
    build_turn_prompt,
    can_accept_message,
    can_decide,
    context_edit_notice,
    excerpt,
    interpret_agent_text,
    new_decision_id,
    new_session_id,
    project_name_is_valid,
    session_id_is_valid,
    text_delta,
    tool_call_finished,
    tool_call_started,
    tool_call_summary,
    tool_risk,
    validate_message,
    validate_reason,
    validate_title,
)

MOMENT = datetime(2026, 10, 18, 12, 0, 0, tzinfo=UTC)


class TestIdentity:
    def test_session_id_shape(self) -> None:
        session_id = new_session_id(MOMENT)
        assert session_id.startswith("cs-20261018120000-")
        assert len(session_id) == len("cs-20261018120000-") + 6
        assert session_id_is_valid(session_id)

    def test_decision_id_shape(self) -> None:
        decision_id = new_decision_id(MOMENT)
        assert decision_id.startswith("dc-20261018120000-")
        assert session_id_is_valid(decision_id)

    def test_ids_do_not_repeat(self) -> None:
        assert len({new_session_id(MOMENT) for _ in range(50)}) == 50

    @pytest.mark.parametrize("value", ["", "cs 1", "cs/1", "cs;drop", "x" * 129])
    def test_invalid_session_ids_are_rejected(self, value: str) -> None:
        assert not session_id_is_valid(value)

    @pytest.mark.parametrize("name", ["demo", "a.b-c_d", "ForgeLoop-2"])
    def test_project_name_accepts_safe_tokens(self, name: str) -> None:
        assert project_name_is_valid(name)

    @pytest.mark.parametrize("name", ["", "bad name", "a/b", 'a"b', "项目", "x" * 65])
    def test_project_name_rejects_unsafe_tokens(self, name: str) -> None:
        assert not project_name_is_valid(name)


class TestInputValidation:
    def test_title_is_trimmed(self) -> None:
        assert validate_title("  排查构建失败  ") == "排查构建失败"

    @pytest.mark.parametrize("value", ["", "   ", "a" * 121, "两行\n标题"])
    def test_invalid_titles(self, value: str) -> None:
        with pytest.raises(ConversationError):
            validate_title(value)

    def test_message_keeps_body(self) -> None:
        assert validate_message("  请检查   ") == "请检查"

    @pytest.mark.parametrize("value", ["", " ", "x" * 8001])
    def test_invalid_messages(self, value: str) -> None:
        with pytest.raises(ConversationError):
            validate_message(value)

    def test_reason_allows_empty_but_bounded(self) -> None:
        assert validate_reason("") == ""
        assert validate_reason("  因为  ") == "因为"
        with pytest.raises(ConversationError):
            validate_reason("x" * 501)


class TestAcceptanceRules:
    @pytest.mark.parametrize(
        ("status", "pending", "running", "allowed"),
        [
            (SessionStatus.ACTIVE, False, False, True),
            (SessionStatus.ACTIVE, True, False, False),
            (SessionStatus.ACTIVE, False, True, False),
            (SessionStatus.AWAITING_HUMAN, False, False, True),
            (SessionStatus.TERMINATED, False, False, False),
        ],
    )
    def test_can_accept_message(
        self, status: SessionStatus, pending: bool, running: bool, allowed: bool
    ) -> None:
        verdict = can_accept_message(status, pending_decision=pending, running=running)
        assert verdict.allowed is allowed
        if not allowed:
            assert verdict.reason

    def test_pending_decision_reason_names_the_next_step(self) -> None:
        verdict = can_accept_message(
            SessionStatus.AWAITING_HUMAN, pending_decision=True, running=False
        )
        assert "批准或拒绝" in verdict.reason

    @pytest.mark.parametrize(
        ("status", "decision", "allowed"),
        [
            (SessionStatus.ACTIVE, DecisionStatus.PENDING, True),
            (SessionStatus.AWAITING_HUMAN, DecisionStatus.PENDING, True),
            (SessionStatus.TERMINATED, DecisionStatus.PENDING, False),
            (SessionStatus.ACTIVE, DecisionStatus.APPROVED, False),
            (SessionStatus.ACTIVE, DecisionStatus.REJECTED, False),
        ],
    )
    def test_can_decide(
        self, status: SessionStatus, decision: DecisionStatus, allowed: bool
    ) -> None:
        assert can_decide(status, decision).allowed is allowed


class TestTurnPrompt:
    def prompt(self, history: tuple[tuple[MessageRole, str], ...] = ()) -> str:
        return build_turn_prompt(
            project="demo",
            project_path="/srv/demo",
            title="排查构建失败",
            history=history,
            instruction="看看测试为什么失败",
        )

    def test_prompt_carries_project_and_instruction(self) -> None:
        prompt = self.prompt()
        assert "demo" in prompt
        assert "/srv/demo" in prompt
        assert "排查构建失败" in prompt
        assert prompt.rstrip().endswith("看看测试为什么失败")

    def test_prompt_states_the_hitl_contract(self) -> None:
        assert '"awaiting_human": true' in self.prompt()

    def test_history_is_replayed_in_order(self) -> None:
        prompt = self.prompt(((MessageRole.HUMAN, "第一条"), (MessageRole.AGENT, "第一条回复")))
        assert prompt.index("[人工] 第一条") < prompt.index("[Agent] 第一条回复")

    def test_long_history_is_truncated_with_a_marker(self) -> None:
        history = tuple(
            (MessageRole.HUMAN, f"消息 {index}") for index in range(HISTORY_MESSAGES_MAX + 5)
        )
        prompt = self.prompt(history)
        assert "[历史已截断 5 条]" in prompt
        assert "消息 0" not in prompt
        assert f"消息 {HISTORY_MESSAGES_MAX + 4}" in prompt

    def test_oversized_prompt_keeps_the_tail_and_says_so(self) -> None:
        prompt = self.prompt(((MessageRole.HUMAN, "很长的历史" * 4000),))
        assert len(prompt) < PROMPT_CHARS_MAX + 100
        assert prompt.startswith("[提示词过长，已按上限截断前 ")
        assert prompt.rstrip().endswith("看看测试为什么失败")

    def continuation_prompt(self) -> str:
        return build_turn_prompt(
            project="demo",
            project_path="/srv/demo",
            title="排查构建失败",
            history=((MessageRole.HUMAN, "第一问"), (MessageRole.AGENT, "第一答")),
            instruction="第二问",
            continuation=True,
        )

    def test_continuation_does_not_replay_history(self) -> None:
        prompt = self.continuation_prompt()
        # 上下文在常驻进程手里：再回放一遍会让模型把同一段对话读两次。
        assert "第一问" not in prompt
        assert "第一答" not in prompt
        assert "对话历史" not in prompt
        assert "后续输入" in prompt
        assert prompt.rstrip().endswith("第二问")


class TestStreamInterpretation:
    """增量事件解释：形状来自 206 份真实 PI 轨迹（见 domain 模块注释）。"""

    def test_text_delta_is_the_visible_text(self) -> None:
        payload = {"assistantMessageEvent": {"type": "text_delta", "delta": "你好"}}
        assert text_delta(payload) == "你好"

    def test_thinking_delta_is_not_transcript(self) -> None:
        payload = {"assistantMessageEvent": {"type": "thinking_delta", "delta": "内部思考"}}
        assert text_delta(payload) == ""

    def test_missing_or_odd_shape_yields_nothing(self) -> None:
        assert text_delta({}) == ""
        assert text_delta({"assistantMessageEvent": "不是对象"}) == ""
        assert text_delta({"assistantMessageEvent": {"type": "text_delta", "delta": 42}}) == ""
        assert text_delta({"assistantMessageEvent": {"type": "text_delta"}}) == ""


class TestToolCallInterpretation:
    def start(self, **overrides: object) -> dict:
        payload: dict = {
            "toolCallId": "call-1",
            "toolName": "bash",
            "args": {"command": "ls -la"},
        }
        payload.update(overrides)
        return payload

    def test_start_carries_identity_arguments_and_risk(self) -> None:
        started = tool_call_started(self.start())
        assert started is not None
        assert (started.tool_call_id, started.tool_name) == ("call-1", "bash")
        assert started.risk is ToolRisk.EXECUTE
        assert "ls -la" in started.args_excerpt

    def test_start_rejects_incomplete_events(self) -> None:
        assert tool_call_started(self.start(toolCallId="")) is None
        assert tool_call_started(self.start(toolName="   ")) is None
        assert tool_call_started({}) is None

    def test_string_args_are_kept_and_long_args_truncated(self) -> None:
        assert tool_call_started(self.start(args="原样字符串")).args_excerpt == "原样字符串"  # type: ignore[union-attr]
        long_args = tool_call_started(self.start(args={"command": "x" * 1000}))
        assert long_args is not None
        assert "已截断" in long_args.args_excerpt
        assert len(long_args.args_excerpt) < TOOL_ARG_CHARS_MAX + 40

    def test_unserializable_args_fall_back_to_text(self) -> None:
        class Weird:
            def __repr__(self) -> str:
                return "weird-args"

        started = tool_call_started(self.start(args=Weird()))
        assert started is not None
        assert started.args_excerpt == "weird-args"

    def test_end_carries_result_error_flag_and_duration(self) -> None:
        finished = tool_call_finished(
            {
                "toolCallId": "call-1",
                "toolName": "bash",
                "result": {"content": [{"type": "text", "text": "total 12"}]},
                "isError": False,
                "durationMs": 12,
            }
        )
        assert finished is not None
        assert finished.result_excerpt == "total 12"
        assert finished.is_error is False
        assert finished.duration_ms == 12

    def test_end_result_fallbacks(self) -> None:
        structured = tool_call_finished(
            self.end_payload(result={"structuredContent": {"stdout": "ok"}})
        )
        assert structured is not None
        assert "stdout" in structured.result_excerpt
        details = tool_call_finished(self.end_payload(result={"details": {"exit": 0}}))
        assert details is not None
        assert "exit" in details.result_excerpt
        plain = tool_call_finished(self.end_payload(result="原始文本"))
        assert plain is not None
        assert plain.result_excerpt == "原始文本"
        empty = tool_call_finished(self.end_payload(result=None))
        assert empty is not None
        assert empty.result_excerpt == ""

    def test_end_separates_multiple_text_blocks_and_ignores_others(self) -> None:
        finished = tool_call_finished(
            self.end_payload(
                result={
                    "content": [
                        {"type": "text", "text": "第一段"},
                        {"type": "image", "text": "不该出现"},
                        "不是对象",
                        {"type": "text", "text": "第二段"},
                    ]
                }
            )
        )
        assert finished is not None
        assert finished.result_excerpt == "第一段\n第二段"

    def test_end_error_flag_and_duration_defaults(self) -> None:
        payload = self.end_payload(isError=True)
        payload.pop("durationMs")
        finished = tool_call_finished(payload)
        assert finished is not None
        assert finished.is_error is True
        assert finished.duration_ms == 0
        assert tool_call_finished(self.end_payload(durationMs=True)).duration_ms == 0  # type: ignore[union-attr]
        assert tool_call_finished(self.end_payload(durationMs=7.8)).duration_ms == 7  # type: ignore[union-attr]

    def test_end_rejects_incomplete_events(self) -> None:
        assert tool_call_finished(self.end_payload(toolCallId="")) is None
        assert tool_call_finished({"toolCallId": "c"}) is None
        assert tool_call_finished({}) is None

    def test_long_result_is_capped_and_marked(self) -> None:
        finished = tool_call_finished(
            self.end_payload(result={"content": [{"type": "text", "text": "y" * 5000}]})
        )
        assert finished is not None
        # 解释层就按上限截断：记录里不该出现整份工具输出（几千行日志会淹掉会话）。
        assert len(finished.result_excerpt) < 5000
        assert finished.result_excerpt.startswith("y" * 100)
        assert f"已截断 {5000 - TOOL_RESULT_CHARS_MAX} 字符" in finished.result_excerpt
        # 短内容原样返回：记录层再施加一次上限不会改动它。
        assert excerpt("短结果", TOOL_RESULT_CHARS_MAX) == "短结果"

    def end_payload(self, **overrides: object) -> dict:
        payload: dict = {
            "toolCallId": "call-1",
            "toolName": "bash",
            "result": {"content": [{"type": "text", "text": "ok"}]},
            "isError": False,
            "durationMs": 5,
        }
        payload.update(overrides)
        return payload


class TestToolRiskRules:
    def test_known_tools_map_to_their_risk(self) -> None:
        assert tool_risk("read") is ToolRisk.READ
        assert tool_risk("edit") is ToolRisk.WRITE
        assert tool_risk("bash") is ToolRisk.EXECUTE

    def test_name_matching_ignores_case_and_padding(self) -> None:
        assert tool_risk("  BASH ") is ToolRisk.EXECUTE

    def test_unknown_tool_is_not_assumed_safe(self) -> None:
        assert tool_risk("custom_browser") is ToolRisk.UNKNOWN

    def test_policy_off_never_requires_approval(self) -> None:
        for risk in ToolRisk:
            assert approval_required(risk, ToolApprovalPolicy.OFF) is False

    def test_policy_write_covers_write_execute_and_unknown(self) -> None:
        policy = ToolApprovalPolicy.WRITE
        assert approval_required(ToolRisk.READ, policy) is False
        assert approval_required(ToolRisk.WRITE, policy) is True
        assert approval_required(ToolRisk.EXECUTE, policy) is True
        assert approval_required(ToolRisk.UNKNOWN, policy) is True

    def test_policy_all_covers_every_tool(self) -> None:
        for risk in ToolRisk:
            assert approval_required(risk, ToolApprovalPolicy.ALL) is True

    def test_summary_is_one_line(self) -> None:
        assert tool_call_summary("bash", '{"command": "ls"}') == 'bash：{"command": "ls"}'
        assert tool_call_summary("read", "  ") == "read"


class TestContextEditNotice:
    def test_removal_is_reported_as_removal(self) -> None:
        notice = context_edit_notice(
            {"entry": {"type": "context_edit", "targetId": "abc", "replacement": None}}
        )
        assert "移除" in notice
        assert "abc" in notice
        assert "完整流水" in notice

    def test_replacement_is_reported_as_replacement(self) -> None:
        notice = context_edit_notice(
            {"entry": {"type": "context_edit", "targetId": "abc", "replacement": {"id": "x"}}}
        )
        assert "替换" in notice

    def test_other_entries_and_bad_shapes_yield_nothing(self) -> None:
        assert context_edit_notice({"entry": {"type": "message"}}) == ""
        assert context_edit_notice({"entry": "不是对象"}) == ""
        assert context_edit_notice({}) == ""

    def test_missing_target_is_stated_not_invented(self) -> None:
        notice = context_edit_notice({"entry": {"type": "context_edit"}})
        assert "未知条目" in notice


class TestAgentOutputInterpretation:
    def test_plain_text_is_a_reply(self) -> None:
        reply = interpret_agent_text("已完成：新增了两个测试。")
        assert reply.awaiting_human is False
        assert reply.reply == "已完成：新增了两个测试。"

    def test_marker_requests_a_human_decision(self) -> None:
        reply = interpret_agent_text('{"awaiting_human": true, "question": "是否删除旧接口?"}')
        assert reply.awaiting_human is True
        assert reply.question == "是否删除旧接口?"

    def test_marker_wrapped_in_a_code_block_still_counts(self) -> None:
        text = '我需要确认一下：\n```json\n{"awaiting_human": true, "question": "继续吗?"}\n```'
        reply = interpret_agent_text(text)
        assert reply.awaiting_human is True
        assert reply.question == "继续吗?"

    @pytest.mark.parametrize(
        "text",
        [
            '{"awaiting_human": false, "question": "不用决定"}',
            '{"awaiting_human": true}',
            '{"awaiting_human": true, "question": "   "}',
            "awaiting_human: true",
            "{不是 JSON}",
        ],
    )
    def test_incomplete_or_negative_markers_are_plain_replies(self, text: str) -> None:
        reply = interpret_agent_text(text)
        assert reply.awaiting_human is False
        assert reply.reply == text.strip()

    def test_empty_text_is_reported_as_empty(self) -> None:
        reply = interpret_agent_text("   ")
        assert reply.awaiting_human is False
        assert reply.reply == ""
