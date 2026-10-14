"""守卫场景：图级批准绑定、停止/拒绝/模型错误与不明确结果的如实标记。"""

import json
from pathlib import Path

from support import (
    run_cli,
    seed_test_control,
    status_document,
    submit_task,
)


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


class TestActionReplayGuard:
    """开发中杀进程后再次批准不得重放未核对动作。"""

    def test_reapproval_after_dev_crash_does_not_replay(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        from forgeloop.records.store import RecordStore

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        prompt_log = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(prompt_log))
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        # 模拟上一次进程在 dev 动作中途被杀：只留下 started 记录，未登记完成。
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.actions.begin(task_id, "dev")
        finally:
            store.close()
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "interrupted"  # 未核对动作不盲目重放
        assert not (tmp_path / task_id / "candidate.diff").exists()
        assert not prompt_log.exists()  # 没有启动新的 PI 会话

    def test_reapproval_after_consumed_approval_surfaces_unchecked_action(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        from datetime import UTC, datetime

        from forgeloop.domain.approval import Approval, ApprovalStage
        from forgeloop.records.store import RecordStore

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        prompt_log = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(prompt_log))
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            plan = store.latest_plan(task_id)
            assert plan is not None
            # 模拟批准已被门消费、dev 动作中途被杀的真实进程中断现场。
            store.record_approval(
                Approval(task_id, plan.version, ApprovalStage.PLAN, datetime.now(UTC))
            )
            store.consume_approval(task_id, plan.version, ApprovalStage.PLAN)
            store.actions.begin(task_id, "dev")
        finally:
            store.close()
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "interrupted"  # 未被"批准已用"掩盖成 blocked
        assert not (tmp_path / task_id / "candidate.diff").exists()
        assert not prompt_log.exists()


class TestStopFacts:
    """停止最终状态必须能由持久化事实解释。"""

    def test_grant_denial_records_a_confirmed_stop(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        from langgraph.types import Command

        from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=3)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        store, _ctx, graph = _build_runtime(tmp_path, task_id)
        try:
            graph.invoke(Command(resume={"decision": "stop"}), _run_config(task_id))
        finally:
            _close_runtime(graph)
            store.close()
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "stopped"
        assert document["stop"] is not None  # 停止状态有记录依据，不是凭空置位
        assert document["stop"]["confirmed_at"] is not None

    def test_confirmed_stop_with_unchecked_action_stays_interrupted(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        from forgeloop.records.store import RecordStore

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.outcomes.request_stop(task_id, "已核对停止")
            store.outcomes.confirm_stop(task_id, "已核对")
            store.actions.begin(task_id, "dev")  # 停止确认后仍有未核对动作
        finally:
            store.close()
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "interrupted"  # 不被干净的 stopped 掩盖
        assert document["stop"] is not None  # 停止事实仍保留


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


class TestPiOutcomeHalts:
    def test_model_error_marks_interrupted_not_success(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "model-error")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "interrupted"  # 模型错误不伪装完成
        assert document["failures"]["cumulative"] == 0  # 不消耗失败轮次
        assert (
            not (tmp_path / task_id / "candidate.diff").exists()
            or (tmp_path / task_id / "candidate.diff").read_text(encoding="utf-8") == ""
        )

    def test_confirmed_stop_halts_as_stopped(self, tmp_path: Path, capsys, monkeypatch) -> None:
        from forgeloop.records.store import RecordStore

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.outcomes.request_stop(task_id, "已核对停止")
            store.outcomes.confirm_stop(task_id, "已核对")
        finally:
            store.close()
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "stopped"  # 确认停止后不再启动新动作

    def test_plain_text_review_is_not_released(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "plain-text")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        document = status_document(tmp_path, task_id, capsys)
        # 无结构化载荷时不得判为"无阻断"：中断交人工决定，不进入测试与验收。
        assert document["status"] == "interrupted"
        assert document.get("delivery") is None
        reviews = [
            json.loads(line)
            for line in (tmp_path / task_id / "reviews.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert reviews[0]["blocking_issues"] == []
        assert reviews[0]["blocking_issues_valid"] is False
        assert "自然语言" in reviews[0]["summary"]  # 原始文本保留供人工核对
