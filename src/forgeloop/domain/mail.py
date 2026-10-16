"""邮件需求领域规则：分类建议、消歧轮次、超时提醒、回复关联与中文通知模板。

规则来源（任务 ``domain-mail``）：

- 邮件需求只有三类分类建议：**消歧**、**不接纳候选**、**接纳成功**。信息不完整
  先消歧；信息完整但不在受理范围列为不接纳候选；信息完整且可受理才建议接纳成功。
- 每次消歧把一组问题记为新一轮，最多 3 轮；达到上限后不再自动追问，线程标记为
  「退回人工」，由人工接手。
- 需求进入终态（接纳成功或不接纳）后不再产生新的消歧提问。
- 提问后 7 天仍无回复时只提醒一次；提醒可用开关关闭，终态一律不提醒。
- 回复关联按固定优先级解析：``In-Reply-To`` → ``References`` → 主题 → 正文；
  ``req-…`` 与 ``#req-…`` 两种写法都接受。
- 通知使用固定中文纯文本模板，至少含需求编号、当前状态与待澄清问题编号。
- 附件只记录元数据，不读取内容，也不参与关联解析。

本模块是纯领域规则：不读写记录、不访问时钟或环境，所有时间由调用方传入。
"""

import re
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum

# 消歧自动追问的轮次上限；达到后不再自动追问，退回人工。
MAX_DISAMBIGUATION_ROUNDS = 3
# 提问后多久没有回复才提醒一次。
REMINDER_AFTER = timedelta(days=7)


class MailError(ValueError):
    """违反邮件需求领域规则。"""


class MailStatus(StrEnum):
    """邮件需求线程的状态；``ACCEPTED`` 与 ``NOT_ACCEPTED`` 是终态。"""

    DISAMBIGUATING = "disambiguating"
    MANUAL_REVIEW = "manual_review"
    ACCEPTED = "accepted"
    NOT_ACCEPTED = "not_accepted"


TERMINAL_STATUSES: frozenset[MailStatus] = frozenset({MailStatus.ACCEPTED, MailStatus.NOT_ACCEPTED})

_STATUS_LABELS: dict[MailStatus, str] = {
    MailStatus.DISAMBIGUATING: "消歧中",
    MailStatus.MANUAL_REVIEW: "退回人工",
    MailStatus.ACCEPTED: "已接纳",
    MailStatus.NOT_ACCEPTED: "不接纳",
}


class Classification(StrEnum):
    """邮件需求的分类建议：消歧、不接纳候选、接纳成功。"""

    DISAMBIGUATE = "disambiguate"
    NOT_ACCEPT_CANDIDATE = "not_accept_candidate"
    ACCEPT_SUCCESS = "accept_success"


@dataclass(frozen=True)
class ClassificationSuggestion:
    """一条分类建议及其理由。"""

    kind: Classification
    reason: str


def suggest_classification(
    *, needs_clarification: bool, within_scope: bool
) -> ClassificationSuggestion:
    """按「是否缺信息」「是否在受理范围内」给出三分支分类建议。

    缺信息优先进入消歧；信息完整但不在受理范围内列为不接纳候选；两者都通过才
    建议接纳成功。判定只依赖调用方给出的事实，不猜测缺省值。
    """

    if needs_clarification:
        return ClassificationSuggestion(Classification.DISAMBIGUATE, "信息不完整，先进入消歧")
    if not within_scope:
        return ClassificationSuggestion(
            Classification.NOT_ACCEPT_CANDIDATE, "信息完整但不在受理范围内，列为不接纳候选"
        )
    return ClassificationSuggestion(
        Classification.ACCEPT_SUCCESS, "信息完整且在受理范围内，建议接纳"
    )


