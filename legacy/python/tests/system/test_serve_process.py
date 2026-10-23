"""系统测试：以真实子进程运行 ``forgeloop serve``，核对常驻行为与失败路径。

R1 的验收点是「进程真的常驻、停得干净、坏配置拒绝启动、状态可查」，因此这里只做
真实子进程 + 真实 HTTP：``--once`` 自检、端口 0 启动后从输出取实际地址、``SIGTERM``
后退出码 0 且端口释放、四类非法配置各自拒绝启动。

R1 明确不执行任务，因此本文件不断言任何业务推进；执行与唤醒的验收在 R2 追加。
"""

import contextlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from project_support import (
    record_store,
)

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
STARTUP_LINE = re.compile(r"Web 操作管理台: (http://[^\s]+)")
STARTUP_TIMEOUT_SECONDS = 15
STOP_TIMEOUT_SECONDS = 15


def cli_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    return env


def run_cli(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=60,
        env=cli_env(),
        check=False,
    )


def wait_for_startup(process: subprocess.Popen[str]) -> str:
    """从启动输出里取实际监听地址；超时即失败并带上已读到的内容。"""

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
def running_serve(records_root: Path, *extra: str) -> Iterator[tuple[subprocess.Popen[str], str]]:
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "serve",
            "--port",
            "0",
            "--records-root",
            str(records_root),
            *extra,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=cli_env(),
    )
    try:
        yield process, wait_for_startup(process)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=STOP_TIMEOUT_SECONDS)
        # 管道必须显式关闭：pytest 把 ResourceWarning 当错误，泄漏的管道会让用例假失败。
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def read_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as response:  # 真实回环地址
        return json.loads(response.read().decode("utf-8"))


def write_config(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


class TestOnceSelfCheck:
    def test_once_json_reports_skeleton(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        result = run_cli(
            [
                "serve",
                "--once",
                "--json",
                "--projects-file",
                str(tmp_path / "projects.toml"),
            ],
            records,
        )
        assert result.returncode == 0, result.stderr
        document = json.loads(result.stdout)
        assert document["schema_version"] == 1
        assert document["worker"]["execution_enabled"] is False
        assert document["worker"]["running"] is False
        assert document["worker"]["poll_seconds"] == 2
        assert document["projects"] == []
        assert document["review_required"] == []

    def test_once_text_reports_effective_config(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        service_config = write_config(
            tmp_path / "service.toml",
            "schema_version = 1\npoll_seconds = 7\nauto_advance = true\n",
        )
        result = run_cli(
            [
                "serve",
                "--once",
                "--service-config",
                str(service_config),
                "--refresh-seconds",
                "0",
                "--projects-file",
                str(tmp_path / "projects.toml"),
            ],
            records,
        )
        assert result.returncode == 0, result.stderr
        assert "轮询间隔: 7 秒" in result.stdout
        assert "自动接续: 开启" in result.stdout
        assert "可执行项目: 无" in result.stdout

    def test_once_does_not_listen(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        port = free_port()
        result = run_cli(["serve", "--once", "--port", str(port)], records)
        assert result.returncode == 0, result.stderr
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(("127.0.0.1", port)) != 0


class TestInvalidConfig:
    @pytest.mark.parametrize(
        ("name", "body", "needle"),
        [
            ("remote", 'schema_version = 1\nhost = "0.0.0.0"\n', "只允许回环地址"),
            ("poll", "schema_version = 1\npoll_seconds = 0\n", "poll_seconds"),
            ("unknown", "schema_version = 1\npoll_second = 3\n", "未知配置项"),
            ("schema", "schema_version = 2\n", "schema_version"),
            (
                "pihome",
                'schema_version = 1\n[projects.demo]\npath = "/tmp/demo"\n'
                'pi_command = ["pi"]\ntest_command = ["pytest"]\n'
                'pi_home = "/nonexistent-forgeloop-home"\n',
                "PI HOME 不可用",
            ),
        ],
    )
    def test_invalid_config_refuses_to_start(
        self, tmp_path: Path, name: str, body: str, needle: str
    ) -> None:
        records = tmp_path / "records"
        service_config = write_config(tmp_path / f"{name}.toml", body)
        result = run_cli(["serve", "--once", "--service-config", str(service_config)], records)
        assert result.returncode == 1
        assert needle in result.stderr
        assert str(service_config) in result.stderr

    def test_broken_toml_is_refused(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        service_config = write_config(tmp_path / "broken.toml", "schema_version = ")
        result = run_cli(["serve", "--once", "--service-config", str(service_config)], records)
        assert result.returncode == 1
        assert "解析失败" in result.stderr

    def test_port_already_in_use_is_reported(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen(1)
            port = holder.getsockname()[1]
            result = run_cli(["serve", "--port", str(port)], records)
        assert result.returncode == 1
        assert "无法监听" in result.stderr


class TestResidentProcess:
    def test_status_route_and_graceful_sigterm(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        with running_serve(records) as (process, url):
            document = read_json(f"{url}/api/service")
            assert document["worker"]["running"] is True
            assert document["worker"]["execution_enabled"] is False
            assert document["records_root"] == str(records)
            port = int(url.rsplit(":", 1)[1].rstrip("/"))
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=STOP_TIMEOUT_SECONDS) == 0
            tail = process.stdout.read() if process.stdout else ""
        assert "已停止。" in tail
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(("127.0.0.1", port)) != 0

    def test_worker_heartbeat_is_reported_by_real_process(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        with running_serve(records) as (_, url):
            deadline = time.monotonic() + 10
            polls = 0
            while time.monotonic() < deadline:
                polls = read_json(f"{url}/api/service")["worker"]["polls"]
                if polls >= 1:
                    break
                time.sleep(0.2)
            assert polls >= 1, "常驻进程应在 poll_seconds 内至少完成一次心跳"

    def test_review_required_surfaces_records(self, tmp_path: Path) -> None:
        records = tmp_path / "records"
        records.mkdir(parents=True)
        seed_blocked_task(records)
        with running_serve(records) as (_, url):
            document = read_json(f"{url}/api/service")
            kinds = {item["kind"] for item in document["review_required"]}
            assert kinds == {"task_blocked", "slot_residue"}
            assert document["counts"]["issues"] == 2


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def seed_blocked_task(records: Path) -> None:
    """直接写真实 SQLite 记录（与集成层同一个夹具口径），供常驻进程读取。"""

    sys.path.insert(0, str(SRC))

    store = record_store(records)
    try:
        store.create_task(
            "task-blocked",
            "forgeloop",
            "常驻服务的阻断任务",
            {"pi_command": '["pi"]', "test_command": '["pytest"]'},
            limit_seconds=100.0,
        )
        store.set_task_status("task-blocked", "blocked")
        store.actions.claim_slot("req-forgeloop-1", "advance")
    finally:
        store.close()
