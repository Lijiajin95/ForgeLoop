"""页面写入口的真实进程全链路（R3）：真实子进程 + 真实 HTTP + 真实记录 + 假 PI。

一条命令跑完整条页面闭环：**页面提交 → 页面批准 → 常驻进程自动推进 → 页面整体验收**。
令牌从真实页面 HTML 里读出来（不硬编码），因此「服务端注入令牌、页面带令牌发请求」这条
链路是被真实核对过的；批准与验收走与 CLI 相同的函数对象，绑定与审计一致。

真实浏览器里的 DOM 接线由 jsdom 组件用例覆盖；真实 Chromium 的 Playwright 用例尚未编写
（如实记录在状态文档里）。
"""

import contextlib
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
from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import (
    project_records,
    register_project,
    requirement_store,
)

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
STARTUP_LINE = re.compile(r"状态页: (http://[^\s]+)")
TOKEN_PATTERN = re.compile(r'name="forgeloop-token" content="([^"]+)"')
STARTUP_TIMEOUT_SECONDS = 20
ADVANCE_TIMEOUT_SECONDS = 90
STOP_TIMEOUT_SECONDS = 20
WHEN = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"


def _pi_home(tmp_path: Path) -> Path:
    home = tmp_path / "pi-home"
    models = home / ".pi" / "agent" / "models.json"
    models.parent.mkdir(parents=True, exist_ok=True)
    models.write_text('{"providers": {}}', encoding="utf-8")
    return home


def _service_config(tmp_path: Path, home: Path) -> Path:
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
                "auto_advance = true",
                "",
                f"[projects.{PROJECT}]",
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
            return match.group(1).rstrip("/")
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


def _fetch(url: str) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:  # 真实回环地址
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:  # pragma: no cover - 失败路径由断言体现
        return error.code, error.read().decode("utf-8")


