"""运行时不可用时的 CLI 失败关闭：分析、规划、推进与并行推进都不伪装成功。

场景：记录里没有运行状态、任务也没有可用的启动命令。命令应报出具体原因并以非零
退出码结束，而不是抛 traceback、静默跳过或留下“已推进”的假记录。
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.records.requirements import RequirementStore

WHEN = datetime(2026, 10, 19, 10, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1


def _approved(root: Path, req_id: str) -> None:
    store = RequirementStore(root / "records.sqlite")
    try:
        plan = TaskPlan(
            task_plan_id=f"plan-{req_id}-{PLAN_VERSION}",
            requirement_id=req_id,
            project=PROJECT,
            plan_version=PLAN_VERSION,
            requirement_version=1,
            tasks=(
                PlannedTask(
                    task_id="first",
                    goal="实现",
                    files=("src/forgeloop/status.py",),
                    acceptance="验收",
                    test_command=("python3", "-c", "print('ok')"),
                    depends_on=(),
                    limits=TaskLimits(limit_seconds=600.0, max_failure_rounds=3),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(req_id, plan)
        store.record_plan_approval(
            req_id, PLAN_VERSION, "owner", source="batch-runtime-unavailable"
        )
    finally:
        store.close()


def _submit(root: Path) -> str:
    store = RequirementStore(root / "records.sqlite")
    try:
        return store.submit(PROJECT, "需求：验证运行时不可用时的失败关闭").req_id
    finally:
        store.close()


class TestPlanningRuntimeUnavailable:
    def test_analyze_without_command_fails_closed(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _submit(tmp_path)

        code = cli_main(["requirement", "analyze", req_id, "--records-root", str(tmp_path)])
        captured = capsys.readouterr()

        assert code == 1
        assert "FAIL" in captured.err
        assert "缺少启动命令" in captured.err

    def test_plan_without_command_fails_closed(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _submit(tmp_path)
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            store.record_analysis(
                req_id,
                RequirementAnalysis(
                    analysis_version=1,
                    requirement_version=1,
                    goal="目标",
                    scenarios=("场景",),
                    acceptance_criteria=("标准",),
                    clarifications=(),
                    created_at=WHEN,
                ),
            )
        finally:
            store.close()

        code = cli_main(["requirement", "plan", req_id, "--records-root", str(tmp_path)])
        captured = capsys.readouterr()

        assert code == 1
        assert "缺少启动命令" in captured.err


class TestExecutionRuntimeUnavailable:
    def test_advance_without_command_fails_closed(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _submit(tmp_path)
        _approved(tmp_path, req_id)

        code = cli_main(["requirement", "advance", req_id, "--records-root", str(tmp_path)])
        captured = capsys.readouterr()

        assert code == 1
        assert "运行时不可用" in captured.err
        assert "缺少启动命令" in captured.err

    def test_dispatch_without_command_fails_closed(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _submit(tmp_path)
        _approved(tmp_path, req_id)

        code = cli_main(["requirement", "dispatch", req_id, "--records-root", str(tmp_path)])
        captured = capsys.readouterr()

        assert code == 1
        assert "运行时不可用" in captured.err


def test_pi_timeout_flag_remains_available_without_pi_command() -> None:
    from forgeloop.cli.main import build_parser

    args = build_parser().parse_args(
        ["requirement", "advance", "req-1", "--pi-timeout-seconds", "42"]
    )
    assert args.pi_command == ""
    assert args.pi_timeout_seconds == 42.0
