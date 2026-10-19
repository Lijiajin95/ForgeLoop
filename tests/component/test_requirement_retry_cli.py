"""``requirement retry`` 的组件级真实用例：真实检查点、真实动作记录、真实业务图。

覆盖本任务验收的核心行为（不依赖 fixture 伪造成功）：

- 命令注册后，``--by``/``--reason`` 必填，缺项由解析层拒绝；``--pi-command`` 可省略
  （运行状态可能已切到 DSH），缺可用命令时在启动执行器前 fail-closed；
- 对业务节点返回 ``halted_reason`` 的真实中断现场，命令在记录人工决定后立即驱动
  ``RequirementTaskRunner`` 就地续跑：``dev`` 重入一次后继续 ``review``/``test``，
  不重放更早的 ``plan``；
- 省略 ``--task`` 时，需求恰有一个中断任务则自动选中并打印实际处理任务身份；
- 校验失败（空白理由）不写决定、不重入图，保留中断现场；
- ``requirement status`` 回查最近一次人工续跑决定（JSON 与文本两种形态）。
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.types import Command

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.builder import RequirementTaskRunner, build_graph, requirement_task_id
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.requirements import TaskExecution, TaskRunState
from forgeloop.records.checkpoints import (
    action_releases,
    latest_retry_decision,
    outstanding_action_node,
)
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 16, 10, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"
REASON = "人工核对检查点现场后确认可续跑"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]
PI_COMMAND = json.dumps(FAKE_PI_COMMAND)


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        # 真实子进程立即成功，不依赖外部测试替身。
        test_command=(sys.executable, "-c", "print('ok')"),
        depends_on=(),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved(root: Path) -> str:
    """建立已批准的单任务需求，返回需求身份。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：CLI 人工续跑")
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
        store.record_plan_approval(
            requirement.req_id, PLAN_VERSION, "owner", source="batch-retry-cli"
        )
        return requirement.req_id
    finally:
        store.close()


def _runner(root: Path, req_id: str) -> RequirementTaskRunner:
    return RequirementTaskRunner(
        records_root=root,
        req_id=req_id,
        plan_version=PLAN_VERSION,
        project=PROJECT,
        pi_command=tuple(FAKE_PI_COMMAND),
        pi_timeout_seconds=120.0,
    )


