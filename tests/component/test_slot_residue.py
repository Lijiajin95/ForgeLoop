"""交付互斥槽位与需求级槽位获取时的残留判定/清理组件测试。

覆盖接入后的三类行为（判定只看权威动作记录的进程身份，不依据等待时长）：

- **已死残留**：获取交付槽位（``merge``/``release``）或需求级槽位时自动清理并继续，
  清理记录落在 ``slot_cleanups``；
- **存活占用**：绝不清理，交付路径在等待上限内继续等待并以具体原因报告；
- **不确定**：缺少进程身份时不清理、保持等待并如实报告原因。

同时核对 ``requirement slot list/clear`` 的既有语义未变。
"""

import argparse
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.cli.merge import cmd_merge
from forgeloop.cli.release import cmd_release
from forgeloop.cli.requirements import (
    cmd_requirement_slot_clear,
    cmd_requirement_slot_list,
)
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.dispatch import RequirementDispatcher, project_delivery_slot
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    TaskResult,
    TaskRunState,
)
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
DEAD_PID = 999_999_999
TASK_ID = "task-delivery"
PROJECT = "proj-x"


def patch_process_liveness(
    monkeypatch: pytest.MonkeyPatch,
    *,
    dead_pids: set[int] | None = None,
    unknown_pids: set[int] | None = None,
) -> None:
    """替换 ``os.kill`` 探测：死亡抛出查无此进程，不确定抛出无法确认。

    未列出的 pid 视为存活（``os.kill`` 正常返回）。探测接缝在 ``records.actions``
    中调用 ``os.kill``，所以组件级也能确定性地覆盖三种判定，不依赖真实进程状态。
    """

    dead = dead_pids or set()
    unknown = unknown_pids or set()

    def fake_kill(pid: int, _signal: int) -> None:
        if pid in dead:
            raise ProcessLookupError
        if pid in unknown:
            raise OSError("cannot probe")

    monkeypatch.setattr(os, "kill", fake_kill)


def seed_delivery_task(tmp_path: Path) -> None:
    """创建最小任务，使 ``cmd_merge``/``cmd_release`` 能走到交付互斥获取之前。"""

    store = RecordStore(tmp_path / "records.sqlite")
    try:
        store.create_task(TASK_ID, PROJECT, "输入", {"project_path": str(tmp_path)}, 7200.0)
    finally:
        store.close()


def merge_args(tmp_path: Path) -> argparse.Namespace:
    return argparse.Namespace(
        task_id=TASK_ID,
        records_root=str(tmp_path),
        message="",
        no_push=True,
        direct_push=False,
        require_checks="none",
        checks_timeout=0.0,
        delivery_timeout=0.0,
    )


def release_args(tmp_path: Path) -> argparse.Namespace:
    return argparse.Namespace(
        task_id=TASK_ID,
        tag="v0.0.1",
        records_root=str(tmp_path),
        message="",
        no_push=True,
        delivery_timeout=0.0,
    )


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


