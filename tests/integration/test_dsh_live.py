"""dsh_live 集成测试：真实 dsh 二进制 + 真实模型 + 真实 ``--json`` 事件流。

显式选择加入：环境变量 ``FORGELOOP_DSH_LIVE=1``（``make dsh-live``）。

运行前提（本机一次性准备，凭据不进入仓库与报告）：

- ``FORGELOOP_DSH_HOME``：可写的 DSH_HOME（headless 默认禁用已保存凭据，
  需要按官方 README 用 ``--patch`` 覆盖启用 credentials 与 authorization；
  该覆盖可以写在 ``FORGELOOP_DSH_COMMAND`` 里）。
- ``FORGELOOP_DSH_COMMAND``：完整启动命令（JSON 数组），缺省
  ``["dsh", "--profile", "headless", "--json"]``；典型值包含
  ``--patch <overlay.yml>``，顺序必须是启动器参数在应用参数之前。

真实调用产生模型费用与耗时；每个用例只发一条极小提示词。
"""

import json
import os
import shutil
from pathlib import Path

import pytest

from forgeloop.adapter.agent_runtime import AgentSpawnOptions
from forgeloop.adapter.dsh_headless import DSHProcess

pytestmark = [
    pytest.mark.dsh_live,
    pytest.mark.timeout(180),
    pytest.mark.skipif(
        shutil.which("dsh") is None or os.environ.get("FORGELOOP_DSH_LIVE") != "1",
        reason="requires the dsh binary and FORGELOOP_DSH_LIVE=1 (real model cost)",
    ),
]

DEFAULT_COMMAND = ["dsh", "--profile", "headless", "--json"]


def dsh_command() -> list[str]:
    raw = os.environ.get("FORGELOOP_DSH_COMMAND", "")
    return list(json.loads(raw)) if raw.strip() else list(DEFAULT_COMMAND)


def dsh_env() -> dict[str, str]:
    home = os.environ.get("FORGELOOP_DSH_HOME", "")
    return {"DSH_HOME": home} if home else {}


def run_once(workspace: Path, session_dir: Path, role: str, prompt: str):
    process = DSHProcess(
        dsh_command(),
        f"task-{role}",
        role,
        session_dir,
        AgentSpawnOptions(cwd=workspace, extra_env=dsh_env(), runtime="dsh"),
    )
    process.start()
    try:
        process.send_prompt(prompt)
        return process.wait_until_settled(120.0)
    finally:
        process.close()


class TestRealDshRun:
    def test_structured_answer_through_real_event_stream(self, tmp_path: Path) -> None:
        """真实模型返回 JSON 时：settled、结构化载荷、会话身份与命令都落盘。"""

        workspace = tmp_path / "work"
        workspace.mkdir()
        result = run_once(
            workspace,
            tmp_path / "sessions",
            "dev",
            'Reply with exactly this JSON object and nothing else: {"ok": true, "runtime": "dsh"}',
        )

        assert result.settled is True, result.error or result.model_error
        assert result.error is None
        assert result.model_error is None
        parsed = result.result or {}
        assert parsed.get("ok") is True
        assert parsed.get("runtime") == "dsh"
        assert result.session_id.startswith("session-")
        assert any(event.type == "final" for event in result.events)
        assert result.command == tuple(dsh_command())

        requests = (tmp_path / "sessions" / "task-dev-dev.requests.jsonl").read_text(
            encoding="utf-8"
        )
        record = json.loads(requests.splitlines()[0])
        assert record["agent_runtime"] == "dsh"
        assert record["command"] == dsh_command()

    def test_real_tools_edit_the_workspace(self, tmp_path: Path) -> None:
        """真实工具调用：模型在指定工作目录内创建文件（适配器只提供 cwd 与提示词）。"""

        workspace = tmp_path / "workspace"
        workspace.mkdir()
        result = run_once(
            workspace,
            tmp_path / "sessions",
            "dev-edit",
            "In the current working directory, create a file named dsh-live.txt whose entire "
            "content is exactly: hello-from-dsh\n"
            'Then reply with exactly {"done": true} and nothing else.',
        )

        assert result.settled is True, result.error or result.model_error
        assert result.error is None
        target = workspace / "dsh-live.txt"
        assert target.is_file(), sorted(path.name for path in workspace.iterdir())
        assert target.read_text(encoding="utf-8").strip() == "hello-from-dsh"
