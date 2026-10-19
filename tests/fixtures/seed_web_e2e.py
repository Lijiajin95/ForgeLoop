"""
为状态页的浏览器用例（frontend/tests/e2e）造一份真实记录。

写入的是**真实 SQLite 记录**，由真实 `forgeloop web` 服务读取后交给真实浏览器，
因此浏览器用例核对的是「记录 → 服务端 → 编译后的前端产物 → DOM」整条链，而不是
一份手工 HTML。用法：``python tests/fixtures/seed_web_e2e.py <records_root>``。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from forgeloop.domain.project import project_data_root
from forgeloop.records.projects import ProjectStore, project_records_path
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

PROJECT = "forgeloop"
BLOCKED_TASK = "task-e2e-blocked"
SLOT = "req-forgeloop-e2e"


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

    requirement_store = RequirementStore(records)
    try:
        requirement = requirement_store.submit(PROJECT, "状态页要在真实浏览器里显示进展")
    finally:
        requirement_store.close()

    store = RecordStore(records)
    try:
        store.create_task(
            BLOCKED_TASK,
            PROJECT,
            "浏览器用例的阻断任务",
            {"pi_command": '["pi"]', "test_command": '["pytest"]'},
            limit_seconds=7200.0,
        )
        store.set_task_status(BLOCKED_TASK, "blocked")
        store.actions.claim_slot(SLOT, "advance")
    finally:
        store.close()

    print(f"已写入 {records}：需求 {requirement.req_id}，阻断任务 {BLOCKED_TASK}，槽位 {SLOT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
