"""B04 场景：用户验收绑定实际候选、测试证据与需求整体结果。

用真实 CLI、真实业务图、真实 SQLite 记录与真实任务目录文件驱动：
- 验收批准在记录时绑定当前候选 diff、测试证据、审查结论与产物校验值；
- 批准后替换 diff/测试/产物，恢复验收时原批准失效（材料变化），不写出交付；
- 已交付任务的验收绑定可回查，替换材料后可检测出漂移；
- 单个任务通过不自动等于需求整体验收；缺产物身份时不整体验收。
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from langgraph.types import Command
from support import (
    run_cli,
    run_git,
    seed_test_control,
    status_document,
    submit_task,
)

from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.delivery import (
    RequirementDelivery,
    TaskDelivery,
    assess_requirement_acceptance,
    build_binding,
    sha256_of_text,
    verify_binding,
)
from forgeloop.graph.nodes import NodeContext, make_deliver_node
from forgeloop.records.store import RecordStore


def reach_awaiting_acceptance(tmp_path: Path, capsys, monkeypatch) -> str:
    """真实跑到等待验收：提交、批准方案、开发、审查、测试通过。"""

    monkeypatch.setenv("FAKE_PI_MODE", "ok")
    task_id = submit_task(tmp_path, capsys)
    seed_test_control(tmp_path, task_id, fail_first=0)
    code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
    assert code == 0, out
    document = status_document(tmp_path, task_id, capsys)
    assert document["status"] == "awaiting_acceptance"
    return task_id


class TestAcceptanceBindsMaterial:
    def test_delivery_report_records_bound_material(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = reach_awaiting_acceptance(tmp_path, capsys, monkeypatch)

        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        assert status_document(tmp_path, task_id, capsys)["status"] == "delivered"

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            accepted = store.acceptance_binding(task_id)
            assert accepted is not None
            # 批准绑定的是任务目录里真实候选与测试证据的内容校验值。
            candidate = (tmp_path / task_id / "candidate.diff").read_text(encoding="utf-8")
            evidence = (tmp_path / task_id / "test-run.jsonl").read_text(encoding="utf-8")
            assert accepted.candidate_sha256 == sha256_of_text(candidate)
            assert accepted.test_evidence_sha256 == sha256_of_text(evidence)
            report = json.loads(
                (tmp_path / task_id / "delivery-report.json").read_text(encoding="utf-8")
            )
            assert report["binding"]["candidate_sha256"] == accepted.candidate_sha256
            assert report["binding"]["test_evidence_sha256"] == accepted.test_evidence_sha256
            assert report["binding"]["fingerprint"] == accepted.fingerprint
        finally:
            store.close()

    def test_replaced_candidate_between_approval_and_consume_blocks_delivery(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = reach_awaiting_acceptance(tmp_path, capsys, monkeypatch)

        # 记录验收批准（自动绑定当前材料），随后替换候选 diff：模拟批准后材料被换掉。
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            plan = store.latest_plan(task_id)
            assert plan is not None
            store.record_approval(
                Approval(task_id, plan.version, ApprovalStage.ACCEPTANCE, datetime.now(UTC))
            )
            pending = store.task_delivery(task_id)
            assert pending is not None and pending.accepted is False  # 批准未消费不算已验收
        finally:
            store.close()
        candidate = tmp_path / task_id / "candidate.diff"
        candidate.write_text(
            candidate.read_text(encoding="utf-8") + "\n+tampered", encoding="utf-8"
        )

        store, _ctx, graph = _build_runtime(tmp_path, task_id)
        try:
            graph.invoke(Command(resume={"decision": "accepted"}), _run_config(task_id))
        finally:
            _close_runtime(graph)
            store.close()

        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "blocked"  # 材料变化，原批准不能沿用
        assert not (tmp_path / task_id / "delivery-report.json").exists()

    def test_delivered_binding_detects_later_material_drift(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = reach_awaiting_acceptance(tmp_path, capsys, monkeypatch)
        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            accepted = store.acceptance_binding(task_id)
            assert accepted is not None
            assert verify_binding(
                accepted, store.capture_delivery_binding(task_id, accepted.plan_version)
            ).valid
            # 替换正式测试证据：同一验收决定不再覆盖新材料。
            (tmp_path / task_id / "test-run.jsonl").write_text("tampered", encoding="utf-8")
            drifted = store.capture_delivery_binding(task_id, accepted.plan_version)
            decision = verify_binding(accepted, drifted)
            assert not decision.valid
            assert "test_evidence_sha256" in decision.changed
        finally:
            store.close()


class TestRequirementOverallAcceptance:
    def test_one_task_accepted_is_not_overall_acceptance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = reach_awaiting_acceptance(tmp_path, capsys, monkeypatch)
        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            accepted = store.task_delivery(task_id)
            assert accepted is not None and accepted.accepted is True
            requirement = (
                RequirementDelivery("req-forgeloop-1")
                .with_task(accepted)
                .with_task(
                    TaskDelivery(
                        build_binding(
                            "task-2",
                            accepted.binding.plan_version,
                            candidate_text="other candidate",
                            test_evidence_text="other evidence",
                            review_text="other review",
                        ),
                        accepted=False,
                    )
                )
            )
            decision = assess_requirement_acceptance(requirement)
            assert not decision.allowed
            assert decision.pending_tasks == ("task-2",)
        finally:
            store.close()

    def test_artifact_identity_required_for_product_acceptance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = reach_awaiting_acceptance(tmp_path, capsys, monkeypatch)
        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            accepted = store.acceptance_binding(task_id)
            assert accepted is not None
            assert not accepted.has_artifact  # 验收发生在 C01 构建产物之前
            requirement = RequirementDelivery("req-forgeloop-1").with_task(
                TaskDelivery(accepted, accepted=True)
            )
            assert not assess_requirement_acceptance(requirement, require_artifacts=True).allowed

            with_artifact = build_binding(
                accepted.task_id,
                accepted.plan_version,
                candidate_text=(tmp_path / task_id / "candidate.diff").read_text(encoding="utf-8"),
                test_evidence_text=(tmp_path / task_id / "test-run.jsonl").read_text(
                    encoding="utf-8"
                ),
                review_text=(tmp_path / task_id / "review-report.json").read_text(encoding="utf-8"),
                artifact_sha256="c" * 64,
            )
            bound = RequirementDelivery("req-forgeloop-1").with_task(
                TaskDelivery(with_artifact, accepted=True)
            )
            assert assess_requirement_acceptance(bound, require_artifacts=True).allowed
        finally:
            store.close()


class TestDeliverRechecksMaterial:
    """验收后到落交付前的二次核对：候选被替换则不写交付记录。"""

    def test_deliver_node_blocks_when_material_changes_after_acceptance(
        self, tmp_path: Path
    ) -> None:
        task_id = "task-recheck"
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task(task_id, "forgeloop", "input", {}, 600.0)
            store.save_plan(Plan(task_id, 1, "goal", "scope", "accept", ("true",)))
            task_dir = tmp_path / task_id
            task_dir.mkdir(parents=True)
            (task_dir / "candidate.diff").write_text("original", encoding="utf-8")
            (task_dir / "test-run.jsonl").write_text('{"exit_code": 0}\n', encoding="utf-8")
            (task_dir / "review-report.json").write_text(
                '{"blocking_issues": []}', encoding="utf-8"
            )
            # 验收批准绑定原始候选；落交付前候选被替换，二次核对必须拦下。
            store.record_approval(Approval(task_id, 1, ApprovalStage.ACCEPTANCE, datetime.now(UTC)))
            (task_dir / "candidate.diff").write_text("tampered", encoding="utf-8")
            ctx = NodeContext.for_task(store, tmp_path, task_id)
            update = make_deliver_node(ctx)({"task_id": task_id})
            task = store.get_task(task_id)
            assert task is not None and task.status == "blocked"
        finally:
            store.close()
        assert update == {"halted_reason": "delivery_material_changed"}
        assert not (tmp_path / task_id / "delivery-report.json").exists()


class TestGitBackedAcceptanceBinding:
    """真实 git 副本：验收绑定实际交付基线提交号，并写入交付报告。"""

    def test_baseline_is_bound_and_reported(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = tmp_path / "source"
        source.mkdir()
        (source / "feature.txt").write_text("old\n", encoding="utf-8")
        run_git(source, "init", "-b", "main")
        run_git(source, "add", "-A")
        run_git(source, "commit", "-m", "chore: baseline")
        baseline = run_git(source, "rev-parse", "HEAD")
        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "baseline": baseline,
                "test-command": json.dumps([sys.executable, "-c", "pass"]),
            },
        )
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        assert status_document(tmp_path, task_id, capsys)["status"] == "awaiting_acceptance"
        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        assert status_document(tmp_path, task_id, capsys)["status"] == "delivered"
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            accepted = store.acceptance_binding(task_id)
            assert accepted is not None
            assert accepted.baseline_commit == baseline
        finally:
            store.close()
        dev_reports = [
            json.loads(line)
            for line in (tmp_path / task_id / "dev-reports.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert dev_reports[-1]["baseline_commit"] == baseline
        report = json.loads(
            (tmp_path / task_id / "delivery-report.json").read_text(encoding="utf-8")
        )
        assert report["binding"]["baseline_commit"] == baseline
