"""状态页清单读取的单元测试：跨项目列出需求与任务的权威记录。

页面必须列出全部需求与任务，而既有记录层只有「按项目回查需求」与「按身份取
单个任务」。本文件固定两条只读取数的公共行为：返回全部对象、顺序确定（先按
创建时间、再按身份），空库返回空元组，且读取不写入任何记录。
"""

from pathlib import Path

import pytest

from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore


@pytest.fixture()
def record_store(tmp_path: Path):
    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


@pytest.fixture()
def requirement_store(tmp_path: Path):
    store = RequirementStore(tmp_path / "records.sqlite")
    yield store
    store.close()


def make_task(store: RecordStore, task_id: str, project: str) -> None:
    store.create_task(
        task_id,
        project,
        f"{project} 的原始需求文本",
        {"pi_command": '["pi"]', "test_command": '["pytest"]'},
        limit_seconds=100.0,
    )


class TestAllTasks:
    def test_empty_store_returns_empty_tuple(self, record_store: RecordStore) -> None:
        assert record_store.all_tasks() == ()

    def test_returns_tasks_of_every_project_in_creation_order(
        self, record_store: RecordStore
    ) -> None:
        make_task(record_store, "task-1", "forgeloop")
        make_task(record_store, "task-2", "other-project")

        tasks = record_store.all_tasks()

        assert [task.id for task in tasks] == ["task-1", "task-2"]
        assert [task.project for task in tasks] == ["forgeloop", "other-project"]
        assert tasks[0].status == "created"
        assert tasks[0].original_input == "forgeloop 的原始需求文本"

    def test_reading_does_not_change_records(self, record_store: RecordStore) -> None:
        make_task(record_store, "task-1", "forgeloop")

        before = record_store.get_task("task-1")
        record_store.all_tasks()

        assert record_store.get_task("task-1") == before


class TestAllRequirements:
    def test_empty_store_returns_empty_tuple(self, requirement_store: RequirementStore) -> None:
        assert requirement_store.all_requirements() == ()

    def test_returns_requirements_of_every_project(
        self, requirement_store: RequirementStore
    ) -> None:
        first = requirement_store.submit("forgeloop", "第一条需求")
        second = requirement_store.submit("other-project", "第二条需求")

        requirements = requirement_store.all_requirements()

        assert [item.req_id for item in requirements] == [first.req_id, second.req_id]
        assert [item.project for item in requirements] == ["forgeloop", "other-project"]

    def test_latest_version_text_is_readable_per_requirement(
        self, requirement_store: RequirementStore
    ) -> None:
        created = requirement_store.submit("forgeloop", "原始需求")
        requirement_store.append(created.req_id, "追加澄清")

        requirements = requirement_store.all_requirements()

        assert requirements[0].version_count == 2
        assert requirements[0].latest.text == "追加澄清"
