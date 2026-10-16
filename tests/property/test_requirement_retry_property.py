"""人工续跑「无理由永不续跑且零副作用」的属性测试。

不变量（对任意 ``--by`` 文本与任意空白理由都成立）：

- 理由去首尾空白后为空时，``records`` 层授权永不放行；
- 拒绝时零副作用：不写人工决定记录、不返回已清除的检查点摘要、原始检查点
  ``halted_reason`` 原样保留；
- CLI 命令在空白理由下同样拒绝并且不记录任何决定（不会驱动业务图续跑）；
- 放行仅在理由非空且 ``--by`` 合法时发生，且放行必然落一条决定记录。

属性测试使用独立临时目录，避免示例之间共享记录状态。
"""

import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from uuid import uuid4

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.checkpoints import (
    INTERRUPTED,
    CheckpointHealth,
    CheckpointInspection,
    CheckpointState,
    authorize_retry,
    inspect_checkpoint,
    latest_retry_decision,
)
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 16, 10, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"
PI_COMMAND = json.dumps([sys.executable, "fake_pi.py"])

# Python ``str.strip()`` 会去掉这些 Unicode 空白；任意组合都必须是空白理由。
whitespace = st.text(
    alphabet=st.sampled_from([" ", "\t", "\n", "\r", "\x0b", "\x0c", "\u3000", "\u00a0"]),
    max_size=6,
)
arbitrary_by = st.text(max_size=80)
nonblank_reason = st.text(min_size=1).filter(lambda value: value.strip() != "")


def _inspection(*, task_status: str = INTERRUPTED) -> CheckpointInspection:
    thread = f"task-req-prop-v{PLAN_VERSION}-{TASK}"
    return CheckpointInspection(
        CheckpointHealth.OK,
        CheckpointState(
            task_id=thread,
            checkpoint_id="cp-1",
            halted_reason="pi_dev_unsettled",
            halted_node="dev",
            recorded_task_id=thread,
            plan_version=PLAN_VERSION,
        ),
    )


def _write_checkpoint(root: Path, thread_id: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        checkpoint["id"] = "cp-1"
        checkpoint["channel_values"] = {
            "task_id": thread_id,
            "plan_version": PLAN_VERSION,
            "halted_reason": "pi_dev_unsettled",
        }
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


def _approved(root: Path) -> tuple[str, str]:
    """建立已批准的单任务需求与中断现场，返回需求身份与单任务身份。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：属性测试")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask(
                    TASK,
                    "实现 first",
                    ("src/first.py",),
                    "验收",
                    (sys.executable, "-c", "print('ok')"),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, PLAN_VERSION, "owner", source="property")
        req_id = requirement.req_id
    finally:
        store.close()
    thread_id = requirement_task_id(req_id, PLAN_VERSION, TASK)
    _write_checkpoint(root, thread_id)
    record_store = RecordStore(root / "records.sqlite")
    try:
        record_store.create_task(
            thread_id,
            PROJECT,
            "task",
            {"pi_command": "[]", "test_command": "[]"},
            7200.0,
        )
        record_store.set_task_status(thread_id, "interrupted")
    finally:
        record_store.close()
    return req_id, thread_id


@given(by=arbitrary_by, reason=whitespace)
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_blank_reason_never_authorizes_and_has_no_side_effects(
    tmp_path: Path, by: str, reason: str
) -> None:
    root = tmp_path / uuid4().hex

    outcome = authorize_retry(
        root,
        inspection=_inspection(),
        requirement_id="req-prop",
        task_id=f"task-req-prop-v{PLAN_VERSION}-{TASK}",
        plan_version=PLAN_VERSION,
        task_status=INTERRUPTED,
        by=by,
        reason=reason,
        at=WHEN,
    )

    assert outcome.allowed is False
    assert outcome.decision is None
    assert outcome.checkpoint is None
    assert latest_retry_decision(root, "req-prop") is None


@given(by=arbitrary_by, reason=nonblank_reason)
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_decision_recorded_exactly_when_allowed(tmp_path: Path, by: str, reason: str) -> None:
    root = tmp_path / uuid4().hex
    thread = f"task-req-prop-v{PLAN_VERSION}-{TASK}"

    outcome = authorize_retry(
        root,
        inspection=_inspection(),
        requirement_id="req-prop",
        task_id=thread,
        plan_version=PLAN_VERSION,
        task_status=INTERRUPTED,
        by=by,
        reason=reason,
        at=WHEN,
    )

    decision = latest_retry_decision(root, "req-prop", thread)
    if outcome.allowed:
        assert outcome.decision is not None
        assert decision is not None
        assert decision.reason == reason
    else:
        assert outcome.decision is None
        assert decision is None


@given(by=arbitrary_by, reason=whitespace)
@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_cli_blank_reason_never_drives_resume(tmp_path: Path, by: str, reason: str) -> None:
    root = tmp_path / uuid4().hex
    req_id, thread_id = _approved(root)

    code = cli_main(
        [
            "requirement",
            "retry",
            req_id,
            "--task",
            TASK,
            f"--by={by}",
            f"--reason={reason}",
            "--pi-command",
            PI_COMMAND,
            "--records-root",
            str(root),
        ]
    )

    assert code == 1
    assert latest_retry_decision(root, req_id, thread_id) is None
    state = inspect_checkpoint(root, thread_id).state
    assert state is not None
    assert state.halted_reason == "pi_dev_unsettled"
