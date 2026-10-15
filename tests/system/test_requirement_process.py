"""系统测试：以真实子进程运行需求研发线 CLI，验证状态不依赖进程内内存。

需求受理、澄清、分析、批准与任务推进记录都写进同一 SQLite 权威记录；本用例
每一步都用全新的 ``python -m forgeloop`` 进程执行，再由另一个新进程回查，
证明系统自身状态可跨进程回查，而不是靠 DSH 的私有内存。

任务推进使用组合式假 PI（讲真实 PI JSONL RPC 协议）与真实测试命令，因此单任务
业务图、LangGraph 检查点与交付绑定都是真实边界。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.system

SRC = Path(__file__).resolve().parents[2] / "src"

# 组合式假 PI：按 prompt 的 role 返回分析/规划/实现/审查结构化结果。
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
        text = result_for(role_of(request.get("message", "")))
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": f"unknown command: {kind}"})
"""

CLARIFY_ANALYSIS = {
    "goal": "跨进程可回查的需求",
    "scenarios": [],
    "acceptance_criteria": [],
    "clarifications": ["验收标准由谁给出?"],
}
READY_ANALYSIS = {
    "goal": "跨进程可回查的需求",
    "scenarios": ["新进程可回查任务推进记录"],
    "acceptance_criteria": ["状态全部来自权威记录"],
    "clarifications": [],
}
PLAN = {
    "tasks": [
        {
            "task_id": "alpha",
            "goal": "实现受理入口",
            "files": ["src/forgeloop/domain/alpha.py"],
            "acceptance": "CLI 可提交需求",
            "test_command": ["python3", "-c", "print('passed')"],
            "depends_on": [],
        },
        {
            "task_id": "beta",
            "goal": "实现推进入口",
            "files": ["src/forgeloop/domain/beta.py"],
            "acceptance": "CLI 可推进任务",
            "test_command": ["python3", "-c", "print('passed')"],
            "depends_on": ["alpha"],
        },
    ]
}
DEV = {
    "summary": "implemented",
    "diff": "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -0,0 +1 @@\n+done\n",
}
REVIEW = {"summary": "review passed", "blocking_issues": []}


def run_requirement(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=90,
        env=env,
        check=False,
    )


def requirement_json(argv: list[str], records_root: Path) -> dict:
    result = run_requirement(argv, records_root)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def submit(records_root: Path, text: str = "跨进程需求") -> str:
    result = run_requirement(
        ["requirement", "submit", "--project", "forgeloop", "--input", text], records_root
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.split("需求已创建: ")[1].splitlines()[0].strip()


def configure(monkeypatch, tmp_path: Path) -> str:
    script = tmp_path / "combined_pi.py"
    script.write_text(PI, encoding="utf-8")
    monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps(READY_ANALYSIS, ensure_ascii=False))
    monkeypatch.setenv("FAKE_PLAN_RESULT", json.dumps(PLAN, ensure_ascii=False))
    monkeypatch.setenv("FAKE_DEV_RESULT", json.dumps(DEV, ensure_ascii=False))
    monkeypatch.setenv("FAKE_REVIEW_RESULT", json.dumps(REVIEW, ensure_ascii=False))
    return json.dumps([sys.executable, str(script)])


