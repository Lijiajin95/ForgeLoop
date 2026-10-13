"""CLI 组件测试：status --json 输出契约（成功、失败、不存在任务）。"""

import importlib
import json
import sys
from pathlib import Path

import pytest

from forgeloop.cli.main import main as cli_main

pytestmark = pytest.mark.component

# `forgeloop.cli.main` 既指子模块又被同名函数遮蔽；故障替身必须打在模块对象上。
cli_module = importlib.import_module("forgeloop.cli.main")

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]
PASSING_TEST_COMMAND = [sys.executable, "-c", "print('suite passed')"]


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def run_cli_streams(argv: list[str], capsys) -> tuple[int, str, str]:
    """分离 stdout 与 stderr：保持 stdout 契约与 stderr 错误报告是两项独立要求。"""

    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


class _StateReadFailure:
    """故障替身：转发图执行与连接关闭，只在读取检查点状态时失败。"""

    def __init__(self, graph, error: Exception) -> None:
        self._graph = graph
        self._error = error

    def invoke(self, *args, **kwargs):
        return self._graph.invoke(*args, **kwargs)

    def get_state(self, *args, **kwargs):
        raise self._error

    @property
    def checkpointer(self):
        return self._graph.checkpointer


def submit_argv(input_value: str, records: Path) -> list[str]:
    """最小 submit 参数（多个契约用例共用，避免重复同一段列表）。"""

    return [
        "submit",
        "--project",
        "forgeloop",
        "--input",
        input_value,
        "--test-command",
        json.dumps(PASSING_TEST_COMMAND),
        "--pi-command",
        json.dumps(FAKE_PI_COMMAND),
        "--records-root",
        str(records),
    ]


def submit_task(tmp_path: Path, capsys) -> str:
    """提交最小任务并返回任务 ID。"""

    code, out = run_cli(submit_argv("sample task", tmp_path), capsys)
    assert code == 0, out
    return out.split("任务已创建: ")[1].splitlines()[0].strip()


