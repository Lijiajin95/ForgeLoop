"""从中性事件数据渲染可读的邮件主题与正文。

本模块是纯函数：不依赖 records/cli/adapter/graph，也不做 I/O。事件来源
由组合根从权威记录读出后归一为 :class:`NotificationEvent`；首版覆盖五类
关键事件：任务到达验收门、任务失败/中断/超时、需求整体验收通过、归并
完成、发布完成。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum

from forgeloop.mail.ports import OutgoingMessage

MAIL_SUBJECT_PREFIX = "[ForgeLoop]"


class KeyEvent(StrEnum):
    """首版支持通知的关键事件类型。"""

    AWAITING_ACCEPTANCE = "awaiting_acceptance"
    TASK_FAILURE = "task_failure"
    REQUIREMENT_ACCEPTED = "requirement_accepted"
    MERGED = "merged"
    RELEASED = "released"


@dataclass(frozen=True)
class NotificationEvent:
    """与记录结构无关的中性事件：身份、对象、时间、摘要与明细。"""

    event_id: str
    kind: KeyEvent
    subject_id: str
    summary: str
    occurred_at: datetime
    details: Mapping[str, str] = field(default_factory=dict)

    def detail(self, key: str, default: str = "—") -> str:
        value = self.details.get(key)
        return default if value is None or value == "" else value


@dataclass(frozen=True)
class RenderedMessage:
    """渲染结果：可读主题与正文。"""

    subject: str
    body: str


_EVENT_LABELS: Mapping[KeyEvent, str] = {
    KeyEvent.AWAITING_ACCEPTANCE: "任务待验收",
    KeyEvent.TASK_FAILURE: "任务失败",
    KeyEvent.REQUIREMENT_ACCEPTED: "需求验收通过",
    KeyEvent.MERGED: "归并完成",
    KeyEvent.RELEASED: "发布完成",
}


def event_label(kind: KeyEvent) -> str:
    """返回事件类型的中文可读标签。"""

    return _EVENT_LABELS[kind]


def render_subject(event: NotificationEvent) -> str:
    """渲染单行主题，包含统一前缀、事件标签与对象身份。"""

    return f"{MAIL_SUBJECT_PREFIX} {event_label(event.kind)}：{event.subject_id}"


def render_body(event: NotificationEvent) -> str:
    """渲染多行正文：事件身份、对象、时间、摘要与明细，便于直接阅读。"""

    lines = [
        f"事件：{event_label(event.kind)}",
        f"事件身份：{event.event_id}",
        f"对象：{event.subject_id}",
        f"时间：{event.occurred_at.isoformat()}",
        f"摘要：{event.summary}",
    ]
    if event.details:
        lines.append("明细：")
        lines.extend(f"  - {key}：{value}" for key, value in event.details.items())
    lines.extend(("", "本邮件由 ForgeLoop 自动发送，请勿直接回复。"))
    return "\n".join(lines)


def render(event: NotificationEvent) -> RenderedMessage:
    """把中性事件渲染为可读主题与正文。"""

    return RenderedMessage(subject=render_subject(event), body=render_body(event))


def to_outgoing_message(
    event: NotificationEvent,
    *,
    sender: str,
    recipient: str,
) -> OutgoingMessage:
    """把事件渲染为待发送邮件，并携带事件身份用于幂等判定。"""

    rendered = render(event)
    return OutgoingMessage(
        sender=sender,
        recipients=(recipient,),
        subject=rendered.subject,
        body=rendered.body,
        event_id=event.event_id,
    )
