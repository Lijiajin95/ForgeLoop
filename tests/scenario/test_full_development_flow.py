"""I01 全流程场景：真实 CLI 逐步执行需求受理 → 澄清 → 批准 → 任务推进 → 验收 → 归并。

A（需求）、B（单任务）与 C（交付）三条业务线各自已有实现。本用例从真实 CLI
入口把它们串起来，验证：

- 需求受理、追加澄清、只读分析、任务包批准都经真实记录落库，进程内可回查；
- 待澄清项未回答时不生成任务包；回答澄清后重新分析追加新版本、历史不覆盖；
- 未批准任务包不执行；批准绑定需求身份与任务包版本；
- 批准后 ``requirement advance`` 把需求任务映射到既有单任务业务图（真实 PI 替身、
  真实测试命令、真实检查点），等待所有者对实际候选做验收；
- 既有单任务验收命令消费后再次推进即交付，并把产物身份写入需求记录；
- 全部任务交付后需求仍等待整体验收，不自动验收；
- 既有 ``merge`` 命令仍可用于交付后的任务，状态从需求入口可回查。
"""

import json
import sys
from pathlib import Path

import pytest
from support import make_project, run_cli, run_git

from forgeloop.records.store import RecordStore

# 组合式假 PI：按 prompt 的 role 返回分析/规划/实现/审查结构化结果。
# 讲真实 PI JSONL RPC 协议（response + agent_start/agent_end/agent_settled）。
COMBINED_PI = r"""
import json
import os
import sys
from pathlib import Path


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


def payload(message):
    try:
        parsed = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def role_of(message):
    return str(payload(message).get("role", "dev"))


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
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        if role == "dev":
            target = os.environ.get("FAKE_DEV_WRITE")
            workspace = payload(message).get("workspace")
            if target and isinstance(workspace, str):
                path = Path(workspace) / target
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("new\n", encoding="utf-8")
        text = result_for(role)
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": f"unknown command: {kind}"})
"""

CLARIFY_ANALYSIS = {
    "goal": "把需求线接到真实 CLI 入口",
    "scenarios": [],
    "acceptance_criteria": [],
    "clarifications": ["验收标准由谁给出?"],
}

READY_ANALYSIS = {
    "goal": "把需求线接到真实 CLI 入口",
    "scenarios": ["所有者从 CLI 按依赖推进任务", "真实记录可跨进程回查"],
    "acceptance_criteria": ["需求状态与任务推进记录可回查", "未批准不执行"],
    "clarifications": [],
}

PLAN = {
    "tasks": [
        {
            "task_id": "alpha",
            "goal": "实现需求受理入口",
            "files": ["src/forgeloop/domain/alpha.py"],
            "acceptance": "CLI 可提交需求",
            "test_command": ["python3", "-c", "print('alpha passed')"],
            "depends_on": [],
        },
        {
            "task_id": "beta",
            "goal": "实现任务推进入口",
            "files": ["src/forgeloop/domain/beta.py"],
            "acceptance": "CLI 可按依赖推进任务",
            "test_command": ["python3", "-c", "print('beta passed')"],
            "depends_on": ["alpha"],
        },
    ]
}

DEV = {
    "summary": "implemented and self-verified",
    "diff": "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -0,0 +1 @@\n+done\n",
}
REVIEW = {"summary": "review passed", "blocking_issues": []}


def write_pi(tmp_path: Path) -> str:
    script = tmp_path / "combined_pi.py"
    script.write_text(COMBINED_PI, encoding="utf-8")
    return json.dumps([sys.executable, str(script)])


def set_results(monkeypatch, **values: object) -> None:
    for name, value in values.items():
        monkeypatch.setenv(name, json.dumps(value, ensure_ascii=False))


def submit_requirement(tmp_path: Path, capsys, text: str = "把三条业务线接到真实入口") -> str:
    code, out = run_cli(
        [
            "requirement",
            "submit",
            "--project",
            "forgeloop",
            "--input",
            text,
            "--records-root",
            str(tmp_path),
        ],
        capsys,
    )
    assert code == 0, out
    return out.split("需求已创建: ")[1].splitlines()[0].strip()


def requirement_document(tmp_path: Path, req_id: str, capsys) -> dict:
    code, out = run_cli(
        ["requirement", "status", req_id, "--json", "--records-root", str(tmp_path)], capsys
    )
    assert code == 0, out
    return json.loads(out)


