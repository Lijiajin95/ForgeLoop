"""系统测试：以真实子进程运行 ``forgeloop web``，用真实 HTTP 请求核对进展。

V0-08 与 B01 的语义：查询由实际记录生成，进程退出后仍可回查；状态页必须由真实
CLI 进程提供，而不是只在测试进程内构造的服务对象。本文件启动真实子进程、从它的
启动输出取实际监听地址，再用真实 HTTP 请求读取需求/任务/问题进展与刷新配置。
"""

import contextlib
import json
import os
import re
import select
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from project_support import record_store, register_project, requirement_store

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
STARTUP_LINE = re.compile(r"Web 操作管理台: (http://[^\s]+)")
STARTUP_TIMEOUT_SECONDS = 15


def run_cli_process(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        check=False,
    )


@contextlib.contextmanager
def running_web(records_root: Path, *extra: str) -> Iterator[str]:
    """启动真实 Web 控制台子进程并给出实际监听地址；退出时确保进程被回收。"""

    # Web 控制台需要一个已登记项目（前台 `web` 不再是无项目的只读页）。
    register_project(records_root)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "web",
            "--port",
            "0",
            "--records-root",
            str(records_root),
            # 测试夹具不读仓库里的真实服务/项目档案：两个路径指向临时目录。
            "--service-config",
            str(records_root / "service.toml"),
            "--projects-file",
            str(records_root / "projects.toml"),
            *extra,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert process.stdout is not None
        ready, _, _ = select.select([process.stdout], [], [], STARTUP_TIMEOUT_SECONDS)
        if not ready:
            process.kill()
            _, errors = process.communicate(timeout=10)
            raise AssertionError(
                f"状态页进程未在 {STARTUP_TIMEOUT_SECONDS} 秒内输出监听地址: {errors}"
            )
        line = process.stdout.readline()
        match = STARTUP_LINE.search(line)
        assert match is not None, f"启动输出无法解析: {line!r}"
        yield match.group(1)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        # 管道必须显式关闭：未关闭的文件对象会被 ResourceWarning 记为未处理异常。
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


def seed_records(root: Path) -> str:
    """写入一条真实需求与一个阻断任务；返回需求身份。"""

    register_project(root)
    store = record_store(root)
    try:
        store.create_task(
            "task-blocked",
            "forgeloop",
            "原始需求文本",
            {"pi_command": '["pi"]', "test_command": '["pytest"]'},
            limit_seconds=100.0,
        )
        store.set_task_status("task-blocked", "blocked")
    finally:
        store.close()
    requirements = requirement_store(root)
    try:
        return requirements.submit("forgeloop", "状态页要显示需求进展").req_id
    finally:
        requirements.close()


