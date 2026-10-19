"""面板系统测试：以真实子进程运行 ``forgeloop serve``，核对启动前提与全流程。

R1-R4 已经验证常驻载体本身；这里只回答面板新增的两个问题：① 面板项目档案与 ``[panel]``
配置在真实启动路径上按失败关闭（坏档案、同名冲突、坏 PI HOME、坏数值一律拒绝启动）；
② 在真实进程里，一条人工消息确实驱动一轮真实子进程并把结果落进同一份记录，终止后进程
仍能优雅停止（退出码 0）。
"""

import contextlib
import http.client
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit

import pytest

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
FIXTURES = ROOT / "tests" / "fixtures"
FAKE_PI = (sys.executable, str(FIXTURES / "fake_pi.py"))
STARTUP_LINE = re.compile(r"状态页: (http://[^\s]+)")
STARTUP_TIMEOUT_SECONDS = 20
STOP_TIMEOUT_SECONDS = 20
WAIT_SECONDS = 30.0


def cli_env(mode: str = "chat") -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    env["FAKE_PI_MODE"] = mode
    return env


def workspace(tmp_path: Path) -> dict[str, Path]:
    """一份可用的最小现场：项目目录、隔离 PI HOME、两份配置与记录根。"""

    project = tmp_path / "demo-repo"
    project.mkdir()
    (project / ".git").mkdir()
    pi_home = tmp_path / "pi-home"
    (pi_home / ".pi" / "agent").mkdir(parents=True)
    (pi_home / ".pi" / "agent" / "models.json").write_text('{"providers": {}}', encoding="utf-8")
    projects_file = tmp_path / "projects.toml"
    projects_file.write_text(
        "schema_version = 1\n\n"
        '[projects."demo"]\n'
        f'path = "{project}"\n'
        'description = "系统测试项目"\n'
        f"pi_command = {json.dumps(list(FAKE_PI))}\n"
        f'pi_home = "{pi_home}"\n',
        encoding="utf-8",
    )
    service_config = tmp_path / "service.toml"
    service_config.write_text(
        "schema_version = 1\n"
        'host = "127.0.0.1"\n'
        "port = 0\n"
        "poll_seconds = 2\n"
        "max_concurrent = 2\n"
        "auto_advance = false\n\n"
        "[panel]\n"
        "concurrency = 2\n"
        "turn_timeout_seconds = 60\n",
        encoding="utf-8",
    )
    return {
        "project": project,
        "pi_home": pi_home,
        "projects_file": projects_file,
        "service_config": service_config,
        "records": tmp_path / "records",
    }


def serve_argv(files: dict[str, Path], *extra: str) -> list[str]:
    return [
        sys.executable,
        "-m",
        "forgeloop",
        "serve",
        "--service-config",
        str(files["service_config"]),
        "--projects-file",
        str(files["projects_file"]),
        "--records-root",
        str(files["records"]),
        *extra,
    ]


def wait_for_startup(process: subprocess.Popen[str]) -> str:
    assert process.stdout is not None
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    seen: list[str] = []
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if not line:
            if process.poll() is not None:
                break
            continue
        seen.append(line)
        match = STARTUP_LINE.search(line)
        if match:
            return match.group(1)
    raise AssertionError(f"未在 {STARTUP_TIMEOUT_SECONDS}s 内看到启动输出: {''.join(seen)!r}")


@contextlib.contextmanager
def running_serve(
    files: dict[str, Path], mode: str = "chat"
) -> Iterator[tuple[subprocess.Popen[str], str]]:
    process = subprocess.Popen(
        serve_argv(files),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=cli_env(mode),
    )
    try:
        base = wait_for_startup(process)
        yield process, base.rstrip("/")
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=STOP_TIMEOUT_SECONDS)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