def advance(
    tmp_path: Path,
    req_id: str,
    pi_command: str,
    capsys,
    project_path: str | None = None,
    pi_timeout_seconds: float | None = None,
) -> str:
    argv = [
        "requirement",
        "advance",
        req_id,
        "--pi-command",
        pi_command,
        "--records-root",
        str(tmp_path),
    ]
    if project_path is not None:
        argv.extend(["--project-path", project_path])
    if pi_timeout_seconds is not None:
        argv.extend(["--pi-timeout-seconds", str(pi_timeout_seconds)])
    code, out = run_cli(argv, capsys)
    assert code == 0, out
    return out


def drive_to_all_delivered(
    tmp_path: Path, capsys, monkeypatch, pi_command: str
) -> tuple[str, dict]:
    """跑到全部任务已交付但需求尚未整体验收的状态，返回 ``(req_id, document)``。"""

    set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
    set_results(monkeypatch, FAKE_DEV_RESULT=DEV, FAKE_REVIEW_RESULT=REVIEW)
    req_id = submit_requirement(tmp_path, capsys)
    for command in ("analyze", "plan"):
        code, out = run_cli(
            [
                "requirement",
                command,
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
    run_cli(["requirement", "approve", req_id, "--records-root", str(tmp_path)], capsys)
    advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
    document = requirement_document(tmp_path, req_id, capsys)
    for entry in document["tasks"]:
        run_cli(
            [
                "approve",
                entry["single_task_id"],
                "--stage",
                "acceptance",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
    return req_id, requirement_document(tmp_path, req_id, capsys)


class TestRequirementIntakeAndClarification:
    def test_clarification_blocks_planning_until_answered(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        pi_command = write_pi(tmp_path)
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=CLARIFY_ANALYSIS)
        set_results(monkeypatch, FAKE_PLAN_RESULT=PLAN)
        req_id = submit_requirement(tmp_path, capsys)

        code, out = run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "待澄清" in out

        # 有待澄清项时规划如实阻塞，不生成任务包。
        code, out = run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1 and "analysis_needs_clarification" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] == "blocked"
        assert document["plan"] is None

        # 回答澄清 = 追加版本；重新分析就绪后生成任务包，历史版本保留。
        code, out = run_cli(
            [
                "requirement",
                "revise",
                req_id,
                "--input",
                "验收标准由所有者给出",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "版本 2" in out
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS)
        code, out = run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "分析已就绪" in out
        code, out = run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "任务包 v1" in out

        document = requirement_document(tmp_path, req_id, capsys)
        assert [version["version"] for version in document["versions"]] == [1, 2]
        assert document["analysis"]["needs_clarification"] is False
        assert document["authorization"]["can_execute"] is False

    def test_unknown_requirement_fails_explicitly(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            ["requirement", "status", "req-unknown", "--json", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 1
        assert json.loads(out) == {"req_id": "req-unknown", "error": "requirement_not_found"}

        with pytest.raises(SystemExit, match="需求不存在"):
            run_cli(
                [
                    "requirement",
                    "revise",
                    "req-unknown",
                    "--input",
                    "补充",
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )


class TestApprovedPlanDrivesSingleTaskGraph:
    def test_unapproved_plan_is_not_executed(self, tmp_path: Path, capsys, monkeypatch) -> None:
        pi_command = write_pi(tmp_path)
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        req_id = submit_requirement(tmp_path, capsys)
        run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )

        out = advance(tmp_path, req_id, pi_command, capsys)
        assert "批准" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert all(entry["state"] == "pending" for entry in document["tasks"])
        assert document["tasks"][0]["single_task"] is None

    def test_advance_maps_to_single_task_graph_and_waits_for_owner(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        set_results(monkeypatch, FAKE_DEV_RESULT=DEV, FAKE_REVIEW_RESULT=REVIEW)
        pi_command = write_pi(tmp_path)
        req_id = submit_requirement(tmp_path, capsys)
        run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        code, out = run_cli(
            [
                "requirement",
                "approve",
                req_id,
                "--by",
                "owner",
                "--source",
                "batch-I01",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "授权来源 plan-approval:" in out

        out = advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        assert "需求状态: executing" in out
        assert "等待" in out  # 任务停在等待所有者决定的位置
        # 未做验收前再次推进：复用已存在的检查点中断，不重放动作。
        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["authorization"]["can_execute"] is True
        alpha = document["tasks"][0]
        assert alpha["state"] == "awaiting_user"
        assert alpha["single_task"]["status"] == "awaiting_acceptance"

        # 既有单任务验收命令消费实际候选；再次推进即交付并记录产物身份。
        code, out = run_cli(
            [
                "approve",
                alpha["single_task_id"],
                "--stage",
                "acceptance",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        advance(tmp_path, req_id, pi_command, capsys)
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["tasks"][0]["state"] == "delivered"
        assert document["tasks"][0]["artifact"]["acceptance"] == "accepted"
        assert document["tasks"][0]["artifact"]["candidate_sha256"]
        assert document["tasks"][1]["state"] == "awaiting_user"

        # 验收第二个任务后全部交付，但需求仍等待整体验收（不自动验收）。
        beta = document["tasks"][1]
        run_cli(
            [
                "approve",
                beta["single_task_id"],
                "--stage",
                "acceptance",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        advance(tmp_path, req_id, pi_command, capsys)
        document = requirement_document(tmp_path, req_id, capsys)
        assert all(entry["state"] == "delivered" for entry in document["tasks"])
        assert document["requirement_status"] == "executing"
        assert document["next_step"]["actor"] == "user"
        assert "验收" in document["next_step"]["action"]


class TestStatusAndRefusals:
    def test_text_status_before_and_after_plan(self, tmp_path: Path, capsys, monkeypatch) -> None:
        pi_command = write_pi(tmp_path)
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        req_id = submit_requirement(tmp_path, capsys)

        # 分析前：无分析、无任务包、无工时账目，文本输出走空分支。
        code, out = run_cli(
            ["requirement", "status", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0 and "状态: draft" in out and "下一步" in out
        run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        code, out = run_cli(
            ["requirement", "status", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0 and "任务包版本: 1" in out and "- alpha:" in out

    def test_status_not_found_text_output(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            ["requirement", "status", "req-unknown", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1 and "需求不存在" in out

    def test_blocked_analysis_is_reported(self, tmp_path: Path, capsys, monkeypatch) -> None:
        pi_command = write_pi(tmp_path)
        monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps({"summary": "missing fields"}))
        req_id = submit_requirement(tmp_path, capsys)
        code, out = run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1 and "分析未完成" in out
        code, out = run_cli(
            ["requirement", "status", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0 and "阻塞原因" in out

    def test_approve_without_plan_fails(self, tmp_path: Path, capsys) -> None:
        req_id = submit_requirement(tmp_path, capsys)
        with pytest.raises(SystemExit, match="尚无任务包"):
            run_cli(["requirement", "approve", req_id, "--records-root", str(tmp_path)], capsys)


class TestDeliveryLineStillReachable:
    def test_merge_after_requirement_delivery(self, tmp_path: Path, capsys, monkeypatch) -> None:
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        set_results(monkeypatch, FAKE_DEV_RESULT=DEV, FAKE_REVIEW_RESULT=REVIEW)
        monkeypatch.setenv("FAKE_DEV_WRITE", "feature.txt")
        pi_command = write_pi(tmp_path)
        project = make_project(tmp_path, remote="")
        run_git(project, "config", "user.name", "t")
        run_git(project, "config", "user.email", "t@example.com")
        req_id = submit_requirement(tmp_path, capsys)
        run_cli(
            [
                "requirement",
                "analyze",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(
            [
                "requirement",
                "plan",
                req_id,
                "--pi-command",
                pi_command,
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(["requirement", "approve", req_id, "--records-root", str(tmp_path)], capsys)
        advance(tmp_path, req_id, pi_command, capsys, project_path=str(project))
        document = requirement_document(tmp_path, req_id, capsys)
        alpha_task = document["tasks"][0]["single_task_id"]
        run_cli(
            ["approve", alpha_task, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        advance(tmp_path, req_id, pi_command, capsys, project_path=str(project))

        code, out = run_cli(
            ["merge", alpha_task, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["tasks"][0]["single_task"]["merge"] is not None
        assert document["tasks"][0]["single_task"]["status"] == "merged"


class TestRequirementOverallAcceptance:
    def test_acceptance_requires_all_tasks_and_records_identity(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        set_results(monkeypatch, FAKE_DEV_RESULT=DEV, FAKE_REVIEW_RESULT=REVIEW)
        pi_command = write_pi(tmp_path)
        req_id = submit_requirement(tmp_path, capsys)
        for command in ("analyze", "plan"):
            code, out = run_cli(
                [
                    "requirement",
                    command,
                    req_id,
                    "--pi-command",
                    pi_command,
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )
            assert code == 0, out
        run_cli(["requirement", "approve", req_id, "--records-root", str(tmp_path)], capsys)

        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        document = requirement_document(tmp_path, req_id, capsys)
        alpha = document["tasks"][0]
        beta = document["tasks"][1]
        # 映射到单任务记录时保留受控任务 ID 前缀，且任务之间身份互不别名。
        assert alpha["single_task_id"].startswith("task-")
        assert beta["single_task_id"].startswith("task-")
        assert alpha["single_task_id"] != beta["single_task_id"]

        # 只验收第一个任务时，整体验收明确拒绝，需求仍停在 executing。
        run_cli(
            [
                "approve",
                alpha["single_task_id"],
                "--stage",
                "acceptance",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)

        # 需求身份写入映射任务配置，且验收材料绑定可回查（来源门禁已按所有者决定取消）。
        record_store = RecordStore(tmp_path / "records.sqlite")
        try:
            mapped = record_store.get_task(alpha["single_task_id"])
            assert mapped is not None
            assert mapped.config["requirement_id"] == req_id
            binding = record_store.acceptance_binding(alpha["single_task_id"])
            assert binding is not None
        finally:
            record_store.close()

        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 1 and "被拒绝" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] == "executing"
        assert document["next_step"]["actor"] == "user"

        # 全部任务验收后，整体验收通过并置 accepted（契约 §4 的状态可达）。
        run_cli(
            [
                "approve",
                beta["single_task_id"],
                "--stage",
                "acceptance",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0 and "验收通过" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] == "accepted"
        assert document["next_step"]["action"] == "归并并发布已验收任务"

    def test_acceptance_without_plan_is_refused(self, tmp_path: Path, capsys) -> None:
        req_id = submit_requirement(tmp_path, capsys)
        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 1 and "尚无任务包" in out

    def test_revision_invalidates_overall_acceptance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # 全部任务已交付后追加需求版本：已批准任务包立即失效（契约 §5.3）。
        pi_command = write_pi(tmp_path)
        req_id, document = drive_to_all_delivered(tmp_path, capsys, monkeypatch, pi_command)
        assert all(entry["state"] == "delivered" for entry in document["tasks"])

        run_cli(
            [
                "requirement",
                "revise",
                req_id,
                "--input",
                "补充：验收标准由所有者复核",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["authorization"]["can_execute"] is False

        # 即使全部任务材料齐全，也不得用过期任务包完成整体验收。
        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 1 and "被拒绝" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] != "accepted"

    def test_accepted_is_terminal_for_advance(self, tmp_path: Path, capsys, monkeypatch) -> None:
        pi_command = write_pi(tmp_path)
        req_id, document = drive_to_all_delivered(tmp_path, capsys, monkeypatch, pi_command)
        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 0 and "验收通过" in out
        assert requirement_document(tmp_path, req_id, capsys)["requirement_status"] == "accepted"

        # 重复推进不得把已验收终态静默回退成 executing。
        out = advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        assert "需求状态: accepted" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] == "accepted"
        assert document["next_step"]["action"] == "归并并发布已验收任务"

    def test_acceptance_rejects_material_drift_after_task_acceptance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        set_results(monkeypatch, FAKE_ANALYSIS_RESULT=READY_ANALYSIS, FAKE_PLAN_RESULT=PLAN)
        set_results(monkeypatch, FAKE_DEV_RESULT=DEV, FAKE_REVIEW_RESULT=REVIEW)
        pi_command = write_pi(tmp_path)
        req_id = submit_requirement(tmp_path, capsys)
        for command in ("analyze", "plan"):
            run_cli(
                [
                    "requirement",
                    command,
                    req_id,
                    "--pi-command",
                    pi_command,
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )
        run_cli(["requirement", "approve", req_id, "--records-root", str(tmp_path)], capsys)
        advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)
        document = requirement_document(tmp_path, req_id, capsys)
        for entry in document["tasks"]:
            run_cli(
                [
                    "approve",
                    entry["single_task_id"],
                    "--stage",
                    "acceptance",
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )
            advance(tmp_path, req_id, pi_command, capsys, pi_timeout_seconds=120.0)

        # 全部任务验收后替换一个任务的候选材料：原验收失效，整体验收必须拒绝。
        alpha = document["tasks"][0]
        (tmp_path / alpha["single_task_id"] / "candidate.diff").write_text(
            "tampered\n", encoding="utf-8"
        )
        code, out = run_cli(
            ["requirement", "accept", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert code == 1 and "被拒绝" in out and "变化" in out
        document = requirement_document(tmp_path, req_id, capsys)
        assert document["requirement_status"] == "executing"
