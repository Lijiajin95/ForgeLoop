"""records 层人工续跑决定与检查点可信判定的行为测试。

覆盖本任务验收的核心行为：

- 人工续跑决定以记录表项持久化调用方标识、时间、理由、目标任务与需求身份，
  可按需求/任务回查最近一次决定与完整历史；
- 检查点可信判定覆盖全部不可信项：缺失、读取失败、状态损坏、检查点 ``task_id``
  与目标任务不一致、检查点 ``plan_version`` 与已批准任务包版本不一致、任务为
  ``interrupted`` 但检查点无 ``halted_reason``；每条拒绝都给出可操作原因；
- 状态不符（既非 ``interrupted`` 也无 ``halted_reason``）一律拒绝；
- ``--by`` 去首尾空白后须为 1-64 个可打印字符，否则拒绝；
- 清除 ``halted_reason`` 与写入决定记录只在校验全部通过后发生；校验失败时
  既不写决定，也不改动检查点现场。
"""

import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import Checkpoint, CheckpointMetadata, empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

from forgeloop.records.checkpoints import (
    INTERRUPTED,
    MAX_DECIDED_BY_LENGTH,
    CheckpointHealth,
    CheckpointInspection,
    CheckpointState,
    RetryAuthorization,
    RetryCheck,
    authorize_retry,
    inspect_checkpoint,
    latest_retry_decision,
    read_authorized_checkpoint,
    read_checkpoint,
    retry_decisions,
    validate_retry,
)

WHEN = datetime(2026, 10, 16, 10, 0, tzinfo=UTC)
REQ = "req-demo"
TASK = "records-retry-decision"
PLAN_VERSION = 3
THREAD = f"task-{REQ}-v{PLAN_VERSION}-{TASK}"
BY = "owner"