class TestStatusJsonContract:
    def test_document_schema_for_awaiting_task(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)

        code, out = run_cli(["status", task_id, "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert set(document) == {
            "task_id",
            "project",
            "status",
            "next_action",
            "created_at",
            "plan",
            "approvals",
            "failures",
            "budget",
            "stop",
            "delivery",
            "merge",
            "release",
        }
        assert document["merge"] is None
        assert document["release"] is None
        assert document["status"] == "awaiting_plan_approval"
        assert document["next_action"].keys() == {"action", "actor", "reason"}
        assert document["next_action"]["actor"] == "user"
        assert document["next_action"]["action"]
        assert "批准" in document["next_action"]["reason"]
        assert document["project"] == "forgeloop"
        assert document["plan"]["test_command"] == PASSING_TEST_COMMAND
        assert document["approvals"] == {"plan": None, "acceptance": None}
        assert document["failures"]["cumulative"] == 0
        assert document["failures"]["grants"] == 1
        assert document["failures"]["remaining_in_current_grant"] == 3
        assert document["failures"]["awaiting_grant_decision"] is False
        assert document["failures"]["rounds"] == []
        assert document["budget"]["limit_seconds"] == 7200.0
        assert document["budget"]["exhausted"] is False
        assert document["stop"] is None
        assert document["delivery"] is None

    def test_document_for_delivered_task(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        (tmp_path / task_id / "workspace").mkdir(parents=True, exist_ok=True)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
        )

        code, out = run_cli(["status", task_id, "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["status"] == "delivered"
        assert document["next_action"]["actor"] == "user"
        assert "接回" in document["next_action"]["action"]
        assert document["approvals"]["plan"] is not None
        assert document["approvals"]["acceptance"] is not None
        assert document["delivery"] is not None
        assert Path(document["delivery"]["report_path"]).exists()
        assert Path(document["delivery"]["diff_path"]).exists()

    def test_text_status_for_existing_task(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)

        code, out = run_cli(["status", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert f"任务: {task_id}" in out
        assert "状态: awaiting_plan_approval" in out
        assert "失败轮次: 累计 0" in out
        assert "工时:" in out

    def test_unknown_status_falls_to_manual_review(self, tmp_path: Path, capsys) -> None:
        """未知状态不猜测：输出人工核对动作，主体为 user，原因带原始状态值。"""

        from forgeloop.records.store import RecordStore

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task("task-mystery", "p", "input", {}, limit_seconds=60.0)
            store.set_task_status("task-mystery", "mystery_state")
        finally:
            store.close()
        code, out = run_cli(
            ["status", "task-mystery", "--json", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0
        document = json.loads(out)
        assert document["status"] == "mystery_state"
        assert document["next_action"]["actor"] == "user"
        assert "人工核对" in document["next_action"]["action"]
        assert "mystery_state" in document["next_action"]["reason"]

    def test_submit_reads_input_from_file(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        input_file = tmp_path / "requirement.txt"
        input_file.write_text("来自文件的需求正文", encoding="utf-8")
        records = tmp_path / "rec"
        code, out = run_cli(submit_argv(f"@{input_file}", records), capsys)
        assert code == 0, out
        task_id = out.split("任务已创建: ")[1].splitlines()[0].strip()
        code, out = run_cli(["status", task_id, "--json", "--records-root", str(records)], capsys)
        assert json.loads(out)["plan"]["goal"] == "来自文件的需求正文"

    def test_submit_missing_input_file_fails(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        with pytest.raises(SystemExit, match="输入文件不存在"):
            cli_main(submit_argv("@/nonexistent/file.txt", tmp_path))

    def test_missing_task_outputs_error_contract_and_exit_code(
        self, tmp_path: Path, capsys
    ) -> None:
        code, out = run_cli(
            ["status", "task-does-not-exist", "--json", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        document = json.loads(out)
        assert document == {"task_id": "task-does-not-exist", "error": "task_not_found"}

    def test_text_status_for_missing_task_fails_with_stderr(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            ["status", "task-does-not-exist", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "任务不存在" in out

    def test_approve_missing_task_fails(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit, match="任务不存在"):
            cli_main(["approve", "task-none", "--records-root", str(tmp_path)])

    def test_grant_missing_task_fails(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit, match="任务不存在"):
            cli_main(["grant", "task-none", "--records-root", str(tmp_path)])

    def test_stop_missing_task_fails(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit, match="任务不存在"):
            cli_main(["stop", "task-none", "--records-root", str(tmp_path)])

    def test_text_status_shows_stop_and_delivery(self, tmp_path: Path, capsys, monkeypatch) -> None:
        from forgeloop.records.store import RecordStore

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        code, out = run_cli(
            [
                "submit",
                "--project",
                "forgeloop",
                "--input",
                "sample task",
                "--test-command",
                json.dumps(PASSING_TEST_COMMAND),
                "--pi-command",
                json.dumps(FAKE_PI_COMMAND),
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        task_id = out.split("任务已创建: ")[1].splitlines()[0].strip()
        (tmp_path / task_id / "workspace").mkdir(parents=True, exist_ok=True)
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
        )
        code, out = run_cli(["status", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "交付:" in out
        assert "停止请求" not in out

        # 停止请求的任务在文本输出中展示停止记录。
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.outcomes.request_stop(task_id, "验收后归档前暂停")
        finally:
            store.close()
        code, out = run_cli(["status", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "停止请求:" in out
        assert "备注: 验收后归档前暂停" in out

    def test_approve_task_without_plan_fails(self, tmp_path: Path, capsys) -> None:
        from forgeloop.records.store import RecordStore

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task("task-noplan", "p", "input", {}, limit_seconds=60.0)
        finally:
            store.close()
        with pytest.raises(SystemExit, match="任务尚无方案"):
            cli_main(["approve", "task-noplan", "--records-root", str(tmp_path)])

    def test_text_status_without_plan_uses_defaults(self, tmp_path: Path, capsys) -> None:
        from forgeloop.records.store import RecordStore

        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task("task-noplan2", "p", "input", {}, limit_seconds=60.0)
        finally:
            store.close()
        code, out = run_cli(["status", "task-noplan2", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "任务: task-noplan2" in out
        assert "方案版本" not in out

    def test_submit_rejects_negative_pi_timeout(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit, match="不能为负"):
            cli_main(
                [
                    "submit",
                    "--project",
                    "P",
                    "--input",
                    "x",
                    "--test-command",
                    '["true"]',
                    "--pi-command",
                    '["unused"]',
                    "--pi-timeout-seconds",
                    "-1",
                    "--records-root",
                    str(tmp_path),
                ]
            )

    def test_submit_rejects_non_git_project_path(self, tmp_path: Path, capsys) -> None:
        plain = tmp_path / "not-a-repo"
        plain.mkdir()
        with pytest.raises(SystemExit, match="不是 git 仓库"):
            cli_main(
                [
                    "submit",
                    "--project",
                    "forgeloop",
                    "--input",
                    "x",
                    "--test-command",
                    json.dumps(PASSING_TEST_COMMAND),
                    "--pi-command",
                    json.dumps(FAKE_PI_COMMAND),
                    "--project-path",
                    str(plain),
                    "--records-root",
                    str(tmp_path),
                ]
            )

    def test_approve_reports_pending_decision_on_stdout(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        """正常路径回归：批准后 stdout 报出状态与待决定节点，stderr 为空。"""

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)

        code, out, err = run_cli_streams(
            ["approve", task_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0
        assert "状态:" in out
        assert "等待" in out
        assert err == ""

    def test_state_read_failure_is_reported_on_stderr(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        """读取检查点失败必须可见：stdout 保持契约，stderr 给出可公开的错误信息。"""

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        task_id = submit_task(tmp_path, capsys)
        real_build_graph = cli_module.build_graph

        def build_with_failing_state(context, checkpoints_path):
            graph = real_build_graph(context, checkpoints_path)
            return _StateReadFailure(graph, RuntimeError("checkpoint database is locked"))

        monkeypatch.setattr(cli_module, "build_graph", build_with_failing_state)

        code, out, err = run_cli_streams(
            ["approve", task_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0  # 批准已记录，读取失败不改变已完成的决定
        assert "状态:" in out  # stdout 输出契约保持
        assert "RuntimeError" in err
        assert "checkpoint database is locked" in err

    def test_submit_rejects_non_array_test_command(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit):
            cli_main(
                [
                    "submit",
                    "--project",
                    "forgeloop",
                    "--input",
                    "x",
                    "--test-command",
                    "not-json",
                    "--pi-command",
                    json.dumps(FAKE_PI_COMMAND),
                    "--records-root",
                    str(tmp_path),
                ]
            )
