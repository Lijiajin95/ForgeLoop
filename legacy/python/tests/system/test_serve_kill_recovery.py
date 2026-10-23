"""常驻服务的强杀重启核对（R4）：真实子进程 + 真实记录 + 真实业务图 + 假 PI。

一条真实现场：常驻进程在 ``dev`` 动作执行中被 ``kill -9``，动作留在 ``started``、执行槽位
残留。重启后要看到：

- ``GET /api/service`` 的「需人工核对」清单如实列出未核对动作与残留槽位（含副作用证据）；
- **不自动重放**：即使 ``auto_advance = true``、假 PI 这次会成功，任务也不会被重新启动；
- 清理入口存在（``requirement actions list`` 能看到该动作），恢复由人工决定。
"""

import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import (
    project_records,
    requirement_store,
)

pytestmark = pytest.mark.system

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
STARTUP_LINE = re.compile(r"Web 操作管理台: (http://[^\s]+)")
STARTUP_TIMEOUT_SECONDS = 20
ACTION_TIMEOUT_SECONDS = 30
NO_REPLAY_SECONDS = 6.0
STOP_TIMEOUT_SECONDS = 20
WHEN = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"


def _seed_approved_requirement(records: Path) -> str:
    sys.path.insert(0, str(SRC))
    from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan

    store = requirement_store(records)
    try:
        requirement = store.submit(PROJECT, "需求：强杀重启核对")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask(
                    task_id=TASK,
                    goal="实现 first",
                    files=("src/forgeloop/first.py",),
                    acceptance="first 的验收标准",
                    test_command=(sys.executable, "-c", "print('ok')"),
                    limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, PLAN_VERSION, "owner", source="kill-test")
        return requirement.req_id
    finally:
        store.close()


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


def _env(home: Path, mode: str) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    env["HOME"] = str(home)
    env["FAKE_PI_MODE"] = mode
    return env


def _start_serve(
    records: Path, home: Path, service_config: Path, mode: str
) -> tuple[subprocess.Popen[str], str]:
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
        env=_env(home, mode),
    )
    return process, _wait_for_startup(process)


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


def _stop(process: subprocess.Popen[str], *, hard: bool = False) -> None:
    if process.poll() is None:
        if hard:
            process.kill()
        else:
            process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:  # pragma: no cover - 兜底
            process.kill()
            process.wait(timeout=STOP_TIMEOUT_SECONDS)
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            stream.close()


def _action_states(records: Path, thread_id: str) -> list[str]:
    try:
        connection = sqlite3.connect(
            f"file:{project_records(records) / 'records.sqlite'}?mode=ro", uri=True
        )
    except sqlite3.Error:  # pragma: no cover - 记录库尚未建立
        return []
    try:
        rows = connection.execute(
            "SELECT state FROM actions WHERE task_id = ? ORDER BY started_at", (thread_id,)
        ).fetchall()
    except sqlite3.Error:  # pragma: no cover - 并发瞬时锁
        return []
    finally:
        connection.close()
    return [str(row[0]) for row in rows]


def _wait_for_started_action(records: Path, thread_id: str) -> None:
    deadline = time.monotonic() + ACTION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if "started" in _action_states(records, thread_id):
            return
        time.sleep(0.2)
    raise AssertionError(f"未在 {ACTION_TIMEOUT_SECONDS}s 内看到 {thread_id} 的 started 动作")


def _read_service(url: str) -> dict:
    with urllib.request.urlopen(f"{url}/api/service", timeout=10) as response:  # 真实回环地址
        return json.loads(response.read().decode("utf-8"))


def _read_progress(url: str) -> dict:
    with urllib.request.urlopen(f"{url}/api/progress", timeout=10) as response:  # 真实回环地址
        return json.loads(response.read().decode("utf-8"))


def test_kill_during_dev_is_reconciled_and_not_replayed(tmp_path: Path) -> None:
    records = tmp_path / "records"
    home = _pi_home(tmp_path)
    service_config = _service_config(tmp_path, home)
    req_id = _seed_approved_requirement(records)
    thread_id = f"task-{req_id}-v{PLAN_VERSION}-{TASK}"

    # 第一段：常驻进程在 dev 动作里挂住，然后被 kill -9
    first, _ = _start_serve(records, home, service_config, "hang")
    try:
        _wait_for_started_action(records, thread_id)
        states = _action_states(records, thread_id)
        assert states == ["started"]
    finally:
        _stop(first, hard=True)

    # 第二段：重启（这次假 PI 会成功，因此任何重放都会显形），核对 + 不重放
    second, url = _start_serve(records, home, service_config, "ok")
    try:
        document = _read_service(url)
        items = document["review_required"]
        kinds = {item["kind"] for item in items}
        assert "outstanding_action" in kinds
        action_item = next(item for item in items if item["kind"] == "outstanding_action")
        assert action_item["ref_id"] == thread_id
        assert "禁止盲目重放" in action_item["summary"]
        assert "节点: dev" in action_item["detail"]
        assert "actions list" in action_item["detail"]
        assert "候选 diff" in action_item["detail"]  # worker 的现场证据并入同一条
        assert document["worker"]["startup_review"], "启动核对项要进状态快照"
        assert document["worker"]["auto_advance"] is True

        # 页面「问题」段的数据源（/api/progress）同样要列出未核对动作与残留槽位：
        # 只出现在 /api/service 不算通过验收。
        progress_kinds = {item["kind"] for item in _read_progress(url)["issues"]}
        assert "outstanding_action" in progress_kinds
        assert "slot_residue" in progress_kinds

        # 不自动重放：等待若干个心跳周期，动作集合保持不变、任务没有往前跑。
        time.sleep(NO_REPLAY_SECONDS)
        assert _action_states(records, thread_id) == ["started"]
        after = _read_service(url)
        assert after["worker"]["last_tick"]["executed"] == []
        assert "未核对的未完成动作" in json.dumps(
            after["worker"]["last_tick"]["skipped"], ensure_ascii=False
        )
    finally:
        _stop(second)


def test_actions_list_shows_the_killed_action(tmp_path: Path) -> None:
    """清理入口可用：CLI 能列出被强杀留下的未完成动作（恢复由人工决定）。"""

    records = tmp_path / "records"
    home = _pi_home(tmp_path)
    service_config = _service_config(tmp_path, home)
    req_id = _seed_approved_requirement(records)
    thread_id = f"task-{req_id}-v{PLAN_VERSION}-{TASK}"

    process, _ = _start_serve(records, home, service_config, "hang")
    try:
        _wait_for_started_action(records, thread_id)
    finally:
        _stop(process, hard=True)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "forgeloop",
            "requirement",
            "actions",
            "list",
            "--task",
            thread_id,
            "--records-root",
            str(records),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=_env(home, "ok"),
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "dev" in result.stdout