def request(
    base: str, method: str, path: str, body: dict | None = None, token: str = ""
) -> tuple[int, dict]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    http_request = urllib.request.Request(base + path, data=payload, method=method)
    http_request.add_header("Content-Type", "application/json")
    http_request.add_header("Origin", base)
    if token:
        http_request.add_header("X-Forgeloop-Token", token)
    try:
        with urllib.request.urlopen(http_request, timeout=20) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def page_token(base: str) -> str:
    with urllib.request.urlopen(base + "/", timeout=10) as response:
        html = response.read().decode("utf-8")
    match = re.search(r'name="forgeloop-token" content="([^"]+)"', html)
    assert match is not None
    return match.group(1)


def wait_until(predicate, *, what: str) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError(f"等待超时: {what}")


class TestPanelProcess:
    def test_full_flow_in_a_real_process(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        with running_serve(files) as (process, base):
            token = page_token(base)
            status, document = request(base, "GET", "/api/panel")
            assert status == 200
            project = document["projects"][0]
            assert project["name"] == "demo"
            assert project["source"] == "panel"
            assert project["problems"] == []
            assert project["runtime"]["ready"] is True

            status, created = request(
                base,
                "POST",
                "/api/panel/sessions",
                {"by": "owner", "project": "demo", "title": "系统测试会话"},
                token,
            )
            assert status == 201
            session_id = created["session_id"]

            status, accepted = request(
                base,
                "POST",
                f"/api/panel/sessions/{session_id}/messages",
                {"by": "owner", "text": "看一下仓库状态"},
                token,
            )
            assert status == 202
            assert accepted["queued"] is False

            def replied() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}")
                return len(detail["messages"]) >= 2

            wait_until(replied, what="Agent 回复出现")
            _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}")
            assert detail["session"]["status"] == "active"
            assert "假 PI" in detail["messages"][1]["content"]

            status, terminated = request(
                base,
                "POST",
                f"/api/panel/sessions/{session_id}/terminate",
                {"by": "owner", "reason": "系统测试收尾"},
                token,
            )
            assert status == 200
            assert terminated["terminated"] is True

            # 记录落盘在真实记录根里（同一份 records.sqlite，不是第二份状态）。
            assert (files["records"] / "records.sqlite").is_file()
            assert (files["records"] / "panel" / session_id).is_dir()

        assert process.returncode == 0

    def test_hitl_flow_in_a_real_process(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        with running_serve(files, mode="chat-hitl") as (_, base):
            token = page_token(base)
            _, created = request(
                base,
                "POST",
                "/api/panel/sessions",
                {"by": "owner", "project": "demo", "title": "HITL 会话"},
                token,
            )
            session_id = created["session_id"]
            request(
                base,
                "POST",
                f"/api/panel/sessions/{session_id}/messages",
                {"by": "owner", "text": "这一步需要你决定"},
                token,
            )

            def pending() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}")
                return detail["session"]["pending_decisions"] == 1

            wait_until(pending, what="待人工决定出现")
            _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}")
            assert detail["session"]["status"] == "awaiting_human"
            decision_id = detail["decisions"][-1]["decision_id"]

            status, decided = request(
                base,
                "POST",
                f"/api/panel/sessions/{session_id}/decisions/{decision_id}",
                {"by": "owner", "decision": "reject", "reason": "这一步不做"},
                token,
            )
            assert status == 200
            assert decided["session_status"] == "terminated"
            _, after = request(base, "GET", f"/api/panel/sessions/{session_id}")
            assert after["session"]["status"] == "terminated"


