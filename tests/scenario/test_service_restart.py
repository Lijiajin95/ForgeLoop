"""常驻服务重启恢复的场景测试（R4）：真实记录 + 真实业务图 + 假 PI 子进程。

核对方案 §8 R4 的验收口径：

- 进程被强杀后留下的 ``started`` 动作与残留槽位，重启核对时**如实列出**（含副作用证据），
  worker 也**不自动重放**该任务；
- 人工核对并释放动作（``release_outstanding_action``，与 CLI ``requirement actions clear``
  同一入口）后，恢复路径可达：同一条需求能在常驻进程里被重新推进到验收门；
- 没有未核对现场的任务不受影响（重启核对不是全局停摆）。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.service import ProjectProfile
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.checkpoints import release_outstanding_action
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.scenario

WHEN = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"
PI_HOME = "/tmp/forgeloop-restart-home"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = (sys.executable, str(FIXTURES / "fake_pi.py"))


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        test_command=(sys.executable, "-c", "print('ok')"),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved(root: Path, text: str = "需求：重启恢复") -> str:
    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, text)
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(_planned(),),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, PLAN_VERSION, "owner", source="scenario")
        return requirement.req_id
    finally:
        store.close()


def _worker(root: Path) -> ServiceWorker:
    profile = ProjectProfile(
        name=PROJECT,
        path="",
        pi_command=FAKE_PI_COMMAND,
        test_command=(sys.executable, "-c", "print('ok')"),
        baseline="",
        pi_home=PI_HOME,
    )
    return ServiceWorker(
        root,
        poll_seconds=1,
        auto_advance=True,
        projects={PROJECT: profile},
        process_home=PI_HOME,
    )


def _kill_mid_dev(root: Path, thread_id: str) -> str:
    """模拟「进程在 dev 中途被杀」：建任务、登记 started 动作、占住执行槽位。"""

    store = RecordStore(root / "records.sqlite")
    try:
        store.create_task(
            thread_id,
            PROJECT,
            "实现 first",
            {
                # 与真实任务同形的配置：释放后同一条任务要能继续跑完图。
                "pi_command": json.dumps(list(FAKE_PI_COMMAND)),
                "test_command": json.dumps([sys.executable, "-c", "print('ok')"]),
            },
            7200.0,
        )
        action = store.actions.begin(thread_id, "dev")
        store.actions.claim_slot(
            f"requirement:{thread_id.split('-v')[0].removeprefix('task-')}", "advance"
        )
        (root / thread_id).mkdir(parents=True, exist_ok=True)
        (root / thread_id / "candidate.diff").write_text("partial diff\n", encoding="utf-8")
        # 被强杀的 dev 现场一定有工作副本：核对项要能报出这一点。
        (root / thread_id / "workspace").mkdir(exist_ok=True)
    finally:
        store.close()
    return action.action_id


class TestRestartReconciliation:
    def test_killed_action_is_listed_and_not_replayed(self, tmp_path: Path) -> None:
        req_id = _approved(tmp_path)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        action_id = _kill_mid_dev(tmp_path, thread_id)
        worker = _worker(tmp_path)

        review = worker.reconcile()

        kinds = {item["kind"] for item in review}
        assert kinds == {"outstanding_action", "slot_residue"}
        action_item = next(item for item in review if item["kind"] == "outstanding_action")
        assert action_item["ref_id"] == thread_id
        assert action_id in action_item["detail"]
        assert "候选 diff sha256:" in action_item["detail"]
        assert "工作副本存在" in action_item["detail"]

        # 不自动重放：筛选跳过，启动核对项进状态快照。
        runners, skipped = worker.survey()
        assert runners == {}
        assert "未核对的未完成动作" in skipped[req_id]
        status = worker.status()
        assert {item["kind"] for item in status["startup_review"]} == kinds
        assert status["startup_checked_at"]

    def test_clean_requirement_is_unaffected_by_other_residue(self, tmp_path: Path) -> None:
        """核对是逐条的：另一条需求的残留现场不阻断干净需求的自动接续。"""

        dirty = _approved(tmp_path, "需求：被强杀的那条")
        dirty_thread = requirement_task_id(dirty, PLAN_VERSION, TASK)
        _kill_mid_dev(tmp_path, dirty_thread)
        clean = _approved(tmp_path, "需求：干净的那条")
        worker = _worker(tmp_path)

        runners, skipped = worker.survey()

        assert list(runners) == [clean]
        assert "未核对的未完成动作" in skipped[dirty]


class TestRecoveryAfterManualRelease:
    def test_release_then_resume_reaches_acceptance_gate(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        req_id = _approved(tmp_path)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        action_id = _kill_mid_dev(tmp_path, thread_id)
        worker = _worker(tmp_path)
        assert worker.survey()[0] == {}

        released = release_outstanding_action(
            tmp_path,
            task_id=thread_id,
            action_id=action_id,
            by="owner",
            reason="人工核对副本与候选 diff 后释放未完成动作",
        )
        assert released.allowed is True
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.clear_slot(f"requirement:{req_id}", "人工核对后清理残留槽位")
        finally:
            store.close()

        runners, skipped = worker.survey()
        assert list(runners) == [req_id], skipped
        summaries = worker.advance_once()

        assert list(summaries) == [req_id]
        record = RecordStore(tmp_path / "records.sqlite")
        try:
            task = record.get_task(thread_id)
            nodes = [
                action.node
                for action in record.actions.history(thread_id)
                if action.state.value == "completed"
            ]
        finally:
            record.close()
        assert task is not None
        assert task.status == "awaiting_acceptance"
        assert nodes == ["dev", "review", "test"]
