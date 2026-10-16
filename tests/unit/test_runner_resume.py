"""续跑接缝的端到端行为：停在业务节点的检查点必须由真实执行器就地续跑。

本任务此前只把 ``TaskExecution.resume`` 置真，却没有任何用例证明生产入口
``graph.builder.RequirementTaskRunner`` 真的消费它：停在 ``dev`` 的检查点交给
执行器仍返回等待人工决定、``dev`` 不再执行。这里用真实业务图、真实 LangGraph
检查点、真实动作记录与假 PI 子进程复现「进程在 dev 前被中断」的现场，验证：

- ``RequirementExecutor`` 经只读检查点判定把 ``resume=True`` 交给真实执行器；
- 执行器据此调用 ``graph.invoke(None)`` 就地续跑，``dev``/``review``/``test`` 真正
  执行并停在验收门；
- 同一现场在 ``resume=False``（未判定可续跑）时不重放，保持等待人工决定语义。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.runnables import RunnableConfig
from langgraph.types import Command

from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import RequirementTaskRunner, build_graph, requirement_task_id
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.requirements import (
    RequirementExecutor,
    TaskExecution,
    TaskRunState,
)
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id="first",
        goal="实现 first",
        files=("src/first.py",),
        acceptance="first 的验收标准",
        # 不依赖外部测试替身：真实子进程立即成功。
        test_command=(sys.executable, "-c", "print('ok')"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _runner(tmp_path: Path, req_id: str) -> RequirementTaskRunner:
    return RequirementTaskRunner(
        records_root=tmp_path,
        req_id=req_id,
        plan_version=1,
        project="ForgeLoop",
        pi_command=tuple(FAKE_PI_COMMAND),
        pi_timeout_seconds=120.0,
    )


def _park_at_dev(tmp_path: Path, monkeypatch) -> tuple[RequirementTaskRunner, PlannedTask, str]:
    """建立已批准需求，并把映射出的单任务图停到 ``dev`` 之前。

    用真实图与真实检查点走完 plan 与方案批准门，再以 ``interrupt_before=['dev']``
    在 dev 前落一条 ``next=('dev',)`` 的检查点，等价于进程在 dev 前被中断的现场。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "ok")
    task = _planned()

    requirement_store = RequirementStore(tmp_path / "records.sqlite")
    try:
        requirement = requirement_store.submit("ForgeLoop", "需求：检查点续跑")
        runner = _runner(tmp_path, requirement.req_id)
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-1",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=runner.plan_version,
            requirement_version=requirement.version_count,
            tasks=(task,),
            created_at=WHEN,
        )
        requirement_store.record_task_plan(requirement.req_id, plan)
        requirement_store.record_plan_approval(
            requirement.req_id, runner.plan_version, "owner", source="batch-resume"
        )
    finally:
        requirement_store.close()

    task_id = requirement_task_id(runner.req_id, runner.plan_version, task.task_id)
    store = RecordStore(tmp_path / "records.sqlite")
    graph = None
    try:
        store.create_task(
            task_id, runner.project, task.goal, runner._config(task), task.limits.limit_seconds
        )
        context = NodeContext.for_task(store, tmp_path, task_id)
        graph = build_graph(context, tmp_path / "checkpoints.sqlite")
        config: RunnableConfig = {"configurable": {"thread_id": task_id}}
        # 先跑到方案批准门（gate_plan_approval 调 interrupt 暂停）。
        graph.invoke({"task_id": task_id}, config)
        # 记录派生方案批准并恢复，但以 interrupt_before 停在 dev 之前。
        runner._approve_plan(store, task_id)
        graph.invoke(
            Command(resume={"decision": "approved"}),
            config,
            interrupt_before=["dev"],
        )
        snapshot = graph.get_state(config)
        assert set(snapshot.next) == {"dev"}, snapshot.next
    finally:
        if graph is not None:
            conn = getattr(graph.checkpointer, "conn", None)
            if conn is not None:
                conn.close()
        store.close()

    return runner, task, task_id


class TestRunnerConsumesResume:
    def test_executor_resumes_parked_dev_to_acceptance_gate(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        runner, task, task_id = _park_at_dev(tmp_path, monkeypatch)
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            # 不注入 checkpoints：由执行器从自身记录根派生只读读取接缝。
            progress = RequirementExecutor(store, runner.req_id, runner).advance()
            run = store.task_run(runner.req_id, runner.plan_version, task.task_id)
        finally:
            store.close()

        # dev/review/test 真正执行：候选 diff 与验收门现场都由真实图产生。
        assert (tmp_path / task_id / "candidate.diff").is_file()
        assert run is not None
        assert run.state == TaskRunState.AWAITING_USER.value
        assert progress.current_task == task.task_id
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            record = record_store.get_task(task_id)
        finally:
            record_store.close()
        assert record is not None
        assert record.status == "awaiting_acceptance"

    def test_resume_disabled_keeps_waiting_without_replaying(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        runner, task, task_id = _park_at_dev(tmp_path, monkeypatch)

        result = runner(TaskExecution(task=task, resume=False))

        assert result.state is TaskRunState.AWAITING_USER
        # 未判定可续跑时不启动节点：候选 diff 与 dev 动作都不存在。
        assert not (tmp_path / task_id / "candidate.diff").exists()
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            assert store.actions.outstanding(task_id) is None
            assert all(action.node != "dev" for action in store.actions.history(task_id))
        finally:
            store.close()

    def test_resume_true_reaches_gate_without_replaying_completed_nodes(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        runner, task, task_id = _park_at_dev(tmp_path, monkeypatch)

        result = runner(TaskExecution(task=task, resume=True))

        assert result.state is TaskRunState.AWAITING_USER
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            history = store.actions.history(task_id)
        finally:
            store.close()
        completed = [action.node for action in history if action.state.value == "completed"]
        # 每个动作节点只执行一次：续跑不重放已完成的 dev/review/test。
        assert sorted(completed) == ["dev", "review", "test"]
        report = json.loads(
            (tmp_path / task_id / "reviews.jsonl").read_text(encoding="utf-8").splitlines()[0]
        )
        assert report["blocking_issues"] == []
