"""PI 适配器结果解释的单元测试：模型错误追踪与最终文本提取。

对应实测发现：settled 不等于成功（provider 重试耗尽后 stopReason=error）。
"""

from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.pi_rpc import (
    LAST_TEXT_COMMAND,
    PIEvent,
    PIProcess,
)


def event(payload: dict) -> PIEvent:
    return PIEvent(
        type=str(payload.get("type", "")), payload=payload, received_at=datetime.now(UTC)
    )


def make_process(tmp_path: Path) -> PIProcess:
    return PIProcess(("echo",), "task-unit", "dev", tmp_path / "sessions")


class TestTrackModelError:
    def test_final_assistant_error_is_recorded(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._track_model_error(
            event(
                {
                    "type": "agent_end",
                    "messages": [
                        {"role": "user", "content": "hi"},
                        {
                            "role": "assistant",
                            "content": [],
                            "stopReason": "error",
                            "errorMessage": "403: subscription",
                        },
                    ],
                }
            )
        )
        assert process._model_error == "403: subscription"

    def test_successful_run_clears_error(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._model_error = "previous failure"
        process._track_model_error(
            event(
                {
                    "type": "agent_end",
                    "messages": [{"role": "assistant", "content": [], "stopReason": "stop"}],
                }
            )
        )
        assert process._model_error is None

    def test_non_list_messages_is_ignored(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._track_model_error(event({"type": "agent_end", "messages": "not-a-list"}))
        assert process._model_error is None

    def test_non_mapping_message_is_ignored(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._track_model_error(event({"type": "agent_end", "messages": [42]}))
        assert process._model_error is None

    def test_non_assistant_messages_are_skipped(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._track_model_error(
            event(
                {
                    "type": "agent_end",
                    "messages": [{"role": "user", "content": "only user"}],
                }
            )
        )
        assert process._model_error is None

    def test_error_without_message_string_falls_back(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._track_model_error(
            event(
                {
                    "type": "agent_end",
                    "messages": [{"role": "assistant", "stopReason": "error", "errorMessage": 403}],
                }
            )
        )
        assert process._model_error == "model error"


class TestExtractText:
    def test_matching_response_yields_text(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-2",
                    "command": LAST_TEXT_COMMAND,
                    "success": True,
                    "data": {"text": "ok"},
                }
            )
        )
        assert text == "ok"

    def test_id_mismatch_returns_none(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-9",
                    "command": LAST_TEXT_COMMAND,
                    "success": True,
                    "data": {"text": "ok"},
                }
            )
        )
        assert text is None

    def test_other_command_returns_none(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-2",
                    "command": "get_state",
                    "success": True,
                    "data": {},
                }
            )
        )
        assert text is None

    def test_failed_response_returns_empty_string(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {"type": "response", "id": "req-2", "command": LAST_TEXT_COMMAND, "success": False}
            )
        )
        assert text == ""

    def test_data_string_is_accepted(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-2",
                    "command": LAST_TEXT_COMMAND,
                    "success": True,
                    "data": "raw text",
                }
            )
        )
        assert text == "raw text"

    def test_data_without_text_returns_empty(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        process._text_request_id = "req-2"
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-2",
                    "command": LAST_TEXT_COMMAND,
                    "success": True,
                    "data": {"unexpected": 1},
                }
            )
        )
        assert text == ""

    def test_without_pending_request_returns_none(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        assert process._text_request_id is None
        text = process._extract_text(
            event(
                {
                    "type": "response",
                    "id": "req-2",
                    "command": LAST_TEXT_COMMAND,
                    "success": True,
                    "data": {"text": "ok"},
                }
            )
        )
        assert text is None


class TestParseEvent:
    def test_blank_line_is_tolerated(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        parsed = process._parse_event("")
        assert parsed is not None and parsed.type == ""

    def test_non_object_json_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path)
        assert process._parse_event("42") is None
        assert process._parse_event("not-json") is None
