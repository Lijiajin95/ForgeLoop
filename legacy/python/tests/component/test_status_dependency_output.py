"""CLI 组件测试：需求 ``status --json`` 追加依赖事实与阻塞判断。

覆盖 G02 cli-contract 的查询输出契约：

- 依赖事实与阻塞判断由权威记录只读判定：未达终态的前置使下游 ``waiting``，
  存在 ``started`` 未完成动作即 ``running``，前置记录缺失输出 ``unknown`` 并
  列出缺少的记录，前置已终态则 ``ready``；不新增状态词、不改既有语义；
- 输出稳定可解析 JSON，字段名小写下划线，既有字段（req_id/requirement_status/
  任务 state）不变。
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from project_support import project_records, record_store, requirement_store

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.requirements import RequirementStore

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


def approved_requirement(tmp_path: Path) -> tuple[RequirementStore, str]:
    store = requirement_store(tmp_path)
    requirement = store.submit("proj", "需求：CLI 输出依赖事实")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=(
            PlannedTask("alpha", "实现上游", ("src/a.py",), "验收", ("cmd",)),
            PlannedTask("beta", "实现下游", ("src/b.py",), "验收", ("cmd",), depends_on=("alpha",)),
        ),
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, 1, "owner")
    return store, requirement.req_id


def seed_single_task(tmp_path: Path, task_id: str, *, terminal: bool) -> None:
    task_dir = project_records(tmp_path) / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    store = record_store(tmp_path)
    try:
        store.create_task(task_id, "proj", "input", {}, 7200.0)
        store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
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


class TestDependencyOutput:
    def test_unmet_prerequisite_is_waiting(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=False)

        document = requirement_status(tmp_path, req_id, capsys)
        entries = by_task(document)
        assert document["req_id"] == req_id
        assert document["requirement_status"] == "approved"  # 既有状态词不变
        assert entries["alpha"]["state"] == "pending"  # 既有任务状态词不变
        assert entries["beta"]["dependency"]["verdict"] == "waiting"
        assert entries["beta"]["dependency"]["is_waiting"] is True
        assert entries["beta"]["dependency"]["unmet_prerequisites"] == ["alpha"]
        assert_lower_snake_keys(document)

    def test_terminal_prerequisite_is_ready(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=True)

        entries = by_task(requirement_status(tmp_path, req_id, capsys))
        assert entries["alpha"]["dependency"]["verdict"] == "ready"
        assert entries["beta"]["dependency"]["verdict"] == "ready"
        assert entries["beta"]["dependency"]["unmet_prerequisites"] == []

    def test_missing_prerequisite_record_is_unknown(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")

        document = requirement_status(tmp_path, req_id, capsys)
        entries = by_task(document)
        assert entries["beta"]["dependency"]["verdict"] == "unknown"
        assert entries["beta"]["dependency"]["is_unknown"] is True
        assert f"tasks:{alpha}" in entries["beta"]["dependency"]["missing"]
        assert f"beta:dependency:tasks:{alpha}" in document["missing"]

    def test_outstanding_action_is_running(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        beta = requirement_task_id(req_id, 1, "beta")
        seed_single_task(tmp_path, alpha, terminal=True)
        seed_single_task(tmp_path, beta, terminal=False)
        store = record_store(tmp_path)
        try:
            store.actions.begin(beta, "dev")
        finally:
            store.close()

        entries = by_task(requirement_status(tmp_path, req_id, capsys))
        assert entries["beta"]["dependency"]["verdict"] == "running"
        assert entries["beta"]["dependency"]["is_running"] is True
        assert entries["beta"]["dependency"]["outstanding_action"]

    def test_status_word_lag_does_not_block(self, tmp_path: Path, capsys) -> None:
        """前置已终态时，即使记录状态词滞后也不判为阻塞（状态词不参与判定）。"""

        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=True)
        store = record_store(tmp_path)
        try:
            store.set_task_status(alpha, "blocked")
        finally:
            store.close()

        entries = by_task(requirement_status(tmp_path, req_id, capsys))
        assert entries["beta"]["dependency"]["verdict"] == "ready"
        assert entries["alpha"]["dependency"]["recorded_status"] == "blocked"


def seed_materials(
    task_dir: Path,
    *,
    marker: str = "a",
    exit_code: int = 0,
    blocking_valid: bool = True,
    blocking_issues: tuple[str, ...] = (),
) -> None:
    """写入单任务交付现场材料；标记字符决定 sha 内容，避免样本相互碰撞。"""

    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "candidate.diff").write_text(
        f"diff --git a/{marker}.py b/{marker}.py\n--- a/{marker}.py\n+++ b/{marker}.py\n"
        f"@@ -0,0 +1 @@\n+{marker}\n",
        encoding="utf-8",
    )
    (task_dir / "review-report.json").write_text(
        json.dumps(
            {
                "summary": "review",
                "blocking_issues": list(blocking_issues),
                "blocking_issues_valid": blocking_valid,
            }
        ),
        encoding="utf-8",
    )
    (task_dir / "test-run.jsonl").write_text(
        json.dumps({"exit_code": exit_code}) + "\n", encoding="utf-8"
    )
    (task_dir / "candidate-artifact.json").write_text(
        json.dumps({"sha256": marker * 64}), encoding="utf-8"
    )
    (task_dir / "dev-reports.jsonl").write_text(
        json.dumps({"baseline_commit": marker * 40}) + "\n", encoding="utf-8"
    )


def task_status(tmp_path: Path, task_id: str, capsys) -> dict:
    code = cli_main(["status", task_id, "--json", "--records-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0, captured.out
    return json.loads(captured.out)


class TestSingleTaskStatusEvidence:
    """单任务 ``forgeloop status --json`` 同样追加证据身份与 missing（G02）。"""

    def test_evidence_identity_is_aggregated(self, tmp_path: Path, capsys) -> None:
        task_id = "task-evidence"
        seed_materials(project_records(tmp_path) / task_id, marker="a")
        store = record_store(tmp_path)
        try:
            store.create_task(task_id, "proj", "input", {}, 7200.0)
            store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
            store.record_approval(Approval(task_id, 1, ApprovalStage.ACCEPTANCE, WHEN))
            store.consume_approval(task_id, 1, ApprovalStage.ACCEPTANCE)
        finally:
            store.close()

        document = task_status(tmp_path, task_id, capsys)
        evidence = document["evidence"]
        assert document["task_id"] == task_id  # 既有字段语义不变
        assert "status" in document
        assert document["dependency"]["verdict"] == "ready"
        assert document["dependency"]["missing"] == []
        assert evidence["candidate"]["summary"] == "1 files changed, +1 -0"
        assert evidence["candidate"]["sha256"]
        assert evidence["review"]["sha256"]
        assert evidence["review"]["blocking"] is False
        assert evidence["test"]["sha256"]
        assert evidence["test"]["result"] == "passed"
        assert evidence["test"]["exit_code"] == 0
        assert evidence["artifact"]["sha256"] == "a" * 64
        assert evidence["baseline_commit"] == "a" * 40
        assert evidence["acceptance"]["bound"] is True
        assert evidence["acceptance"]["accepted"] is True
        assert evidence["acceptance"]["fingerprint"]
        assert evidence["missing"] == []
        assert document["missing"] == []
        assert_lower_snake_keys(document)

    def test_missing_evidence_lists_every_field(self, tmp_path: Path, capsys) -> None:
        task_id = "task-bare"
        store = record_store(tmp_path)
        try:
            store.create_task(task_id, "proj", "input", {}, 7200.0)
        finally:
            store.close()

        document = task_status(tmp_path, task_id, capsys)
        evidence = document["evidence"]
        for item in (
            "candidate.summary",
            "candidate.sha256",
            "review.sha256",
            "review.blocking",
            "test.sha256",
            "test.result",
            "artifact.sha256",
            "baseline_commit",
            "acceptance.binding",
        ):
            assert item in evidence["missing"]
            assert f"{task_id}:evidence:{item}" in document["missing"]

    def test_blocking_review_and_failed_test_are_explicit(self, tmp_path: Path, capsys) -> None:
        task_id = "task-failed"
        seed_materials(
            project_records(tmp_path) / task_id,
            marker="b",
            exit_code=1,
            blocking_issues=("缺边界检查",),
        )
        store = record_store(tmp_path)
        try:
            store.create_task(task_id, "proj", "input", {}, 7200.0)
            store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
            store.record_approval(Approval(task_id, 1, ApprovalStage.ACCEPTANCE, WHEN))
            store.consume_approval(task_id, 1, ApprovalStage.ACCEPTANCE)
        finally:
            store.close()

        evidence = task_status(tmp_path, task_id, capsys)["evidence"]
        assert evidence["review"]["blocking"] is True
        assert evidence["test"]["result"] == "failed"
        assert evidence["test"]["exit_code"] == 1

    def test_unusable_review_result_is_missing_not_passing(self, tmp_path: Path, capsys) -> None:
        task_id = "task-review-unknown"
        seed_materials(project_records(tmp_path) / task_id, marker="c", blocking_valid=False)
        store = record_store(tmp_path)
        try:
            store.create_task(task_id, "proj", "input", {}, 7200.0)
            store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("cmd",)))
            store.record_approval(Approval(task_id, 1, ApprovalStage.ACCEPTANCE, WHEN))
            store.consume_approval(task_id, 1, ApprovalStage.ACCEPTANCE)
        finally:
            store.close()

        document = task_status(tmp_path, task_id, capsys)
        evidence = document["evidence"]
        assert evidence["review"]["blocking"] is None
        assert "review.blocking" in evidence["missing"]
        assert f"{task_id}:evidence:review.blocking" in document["missing"]

    def test_outstanding_action_reports_running(self, tmp_path: Path, capsys) -> None:
        task_id = "task-running"
        store = record_store(tmp_path)
        try:
            store.create_task(task_id, "proj", "input", {}, 7200.0)
            store.actions.begin(task_id, "dev")
        finally:
            store.close()

        document = task_status(tmp_path, task_id, capsys)
        assert document["dependency"]["verdict"] == "running"
        assert document["dependency"]["is_running"] is True
        assert document["dependency"]["outstanding_action"]
