"""测试替身：讲 DSH headless ``--json`` 事件流真实契约的假 dsh 进程。

契约依据（``@deepseek-ai/dsh-headless`` 官方 README，0.2.1）：
- 一个进程只回答一个任务：提示词从 stdin 读入，进程自行退出。
- stdout 是 JSONL 事件流：``session`` 开场，``status``/``text``/``tool_call``/
  ``tool_result`` 居中，``final`` 收场并携带完整最终文本；运行器自身失败写
  ``error`` 事件且没有 ``final``。
- ``status(phase=turn_end).reason.kind`` 是终态原因：``completed``/``aborted``/
  ``error``/``blocked`` 等；退出码 0 只对应 ``completed``。

行为由环境变量控制（真实 DSH 由模型驱动，此处脚本化）：
- FAKE_DSH_MODE=ok：正常完成（按角色区分 dev/review/analysis/planning 的结构化结果）。
- FAKE_DSH_MODE=model-error：turn_end reason.kind=error（provider 错误），exit 1。
- FAKE_DSH_MODE=aborted：turn_end reason.kind=aborted（用户中止），exit 1。
- FAKE_DSH_MODE=blocked：turn_end reason.kind=blocked，exit 1。
- FAKE_DSH_MODE=error-event：运行器自身失败，只写 error 事件、没有 final，exit 1。
- FAKE_DSH_MODE=no-final：正常开场后直接退出（协议畸形：没有 final），exit 0。
- FAKE_DSH_MODE=garbage：输出一行非 JSON 文本，exit 0。
- FAKE_DSH_MODE=hang：输出开场后挂起（等超时被终止）。
- FAKE_DSH_MODE=plain-text：final 是自然语言而非 JSON（无结构化载荷）。
- FAKE_DSH_MODE=review-bad-issues / review-no-issues / review-empty-text：审查结果畸形负例。
- FAKE_DSH_MODE=blocking-first：首次审查阻断后正常（状态文件 FAKE_DSH_STATE）。
- FAKE_DSH_MODE=edit：dev 角色真实修改工作副本（写入 feature.txt=new，工作区路径取自
  提示词 workspace 字段）。

其他环境变量：
- FAKE_DSH_RESULT：覆盖结构化结果（JSON 文本）。
- FAKE_DSH_PROMPT_LOG：把收到的提示词（角色 + 原文）追加落盘，供断言。
"""

import json
import os
import sys
import time
from pathlib import Path

DEV_RESULT = {
    "summary": "implemented and self-verified",
    "diff": (
        "diff --git a/example.txt b/example.txt\n"
        "--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n"
    ),
}
REVIEW_OK_RESULT = {"summary": "review passed", "blocking_issues": []}
REVIEW_BLOCKING_RESULT = {
    "summary": "review found blocking issues",
    "blocking_issues": ["示例阻断问题：实现与验收标准不符"],
}
REVIEW_BAD_ISSUES_RESULT = {
    "summary": "review 结果里 blocking_issues 不是列表",
    "blocking_issues": "none",
}
REVIEW_NO_ISSUES_RESULT = {"summary": "review 结果没有 blocking_issues 字段"}
ANALYSIS_RESULT = {
    "goal": "为 CLI 增加 status --json 输出",
    "scenarios": ["查看下一步动作", "查看阻塞原因"],
    "acceptance_criteria": ["status --json 含 next_action"],
    "clarifications": [],
}
PLANNING_RESULT = {
    "tasks": [
        {
            "task_id": "first",
            "goal": "实现 status --json 输出",
            "files": ["src/forgeloop/cli/main.py"],
            "acceptance": "输出稳定契约",
            "test_command": ["python3", "-m", "pytest", "tests/unit"],
            "depends_on": [],
            "limits": {"limit_seconds": 7200, "max_failure_rounds": 3},
        },
        {
            "task_id": "second",
            "goal": "补充契约测试",
            "files": ["tests/unit/test_status.py"],
            "acceptance": "契约测试通过",
            "test_command": ["python3", "-m", "pytest", "tests/unit"],
            "depends_on": ["first"],
            "limits": {"limit_seconds": 7200, "max_failure_rounds": 3},
        },
    ]
}


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def prompt_role(text: str) -> str:
    """从提示词 JSON 中识别角色：review/analysis/planning，缺省 dev。"""

    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return "dev"
    if isinstance(payload, dict):
        return str(payload.get("role", "dev"))
    return "dev"


