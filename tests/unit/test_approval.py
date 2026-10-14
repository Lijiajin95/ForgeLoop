"""批准绑定规则：重复或旧版本决定不能重复执行（V0-02/V0-03 关键路径）。"""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.approval import (
    Approval,
    ApprovalBook,
    ApprovalStage,
    ConsumeStatus,
    Plan,
)
from forgeloop.domain.delivery import (
    DeliveryBinding,
    RequirementDelivery,
    TaskDelivery,
    assess_requirement_acceptance,
    build_binding,
    sha256_of_text,
    verify_binding,
)
from forgeloop.records.store import RecordStore


def decided_at(minute: int) -> datetime:
    return datetime(2026, 10, 12, 12, minute, tzinfo=UTC)


def binding(task_id: str = "task-1", version: int = 1, marker: str = "a") -> DeliveryBinding:
    """确定性的交付绑定：同一 marker 产生同一材料身份。"""

    return build_binding(
        task_id,
        version,
        candidate_text=f"diff-{marker}",
        test_evidence_text=f"tests-{marker}",
        review_text=f"review-{marker}",
    )


class TestPlan:
    def test_plan_requires_test_command(self) -> None:
        with pytest.raises(ValueError, match="test command"):
            Plan("task-1", 1, "goal", "scope", "acceptance", ())

    def test_plan_version_must_be_positive(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            Plan("task-1", 0, "goal", "scope", "acceptance", ("pytest",))


class TestApprovalBook:
    def test_consume_ok_marks_used_once(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        first = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert first.status is ConsumeStatus.OK
        assert first.approval is not None and first.approval.plan_version == 1
        assert first.reason == ""
        second = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert second.status is ConsumeStatus.ALREADY_USED
        assert second.approval is not None  # 拒绝结果仍携带对应批准
        assert second.reason  # 拒绝原因非空（供人工核对）

    def test_missing_approval_blocks_execution(self) -> None:
        book = ApprovalBook()
        result = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert result.status is ConsumeStatus.MISSING
        assert "未批准" in result.reason

    def test_stale_version_is_rejected(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        result = book.consume("task-1", 1, ApprovalStage.PLAN)
        assert result.status is ConsumeStatus.STALE
        assert result.approval is not None and result.approval.plan_version == 2
        assert result.reason

    def test_newer_version_consumes_normally(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        assert book.consume("task-1", 2, ApprovalStage.PLAN).status is ConsumeStatus.OK

    def test_recording_older_approval_than_effective_is_rejected(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)))
        with pytest.raises(ValueError, match="older"):
            book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))

    def test_recording_same_version_is_idempotent_update(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(0)))
        book.record(Approval("task-1", 2, ApprovalStage.PLAN, decided_at(5)))  # 同版本不视为降级
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.decided_at == decided_at(5)

    def test_stages_are_independent(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 3, ApprovalStage.PLAN, decided_at(0)))
        assert book.effective("task-1", ApprovalStage.ACCEPTANCE) is None
        assert book.consume("task-1", 3, ApprovalStage.ACCEPTANCE).status is ConsumeStatus.MISSING

    def test_mark_consumed_rebuilds_state_without_new_approval(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        book.mark_consumed("task-1", 1, ApprovalStage.PLAN)
        assert book.consume("task-1", 1, ApprovalStage.PLAN).status is ConsumeStatus.ALREADY_USED

    def test_rebuild_keeps_highest_version_effective(self) -> None:
        approvals = (
            Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)),
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.plan_version == 2

    def test_rebuild_is_input_order_independent(self) -> None:
        approvals = (
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(1)),
            Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.plan_version == 2

    def test_rebuild_keeps_latest_same_version_approval(self) -> None:
        approvals = (
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(0)),
            Approval("task-1", 2, ApprovalStage.PLAN, decided_at(5)),
        )
        book = ApprovalBook(approvals)
        effective = book.effective("task-1", ApprovalStage.PLAN)
        assert effective is not None and effective.decided_at == decided_at(5)


