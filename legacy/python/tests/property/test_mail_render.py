"""邮件渲染的属性测试：任意中性事件都产出可读且可追溯的主题正文。

不变量：
- 渲染是确定性的纯函数；
- 主题统一带 ``[ForgeLoop]`` 前缀、单行且包含对象身份；
- 正文包含事件身份、对象身份、时间与摘要，并逐条列出明细；
- 五类关键事件各自非空且互不混淆；
- 渲染到待发送邮件时携带事件身份用于幂等。
"""

from datetime import datetime

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.mail.render import (
    MAIL_SUBJECT_PREFIX,
    KeyEvent,
    NotificationEvent,
    render,
    render_body,
    render_subject,
    to_outgoing_message,
)

# 排除控制字符，保证主题单行与正文行结构不被测试噪声破坏。
VISIBLE = st.characters(blacklist_categories=("Cc", "Cs"))
idents = st.text(alphabet=VISIBLE, min_size=1, max_size=30)
words = st.text(alphabet=VISIBLE, max_size=60)
details = st.dictionaries(idents, st.text(alphabet=VISIBLE, min_size=1, max_size=30), max_size=4)
kinds = st.sampled_from(list(KeyEvent))
moments = st.datetimes()


@st.composite
def events(draw) -> NotificationEvent:
    return NotificationEvent(
        event_id=draw(idents),
        kind=draw(kinds),
        subject_id=draw(idents),
        summary=draw(words),
        occurred_at=draw(moments),
        details=draw(details),
    )


@given(events())
def test_render_is_deterministic(event: NotificationEvent) -> None:
    assert render(event) == render(event)


@given(events())
def test_subject_is_prefixed_single_line_and_names_the_object(
    event: NotificationEvent,
) -> None:
    subject = render_subject(event)
    assert subject.startswith(MAIL_SUBJECT_PREFIX)
    assert "\n" not in subject
    assert event.subject_id in subject


@given(events())
def test_body_contains_traceable_fields(event: NotificationEvent) -> None:
    body = render_body(event)
    assert event.event_id in body
    assert event.subject_id in body
    assert event.occurred_at.isoformat() in body
    assert event.summary in body


@given(events())
def test_body_lists_every_detail(event: NotificationEvent) -> None:
    body = render_body(event)
    for key, value in event.details.items():
        assert key in body
        assert value in body


@given(st.sampled_from(list(KeyEvent)))
def test_every_kind_renders_nonempty(kind: KeyEvent) -> None:
    event = NotificationEvent(
        event_id="event-1",
        kind=kind,
        subject_id="task-1",
        summary="summary",
        occurred_at=datetime(2026, 10, 16),
    )
    rendered = render(event)
    assert rendered.subject.strip()
    assert rendered.body.strip()


def test_five_kinds_have_distinct_subjects() -> None:
    subjects = {
        render_subject(
            NotificationEvent(
                event_id="event-1",
                kind=kind,
                subject_id="task-1",
                summary="summary",
                occurred_at=datetime(2026, 10, 16),
            )
        )
        for kind in KeyEvent
    }
    assert len(subjects) == len(KeyEvent) == 5


@given(events())
def test_outgoing_message_carries_event_identity(event: NotificationEvent) -> None:
    message = to_outgoing_message(event, sender="owner@example.com", recipient="to@example.com")
    assert message.event_id == event.event_id
    assert message.recipients == ("to@example.com",)
    assert message.primary_recipient == "to@example.com"