def _post(base: str, path: str, payload: dict, token: str) -> tuple[int, dict]:
    request = urllib.request.Request(  # 真实回环地址
        f"{base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Origin": base,
            "X-Forgeloop-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def _token_from_page(base: str) -> str:
    status, html = _fetch(f"{base}/")
    assert status == 200
    match = TOKEN_PATTERN.search(html)
    assert match is not None, "页面没有注入令牌"
    return match.group(1)


def _progress(base: str) -> dict:
    status, body = _fetch(f"{base}/api/progress")
    assert status == 200
    return json.loads(body)


def _wait_for_task_status(base: str, task_id: str, expected: str) -> dict:
    deadline = time.monotonic() + ADVANCE_TIMEOUT_SECONDS
    document = _progress(base)
    while time.monotonic() < deadline:
        for entry in document["tasks"]:
            if entry["task_id"] == task_id and entry["status"] == expected:
                return entry
        time.sleep(0.5)
        document = _progress(base)
    raise AssertionError(f"{task_id} 未在 {ADVANCE_TIMEOUT_SECONDS}s 内到达 {expected}")


def _approve_task_acceptance(task_id: str, records: Path, home: Path) -> None:
    """单任务验收由人工在 CLI 侧作出（页面只做需求整体验收）：记录批准并恢复执行。"""

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "approve",
            task_id,
            "--stage",
            "acceptance",
            "--decision",
            "approved",
            "--records-root",
            str(records),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        env=_env(home),
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _wait_for_requirement_status(base: str, req_id: str, expected: str) -> dict:
    deadline = time.monotonic() + ADVANCE_TIMEOUT_SECONDS
    document = _progress(base)
    while time.monotonic() < deadline:
        for entry in document["requirements"]:
            if entry["req_id"] == req_id and entry["requirement_status"] == expected:
                return entry
        time.sleep(0.5)
        document = _progress(base)
    raise AssertionError(f"{req_id} 未在 {ADVANCE_TIMEOUT_SECONDS}s 内到达 {expected}")


@pytest.mark.timeout(240)
def test_page_flow_submit_approve_advance_accept(tmp_path: Path) -> None:
    """页面提交 → 页面批准 → 自动推进 → 页面验收，全程只经 HTTP 与真实记录。"""

    records = tmp_path / "records"
    # 多项目模式：先登记项目，常驻服务才会把业务记录写进项目记录根。
    register_project(records)
    home = _pi_home(tmp_path)
    service_config = _service_config(tmp_path, home)

    with _running_serve(records, home, service_config) as (_, base):
        token = _token_from_page(base)

        # 1) 页面提交需求
        status, submitted = _post(
            base,
            "/api/requirements",
            {"project": PROJECT, "text": "页面闭环用例", "by": "owner", "reason": "系统用例"},
            token,
        )
        assert status == 201, submitted
        req_id = submitted["req_id"]

        # 2) 页面批准任务包（此时还没有任务包：先由需求线规划——本用例直接写一条已批准任务包）
        #    真实路径是「提交 → analyze → plan → approve」，这里为把范围钉在页面写入口上，
        #    用记录层直接准备任务包，再走页面的批准入口。
        _prepare_plan(records, req_id)
        status, approved = _post(
            base,
            f"/api/requirements/{req_id}/approve",
            {"by": "owner", "reason": "页面批准"},
            token,
        )
        assert status == 200, approved
        assert "已批准" in approved["output"]

        # 3) 常驻进程自动接续：不做任何推进调用，只读进展接口等单任务自己跑到验收门
        task_id = f"task-{req_id}-v1-first"
        _wait_for_task_status(base, task_id, "awaiting_acceptance")

        # 4) 单任务验收是人工决定（页面只提供需求整体验收）：CLI 记录批准并恢复执行
        _approve_task_acceptance(task_id, records, home)
        _wait_for_task_status(base, task_id, "delivered")

        # 5) 页面整体验收
        status, accepted = _post(
            base,
            f"/api/requirements/{req_id}/accept",
            {"by": "owner", "reason": "页面验收"},
            token,
        )
        assert status == 200, accepted
        entry = _wait_for_requirement_status(base, req_id, "accepted")
        assert entry["requirement_status"] == "accepted"

    # 收尾核对：任务确实交付过，且批准记录的来源列写明是页面入口（审计可回查）
    tasks = _read_tasks(records)
    assert any(status == "delivered" for status in tasks.values()), tasks
    assert _approval_source(records) == "web:owner"


def _prepare_plan(records: Path, req_id: str) -> None:
    """把任务包写进真实记录（本用例只验证页面写入口，不复跑规划那一跳）。"""

    sys.path.insert(0, str(SRC))
    from forgeloop.domain.task_plan import PlannedTask, TaskPlan

    store = requirement_store(records)
    try:
        plan = TaskPlan(
            task_plan_id=f"plan-{req_id}-1",
            requirement_id=req_id,
            project=PROJECT,
            plan_version=1,
            requirement_version=1,
            tasks=(
                PlannedTask(
                    task_id="first",
                    goal="页面闭环任务",
                    files=("src/forgeloop/first.py",),
                    acceptance="闭环验收",
                    test_command=(sys.executable, "-c", "print('ok')"),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(req_id, plan)
    finally:
        store.close()


def _approval_source(records: Path) -> str:
    """批准记录的 ``source`` 列：页面批准必须留下 ``web:<by>`` 的来源。"""

    import sqlite3

    connection = sqlite3.connect(
        f"file:{project_records(records) / 'records.sqlite'}?mode=ro", uri=True
    )
    try:
        row = connection.execute(
            "SELECT source FROM requirement_plan_approvals ORDER BY approved_at DESC LIMIT 1"
        ).fetchone()
    finally:
        connection.close()
    return "" if row is None else str(row[0])


def _read_tasks(records: Path) -> dict[str, str]:
    import sqlite3

    connection = sqlite3.connect(
        f"file:{project_records(records) / 'records.sqlite'}?mode=ro", uri=True
    )
    try:
        return {
            str(row[0]): str(row[1]) for row in connection.execute("SELECT id, status FROM tasks")
        }
    finally:
        connection.close()
