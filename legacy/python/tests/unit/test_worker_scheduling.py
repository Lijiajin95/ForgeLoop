"""常驻 worker 的只读筛选与「自动接续」开关（R2）。

覆盖三块确定性规则：``worker_eligibility`` 的四条前提（项目已配置、任务包已批准、
下一步主体是 agent、PI HOME 与进程 HOME 一致）、``survey()`` 对真实记录的只读筛选
（含逐条跳过原因、不写任何记录）、以及 ``auto_advance`` 关闭时**不推进**。

真实执行（假 PI、真实业务图）在 ``tests/integration/test_worker_execution.py``，
常驻进程的唤醒与断线续跑在 ``tests/system/test_serve_async.py``。
"""

import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.service import ProjectProfile
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.graph.worker import ServiceWorker, worker_eligibility
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 18, 8, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
TASK = "first"
PLAN_VERSION = 1
PI_HOME = "/tmp/forgeloop-pi-home"
PROFILE = ProjectProfile(
    name=PROJECT,
    path="/tmp/forgeloop-project",
    pi_command=("pi", "--mode", "rpc"),
    test_command=(sys.executable, "-c", "print('ok')"),
    baseline="",
    pi_home=PI_HOME,
)


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        test_command=(sys.executable, "-c", "print('ok')"),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _requirement(root: Path, *, approved: bool = True, project: str = PROJECT) -> str:
    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(project, "需求：常驻 worker 自动接续")
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
        if approved:
            store.record_plan_approval(
                requirement.req_id, PLAN_VERSION, "owner", source="worker-test"
            )
        return requirement.req_id
    finally:
        store.close()


def _records_state(root: Path) -> dict[str, int]:
    """关键表行数：用于证明筛选不产生任何业务事实。

    只比行数不比字节：打开记录库会按需执行 schema bootstrap（``CREATE TABLE IF NOT
    EXISTS``），这与 ``web`` 查询的既有口径一致，属查询代价而不是业务写入；业务事实
    （需求、任务包、批准、任务、动作）新增一条都会在这里显形。
    """

    import sqlite3

    path = root / "records.sqlite"
    if not path.is_file():
        return {}
    counts: dict[str, int] = {}
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for table in ("requirements", "requirement_task_plans", "approvals", "tasks", "actions"):
            try:
                counts[table] = connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                counts[table] = -1
    finally:
        connection.close()
    return counts


def _worker(
    root: Path,
    *,
    auto_advance: bool = True,
    projects: dict[str, ProjectProfile] | None = None,
    process_home: str = PI_HOME,
) -> ServiceWorker:
    return ServiceWorker(
        root,
        poll_seconds=1,
        auto_advance=auto_advance,
        projects={PROJECT: PROFILE} if projects is None else projects,
        process_home=process_home,
    )


class TestEligibility:
    def test_all_conditions_met_is_eligible(self) -> None:
        decision = worker_eligibility(
            project_configured=True,
            plan_approved=True,
            next_actor="agent",
            process_home=PI_HOME,
            project_home=PI_HOME,
        )
        assert decision.eligible is True
        assert decision.reason == ""

    @pytest.mark.parametrize(
        ("overrides", "needle"),
        [
            ({"project_configured": False}, "config/service.toml"),
            ({"plan_approved": False}, "没有已批准任务包"),
            ({"has_outstanding_action": True}, "未核对的未完成动作"),
            ({"next_actor": "user"}, "常驻进程不代劳"),
            ({"next_actor": ""}, "unknown"),
            ({"process_home": ""}, "没有 HOME"),
            ({"process_home": "/another/home"}, "HOME 不一致"),
        ],
    )
    def test_each_missing_condition_is_refused_with_reason(
        self, overrides: dict[str, object], needle: str
    ) -> None:
        base: dict[str, object] = {
            "project_configured": True,
            "plan_approved": True,
            "next_actor": "agent",
            "process_home": PI_HOME,
            "project_home": PI_HOME,
        }
        base.update(overrides)
        decision = worker_eligibility(**base)  # type: ignore[arg-type]
        assert decision.eligible is False
        assert needle in decision.reason

    def test_decision_is_deterministic(self) -> None:
        arguments: dict[str, object] = {
            "project_configured": True,
            "plan_approved": False,
            "next_actor": "agent",
            "process_home": PI_HOME,
            "project_home": PI_HOME,
        }
        first = worker_eligibility(**arguments)  # type: ignore[arg-type]
        second = worker_eligibility(**arguments)  # type: ignore[arg-type]
        assert first == second


