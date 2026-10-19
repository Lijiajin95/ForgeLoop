"""Agent Runtime 热切换场景：同一进程内切换 PI/DSH，以及 DSH 全链路业务图。

两层证据：

1. **节点级**：同一推进进程先由 PI 跑实现，再用 ``runtime set`` 切到 DSH 跑审查；
   两个会话的请求记录分别标注 ``pi`` 与 ``dsh``，证明切换在下一个动作生效，
   不需要重启进程、不改任务配置快照。
2. **CLI 全链路**：运行状态为 DSH 时提交任务（不提供 ``--pi-command``），
   ``approve`` 驱动实现→审查→测试→等待验收，再 ``approve --stage acceptance`` 交付；
   候选与证据来自假 DSH 的真实事件流，不是注入的返回值。
"""

import json
import re
import sys
from pathlib import Path

from support import FAKE_TEST_COMMAND, run_cli

from forgeloop.graph.nodes import NodeContext, make_dev_node, make_plan_node, make_review_node
from forgeloop.graph.planning import PlanningContext, analyze_requirement, plan_requirement
from forgeloop.records.agent_runtimes import AgentRuntimeStore
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
FAKE_DSH = [sys.executable, str(FIXTURES / "fake_dsh.py")]
TASK_CREATED = re.compile(r"任务已创建: (\S+)")


def _switch_to_dsh(root: Path, command: list[str] | None = None) -> None:
    store = AgentRuntimeStore(root / "records.sqlite")
    try:
        store.set_runtime(
            "dsh",
            command=command or FAKE_DSH,
            by="owner",
            reason="场景测试：热切换到 DSH",
        )
    finally:
        store.close()


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


