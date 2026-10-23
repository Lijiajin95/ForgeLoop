"""依赖事实与真实阻塞判定：domain 纯规则与 records 只读取数。

覆盖验收要求：未满足前置清单、判定依据记录身份、未完成 ``started`` 动作、
真实等待、状态滞后不判为阻塞、依据缺失输出 ``unknown`` 并说明缺少哪条记录，
以及只读查询不改动权威记录。
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.domain.counting import FailureStage
from forgeloop.domain.dependency_facts import (
    DependencyFactsError,
    DependencyVerdict,
    PrerequisiteFact,
    TerminalState,
    assess_dependency,
)
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore, read_task_dependency_record

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


class TestAssessDependency:
    """domain 纯规则：给定权威事实即可判定，不读记录、不读时钟。"""

    def test_no_prerequisites_is_ready(self) -> None:
        facts = assess_dependency("subject")
        assert facts.verdict is DependencyVerdict.READY
        assert facts.unmet_prerequisites == ()
        assert facts.evidence == ()
        assert not facts.has_outstanding_action
        assert not facts.is_waiting
        assert facts.is_ready

    def test_all_prerequisites_terminal_is_ready(self) -> None:
        facts = assess_dependency(
            "subject",
            (
                PrerequisiteFact("a", TerminalState.DELIVERED, evidence=("deliveries:a",)),
                PrerequisiteFact(
                    "b",
                    TerminalState.ACCEPTED,
                    evidence=("approval_consumption:b:v1:acceptance",),
                ),
            ),
            subject_evidence=("tasks:subject",),
        )
        assert facts.verdict is DependencyVerdict.READY
        assert facts.unmet_prerequisites == ()
        assert facts.evidence == (
            "tasks:subject",
            "deliveries:a",
            "approval_consumption:b:v1:acceptance",
        )

    def test_unmet_prerequisite_without_action_waits(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", recorded_status="implementing", evidence=("tasks:a",)),),
        )
        assert facts.verdict is DependencyVerdict.WAITING
        assert facts.is_waiting
        assert facts.unmet_prerequisites == ("a",)
        assert not facts.has_outstanding_action

    def test_started_action_is_running(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a"),),
            outstanding_action="act-1",
        )
        assert facts.verdict is DependencyVerdict.RUNNING
        assert facts.has_outstanding_action
        assert facts.is_running
        assert "actions:act-1" in facts.evidence

    def test_missing_evidence_is_unknown_with_reason(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", missing=("tasks:a",)),),
        )
        assert facts.verdict is DependencyVerdict.UNKNOWN
        assert facts.is_unknown
        assert facts.missing_evidence == ("tasks:a",)

    def test_missing_evidence_takes_precedence_over_action_and_unmet(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", missing=("tasks:a",)),),
            outstanding_action="act-1",
        )
        assert facts.is_unknown
        assert not facts.is_running

    def test_stale_status_with_terminal_prerequisite_is_not_blocking(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", TerminalState.DELIVERED, recorded_status="blocked"),),
        )
        assert facts.is_ready
        assert not facts.is_waiting

    def test_evidence_and_missing_are_deduped_stably(self) -> None:
        facts = assess_dependency(
            "subject",
            (
                PrerequisiteFact("a", evidence=("tasks:a", "deliveries:a")),
                PrerequisiteFact(
                    "b",
                    evidence=("tasks:b", "deliveries:a"),
                    missing=("tasks:b", "tasks:b"),
                ),
            ),
        )
        assert facts.evidence == ("tasks:a", "deliveries:a", "tasks:b")
        assert facts.missing_evidence == ("tasks:b",)

    def test_unknown_prerequisite_counts_as_unmet(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", terminal=None, missing=("tasks:a",)),),
        )
        assert facts.unmet_prerequisites == ("a",)

    def test_blank_task_id_is_rejected(self) -> None:
        with pytest.raises(DependencyFactsError):
            assess_dependency("   ")

    def test_negative_failure_rounds_are_rejected(self) -> None:
        with pytest.raises(DependencyFactsError):
            assess_dependency("subject", failure_rounds=-1)

    def test_metadata_is_reported_without_affecting_verdict(self) -> None:
        facts = assess_dependency(
            "subject",
            (PrerequisiteFact("a", TerminalState.RELEASED),),
            recorded_status="time_exhausted",
            failure_rounds=3,
        )
        assert facts.is_ready
        assert facts.recorded_status == "time_exhausted"
        assert facts.failure_rounds == 3

    def test_blank_prerequisite_id_is_rejected(self) -> None:
        with pytest.raises(DependencyFactsError):
            PrerequisiteFact("   ")

    def test_unknown_terminal_value_is_rejected(self) -> None:
        with pytest.raises(DependencyFactsError):
            PrerequisiteFact("a", terminal=cast("TerminalState", "bogus"))


def planned(task_id: str, *, depends_on: tuple[str, ...] = ()) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=("pytest", f"tests/{task_id}.py", "-q"),
        depends_on=depends_on,
    )


@pytest.fixture()
def records(tmp_path: Path):
    """同一 records.sqlite 上打开两个记录存储，并批准一个两任务任务包。"""

    db_path = tmp_path / "records.sqlite"
    requirement_store = RequirementStore(db_path)
    record_store = RecordStore(db_path)
    requirement = requirement_store.submit("ForgeLoop", "需求：依赖事实")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=(planned("first"), planned("second", depends_on=("first",))),
        created_at=WHEN,
    )
    requirement_store.record_task_plan(requirement.req_id, plan)
    requirement_store.record_plan_approval(requirement.req_id, 1, "owner")
    yield requirement_store, record_store, requirement.req_id
    record_store.close()
    requirement_store.close()


class TestRequirementDependencyFacts:
    """records 只读：从权威记录汇总依赖事实，不改写任何既有记录。"""

    def _facts(self, requirement_store: RequirementStore, req_id: str, **kwargs):
        return {item.task_id: item for item in requirement_store.dependency_facts(req_id, **kwargs)}

    def test_missing_prerequisite_record_is_unknown(self, records) -> None:
        requirement_store, _record_store, req_id = records
        facts = self._facts(requirement_store, req_id)
        assert facts["first"].is_ready
        assert facts["second"].is_unknown
        assert facts["second"].missing_evidence == ("tasks:first",)

    def test_declared_prerequisite_without_terminal_waits(self, records) -> None:
        requirement_store, record_store, req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        facts = self._facts(requirement_store, req_id)
        assert not facts["first"].is_waiting  # 无前置，未启动也不算等待
        assert facts["second"].is_waiting
        assert facts["second"].unmet_prerequisites == ("first",)
        assert facts["second"].evidence == ("tasks:first",)
        assert facts["first"].recorded_status == "created"

    def test_started_action_is_running_not_waiting(self, records) -> None:
        requirement_store, record_store, req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        action = record_store.actions.begin("first", "dev")
        facts = self._facts(requirement_store, req_id)
        assert facts["first"].is_running
        assert facts["first"].outstanding_action == action.action_id
        assert f"actions:{action.action_id}" in facts["first"].evidence

    def test_delivered_prerequisite_is_ready_despite_stale_status(self, records) -> None:
        requirement_store, record_store, req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        record_store.set_task_status("first", "blocked")  # 状态滞后，不是判定依据
        record_store.outcomes.record_delivery("first", "candidate.diff", "report.json")
        facts = self._facts(requirement_store, req_id)
        assert facts["first"].is_ready
        assert facts["second"].is_ready
        assert not facts["second"].is_waiting
        assert "deliveries:first" in facts["second"].evidence

    def test_consumed_acceptance_is_terminal(self, records) -> None:
        requirement_store, record_store, req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        record_store.record_approval(Approval("first", 1, ApprovalStage.ACCEPTANCE, WHEN))
        consumed = record_store.consume_approval("first", 1, ApprovalStage.ACCEPTANCE)
        assert consumed.status.value == "ok"
        facts = self._facts(requirement_store, req_id)
        assert facts["second"].is_ready
        assert "approval_consumption:first:v1:acceptance" in facts["second"].evidence

    def test_single_task_id_mapper_is_used(self, records) -> None:
        requirement_store, _record_store, req_id = records
        facts = self._facts(
            requirement_store,
            req_id,
            single_task_id=lambda task_id: f"task-x-{task_id}",
        )
        assert facts["second"].missing_evidence == ("tasks:task-x-first",)

    def test_query_is_read_only(self, records) -> None:
        requirement_store, _record_store, req_id = records
        before = {
            table: requirement_store._db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("requirements", "requirement_task_plans", "tasks", "actions")
        }
        self._facts(requirement_store, req_id)
        after = {
            table: requirement_store._db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("requirements", "requirement_task_plans", "tasks", "actions")
        }
        assert before == after


class TestTaskDependencyRecordReader:
    """records 只读取数：缺表与终态优先级都如实处理。"""

    def test_absent_tables_report_missing_record(self, tmp_path: Path) -> None:
        db = sqlite3.connect(tmp_path / "empty.sqlite")
        try:
            record = read_task_dependency_record(db, "ghost")
        finally:
            db.close()
        assert record.exists is False
        assert record.missing == ("tasks:ghost",)
        assert record.terminal is None
        assert record.evidence == ()

    def test_merge_and_release_outrank_earlier_terminals(self, records) -> None:
        _requirement_store, record_store, _req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        record_store.outcomes.record_merge("first", "abc", pushed=False, push_detail="")
        merged = record_store.task_dependency_record("first")
        assert merged.terminal is TerminalState.MERGED
        assert "merges:first" in merged.evidence
        record_store.outcomes.record_release(
            ReleaseRecord(
                task_id="first",
                tag="v0.0.1",
                merge_commit="abc",
                baseline_commit="def",
                diff_sha256="a" * 64,
                receipt_path="receipt.json",
                pushed=False,
                push_detail="",
                released_at=WHEN,
            )
        )
        released = record_store.task_dependency_record("first")
        assert released.terminal is TerminalState.RELEASED
        assert "releases:first" in released.evidence

    def test_failure_rounds_are_read_without_deciding_blocking(self, records) -> None:
        _requirement_store, record_store, _req_id = records
        record_store.create_task("first", "ForgeLoop", "目标", {}, 100.0)
        record_store.record_failure("first", "r1", FailureStage.FORMAL_TEST, "失败")
        record = record_store.task_dependency_record("first")
        assert record.failure_rounds == 1
        assert "failure_rounds:first" in record.evidence
        assert record.terminal is None
