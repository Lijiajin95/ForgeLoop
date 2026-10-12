"""流程场景测试：批准 → PI 实现 → 独立审查 → 正式测试 → 失败/授权 → 验收交付。

用假 PI 子进程（讲同一 JSONL 契约）与真实测试命令子进程驱动真实业务图、
真实 SQLite 记录与真实 LangGraph 检查点；验证 A01-A04 的行为语义。
"""

import json
import re
import sys
from pathlib import Path

import pytest

from forgeloop.cli.main import main as cli_main

pytestmark = pytest.mark.scenario

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]
FAKE_TEST_COMMAND = [sys.executable, str(FIXTURES / "fake_test.py"), "test-control.json"]

TASK_CREATED = re.compile(r"任务已创建: (\S+)")


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def submit_task(tmp_path: Path, capsys, **overrides) -> str:
    argv = [
        "submit",
        "--project",
        "forgeloop",
        "--input",
        "为 CLI 增加 status --json 输出",
        "--test-command",
        json.dumps(FAKE_TEST_COMMAND),
        "--pi-command",
        json.dumps(FAKE_PI_COMMAND),
        "--goal",
        "status --json 契约",
        "--scope",
        "仅 CLI 查询输出",
        "--acceptance",
        "输出稳定 JSON 契约",
        "--records-root",
        str(tmp_path),
    ]
    for flag, value in overrides.items():
        argv.extend([f"--{flag}", str(value)])
    code, out = run_cli(argv, capsys)
    assert code == 0, out
    match = TASK_CREATED.search(out)
    assert match, out
    return match.group(1)


def seed_test_control(tmp_path: Path, task_id: str, fail_first: int) -> None:
    workspace = tmp_path / task_id / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "test-control.json").write_text(
        json.dumps({"fail_first": fail_first, "runs": 0}), encoding="utf-8"
    )


def status_document(tmp_path: Path, task_id: str, capsys) -> dict:
    code, out = run_cli(["status", task_id, "--json", "--records-root", str(tmp_path)], capsys)
    assert code == 0, out
    return json.loads(out)


class TestHappyLoopWithOneFailure:
    def test_approve_implement_review_test_fix_accept_deliver(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
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
        test_runs = tmp_path / task_id / "test-run.jsonl"
        assert test_runs.exists()
        runs = [json.loads(line) for line in test_runs.read_text(encoding="utf-8").splitlines()]
        assert len(runs) == 2
        assert runs[0]["exit_code"] == 1 and runs[1]["exit_code"] == 0
        assert (tmp_path / task_id / "reviews.jsonl").exists()
        report = json.loads(
            (tmp_path / task_id / "delivery-report.json").read_text(encoding="utf-8")
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
            for line in (tmp_path / task_id / "reviews.jsonl")
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
            (tmp_path / task_id / "delivery-report.json").read_text(encoding="utf-8")
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


class TestGraphGuards:
    def test_resume_without_approval_record_is_blocked(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        from langgraph.types import Command

        from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        store, _ctx, graph = _build_runtime(tmp_path, task_id)
        try:
            graph.invoke(Command(resume={"decision": "approved"}), _run_config(task_id))
        finally:
            _close_runtime(graph)
            store.close()
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "blocked"  # 未批准不开始改代码
        assert document["approvals"]["plan"] is None
        assert not (tmp_path / task_id / "candidate.diff").exists()

    def test_grant_denial_stops_the_task(self, tmp_path: Path, capsys, monkeypatch) -> None:
        from langgraph.types import Command

        from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=3)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_grant"
        store, _ctx, graph = _build_runtime(tmp_path, task_id)
        try:
            graph.invoke(Command(resume={"decision": "stop"}), _run_config(task_id))
        finally:
            _close_runtime(graph)
            store.close()
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "stopped"
        assert document["failures"]["cumulative"] == 3


class TestStopAndRejection:
    def test_rejected_plan_stops_without_execution(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        code, out = run_cli(
            ["approve", task_id, "--decision", "rejected", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "rejected"
        assert document["approvals"]["plan"] is None  # 拒绝不写入批准
        assert not (tmp_path / task_id / "candidate.diff").exists()  # 未批准不改候选代码

    def test_stop_request_halts_before_new_action(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        code, out = run_cli(
            ["stop", task_id, "--note", "测试停止", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "stop_requested"
        assert document["stop"]["note"] == "测试停止"
        assert not (tmp_path / task_id / "candidate.diff").exists()  # 未启动新动作

    def test_tiny_time_limit_exhausts_before_dev(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys, **{"limit-seconds": 0.001})
        seed_test_control(tmp_path, task_id, fail_first=0)
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "time_exhausted"
        assert document["budget"]["exhausted"] is True

    def test_unsettled_pi_marks_interrupted_not_failed(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "unsettled")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "interrupted"
        # 未明确结果不消耗失败轮次（不伪装为测试失败）
        assert document["failures"]["cumulative"] == 0