def _write_checkpoint(
    root: Path,
    thread_id: str = THREAD,
    *,
    task_id: str = TASK,
    plan_version: int | None = PLAN_VERSION,
    nodes: tuple[str, ...] = ("dev",),
    halted_reason: str = "pi_dev_unsettled",
    checkpoint_id: str = "cp-1",
) -> None:
    """在记录根下写一条真实 LangGraph 检查点，供只读读取与判定用例使用。"""

    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "checkpoints.sqlite", check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        checkpoint = cast(Checkpoint, dict(empty_checkpoint()))
        checkpoint["id"] = checkpoint_id
        values: dict[str, object] = {f"branch:to:{node}": node for node in nodes}
        if halted_reason:
            values["halted_reason"] = halted_reason
        values["task_id"] = task_id
        if plan_version is not None:
            values["plan_version"] = plan_version
        checkpoint["channel_values"] = values
        config = cast(
            RunnableConfig,
            {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": "",
                    "checkpoint_id": checkpoint_id,
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


def _state(
    *,
    task_id: str = TASK,
    plan_version: int | None = PLAN_VERSION,
    halted_reason: str = "pi_dev_unsettled",
) -> CheckpointState:
    return CheckpointState(
        task_id=THREAD,
        checkpoint_id="cp-1",
        next_nodes=("dev",),
        halted_reason=halted_reason,
        recorded_task_id=task_id,
        plan_version=plan_version,
    )


def _ok_inspection(**kwargs: object) -> CheckpointInspection:
    return CheckpointInspection(CheckpointHealth.OK, _state(**kwargs))  # type: ignore[arg-type]


def _check(
    inspection: CheckpointInspection,
    *,
    task_status: str = INTERRUPTED,
    by: str = BY,
    reason: str = "人工核对后确认可续跑",
) -> RetryCheck:
    return validate_retry(
        inspection,
        requirement_id=REQ,
        task_id=TASK,
        plan_version=PLAN_VERSION,
        task_status=task_status,
        by=by,
        reason=reason,
    )


class TestCheckpointInspection:
    def test_missing_database_reports_missing(self, tmp_path: Path) -> None:
        inspection = inspect_checkpoint(tmp_path, THREAD)

        assert inspection.health is CheckpointHealth.MISSING
        assert inspection.state is None

    def test_empty_database_is_not_enlarged_by_reading(self, tmp_path: Path) -> None:
        path = tmp_path / "checkpoints.sqlite"
        path.write_bytes(b"")

        inspection = inspect_checkpoint(tmp_path, THREAD)

        assert inspection.health is CheckpointHealth.MISSING
        assert path.stat().st_size == 0

    def test_unknown_thread_reports_missing(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, "other-thread")

        assert inspect_checkpoint(tmp_path, THREAD).health is CheckpointHealth.MISSING

    def test_garbage_file_reports_corrupt(self, tmp_path: Path) -> None:
        (tmp_path / "checkpoints.sqlite").write_bytes(b"this is not a sqlite database")

        assert inspect_checkpoint(tmp_path, THREAD).health is CheckpointHealth.CORRUPT

    def test_unreadable_file_reports_unreadable(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, THREAD)
        path = tmp_path / "checkpoints.sqlite"
        os.chmod(path, 0o000)
        try:
            inspection = inspect_checkpoint(tmp_path, THREAD)
        finally:
            os.chmod(path, 0o644)

        assert inspection.health is CheckpointHealth.UNREADABLE

    def test_corrupted_blob_reports_corrupt(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, THREAD)
        conn = sqlite3.connect(tmp_path / "checkpoints.sqlite")
        try:
            conn.execute("UPDATE checkpoints SET checkpoint = ?", (b"corrupted-payload",))
            conn.commit()
        finally:
            conn.close()

        assert inspect_checkpoint(tmp_path, THREAD).health is CheckpointHealth.CORRUPT

    def test_unknown_serialization_type_reports_corrupt(self, tmp_path: Path) -> None:
        # SqliteSaver 的 serde 对未知 type 抛 NotImplementedError；它同样是「状态
        # 损坏」，必须 fail-closed 归类为 CORRUPT，而不是让异常穿透读取路径。
        _write_checkpoint(tmp_path, THREAD)
        conn = sqlite3.connect(tmp_path / "checkpoints.sqlite")
        try:
            conn.execute("UPDATE checkpoints SET type = ?", ("bogus",))
            conn.commit()
        finally:
            conn.close()

        inspection = inspect_checkpoint(tmp_path, THREAD)

        assert inspection.health is CheckpointHealth.CORRUPT
        assert inspection.state is None

    def test_reads_recorded_task_and_plan_identity(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, THREAD, task_id=TASK, plan_version=PLAN_VERSION)

        inspection = inspect_checkpoint(tmp_path, THREAD)

        assert inspection.health is CheckpointHealth.OK
        assert inspection.state is not None
        assert inspection.state.recorded_task_id == TASK
        assert inspection.state.plan_version == PLAN_VERSION
        assert inspection.state.halted_reason == "pi_dev_unsettled"

    def test_read_checkpoint_stays_compatible_with_none_on_failure(self, tmp_path: Path) -> None:
        assert read_checkpoint(tmp_path, THREAD) is None
        (tmp_path / "checkpoints.sqlite").write_bytes(b"garbage")
        assert read_checkpoint(tmp_path, THREAD) is None


class TestValidateRetry:
    def test_trusted_interrupted_checkpoint_is_allowed(self) -> None:
        check = _check(_ok_inspection())

        assert check.allowed is True
        assert check.reasons == ()

    def test_halted_reason_allows_non_interrupted_status(self) -> None:
        check = _check(_ok_inspection(), task_status="blocked")

        assert check.allowed is True

    def test_status_mismatch_without_halted_reason_is_rejected(self) -> None:
        check = _check(_ok_inspection(halted_reason=""), task_status="implementing")

        assert check.allowed is False
        assert "状态不符" in check.reason
        assert INTERRUPTED in check.reason

    def test_interrupted_without_halted_reason_is_rejected(self) -> None:
        check = _check(_ok_inspection(halted_reason=""))

        assert check.allowed is False
        assert "halted_reason" in check.reason

    def test_missing_checkpoint_is_rejected(self) -> None:
        check = _check(CheckpointInspection(CheckpointHealth.MISSING, None))

        assert check.allowed is False
        assert "缺失" in check.reason

    def test_unreadable_checkpoint_is_rejected(self) -> None:
        check = _check(CheckpointInspection(CheckpointHealth.UNREADABLE, None))

        assert check.allowed is False
        assert "读取失败" in check.reason

    def test_corrupt_checkpoint_is_rejected(self) -> None:
        check = _check(CheckpointInspection(CheckpointHealth.CORRUPT, None))

        assert check.allowed is False
        assert "损坏" in check.reason

    def test_task_identity_mismatch_is_rejected(self) -> None:
        check = _check(_ok_inspection(task_id="another-task"))

        assert check.allowed is False
        assert "task_id" in check.reason
        assert "不一致" in check.reason

    def test_missing_recorded_task_identity_is_rejected(self) -> None:
        check = _check(_ok_inspection(task_id=""))

        assert check.allowed is False
        assert "task_id" in check.reason

    def test_plan_version_mismatch_is_rejected(self) -> None:
        check = _check(_ok_inspection(plan_version=2))

        assert check.allowed is False
        assert "plan_version" in check.reason
        assert "不一致" in check.reason

    def test_missing_plan_version_is_rejected(self) -> None:
        check = _check(_ok_inspection(plan_version=None))

        assert check.allowed is False
        assert "plan_version" in check.reason

    def test_blank_by_is_rejected(self) -> None:
        check = _check(_ok_inspection(), by="   ")

        assert check.allowed is False
        assert "--by" in check.reason

    def test_by_too_long_is_rejected(self) -> None:
        check = _check(_ok_inspection(), by="a" * (MAX_DECIDED_BY_LENGTH + 1))

        assert check.allowed is False
        assert "--by" in check.reason

    def test_by_at_limit_is_allowed(self) -> None:
        check = _check(_ok_inspection(), by="a" * MAX_DECIDED_BY_LENGTH)

        assert check.allowed is True

    def test_non_printable_by_is_rejected(self) -> None:
        check = _check(_ok_inspection(), by="own\x00er")

        assert check.allowed is False
        assert "--by" in check.reason

    def test_blank_reason_is_rejected(self) -> None:
        check = _check(_ok_inspection(), reason="   ")

        assert check.allowed is False
        assert "理由" in check.reason


class TestRetryDecisionPersistence:
    def _authorize(self, root: Path, *, at: datetime = WHEN) -> RetryAuthorization:
        _write_checkpoint(root)
        return authorize_retry(
            root,
            inspection=inspect_checkpoint(root, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by=BY,
            reason="人工核对后确认可续跑",
            at=at,
        )

    def test_successful_authorization_persists_decision(self, tmp_path: Path) -> None:
        outcome = self._authorize(tmp_path)

        assert outcome.allowed is True
        assert outcome.decision is not None
        latest = latest_retry_decision(tmp_path, REQ, TASK)
        assert latest is not None
        assert latest.requirement_id == REQ
        assert latest.task_id == TASK
        assert latest.decided_by == BY
        assert latest.reason == "人工核对后确认可续跑"
        assert latest.decided_at == WHEN

    def test_decision_records_plan_version_and_checkpoint_identity(self, tmp_path: Path) -> None:
        self._authorize(tmp_path)

        latest = latest_retry_decision(tmp_path, REQ, TASK)

        assert latest is not None
        # 决定必须绑定被校验过的方案版本与检查点身份，否则过期决定可清除本应被
        # 判为不可信的检查点。
        assert latest.plan_version == PLAN_VERSION
        assert latest.checkpoint_id == "cp-1"

    def test_decision_is_readable_after_reconnecting(self, tmp_path: Path) -> None:
        self._authorize(tmp_path)

        # 每次读取都新建连接：决定必须落在 records.sqlite，而非进程内存。
        assert latest_retry_decision(tmp_path, REQ, TASK) is not None
        assert latest_retry_decision(tmp_path, REQ, TASK) is not None

    def test_latest_decision_returns_most_recent(self, tmp_path: Path) -> None:
        self._authorize(tmp_path, at=WHEN)
        second = self._authorize(tmp_path, at=datetime(2026, 10, 16, 11, 0, tzinfo=UTC))

        latest = latest_retry_decision(tmp_path, REQ, TASK)

        assert second.decision is not None
        assert latest is not None
        assert latest.decided_at == second.decision.decided_at
        history = retry_decisions(tmp_path, REQ, TASK)
        assert [d.decided_at for d in history] == [WHEN, second.decision.decided_at]

    def test_history_filters_by_task(self, tmp_path: Path) -> None:
        self._authorize(tmp_path)
        plan = self._authorize(tmp_path)
        assert plan.decision is not None

        other = retry_decisions(tmp_path, REQ, "another-task")

        assert other == ()

    def test_missing_decision_reads_as_none(self, tmp_path: Path) -> None:
        assert latest_retry_decision(tmp_path, REQ, TASK) is None
        assert retry_decisions(tmp_path, REQ, TASK) == ()


class TestAuthorizeRetry:
    def test_success_clears_halted_reason_and_records_decision(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path)

        outcome = authorize_retry(
            tmp_path,
            inspection=inspect_checkpoint(tmp_path, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by=BY,
            reason="人工核对后确认可续跑",
            at=WHEN,
        )

        assert outcome.allowed is True
        assert outcome.checkpoint is not None
        assert outcome.checkpoint.halted_reason == ""
        assert outcome.decision is not None
        assert latest_retry_decision(tmp_path, REQ, TASK) is not None

    def test_rejected_authorization_has_no_side_effects(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, plan_version=2)

        outcome = authorize_retry(
            tmp_path,
            inspection=inspect_checkpoint(tmp_path, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by=BY,
            reason="人工核对后确认可续跑",
            at=WHEN,
        )

        assert outcome.allowed is False
        assert outcome.checkpoint is None
        assert outcome.decision is None
        assert latest_retry_decision(tmp_path, REQ, TASK) is None
        # 校验失败不得改动检查点现场：halted_reason 原样保留。
        untouched = read_checkpoint(tmp_path, THREAD)
        assert untouched is not None
        assert untouched.halted_reason == "pi_dev_unsettled"

    def test_by_is_normalized_before_persisting(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path)

        outcome = authorize_retry(
            tmp_path,
            inspection=inspect_checkpoint(tmp_path, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by="  owner  ",
            reason="人工核对后确认可续跑",
            at=WHEN,
        )

        assert outcome.allowed is True
        assert outcome.decision is not None
        assert outcome.decision.decided_by == "owner"

    def test_read_authorized_checkpoint_is_cleared_only_after_decision(
        self, tmp_path: Path
    ) -> None:
        _write_checkpoint(tmp_path)
        inspection = inspect_checkpoint(tmp_path, THREAD)

        before = read_authorized_checkpoint(tmp_path, THREAD, requirement_id=REQ, task_id=TASK)
        assert before is not None
        assert before.halted_reason == "pi_dev_unsettled"

        authorize_retry(
            tmp_path,
            inspection=inspection,
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by=BY,
            reason="人工核对后确认可续跑",
            at=WHEN,
        )

        after = read_authorized_checkpoint(tmp_path, THREAD, requirement_id=REQ, task_id=TASK)
        assert after is not None
        assert after.halted_reason == ""
        # 原始检查点仍是只读事实：清除通过决定叠加表达，不改写 LangGraph 库。
        raw = read_checkpoint(tmp_path, THREAD)
        assert raw is not None
        assert raw.halted_reason == "pi_dev_unsettled"

    def test_read_authorized_checkpoint_does_not_clear_when_checkpoint_changed(
        self, tmp_path: Path
    ) -> None:
        _write_checkpoint(tmp_path)
        authorize_retry(
            tmp_path,
            inspection=inspect_checkpoint(tmp_path, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status=INTERRUPTED,
            by=BY,
            reason="人工核对后确认可续跑",
            at=WHEN,
        )
        # 授权后同一线程的检查点被替换为不同 plan_version 的现场：旧决定不再匹配，
        # 有效现场必须保留 halted_reason，fail-closed。
        _write_checkpoint(tmp_path, plan_version=PLAN_VERSION + 1)

        result = read_authorized_checkpoint(tmp_path, THREAD, requirement_id=REQ, task_id=TASK)

        assert result is not None
        assert result.plan_version == PLAN_VERSION + 1
        assert result.halted_reason == "pi_dev_unsettled"

    def test_no_decision_is_written_when_status_mismatch(self, tmp_path: Path) -> None:
        _write_checkpoint(tmp_path, halted_reason="")

        outcome = authorize_retry(
            tmp_path,
            inspection=inspect_checkpoint(tmp_path, THREAD),
            requirement_id=REQ,
            task_id=TASK,
            plan_version=PLAN_VERSION,
            task_status="implementing",
            by=BY,
            reason="人工核对后确认可续跑",
            at=WHEN,
        )

        assert outcome.allowed is False
        assert outcome.checkpoint is None
        assert latest_retry_decision(tmp_path, REQ, TASK) is None
