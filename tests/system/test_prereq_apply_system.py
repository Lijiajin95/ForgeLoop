"""系统测试：真实 CLI 子进程下，前置任务代码进入下游任务副本。

以全新的 ``python -m forgeloop`` 进程逐步驱动需求线（提交→分析→规划→批准→推进
→验收→再推进），每一步的记录与工作副本都落在本地现场。任务评审实现用组合式假 PI
（讲真实 PI JSONL RPC 协议），但工作副本、候选 diff 与前置应用都是真实 git 边界：

- 上游 ``alpha`` 的实现 PI 在真实工作副本里写 ``alpha.txt``，候选 diff 由真实基线采集；
- 下游 ``beta`` 的 dev 节点在克隆副本后、进入实现前，把 alpha 的候选 diff 真实应用到
  副本，再跑自己的实现 PI 写 ``beta.txt``；
- 断言读取 ``beta`` 副本内实际文件内容与 ``prerequisite-applications.json``，证明前置
  代码确实进入了下游实现现场，而不是只在提示词里。

与场景/集成测试的区别：这里从 CLI 入口跨越多个独立进程验证，不依赖进程内内存。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.system

SRC = Path(__file__).resolve().parents[2] / "src"
GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}

# 组合式假 PI：按 prompt 的 role 返回分析/规划/实现/审查结构化结果；dev 角色额外
# 在真实工作副本（进程 cwd）里落地代码文件，供候选 diff 与前置应用真实采集。
PI = r"""
import json
import os
import sys


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(request, success=True, data=None):
    record = {
        "id": request.get("id"),
        "type": "response",
        "command": request.get("type"),
        "success": success,
    }
    if data is not None:
        record["data"] = data
    emit(record)


def role_of(message):
    try:
        parsed = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return "dev"
    return str(parsed.get("role", "dev")) if isinstance(parsed, dict) else "dev"


def dev_payload(message):
    try:
        parsed = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def write_dev_file(message):
    payload = dev_payload(message)
    goal = str(payload.get("goal", ""))
    if "alpha" in goal:
        name, body = "alpha.txt", "alpha-from-pi\n"
    elif "beta" in goal:
        name, body = "beta.txt", "beta-from-pi\n"
    else:
        return
    with open(os.path.join(os.getcwd(), name), "w", encoding="utf-8") as handle:
        handle.write(body)


def result_for(role):
    fallback = {
        "analysis": '{"goal": "占位", "scenarios": [], "acceptance_criteria": [], "clarifications": []}',
        "planning": '{"tasks": []}',
        "dev": '{"summary": "implemented", "diff": ""}',
        "review": '{"summary": "review passed", "blocking_issues": []}',
    }
    env_name = {
        "analysis": "FAKE_ANALYSIS_RESULT",
        "planning": "FAKE_PLAN_RESULT",
        "dev": "FAKE_DEV_RESULT",
        "review": "FAKE_REVIEW_RESULT",
    }.get(role, "FAKE_DEV_RESULT")
    return os.environ.get(env_name, fallback.get(role, fallback["dev"]))


text = ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "prompt":
        message = request.get("message", "")
        role = role_of(message)
        if role == "dev":
            write_dev_file(message)
        text = result_for(role)
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": f"unknown command: {kind}"})
"""

READY_ANALYSIS = {
    "goal": "前置任务代码进入下游副本",
    "scenarios": ["下游任务实现现场包含上游代码"],
    "acceptance_criteria": ["beta 副本内能读到 alpha.txt"],
    "clarifications": [],
}
PLAN = {
    "tasks": [
        {
            "task_id": "alpha",
            "goal": "实现 alpha 任务",
            "files": ["src/forgeloop/domain/alpha.py"],
            "acceptance": "alpha 落地",
            "test_command": ["python3", "-c", "print('passed')"],
            "depends_on": [],
        },
        {
            "task_id": "beta",
            "goal": "实现 beta 任务",
            "files": ["src/forgeloop/domain/beta.py"],
            "acceptance": "beta 基于 alpha",
            "test_command": ["python3", "-c", "print('passed')"],
            "depends_on": ["alpha"],
        },
    ]
}
DEV = {"summary": "implemented", "diff": ""}
REVIEW = {"summary": "review passed", "blocking_issues": []}


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**GIT_ENV, "HOME": str(path.parent)},
    )
    return result.stdout


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def run_requirement(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        check=False,
    )


def requirement_json(argv: list[str], records_root: Path) -> dict:
    result = run_requirement(argv, records_root)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def configure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    script = tmp_path / "combined_pi.py"
    script.write_text(PI, encoding="utf-8")
    monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps(READY_ANALYSIS, ensure_ascii=False))
    monkeypatch.setenv("FAKE_PLAN_RESULT", json.dumps(PLAN, ensure_ascii=False))
    monkeypatch.setenv("FAKE_DEV_RESULT", json.dumps(DEV, ensure_ascii=False))
    monkeypatch.setenv("FAKE_REVIEW_RESULT", json.dumps(REVIEW, ensure_ascii=False))
    return json.dumps([sys.executable, str(script)])


def single_task_id(document: dict, task_id: str) -> str:
    for entry in document["tasks"]:
        if entry["task_id"] == task_id:
            return entry["single_task_id"]
    raise AssertionError(f"no task {task_id} in {document['tasks']}")


class TestPrerequisiteCodeAcrossProcesses:
    def test_downstream_copy_contains_upstream_code_and_record(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pi_command = configure(monkeypatch, tmp_path)
        source = make_source_repo(tmp_path)

        submitted = run_requirement(
            ["requirement", "submit", "--project", "forgeloop", "--input", "前置进入下游"],
            tmp_path,
        )
        assert submitted.returncode == 0, submitted.stderr
        req_id = submitted.stdout.split("需求已创建: ")[1].splitlines()[0].strip()

        for command in (
            ["requirement", "analyze", req_id, "--pi-command", pi_command],
            ["requirement", "plan", req_id, "--pi-command", pi_command],
        ):
            step = run_requirement(command, tmp_path)
            assert step.returncode == 0, step.stderr
        approved = run_requirement(["requirement", "approve", req_id, "--by", "owner"], tmp_path)
        assert approved.returncode == 0, approved.stderr

        # 第一次推进：alpha 实现落地并停在等待验收。
        advanced = run_requirement(
            [
                "requirement",
                "advance",
                req_id,
                "--pi-command",
                pi_command,
                "--project-path",
                str(source),
            ],
            tmp_path,
        )
        assert advanced.returncode == 0, advanced.stderr
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        alpha_id = single_task_id(document, "alpha")
        assert (tmp_path / alpha_id / "workspace" / "alpha.txt").read_text(
            encoding="utf-8"
        ) == "alpha-from-pi\n"
        # 基线源仓库没有该文件：后续下游副本里的出现只可能来自前置应用。
        assert not (source / "alpha.txt").exists()

        # 另一个新进程记录验收并就地恢复单任务图；再由新进程推进到 beta。
        accepted = run_requirement(["approve", alpha_id, "--stage", "acceptance"], tmp_path)
        assert accepted.returncode == 0, accepted.stderr
        second = run_requirement(
            [
                "requirement",
                "advance",
                req_id,
                "--pi-command",
                pi_command,
                "--project-path",
                str(source),
            ],
            tmp_path,
        )
        assert second.returncode == 0, second.stderr
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        beta_id = single_task_id(document, "beta")

        beta_workspace = tmp_path / beta_id / "workspace"
        # 真实读取下游副本文件：上游代码作为代码输入进入 beta 实现现场。
        assert (beta_workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-from-pi\n"
        assert (beta_workspace / "beta.txt").read_text(encoding="utf-8") == "beta-from-pi\n"

        record = json.loads(
            (tmp_path / beta_id / "prerequisite-applications.json").read_text(encoding="utf-8")
        )
        assert record["blocked_reason"] == ""
        assert record["applications"][0]["task_id"] == "alpha"
        assert record["applications"][0]["status"] == "applied"

        # 下游候选 diff 相对基线采集，已带上由前置带入的改动。
        candidate_diff = (tmp_path / beta_id / "candidate.diff").read_text(encoding="utf-8")
        assert "alpha.txt" in candidate_diff
        assert "+alpha-from-pi" in candidate_diff

    def test_upstream_file_absent_from_baseline_and_own_workdir(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """反向断言：alpha 的工作副本与源仓库都不含 beta 文件。"""

        pi_command = configure(monkeypatch, tmp_path)
        source = make_source_repo(tmp_path)
        submitted = run_requirement(
            ["requirement", "submit", "--project", "forgeloop", "--input", "隔离检查"],
            tmp_path,
        )
        req_id = submitted.stdout.split("需求已创建: ")[1].splitlines()[0].strip()
        for command in (
            ["requirement", "analyze", req_id, "--pi-command", pi_command],
            ["requirement", "plan", req_id, "--pi-command", pi_command],
        ):
            run_requirement(command, tmp_path)
        run_requirement(["requirement", "approve", req_id, "--by", "owner"], tmp_path)
        run_requirement(
            [
                "requirement",
                "advance",
                req_id,
                "--pi-command",
                pi_command,
                "--project-path",
                str(source),
            ],
            tmp_path,
        )
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        alpha_id = single_task_id(document, "alpha")
        assert not (tmp_path / alpha_id / "workspace" / "beta.txt").exists()
        assert not (source / "beta.txt").exists()