class TestSurvey:
    def test_approved_requirement_is_a_candidate(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        worker = _worker(tmp_path)

        runners, skipped = worker.survey()

        assert list(runners) == [req_id]
        assert skipped == {}
        runner = runners[req_id]
        assert runner.plan_version == PLAN_VERSION
        assert runner.project == PROJECT
        assert runner.pi_command == PROFILE.pi_command
        assert runner.project_path == PROFILE.path
        status = worker.status()
        assert status["last_tick"]["candidates"] == [req_id]
        assert status["executable_projects"] == [PROJECT]

    def test_project_without_profile_is_skipped(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path, project="other")
        worker = _worker(tmp_path)

        runners, skipped = worker.survey()

        assert runners == {}
        assert "项目未在 config/service.toml 配置" in skipped[req_id]

    def test_unapproved_plan_is_skipped(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path, approved=False)
        worker = _worker(tmp_path)

        runners, skipped = worker.survey()

        assert runners == {}
        assert "没有已批准任务包" in skipped[req_id]

    def test_home_mismatch_is_skipped(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        worker = _worker(tmp_path, process_home="/somewhere/else")

        runners, skipped = worker.survey()

        assert runners == {}
        assert "HOME 不一致" in skipped[req_id]
        assert worker.status()["executable_projects"] == []

    def test_no_projects_means_no_scan(self, tmp_path: Path) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=True, projects={})
        runners, skipped = worker.survey()
        assert runners == {} and skipped == {}
        assert not (tmp_path / "records.sqlite").exists()

    def test_outstanding_action_blocks_auto_advance(self, tmp_path: Path) -> None:
        """未核对的未完成动作是独立红线：即使其余条件都满足也不自动推进。"""

        req_id = _requirement(tmp_path)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            record_store.create_task(
                thread_id,
                PROJECT,
                "实现 first",
                {"pi_command": "[]", "test_command": "[]"},
                7200.0,
            )
            record_store.actions.begin(thread_id, "dev")
        finally:
            record_store.close()
        worker = _worker(tmp_path)

        runners, skipped = worker.survey()

        assert runners == {}
        assert "未核对的未完成动作" in skipped[req_id]
        review = worker.reconcile()
        kinds = {item["kind"] for item in review}
        assert kinds == {"outstanding_action"}
        item = review[0]
        assert item["ref_id"] == thread_id
        assert "dev" in item["summary"]
        assert "actions list" in item["detail"]
        # 核对项进状态快照，页面与 /api/service 能看到同一份清单。
        assert worker.status()["startup_review"] == [dict(item)]
        assert worker.status()["startup_checked_at"]

    def test_survey_is_read_only_and_repeatable(self, tmp_path: Path) -> None:
        _requirement(tmp_path)
        worker = _worker(tmp_path)
        before = _records_state(tmp_path)

        first = worker.survey()
        second = worker.survey()

        assert list(first[0]) == list(second[0])
        assert first[1] == second[1]
        # 表不存在与表为空都表示「没有业务事实」：只比归一化后的行数，不比 schema 是否已建。
        after = _records_state(tmp_path)
        assert {table: max(0, count) for table, count in after.items()} == {
            table: max(0, count) for table, count in before.items()
        }
        assert after["tasks"] <= 0 and after["actions"] <= 0


class TestRecoveryAfterRelease:
    def test_released_action_allows_advance_again(self, tmp_path: Path) -> None:
        """人工核对并释放后，筛选重新放行——恢复路径始终可达。"""

        from forgeloop.records.checkpoints import release_outstanding_action

        req_id = _requirement(tmp_path)
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            record_store.create_task(
                thread_id,
                PROJECT,
                "实现 first",
                {"pi_command": "[]", "test_command": "[]"},
                7200.0,
            )
            action = record_store.actions.begin(thread_id, "dev")
        finally:
            record_store.close()
        worker = _worker(tmp_path)
        assert worker.survey()[0] == {}

        released = release_outstanding_action(
            tmp_path, task_id=thread_id, by="owner", reason="人工核对现场后释放"
        )

        assert released.allowed is True
        assert released.release is not None
        assert released.release.action_id == action.action_id
        runners, skipped = worker.survey()
        assert list(runners) == [req_id]
        assert skipped == {}


class TestAutoAdvanceSwitch:
    def test_poll_once_with_switch_off_does_not_execute(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        worker = _worker(tmp_path, auto_advance=False)

        worker.poll_once()

        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            assert store.get_task(thread_id) is None
            assert store.actions.history(thread_id) == ()
        finally:
            store.close()
        # 开关关闭时连筛选都不做：状态里没有候选。
        assert worker.status()["last_tick"]["candidates"] == []
        assert worker.status()["execution_enabled"] is False

    def test_survey_does_not_execute_even_when_enabled(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        worker = _worker(tmp_path)

        runners, _ = worker.survey()

        assert list(runners) == [req_id]
        thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            assert store.get_task(thread_id) is None
        finally:
            store.close()