class TestMaterialBinding:
    """验收批准绑定实际材料：替换 diff/测试/产物后原批准不能沿用。"""

    def approval(self, material: DeliveryBinding | None = None) -> Approval:
        return Approval(
            "task-1",
            1,
            ApprovalStage.ACCEPTANCE,
            decided_at(0),
            material if material is not None else binding(),
        )

    def test_unchanged_material_consumes_once(self) -> None:
        book = ApprovalBook()
        bound = binding()
        book.record(self.approval(bound))
        first = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, bound)
        assert first.status is ConsumeStatus.OK
        assert first.approval is not None and first.approval.binding == bound
        second = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, bound)
        assert second.status is ConsumeStatus.ALREADY_USED

    def test_replaced_candidate_invalidates_approval(self) -> None:
        book = ApprovalBook()
        book.record(self.approval(binding(marker="a")))
        result = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, binding(marker="b"))
        assert result.status is ConsumeStatus.MATERIAL_CHANGED
        assert "候选 diff" in result.reason
        assert "不能沿用原批准" in result.reason

    def test_replaced_test_evidence_invalidates_approval(self) -> None:
        approved = binding()
        current = DeliveryBinding(
            approved.task_id,
            approved.plan_version,
            approved.candidate_sha256,
            "f" * 64,
            approved.review_sha256,
        )
        book = ApprovalBook()
        book.record(self.approval(approved))
        result = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, current)
        assert result.status is ConsumeStatus.MATERIAL_CHANGED
        assert "正式测试证据" in result.reason

    def test_replaced_review_invalidates_approval(self) -> None:
        approved = binding()
        current = DeliveryBinding(
            approved.task_id,
            approved.plan_version,
            approved.candidate_sha256,
            approved.test_evidence_sha256,
            "e" * 64,
        )
        book = ApprovalBook()
        book.record(self.approval(approved))
        result = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, current)
        assert result.status is ConsumeStatus.MATERIAL_CHANGED
        assert "独立审查结论" in result.reason

    def test_replaced_artifact_invalidates_approval(self) -> None:
        approved = binding()
        current = DeliveryBinding(
            approved.task_id,
            approved.plan_version,
            approved.candidate_sha256,
            approved.test_evidence_sha256,
            approved.review_sha256,
            artifact_sha256="d" * 64,
        )
        book = ApprovalBook()
        book.record(self.approval(approved))
        result = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, current)
        assert result.status is ConsumeStatus.MATERIAL_CHANGED
        assert "候选产物" in result.reason

    def test_missing_current_material_is_rejected(self) -> None:
        book = ApprovalBook()
        book.record(self.approval())
        result = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE)
        assert result.status is ConsumeStatus.MATERIAL_CHANGED
        assert "缺少当前材料身份" in result.reason

    def test_material_change_results_still_carry_the_approval(self) -> None:
        """材料变化拒绝仍返回对应批准，供人工核对是哪次决定被拒。"""

        book = ApprovalBook()
        book.record(self.approval(binding(marker="a")))
        missing = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE)
        replaced = book.consume("task-1", 1, ApprovalStage.ACCEPTANCE, binding(marker="b"))
        assert missing.status is ConsumeStatus.MATERIAL_CHANGED and missing.approval is not None
        assert replaced.status is ConsumeStatus.MATERIAL_CHANGED and replaced.approval is not None

    def test_plan_approval_without_binding_still_consumes(self) -> None:
        book = ApprovalBook()
        book.record(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
        assert book.consume("task-1", 1, ApprovalStage.PLAN).status is ConsumeStatus.OK

    def test_verify_binding_reports_task_and_version_mismatch(self) -> None:
        approved = binding()
        assert not verify_binding(approved, binding(task_id="task-2")).valid
        other_version = build_binding(
            "task-1",
            2,
            candidate_text="diff-a",
            test_evidence_text="tests-a",
            review_text="review-a",
        )
        decision = verify_binding(approved, other_version)
        assert not decision.valid and "方案版本" in decision.reason


class TestRequirementAcceptance:
    """单个任务通过不自动等于需求整体验收。"""

    def requirement(self, *tasks: TaskDelivery) -> RequirementDelivery:
        requirement = RequirementDelivery("req-forgeloop-1")
        for task in tasks:
            requirement = requirement.with_task(task)
        return requirement

    def test_single_accepted_task_is_not_overall_acceptance(self) -> None:
        requirement = self.requirement(
            TaskDelivery(binding("task-1"), accepted=True),
            TaskDelivery(binding("task-2"), accepted=False),
        )
        decision = assess_requirement_acceptance(requirement)
        assert not decision.allowed
        assert decision.pending_tasks == ("task-2",)
        assert "单个任务通过不自动等于需求整体验收" in decision.reason

    def test_all_tasks_accepted_allows_overall_acceptance(self) -> None:
        requirement = self.requirement(
            TaskDelivery(binding("task-1"), accepted=True),
            TaskDelivery(binding("task-2"), accepted=True),
        )
        assert assess_requirement_acceptance(requirement).allowed

    def test_empty_requirement_is_not_accepted(self) -> None:
        decision = assess_requirement_acceptance(RequirementDelivery("req-forgeloop-1"))
        assert not decision.allowed

    def test_material_change_in_one_task_blocks_overall_acceptance(self) -> None:
        requirement = self.requirement(
            TaskDelivery(binding("task-1"), accepted=True),
            TaskDelivery(binding("task-2"), accepted=True),
        )
        decision = assess_requirement_acceptance(
            requirement,
            current_bindings={"task-1": binding("task-1"), "task-2": binding("task-2", marker="x")},
        )
        assert not decision.allowed
        assert decision.pending_tasks == ("task-2",)
        assert "不能沿用原批准" in decision.reason

    def test_artifacts_required_for_product_acceptance(self) -> None:
        requirement = self.requirement(TaskDelivery(binding("task-1"), accepted=True))
        blocked = assess_requirement_acceptance(requirement, require_artifacts=True)
        assert not blocked.allowed and "候选产物" in blocked.reason
        with_artifact = DeliveryBinding(
            "task-1",
            1,
            binding().candidate_sha256,
            binding().test_evidence_sha256,
            binding().review_sha256,
            artifact_sha256="c" * 64,
        )
        allowed = assess_requirement_acceptance(
            self.requirement(TaskDelivery(with_artifact, accepted=True)), require_artifacts=True
        )
        assert allowed.allowed

    def test_duplicate_task_is_rejected(self) -> None:
        requirement = self.requirement(
            TaskDelivery(binding("task-1"), accepted=True),
            TaskDelivery(binding("task-1"), accepted=True),
        )
        assert not assess_requirement_acceptance(requirement).allowed


class TestDeliveryBindingValidation:
    """绑定字段本身的守卫：缺身份、非正版本与非法校验值都拒绝。"""

    @pytest.mark.parametrize(
        ("index", "label"),
        [(0, "候选 diff"), (1, "正式测试证据"), (2, "独立审查结论")],
    )
    def test_rejects_non_digest_per_material_field(self, index: int, label: str) -> None:
        material = ["a" * 64, "b" * 64, "c" * 64]
        material[index] = "not-a-digest"
        with pytest.raises(ValueError, match=label):
            DeliveryBinding("task-1", 1, *material)

    def test_rejects_non_digest_artifact(self) -> None:
        with pytest.raises(ValueError, match="候选产物"):
            DeliveryBinding(
                "task-1", 1, "a" * 64, "b" * 64, "c" * 64, artifact_sha256="not-a-digest"
            )

    def test_build_binding_defaults_leave_artifact_and_baseline_unset(self) -> None:
        bound = build_binding(
            "task-1", 1, candidate_text="diff", test_evidence_text="tests", review_text="review"
        )
        assert bound.artifact_sha256 == "" and not bound.has_artifact
        assert bound.baseline_commit == ""

    def test_rejects_non_digest_material(self) -> None:
        with pytest.raises(ValueError, match="候选 diff"):
            DeliveryBinding("task-1", 1, "not-a-digest", "b" * 64, "c" * 64)

    def test_rejects_missing_task_identity(self) -> None:
        with pytest.raises(ValueError, match="缺少任务身份"):
            DeliveryBinding("", 1, "a" * 64, "b" * 64, "c" * 64)

    def test_rejects_non_positive_plan_version(self) -> None:
        with pytest.raises(ValueError, match="正的方案版本"):
            DeliveryBinding("task-1", 0, "a" * 64, "b" * 64, "c" * 64)

    def test_all_accepted_requires_at_least_one_delivery(self) -> None:
        assert not RequirementDelivery("req-1").all_accepted
        assert RequirementDelivery(
            "req-1", (TaskDelivery(binding("task-1"), accepted=True),)
        ).all_accepted


class TestRequirementAcceptanceIdentity:
    """需求整体验收的身份与当前材料守卫。"""

    def test_requirement_without_identity_is_rejected(self) -> None:
        decision = assess_requirement_acceptance(
            RequirementDelivery("", (TaskDelivery(binding("task-1"), accepted=True),))
        )
        assert not decision.allowed
        assert "缺少需求身份" in decision.reason

    def test_missing_current_binding_rejects_overall_acceptance(self) -> None:
        requirement = RequirementDelivery(
            "req-1", (TaskDelivery(binding("task-1"), accepted=True),)
        )
        decision = assess_requirement_acceptance(requirement, current_bindings={})
        assert not decision.allowed
        assert decision.pending_tasks == ("task-1",)
        assert "缺少当前材料身份" in decision.reason


class TestDecisionContract:
    """判定结果必须是明确布尔且带可读原因，未满足任务清单不得丢字段。"""

    def requirement(self, *tasks: TaskDelivery) -> RequirementDelivery:
        requirement = RequirementDelivery("req-forgeloop-1")
        for task in tasks:
            requirement = requirement.with_task(task)
        return requirement

    def test_every_denial_branch_uses_false_and_carries_reason(self) -> None:
        cases = (
            assess_requirement_acceptance(RequirementDelivery("")),
            assess_requirement_acceptance(RequirementDelivery("req-forgeloop-1")),
            assess_requirement_acceptance(
                self.requirement(
                    TaskDelivery(binding("task-1"), accepted=True),
                    TaskDelivery(binding("task-1"), accepted=True),
                )
            ),
            assess_requirement_acceptance(
                self.requirement(
                    TaskDelivery(binding("task-1"), accepted=True),
                    TaskDelivery(binding("task-2"), accepted=False),
                )
            ),
            assess_requirement_acceptance(
                self.requirement(TaskDelivery(binding("task-1"), accepted=True)),
                require_artifacts=True,
            ),
            assess_requirement_acceptance(
                self.requirement(TaskDelivery(binding("task-1"), accepted=True)),
                current_bindings={},
            ),
            assess_requirement_acceptance(
                self.requirement(TaskDelivery(binding("task-1"), accepted=True)),
                current_bindings={"task-1": binding("task-1", marker="changed")},
            ),
        )
        for decision in cases:
            assert decision.allowed is False
            assert isinstance(decision.reason, str) and decision.reason

    def test_artifact_denial_lists_each_missing_task(self) -> None:
        decision = assess_requirement_acceptance(
            self.requirement(TaskDelivery(binding("task-1"), accepted=True)),
            require_artifacts=True,
        )
        assert decision.pending_tasks == ("task-1",)

    def test_success_uses_true_and_carries_reason(self) -> None:
        decision = assess_requirement_acceptance(
            self.requirement(TaskDelivery(binding("task-1"), accepted=True))
        )
        assert decision.allowed is True
        assert isinstance(decision.reason, str) and decision.reason

    def test_verify_binding_decisions_are_explicit_booleans_with_reasons(self) -> None:
        approved = binding()
        task_mismatch = verify_binding(approved, binding(task_id="task-2"))
        version_mismatch = verify_binding(
            approved,
            build_binding(
                "task-1",
                2,
                candidate_text="diff-a",
                test_evidence_text="tests-a",
                review_text="review-a",
            ),
        )
        material_mismatch = verify_binding(approved, binding(marker="changed"))
        for decision in (task_mismatch, version_mismatch, material_mismatch):
            assert decision.valid is False
            assert isinstance(decision.reason, str) and decision.reason
        consistent = verify_binding(approved, approved)
        assert consistent.valid is True
        assert isinstance(consistent.reason, str) and consistent.reason


class TestRecordStoreBindingCapture:
    """记录层真实读取任务目录：产物回执、交付基线与验收绑定回查。"""

    def _task_dir(self, tmp_path: Path, task_id: str = "task-1") -> Path:
        task_dir = tmp_path / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "candidate.diff").write_text("diff-body", encoding="utf-8")
        (task_dir / "test-run.jsonl").write_text('{"exit_code": 0}\n', encoding="utf-8")
        (task_dir / "review-report.json").write_text('{"blocking_issues": []}', encoding="utf-8")
        return task_dir

    def _store(self, tmp_path: Path) -> RecordStore:
        return RecordStore(tmp_path / "records.sqlite")

    def test_valid_artifact_receipt_is_bound(self, tmp_path: Path) -> None:
        task_dir = self._task_dir(tmp_path)
        digest = "a" * 64
        (task_dir / "candidate-artifact.json").write_text(
            json.dumps({"sha256": digest}), encoding="utf-8"
        )
        store = self._store(tmp_path)
        try:
            captured = store.capture_delivery_binding("task-1", 1)
        finally:
            store.close()
        assert captured.has_artifact
        assert captured.artifact_sha256 == digest

    @pytest.mark.parametrize("payload", ["not-json", "[1, 2]", "{}", '{"sha256": "bad"}'])
    def test_unusable_artifact_receipt_is_not_bound(self, tmp_path: Path, payload: str) -> None:
        task_dir = self._task_dir(tmp_path)
        (task_dir / "candidate-artifact.json").write_text(payload, encoding="utf-8")
        store = self._store(tmp_path)
        try:
            captured = store.capture_delivery_binding("task-1", 1)
        finally:
            store.close()
        assert not captured.has_artifact

    def test_baseline_commit_read_from_latest_dev_report(self, tmp_path: Path) -> None:
        task_dir = self._task_dir(tmp_path)
        baseline = "b" * 40
        (task_dir / "dev-reports.jsonl").write_text(
            json.dumps({"attempt": 1, "diff_source": "payload", "baseline_commit": ""})
            + "\n"
            + json.dumps({"attempt": 2, "diff_source": "git", "baseline_commit": baseline})
            + "\n",
            encoding="utf-8",
        )
        store = self._store(tmp_path)
        try:
            captured = store.capture_delivery_binding("task-1", 1)
        finally:
            store.close()
        assert captured.baseline_commit == baseline

    @pytest.mark.parametrize("content", ["", "not-json\n", "[1]\n", '{"baseline_commit": 42}\n'])
    def test_unusable_dev_reports_leave_baseline_empty(self, tmp_path: Path, content: str) -> None:
        task_dir = self._task_dir(tmp_path)
        (task_dir / "dev-reports.jsonl").write_text(content, encoding="utf-8")
        store = self._store(tmp_path)
        try:
            captured = store.capture_delivery_binding("task-1", 1)
        finally:
            store.close()
        assert captured.baseline_commit == ""

    def test_acceptance_approval_binds_and_roundtrips_material(self, tmp_path: Path) -> None:
        task_dir = self._task_dir(tmp_path)
        store = self._store(tmp_path)
        try:
            store.create_task("task-1", "p", "input", {}, 60.0)
            store.save_plan(Plan("task-1", 1, "g", "s", "a", ("true",)))
            store.record_approval(Approval("task-1", 1, ApprovalStage.ACCEPTANCE, decided_at(0)))
            bound = store.acceptance_binding("task-1")
            assert bound is not None
            assert bound.candidate_sha256 == sha256_of_text("diff-body")
            pending = store.task_delivery("task-1")
            assert pending is not None and pending.accepted is False
            assert (
                store.consume_approval("task-1", 1, ApprovalStage.ACCEPTANCE, bound).status
                is ConsumeStatus.OK
            )
            assert (
                store.consume_approval("task-1", 1, ApprovalStage.ACCEPTANCE, bound).status
                is ConsumeStatus.ALREADY_USED
            )
            consumed = store.task_delivery("task-1")
            assert consumed is not None and consumed.accepted is True
            # 替换候选后消费（默认重读任务目录）：原批准失效。
            (task_dir / "candidate.diff").write_text("tampered", encoding="utf-8")
            assert (
                store.consume_approval("task-1", 1, ApprovalStage.ACCEPTANCE).status
                is ConsumeStatus.MATERIAL_CHANGED
            )
        finally:
            store.close()

    def test_acceptance_binding_does_not_leak_into_plan_approval(self, tmp_path: Path) -> None:
        self._task_dir(tmp_path)  # 提供可绑定的真实材料
        store = self._store(tmp_path)
        try:
            store.create_task("task-1", "p", "input", {}, 60.0)
            store.save_plan(Plan("task-1", 1, "g", "s", "a", ("true",)))
            store.record_approval(Approval("task-1", 1, ApprovalStage.PLAN, decided_at(0)))
            assert (
                store.consume_approval("task-1", 1, ApprovalStage.PLAN).status is ConsumeStatus.OK
            )
            # 同版本的验收批准写入交付绑定后，方案批准不得带上该绑定。
            store.record_approval(Approval("task-1", 1, ApprovalStage.ACCEPTANCE, decided_at(1)))
            plan_approval = store.effective_approval("task-1", ApprovalStage.PLAN)
            assert plan_approval is not None and plan_approval.binding is None
            assert (
                store.consume_approval("task-1", 1, ApprovalStage.PLAN).status
                is ConsumeStatus.ALREADY_USED
            )
        finally:
            store.close()

    def test_task_delivery_absent_without_acceptance_binding(self, tmp_path: Path) -> None:
        store = self._store(tmp_path)
        try:
            assert store.task_delivery("task-none") is None
        finally:
            store.close()
