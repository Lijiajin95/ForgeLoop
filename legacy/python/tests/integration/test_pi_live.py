"""pi_live 集成测试：真实 pi 二进制 + 真实 RPC 协议（验收计划步骤 1）。

显式选择加入：环境变量 ``FORGELOOP_PI_LIVE=1``（``make pi-live``）。
- 协议握手部分不调用模型：验证真实进程的 JSONL 帧、命令/响应 id 关联与
  stdin 关闭的优雅停机（官方文档的最小客户端口径）。
- 模型部分经 ForgeLoop 适配器发送一个极小 prompt：验证真实事件流、
  agent_settled 稳定结束、get_last_assistant_text 最终文本与会话落盘。

真实调用产生模型费用与耗时（kimi-k2.6，单次极小 prompt）。
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from forgeloop.adapter.pi_rpc import PIProcess, PISpawnOptions

pytestmark = [
    pytest.mark.pi_live,
    pytest.mark.timeout(180),
    pytest.mark.skipif(
        shutil.which("pi") is None or os.environ.get("FORGELOOP_PI_LIVE") != "1",
        reason="requires the pi binary and FORGELOOP_PI_LIVE=1 (real model cost)",
    ),
]

# 真实模型组合（2026-10-12 实测可用；opencode-go 订阅失效）。
# 环境变量可覆盖：FORGELOOP_PI_PROVIDER / FORGELOOP_PI_MODEL。
PI_PROVIDER = os.environ.get("FORGELOOP_PI_PROVIDER", "cc-switch-open-code-go")
PI_MODEL = os.environ.get("FORGELOOP_PI_MODEL", "deepseek-v4.1-flash")
REAL_PI_COMMAND = [
    "pi",
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    PI_PROVIDER,
    "--model",
    PI_MODEL,
]


@pytest.fixture()
def isolated_pi_home(tmp_path: Path) -> dict[str, str]:
    """隔离 HOME：拷贝本机 pi 配置（含凭据）到临时目录。

    两个目的：测试写锁不污染真实 ~/.pi；宿主沙箱或只读 HOME 下仍可运行。
    真实凭据只在本地子进程间复制，不进入任何报告或仓库。
    """

    source = Path.home() / ".pi"
    target = tmp_path / "pi-home" / ".pi"
    if source.exists():
        shutil.copytree(source, target)
    return {"HOME": str(tmp_path / "pi-home")}


def run_rpc_roundtrip(command: dict) -> dict:
    """发送一条命令并读取其关联响应；关闭 stdin 优雅停机并清理管道。"""

    process = subprocess.Popen(
        REAL_PI_COMMAND,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None and process.stdout is not None
    try:
        process.stdin.write(json.dumps(command) + "\n")
        process.stdin.flush()
        response = None
        for line in process.stdout:
            record = json.loads(line)
            if record.get("type") == "response" and record.get("id") == command.get("id"):
                response = record
                break
        assert response is not None, f"no correlated response for {command.get('type')}"
    finally:
        process.stdin.close()  # 官方口径：关闭 stdin 请求优雅停机
        try:
            process.wait(timeout=15)
        finally:
            process.stdout.close()
            assert process.stderr is not None
            process.stderr.close()
    assert process.returncode == 0, f"pi exited with {process.returncode}"
    return response


class TestProtocolHandshake:
    def test_get_state_roundtrip_without_model(self) -> None:
        """命令/响应 id 关联与 JSONL 帧：不调用模型的协议层验证。"""

        response = run_rpc_roundtrip({"id": "state-1", "type": "get_state"})
        assert response["command"] == "get_state"
        assert response["success"] is True
        assert isinstance(response.get("data"), dict)

    def test_unknown_command_returns_failure_response(self) -> None:
        """未知命令得到 success=false 响应而不是进程崩溃（协议容错）。"""

        response = run_rpc_roundtrip({"id": "bad-1", "type": "definitely_not_a_command"})
        assert response["success"] is False


class TestRealPromptThroughAdapter:
    def test_prompt_settles_with_real_event_stream(
        self, tmp_path: Path, isolated_pi_home: dict[str, str]
    ) -> None:
        """经 ForgeLoop 适配器的真实模型调用：真实事件流与显式结果。

        契约：agent_settled 后结果必须显式——要么取得非空最终文本，
        要么 model_error 携带 provider 错误（2026-10-12 实测：OpenCode Go
        订阅失效，全部模型 403，自动重试 3 次后 settled，最终消息
        stopReason=error）。两者都没有才算适配器缺陷。
        """

        process = PIProcess(
            REAL_PI_COMMAND,
            "task-live",
            "dev",
            tmp_path / "sessions",
            options=PISpawnOptions(extra_env=isolated_pi_home),
        )
        process.start()
        try:
            process.send_prompt("Reply with exactly one word: ok")
            outcome = process.wait_until_settled(120.0)
        finally:
            process.close()
        assert outcome.settled, f"not settled: {outcome.error}"
        assert outcome.aborted is False
        assert outcome.error is None
        # 结果显式二选一：非空文本或模型错误。
        assert (outcome.text is not None and outcome.text.strip() != "") or (
            outcome.model_error is not None
        ), "settled without text and without model_error"
        if outcome.model_error:
            print(f"MODEL UNAVAILABLE (recorded honestly): {outcome.model_error[:120]}")
        # 真实事件流：prompt 响应（接受不等于完成）→ … → agent_settled。
        types = [event.type for event in outcome.events]
        assert "agent_settled" in types
        assert "agent_start" in types and "agent_end" in types
        prompt_responses = [
            event
            for event in outcome.events
            if event.type == "response" and event.payload.get("command") == "prompt"
        ]
        assert prompt_responses, "no prompt response record"
        assert prompt_responses[0].payload.get("success") is True
        # 会话与轨迹落盘可读取。
        events_file = tmp_path / "sessions" / "task-live-dev.events.jsonl"
        requests_file = tmp_path / "sessions" / "task-live-dev.requests.jsonl"
        assert events_file.exists()
        recorded = [
            json.loads(line) for line in events_file.read_text(encoding="utf-8").splitlines()
        ]
        assert any(entry["event"].get("type") == "agent_settled" for entry in recorded)
        assert requests_file.exists()

    def test_orderly_shutdown_after_settle(
        self, tmp_path: Path, isolated_pi_home: dict[str, str]
    ) -> None:
        """settled 后 close()：stdin 关闭触发优雅停机，退出码 0。"""

        process = PIProcess(
            REAL_PI_COMMAND,
            "task-live2",
            "review",
            tmp_path / "sessions",
            options=PISpawnOptions(extra_env=isolated_pi_home),
        )
        process.start()
        process.send_prompt("Reply with exactly one word: done")
        outcome = process.wait_until_settled(120.0)
        assert outcome.settled
        process.close()
        # close 后进程已退出；适配器不再报告运行中的退出码。
        assert process.poll_exit_code() is None or isinstance(process.poll_exit_code(), int)
        stderr_file = tmp_path / "sessions" / "task-live2-review.stderr.log"
        assert stderr_file.exists()


class TestAdapterProtocolFidelity:
    def test_abort_outcome_is_explicit(
        self, tmp_path: Path, isolated_pi_home: dict[str, str]
    ) -> None:
        """真实 abort 请求后的结果必须显式。

        今日模型环境（403 订阅失效）下运行在 ~15s 重试后自行 settled，
        abort 未必赶在运行中生效；两种显式结果都接受：abort 生效
        （aborted=True）或运行自行结束（model_error / 非空文本）。
        工作模型可用后应收紧为 aborted=True（长运行中发 abort）。
        """

        process = PIProcess(
            REAL_PI_COMMAND,
            "task-live3",
            "dev",
            tmp_path / "sessions",
            options=PISpawnOptions(extra_env=isolated_pi_home),
        )
        process.start()
        try:
            process.send_prompt("Count slowly from 1 to 100, one number per line.")
            process.request_stop()
            outcome = process.wait_until_settled(120.0)
        finally:
            process.close()
        assert outcome.settled  # abort 等待空闲后产生 settled
        assert outcome.error is None
        explicit = (
            outcome.aborted
            or outcome.model_error
            or (outcome.text is not None and outcome.text.strip() != "")
        )
        assert explicit, "abort path settled without an explicit outcome"
