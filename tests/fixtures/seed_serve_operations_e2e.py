"""为「页面操作入口」的真实浏览器用例造一份真实现场。

写出真实 ``records.sqlite``（一条**已规划但未批准**的需求：页面的批准按钮才有东西可批）
与一份真实的 ``service.toml``（``auto_advance = true`` + 假 PI），并打印现场路径。用法：

    python tests/fixtures/seed_serve_operations_e2e.py <现场目录>

现场目录下会生成 ``records/``、``pi-home/``（含可用的 ``.pi/agent/models.json``）与
``service.toml``；真实 ``forgeloop serve`` 读它们，真实 Chromium 打开页面操作。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.records.requirements import RequirementStore

PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"
WHEN = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)

FAKE_PI = [sys.executable, str(Path(__file__).resolve().parent / "fake_pi.py")]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法: seed_serve_operations_e2e.py <现场目录>", file=sys.stderr)
        return 2
    base = Path(argv[1]).resolve()
    records = base / "records"
    home = base / "pi-home"
    models = home / ".pi" / "agent" / "models.json"
    models.parent.mkdir(parents=True, exist_ok=True)
    models.write_text('{"providers": {}}', encoding="utf-8")
    records.mkdir(parents=True, exist_ok=True)

    store = RequirementStore(records / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "浏览器用例：待批准的需求")
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
    finally:
        store.close()

    test_command = json.dumps([sys.executable, "-c", "print('ok')"])
    (base / "service.toml").write_text(
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
                f'path = "{Path(__file__).resolve().parents[2]}"',
                f"pi_command = {json.dumps(FAKE_PI)}",
                f"test_command = {test_command}",
                'baseline = ""',
                f'pi_home = "{home}"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    print(f"已写入现场：{base}（需求 {requirement.req_id}，任务包 v{PLAN_VERSION}，未批准）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
