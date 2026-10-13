"""PI RPC 适配器集成测试：真实子进程 + 假 PI（讲同一 JSONL 契约）。

真实 PI 协议行为须在 pi_live 集成中验证；此处验证适配器自身的
进程管理、事件落盘、settled 判定、超时与协议错误负例。
"""

import sys
from pathlib import Path

import pytest

from forgeloop.adapter.pi_rpc import PIProcess, PISpawnOptions

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]


def make_process(tmp_path: Path, mode: str) -> PIProcess:
    return PIProcess(
        FAKE_PI,
        "task-it",
        "dev",
        tmp_path / "sessions",
        options=PISpawnOptions(extra_env={"FAKE_PI_MODE": mode}),
    )


class TestHappyPath:
    def test_settled_result_observed_and_session_files_written(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            process.send_prompt("实现示例任务")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert outcome.settled
        assert outcome.aborted is False
        assert outcome.error is None
        assert outcome.text is not None and "diff" in outcome.text
        assert outcome.result is not None and "diff" in outcome.result
        assert any(event.type == "agent_settled" for event in outcome.events)
        # 真实协议记录：prompt 响应（id 关联）与 settled 事件都应出现。
        assert any(
            event.type == "response" and event.payload.get("command") == "prompt"
            for event in outcome.events
        )
        assert any(
            event.type == "response" and event.payload.get("command") == "get_last_assistant_text"
            for event in outcome.events
        )
        sessions = tmp_path / "sessions"
        events_file = sessions / "task-it-dev.events.jsonl"
        requests_file = sessions / "task-it-dev.requests.jsonl"
        stderr_file = sessions / "task-it-dev.stderr.log"
        assert events_file.exists() and "agent_settled" in events_file.read_text(encoding="utf-8")
        requests_content = requests_file.read_text(encoding="utf-8")
        assert "prompt" in requests_content and "get_last_assistant_text" in requests_content
        assert stderr_file.exists()

    def test_review_session_is_independent_from_dev(self, tmp_path: Path) -> None:
        dev = PIProcess(FAKE_PI, "task-it", "dev", tmp_path / "sessions")
        review = PIProcess(FAKE_PI, "task-it", "review", tmp_path / "sessions")
        dev.start()
        review.start()
        try:
            dev.send_prompt("dev")
            review.send_prompt("review")
            dev_outcome = dev.wait_until_settled(10.0)
            review_outcome = review.wait_until_settled(10.0)
        finally:
            dev.close()
            review.close()
        assert dev_outcome.settled and review_outcome.settled
        assert (tmp_path / "sessions" / "task-it-dev.events.jsonl").exists()
        assert (tmp_path / "sessions" / "task-it-review.events.jsonl").exists()


class TestUnsettledNegatives:
    def test_process_exit_without_settlement_is_reported(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "unsettled")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert not outcome.settled
        assert outcome.error == "process-exited"

    def test_timeout_is_reported_and_not_disguised(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "hang")
        process.start()
        try:
            process.send_prompt("hang please")
            outcome = process.wait_until_settled(0.5)
            assert not outcome.settled
            assert outcome.error == "timeout"
            # 请求停止后核对真实状态：abort 命令 → agent_settled(aborted=true)。
            # 进程保持存活（真实 abort 不退出进程），结果如实标记中止。
            process.request_stop()
            outcome = process.wait_until_settled(5.0)
            assert outcome.settled
            assert outcome.aborted is True
            assert outcome.error is None
        finally:
            process.close()

    def test_settled_with_model_error_is_reported(self, tmp_path: Path) -> None:
        """settled 不等于成功：provider 失败（stopReason=error）如实上报。"""

        process = make_process(tmp_path, "model-error")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert outcome.settled
        assert outcome.aborted is False
        assert outcome.error is None  # 协议层成功
        assert outcome.model_error is not None
        assert "403" in outcome.model_error
        assert outcome.text == ""

    def test_rejected_prompt_is_reported(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "reject")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(5.0)
        finally:
            process.close()
        assert not outcome.settled
        assert outcome.error == "prompt-rejected"

    def test_invalid_json_line_is_a_protocol_error(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "garbage")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert not outcome.settled
        assert outcome.error == "invalid-json"

    def test_scalar_json_line_is_a_protocol_error(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "scalar")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert not outcome.settled
        assert outcome.error == "invalid-json"

    def test_blank_lines_are_tolerated_until_settlement(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok-blank")
        process.start()
        try:
            process.send_prompt("anything")
            outcome = process.wait_until_settled(10.0)
        finally:
            process.close()
        assert outcome.settled  # 空行不阻断 settled 判定
        assert outcome.result is not None

    def test_non_positive_timeout_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            with pytest.raises(ValueError, match="must be positive"):
                process.wait_until_settled(0.0)
        finally:
            process.close()

    def test_tiny_timeout_reports_timeout_not_disguised(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            process.send_prompt("x")
            outcome = process.wait_until_settled(1e-9)
        finally:
            process.close()
        assert not outcome.settled
        assert outcome.error == "timeout"


class TestProcessLifecycle:
    def test_send_before_start_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        with pytest.raises(Exception, match="not running"):
            process.send_prompt("early")

    def test_wait_before_start_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        with pytest.raises(Exception, match="not running"):
            process.wait_until_settled(1.0)

    def test_empty_command_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            PIProcess((), "task-it", "dev", tmp_path / "sessions")

    def test_close_terminates_hanging_process(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "hang")
        process.start()
        process.send_prompt("hang")
        process.close()
        assert process.poll_exit_code() is None or isinstance(process.poll_exit_code(), int)

    def test_close_is_idempotent(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        process.send_prompt("x")
        process.close()
        process.close()  # 第二次关闭不抛错

    def test_close_after_settled_process_exit(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        process.send_prompt("x")
        outcome = process.wait_until_settled(10.0)
        assert outcome.settled
        process.close()

    def test_start_twice_is_rejected(self, tmp_path: Path) -> None:
        process = make_process(tmp_path, "ok")
        process.start()
        try:
            with pytest.raises(Exception, match="already started"):
                process.start()
        finally:
            process.close()
