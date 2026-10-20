"""场景测试：阻断原因文本贯穿单任务与需求状态回查。

覆盖 G03 status-cli-wireup 的用户可见行为：

- 真实单任务入口：``submit`` 后 ``status --json`` 的 ``blocked_reason_text``
  非空并说明当前等待的门；
- 需求命令组：``requirement status --json`` 在需求级与每个任务条目上都给出
  非空 ``blocked_reason_text``，前置未满足时说明所缺前置，终态时也不留空；
- 既有 ``status``/``next_action``/``missing`` 字段名称与语义不变。
"""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import record_store, requirement_store
from support import status_document, submit_task

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.requirements import RequirementStore

pytestmark = pytest.mark.scenario

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


def approved_requirement(tmp_path: Path) -> tuple[RequirementStore, str, TaskPlan]:
    store = requirement_store(tmp_path, legacy_project="proj")
    requirement = store.submit("proj", "需求：状态回查给出阻断原因文本")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=(
            PlannedTask("alpha", "实现上游", ("src/a.py",), "验收", ("cmd",)),
            PlannedTask(
                "beta",
                "实现下游",
                ("src/b.py",),
                "验收",
                ("cmd",),
                depends_on=("alpha",),
            ),
        ),
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, 1, "owner")
    return store, requirement.req_id, plan


def seed_single_task(tmp_path: Path, task_id: str, *, terminal: bool = False) -> None:
    store = record_store(tmp_path, legacy_project="proj")
    try:
        store.create_task(task_id, "proj", "input", {}, 7200.0)
        store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
        store.record_approval(Approval(task_id, 1, ApprovalStage.PLAN, WHEN))
        store.record_approval(Approval(task_id, 1, ApprovalStage.ACCEPTANCE, WHEN))
        if terminal:
            store.consume_approval(task_id, 1, ApprovalStage.ACCEPTANCE)
    finally:
        store.close()


def requirement_status(tmp_path: Path, req_id: str, capsys) -> dict:
    code = cli_main(["requirement", "status", req_id, "--json", "--records-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0, captured.out
    return json.loads(captured.out)


def by_task(document: dict) -> dict[str, dict]:
    return {entry["task_id"]: entry for entry in document["tasks"]}


class TestSingleTaskCliFlow:
    def test_submitted_task_reports_awaiting_gate(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)

        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_plan_approval"
        assert document["blocked_reason_text"]
        assert "批准" in document["blocked_reason_text"]
        assert set(document["next_action"]) == {"action", "actor", "reason"}

    def test_text_output_includes_blocked_reason(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)

        code = cli_main(["status", task_id, "--records-root", str(tmp_path)])
        captured = capsys.readouterr()
        assert code == 0
        assert "阻断原因: " in captured.out


class TestRequirementStatusFlow:
    def test_every_task_and_requirement_has_non_empty_reason(self, tmp_path: Path, capsys) -> None:
        store, req_id, _ = approved_requirement(tmp_path)
        store.close()
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "alpha"))
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "beta"))

        document = requirement_status(tmp_path, req_id, capsys)
        assert document["blocked_reason_text"]
        entries = by_task(document)
        assert entries["alpha"]["blocked_reason_text"]
        assert entries["beta"]["blocked_reason_text"]

    def test_unmet_prerequisite_is_named(self, tmp_path: Path, capsys) -> None:
        store, req_id, _ = approved_requirement(tmp_path)
        store.close()
        # alpha 有记录但未达终态：beta 的真实等待应指出所缺前置。
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "alpha"))
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "beta"))

        entries = by_task(requirement_status(tmp_path, req_id, capsys))
        assert entries["beta"]["dependency"]["verdict"] == "waiting"
        assert "alpha" in entries["beta"]["blocked_reason_text"]

    def test_terminal_requirement_is_not_empty(self, tmp_path: Path, capsys) -> None:
        store, req_id, _ = approved_requirement(tmp_path)
        store.close()
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "alpha"), terminal=True)
        seed_single_task(tmp_path, requirement_task_id(req_id, 1, "beta"), terminal=True)

        document = requirement_status(tmp_path, req_id, capsys)
        assert document["blocked_reason_text"]
        assert by_task(document)["alpha"]["blocked_reason_text"]
        assert document["requirement_status"] != ""

    def test_missing_single_task_record_is_unknown_not_guessed(
        self, tmp_path: Path, capsys
    ) -> None:
        store, req_id, _ = approved_requirement(tmp_path)
        store.close()

        entries = by_task(requirement_status(tmp_path, req_id, capsys))
        text = entries["alpha"]["blocked_reason_text"]
        assert text
        assert "unknown" in text
        assert "tasks:" in text
