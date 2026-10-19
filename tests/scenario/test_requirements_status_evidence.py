"""场景测试：需求 ``status --json`` 汇总交付证据身份与显式 ``missing`` 列表。

覆盖 G02 cli-contract 的证据部分：

- 交付证据身份完整汇总候选内容摘要与 sha256、审查 sha256 及是否阻断、正式测试
  sha256/结果、产物 sha256、基线提交与验收绑定；
- 任一证据缺失都在 ``evidence.missing`` 与需求级 ``missing`` 中逐项列出，不省略
  字段、不把缺失推测为通过；
- 既有需求状态词与任务 ``state`` 不变，输出稳定可解析 JSON。
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from project_support import record_store, requirement_store
from support import task_dir

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id
from forgeloop.records.requirements import RequirementStore, TaskArtifact

pytestmark = pytest.mark.scenario

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


def approved_requirement(tmp_path: Path) -> tuple[RequirementStore, str]:
    store = requirement_store(tmp_path, legacy_project="proj")
    requirement = store.submit("proj", "需求：CLI 汇总交付证据身份")
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


def seed_single_task(
    tmp_path: Path,
    task_id: str,
    *,
    terminal: bool,
    exit_code: int = 0,
    blocking_issues: tuple[str, ...] = (),
    blocking_issues_valid: bool = True,
    marker: str = "a",
) -> None:
    """建立单任务记录与现场材料；``terminal`` 决定验收批准是否已消费。"""

    task_path = task_dir(tmp_path, task_id)
    task_path.mkdir(parents=True, exist_ok=True)
    (task_path / "candidate.diff").write_text(
        f"diff --git a/{marker}.py b/{marker}.py\n--- a/{marker}.py\n+++ b/{marker}.py\n"
        f"@@ -0,0 +1 @@\n+{marker}\n",
        encoding="utf-8",
    )
    (task_path / "review-report.json").write_text(
        json.dumps(
            {
                "summary": "review",
                "blocking_issues": list(blocking_issues),
                "blocking_issues_valid": blocking_issues_valid,
            }
        ),
        encoding="utf-8",
    )
    (task_path / "test-run.jsonl").write_text(
        json.dumps({"exit_code": exit_code}) + "\n", encoding="utf-8"
    )
    (task_path / "candidate-artifact.json").write_text(
        json.dumps({"sha256": marker * 64}), encoding="utf-8"
    )
    (task_path / "dev-reports.jsonl").write_text(
        json.dumps({"baseline_commit": marker * 40}) + "\n", encoding="utf-8"
    )
    store = record_store(tmp_path, legacy_project="proj")
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


class TestRequirementDeliveryEvidence:
    def test_evidence_identity_is_aggregated(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=True, marker="a")
        store = requirement_store(tmp_path, legacy_project="proj")
        try:
            store.record_task_artifact(
                req_id,
                1,
                "alpha",
                TaskArtifact("alpha", "c" * 64, "d" * 64, "e" * 64, "accepted", "approval"),
            )
        finally:
            store.close()

        document = requirement_status(tmp_path, req_id, capsys)
        evidence = by_task(document)["alpha"]["evidence"]
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
        assert evidence["acceptance"]["plan_version"] == 1
        assert evidence["acceptance"]["fingerprint"]
        assert evidence["missing"] == []
        assert document["requirement_status"] == "approved"  # 既有状态词不变
        assert_lower_snake_keys(document)

    def test_missing_evidence_lists_every_field(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()

        document = requirement_status(tmp_path, req_id, capsys)
        evidence = by_task(document)["alpha"]["evidence"]
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
        assert "alpha:evidence:candidate.sha256" in document["missing"]

    def test_blocking_review_and_failed_test_are_explicit(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(
            tmp_path, alpha, terminal=True, exit_code=1, blocking_issues=("缺边界检查",)
        )

        evidence = by_task(requirement_status(tmp_path, req_id, capsys))["alpha"]["evidence"]
        assert evidence["review"]["blocking"] is True
        assert evidence["test"]["result"] == "failed"
        assert evidence["test"]["exit_code"] == 1

    def test_unusable_review_result_is_missing_not_passing(self, tmp_path: Path, capsys) -> None:
        """审查结果不可用（``blocking_issues_valid`` 为假）不得误报为无阻断。"""

        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(
            tmp_path,
            alpha,
            terminal=True,
            blocking_issues=(),
            blocking_issues_valid=False,
        )

        document = requirement_status(tmp_path, req_id, capsys)
        evidence = by_task(document)["alpha"]["evidence"]
        assert evidence["review"]["blocking"] is None
        assert "review.blocking" in evidence["missing"]
        assert "alpha:evidence:review.blocking" in document["missing"]

    def test_review_report_without_validity_flag_is_missing(self, tmp_path: Path, capsys) -> None:
        """缺少 ``blocking_issues_valid`` 标志同样不可判定，不得猜为无阻断。"""

        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=True)
        (task_dir(tmp_path, alpha) / "review-report.json").write_text(
            json.dumps({"summary": "review", "blocking_issues": []}),
            encoding="utf-8",
        )

        evidence = by_task(requirement_status(tmp_path, req_id, capsys))["alpha"]["evidence"]
        assert evidence["review"]["blocking"] is None
        assert "review.blocking" in evidence["missing"]

    def test_missing_aggregates_across_tasks(self, tmp_path: Path, capsys) -> None:
        store, req_id = approved_requirement(tmp_path)
        store.close()
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, terminal=True)

        document = requirement_status(tmp_path, req_id, capsys)
        assert "beta:evidence:candidate.sha256" in document["missing"]
        assert "beta:evidence:acceptance.binding" in document["missing"]
