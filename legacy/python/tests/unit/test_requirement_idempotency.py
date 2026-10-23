"""幂等提交与审计归属（2026-10-18 所有者决定：加列实现幂等键、补审计归属列）。

两件事都在**既有表**上加列（不新建业务状态表），因此这里同时核对三面：

- 新库：建表语句就带列与幂等键的部分唯一索引；
- 旧库：`_migrate` 能平滑补列（用旧版建表语句造一个真实旧库再打开）；
- 语义：同键同内容幂等命中、同键不同内容 fail-closed、空键保持历史行为；
  批准/停止/提交/验收四类操作的「谁、从哪来、依据什么材料」都能回查。
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.domain.requirement import IdempotencyConflictError, RequirementNotFoundError
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

WHEN = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)

OLD_REQUIREMENTS_SCHEMA = """
CREATE TABLE requirements (
    req_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    blocked_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE requirement_versions (
    req_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (req_id, version)
);
"""

OLD_TASK_SCHEMA = """
CREATE TABLE approvals (
    task_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    stage TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (task_id, stage, plan_version)
);
CREATE TABLE stops (
    task_id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    confirmed_at TEXT,
    note TEXT NOT NULL DEFAULT ''
);
"""


class TestIdempotentSubmit:
    def test_same_key_and_text_returns_the_same_requirement(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            first = store.submit_once("ForgeLoop", "原文", client_key="key-1", submitted_by="owner")
            second = store.submit_once(
                "ForgeLoop", "原文", client_key="key-1", submitted_by="owner"
            )
            rows = store._db.execute("SELECT COUNT(*) FROM requirements").fetchone()
        finally:
            store.close()

        assert first.created is True
        assert second.created is False, "幂等命中不得再建一条需求"
        assert second.requirement.req_id == first.requirement.req_id
        assert rows == (1,)

    def test_same_key_with_different_text_is_refused(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            store.submit_once("ForgeLoop", "原文", client_key="key-1")
            with pytest.raises(IdempotencyConflictError, match="原文不同"):
                store.submit_once("ForgeLoop", "改了内容", client_key="key-1")
            rows = store._db.execute("SELECT COUNT(*) FROM requirements").fetchone()
        finally:
            store.close()

        assert rows == (1,), "冲突时不得写入第二条"

    def test_empty_key_keeps_the_historical_behaviour(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            first = store.submit("ForgeLoop", "同一段原文")
            second = store.submit("ForgeLoop", "同一段原文")
        finally:
            store.close()

        assert first.req_id != second.req_id

    def test_attribution_and_key_are_readable(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            outcome = store.submit_once(
                "ForgeLoop",
                "原文",
                client_key="key-9",
                submitted_by="owner",
                source="web",
            )
            attribution = store.submission_attribution(outcome.requirement.req_id)
        finally:
            store.close()

        assert attribution == ("owner", "web", "key-9")

    def test_key_is_trimmed_and_blank_keys_do_not_collide(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            first = store.submit_once("ForgeLoop", "a", client_key="  ")
            second = store.submit_once("ForgeLoop", "b", client_key="")
            keyed = store.submit_once("ForgeLoop", "c", client_key="  key-x  ")
            again = store.submit_once("ForgeLoop", "c", client_key="key-x")
        finally:
            store.close()

        assert {first.created, second.created, keyed.created} == {True}
        assert again.created is False, "键两侧空白应被裁掉后视为同一个键"
        assert first.requirement.req_id != second.requirement.req_id


class TestRequirementAcceptanceRecord:
    def test_acceptance_records_who_when_and_material(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            requirement = store.submit("ForgeLoop", "原文")
            before = store.requirement_acceptance(requirement.req_id)
            store.record_requirement_acceptance(
                requirement.req_id,
                accepted_by="owner",
                source="web:owner",
                fingerprint="f" * 64,
                at=WHEN,
            )
            after = store.requirement_acceptance(requirement.req_id)
            status = store._db.execute(
                "SELECT status FROM requirements WHERE req_id = ?", (requirement.req_id,)
            ).fetchone()
        finally:
            store.close()

        assert before == {
            "accepted_at": "",
            "accepted_by": "",
            "acceptance_source": "",
            "acceptance_fingerprint": "",
        }
        assert after["accepted_by"] == "owner"
        assert after["acceptance_source"] == "web:owner"
        assert after["acceptance_fingerprint"] == "f" * 64
        assert after["accepted_at"].startswith("2026-10-18T12:00")
        assert status == ("accepted",)

    def test_unknown_requirement_fails_loudly(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            with pytest.raises(RequirementNotFoundError):
                store.record_requirement_acceptance(
                    "req-不存在", accepted_by="owner", source="web", fingerprint="x"
                )
            with pytest.raises(RequirementNotFoundError):
                store.requirement_acceptance("req-不存在")
        finally:
            store.close()


class TestTaskDecisionAttribution:
    def test_approval_keeps_actor_and_source(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.record_approval(
                Approval(
                    "task-1",
                    1,
                    ApprovalStage.ACCEPTANCE,
                    WHEN,
                    approved_by="owner",
                    source="web:owner",
                )
            )
            approval = store.effective_approval("task-1", ApprovalStage.ACCEPTANCE)
        finally:
            store.close()

        assert approval is not None
        assert (approval.approved_by, approval.source) == ("owner", "web:owner")

    def test_stop_keeps_requester_and_source(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.outcomes.request_stop("task-1", "页面停止", requested_by="owner", source="web")
            attribution = store.outcomes.stop_attribution("task-1")
            record = store.outcomes.stop_record("task-1")
        finally:
            store.close()

        assert attribution == ("owner", "web")
        assert record is not None and record[2] == "页面停止", "理由仍进 note，不与归属混装"

    def test_missing_stop_record_yields_empty_attribution(self, tmp_path: Path) -> None:
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            assert store.outcomes.stop_attribution("task-没有") == ("", "")
        finally:
            store.close()


class TestAcceptanceFingerprint:
    """材料指纹必须「同材料同值、换材料换值、与任务顺序无关」。"""

    def _binding(self, task_id: str, candidate: str, test: str, review: str):
        from forgeloop.domain.delivery import DeliveryBinding

        return DeliveryBinding(
            task_id=task_id,
            plan_version=1,
            candidate_sha256=candidate,
            test_evidence_sha256=test,
            review_sha256=review,
            artifact_sha256="",
            baseline_commit="",
        )

    def test_order_independent_and_sensitive_to_each_material(self) -> None:
        from forgeloop.cli.main import _acceptance_fingerprint

        first = self._binding("task-a", "1" * 64, "2" * 64, "3" * 64)
        second = self._binding("task-b", "4" * 64, "5" * 64, "6" * 64)

        base = _acceptance_fingerprint({"task-a": first, "task-b": second})
        swapped = _acceptance_fingerprint({"task-b": second, "task-a": first})
        assert base == swapped, "指纹只看材料身份集合，不看插入顺序"
        assert len(base) == 64

        replaced = self._binding("task-b", "4" * 64, "5" * 64, "7" * 64)
        assert _acceptance_fingerprint({"task-a": first, "task-b": replaced}) != base
        assert _acceptance_fingerprint({"task-a": first}) != base


class TestOldDatabaseUpgrade:
    """旧库平滑升级：既有记录照常可读，新列由 _migrate 补上。"""

    def test_requirements_old_schema_gains_columns_and_index(self, tmp_path: Path) -> None:
        db_path = tmp_path / "records.sqlite"
        connection = sqlite3.connect(db_path)
        connection.executescript(OLD_REQUIREMENTS_SCHEMA)
        connection.execute(
            "INSERT INTO requirements (req_id, project, created_at) VALUES (?, ?, ?)",
            ("req-old", "ForgeLoop", "2026-10-01T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO requirement_versions (req_id, version, text, created_at)"
            " VALUES (?, ?, ?, ?)",
            ("req-old", 1, "旧库原文", "2026-10-01T00:00:00+00:00"),
        )
        connection.commit()
        connection.close()

        store = RequirementStore(db_path)
        try:
            columns = {str(row[1]) for row in store._db.execute("PRAGMA table_info(requirements)")}
            indexes = {str(row[1]) for row in store._db.execute("PRAGMA index_list(requirements)")}
            old = store.get("req-old")
            attribution = store.submission_attribution("req-old")
            fresh = store.submit_once("ForgeLoop", "新库原文", client_key="key-new")
        finally:
            store.close()

        for name in (
            "submitted_by",
            "source",
            "client_key",
            "accepted_at",
            "accepted_by",
            "acceptance_source",
            "acceptance_fingerprint",
        ):
            assert name in columns, name
        assert "idx_requirements_client_key" in indexes
        assert old.latest.text == "旧库原文", "旧记录必须照常可读"
        assert attribution == ("", "", ""), "旧记录归属为空串而不是报错"
        assert fresh.created is True

    def test_task_tables_old_schema_gains_attribution_columns(self, tmp_path: Path) -> None:
        db_path = tmp_path / "records.sqlite"
        connection = sqlite3.connect(db_path)
        connection.executescript(OLD_TASK_SCHEMA)
        connection.execute(
            "INSERT INTO approvals (task_id, plan_version, stage, decided_at) VALUES (?, ?, ?, ?)",
            ("task-old", 1, "plan", "2026-10-01T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO stops (task_id, requested_at, note) VALUES (?, ?, ?)",
            ("task-old", "2026-10-01T00:00:00+00:00", "旧停止"),
        )
        connection.commit()
        connection.close()

        store = RecordStore(db_path)
        try:
            approval = store.effective_approval("task-old", ApprovalStage.PLAN)
            attribution = store.outcomes.stop_attribution("task-old")
            stop = store.outcomes.stop_record("task-old")
        finally:
            store.close()

        assert approval is not None and approval.approved_by == "" and approval.source == ""
        assert attribution == ("", "")
        assert stop is not None and stop[2] == "旧停止"


class TestRequirementCancellation:
    """取消需求（2026-10-19）：终态 + 人工决定留痕，**不删除任何记录**。"""

    def test_cancel_records_decision_and_sets_terminal_status(self, tmp_path) -> None:
        from forgeloop.domain.requirement import CANCELLED
        from forgeloop.records.requirements import RequirementStore

        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            requirement = store.submit("ForgeLoop", "取消测试：批量导出")
            store.record_requirement_cancellation(
                requirement.req_id, by="owner", reason="不再需要该需求"
            )
            assert store.requirement_status(requirement.req_id) == CANCELLED
            decision = store.requirement_cancellation(requirement.req_id)
            assert decision is not None
            assert decision == {
                "cancelled_by": "owner",
                "reason": "不再需要该需求",
                "cancelled_at": decision["cancelled_at"],
            }
            assert decision["cancelled_at"]
        finally:
            store.close()

    def test_missing_reason_or_by_is_refused_without_side_effects(self, tmp_path) -> None:
        from forgeloop.domain.requirement import CANCELLED
        from forgeloop.records.requirements import RequirementStore

        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            requirement = store.submit("ForgeLoop", "取消测试：缺理由")
            cases = (("", "理由"), ("owner", "  "))
            for decided_by, reason in cases:
                with pytest.raises(Exception, match="必须给出"):
                    store.record_requirement_cancellation(
                        requirement.req_id, by=decided_by, reason=reason
                    )
            assert store.requirement_status(requirement.req_id) != CANCELLED
            assert store.requirement_cancellation(requirement.req_id) is None
        finally:
            store.close()

    def test_cancelling_twice_keeps_the_first_decision(self, tmp_path) -> None:
        from forgeloop.records.requirements import RequirementStore

        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            requirement = store.submit("ForgeLoop", "取消测试：重复取消")
            store.record_requirement_cancellation(requirement.req_id, by="owner", reason="第一次")
            store.record_requirement_cancellation(requirement.req_id, by="someone", reason="第二次")
            decision = store.requirement_cancellation(requirement.req_id)
            assert decision is not None and decision["reason"] == "第一次"
        finally:
            store.close()