def approve_requirement(tmp_path: Path) -> str:
    """真实记录层：提交需求并批准含单个任务的任务包，返回 ``req_id``。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    try:
        requirement = store.submit("project-a", "需求：project-a")
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
        store.record_plan_approval(requirement.req_id, 1, "owner", source="batch-F5")
        return requirement.req_id
    finally:
        store.close()


def delivering_runner(calls: list[str]):
    def runner(execution) -> TaskResult:
        calls.append(execution.task.task_id)
        return TaskResult(
            TaskRunState.DELIVERED,
            TaskArtifact(
                task_id=execution.task.task_id,
                candidate_sha256="a" * 64,
                test_evidence_sha256="A" * 64,
                review_sha256="r" * 64,
                acceptance="accepted",
                authorization_source="plan-approval:alpha:v1:owner",
            ),
        )

    return runner


class TestDeliverySlotResidue:
    """``merge`` 与 ``release`` 获取同项目交付槽位时先处理残留。"""

    def test_merge_cleans_dead_residue_and_continues(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        seed_delivery_task(tmp_path)
        slot_key = project_delivery_slot(PROJECT)
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=PROJECT, pid=DEAD_PID)
        finally:
            seed.close()
        patch_process_liveness(monkeypatch, dead_pids={DEAD_PID})

        code = cmd_merge(merge_args(tmp_path))

        # 无交付记录使归并如实失败，但槽位已自动清理，证明获取路径先处理了残留。
        assert code == 1
        err = capsys.readouterr().err
        assert "已自动清理已死残留交付槽位" in err
        assert "任务尚无交付记录" in err
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is None
            history = verify.actions.cleanup_history(slot_key)
            assert len(history) == 1
            assert history[0].occupant_pid == DEAD_PID
        finally:
            verify.close()

    def test_release_cleans_dead_residue_and_continues(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        seed_delivery_task(tmp_path)
        slot_key = project_delivery_slot(PROJECT)
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=PROJECT, pid=DEAD_PID)
        finally:
            seed.close()
        patch_process_liveness(monkeypatch, dead_pids={DEAD_PID})

        code = cmd_release(release_args(tmp_path))

        assert code == 1
        err = capsys.readouterr().err
        assert "已自动清理已死残留交付槽位" in err
        assert "任务尚无归并与交付记录" in err
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is None
            assert len(verify.actions.cleanup_history(slot_key)) == 1
        finally:
            verify.close()

    def test_merge_keeps_waiting_and_reports_live_residue(self, tmp_path: Path, capsys) -> None:
        seed_delivery_task(tmp_path)
        slot_key = project_delivery_slot(PROJECT)
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=PROJECT, pid=os.getpid())
        finally:
            seed.close()

        code = cmd_merge(merge_args(tmp_path))

        assert code == 1
        err = capsys.readouterr().err
        assert "同项目交付" in err
        assert "仍存活" in err
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is not None
            assert verify.actions.cleanup_history(slot_key) == ()
        finally:
            verify.close()

    def test_release_keeps_waiting_and_reports_uncertain_residue(
        self, tmp_path: Path, capsys
    ) -> None:
        seed_delivery_task(tmp_path)
        slot_key = project_delivery_slot(PROJECT)
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            # 旧记录没有进程身份：无法确认存活，绝不清理。
            seed.actions.begin(f"{SLOT_PREFIX}{slot_key}", "execution_slot", role=PROJECT)
        finally:
            seed.close()

        code = cmd_release(release_args(tmp_path))

        assert code == 1
        err = capsys.readouterr().err
        assert "同项目交付" in err
        assert "缺少进程身份" in err
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is not None
            assert verify.actions.cleanup_history(slot_key) == ()
        finally:
            verify.close()


class TestRequirementSlotResidue:
    """需求级槽位获取时同样先处理残留。"""

    def test_dead_requirement_slot_is_cleaned_and_advance_continues(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        req_id = approve_requirement(tmp_path)
        slot_key = f"requirement:{req_id}"
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=req_id, pid=DEAD_PID)
        finally:
            seed.close()
        patch_process_liveness(monkeypatch, dead_pids={DEAD_PID})

        calls: list[str] = []
        progress = RequirementDispatcher(tmp_path).advance(req_id, delivering_runner(calls))

        assert calls == ["alpha"]
        assert progress.completed_tasks == ("alpha",)
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is None
            history = verify.actions.cleanup_history(slot_key)
            assert len(history) == 1
            assert history[0].occupant_pid == DEAD_PID
        finally:
            verify.close()

    def test_live_requirement_slot_is_not_cleaned_and_reports_reason(self, tmp_path: Path) -> None:
        req_id = approve_requirement(tmp_path)
        slot_key = f"requirement:{req_id}"
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=req_id, pid=os.getpid())
        finally:
            seed.close()

        calls: list[str] = []
        with pytest.raises(RequirementAlreadyRunningError) as excinfo:
            RequirementDispatcher(tmp_path).advance(req_id, delivering_runner(calls))

        # 报告具体原因，并保留人工核对入口；被拒绝时不启动业务图。
        assert "仍存活" in str(excinfo.value)
        assert "slot clear" in str(excinfo.value)
        assert calls == []
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is not None
            assert verify.actions.cleanup_history(slot_key) == ()
        finally:
            verify.close()

    def test_uncertain_requirement_slot_is_not_cleaned_and_reports_reason(
        self, tmp_path: Path
    ) -> None:
        req_id = approve_requirement(tmp_path)
        slot_key = f"requirement:{req_id}"
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.begin(f"{SLOT_PREFIX}{slot_key}", "execution_slot", role=req_id)
        finally:
            seed.close()

        calls: list[str] = []
        with pytest.raises(RequirementAlreadyRunningError) as excinfo:
            RequirementDispatcher(tmp_path).advance(req_id, delivering_runner(calls))

        assert "缺少进程身份" in str(excinfo.value)
        assert calls == []
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is not None
            assert verify.actions.cleanup_history(slot_key) == ()
        finally:
            verify.close()


class TestSlotCliSemanticsUnchanged:
    """``requirement slot list/clear`` 的对外语义保持原样。"""

    def test_list_then_clear_round_trip(self, tmp_path: Path, capsys) -> None:
        req_id = approve_requirement(tmp_path)
        slot_key = f"requirement:{req_id}"
        seed = RecordStore(tmp_path / "records.sqlite")
        try:
            seed.actions.claim_slot(slot_key, owner=req_id, pid=os.getpid())
        finally:
            seed.close()

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
        verify = RecordStore(tmp_path / "records.sqlite")
        try:
            assert verify.actions.slot_owner(slot_key) is None
        finally:
            verify.close()

    def test_clear_absent_slot_still_fails_loudly(self, tmp_path: Path, capsys) -> None:
        code = cmd_requirement_slot_clear(
            argparse.Namespace(records_root=str(tmp_path), slot="requirement:missing")
        )
        assert code == 1
        assert "未被占用" in capsys.readouterr().err
