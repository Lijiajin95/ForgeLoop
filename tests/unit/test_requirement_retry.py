"""CLI 人工续跑命令的行为测试（records + CLI 边界，不驱动真实业务图）。

覆盖本任务验收的核心行为：

- ``forgeloop requirement retry`` 已注册且必填参数与需求一致（``--by``/``--reason``/
  ``--pi-command``）；缺任一必填项在解析层 fail-closed；
- 取值校验 fail-closed：空白理由、空白/超长/不可打印 ``--by`` 都被拒绝且给出可操作
  提示；校验失败零副作用：不记录人工决定，也不清除检查点 ``halted_reason``；
- 状态不符时提示当前状态与要求状态；
- 检查点缺失/损坏等不可信现场提示人工处置路径（``requirement slot list``）；
- 省略 ``--task`` 时只接受「需求恰有一个中断任务」：0 个或多个都拒绝并列出候选；
- 指定包外任务时拒绝并列出任务包内可选任务。

成功续跑所需的真实业务图执行放在 ``tests/component/test_requirement_retry_cli.py``；
本文件只验证校验与选择规则，不启动 PI。
"""

import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

from forgeloop.cli.main import main as cli_main
from forgeloop.cli.requirements import (
    RetryCandidate,
    _select_retry_candidate,
)
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.checkpoints import (
    inspect_checkpoint,
    latest_retry_decision,
)
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 16, 10, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
PI_COMMAND = json.dumps([sys.executable, "fake_pi.py"])
REASON = "人工核对检查点现场后确认可续跑"


def _planned(task_id: str) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=(sys.executable, "-c", "print('ok')"),
    )


