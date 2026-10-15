"""F5 场景：执行槽位残留判定与安全清理接入需求级推进后的恢复流程。

用真实记录层（SQLite 权威记录 + 执行槽位）与确定性替身执行器，串起一条完整的
「进程被中断留下槽位 → 下一次推进先判定 → 按结论处置」流程，覆盖三类行为：

- **已死残留**：下一次推进自动清理并写入清理记录，随后继续推进且不重放已完成任务；
- **存活占用**：一律不清理，报告「仍存活」，人工核对清理后推进恢复；
- **不确定占用**：缺少进程身份时不清理、保持占用并报告原因，人工核对清理后推进恢复。

判定只看权威动作记录的进程身份，不依据等待时长或心跳年龄；重复推进不重放业务图。
"""

import argparse
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.cli.requirements import (
    cmd_requirement_slot_clear,
    cmd_requirement_slot_list,
)
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.dispatch import RequirementDispatcher
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.scenario

WHEN = datetime(2026, 10, 15, 10, 30, tzinfo=UTC)
# 远超本机 pid 上限且必然不存在，真实 ``os.kill(pid, 0)`` 判为已死。
DEAD_PID = 999_999_999
OWNER = "owner"


def _planned_alpha() -> PlannedTask:
    return PlannedTask(
        task_id="alpha",
        goal="实现 alpha",
        files=("src/forgeloop/alpha.py",),
        acceptance="alpha 的验收标准",
        test_command=("uv", "run", "pytest", "tests/alpha.py", "-q"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _artifact(task_id: str, marker: str = "a") -> TaskArtifact:
    return TaskArtifact(
        task_id=task_id,
        candidate_sha256=marker * 64,
        test_evidence_sha256=marker.upper() * 64,
        review_sha256="r" * 64,
        acceptance="accepted",
        authorization_source=f"plan-approval:{task_id}:v1:owner",
    )


def approve_requirement(tmp_path: Path, project: str = "project-a") -> str:
    """真实记录层：提交需求并取得含单个任务的任务包批准，返回 ``req_id``。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    try:
        requirement = store.submit(project, f"需求：{project}")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-1",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=(_planned_alpha(),),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, 1, OWNER, source="batch-F5")
        return requirement.req_id
    finally:
        store.close()


def delivering_runner(calls: list[str]):
    """确定性替身执行器：记录调用并交付带完整身份的唯一任务。"""

    def runner(execution) -> TaskResult:
        calls.append(execution.task.task_id)
        return TaskResult(TaskRunState.DELIVERED, _artifact(execution.task.task_id))

    return runner


def seed_requirement_slot(
    tmp_path: Path, req_id: str, *, pid: int | None = DEAD_PID, legacy: bool = False
) -> None:
    """按现场需要登记一个需求级槽位占用（真实或缺少进程身份的旧记录）。"""

    store = RecordStore(tmp_path / "records.sqlite")
    try:
        slot_key = f"requirement:{req_id}"
        if legacy:
            store.actions.begin(f"{SLOT_PREFIX}{slot_key}", "execution_slot", role=req_id)
        else:
            store.actions.claim_slot(slot_key, owner=req_id, pid=pid)
    finally:
        store.close()


def cleanup_history(tmp_path: Path, slot_key: str):
    store = RecordStore(tmp_path / "records.sqlite")
    try:
        return store.actions.cleanup_history(slot_key)
    finally:
        store.close()


def slot_occupied(tmp_path: Path, slot_key: str) -> bool:
    store = RecordStore(tmp_path / "records.sqlite")
    try:
        return store.actions.slot_owner(slot_key) is not None
    finally:
        store.close()


class TestDeadResidueScenario:
    """已死残留：推进自动清理并留档，随后继续且不重放。"""

    def test_dead_requirement_slot_is_cleaned_recorded_and_advance_continues(
        self, tmp_path: Path
    ) -> None:
        req_id = approve_requirement(tmp_path)
        seed_requirement_slot(tmp_path, req_id)
        calls: list[str] = []
        dispatcher = RequirementDispatcher(tmp_path)

        first = dispatcher.advance(req_id, delivering_runner(calls))

        assert calls == ["alpha"]
        assert first.completed_tasks == ("alpha",)
        slot_key = f"requirement:{req_id}"
        assert not slot_occupied(tmp_path, slot_key)
        history = cleanup_history(tmp_path, slot_key)
        assert len(history) == 1
        assert history[0].occupant_pid == DEAD_PID
        assert history[0].occupant_owner == req_id
        assert str(DEAD_PID) in history[0].reason

        # 再次推进：槽位已空闲，不重放已交付任务，也不产生第二条清理记录。
        second = dispatcher.advance(req_id, delivering_runner(calls))
        assert calls == ["alpha"]
        assert second.completed_tasks == ("alpha",)
        assert len(cleanup_history(tmp_path, slot_key)) == 1


class TestLiveResidueScenario:
    """存活占用：不清理、报告原因；人工核对清理后推进恢复。"""

    def test_live_requirement_slot_blocks_then_operator_clear_recovers(
        self, tmp_path: Path, capsys
    ) -> None:
        req_id = approve_requirement(tmp_path)
        seed_requirement_slot(tmp_path, req_id, pid=os.getpid())
        calls: list[str] = []
        dispatcher = RequirementDispatcher(tmp_path)

        with pytest.raises(RequirementAlreadyRunningError) as excinfo:
            dispatcher.advance(req_id, delivering_runner(calls))

        assert "仍存活" in str(excinfo.value)
        assert calls == []  # 被拒绝时不启动业务图
        slot_key = f"requirement:{req_id}"
        assert slot_occupied(tmp_path, slot_key)
        assert cleanup_history(tmp_path, slot_key) == ()

        # 人工核对入口：列表列出占位者，清理后推进恢复。
        assert cmd_requirement_slot_list(argparse.Namespace(records_root=str(tmp_path))) == 0
        listing = capsys.readouterr().out
        assert slot_key in listing
        assert "清理" in listing
        assert (
            cmd_requirement_slot_clear(
                argparse.Namespace(records_root=str(tmp_path), slot=slot_key)
            )
            == 0
        )
        assert not slot_occupied(tmp_path, slot_key)

        recovered = dispatcher.advance(req_id, delivering_runner(calls))
        assert calls == ["alpha"]
        assert recovered.completed_tasks == ("alpha",)


class TestUncertainResidueScenario:
    """不确定占用：不清理、保持占用并报告原因；人工核对清理后推进恢复。"""

    def test_legacy_requirement_slot_keeps_waiting_and_reports_then_clear_recovers(
        self, tmp_path: Path
    ) -> None:
        req_id = approve_requirement(tmp_path)
        seed_requirement_slot(tmp_path, req_id, legacy=True)
        calls: list[str] = []
        dispatcher = RequirementDispatcher(tmp_path)

        with pytest.raises(RequirementAlreadyRunningError) as excinfo:
            dispatcher.advance(req_id, delivering_runner(calls))

        assert "缺少进程身份" in str(excinfo.value)
        assert calls == []
        slot_key = f"requirement:{req_id}"
        assert slot_occupied(tmp_path, slot_key)
        assert cleanup_history(tmp_path, slot_key) == ()

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.clear_slot(slot_key, detail="cleared by operator")
        finally:
            store.close()

        recovered = dispatcher.advance(req_id, delivering_runner(calls))
        assert calls == ["alpha"]
        assert recovered.completed_tasks == ("alpha",)
