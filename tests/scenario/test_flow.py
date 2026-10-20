"""流程场景测试：批准 → PI 实现 → 独立审查 → 正式测试 → 失败/授权 → 验收交付。

用假 PI 子进程（讲同一 JSONL 契约）与真实测试命令子进程驱动真实业务图、
真实 SQLite 记录与真实 LangGraph 检查点；验证 A01-A04 的行为语义。
守卫与自迭代场景见 test_guards.py / test_self_iteration.py。
"""

import json
from pathlib import Path

from support import (
    FAKE_TEST_COMMAND,
    run_cli,
    seed_test_control,
    status_document,
    submit_task,
    task_dir,
)


class TestHappyLoopWithOneFailure:
    def test_approve_implement_review_test_fix_accept_deliver(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # edit：PI 真实改写 worktree 内文件，候选 diff 才来自工作树对基线的差异。
        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=1)

        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_plan_approval"
        assert document["plan"]["test_command"] == FAKE_TEST_COMMAND
        assert document["approvals"]["plan"] is None

        # 第一次本地批准 → 实现 → 审查 → 测试失败 → 修复 → 测试通过 → 等待验收
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_acceptance"
        assert document["failures"]["cumulative"] == 1
        assert document["failures"]["grants"] == 1
        assert document["failures"]["remaining_in_current_grant"] == 2
        assert document["approvals"]["plan"]["plan_version"] == 1

        # 第二次本地批准（整体验收）→ 交付
        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        assert document["failures"]["cumulative"] == 1  # 累计保留
        assert document["approvals"]["acceptance"]["plan_version"] == 1

        # 交付证据可回查：diff、测试证据、审查记录、交付报告
        delivery = document["delivery"]
        assert delivery is not None
        diff = Path(delivery["diff_path"])
        assert diff.exists() and "+new" in diff.read_text(encoding="utf-8")
        test_runs = task_dir(tmp_path, task_id) / "test-run.jsonl"
        assert test_runs.exists()
        runs = [json.loads(line) for line in test_runs.read_text(encoding="utf-8").splitlines()]
        assert len(runs) == 2
        assert runs[0]["exit_code"] == 1 and runs[1]["exit_code"] == 0
        assert (task_dir(tmp_path, task_id) / "reviews.jsonl").exists()
        report = json.loads(
            (task_dir(tmp_path, task_id) / "delivery-report.json").read_text(encoding="utf-8")
        )
        assert report["task_id"] == task_id
        assert report["dev_attempts"] == 2
        assert report["cumulative_failures"] == 1


class TestGrantLoop:
    def test_three_failures_require_grant_then_deliver(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=3)

        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_grant"
        assert document["failures"]["cumulative"] == 3
        assert document["failures"]["awaiting_grant_decision"] is True

        code, out = run_cli(["grant", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["failures"]["grants"] == 2
        assert document["failures"]["cumulative"] == 3  # 追加不清零
        assert document["status"] == "awaiting_acceptance"  # 第四次测试通过

        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
        )
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        assert document["failures"]["cumulative"] == 3
        assert document["failures"]["grants"] == 2


class TestReviewBlocking:
    def test_blocking_review_returns_to_dev_then_passes(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "blocking-first")
        monkeypatch.setenv("FAKE_PI_STATE", str(tmp_path / "pi-state.json"))
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)

        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_acceptance"

        reviews = [
            json.loads(line)
            for line in (task_dir(tmp_path, task_id) / "reviews.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert len(reviews) == 2
        assert reviews[0]["blocking_issues"]
        assert not reviews[1]["blocking_issues"]

        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        report = json.loads(
            (task_dir(tmp_path, task_id) / "delivery-report.json").read_text(encoding="utf-8")
        )
        assert report["dev_attempts"] == 2


class TestAcceptanceRejection:
    def reject_acceptance(self, tmp_path: Path, task_id: str, capsys) -> None:
        run_cli(
            [
                "approve",
                task_id,
                "--stage",
                "acceptance",
                "--decision",
                "rejected",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )

    def ready_for_acceptance(self, tmp_path: Path, capsys, monkeypatch) -> str:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_acceptance"
        return task_id

    def test_first_rejection_counts_one_round(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id = self.ready_for_acceptance(tmp_path, capsys, monkeypatch)
        # 用户验收发现明确交付失败：按同一正式候选轮次规则计一轮。
        self.reject_acceptance(tmp_path, task_id, capsys)
        document = status_document(tmp_path, task_id, capsys)
        assert document["failures"]["cumulative"] == 1
        assert document["failures"]["remaining_in_current_grant"] == 2
        assert document["status"] == "awaiting_acceptance"  # 修复后再次等待验收
        assert document["approvals"]["acceptance"] is None  # 拒绝不写入批准

    def test_new_candidate_after_fix_counts_new_round(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id = self.ready_for_acceptance(tmp_path, capsys, monkeypatch)
        self.reject_acceptance(tmp_path, task_id, capsys)
        # 修复后是新的候选轮次：第二次拒绝按新一轮计数（每轮只计一次的
        # 去重语义由账本 round_id 幂等保证，见单元与属性测试）。
        self.reject_acceptance(tmp_path, task_id, capsys)
        document = status_document(tmp_path, task_id, capsys)
        assert document["failures"]["cumulative"] == 2
        assert document["failures"]["rounds"][0]["round_id"] == "candidate-1"
        assert document["failures"]["rounds"][1]["round_id"] == "candidate-2"

    def test_accepted_after_rejections_delivers(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id = self.ready_for_acceptance(tmp_path, capsys, monkeypatch)
        self.reject_acceptance(tmp_path, task_id, capsys)
        self.reject_acceptance(tmp_path, task_id, capsys)
        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        assert document["failures"]["cumulative"] == 2
