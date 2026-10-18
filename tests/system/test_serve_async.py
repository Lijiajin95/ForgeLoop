"""常驻进程的异步执行验收（R2）：真实子进程、真实记录、真实业务图、假 PI。

覆盖方案 §8 中 R2 的两条后台验收：

- **决定后唤醒**：需求先处于「未批准」，常驻进程空闲；由**另一个进程**执行
  `requirement approve` 后，不再有任何推进调用，worker 应在若干个 ``poll_seconds``
  内自己发现并开始执行；
- **客户端断开后推进**：显式 POST 一次推进后**立即用 RST 断开连接**（不读响应），服务端
  仍要把这一步跑完 —— 任务照常跑到验收门（``awaiting_acceptance``）；另一条更弱的形态
  （批准之后测试完全不访问服务）也由唤醒用例覆盖。

另有一条反向用例：``auto_advance = false`` 时即使批准了也不会执行（开关默认关闭）。
真实模型不在本层验证（假 PI 只证明编排）；真实模型下的常驻长跑需另行验收。
"""

import contextlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
STARTUP_LINE = re.compile(r"状态页: (http://[^\s]+)")
STARTUP_TIMEOUT_SECONDS = 20
ADVANCE_TIMEOUT_SECONDS = 90
STOP_TIMEOUT_SECONDS = 20
WHEN = datetime(2026, 10, 18, 8, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
TASK = "first"
PLAN_VERSION = 1


def _seed_requirement(records: Path) -> str:
    """写入一条**未批准**的真实需求：任务包已记录，批准留给另一个进程去做。"""

    sys.path.insert(0, str(SRC))
    from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
    from forgeloop.records.requirements import RequirementStore

    store = RequirementStore(records / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：常驻进程自动接续")
        task = PlannedTask(
            task_id=TASK,
            goal="实现 first",
            files=("src/forgeloop/first.py",),
            acceptance="first 的验收标准",
            test_command=(sys.executable, "-c", "print('ok')"),
            limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
        )
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(task,),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        return requirement.req_id
    finally:
        store.close()


def _pi_home(tmp_path: Path) -> Path:
    home = tmp_path / "pi-home"
    models = home / ".pi" / "agent" / "models.json"
    models.parent.mkdir(parents=True, exist_ok=True)
    models.write_text('{"providers": {}}', encoding="utf-8")
    return home


def _service_config(tmp_path: Path, home: Path, *, auto_advance: bool) -> Path:
    path = tmp_path / "service.toml"
    test_command = json.dumps([sys.executable, "-c", "print('ok')"])
    path.write_text(
        "\n".join(
            [
                "schema_version = 1",
                'host = "127.0.0.1"',
                "port = 0",
                "poll_seconds = 1",
                "max_concurrent = 1",
                f"auto_advance = {'true' if auto_advance else 'false'}",
                "",
                f"[projects.{PROJECT}]",
                # path 必须是真实项目目录（配置校验拒绝空串）；用仓库本身作为被测项目。
                f'path = "{ROOT}"',
                f"pi_command = {json.dumps(FAKE_PI)}",
                f"test_command = {test_command}",
                'baseline = ""',
                f'pi_home = "{home}"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    return path


def _env(home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    env["HOME"] = str(home)
    env["FAKE_PI_MODE"] = "ok"
    return env


def _wait_for_startup(process: subprocess.Popen[str]) -> str:
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
def _running_serve(
    records: Path, home: Path, service_config: Path
) -> Iterator[tuple[subprocess.Popen[str], str]]:
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "serve",
            "--port",
            "0",
            "--records-root",
            str(records),
            "--service-config",
            str(service_config),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_env(home),
    )
    try:
        yield process, _wait_for_startup(process)
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:  # pragma: no cover - 兜底清理
                process.kill()
                process.wait(timeout=STOP_TIMEOUT_SECONDS)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def _approve_in_another_process(req_id: str, records: Path, home: Path) -> None:
    """由**另一个进程**记录批准：模拟所有者离开终端后从别处作出决定。"""

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "requirement",
            "approve",
            req_id,
            "--by",
            "owner",
            "--source",
            "system-test-async",
            "--records-root",
            str(records),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=_env(home),
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _workspace_status(records: Path, thread_id: str) -> tuple[str, int]:
    """只读 SQLite：返回（任务状态，已完成动作数）；记录不存在时返回 ("missing", 0)。"""

    try:
        connection = sqlite3.connect(f"file:{records / 'records.sqlite'}?mode=ro", uri=True)
    except sqlite3.Error:  # pragma: no cover - 记录库尚未建立
        return "missing", 0
    try:
        row = connection.execute("SELECT status FROM tasks WHERE id = ?", (thread_id,)).fetchone()
        done = connection.execute(
            "SELECT count(*) FROM actions WHERE task_id = ? AND state = 'completed'",
            (thread_id,),
        ).fetchone()
    except sqlite3.Error:  # pragma: no cover - 并发写入时的瞬时锁
        return "unknown", 0
    finally:
        connection.close()
    return ("missing" if row is None else str(row[0])), int(done[0] if done else 0)


def _wait_for_status(
    records: Path, thread_id: str, expected: str, timeout: float = ADVANCE_TIMEOUT_SECONDS
) -> tuple[str, int]:
    """只读记录等待状态到达；不做任何推进调用，也不访问 HTTP。"""

    deadline = time.monotonic() + timeout
    last = ("missing", 0)
    while time.monotonic() < deadline:
        last = _workspace_status(records, thread_id)
        if last[0] == expected:
            return last
        time.sleep(0.5)
    return last


def _thread_id(req_id: str) -> str:
    return f"task-{req_id}-v{PLAN_VERSION}-{TASK}"


def test_worker_wakes_up_after_external_approval(tmp_path: Path) -> None:
    records = tmp_path / "records"
    home = _pi_home(tmp_path)
    req_id = _seed_requirement(records)
    service_config = _service_config(tmp_path, home, auto_advance=True)
    thread_id = _thread_id(req_id)

    with _running_serve(records, home, service_config) as (_, url):
        # 批准前：常驻进程如实报告「不会执行，因为还没有已批准任务包」。
        before = _wait_for_service_tick(url)
        assert before["worker"]["auto_advance"] is True
        assert before["worker"]["executable_projects"] == [PROJECT]
        skipped = {
            item["req_id"]: item["reason"] for item in before["worker"]["last_tick"]["skipped"]
        }
        assert "没有已批准任务包" in skipped[req_id]
        assert _workspace_status(records, thread_id)[0] == "missing"

        _approve_in_another_process(req_id, records, home)

        # 批准之后不再有任何推进调用：等记录自己动起来。
        status, completed = _wait_for_status(records, thread_id, "awaiting_acceptance")

    assert status == "awaiting_acceptance", f"常驻进程未自动接续，最后状态 {status}"
    assert completed >= 3, f"dev/review/test 三个动作都应完成，实际 {completed}"


def test_explicit_advance_survives_client_disconnect(tmp_path: Path) -> None:
    """推进请求发出后客户端立刻断开：服务端不因客户端消失而丢掉这一步。

    ``auto_advance = false``（默认值）保证**只有**这次显式请求能让任务动起来，因此这条
    用例核对的是「请求驱动的推进不依赖客户端连接」这件事本身。
    """

    import socket
    import struct
    import urllib.request

    records = tmp_path / "records"
    home = _pi_home(tmp_path)
    req_id = _seed_requirement(records)
    _approve_in_another_process(req_id, records, home)
    service_config = _service_config(tmp_path, home, auto_advance=False)
    thread_id = _thread_id(req_id)

    with _running_serve(records, home, service_config) as (_, url):
        with urllib.request.urlopen(f"{url}/", timeout=10) as response:  # 真实回环地址
            html = response.read().decode("utf-8")
        token = re.search(r'name="forgeloop-token" content="([^"]+)"', html)
        assert token is not None, "常驻服务必须在页面里注入令牌"
        host, port = url.removeprefix("http://").rstrip("/").split(":")

        body = json.dumps({"by": "owner", "reason": ""}).encode("utf-8")
        request = (
            f"POST /api/requirements/{req_id}/advance HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Content-Type: application/json\r\n"
            f"Origin: {url}\r\n"
            f"X-Forgeloop-Token: {token.group(1)}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode() + body
        client = socket.create_connection((host, int(port)), timeout=10)
        try:
            client.sendall(request)
            # RST 而不是 FIN：连接被强制断开，服务端连回包都写不出去。
            client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        finally:
            client.close()

        # 客户端已经消失；记录必须继续往前走。
        status, completed = _wait_for_status(records, thread_id, "awaiting_acceptance")

    assert status == "awaiting_acceptance", f"断线后未跑完，最后状态 {status}"
    assert completed >= 3, f"dev/review/test 三个动作都应完成，实际 {completed}"


def test_auto_advance_off_never_executes(tmp_path: Path) -> None:
    records = tmp_path / "records"
    home = _pi_home(tmp_path)
    req_id = _seed_requirement(records)
    service_config = _service_config(tmp_path, home, auto_advance=False)
    thread_id = _thread_id(req_id)

    with _running_serve(records, home, service_config) as (_, url):
        document = _read_service(url)
        assert document["worker"]["auto_advance"] is False
        assert document["worker"]["execution_enabled"] is False
        _approve_in_another_process(req_id, records, home)
        # 给足若干个心跳周期：开关关闭时必须仍然没有任何执行。
        time.sleep(3 * document["worker"]["poll_seconds"])
        status, completed = _workspace_status(records, thread_id)

    assert status == "missing"
    assert completed == 0


def _wait_for_service_tick(url: str, timeout: float = 10.0) -> dict:
    """等到常驻进程至少完成一次筛选（``last_tick`` 有内容）再断言。"""

    deadline = time.monotonic() + timeout
    document = _read_service(url)
    while time.monotonic() < deadline:
        skipped = document["worker"]["last_tick"]["skipped"]
        if skipped:
            return document
        time.sleep(0.3)
        document = _read_service(url)
    return document


def _read_service(url: str) -> dict:
    import urllib.request

    with urllib.request.urlopen(f"{url.rstrip('/')}/api/service", timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))