@dataclass(frozen=True)
class Attachment:
    """邮件附件：只记录元数据，不读取内容，也不参与关联解析。"""

    filename: str
    content_type: str = ""
    size_bytes: int = 0

    def __post_init__(self) -> None:
        if not self.filename.strip():
            raise MailError("附件文件名不能为空")
        if self.size_bytes < 0:
            raise MailError("附件大小不能为负")


@dataclass(frozen=True)
class MailReply:
    """一封用户回复；关联解析只看头部与正文，附件仅记录。"""

    received_at: datetime
    in_reply_to: str | None = None
    references: tuple[str, ...] = ()
    subject: str = ""
    body: str = ""
    attachments: tuple[Attachment, ...] = ()


@dataclass(frozen=True)
class DisambiguationQuestion:
    """一个待澄清问题；编号用于通知模板与后续答复关联。"""

    question_id: str
    text: str

    def __post_init__(self) -> None:
        if not self.question_id.strip():
            raise MailError("待澄清问题编号不能为空")
        if not self.text.strip():
            raise MailError("待澄清问题内容不能为空")


@dataclass(frozen=True)
class DisambiguationRound:
    """一轮消歧：一次提出的若干问题与提出时间。"""

    round_number: int
    questions: tuple[DisambiguationQuestion, ...]
    asked_at: datetime

    def __post_init__(self) -> None:
        if self.round_number < 1:
            raise MailError("消歧轮次必须从 1 开始")
        if not self.questions:
            raise MailError("一轮消歧至少要有一个待澄清问题")


@dataclass(frozen=True)
class MailThread:
    """一个需求在邮件入口的线程状态（不可变，操作返回新实例）。"""

    req_id: str
    status: MailStatus = MailStatus.DISAMBIGUATING
    rounds: tuple[DisambiguationRound, ...] = ()
    last_question_at: datetime | None = None
    last_reply_at: datetime | None = None
    reminder_sent_at: datetime | None = None
    attachments: tuple[Attachment, ...] = ()

    def __post_init__(self) -> None:
        if not self.req_id.strip():
            raise MailError("邮件需求必须绑定需求编号")
        numbers = [round_.round_number for round_ in self.rounds]
        if numbers != list(range(1, len(self.rounds) + 1)):
            raise MailError("消歧轮次必须从 1 起连续记录，历史轮次不得覆盖")

    @property
    def is_terminal(self) -> bool:
        """是否已进入终态（接纳成功或不接纳）。"""

        return self.status in TERMINAL_STATUSES

    @property
    def disambiguation_rounds(self) -> int:
        return len(self.rounds)

    @property
    def awaiting_reply(self) -> bool:
        """最后一次提问后是否仍没有回复。"""

        if self.last_question_at is None:
            return False
        return self.last_reply_at is None or self.last_reply_at < self.last_question_at

    def accept(self) -> "MailThread":
        """标记为接纳成功（终态）。"""

        return replace(self, status=MailStatus.ACCEPTED)

    def reject(self) -> "MailThread":
        """标记为不接纳（终态）。"""

        return replace(self, status=MailStatus.NOT_ACCEPTED)

    def open_disambiguation(
        self,
        questions: tuple[DisambiguationQuestion, ...],
        now: datetime,
    ) -> "DisambiguationOutcome":
        """尝试提出新一轮消歧提问；终态或已达上限时不再自动追问。

        数量上限只统计已经记入的轮次；第 ``MAX_DISAMBIGUATION_ROUNDS`` 轮仍会
        正常提出，之后再尝试提问才退回人工。
        """

        if self.is_terminal:
            return DisambiguationOutcome(self, (), False, "需求已到终态，不再产生新的消歧提问")
        if self.status is MailStatus.MANUAL_REVIEW:
            return DisambiguationOutcome(self, (), True, "已退回人工，不再自动追问")
        if self.disambiguation_rounds >= MAX_DISAMBIGUATION_ROUNDS:
            handed_off = replace(self, status=MailStatus.MANUAL_REVIEW)
            return DisambiguationOutcome(
                handed_off,
                (),
                True,
                f"消歧轮次已达上限 {MAX_DISAMBIGUATION_ROUNDS} 轮，退回人工处理",
            )
        if not questions:
            raise MailError("自动追问至少要有一个待澄清问题")
        round_ = DisambiguationRound(
            round_number=self.disambiguation_rounds + 1,
            questions=questions,
            asked_at=now,
        )
        updated = replace(
            self,
            rounds=(*self.rounds, round_),
            last_question_at=now,
            last_reply_at=None,
        )
        return DisambiguationOutcome(updated, questions, False, "已生成新的消歧提问")

    def record_reply(self, reply: MailReply) -> "MailThread":
        """记录一封回复的时间，并把附件元数据追加到线程记录。"""

        return replace(
            self,
            last_reply_at=reply.received_at,
            attachments=(*self.attachments, *reply.attachments),
        )

    def should_send_reminder(self, now: datetime, *, enabled: bool) -> bool:
        """判断是否应发送「7 天无回复」提醒。

        仅在消歧中、开关开启、尚未提醒、仍等待回复且距最后一次提问满 7 天时为真。
        提醒对同一线程只发一次；终态与退回人工后的线程都不再提醒。
        """

        if not enabled:
            return False
        if self.status is not MailStatus.DISAMBIGUATING:
            return False
        if self.reminder_sent_at is not None:
            return False
        if not self.awaiting_reply or self.last_question_at is None:
            return False
        return now - self.last_question_at >= REMINDER_AFTER

    def mark_reminder_sent(self, now: datetime) -> "MailThread":
        """记录提醒已发送，保证同一线程只提醒一次。"""

        return replace(self, reminder_sent_at=now)


