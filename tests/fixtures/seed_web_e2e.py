"""
为状态页的浏览器用例（frontend/tests/e2e）造一份真实记录。

写入的是**真实 SQLite 记录**，由真实 `forgeloop web` 服务读取后交给真实浏览器，
因此浏览器用例核对的是「记录 → 服务端 → 编译后的前端产物 → DOM」整条链，而不是
一份手工 HTML。用法：``python tests/fixtures/seed_web_e2e.py <records_root>``。

记录形状按页面要展示的层级造：一条需求、它的任务包（两个任务）、两个任务对应的
单任务记录（一个已交付、一个被阻断），以及一个未完成执行槽位——槽位对象既不是
需求也不是任务，用来核对「对不上记录的对象只显示为纯文本」。
"""

import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from forgeloop.domain.approval import Plan
from forgeloop.domain.project import project_data_root
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.projects import ProjectStore, project_records_path
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

PROJECT = "forgeloop"
PLAN_VERSION = 1
SLOT = "req-forgeloop-e2e"
TASK_CONFIG = {"pi_command": '["pi"]', "test_command": '["pytest"]'}


def _task(task_id: str, goal: str) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=goal,
        files=("frontend/src/render.ts",),
        acceptance=f"{task_id} 在状态页上可见",
        test_command=("pytest", "-q"),
    )


def _seed_requirement(records: Path) -> str:
    """写入需求与它的任务包；返回需求身份。"""

    store = RequirementStore(records)
    try:
        requirement = store.submit(PROJECT, "状态页要在真实浏览器里显示进展")
        store.record_task_plan(
            requirement.req_id,
            TaskPlan(
                task_plan_id="plan-e2e",
                requirement_id=requirement.req_id,
                project=PROJECT,
                plan_version=PLAN_VERSION,
                requirement_version=1,
                tasks=(
                    _task("first", "先交付一个正常任务"),
                    _task("blocked", "再留下一个被阻断的任务"),
                ),
                created_at=datetime.now(UTC),
            ),
        )
        store.record_task_run(requirement.req_id, PLAN_VERSION, "first", "delivered")
        store.record_task_run(requirement.req_id, PLAN_VERSION, "blocked", "in_progress")
        return requirement.req_id
    finally:
        store.close()


def _seed_tasks(records: Path, req_id: str) -> tuple[str, str]:
    """写入两个真实单任务记录（含各自方案）与一个未完成槽位；返回两个任务身份。"""

    delivered = requirement_task_id(req_id, PLAN_VERSION, "first")
    blocked = requirement_task_id(req_id, PLAN_VERSION, "blocked")
    stage = (
        (delivered, "先交付一个正常任务", "merged"),
        (blocked, "再留下一个被阻断的任务", "blocked"),
    )
    store = RecordStore(records)
    try:
        for task_id, goal, status in stage:
            store.create_task(
                task_id, PROJECT, f"浏览器用例：{goal}", TASK_CONFIG, limit_seconds=7200.0
            )
            # 真实记录里单任务带方案（页面的任务描述读它的 goal）；夹具同样写入，
            # 避免造出现实中不存在的「没有目标的已完成任务」。
            store.save_plan(
                Plan(
                    task_id,
                    1,
                    goal,
                    "frontend/src/render.ts",
                    f"{goal} 在状态页上可见",
                    ("pytest", "-q"),
                )
            )
            store.set_task_status(task_id, status)
        store.actions.claim_slot(SLOT, "advance")
    finally:
        store.close()
    return delivered, blocked


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法: seed_web_e2e.py <records_root>", file=sys.stderr)
        return 2
    root = Path(argv[1])
    root.mkdir(parents=True, exist_ok=True)
    projects = ProjectStore(project_records_path(root))
    try:
        projects.add(PROJECT, "ForgeLoop", str(root / "forgeloop-repo"))
    finally:
        projects.close()
    records = project_data_root(root, PROJECT) / "records.sqlite"
    records.parent.mkdir(parents=True, exist_ok=True)

    req_id = _seed_requirement(records)
    delivered, blocked = _seed_tasks(records, req_id)

    print(
        f"已写入 {records}：需求 {req_id}（任务包 v{PLAN_VERSION}），"
        f"任务 {delivered}（merged）与 {blocked}（blocked），槽位 {SLOT}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