def _halted(root: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """用真实业务图把 ``dev`` 跑到返回 halted_reason 的真实中断现场。

    返回需求身份与单任务线程身份；检查点由真实 ``SqliteSaver`` 落库，``next`` 为空、
    ``halted_reason`` 为 ``pi_dev_unsettled``，与生产中断现场一致。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "unsettled")
    req_id = _approved(root)
    runner = _runner(root, req_id)
    result = runner(TaskExecution(task=_planned()))
    assert result.state is TaskRunState.FAILED, result
    return req_id, requirement_task_id(req_id, PLAN_VERSION, TASK)


def _halted_action_unchecked(root: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str, str]:
    """用真实业务图建立 ``action_unchecked:dev`` 的真实未完成动作现场。

    走完方案批准门后、恢复前登记一个 ``started`` 动作；恢复后 ``dev`` 的 B03 闸门
    因它落下 ``halted_reason=action_unchecked:dev``，图路由到 END、``next`` 为空，
    与推进进程在 dev 中途被杀留下的现场一致。返回需求身份、线程身份与动作身份。
    """

    monkeypatch.setenv("FAKE_PI_MODE", "ok")
    req_id = _approved(root)
    runner = _runner(root, req_id)
    thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
    task = _planned()
    store = RecordStore(root / "records.sqlite")
    graph = None
    action_id = ""
    try:
        store.create_task(
            thread_id, PROJECT, task.goal, runner._config(task), task.limits.limit_seconds
        )
        context = NodeContext.for_task(store, root, thread_id)
        graph = build_graph(context, root / "checkpoints.sqlite")
        config = cast(RunnableConfig, {"configurable": {"thread_id": thread_id}})
        graph.invoke({"task_id": thread_id}, config)
        runner._approve_plan(store, thread_id)
        action_id = store.actions.begin(thread_id, "dev").action_id
        graph.invoke(Command(resume={"decision": "approved"}), config)
        snapshot = graph.get_state(config)
        assert snapshot.values.get("halted_reason") == "action_unchecked:dev"
        assert not set(snapshot.next)
    finally:
        if graph is not None:
            conn = getattr(graph.checkpointer, "conn", None)
            if conn is not None:
                conn.close()
        store.close()
    return req_id, thread_id, action_id


def _retry_argv(
    root: Path,
    req_id: str,
    *,
    task: str | None = TASK,
    reason: str = REASON,
) -> list[str]:
    argv = ["requirement", "retry", req_id]
    if task is not None:
        argv += ["--task", task]
    argv += ["--by", "owner", "--reason", reason, "--pi-command", PI_COMMAND]
    argv += ["--records-root", str(root)]
    return argv


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


class TestRetryDrivesResume:
    def test_explicit_task_resumes_in_place_and_prints_identity(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, thread_id = _halted(tmp_path, monkeypatch)
        monkeypatch.setenv("FAKE_PI_MODE", "ok")

        code = cli_main(_retry_argv(tmp_path, req_id))
        captured = capsys.readouterr()

        assert code == 0, captured.out + captured.err
        assert f"实际处理任务: {TASK}" in captured.out
        assert thread_id in captured.out
        decision = latest_retry_decision(tmp_path, req_id, thread_id)
        assert decision is not None
        assert decision.decided_by == "owner"
        assert decision.reason == REASON
        # 真实图就地续跑：dev 重入一次后继续 review/test，plan 未从 START 重放。
        assert _completed_nodes(tmp_path, thread_id) == ["dev", "dev", "review", "test"]
        assert (tmp_path / thread_id / "candidate.diff").is_file()
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            plan = store.latest_plan(thread_id)
        finally:
            store.close()
        assert plan is not None
        assert plan.version == 1

    def test_omitted_task_resumes_single_interrupted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, thread_id = _halted(tmp_path, monkeypatch)
        monkeypatch.setenv("FAKE_PI_MODE", "ok")

        code = cli_main(_retry_argv(tmp_path, req_id, task=None))
        captured = capsys.readouterr()

        assert code == 0, captured.out + captured.err
        assert f"实际处理任务: {TASK}" in captured.out
        assert _completed_nodes(tmp_path, thread_id) == ["dev", "dev", "review", "test"]

    def test_blank_reason_does_not_enter_graph(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, thread_id = _halted(tmp_path, monkeypatch)
        before = _completed_nodes(tmp_path, thread_id)

        code = cli_main(_retry_argv(tmp_path, req_id, reason="   "))
        captured = capsys.readouterr()

        assert code == 1
        assert "理由" in captured.err
        assert _completed_nodes(tmp_path, thread_id) == before
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_retry_releases_outstanding_action_and_resumes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, thread_id, action_id = _halted_action_unchecked(tmp_path, monkeypatch)
        assert outstanding_action_node(tmp_path, thread_id) == "dev"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")

        code = cli_main(_retry_argv(tmp_path, req_id))
        captured = capsys.readouterr()

        assert code == 0, captured.out + captured.err
        assert f"实际处理任务: {TASK}" in captured.out
        assert "已释放未完成动作" in captured.out
        # 审计可回查：谁/何时/理由/动作身份都在档。
        releases = action_releases(tmp_path, thread_id)
        assert [item.action_id for item in releases] == [action_id]
        assert releases[0].released_by == "owner"
        assert releases[0].reason == REASON
        assert outstanding_action_node(tmp_path, thread_id) == ""
        # 真实图从被释放动作所在节点就地重入，dev/review/test 只执行一次。
        assert _completed_nodes(tmp_path, thread_id) == ["dev", "review", "test"]
        assert (tmp_path / thread_id / "candidate.diff").is_file()


class TestStatusReportsDecision:
    def test_status_json_and_text_show_latest_retry_decision(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, thread_id = _halted(tmp_path, monkeypatch)
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        assert cli_main(_retry_argv(tmp_path, req_id)) == 0
        capsys.readouterr()

        assert (
            cli_main(
                [
                    "requirement",
                    "status",
                    req_id,
                    "--json",
                    "--records-root",
                    str(tmp_path),
                ]
            )
            == 0
        )
        document = json.loads(capsys.readouterr().out)
        assert document["retry"] is not None
        assert document["retry"]["decided_by"] == "owner"
        assert document["retry"]["task_id"] == thread_id
        assert document["retry"]["reason"] == REASON

        assert cli_main(["requirement", "status", req_id, "--records-root", str(tmp_path)]) == 0
        assert "最近人工续跑" in capsys.readouterr().out


class TestMissingRequiredOption:
    def test_missing_pi_command_is_accepted_by_parser(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # 省略 --pi-command 不应由解析层拒绝：运行状态可能已切到 DSH。这里没有
        # 可续跑现场，命令由业务校验拒绝（exit 1），错误信息里不再出现缺参提示。
        req_id = _approved(tmp_path)
        argv = _retry_argv(tmp_path, req_id)
        index = argv.index("--pi-command")
        del argv[index : index + 2]

        code = cli_main(argv)

        assert code == 1
        assert "--pi-command" not in capsys.readouterr().err


class TestRuntimeUnavailable:
    """运行时不可用时 fail-closed：不伪装续跑成功，也不丢现场。"""

    def test_retry_aborts_when_executor_reports_runtime_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, _thread_id = _halted(tmp_path, monkeypatch)
        from forgeloop.cli import requirements as requirements_module
        from forgeloop.domain.agent_runtime import AgentRuntimeError

        def _raise(self) -> None:
            raise AgentRuntimeError("Agent Runtime pi 缺少启动命令")

        monkeypatch.setattr(requirements_module.RequirementExecutor, "advance", _raise)

        code = cli_main(
            [
                "requirement",
                "retry",
                req_id,
                "--task",
                TASK,
                "--by",
                "owner",
                "--reason",
                REASON,
                "--records-root",
                str(tmp_path),
            ]
        )
        captured = capsys.readouterr()

        assert code == 1
        assert "运行时不可用" in captured.err
        assert "缺少启动命令" in captured.err
