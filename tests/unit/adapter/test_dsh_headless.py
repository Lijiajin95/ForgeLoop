"""DSH headless 适配器：事件流分类与真实子进程会话的行为测试。

分类规则是 fail-closed 的判定核心（未取得结果绝不冒充成功），因此先用纯函数
逐条覆盖，再用真实假 dsh 子进程验证进程边界（提示词进 stdin、事件与请求落盘、
超时终止、退出码与终态原因的组合）。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.adapter.agent_runtime import AgentEvent, AgentSpawnOptions
from forgeloop.adapter.dsh_headless import DSHProcess, classify_run

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
FAKE_DSH = [sys.executable, str(FIXTURES / "fake_dsh.py")]


def event(payload: dict) -> AgentEvent:
    return AgentEvent(
        type=str(payload.get("type", "")), payload=payload, received_at=datetime.now(UTC)
    )


def completed(text: str = '{"summary": "ok"}') -> list[AgentEvent]:
    return [
        event({"type": "session", "sessionId": "session-1"}),
        event({"type": "status", "phase": "turn_end", "reason": {"kind": "completed"}}),
        event({"type": "final", "text": text}),
    ]


class TestClassifyRun:
    def test_completed_with_final_is_settled(self) -> None:
        outcome = classify_run(completed(), 0)
        assert outcome.settled is True
        assert outcome.aborted is False
        assert outcome.text == '{"summary": "ok"}'
        assert outcome.error is None
        assert outcome.model_error is None
        assert outcome.session_id == "session-1"
        assert outcome.turn_reason == "completed"

    def test_completed_without_final_is_not_a_result(self) -> None:
        outcome = classify_run(
            [event({"type": "status", "phase": "turn_end", "reason": {"kind": "completed"}})], 0
        )
        assert outcome.settled is False
        assert outcome.error == "final-missing"

    def test_aborted_is_settled_and_flagged(self) -> None:
        outcome = classify_run(
            [
                event({"type": "status", "phase": "turn_end", "reason": {"kind": "aborted"}}),
                event({"type": "final", "text": ""}),
            ],
            1,
        )
        assert outcome.settled is True
        assert outcome.aborted is True
        assert outcome.error is None

    def test_provider_error_is_model_error_not_success(self) -> None:
        outcome = classify_run(
            [
                event(
                    {
                        "type": "status",
                        "phase": "turn_end",
                        "reason": {
                            "kind": "error",
                            "error": {"code": "PROVIDER_ERROR", "message": "403 subscription"},
                        },
                    }
                ),
                event({"type": "final", "text": ""}),
            ],
            1,
        )
        assert outcome.settled is True
        assert outcome.model_error == "PROVIDER_ERROR: 403 subscription"
        assert outcome.error is None

    def test_provider_error_without_fields_falls_back(self) -> None:
        outcome = classify_run(
            [
                event({"type": "status", "phase": "turn_end", "reason": {"kind": "error"}}),
                event({"type": "final", "text": ""}),
            ],
            1,
        )
        assert outcome.model_error == "model error"

    def test_blocked_turn_is_unsettled_with_reason(self) -> None:
        outcome = classify_run(
            [
                event({"type": "status", "phase": "turn_end", "reason": {"kind": "blocked"}}),
                event({"type": "final", "text": ""}),
            ],
            1,
        )
        assert outcome.settled is False
        assert outcome.error == "turn-blocked"

    def test_unknown_terminal_kind_is_unsettled(self) -> None:
        outcome = classify_run(
            [event({"type": "status", "phase": "turn_end", "reason": {"kind": "forked"}})], 1
        )
        assert outcome.settled is False
        assert outcome.error == "turn-forked"

    def test_runtime_error_event_wins(self) -> None:
        outcome = classify_run(
            [
                event({"type": "session", "sessionId": "session-2"}),
                event({"type": "error", "message": "profile failed to load"}),
            ],
            1,
        )
        assert outcome.settled is False
        assert outcome.error == "runtime-error: profile failed to load"
        assert outcome.session_id == "session-2"

    def test_final_without_turn_end_exit_zero_counts_as_completed(self) -> None:
        outcome = classify_run([event({"type": "final", "text": "hi"})], 0)
        assert outcome.settled is True
        assert outcome.text == "hi"

    def test_missing_final_exit_zero_is_reported(self) -> None:
        outcome = classify_run([event({"type": "session", "sessionId": "s"})], 0)
        assert outcome.settled is False
        assert outcome.error == "final-missing"

    def test_nonzero_exit_without_terminal_is_reported(self) -> None:
        outcome = classify_run([], 3)
        assert outcome.settled is False
        assert outcome.error == "process-exited:3"

    def test_invalid_stream_is_reported(self) -> None:
        outcome = classify_run(completed(), 0, invalid_stream=True)
        assert outcome.settled is False
        assert outcome.error == "invalid-json"

    def test_timeout_is_reported(self) -> None:
        outcome = classify_run(completed(), None, timed_out=True)
        assert outcome.settled is False
        assert outcome.error == "timeout"


def make_process(tmp_path: Path, mode: str, *, cwd: Path | None = None) -> DSHProcess:
    return DSHProcess(
        FAKE_DSH,
        "task-dsh",
        "dev",
        tmp_path / "sessions",
        AgentSpawnOptions(cwd=cwd or tmp_path, extra_env={"FAKE_DSH_MODE": mode}, runtime="dsh"),
    )


class TestDSHProcess:
    def test_completed_run_yields_structured_result(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            process.send_prompt(json.dumps({"goal": "g", "workspace": str(tmp_path)}))
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is True
        assert result.error is None
        assert result.runtime == "dsh"
        assert result.session_id.startswith("session-fake-")
        assert result.command == tuple(FAKE_DSH)
        assert result.result is not None
        assert result.result["summary"] == "implemented and self-verified"

    def test_session_files_are_written_with_runtime_identity(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            process.send_prompt("prompt-body")
            process.wait_until_settled(10.0)
        finally:
            process.close()
        sessions = tmp_path / "sessions"
        events = (sessions / "task-dsh-dev.events.jsonl").read_text(encoding="utf-8")
        requests = (sessions / "task-dsh-dev.requests.jsonl").read_text(encoding="utf-8")
        assert '"type": "final"' in events
        request_record = json.loads(requests.splitlines()[0])
        assert request_record["agent_runtime"] == "dsh"
        assert request_record["prompt"] == "prompt-body"
        assert request_record["command"] == list(FAKE_DSH)
        assert (sessions / "task-dsh-dev.stderr.log").exists()

    def test_review_role_result(self, tmp_path: Path) -> None:
        process = DSHProcess(
            FAKE_DSH,
            "task-review",
            "review",
            tmp_path / "sessions",
            AgentSpawnOptions(extra_env={"FAKE_DSH_MODE": "ok"}, runtime="dsh"),
        )
        process.start()
        try:
            process.send_prompt(json.dumps({"role": "review", "candidate_diff": ""}))
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.result == {"summary": "review passed", "blocking_issues": []}

    def test_model_error_is_reported_as_model_error(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "model-error")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is True
        assert result.model_error and "PROVIDER_ERROR" in result.model_error

    def test_runtime_error_event_is_not_settled(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "error-event")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is False
        assert result.error and result.error.startswith("runtime-error:")

    def test_missing_final_is_not_settled(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "no-final")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is False
        assert result.error == "final-missing"

    def test_invalid_json_line_is_not_settled(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "garbage")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is False
        assert result.error == "invalid-json"

    def test_plain_text_final_has_no_structured_result(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "plain-text")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is True
        assert result.result is None
        assert result.text

    def test_timeout_is_reported_and_process_is_killed(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "hang")
        process.start()
        try:
            process.send_prompt("x")
            result = process.wait_until_settled(0.5)
            assert result.settled is False
            assert result.error == "timeout"
        finally:
            process.close()
        assert process.last_exit_code is not None

    def test_dev_edit_mode_writes_workspace(self, tmp_path: Path) -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        process = make_process(tmp_path, "edit", cwd=workspace)
        process.start()
        try:
            process.send_prompt(json.dumps({"workspace": str(workspace)}))
            result = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert result.settled is True
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "new"

    def test_empty_command_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            DSHProcess([], "t", "dev", tmp_path)

    def test_prompt_before_start_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        with pytest.raises(Exception, match="not running"):
            process.send_prompt("x")