def result_for(role: str, mode: str) -> dict:
    override = os.environ.get("FAKE_DSH_RESULT", "")
    if override:
        return json.loads(override)
    if role == "review":
        if mode == "review-bad-issues":
            return REVIEW_BAD_ISSUES_RESULT
        if mode == "review-no-issues":
            return REVIEW_NO_ISSUES_RESULT
        if mode in ("blocking", "blocking-first"):
            if mode == "blocking-first":
                return blocking_first_result()
            return REVIEW_BLOCKING_RESULT
        return REVIEW_OK_RESULT
    if role == "analysis":
        return ANALYSIS_RESULT
    if role == "planning":
        return PLANNING_RESULT
    return DEV_RESULT


def blocking_first_result() -> dict:
    state_path = Path(os.environ.get("FAKE_DSH_STATE", "fake-dsh-state.json"))
    state = {"blocking_done": False}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    if not state.get("blocking_done"):
        state["blocking_done"] = True
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state), encoding="utf-8")
        return REVIEW_BLOCKING_RESULT
    return REVIEW_OK_RESULT


def maybe_edit_workspace(role: str, mode: str, prompt_text: str) -> None:
    if role != "dev" or mode != "edit":
        return
    payload = json.loads(prompt_text)
    workspace = Path(str(payload.get("workspace", ".")))
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "feature.txt").write_text("new", encoding="utf-8")


def main() -> int:
    mode = os.environ.get("FAKE_DSH_MODE", "ok")
    prompt = sys.stdin.read()
    role = prompt_role(prompt)
    log_path = os.environ.get("FAKE_DSH_PROMPT_LOG", "")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({"role": role, "message": prompt}, ensure_ascii=False) + "\n")
    emit({"type": "session", "sessionId": f"session-fake-{os.getpid()}", "cwd": os.getcwd()})
    emit({"type": "status", "phase": "turn_start", "turn": 1})
    if mode == "hang":
        while True:
            time.sleep(1)
    if mode == "blank-line":
        emit({"type": "status", "phase": "turn_start", "turn": 1})
        emit({"type": "session", "sessionId": f"session-fake-{os.getpid()}", "cwd": os.getcwd()})
        text = json.dumps(result_for(role, "ok"), ensure_ascii=False)
        emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "completed"}})
        emit({"type": "final", "text": text})
        return 0
    if mode == "garbage":
        sys.stdout.write("not-a-json-line\n")
        sys.stdout.flush()
        return 0
    if mode == "error-event":
        emit({"type": "error", "message": "runner could not mount the profile"})
        return 1
    if mode == "no-final":
        emit({"type": "status", "phase": "turn_start", "turn": 1})
        return 0
    if mode == "aborted":
        emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "aborted"}})
        emit({"type": "final", "text": ""})
        return 1
    if mode == "blocked":
        emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "blocked"}})
        emit({"type": "final", "text": ""})
        return 1
    maybe_edit_workspace(role, mode, prompt)
    if mode == "model-error":
        emit(
            {
                "type": "status",
                "phase": "turn_end",
                "turn": 1,
                "reason": {
                    "kind": "error",
                    "error": {"code": "PROVIDER_ERROR", "message": "403 subscription required"},
                },
            }
        )
        emit({"type": "final", "text": ""})
        return 1
    if mode == "review-empty-text":
        emit({"type": "text", "text": ""})
        emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "completed"}})
        emit({"type": "final", "text": ""})
        return 0
    text = (
        "这是自然语言审查结论，没有 JSON 结构。"
        if mode == "plain-text"
        else json.dumps(result_for(role, mode), ensure_ascii=False)
    )
    emit({"type": "text", "text": text})
    emit({"type": "tool_call", "callId": "call-1", "tool": "bash", "input": {"command": "true"}})
    emit({"type": "tool_result", "callId": "call-1", "status": "completed", "result": ""})
    emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": "completed"}})
    emit({"type": "final", "text": text})
    return 0


if __name__ == "__main__":
    sys.exit(main())
