"""面板会话的纯规则（domain 层）：状态迁移、HITL 判定、提示词与输出解释。

职责边界：

- **只做判定**：会话状态、消息与标题的合法性、一轮人工输入的提示词组装、Agent 最终
  输出的解释（普通回复与显式请求人工决定）都在这里。本模块不碰数据库、不读文件、
  不启动进程。
- **不是第二套研发业务状态**：会话只承载「人在面板上与执行器对话」的过程事实；需求、
  任务、批准、验收与停止仍以既有记录为准，面板不因为一次对话改写任何研发工作项状态。
- **HITL 是显式契约**：提示词要求 Agent 需要人工决定时输出
  ``{"awaiting_human": true, "question": "..."}``，只有解析出该标记才登记「待人工决定」。
  不用自然语言猜测——猜测会把普通回复误判成等待人工，让人白等一个不存在的决定。
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import cast

HITL_MARKER = "awaiting_human"
"""Agent 显式请求人工决定的标记键；见本模块说明与 ``build_turn_prompt``。"""

SESSION_ID_PREFIX = "cs"
DECISION_ID_PREFIX = "dc"
HISTORY_MESSAGES_MAX = 20
"""回放进提示词的历史消息条数上限（单轮调用没有服务端会话，历史必须随提示词带上）。"""

PROMPT_CHARS_MAX = 20_000
TITLE_CHARS_MAX = 120
MESSAGE_CHARS_MAX = 8_000
REASON_CHARS_MAX = 500
PROJECT_NAME_CHARS_MAX = 64


class ConversationError(ValueError):
    """会话规则被违反（未知状态、非法输入、重复或答非所问的决定）。"""


class SessionStatus(StrEnum):
    """会话状态：可对话、等待人工决定、已终止。

    没有单独的「失败」状态：一轮失败会登记待人工决定并停在
    :attr:`AWAITING_HUMAN`（失败原因写在会话的 ``last_error`` 与系统消息里），
    由人工选择重试或终止——因此「失败」不是终点，不另设状态。
    """

    ACTIVE = "active"
    AWAITING_HUMAN = "awaiting_human"
    TERMINATED = "terminated"


class MessageRole(StrEnum):
    HUMAN = "human"
    AGENT = "agent"
    SYSTEM = "system"


class MessageState(StrEnum):
    """消息状态：``streaming`` 表示这一条正在增量写入（同一行会被反复更新）。"""

    OK = "ok"
    ERROR = "error"
    STREAMING = "streaming"


class DecisionKind(StrEnum):
    """待人工决定的种类：Agent 请求、一轮失败、或轮次边界的工具审批。"""

    AGENT_REQUEST = "agent_request"
    TURN_FAILED = "turn_failed"
    TOOL_REVIEW = "tool_review"


class DecisionStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


LIVE_SESSION_STATUSES = (SessionStatus.ACTIVE, SessionStatus.AWAITING_HUMAN)
"""「会话还在进行」的两个状态；终止是唯一终态，不再接受新消息。"""


@dataclass(frozen=True)
class Acceptance:
    """一次动作是否被允许，以及被拒绝时的原因（可直接展示给人看）。"""

    allowed: bool
    reason: str = ""


@dataclass(frozen=True)
class AgentReply:
    """Agent 一轮输出的解释结果：普通回复，或显式请求人工决定。"""

    awaiting_human: bool
    reply: str
    question: str = ""


def new_session_id(moment: datetime) -> str:
    """会话身份：``cs-<时间戳>-<随机后缀>``（与需求身份同风格，可读且不撞车）。"""

    return _new_id(SESSION_ID_PREFIX, moment)


def new_decision_id(moment: datetime) -> str:
    """待人工决定的身份：``dc-<时间戳>-<随机后缀>``。"""

    return _new_id(DECISION_ID_PREFIX, moment)


def _new_id(prefix: str, moment: datetime) -> str:
    return f"{prefix}-{moment.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"


def session_id_is_valid(value: str) -> bool:
    """会话身份的字面校验：只允许字母数字与 ``-``、``_``、``.``（用于路由匹配）。"""

    return bool(value) and len(value) <= 128 and _safe_token(value)


def decision_id_is_valid(value: str) -> bool:
    return session_id_is_valid(value)


def project_name_is_valid(value: str) -> bool:
    """项目名：非空、无空白、只用安全字符，避免写进 TOML 时产生嵌套表或转义歧义。"""

    return bool(value) and len(value) <= PROJECT_NAME_CHARS_MAX and _safe_token(value)


def _safe_token(value: str) -> bool:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
    return all(character in allowed for character in value)


def validate_title(title: str) -> str:
    """会话标题：非空、无换行、长度受限（直接进记录与页面）。"""

    text = title.strip()
    if not text:
        raise ConversationError("会话标题不能为空")
    if len(text) > TITLE_CHARS_MAX:
        raise ConversationError(f"会话标题不得超过 {TITLE_CHARS_MAX} 个字符")
    if "\n" in text or "\r" in text:
        raise ConversationError("会话标题不能含换行")
    return text


def validate_message(text: str) -> str:
    """人工消息：非空、长度受限；内容原样保留（不解释、不裁剪语义）。"""

    body = text.strip()
    if not body:
        raise ConversationError("消息内容不能为空")
    if len(body) > MESSAGE_CHARS_MAX:
        raise ConversationError(f"单条消息不得超过 {MESSAGE_CHARS_MAX} 个字符")
    return body


def validate_reason(reason: str) -> str:
    """人工理由：调用方负责「必须填写」，这里只做长度与空白校验。"""

    text = reason.strip()
    if len(text) > REASON_CHARS_MAX:
        raise ConversationError(f"理由不得超过 {REASON_CHARS_MAX} 个字符")
    return text


def can_accept_message(
    status: SessionStatus, *, pending_decision: bool, running: bool
) -> Acceptance:
    """现在能不能再发一条消息：终态、待人工决定、正在执行三种情况都要说清原因。"""

    if status not in LIVE_SESSION_STATUSES:
        return Acceptance(False, "会话已终止，不能再发消息")
    if pending_decision:
        return Acceptance(False, "有未处理的待人工决定；先批准或拒绝它")
    if running:
        return Acceptance(False, "上一轮还在执行；可等待完成或先终止会话")
    return Acceptance(True)


def can_decide(status: SessionStatus, decision_status: DecisionStatus) -> Acceptance:
    """现在能不能作出人工决定：只有进行中的会话与待决事项可以被决定。"""

    if decision_status is not DecisionStatus.PENDING:
        return Acceptance(False, f"该决定已是 {decision_status}，不能重复作出")
    if status not in LIVE_SESSION_STATUSES:
        return Acceptance(False, "会话已终止，该决定不再适用")
    return Acceptance(True)


def build_turn_prompt(
    *,
    project: str,
    project_path: str,
    title: str,
    history: tuple[tuple[MessageRole, str], ...],
    instruction: str,
    continuation: bool = False,
) -> str:
    """组装一次调用的提示词：项目身份 + HITL 契约 +（冷启动时）历史 + 本次人工输入。

    ``continuation=True`` 表示这一轮发给**同一个仍在运行的 PI 进程**：上下文已经在它
    手里，因此不再回放历史（回放会让模型把同一段对话读两遍），只发本次输入。冷启动
    （首次或进程被空闲回收后重启）必须回放，否则上下文真的丢了。

    超长时从**最旧**的消息开始丢弃，并在提示词里如实标注截断，不悄悄改变上下文。
    """

    lines = [
        f"你是 ForgeLoop 面板里的编码 Agent，正在项目「{project}」中工作。",
        f"项目路径：{project_path}（只在其中读写；需要人工决定时不要猜测）。",
        f"会话：{title}",
        "",
        "规则：",
        f'1. 需要人工决定（危险操作、范围取舍、信息不足）时，最后只输出一行 JSON：{{"{HITL_MARKER}": true, "question": "<要人工决定的问题>"}}',
        "2. 其他情况用简洁的中文说明：你做了什么、结果如何、还有什么没做。",
        "3. 不要臆造工具结果或测试结论。",
        "",
    ]
    if continuation:
        lines.extend(["这是同一会话的后续输入（上下文由你手上这个进程保持）：", instruction])
        return _truncate_prompt("\n".join(lines))
    body = _history_lines(history)
    lines.extend(["对话历史（最旧在前）：", *body, "", "本次人工输入：", instruction])
    return _truncate_prompt("\n".join(lines))


def _history_lines(history: tuple[tuple[MessageRole, str], ...]) -> list[str]:
    labels = {MessageRole.HUMAN: "人工", MessageRole.AGENT: "Agent", MessageRole.SYSTEM: "系统"}
    recent = history[-HISTORY_MESSAGES_MAX:]
    dropped = len(history) - len(recent)
    lines = [f"[历史已截断 {dropped} 条]"] if dropped > 0 else []
    lines.extend(f"[{labels[role]}] {content}" for role, content in recent)
    return lines


def _truncate_prompt(prompt: str) -> str:
    """提示词总长超限时保留尾部（近期上下文与本次输入优先），并标注被截断。"""

    if len(prompt) <= PROMPT_CHARS_MAX:
        return prompt
    kept = prompt[-PROMPT_CHARS_MAX:]
    return f"[提示词过长，已按上限截断前 {len(prompt) - len(kept)} 个字符]\n{kept}"


def interpret_agent_text(text: str) -> AgentReply:
    """解释 Agent 的最终文本：显式 HITL 标记 → 待人工决定，否则就是普通回复。

    只认结构化标记：JSON 对象里 ``awaiting_human`` 为真且 ``question`` 非空。模型偶尔把
    JSON 包在代码块或一句说明里，因此允许从第一个 ``{`` 起解析；解析不出对象时按普通
    回复处理（保留原文），绝不把普通文本猜成等待人工。
    """

    body = text.strip()
    payload = _first_json_object(body)
    if payload is not None and payload.get(HITL_MARKER) is True:
        question = str(payload.get("question", "")).strip()
        if question:
            return AgentReply(awaiting_human=True, reply=body, question=question)
    if not body:
        # 无文本不是可用结果：交给调用方按失败处理，不登记成一条空回复。
        return AgentReply(awaiting_human=False, reply="")
    return AgentReply(awaiting_human=False, reply=body)


def _first_json_object(text: str) -> dict[str, object] | None:
    """把文本解析成 JSON 对象；整体解析失败时从第一个 ``{`` 起尝试第一个完整对象。"""

    if not text:
        return None
    candidates = [text]
    start = text.find("{")
    if start > 0:
        candidates.append(text[start:])
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            data, _ = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return cast("dict[str, object]", data)
    return None


# ---- 增量事件解释（2026-10-18 按 206 份真实 PI 轨迹的实测形状补充） ----------------
#
# 真实轨迹（.cache/dogfood 与 .cache/preflight-sessions，500 万+ 事件）里的形状：
# - ``message_update``：``assistantMessageEvent`` 带 ``text_delta``、``thinking_delta``、
#   ``toolcall_delta``（``delta`` 为增量文本，``toolcall_delta`` 的 delta 是参数 JSON 片段）；
# - ``tool_execution_start``：``toolCallId``、``toolName``、``args``；
# - ``tool_execution_end``：``toolCallId``、``toolName``、``result``、``isError``、``durationMs``；
# - ``entry_appended``：``entry.type == "context_edit"``（PI 的上下文编辑，即自动压缩）。
#
# 解释规则放在 domain（纯判定，可被单元与变异测试直接覆盖），适配器只负责把事件回调上来。

TOOL_ARG_CHARS_MAX = 400
TOOL_RESULT_CHARS_MAX = 800
"""工具参数与结果的落库上限：够回查「它到底跑了什么」，不把整份输出塞进记录。"""

_READ_TOOLS = frozenset({"read", "ls", "list", "glob", "grep", "find", "search", "view", "stat"})
_WRITE_TOOLS = frozenset(
    {"edit", "write", "patch", "apply_patch", "create", "delete", "move", "rename"}
)
_EXECUTE_TOOLS = frozenset(
    {"bash", "shell", "exec", "run", "terminal", "process", "command", "spawn"}
)


class ToolRisk(StrEnum):
    """工具的风险级别：只读、写文件、执行命令、未知工具。

    ``UNKNOWN`` 不猜成安全：未知工具按最需要人工看的一类处理（见 ``approval_required``）。
    """

    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    UNKNOWN = "unknown"


class ToolApprovalPolicy(StrEnum):
    """轮次边界审批策略：不审批、只审写文件与执行、或全部工具都审。"""

    OFF = "off"
    WRITE = "write"
    ALL = "all"


@dataclass(frozen=True)
class ToolCallStart:
    """一次工具调用的开始事实：身份、名字、参数摘要与风险级别。"""

    tool_call_id: str
    tool_name: str
    args_excerpt: str
    risk: ToolRisk


@dataclass(frozen=True)
class ToolCallEnd:
    """一次工具调用的结束事实：身份、结果摘要、是否报错与耗时。"""

    tool_call_id: str
    tool_name: str
    result_excerpt: str
    is_error: bool
    duration_ms: int


def tool_risk(tool_name: str) -> ToolRisk:
    """按工具名判风险级别；未知名字返回 ``UNKNOWN``（不假设它安全）。"""

    name = tool_name.strip().lower()
    if name in _READ_TOOLS:
        return ToolRisk.READ
    if name in _WRITE_TOOLS:
        return ToolRisk.WRITE
    if name in _EXECUTE_TOOLS:
        return ToolRisk.EXECUTE
    return ToolRisk.UNKNOWN


def approval_required(risk: ToolRisk, policy: ToolApprovalPolicy) -> bool:
    """该风险级别的工具执行后是否需要人工审批下一轮。"""

    if policy is ToolApprovalPolicy.OFF:
        return False
    if policy is ToolApprovalPolicy.ALL:
        return True
    return risk in (ToolRisk.WRITE, ToolRisk.EXECUTE, ToolRisk.UNKNOWN)


def text_delta(payload: Mapping[str, object]) -> str:
    """``message_update`` → 助手可见文本增量；非文本增量（思考、工具参数）返回空串。

    思考增量刻意不落进对话流水：它是模型内部过程，混进来会让人读不清「它说了什么」。
    """

    event = _assistant_message_event(payload)
    if event is None or event.get("type") != "text_delta":
        return ""
    delta = event.get("delta")
    return delta if isinstance(delta, str) else ""


def _assistant_message_event(payload: Mapping[str, object]) -> Mapping[str, object] | None:
    raw = payload.get("assistantMessageEvent")
    return cast("Mapping[str, object]", raw) if isinstance(raw, Mapping) else None


def tool_call_started(payload: Mapping[str, object]) -> ToolCallStart | None:
    """``tool_execution_start`` → 工具调用开始事实；形状不符时返回 ``None``。"""

    tool_call_id = str(payload.get("toolCallId", "")).strip()
    tool_name = str(payload.get("toolName", "")).strip()
    if not tool_call_id or not tool_name:
        return None
    return ToolCallStart(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        args_excerpt=excerpt(_json_text(payload.get("args")), TOOL_ARG_CHARS_MAX),
        risk=tool_risk(tool_name),
    )


def tool_call_finished(payload: Mapping[str, object]) -> ToolCallEnd | None:
    """``tool_execution_end`` → 工具调用结束事实（含 ``isError`` 与耗时）。"""

    tool_call_id = str(payload.get("toolCallId", "")).strip()
    tool_name = str(payload.get("toolName", "")).strip()
    if not tool_call_id or not tool_name:
        return None
    return ToolCallEnd(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        result_excerpt=excerpt(_tool_result_text(payload.get("result")), TOOL_RESULT_CHARS_MAX),
        is_error=payload.get("isError") is True,
        duration_ms=_int_or_zero(payload.get("durationMs")),
    )


def context_edit_notice(payload: Mapping[str, object]) -> str:
    """``entry_appended`` 的上下文编辑 → 人读文案；不是上下文编辑时返回空串。

    PI 的自动压缩以「编辑条目」的形式出现（``replacement`` 为 null 即移除）。这里只
    如实转述它编辑了哪个条目，**不臆造摘要内容**——压缩后的上下文由 PI 自己持有。
    """

    entry = payload.get("entry")
    if not isinstance(entry, Mapping):
        return ""
    fields = cast("Mapping[str, object]", entry)
    if fields.get("type") != "context_edit":
        return ""
    target = str(fields.get("targetId", "")).strip() or "未知条目"
    replacement = fields.get("replacement")
    action = "移除" if replacement is None else "替换"
    return (
        f"PI 编辑了上下文（{action}条目 {target}）：这是它的自动压缩动作，不影响本会话的完整流水。"
    )


def tool_call_summary(name: str, args_excerpt: str) -> str:
    """工具调用的一行摘要（面板与提示词共用同一口径）。"""

    body = args_excerpt.strip()
    return f"{name}：{body}" if body else name


def excerpt(value: str, limit: int) -> str:
    """按上限截断并标注省略，避免把整份输出塞进记录。"""

    text = value.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…（已截断 {len(text) - limit} 字符）"


def _json_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):  # 不可序列化时退化为字符串化，不抛错
        return str(value)


def _tool_result_text(result: object) -> str:
    """工具结果 → 文本：优先取 ``content[].text``，退回 ``structuredContent`` 或整体。"""

    fields = _as_mapping(result)
    if fields is not None:
        text = _content_text(fields.get("content"))
        if text:
            return text
        for key in ("structuredContent", "details"):
            found = fields.get(key)
            if found is not None:
                return _json_text(found)
    return _json_text(result)


def _as_mapping(value: object) -> Mapping[str, object] | None:
    """按键取值用的映射视图；不是映射时返回 ``None``（调用方走兜底分支）。"""

    return cast("Mapping[str, object]", value) if isinstance(value, Mapping) else None


def _content_text(content: object) -> str:
    """工具结果里的文本片段：只取 ``type == "text"`` 的项，其余（图片等）不猜内容。"""

    if not isinstance(content, Sequence) or isinstance(content, str):
        return ""
    parts: list[str] = []
    for item in cast("Sequence[object]", content):
        if not isinstance(item, Mapping):
            continue
        entry = cast("Mapping[str, object]", item)
        if entry.get("type") == "text":
            parts.append(str(entry.get("text", "")))
    return "\n".join(parts)


def _int_or_zero(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)
