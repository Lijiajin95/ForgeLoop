"""CLI 组件测试：单任务 ``status --json`` 追加 ``blocked_reason_text``。

覆盖 G03 status-cli-wireup 的查询输出契约：

- 阻断原因文本由 ``domain.status_reason`` 从 ``RecordStore.status_reason_facts``
  只读读出的权威事实推导；正常推进与终态也给出一句非空中文说明，不返回空串；
- 既有字段（``status``/``next_action``/``missing`` 等）的名称与语义不变，
  输出稳定可解析 JSON，字段名小写下划线；
- 只读访问：``status_reason_facts`` 不隐式创建 ``grants`` 行。
"""

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from project_support import project_records, record_store

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.counting import FailureStage
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


def task_status(tmp_path: Path, task_id: str, capsys) -> dict:
    code = cli_main(["status", task_id, "--json", "--records-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0, captured.out
    return json.loads(captured.out)


def seed_task(tmp_path: Path, task_id: str = "task-1", *, plan: bool = False) -> RecordStore:
    """建立最小任务记录；``plan`` 为真时写入一条方案（仍未批准）。"""

    store = record_store(tmp_path)
    store.create_task(task_id, "proj", "input", {}, 7200.0)
    if plan:
        store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
    return store


def assert_lower_snake_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            assert key == key.lower()
            assert key[0].isalpha() and key[0].islower()
            assert all(part.isalnum() for part in key.split("_") if part)
            assert_lower_snake_keys(item)
    elif isinstance(value, list):
        for item in value:
            assert_lower_snake_keys(item)


class TestBlockedReasonText:
    def test_created_task_is_non_empty(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path)
        store.close()

        document = task_status(tmp_path, "task-1", capsys)
        assert document["blocked_reason_text"]
        assert document["blocked_reason_text"] == "任务正常推进，暂无阻断条件"
        assert document["status"] == "created"  # 既有状态词不变

    def test_awaiting_plan_approval_names_the_gate(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path, plan=True)
        store.close()

        text = task_status(tmp_path, "task-1", capsys)["blocked_reason_text"]
        assert text
        assert "批准" in text
        assert "方案" in text

    def test_running_reports_current_action_identity(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path, plan=True)
        store.record_approval(Approval("task-1", 1, ApprovalStage.PLAN, WHEN))
        action = store.actions.begin("task-1", "implementing")
        store.close()

        text = task_status(tmp_path, "task-1", capsys)["blocked_reason_text"]
        assert "执行" in text
        assert action.action_id in text

    def test_grant_exhausted_reports_used_and_limit(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path)
        for index in range(3):
            store.record_failure("task-1", f"round-{index}", FailureStage.FORMAL_TEST, "failed")
        store.close()

        text = task_status(tmp_path, "task-1", capsys)["blocked_reason_text"]
        assert "失败轮次额度已用尽" in text
        assert "已用 3 轮" in text
        assert "上限 3 轮" in text

    def test_terminal_task_is_non_empty(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path)
        store.outcomes.record_delivery("task-1", "candidate.diff", "delivery-report.json")
        store.close()

        document = task_status(tmp_path, "task-1", capsys)
        assert document["blocked_reason_text"]
        assert "终态" in document["blocked_reason_text"]


class TestExistingFieldsUnchanged:
    def test_status_next_action_and_missing_semantics_hold(self, tmp_path: Path, capsys) -> None:
        store = seed_task(tmp_path)
        store.close()

        document = task_status(tmp_path, "task-1", capsys)
        for field in ("status", "next_action", "missing", "plan", "failures", "budget"):
            assert field in document
        assert set(document["next_action"]) == {"action", "actor", "reason"}
        assert isinstance(document["missing"], list)
        assert document["next_action"]["actor"] in {"user", "agent"}
        assert_lower_snake_keys(document)


class TestReadOnlyFacts:
    def test_status_reason_facts_does_not_create_grants_row(self, tmp_path: Path) -> None:
        store = seed_task(tmp_path)
        try:
            store.status_reason_facts("task-1")
        finally:
            store.close()

        connection = sqlite3.connect(project_records(tmp_path) / "records.sqlite")
        try:
            count = connection.execute(
                "SELECT COUNT(*) FROM grants WHERE task_id = ?", ("task-1",)
            ).fetchone()[0]
        finally:
            connection.close()
        assert count == 0

    def test_status_reason_facts_reports_missing_task(self, tmp_path: Path) -> None:
        store = record_store(tmp_path)
        try:
            facts = store.status_reason_facts("ghost")
        finally:
            store.close()
        assert facts.missing == ("tasks:ghost",)