def _approved(root: Path, task_ids: tuple[str, ...]) -> str:
    """建立已批准任务包，返回需求身份。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：人工续跑 CLI 校验")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=tuple(_planned(task_id) for task_id in task_ids),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(
            requirement.req_id, PLAN_VERSION, "owner", source="batch-retry-cli"
        )
        return requirement.req_id
    finally:
        store.close()


def _write_checkpoint(
    root: Path,
    thread_id: str,
    *,
    recorded_task_id: str | None = None,
    plan_version: int = PLAN_VERSION,
    halted_reason: str = "pi_dev_unsettled",
    nodes: tuple[str, ...] = (),
) -> None:
    """写一条真实 LangGraph 检查点，供校验/选择用例使用。"""

    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        checkpoint["id"] = "cp-1"
        values: dict[str, object] = {f"branch:to:{node}": node for node in nodes}
        if halted_reason:
            values["halted_reason"] = halted_reason
        values["task_id"] = recorded_task_id if recorded_task_id is not None else thread_id
        values["plan_version"] = plan_version
        checkpoint["channel_values"] = values
        config = cast(
            RunnableConfig,
            {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": "",
                    "checkpoint_id": "cp-1",
                }
            },
        )
        saver.put(
            config,
            checkpoint,
            cast(CheckpointMetadata, {"source": "loop", "step": 0, "parents": {}}),
            {},
        )
        conn.commit()
    finally:
        conn.close()


def _publish_single_task(root: Path, thread_id: str, status: str) -> None:
    """建立并置位单任务权威记录，模拟真实中断现场的任务状态。"""

    store = RecordStore(root / "records.sqlite")
    try:
        if store.get_task(thread_id) is None:
            store.create_task(
                thread_id,
                PROJECT,
                "task",
                {"pi_command": "[]", "test_command": "[]"},
                7200.0,
            )
        store.set_task_status(thread_id, status)
    finally:
        store.close()


def _retry_argv(
    root: Path,
    req_id: str,
    *,
    task: str | None = None,
    by: str | None = "owner",
    reason: str | None = REASON,
    pi_command: str | None = PI_COMMAND,
) -> list[str]:
    argv = ["requirement", "retry", req_id]
    if task is not None:
        argv += ["--task", task]
    if by is not None:
        argv += ["--by", by]
    if reason is not None:
        argv += ["--reason", reason]
    if pi_command is not None:
        argv += ["--pi-command", pi_command]
    argv += ["--records-root", str(root)]
    return argv


def _halted(root: Path, req_id: str, task_id: str) -> str:
    """写入一条中断检查点并置位单任务状态，返回单任务身份。"""

    thread_id = requirement_task_id(req_id, PLAN_VERSION, task_id)
    _write_checkpoint(root, thread_id)
    _publish_single_task(root, thread_id, "interrupted")
    return thread_id


class TestRequiredArguments:
    @pytest.mark.parametrize("missing", ["--by", "--reason", "--pi-command"])
    def test_missing_required_option_is_rejected(
        self, tmp_path: Path, missing: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        argv = _retry_argv(tmp_path, req_id, task="first")
        index = argv.index(missing)
        del argv[index : index + 2]

        with pytest.raises(SystemExit) as excinfo:
            cli_main(argv)

        assert excinfo.value.code != 0
        assert missing in capsys.readouterr().err


class TestValueValidation:
    def test_blank_reason_is_rejected_without_side_effects(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = _halted(tmp_path, req_id, "first")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first", reason="   "))

        assert code == 1
        assert "理由" in capsys.readouterr().err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None
        state = inspect_checkpoint(tmp_path, thread_id).state
        assert state is not None
        assert state.halted_reason == "pi_dev_unsettled"

    def test_blank_by_is_rejected_with_actionable_example(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = _halted(tmp_path, req_id, "first")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first", by="   "))

        assert code == 1
        err = capsys.readouterr().err
        assert "--by" in err
        assert "owner" in err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_overlong_by_is_rejected(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = _halted(tmp_path, req_id, "first")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first", by="a" * 65))

        assert code == 1
        assert "--by" in capsys.readouterr().err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_non_printable_by_is_rejected(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = _halted(tmp_path, req_id, "first")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first", by="own\x01er"))

        assert code == 1
        assert "--by" in capsys.readouterr().err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_status_mismatch_reports_current_and_required(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = requirement_task_id(req_id, PLAN_VERSION, "first")
        # 非中断现场：检查点停在可续跑业务节点但任务状态不是 interrupted。
        _write_checkpoint(tmp_path, thread_id, halted_reason="", nodes=("dev",))
        _publish_single_task(tmp_path, thread_id, "implementing")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first"))

        assert code == 1
        err = capsys.readouterr().err
        assert "状态不符" in err
        assert "implementing" in err
        assert "interrupted" in err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_missing_checkpoint_reports_recovery_path(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = requirement_task_id(req_id, PLAN_VERSION, "first")
        # 状态为中断但没有可读检查点：必须 fail-closed 并给出人工处置路径。
        _publish_single_task(tmp_path, thread_id, "interrupted")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first"))

        assert code == 1
        err = capsys.readouterr().err
        assert "检查点缺失" in err
        assert "slot list" in err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_corrupt_checkpoint_reports_recovery_path(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = requirement_task_id(req_id, PLAN_VERSION, "first")
        _publish_single_task(tmp_path, thread_id, "interrupted")
        (tmp_path / "checkpoints.sqlite").write_bytes(b"this is not a sqlite database")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first"))

        assert code == 1
        err = capsys.readouterr().err
        assert "检查点" in err
        assert "slot list" in err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_plan_identity_mismatch_is_rejected(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        thread_id = requirement_task_id(req_id, PLAN_VERSION, "first")
        _write_checkpoint(tmp_path, thread_id, plan_version=PLAN_VERSION + 1)
        _publish_single_task(tmp_path, thread_id, "interrupted")

        code = cli_main(_retry_argv(tmp_path, req_id, task="first"))

        assert code == 1
        err = capsys.readouterr().err
        assert "plan_version" in err
        assert "slot list" in err
        assert latest_retry_decision(tmp_path, req_id, thread_id) is None

    def test_invalid_pi_command_is_rejected(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first",))
        _halted(tmp_path, req_id, "first")

        with pytest.raises(SystemExit) as excinfo:
            cli_main(_retry_argv(tmp_path, req_id, task="first", pi_command="not-json"))

        assert "pi-command" in str(excinfo.value)


class TestTaskSelection:
    def test_unknown_task_lists_pack_tasks(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first", "second"))

        code = cli_main(_retry_argv(tmp_path, req_id, task="does-not-exist"))

        assert code == 1
        err = capsys.readouterr().err
        assert "没有任务 does-not-exist" in err
        assert "first" in err
        assert "second" in err

    def test_omitted_task_rejects_zero_interrupted_and_lists_tasks(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first", "second"))

        code = cli_main(_retry_argv(tmp_path, req_id))

        assert code == 1
        err = capsys.readouterr().err
        assert "没有处于中断" in err
        assert "first" in err
        assert "second" in err

    def test_omitted_task_rejects_multiple_and_lists_candidates(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = _approved(tmp_path, ("first", "second"))
        _halted(tmp_path, req_id, "first")
        _publish_single_task(
            tmp_path, requirement_task_id(req_id, PLAN_VERSION, "second"), "interrupted"
        )

        code = cli_main(_retry_argv(tmp_path, req_id))

        assert code == 1
        err = capsys.readouterr().err
        assert "2 个" in err
        assert "first" in err
        assert "second" in err
        # 歧义时绝不猜测：没有写入任何人工决定。
        assert latest_retry_decision(tmp_path, req_id) is None

    def test_select_single_interrupted_candidate(self) -> None:
        candidates = (
            RetryCandidate("first", "thread-first", "interrupted", ""),
            RetryCandidate("second", "thread-second", "delivered", ""),
        )

        selected = _select_retry_candidate(candidates)

        assert selected is not None
        assert selected.task_id == "first"

    def test_select_zero_or_multiple_candidates_returns_none(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        zero = (RetryCandidate("first", "thread-first", "delivered", ""),)
        multiple = (
            RetryCandidate("first", "thread-first", "interrupted", ""),
            RetryCandidate("second", "thread-second", "unknown", "pi_dev_unsettled"),
        )

        assert _select_retry_candidate(zero) is None
        assert _select_retry_candidate(multiple) is None
        err = capsys.readouterr().err
        assert "没有处于中断" in err
        assert "2 个" in err
