"""邮件需求领域规则的单元测试（分类、消歧轮次、提醒、关联与模板）。"""

from datetime import UTC, datetime, timedelta

import pytest

from forgeloop.domain.mail import (
    MAX_DISAMBIGUATION_ROUNDS,
    REMINDER_AFTER,
    TERMINAL_STATUSES,
    Attachment,
    Classification,
    DisambiguationQuestion,
    DisambiguationRound,
    MailError,
    MailReply,
    MailStatus,
    MailThread,
    parse_reply_reference,
    render_notification,
    status_label,
    suggest_classification,
)

WHEN = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)


def question(question_id: str = "Q1") -> DisambiguationQuestion:
    return DisambiguationQuestion(question_id, "请补充这条需求的使用场景")


def thread(**kwargs: object) -> MailThread:
    return MailThread("req-20261016071651-c4f6e4", **kwargs)  # type: ignore[arg-type]


class TestClassificationSuggestion:
    """三类分类建议的三分支判定。"""

    def test_missing_information_disambiguates_first(self) -> None:
        both = suggest_classification(needs_clarification=True, within_scope=True)
        out_of_scope = suggest_classification(needs_clarification=True, within_scope=False)
        assert both.kind is Classification.DISAMBIGUATE
        assert out_of_scope.kind is Classification.DISAMBIGUATE  # 缺信息优先消歧
        assert both.reason

    def test_complete_but_out_of_scope_is_not_accept_candidate(self) -> None:
        suggestion = suggest_classification(needs_clarification=False, within_scope=False)
        assert suggestion.kind is Classification.NOT_ACCEPT_CANDIDATE
        assert suggestion.reason

    def test_complete_and_in_scope_is_accept_success(self) -> None:
        suggestion = suggest_classification(needs_clarification=False, within_scope=True)
        assert suggestion.kind is Classification.ACCEPT_SUCCESS
        assert suggestion.reason


class TestDisambiguationRounds:
    """消歧轮次计数与 3 轮上限。"""

    def test_first_round_is_recorded_and_awaits_reply(self) -> None:
        outcome = thread().open_disambiguation((question(),), WHEN)
        assert outcome.asked
        assert not outcome.handed_to_manual
        assert outcome.thread.disambiguation_rounds == 1
        assert outcome.thread.rounds[0].round_number == 1
        assert outcome.thread.awaiting_reply

    def test_up_to_three_rounds_are_allowed(self) -> None:
        current = thread()
        for round_number in range(1, MAX_DISAMBIGUATION_ROUNDS + 1):
            outcome = current.open_disambiguation(
                (question(f"Q{round_number}"),), WHEN + timedelta(hours=round_number)
            )
            assert outcome.asked
            assert not outcome.handed_to_manual
            current = outcome.thread
        assert current.disambiguation_rounds == MAX_DISAMBIGUATION_ROUNDS

    def test_fourth_attempt_hands_off_to_manual(self) -> None:
        current = thread()
        for round_number in range(1, MAX_DISAMBIGUATION_ROUNDS + 1):
            current = current.open_disambiguation((question(f"Q{round_number}"),), WHEN).thread
        outcome = current.open_disambiguation((question("Q4"),), WHEN + timedelta(days=1))
        assert outcome.asked is False
        assert outcome.questions == ()
        assert outcome.handed_to_manual
        assert outcome.thread.status is MailStatus.MANUAL_REVIEW
        assert outcome.thread.disambiguation_rounds == MAX_DISAMBIGUATION_ROUNDS

    def test_manual_review_does_not_ask_again(self) -> None:
        current = thread()
        for round_number in range(1, MAX_DISAMBIGUATION_ROUNDS + 1):
            current = current.open_disambiguation((question(f"Q{round_number}"),), WHEN).thread
        handed_off = current.open_disambiguation((question("Q4"),), WHEN).thread
        again = handed_off.open_disambiguation((question("Q5"),), WHEN)
        assert again.asked is False
        assert again.handed_to_manual
        assert again.thread.rounds == handed_off.rounds  # 不追加新轮次

    def test_empty_questions_are_rejected(self) -> None:
        with pytest.raises(MailError, match="至少要有一个待澄清问题"):
            thread().open_disambiguation((), WHEN)


