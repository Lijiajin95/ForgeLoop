"""邮件交互协议：确定性命令解析、发件人校验与回信主题规则。

邮件入口与 CLI 共用同一套需求、批准与执行记录。本模块只做纯协议判定，不访问
邮箱、记录或时钟：

- 命令必须写在正文第一个有效行，大小写不敏感，支持少量中文别名；不解析自然
  语言，也不把「同意」「可以」等模糊表达当作批准。
- 引用行（``>`` 开头）与签名分隔线之后的内容不参与命令解析，避免把通知原文
  误当成新命令。
- 批准命令必须显式携带任务包版本；版本与当前记录不一致时由调用方拒绝。
- 只有配置在允许列表中的发件地址才能触发命令；不在列表中的邮件不回复、不建档。
- 回信主题使用 ``[ForgeLoop][<req_id>][<标签>]``，保持线程稳定且可人工识别。

命令语法::

    status | 状态
    revise <补充内容> | 修订 <补充内容>
    analyze | 分析
    plan | 规划
    approve <任务包版本> | 批准 <任务包版本>
    advance | 推进
    accept | 验收
    help | 帮助

直接回复既有需求通知而不写命令时，正文作为需求修订内容追加；新邮件不写命令时
视为提交新需求。本模块不判断记录是否存在，也不执行任何动作。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from email.utils import parseaddr
from enum import StrEnum

# 邮件命令行的第一个词只允许 ASCII 字母与中文；后面的内容原样保留。全角叹号用
# 转义写入，避免 RUF001 把全角与半角标点判为易混淆字符。
_COMMAND_LINE = re.compile(r"^\s*[/#!\uFF01]?\s*([A-Za-z\u4e00-\u9fff]+)\s*(.*)$")
# 无参数命令允许行尾带这些标点（如「状态。」）；带其他文字的行不算命令，
# 避免把「状态：还需要确认」这类正常回复误判为命令。
_TRAILING_PUNCTUATION = "：:。.，,；;\uff01!\uff1f?、 \t"
# 常见邮件客户端的引用分隔：QQ/网易等中文客户端在纯文本里不用 ">"，而是用
# 「原始邮件」或 "On … wrote:" 引出历史引用；识别到即停止，避免把引用内容
# 追加进需求修订。
_QUOTE_SEPARATORS = frozenset({"原始邮件", "原始郵件", "-----original message-----"})
_QUOTE_ATTRIBUTION = re.compile(r"^(On .+ wrote:|在 .{1,60}写道[:：]?)$", re.IGNORECASE)


class MailInteractionError(ValueError):
    """违反邮件交互协议（命令为空、主题标签非法等）。"""


class MailCommandKind(StrEnum):
    """邮件入口支持的确定性命令。"""

    HELP = "help"
    STATUS = "status"
    REVISE = "revise"
    ANALYZE = "analyze"
    PLAN = "plan"
    APPROVE = "approve"
    ADVANCE = "advance"
    ACCEPT = "accept"


@dataclass(frozen=True)
class MailCommand:
    """一条已解析的命令；``argument`` 是命令后的原文，不做语义解释。"""

    kind: MailCommandKind
    argument: str = ""

    @property
    def needs_requirement(self) -> bool:
        """是否只能作用于已有需求；``help`` 可独立回复。"""

        return self.kind is not MailCommandKind.HELP


_ALIASES: dict[str, MailCommandKind] = {
    "help": MailCommandKind.HELP,
    "帮助": MailCommandKind.HELP,
    "status": MailCommandKind.STATUS,
    "状态": MailCommandKind.STATUS,
    "进展": MailCommandKind.STATUS,
    "revise": MailCommandKind.REVISE,
    "修订": MailCommandKind.REVISE,
    "analyze": MailCommandKind.ANALYZE,
    "分析": MailCommandKind.ANALYZE,
    "plan": MailCommandKind.PLAN,
    "规划": MailCommandKind.PLAN,
    "approve": MailCommandKind.APPROVE,
    "批准": MailCommandKind.APPROVE,
    "advance": MailCommandKind.ADVANCE,
    "推进": MailCommandKind.ADVANCE,
    "accept": MailCommandKind.ACCEPT,
    "验收": MailCommandKind.ACCEPT,
}


def _body_lines(body: str) -> list[str]:
    """去掉引用行、引用分隔与签名块后的正文行（保留原始缩进与空行）。"""

    lines: list[str] = []
    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith(">"):
            continue
        if stripped in _QUOTE_SEPARATORS or _QUOTE_ATTRIBUTION.match(stripped):
            break
        if stripped == "--" or stripped.startswith("-- "):
            break
        lines.append(raw.rstrip())
    return lines


def reply_text(body: str) -> str:
    """提取可用正文：去掉引用、签名与首尾空行，不改变其余内容。"""

    lines = _body_lines(body)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def parse_mail_command(body: str) -> MailCommand | None:
    """解析正文第一个有效行；没有可识别命令时返回 ``None``。

    只识别固定的命令词，不做自然语言推断。无法识别的回复由调用方按「补充需求
    内容」处理；新邮件则按新需求处理。
    """

    lines = [line for line in _body_lines(body) if line.strip()]
    if not lines:
        return None
    match = _COMMAND_LINE.match(lines[0])
    if match is None:
        return None
    kind = _ALIASES.get(match.group(1).lower())
    if kind is None:
        return None
    argument = match.group(2).strip()
    if kind is MailCommandKind.REVISE:
        # ``revise`` 后的内容：同一行的参数与后续行都算修订正文，不丢内容。
        following = "\n".join(lines[1:]).strip()
        if argument and following:
            argument = f"{argument}\n{following}"
        elif following:
            argument = following
    elif kind is not MailCommandKind.APPROVE:
        # 除批准与修订外，命令必须独占一行；带其他文字的行按普通正文处理。
        if argument.strip(_TRAILING_PUNCTUATION):
            return None
        argument = ""
    return MailCommand(kind, argument)


def revision_text(body: str) -> str:
    """提取需求修订正文；``revise`` 命令后没有内容时取命令后的正文。"""

    command = parse_mail_command(body)
    if command is not None and command.kind is MailCommandKind.REVISE:
        if command.argument:
            return command.argument
        lines = reply_text(body).splitlines()
        return "\n".join(lines[1:]).strip()
    return reply_text(body)


def normalize_address(raw: str) -> str:
    """把 ``Name <addr>`` 归一为小写邮箱地址；无法解析时返回空串。"""

    address = parseaddr(raw)[1].strip().lower()
    if "@" not in address:
        return ""
    return address


def is_auto_submitted(value: str) -> bool:
    """``Auto-Submitted`` 是否表示自动回复；``no`` 或空值按人工邮件处理。"""

    return bool(value.strip()) and value.strip().lower() != "no"


def sender_allowed(sender: str, allowed_senders: tuple[str, ...] | frozenset[str]) -> bool:
    """发件人是否在允许列表内；列表为空时一律拒绝（失败关闭）。"""

    normalized = normalize_address(sender)
    if not normalized:
        return False
    allowed = {normalize_address(item) for item in allowed_senders}
    allowed.discard("")
    return normalized in allowed


def interaction_subject(req_id: str | None, label: str) -> str:
    """构造稳定的回信主题；标签中的方括号与换行会被替换。"""

    cleaned = label.replace("[", "(").replace("]", ")").replace("\n", " ").strip()
    if not cleaned:
        raise MailInteractionError("回信标签不能为空")
    if req_id:
        return f"[ForgeLoop][{req_id}][{cleaned}]"
    return f"[ForgeLoop][{cleaned}]"


def command_help(req_id: str | None = None) -> str:
    """返回邮件命令说明；带上需求编号时便于直接复制批准命令。"""

    header = f"需求：{req_id}\n" if req_id else ""
    return (
        f"{header}"
        "可用命令（写在邮件正文第一行，大小写不敏感）：\n"
        "  status / 状态：查看需求、任务与下一步\n"
        "  revise <内容> / 修订 <内容>：追加需求新版本；也可直接回复本邮件写内容\n"
        "  analyze / 分析：执行只读分析（需配置 PI）\n"
        "  plan / 规划：生成任务包（需就绪分析与 PI）\n"
        "  approve <任务包版本> / 批准 <任务包版本>：批准最新任务包\n"
        "  advance / 推进：按依赖推进需求（需已批准任务包与 PI）\n"
        "  accept / 验收：需求整体验收\n"
        "  help / 帮助：显示本说明\n"
        "批准必须显式写出任务包版本；系统不会把自然语言「同意」当作批准。\n"
    )
