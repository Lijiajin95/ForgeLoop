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

    def test_plain_text_review_falls_back_to_text(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "plain-text")
        task_id = submit_task(tmp_path, capsys)
        seed_test_control(tmp_path, task_id, fail_first=0)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        document = status_document(tmp_path, task_id, capsys)
        # 文本回退：无结构化载荷时仍完成审查与测试闭环。
        assert document["status"] == "awaiting_acceptance"
        reviews = [
            json.loads(line)
            for line in (tmp_path / task_id / "reviews.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert reviews[0]["blocking_issues"] == []
        assert "自然语言" in reviews[0]["summary"]