def drive_to_all_delivered(tmp_path: Path, pi_command: str) -> tuple[str, dict]:
    """跨进程跑到全部任务已交付但需求尚未整体验收，返回 ``(req_id, document)``。"""

    req_id = submit(tmp_path, "跨进程整体验收需求")
    run_requirement(["requirement", "analyze", req_id, "--pi-command", pi_command], tmp_path)
    run_requirement(["requirement", "plan", req_id, "--pi-command", pi_command], tmp_path)
    run_requirement(["requirement", "approve", req_id, "--by", "owner"], tmp_path)
    run_requirement(["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path)
    document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
    for entry in document["tasks"]:
        run_requirement(["approve", entry["single_task_id"], "--stage", "acceptance"], tmp_path)
        run_requirement(["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path)
    return req_id, requirement_json(["requirement", "status", req_id, "--json"], tmp_path)


class TestRequirementStateAcrossProcesses:
    def test_intake_and_revision_survive_new_process(self, tmp_path: Path) -> None:
        req_id = submit(tmp_path)

        # 全新进程回查：原文、状态与版本都来自记录，不靠进程内内存。
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["req_id"] == req_id
        assert document["project"] == "forgeloop"
        assert document["versions"] == [{"version": 1, "text": "跨进程需求"}]
        assert document["requirement_status"] == "draft"

        revised = run_requirement(
            ["requirement", "revise", req_id, "--input", "补充：标准由所有者给出"], tmp_path
        )
        assert revised.returncode == 0, revised.stderr

        # 又一个新进程：两个版本都在，顺序与原文不变。
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert [item["version"] for item in document["versions"]] == [1, 2]
        assert document["versions"][0]["text"] == "跨进程需求"

    def test_unknown_requirement_reports_not_found_in_new_process(self, tmp_path: Path) -> None:
        result = run_requirement(["requirement", "status", "req-unknown", "--json"], tmp_path)
        assert result.returncode == 1
        assert json.loads(result.stdout) == {
            "req_id": "req-unknown",
            "error": "requirement_not_found",
        }

    def test_clarification_analysis_and_plan_across_processes(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        pi_command = configure(monkeypatch, tmp_path)
        monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps(CLARIFY_ANALYSIS, ensure_ascii=False))
        req_id = submit(tmp_path, "需要澄清的需求")

        analyzed = run_requirement(
            ["requirement", "analyze", req_id, "--pi-command", pi_command], tmp_path
        )
        assert analyzed.returncode == 0, analyzed.stderr
        assert "待澄清" in analyzed.stdout
        # 全新进程回查：分析结论与等待澄清状态都在记录里。
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] == "awaiting_clarification"
        assert document["analysis"]["clarifications"] == ["验收标准由谁给出?"]

        monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps(READY_ANALYSIS, ensure_ascii=False))
        run_requirement(["requirement", "revise", req_id, "--input", "所有者给出"], tmp_path)
        reanalyzed = run_requirement(
            ["requirement", "analyze", req_id, "--pi-command", pi_command], tmp_path
        )
        assert reanalyzed.returncode == 0, reanalyzed.stderr
        plan = run_requirement(
            ["requirement", "plan", req_id, "--pi-command", pi_command], tmp_path
        )
        assert plan.returncode == 0, plan.stderr
        assert "任务包 v1" in plan.stdout
        approval = run_requirement(
            ["requirement", "approve", req_id, "--by", "owner", "--source", "batch-I01"],
            tmp_path,
        )
        assert approval.returncode == 0, approval.stderr
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] == "approved"
        assert document["authorization"]["can_execute"] is True
        assert [task["task_id"] for task in document["plan"]["tasks"]] == ["alpha", "beta"]

    def test_advance_and_acceptance_across_processes(self, tmp_path: Path, monkeypatch) -> None:
        pi_command = configure(monkeypatch, tmp_path)
        req_id = submit(tmp_path, "需要推进的需求")
        run_requirement(["requirement", "analyze", req_id, "--pi-command", pi_command], tmp_path)
        run_requirement(["requirement", "plan", req_id, "--pi-command", pi_command], tmp_path)
        run_requirement(["requirement", "approve", req_id, "--by", "owner"], tmp_path)

        advanced = run_requirement(
            ["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path
        )
        assert advanced.returncode == 0, advanced.stderr
        # 新进程回查：第一个任务停在等待所有者验收，单任务记录也可读。
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        alpha = document["tasks"][0]
        assert alpha["state"] == "awaiting_user"
        assert alpha["single_task"]["status"] == "awaiting_acceptance"

        # 既有单任务验收命令在另一个进程消费实际候选。
        accepted = run_requirement(
            ["approve", alpha["single_task_id"], "--stage", "acceptance"], tmp_path
        )
        assert accepted.returncode == 0, accepted.stderr

        final = run_requirement(
            ["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path
        )
        assert final.returncode == 0, final.stderr
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["tasks"][0]["state"] == "delivered"
        assert document["tasks"][0]["artifact"]["candidate_sha256"]
        assert document["tasks"][1]["state"] == "awaiting_user"

    def test_requirement_overall_acceptance_across_processes(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        pi_command = configure(monkeypatch, tmp_path)
        req_id = submit(tmp_path, "整体验收需求")
        run_requirement(["requirement", "analyze", req_id, "--pi-command", pi_command], tmp_path)
        run_requirement(["requirement", "plan", req_id, "--pi-command", pi_command], tmp_path)
        run_requirement(["requirement", "approve", req_id, "--by", "owner"], tmp_path)
        run_requirement(["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path)

        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        alpha = document["tasks"][0]
        beta = document["tasks"][1]
        assert alpha["single_task_id"].startswith("task-")

        # 只验收第一个任务：新进程执行的整体验收被拒绝，状态仍为 executing。
        run_requirement(["approve", alpha["single_task_id"], "--stage", "acceptance"], tmp_path)
        run_requirement(["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path)
        refused = run_requirement(["requirement", "accept", req_id], tmp_path)
        assert refused.returncode == 1
        assert "被拒绝" in refused.stdout
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] == "executing"

        # 全部任务验收后，另一个新进程执行整体验收并置 accepted。
        run_requirement(["approve", beta["single_task_id"], "--stage", "acceptance"], tmp_path)
        run_requirement(["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path)
        accepted = run_requirement(["requirement", "accept", req_id], tmp_path)
        assert accepted.returncode == 0, accepted.stderr
        assert "验收通过" in accepted.stdout
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] == "accepted"
        assert document["next_step"]["action"] == "归并并发布已验收任务"

        # 另一个新进程重复推进：accepted 是终态，不得静默回退为 executing。
        repeated = run_requirement(
            ["requirement", "advance", req_id, "--pi-command", pi_command], tmp_path
        )
        assert repeated.returncode == 0, repeated.stderr
        assert "需求状态: accepted" in repeated.stdout
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] == "accepted"

    def test_revision_invalidates_acceptance_across_processes(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        pi_command = configure(monkeypatch, tmp_path)
        req_id, document = drive_to_all_delivered(tmp_path, pi_command)
        assert all(entry["state"] == "delivered" for entry in document["tasks"])

        # 追加需求版本使已批准任务包失效；即使任务材料齐全也不得整体验收。
        run_requirement(["requirement", "revise", req_id, "--input", "补充验收标准"], tmp_path)
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["authorization"]["can_execute"] is False
        refused = run_requirement(["requirement", "accept", req_id], tmp_path)
        assert refused.returncode == 1
        assert "被拒绝" in refused.stdout
        document = requirement_json(["requirement", "status", req_id, "--json"], tmp_path)
        assert document["requirement_status"] != "accepted"