class TestPanelStreamingToolsAndContext:
    """真实进程下的四项能力：流式增长、工具留痕与审批、多轮常驻进程、压缩可见。"""

    def test_streaming_grows_then_finalizes(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        env = cli_env("panel-stream")
        env["FAKE_PI_CHUNK_DELAY_MS"] = "300"
        process = subprocess.Popen(
            serve_argv(files),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            base = wait_for_startup(process).rstrip("/")
            token = page_token(base)
            status, created = request(
                base,
                "POST",
                "/api/panel/sessions",
                {"project": "demo", "title": "流式会话", "by": "owner"},
                token,
            )
            assert status == 201
            session_id = str(created["session_id"])
            assert (
                request(
                    base,
                    "POST",
                    f"/api/panel/sessions/{session_id}/messages",
                    {"text": "开始", "by": "owner"},
                    token,
                )[0]
                == 202
            )

            # 整轮没结束：详情里已经有一条 streaming 消息，并且长度在增长。
            lengths: list[int] = []

            def grows() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
                streaming = [
                    item for item in detail["messages"] if str(item["state"]) == "streaming"
                ]
                if not streaming:
                    return False
                lengths.append(len(str(streaming[0]["content"])))
                return len(lengths) >= 2 and lengths[-1] > lengths[0]

            wait_until(grows, what="流式内容增长")

            def settled() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
                return detail["session"]["running"] is False

            wait_until(settled, what="这一轮结束")
            _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
            agent = [item for item in detail["messages"] if item["role"] == "agent"]
            assert str(agent[-1]["state"]) == "ok"
            assert "整理改动方案" in str(agent[-1]["content"])
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=STOP_TIMEOUT_SECONDS)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()

    def test_tools_gate_the_next_step_and_multi_turn_keeps_one_process(
        self, tmp_path: Path
    ) -> None:
        files = workspace(tmp_path)
        with running_serve(files, "panel-tools") as (_process, base):
            token = page_token(base)
            status, created = request(
                base,
                "POST",
                "/api/panel/sessions",
                {"project": "demo", "title": "工具会话", "by": "owner"},
                token,
            )
            assert status == 201
            session_id = str(created["session_id"])
            assert (
                request(
                    base,
                    "POST",
                    f"/api/panel/sessions/{session_id}/messages",
                    {"text": "看一下目录", "by": "owner"},
                    token,
                )[0]
                == 202
            )

            def gated() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
                return detail["session"]["pending_decisions"] == 1

            wait_until(gated, what="工具审批闸门出现")
            _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
            calls = {str(item["tool_name"]): item for item in detail["tool_calls"]}
            assert calls["bash"]["risk"] == "execute"
            assert calls["bash"]["approval_status"] == "pending"
            assert calls["read"]["risk"] == "read"
            assert calls["read"]["approval_status"] == "none"
            decision = detail["decisions"][-1]
            assert decision["kind"] == "tool_review"
            assert "轮次边界" in str(decision["question"])

            assert (
                request(
                    base,
                    "POST",
                    f"/api/panel/sessions/{session_id}/decisions/{decision['decision_id']}",
                    {"by": "owner", "decision": "approve", "reason": "只读命令可以跑"},
                    token,
                )[0]
                == 200
            )
            _, after = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
            assert after["session"]["status"] == "active"
            assert calls["bash"]["tool_call_id"] in {
                str(item["tool_call_id"]) for item in after["tool_calls"]
            }
            # 批准只放行需要确认的那一次；只读调用仍是「无需审批」。
            assert {
                str(item["tool_name"]): str(item["approval_status"]) for item in after["tool_calls"]
            } == {"bash": "approved", "read": "none"}

            # 常驻进程：批准后同一个会话进程被复用（pid 不变、冷启动只有一次）。
            _, document = request(base, "GET", "/api/panel", None, token)
            runtime = document["runtime"]
            assert runtime["live_sessions"] == 1
            live = runtime["live"][0]
            pid = live["pid"]
            assert isinstance(pid, int) and pid > 0

            assert (
                request(
                    base,
                    "POST",
                    f"/api/panel/sessions/{session_id}/messages",
                    {"text": "继续", "by": "owner"},
                    token,
                )[0]
                == 202
            )

            def second_turn_done() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
                return detail["session"]["turn_count"] == 2 and not detail["session"]["running"]

            wait_until(second_turn_done, what="第二轮结束")
            _, document = request(base, "GET", "/api/panel", None, token)
            assert document["runtime"]["live"][0]["pid"] == pid
            assert document["runtime"]["live"][0]["cold_starts"] == 1

    def test_compaction_is_recorded_and_counted(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        with running_serve(files, "panel-compact") as (_process, base):
            token = page_token(base)
            status, created = request(
                base,
                "POST",
                "/api/panel/sessions",
                {"project": "demo", "title": "压缩会话", "by": "owner"},
                token,
            )
            assert status == 201
            session_id = str(created["session_id"])
            request(
                base,
                "POST",
                f"/api/panel/sessions/{session_id}/messages",
                {"text": "继续做", "by": "owner"},
                token,
            )

            def done() -> bool:
                _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
                return (
                    detail["session"]["compaction_count"] == 1 and not detail["session"]["running"]
                )

            wait_until(done, what="压缩事件落库")
            _, detail = request(base, "GET", f"/api/panel/sessions/{session_id}", None, token)
            notices = [item for item in detail["messages"] if item["role"] == "system"]
            assert any("上下文" in str(item["content"]) for item in notices)
            contents = [str(item["content"]) for item in detail["messages"]]
            assert "继续做" in contents


class TestPanelStartupFailures:
    def run_once(self, files: dict[str, Path]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            serve_argv(files, "--once", "--json"),
            capture_output=True,
            text=True,
            timeout=60,
            env=cli_env(),
            check=False,
        )

    def test_corrupt_projects_file_refuses_to_start(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        files["projects_file"].write_text("这不是 TOML =", encoding="utf-8")
        result = self.run_once(files)
        assert result.returncode == 1
        assert "projects.toml" in result.stderr
        assert "解析失败" in result.stderr

    def test_name_conflict_with_hand_written_config_refuses_to_start(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        files["service_config"].write_text(
            files["service_config"].read_text(encoding="utf-8")
            + f'\n[projects."demo"]\npath = "{files["project"]}"\n'
            + f"pi_command = {json.dumps(list(FAKE_PI))}\n"
            + f'pi_home = "{files["pi_home"]}"\ntest_command = ["pytest"]\n',
            encoding="utf-8",
        )
        result = self.run_once(files)
        assert result.returncode == 1
        assert "重复" in result.stderr

    def test_unusable_pi_home_refuses_to_start(self, tmp_path: Path) -> None:
        files = workspace(tmp_path)
        broken = tmp_path / "broken-home"
        broken.mkdir()
        files["projects_file"].write_text(
            files["projects_file"]
            .read_text(encoding="utf-8")
            .replace(str(files["pi_home"]), str(broken)),
            encoding="utf-8",
        )
        result = self.run_once(files)
        assert result.returncode == 1
        assert "models.json" in result.stderr

    @pytest.mark.parametrize(
        "panel_line",
        ["concurrency = 0", "concurrency = 9", "turn_timeout_seconds = 0", "unknown_key = 1"],
    )
    def test_invalid_panel_settings_refuse_to_start(self, tmp_path: Path, panel_line: str) -> None:
        files = workspace(tmp_path)
        files["service_config"].write_text(
            files["service_config"]
            .read_text(encoding="utf-8")
            .replace("concurrency = 2", panel_line, 1),
            encoding="utf-8",
        )
        result = self.run_once(files)
        assert result.returncode == 1
        assert "panel" in result.stderr


class TestReadOnlyWebHasNoPanel:
    def test_web_process_does_not_serve_the_panel(self, tmp_path: Path) -> None:
        """只读的 ``forgeloop web`` 不装配面板：真实进程上 /api/panel 必须 404。"""

        records = tmp_path / "records"
        records.mkdir()
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "forgeloop",
                "web",
                "--port",
                "0",
                "--records-root",
                str(records),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=cli_env(),
        )
        try:
            assert process.stdout is not None
            deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
            base = ""
            while time.monotonic() < deadline and not base:
                line = process.stdout.readline()
                if not line and process.poll() is not None:
                    break
                match = re.search(r"(http://[^\s]+)", line)
                if match:
                    base = match.group(1).rstrip("/")
            assert base, "未取到只读服务的地址"
            # 用显式连接而不是 urlopen：失败分支不会留下未关闭的套接字（避免资源告警）。
            host, port = urlsplit(base).hostname, urlsplit(base).port
            assert host is not None and port is not None
            connection = http.client.HTTPConnection(host, port, timeout=10)
            try:
                connection.request("GET", "/api/panel")
                response = connection.getresponse()
                assert response.status == 404
                response.read()
            finally:
                connection.close()
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=STOP_TIMEOUT_SECONDS)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