class TestTerminalState:
    """终态后不再产生新的消歧提问。"""

    def test_accepted_is_terminal_and_stops_questions(self) -> None:
        accepted = thread().accept()
        assert accepted.status is MailStatus.ACCEPTED
        assert accepted.status in TERMINAL_STATUSES
        outcome = accepted.open_disambiguation((question(),), WHEN)
        assert outcome.asked is False
        assert outcome.questions == ()
        assert outcome.thread.status is MailStatus.ACCEPTED

    def test_not_accepted_is_terminal_and_stops_questions(self) -> None:
        rejected = thread().reject()
        assert rejected.status is MailStatus.NOT_ACCEPTED
        assert rejected.is_terminal
        outcome = rejected.open_disambiguation((question(),), WHEN)
        assert outcome.asked is False
        assert outcome.questions == ()


class TestReminder:
    """7 天无回复仅提醒一次，开关可配置，终态不提醒。"""

    def open_thread(self) -> MailThread:
        return thread().open_disambiguation((question(),), WHEN).thread

    def test_reminds_at_seven_days_without_reply(self) -> None:
        current = self.open_thread()
        assert current.should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)

    def test_does_not_remind_before_seven_days(self) -> None:
        current = self.open_thread()
        assert not current.should_send_reminder(
            WHEN + REMINDER_AFTER - timedelta(seconds=1), enabled=True
        )

    def test_switch_can_disable_reminder(self) -> None:
        current = self.open_thread()
        assert not current.should_send_reminder(WHEN + REMINDER_AFTER, enabled=False)

    def test_reminder_is_sent_only_once(self) -> None:
        current = self.open_thread()
        reminded = current.mark_reminder_sent(WHEN + REMINDER_AFTER)
        assert (
            reminded.should_send_reminder(WHEN + REMINDER_AFTER + timedelta(days=1), enabled=True)
            is False
        )

    def test_reply_cancels_reminder(self) -> None:
        current = self.open_thread()
        replied = current.record_reply(MailReply(WHEN + timedelta(days=1)))
        assert replied.awaiting_reply is False
        assert not replied.should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)

    def test_terminal_thread_never_reminds(self) -> None:
        accepted = self.open_thread().accept()
        rejected = self.open_thread().reject()
        assert not accepted.should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)
        assert not rejected.should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)

    def test_manual_review_does_not_remind(self) -> None:
        current = thread()
        for round_number in range(1, MAX_DISAMBIGUATION_ROUNDS + 1):
            current = current.open_disambiguation((question(f"Q{round_number}"),), WHEN).thread
        handed_off = current.open_disambiguation((question("Q4"),), WHEN).thread
        assert not handed_off.should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)

    def test_no_question_never_reminds(self) -> None:
        assert not thread().should_send_reminder(WHEN + REMINDER_AFTER, enabled=True)


