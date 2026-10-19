"""系统测试：以真实子进程运行 CLI，验证独立进程与记录回查。

V0-08 语义：CLI 查询由实际记录生成，进程退出后仍可读取。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.system

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI_COMMAND = [sys.executable, str(FIXTURES / "fake_pi.py")]
PASSING_TEST_COMMAND = [sys.executable, "-c", "print('suite passed')"]
PROJECT_ID = "forgeloop"


def project_root(records_root: Path) -> Path:
    return records_root / "projects" / PROJECT_ID


def prepare_project(records_root: Path) -> None:
    """建立真实源仓库并登记项目：CLI 子进程只从已登记项目读取记录。"""

    repo = records_root.parent / f"{records_root.name}-repo"
    if not (repo / ".git").exists():
        repo.mkdir(parents=True, exist_ok=True)
        (repo / "README.md").write_text("baseline\n", encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(repo.parent)}

        def git(*args: str) -> None:
            subprocess.run(
                ["git", "-C", str(repo), *args], check=True, capture_output=True, env=env
            )

        git("init", "-b", "main")
        git("config", "user.name", "t")
        git("config", "user.email", "t@example.com")
        git("add", "-A")
        git("commit", "-m", "chore: baseline")
    added = run_cli_process(
        ["project", "add", PROJECT_ID, "--name", "ForgeLoop", "--path", str(repo)],
        records_root,
    )
    assert added.returncode == 0, added.stderr


def run_cli_process(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["FAKE_PI_MODE"] = "ok"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "src")
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        check=False,
    )


class TestCliProcess:
    def test_submit_and_status_across_processes(self, tmp_path: Path) -> None:
        prepare_project(tmp_path)
        result = run_cli_process(
            [
                "submit",
                "--project",
                "forgeloop",
                "--input",
                "真实子进程提交的任务",
                "--test-command",
                json.dumps(PASSING_TEST_COMMAND),
                "--pi-command",
                json.dumps(FAKE_PI_COMMAND),
            ],
            tmp_path,
        )
        assert result.returncode == 0, result.stderr
        task_id = result.stdout.split("任务已创建: ")[1].splitlines()[0].strip()

        # 新进程查询：记录在进程退出后仍可回查。
        status = run_cli_process(["status", task_id, "--json"], tmp_path)
        assert status.returncode == 0, status.stderr
        document = json.loads(status.stdout)
        assert document["status"] == "awaiting_plan_approval"
        assert document["project"] == "forgeloop"

        missing = run_cli_process(["status", "task-none", "--json"], tmp_path)
        assert missing.returncode == 1
        assert json.loads(missing.stdout) == {"task_id": "task-none", "error": "task_not_found"}

    def test_full_loop_in_real_processes(self, tmp_path: Path) -> None:
        prepare_project(tmp_path)
        result = run_cli_process(
            [
                "submit",
                "--project",
                "forgeloop",
                "--input",
                "端到端闭环任务",
                "--test-command",
                json.dumps(PASSING_TEST_COMMAND),
                "--pi-command",
                json.dumps(FAKE_PI_COMMAND),
            ],
            tmp_path,
        )
        task_id = result.stdout.split("任务已创建: ")[1].splitlines()[0].strip()
        (project_root(tmp_path) / task_id / "workspace").mkdir(parents=True, exist_ok=True)

        approved = run_cli_process(["approve", task_id], tmp_path)
        assert approved.returncode == 0, approved.stderr
        accepted = run_cli_process(["approve", task_id, "--stage", "acceptance"], tmp_path)
        assert accepted.returncode == 0, accepted.stderr

        status = run_cli_process(["status", task_id, "--json"], tmp_path)
        document = json.loads(status.stdout)
        assert document["status"] == "delivered"
        assert Path(document["delivery"]["report_path"]).exists()

        # 会话文件真实落盘（PI 事件/请求/stderr）。
        sessions = project_root(tmp_path) / task_id / "sessions"
        assert (sessions / f"{task_id}-dev.events.jsonl").exists()
        assert (sessions / f"{task_id}-review.events.jsonl").exists()
        assert (sessions / f"{task_id}-dev.stderr.log").exists()
