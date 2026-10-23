"""常驻 worker 的真实执行边界（R2）：真实业务图 + 真实记录 + 假 PI 子进程。

核对的是「筛选通过 → 复用既有编排真的把需求推进下去」，以及不越界的部分：开关关闭
不执行、已交付不重复执行、已请求停止不启动新动作。真实模型不在本层验证（假 PI 只证明
编排），真实常驻进程的唤醒与断线续跑见 ``tests/system/test_serve_async.py``。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.service import ProjectProfile
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.graph.worker import ServiceWorker, WorkerRefused
from forgeloop.records.requirements import RequirementNotFoundError, RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

WHEN = datetime(2026, 10, 18, 8, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
TASK = "first"
PLAN_VERSION = 1
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


def _approved(root: Path) -> str:
    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：常驻 worker 自动接续")
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
        store.record_plan_approval(requirement.req_id, PLAN_VERSION, "owner", source="worker-it")
        return requirement.req_id
    finally:
        store.close()


def _pi_home(root: Path) -> Path:
    home = root / "pi-home"
    models = home / ".pi" / "agent" / "models.json"
    models.parent.mkdir(parents=True, exist_ok=True)
    models.write_text('{"providers": {}}', encoding="utf-8")
    return home


def _worker(root: Path, home: Path, *, auto_advance: bool = True) -> ServiceWorker:
    profile = ProjectProfile(
        name=PROJECT,
        path="",
        pi_command=FAKE_PI_COMMAND,
        test_command=(sys.executable, "-c", "print('ok')"),
        baseline="",
        pi_home=str(home),
    )
    return ServiceWorker(
        root,
        poll_seconds=1,
        auto_advance=auto_advance,
        projects={PROJECT: profile},
        process_home=str(home),
    )


def _action_count(root: Path, thread_id: str) -> int:
    store = RecordStore(root / "records.sqlite")
    try:
        return len(store.actions.history(thread_id))
    finally:
        store.close()


def _completed_nodes(root: Path, thread_id: str) -> list[str]:
    store = RecordStore(root / "records.sqlite")
    try:
        return [
            action.node
            for action in store.actions.history(thread_id)
            if action.state.value == "completed"
        ]
    finally:
        store.close()


class TestAdvanceOnce:
    def test_eligible_requirement_is_executed_by_worker(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        records = tmp_path / "records"
        home = _pi_home(tmp_path)
        req_id = _approved(records)
        worker = _worker(records, home)

        summaries = worker.advance_once()

        assert list(summaries) == [req_id]
        assert summaries[req_id]["status"], "推进结果必须带需求状态"
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        assert _completed_nodes(records, thread_id) == ["dev", "review", "test"]
        status = worker.status()
        assert status["last_tick"]["executed"] == [req_id]
        assert status["last_error"] == ""
        results = {item["req_id"]: item for item in status["last_tick"]["results"]}
        assert results[req_id]["status"] != "blocked"
        # 单任务走完 dev/review/test 后停在验收门，把决定权交回人工：
        # 这就是「自动接续」的边界——常驻进程不会代替所有者验收。
        record = RecordStore(records / "records.sqlite")
        try:
            task = record.get_task(thread_id)
        finally:
            record.close()
        assert task is not None
        assert task.status == "awaiting_acceptance"

    def test_delivered_task_is_not_executed_twice(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        records = tmp_path / "records"
        home = _pi_home(tmp_path)
        req_id = _approved(records)
        worker = _worker(records, home)
        worker.advance_once()
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        actions_before = _action_count(records, thread_id)

        second = worker.advance_once()

        # 第二轮不再有「下一步交给 agent」的任务：没有新动作，也不重复执行。
        assert second == {}
        assert _action_count(records, thread_id) == actions_before

    def test_stop_request_prevents_new_actions(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        records = tmp_path / "records"
        home = _pi_home(tmp_path)
        req_id = _approved(records)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        store = RecordStore(records / "records.sqlite")
        try:
            store.create_task(
                thread_id,
                PROJECT,
                "实现 first",
                {
                    "pi_command": json.dumps(list(FAKE_PI_COMMAND)),
                    "test_command": json.dumps([sys.executable, "-c", "print('ok')"]),
                },
                7200.0,
            )
            store.outcomes.request_stop(thread_id, "常驻 worker 用例：先请求停止")
        finally:
            store.close()
        worker = _worker(records, home)

        worker.advance_once()

        assert _completed_nodes(records, thread_id) == []
        record = RecordStore(records / "records.sqlite")
        try:
            task = record.get_task(thread_id)
        finally:
            record.close()
        assert task is not None
        assert task.status in {"stop_requested", "stopped", "interrupted"}


class TestSwitchOff:
    def test_poll_once_with_auto_advance_off_executes_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        records = tmp_path / "records"
        home = _pi_home(tmp_path)
        req_id = _approved(records)
        worker = _worker(records, home, auto_advance=False)

        worker.poll_once()

        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        store = RecordStore(records / "records.sqlite")
        try:
            assert store.get_task(thread_id) is None
            assert store.actions.history(thread_id) == ()
        finally:
            store.close()
        assert worker.status()["execution_enabled"] is False


class TestExplicitAdvanceAndRefusals:
    """页面「推进」按钮调用的就是 ``advance_requirement``：成功与三类拒绝都要有依据。"""

    def test_advance_requirement_runs_the_graph(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        req_id = _approved(root)
        worker = _worker(root, home)

        summary = worker.advance_requirement(req_id)

        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        assert _completed_nodes(root, thread_id) == ["dev", "review", "test"]
        assert summary, "显式推进必须回传进展摘要"

    def test_advance_requirement_refuses_when_not_eligible(self, tmp_path: Path) -> None:
        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        store = RequirementStore(root / "records.sqlite")
        try:
            requirement = store.submit(PROJECT, "没有任务包的需求")
        finally:
            store.close()
        worker = _worker(root, home)

        with pytest.raises(WorkerRefused) as refusal:
            worker.advance_requirement(requirement.req_id)

        assert "任务包" in str(refusal.value)

    def test_advance_requirement_rejects_unknown_requirement(self, tmp_path: Path) -> None:
        root = tmp_path / ".forgeloop"
        root.mkdir()
        worker = _worker(root, _pi_home(root))

        with pytest.raises(RequirementNotFoundError):
            worker.advance_requirement("req-不存在")

    def test_current_task_thread_id_refuses_with_reasons(self, tmp_path: Path) -> None:
        """停止入口要能定位当前任务；三种定位失败都必须给出可读原因。"""

        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        store = RequirementStore(root / "records.sqlite")
        try:
            no_plan = store.submit(PROJECT, "没有任务包")
            with_plan = store.submit(PROJECT, "有任务包")
            plan = TaskPlan(
                task_plan_id=f"plan-{with_plan.req_id}-{PLAN_VERSION}",
                requirement_id=with_plan.req_id,
                project=with_plan.project,
                plan_version=PLAN_VERSION,
                requirement_version=with_plan.version_count,
                tasks=(_planned(),),
                created_at=WHEN,
            )
            store.record_task_plan(with_plan.req_id, plan)
            store.record_plan_approval(with_plan.req_id, PLAN_VERSION, "owner", source="worker-it")
            # 「项目未配置」要走到档案判定，需求必须先有任务包（判定顺序：先任务包、后档案）。
            unknown_project = store.submit("未配置项目", "项目没有档案")
            unknown_plan = TaskPlan(
                task_plan_id=f"plan-{unknown_project.req_id}-{PLAN_VERSION}",
                requirement_id=unknown_project.req_id,
                project=unknown_project.project,
                plan_version=PLAN_VERSION,
                requirement_version=unknown_project.version_count,
                tasks=(_planned(),),
                created_at=WHEN,
            )
            store.record_task_plan(unknown_project.req_id, unknown_plan)
        finally:
            store.close()
        worker = _worker(root, home)

        with pytest.raises(WorkerRefused) as no_plan_refusal:
            worker.current_task_thread_id(no_plan.req_id)
        assert "还没有任务包" in str(no_plan_refusal.value)

        with pytest.raises(WorkerRefused) as no_profile_refusal:
            worker.current_task_thread_id(unknown_project.req_id)
        assert "config/service.toml" in str(no_profile_refusal.value)

        # 现场干净时能定位到当前任务（停止入口必须给出确定身份，不能靠猜）。
        assert worker.current_task_thread_id(with_plan.req_id) == requirement_task_id(
            with_plan.req_id, PLAN_VERSION, TASK
        )


class TestWorkerLifecycle:
    def test_stop_is_safe_before_start_and_reports_idle_ticks(self, tmp_path: Path) -> None:
        """没启动就停止不抛错；开关关闭时心跳只打点、不执行（`_tick` 的早退分支）。"""

        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        req_id = _approved(root)
        worker = _worker(root, home, auto_advance=False)

        worker.stop()  # 未启动：线程为 None

        worker.start()
        worker.stop()

        status = worker.status()
        assert status["last_tick"]["executed"] == []
        assert status["last_tick"]["candidates"] == [], "开关关闭时不做筛选"
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        assert _action_count(root, thread_id) == 0


class TestQueuedExplicitAdvance:
    """页面「推进本次」是**排队**的显式请求：受理即可返回，心跳执行；不受开关限制。"""

    def test_queued_request_runs_even_with_auto_advance_off(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        req_id = _approved(root)
        worker = _worker(root, home, auto_advance=False)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)

        worker.request_advance(req_id)

        assert worker.pending_advance() == (req_id,)
        assert worker.status()["pending_advance"] == [req_id]
        worker.poll_once()

        assert _completed_nodes(root, thread_id) == ["dev", "review", "test"]
        assert worker.pending_advance() == (), "请求被消费后不重复执行"

    def test_queued_request_for_ineligible_requirement_is_recorded_as_skipped(
        self, tmp_path: Path
    ) -> None:
        """排队时满足前提、执行时不再满足：如实记进 skipped，不硬跑。"""

        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        store = RequirementStore(root / "records.sqlite")
        try:
            requirement = store.submit(PROJECT, "还没有任务包的需求")
        finally:
            store.close()
        worker = _worker(root, home, auto_advance=False)

        worker.request_advance(requirement.req_id)
        worker.poll_once()

        skipped = {
            item["req_id"]: item["reason"] for item in worker.status()["last_tick"]["skipped"]
        }
        # 具体原因来自同一套筛选规则（比笼统的「不可推进」更有用）。
        assert "没有已批准任务包" in skipped[requirement.req_id]
        assert worker.status()["pending_advance"] == []

    def test_only_filter_does_not_touch_other_requirements(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``only`` 只执行集合内的需求：排队一条不会顺手推进另一条。"""

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        root = tmp_path / ".forgeloop"
        root.mkdir()
        home = _pi_home(root)
        first = _approved(root)
        second = _approved(root)
        worker = _worker(root, home, auto_advance=False)

        summaries = worker.advance_once(only={first})

        assert list(summaries) == [first]
        assert _completed_nodes(root, requirement_task_id(first, PLAN_VERSION, TASK)) == [
            "dev",
            "review",
            "test",
        ]
        assert _action_count(root, requirement_task_id(second, PLAN_VERSION, TASK)) == 0