class TestHotSwitchBetweenActions:
    def test_dev_uses_pi_then_review_uses_dsh_after_switch(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_AGENT_RUNTIME", raising=False)
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task(
                "task-switch",
                "forgeloop",
                "热切换验证",
                {
                    "pi_command": json.dumps(FAKE_PI),
                    "test_command": json.dumps(FAKE_TEST_COMMAND),
                    "goal": "g",
                    "scope": "s",
                    "acceptance": "a",
                },
                limit_seconds=600.0,
            )
            ctx = NodeContext.for_task(store, tmp_path, "task-switch")
            make_plan_node(ctx)({"task_id": "task-switch"})

            # 第一个动作：默认运行时 PI。
            dev_update = make_dev_node(ctx)({"task_id": "task-switch"})
            assert dev_update == {"dev_attempts": 1}
            dev_report = _read_jsonl(ctx.task_dir / "dev-reports.jsonl")[0]
            assert dev_report["agent_runtime"] == "pi"
            assert (ctx.task_dir / "candidate.diff").is_file()

            # 热切换：写运行状态，不重启、不改任务配置。
            _switch_to_dsh(tmp_path)

            # 第二个动作：同进程内改用 DSH。
            review_update = make_review_node(ctx)({"task_id": "task-switch"})
            assert review_update == {"last_review_blocking": False}
            review_entry = _read_jsonl(ctx.task_dir / "reviews.jsonl")[0]
            assert review_entry["agent_runtime"] == "dsh"
            assert review_entry["blocking_issues_valid"] is True

            dev_requests = _read_jsonl(ctx.sessions_dir / "task-switch-dev.requests.jsonl")
            review_requests = _read_jsonl(ctx.sessions_dir / "task-switch-review.requests.jsonl")
            assert dev_requests[-1]["agent_runtime"] == "pi"
            assert review_requests[-1]["agent_runtime"] == "dsh"
            # 会话文件命名不变：回查口径与 PI 时代一致。
            assert (ctx.sessions_dir / "task-switch-dev.events.jsonl").is_file()
            assert (ctx.sessions_dir / "task-switch-review.events.jsonl").is_file()
        finally:
            store.close()

    def test_environment_override_switches_without_touching_records(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_DSH_MODE", "ok")
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "dsh")
        monkeypatch.setenv("FORGELOOP_DSH_COMMAND", json.dumps(FAKE_DSH))
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            # 任务没有 pi_command：进程环境覆盖到 DSH，仍应正常完成审查动作。
            store.create_task(
                "task-env",
                "forgeloop",
                "环境覆盖",
                {
                    "test_command": json.dumps(FAKE_TEST_COMMAND),
                    "goal": "g",
                    "scope": "s",
                    "acceptance": "a",
                },
                limit_seconds=600.0,
            )
            ctx = NodeContext.for_task(store, tmp_path, "task-env")
            make_plan_node(ctx)({"task_id": "task-env"})
            update = make_review_node(ctx)({"task_id": "task-env"})
            assert update == {"last_review_blocking": False}
            review_entry = _read_jsonl(ctx.task_dir / "reviews.jsonl")[0]
            assert review_entry["agent_runtime"] == "dsh"
        finally:
            store.close()


class TestDshFullFlowViaCli:
    def test_submit_approve_accept_with_dsh_runtime(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_AGENT_RUNTIME", raising=False)
        monkeypatch.setenv("FAKE_DSH_MODE", "ok")
        _switch_to_dsh(tmp_path)

        code, out = run_cli(
            [
                "submit",
                "--project",
                "forgeloop",
                "--input",
                "为 CLI 增加热切换",
                "--test-command",
                json.dumps(FAKE_TEST_COMMAND),
                "--goal",
                "热切换",
                "--scope",
                "仅 CLI",
                "--acceptance",
                "输出稳定",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        match = TASK_CREATED.search(out)
        assert match, out
        task_id = match.group(1)

        code, out = run_cli(
            ["approve", task_id, "--stage", "plan", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        assert "awaiting_acceptance" in out

        task_dir = tmp_path / task_id
        dev_report = _read_jsonl(task_dir / "dev-reports.jsonl")[0]
        review_entry = _read_jsonl(task_dir / "reviews.jsonl")[0]
        assert dev_report["agent_runtime"] == "dsh"
        assert review_entry["agent_runtime"] == "dsh"
        assert (task_dir / "test-run.jsonl").is_file()
        assert (task_dir / "sessions" / f"{task_id}-dev.events.jsonl").is_file()

        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            task = store.get_task(task_id)
            assert task is not None and task.status == "delivered"
        finally:
            store.close()

        # 状态页读模型与 runtime 查询都反映同一次热切换（记录是唯一事实来源）。
        code, out = run_cli(["runtime", "show", "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"]["runtime"] == "dsh"
        assert document["effective"]["runtime"] == "dsh"


class TestDshPlanning:
    """分析/规划也走同一 Agent Runtime 抽象：DSH 运行时下 pi_command 可以缺省。"""

    def test_analyze_and_plan_with_dsh_runtime(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.delenv("FORGELOOP_AGENT_RUNTIME", raising=False)
        monkeypatch.setenv("FAKE_DSH_MODE", "ok")
        _switch_to_dsh(tmp_path)
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            requirement = store.submit("ForgeLoop", "需求：用 DSH 做只读分析与任务规划")
            context = PlanningContext(
                store,
                requirement.req_id,
                tmp_path / "requirements" / requirement.req_id / "analysis",
                records_root=tmp_path,
            )
            analysis = analyze_requirement(context)
            assert analysis.is_ready, analysis.halted_reason
            assert analysis.analysis is not None
            assert analysis.analysis.goal

            planning = plan_requirement(context)
            assert planning.plan is not None, planning.halted_reason
            assert len(planning.plan.tasks) == 2
            sessions = context.analysis_dir / "sessions"
            for role in ("analysis", "planning"):
                requests = _read_jsonl(sessions / f"{requirement.req_id}-{role}.requests.jsonl")
                assert requests[-1]["agent_runtime"] == "dsh"
        finally:
            store.close()
