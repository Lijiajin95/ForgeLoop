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
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
STARTUP_LINE = re.compile(r"状态页: (http://[^\s]+)")
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
    """启动真实状态页子进程并给出实际监听地址；退出时确保进程被回收。"""

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

    store = RecordStore(root / "records.sqlite")
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
    requirement_store = RequirementStore(root / "records.sqlite")
    try:
        return requirement_store.submit("forgeloop", "状态页要显示需求进展").req_id
    finally:
        requirement_store.close()


def fetch_json(url: str) -> tuple[int, dict]:
    with urllib.request.urlopen(url, timeout=10) as response:
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
        assert document["counts"] == {"requirements": 1, "tasks": 1, "issues": 1}
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