class TestReplyReference:
    """回复关联解析：头部优先，主题/正文回退，`#req-…` 始终接受。"""

    def test_in_reply_to_is_parsed(self) -> None:
        reply = MailReply(WHEN, in_reply_to="<req-111@forgeloop.local>")
        assert parse_reply_reference(reply) == "req-111"

    def test_references_are_parsed(self) -> None:
        reply = MailReply(WHEN, references=("<msg-1@x>", "<req-222@forgeloop.local>"))
        assert parse_reply_reference(reply) == "req-222"

    def test_in_reply_to_has_priority_over_references(self) -> None:
        reply = MailReply(
            WHEN,
            in_reply_to="<req-111@x>",
            references=("<req-222@x>",),
        )
        assert parse_reply_reference(reply) == "req-111"

    def test_headers_have_priority_over_subject_and_body(self) -> None:
        reply = MailReply(
            WHEN,
            in_reply_to="<req-111@x>",
            subject="关于 req-333 的回复",
            body="正文提到 req-444",
        )
        assert parse_reply_reference(reply) == "req-111"

    def test_subject_number_is_used_as_fallback(self) -> None:
        reply = MailReply(WHEN, subject="关于 req-333 的回复", body="正文没有编号")
        assert parse_reply_reference(reply) == "req-333"

    def test_body_number_is_used_as_fallback(self) -> None:
        reply = MailReply(WHEN, subject="无编号", body="补充说明见 req-444 的上下文")
        assert parse_reply_reference(reply) == "req-444"

    def test_subject_has_priority_over_body(self) -> None:
        reply = MailReply(WHEN, subject="关于 req-333", body="正文提到 req-444")
        assert parse_reply_reference(reply) == "req-333"

    def test_hash_form_is_always_accepted(self) -> None:
        in_header = MailReply(WHEN, in_reply_to="<#req-555@x>")
        in_body = MailReply(WHEN, body="请按 #req-666 处理")
        assert parse_reply_reference(in_header) == "req-555"
        assert parse_reply_reference(in_body) == "req-666"

    def test_no_reference_returns_none(self) -> None:
        assert parse_reply_reference(MailReply(WHEN)) is None

    def test_attachment_filename_is_not_parsed(self) -> None:
        reply = MailReply(
            WHEN,
            subject="普通回复",
            body="正文没有编号",
            attachments=(Attachment("req-999-notes.txt"),),
        )
        assert parse_reply_reference(reply) is None


class TestNotificationTemplate:
    """中文纯文本固定模板渲染。"""

    def test_template_contains_id_status_and_question_ids(self) -> None:
        current = thread().open_disambiguation((question("Q1"), question("Q2")), WHEN).thread
        text = render_notification(current, current.rounds[0].questions)
        assert "req-20261016071651-c4f6e4" in text
        assert "消歧中" in text
        assert "Q1" in text and "Q2" in text

    def test_no_questions_renders_none_marker(self) -> None:
        text = render_notification(thread().accept())
        assert "已接纳" in text
        assert "待澄清问题编号：无" in text

    def test_template_is_chinese_plain_text(self) -> None:
        text = render_notification(thread())
        assert text.startswith("【ForgeLoop 需求通知】")
        assert "<" not in text and "{" not in text  # 无 HTML 标签，也无未替换占位符
        assert status_label(MailStatus.DISAMBIGUATING) == "消歧中"

    def test_manual_and_terminal_status_labels(self) -> None:
        assert status_label(MailStatus.MANUAL_REVIEW) == "退回人工"
        assert status_label(MailStatus.NOT_ACCEPTED) == "不接纳"


class TestAttachmentsAreRecordedOnly:
    """附件只记录元数据，不解析内容。"""

    def test_reply_attachments_are_kept_on_thread(self) -> None:
        attachment = Attachment("设计说明.pdf", "application/pdf", 2048)
        current = thread().record_reply(MailReply(WHEN, attachments=(attachment,)))
        assert current.attachments == (attachment,)
        assert current.last_reply_at == WHEN

    def test_blank_attachment_filename_is_rejected(self) -> None:
        with pytest.raises(MailError, match="文件名不能为空"):
            Attachment("   ")


class TestThreadConstruction:
    """线程身份与轮次记录的完整性校验。"""

    def test_requirement_id_is_required(self) -> None:
        with pytest.raises(MailError, match="必须绑定需求编号"):
            MailThread("  ")

    def test_round_numbers_must_be_contiguous(self) -> None:
        round_one = DisambiguationRound(1, (question(),), WHEN)
        round_three = DisambiguationRound(3, (question("Q3"),), WHEN)
        with pytest.raises(MailError, match="连续记录"):
            MailThread("req-1", rounds=(round_one, round_three))

    def test_question_ids_and_rounds_are_validated(self) -> None:
        with pytest.raises(MailError, match="编号不能为空"):
            DisambiguationQuestion(" ", "文本")
        with pytest.raises(MailError, match="至少要有一个待澄清问题"):
            DisambiguationRound(1, (), WHEN)
