"""测试替身：讲 ForgeLoop PI RPC 真实协议（pi 1.1.0 文档口径）的假 PI 进程。

协议行为（与 https://pi.dev/docs/latest/rpc 对齐）：
- prompt 命令 → 先回 ``{"type":"response","command":"prompt","success":true,...}``
  （disposition=started，接受不等于完成），再输出 agent 事件流。
- 完成路径：agent_start → … → agent_end → agent_settled；settled 后对
  ``get_last_assistant_text`` 命令回 ``{"data":{"text":...}}``。
- dev 角色的 text 是 JSON（含 summary/diff）；review 角色是 JSON
  （含 summary/blocking_issues）——模拟被指示输出结构化 JSON 的真实模型。
- abort 命令 → response + agent_settled(aborted=true)，进程保持存活直到
  stdin 关闭（真实 abort 不退出进程）。

行为由环境变量控制（真实 PI 由模型驱动，此处脚本化）：
- FAKE_PI_MODE=ok：正常完成（角色区分 dev/review）。
- FAKE_PI_MODE=blocking：review 始终阻断；dev 正常。
- FAKE_PI_MODE=blocking-first：首次 review 阻断后正常（状态文件 FAKE_PI_STATE）。
- FAKE_PI_MODE=hang：输出 agent_end 后挂起，等待 abort 或 EOF。
- FAKE_PI_MODE=unsettled：输出 agent_end 后退出（无 settled）。
- FAKE_PI_MODE=garbage：输出一行非法 JSON 后退出（协议错误负例）。
- FAKE_PI_MODE=scalar：输出合法但非对象的 JSON（42）后退出。
- FAKE_PI_MODE=ok-blank：先输出空行再正常 settled（空行容错）。
- FAKE_PI_MODE=reject：prompt 命令被拒绝（response success=false 负例）。
- FAKE_PI_MODE=model-error：正常 settled 但最终消息 stopReason=error
  （provider 失败复现：settled 不等于成功，实测 403 订阅失效场景）。
- FAKE_PI_MODE=plain-text：最终文本是自然语言而非 JSON（无结构化载荷）。
- FAKE_PI_MODE=review-bad-issues：review 返回 blocking_issues 但不是列表。
- FAKE_PI_MODE=review-no-issues：review 返回的 JSON 没有 blocking_issues 字段。
- FAKE_PI_MODE=review-empty-text：review 正常 settled 但既无结构化载荷也无文本。
- FAKE_PI_MODE=edit：dev 角色真实修改工作副本（写入 feature.txt=new，
  工作区路径取自 prompt 的 workspace 字段）——git diff 路径的场景替身。
"""

import json
import os
import sys
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

# 非结构化结果负例：不能据此得出"无阻断"（必须中断而非放行）。
REVIEW_BAD_ISSUES_RESULT = {
    "summary": "review 结果里 blocking_issues 不是列表",
    "blocking_issues": "none",
}

REVIEW_NO_ISSUES_RESULT = {"summary": "review 结果没有 blocking_issues 字段"}


# 协议负例模式：直接输出异常流并让进程退出（返回 None 表示无文本）。
PROTOCOL_NEGATIVE_MODES = ("garbage", "scalar", "unsettled")


def _emit_protocol_negative(mode: str) -> None:
    if mode == "garbage":
        sys.stdout.write("not-a-json-line\n")
        sys.stdout.flush()
    elif mode == "scalar":
        sys.stdout.write("42\n")
        sys.stdout.flush()
    else:
        emit({"type": "agent_end", "messages": [], "willRetry": False})


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(request: dict, success: bool = True, data: dict | None = None) -> None:
    record: dict = {
        "id": request.get("id"),
        "type": "response",
        "command": request.get("type"),
        "success": success,
    }
    if data is not None:
        record["data"] = data
    emit(record)


def prompt_role(text: str) -> str:
    """从 prompt 消息中识别角色（review 节点的 prompt 携带 role=review）。"""

    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return "dev"
    if isinstance(payload, dict):
        return str(payload.get("role", "dev"))
    return "dev"


def _blocking_first_result() -> dict:
    state_path = Path(os.environ.get("FAKE_PI_STATE", "fake-pi-state.json"))
    state = {"blocking_done": False}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    if not state.get("blocking_done"):
        state["blocking_done"] = True
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state), encoding="utf-8")
        return {
            "summary": "first review found blocking issue",
            "blocking_issues": ["首次审查阻断：候选改动缺少边界处理"],
        }
    return {"summary": "re-review passed", "blocking_issues": []}


def _prompt_workspace(message: str) -> Path | None:
    """从 prompt JSON 中取工作区路径（dev 节点携带 workspace 字段）。"""

    try:
        payload = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    workspace = payload.get("workspace")
    return Path(workspace) if isinstance(workspace, str) and workspace else None


def _role_result(mode: str, role: str) -> dict:
    if role != "review":
        return DEV_RESULT
    if mode == "blocking":
        return REVIEW_BLOCKING_RESULT
    if mode == "blocking-first":
        return _blocking_first_result()
    if mode == "review-bad-issues":
        return REVIEW_BAD_ISSUES_RESULT
    if mode == "review-no-issues":
        return REVIEW_NO_ISSUES_RESULT
    return REVIEW_OK_RESULT


def _serve_prompt(request: dict, mode: str) -> str | None:
    """处理 prompt：输出事件流；返回该轮最终文本（None 表示无文本可取）。"""

    message = request.get("message", "")
    if mode == "reject":
        respond(request, success=False, data={"error": "prompt rejected by fake"})
        return None
    respond(request, success=True, data={"disposition": "started"})
    emit({"type": "agent_start"})
    if mode in PROTOCOL_NEGATIVE_MODES:
        _emit_protocol_negative(mode)
        return None
    if mode == "ok-blank":
        sys.stdout.write("\n")
        sys.stdout.flush()
    if mode == "edit" and prompt_role(message) != "review":
        workspace = _prompt_workspace(message)
        if workspace is not None:
            (workspace / "feature.txt").write_text("new\n", encoding="utf-8")
    # 结果只计算一次：事件流与最终文本共享同一份（避免有状态模式被翻转两次）。
    result = _role_result(mode, prompt_role(message))
    if mode == "model-error":
        messages = [
            {"role": "user", "content": message},
            {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "403: active subscription required",
            },
        ]
        emit({"type": "agent_end", "messages": messages, "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
        return ""
    if mode == "hang":
        # 输出 agent_end 后挂起：等待 abort 或 stdin 关闭。
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        return json.dumps(result, ensure_ascii=False)
    emit({"type": "agent_end", "messages": [], "willRetry": False})
    emit({"type": "agent_settled", "aborted": False})
    if mode == "review-empty-text":
        return ""
    if mode == "plain-text":
        return "审查通过：未发现阻断问题（自然语言文本）"
    return json.dumps(result, ensure_ascii=False)


def _serve_abort(request: dict) -> None:
    respond(request, success=True)
    emit({"type": "agent_settled", "aborted": True})


def main() -> int:
    mode = os.environ.get("FAKE_PI_MODE", "ok")
    result_text: str | None = None
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        request_type = request.get("type")
        if request_type == "prompt":
            served = _serve_prompt(request, mode)
            if mode in ("unsettled", "garbage", "scalar"):
                return 0  # 进程退出负例：无 settled 或协议损坏
            if served is not None:
                result_text = served
        elif request_type == "abort":
            _serve_abort(request)
        elif request_type == "get_last_assistant_text":
            respond(request, success=True, data={"text": result_text or ""})
        else:
            respond(request, success=False, data={"error": f"unknown command: {request_type}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