@dataclass(frozen=True)
class DisambiguationOutcome:
    """一次消歧提问尝试的结果：新线程、实际提出的问题与是否退回人工。"""

    thread: MailThread
    questions: tuple[DisambiguationQuestion, ...]
    handed_to_manual: bool
    reason: str

    @property
    def asked(self) -> bool:
        """本次是否真的提出了新的消歧问题。"""

        return bool(self.questions)


# ``req-…`` 与 ``#req-…`` 都接受；用负向后顾避免从更长单词中间截取。
_REQUIREMENT_REFERENCE = re.compile(r"(?<![0-9A-Za-z])#?(req-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*)")


def _first_reference(texts: tuple[str, ...]) -> str | None:
    for text in texts:
        if not text:
            continue
        match = _REQUIREMENT_REFERENCE.search(text)
        if match is not None:
            return match.group(1)
    return None


def parse_reply_reference(reply: MailReply) -> str | None:
    """解析回复关联的需求编号；无关联返回 ``None``。

    优先级固定为 ``In-Reply-To`` → ``References`` → 主题 → 正文；每个位置都接受
    ``req-…`` 与 ``#req-…`` 两种写法。附件不参与解析。
    """

    header_texts = (reply.in_reply_to or "", *reply.references)
    from_headers = _first_reference(header_texts)
    if from_headers is not None:
        return from_headers
    return _first_reference((reply.subject, reply.body))


_NOTIFICATION_TEMPLATE = (
    "【ForgeLoop 需求通知】\n需求编号：{req_id}\n当前状态：{status}\n待澄清问题编号：{questions}\n"
)


def status_label(status: MailStatus) -> str:
    """状态的中文标签，供通知模板与 CLI 展示。"""

    return _STATUS_LABELS[status]


def render_notification(
    thread: MailThread,
    questions: tuple[DisambiguationQuestion, ...] = (),
) -> str:
    """用固定中文纯文本模板渲染通知；没有待澄清问题时写「无」。"""

    question_ids = "、".join(question.question_id for question in questions) or "无"
    return _NOTIFICATION_TEMPLATE.format(
        req_id=thread.req_id,
        status=status_label(thread.status),
        questions=question_ids,
    )
