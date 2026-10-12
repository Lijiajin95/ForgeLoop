"""场景测试共享助手：CLI 驱动、任务提交与状态查询。"""

import json
import re
import sys
from pathlib import Path

from forgeloop.cli.main import main as cli_main

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