def fetch_json(url: str) -> tuple[int, dict]:
    with urllib.request.urlopen(url, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def fetch_page_token(url: str) -> str:
    with urllib.request.urlopen(url, timeout=10) as response:
        page = response.read().decode("utf-8")
    match = re.search(r'name="forgeloop-token" content="([^"]+)"', page)
    assert match is not None, "页面没有下发令牌"
    return match.group(1)


def post_json(url: str, token: str, origin: str, payload: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Forgeloop-Token": token,
            "Origin": origin,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


class TestWebProcess:
    def test_serves_progress_from_real_records(self, tmp_path: Path) -> None:
        req_id = seed_records(tmp_path)

        with running_web(tmp_path, "--web-config", str(tmp_path / "absent.toml")) as base:
            status, document = fetch_json(f"{base}api/progress")
            with urllib.request.urlopen(base, timeout=10) as response:
                page = response.read().decode("utf-8")

        assert status == 200
        assert [item["req_id"] for item in document["requirements"]] == [req_id]
        assert [item["task_id"] for item in document["tasks"]] == ["task-blocked"]
        assert document["counts"] == {"projects": 1, "requirements": 1, "tasks": 1, "issues": 1}
        assert document["issues"][0]["kind"] == "task_blocked"
        # 没有配置文件时用内建默认：每 1 分钟刷新一次。
        assert document["refresh_seconds"] == 60
        assert document["refresh_source"] == "default"
        assert "ForgeLoop" in page

    def test_cli_refresh_override_reaches_the_page(self, tmp_path: Path) -> None:
        with running_web(tmp_path, "--refresh-seconds", "0") as base:
            _, document = fetch_json(f"{base}api/progress")

        assert document["refresh_seconds"] == 0
        assert document["refresh_source"] == "cli"

    def test_records_root_config_value_is_used(self, tmp_path: Path) -> None:
        config = tmp_path / "web.toml"
        config.write_text("schema_version = 1\nrefresh_seconds = 120\n", encoding="utf-8")

        with running_web(tmp_path, "--web-config", str(config)) as base:
            _, document = fetch_json(f"{base}api/progress")

        assert document["refresh_seconds"] == 120
        assert document["refresh_source"] == "config"

    def test_invalid_refresh_value_fails_before_listening(self, tmp_path: Path) -> None:
        result = run_cli_process(["web", "--refresh-seconds", "-1"], tmp_path)

        assert result.returncode == 1
        assert "FAIL:" in result.stderr
        assert "--refresh-seconds" in result.stderr

    def test_missing_port_is_reported_deterministically(self, tmp_path: Path) -> None:
        """同一端口重复绑定必须确定性失败，而不是静默换端口。"""

        with running_web(tmp_path) as base:
            busy_port = re.search(r":(\d+)/$", base)
            assert busy_port is not None
            result = run_cli_process(["web", "--port", busy_port.group(1)], tmp_path)

        assert result.returncode == 1
        assert "无法监听" in result.stderr

    def test_serves_the_compiled_page_module(self, tmp_path: Path) -> None:
        """页面行为代码随包分发：真实进程必须能取到编译后的模块。"""

        with (
            running_web(tmp_path) as base,
            urllib.request.urlopen(f"{base}app.js", timeout=10) as response,
        ):
            module = response.read().decode("utf-8")
            content_type = response.headers["Content-Type"]

        assert "text/javascript" in content_type
        assert "bootstrap" in module

    def test_unknown_path_is_404_over_a_real_process(self, tmp_path: Path) -> None:
        with running_web(tmp_path) as base:
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(f"{base}nope", timeout=10)
            # HTTPError 自身持有响应 socket，必须显式关闭。
            error.value.close()

        assert error.value.code == 404


class TestWebConsoleWrites:
    """`forgeloop web` 是前台操作台：页面令牌 + 同源 + 真实记录改写。"""

    def test_requirement_crud_over_the_foreground_console(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        with running_web(tmp_path) as base:
            token = fetch_page_token(base)
            origin = base.rstrip("/")

            status, created = post_json(
                f"{base}api/requirements",
                token,
                origin,
                {"by": "owner", "project": "forgeloop", "text": "Web 控制台创建的需求"},
            )
            req_id = created["req_id"]
            assert status == 201

            status, revised = post_json(
                f"{base}api/requirements/{req_id}/revise",
                token,
                origin,
                {"by": "owner", "text": "Web 控制台修订后的正文", "reason": "补充细节"},
            )
            assert status == 200
            assert "版本 2" in revised["output"]

            _, progress = fetch_json(f"{base}api/progress")
            requirement = next(
                item for item in progress["requirements"] if item["req_id"] == req_id
            )
            assert [version["text"] for version in requirement["versions"]] == [
                "Web 控制台创建的需求",
                "Web 控制台修订后的正文",
            ]

            status, cancelled = post_json(
                f"{base}api/requirements/{req_id}/cancel",
                token,
                origin,
                {"by": "owner", "reason": "不再需要"},
            )
            assert status == 200
            assert cancelled["operation"] == "cancel"
            _, progress = fetch_json(f"{base}api/progress")
            requirement = next(
                item for item in progress["requirements"] if item["req_id"] == req_id
            )
            assert requirement["requirement_status"] == "cancelled"

    def test_write_without_token_is_refused(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        with running_web(tmp_path) as base:
            request = urllib.request.Request(
                f"{base}api/requirements",
                data=b'{"by":"owner","project":"forgeloop","text":"x"}',
                headers={"Content-Type": "application/json", "Origin": base.rstrip("/")},
                method="POST",
            )
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=10)
            error.value.close()
        assert error.value.code == 403


class TestWebConsoleConversation:
    """Web 会话界面：真实前台进程 + 真实假 PI 子进程，核对「从 Web 对话」链路。"""

    def test_create_session_and_exchange_a_message(self, tmp_path: Path) -> None:
        import os

        records_root = tmp_path / "records"
        register_project(records_root)
        repo = records_root / "repo"
        pi_home = tmp_path / "pi-home"
        (pi_home / ".pi" / "agent").mkdir(parents=True)
        (pi_home / ".pi" / "agent" / "models.json").write_text(
            '{"providers": {}}', encoding="utf-8"
        )
        fake_pi = ROOT / "tests" / "fixtures" / "fake_pi.py"
        projects = tmp_path / "projects.toml"
        projects.write_text(
            "schema_version = 1\n"
            "[projects.forgeloop]\n"
            f'path = "{repo}"\n'
            'description = "Web 会话系统用例"\n'
            f'pi_command = ["{sys.executable}", "{fake_pi}"]\n'
            f'pi_home = "{pi_home}"\n',
            encoding="utf-8",
        )
        env = os.environ.copy()
        env.update({"PYTHONPATH": str(SRC), "FAKE_PI_MODE": "chat"})
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "forgeloop",
                "web",
                "--port",
                "0",
                "--records-root",
                str(records_root),
                "--service-config",
                str(tmp_path / "service.toml"),
                "--projects-file",
                str(projects),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            assert process.stdout is not None
            ready, _, _ = select.select([process.stdout], [], [], STARTUP_TIMEOUT_SECONDS)
            assert ready, "Web 控制台未在时限内启动"
            line = process.stdout.readline()
            match = STARTUP_LINE.search(line)
            assert match is not None, f"启动输出无法解析: {line!r}"
            base = match.group(1)
            token = fetch_page_token(base)
            origin = base.rstrip("/")

            status, session = post_json(
                f"{base}api/panel/sessions",
                token,
                origin,
                {"by": "owner", "project": "forgeloop", "title": "Web 会话系统用例"},
            )
            assert status == 201
            session_id = session["session_id"]

            status, accepted = post_json(
                f"{base}api/panel/sessions/{session_id}/messages",
                token,
                origin,
                {"by": "owner", "text": "请回复一句确认"},
            )
            assert status == 202
            assert accepted["operation"] == "session_message"

            deadline = time.time() + 20
            reply = ""
            while time.time() < deadline:
                _, detail = fetch_json(f"{base}api/panel/sessions/{session_id}")
                agent_messages = [
                    message
                    for message in detail["messages"]
                    if message["role"] == "agent" and message["state"] == "ok"
                ]
                if agent_messages:
                    reply = agent_messages[-1]["content"]
                    break
                time.sleep(0.2)
            assert reply.strip(), "Web 会话没有收到 Agent 回复"
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
