"""邮件交互协议的纯规则测试：命令解析、修订正文、发件人与主题。"""

import pytest

from forgeloop.domain.mail_interaction import (
    MailCommand,
    MailCommandKind,
    MailInteractionError,
    command_help,
    interaction_subject,
    is_auto_submitted,
    normalize_address,
    parse_approval_intent,
    parse_mail_command,
    reply_text,
    revision_text,
    sender_allowed,
)


class TestParseCommand:
    @pytest.mark.parametrize(
        ("body", "kind"),
        [
            ("status", MailCommandKind.STATUS),
            ("状态", MailCommandKind.STATUS),
            ("进展", MailCommandKind.STATUS),
            ("help", MailCommandKind.HELP),
            ("帮助", MailCommandKind.HELP),
            ("analyze", MailCommandKind.ANALYZE),
            ("plan", MailCommandKind.PLAN),
            ("advance", MailCommandKind.ADVANCE),
            ("accept", MailCommandKind.ACCEPT),
            ("验收", MailCommandKind.ACCEPT),
            ("/status", MailCommandKind.STATUS),
            ("#状态", MailCommandKind.STATUS),
            ("\uff01帮助", MailCommandKind.HELP),
        ],
    )
    def test_aliases_are_deterministic(self, body: str, kind: MailCommandKind) -> None:
        assert parse_mail_command(body) == MailCommand(kind)

    def test_approve_keeps_version_argument(self) -> None:
        assert parse_mail_command("approve 2") == MailCommand(MailCommandKind.APPROVE, "2")
        assert parse_mail_command("批准 v3") == MailCommand(MailCommandKind.APPROVE, "v3")

    def test_command_is_case_insensitive(self) -> None:
        assert parse_mail_command("STATUS") == MailCommand(MailCommandKind.STATUS)

    def test_unrecognized_language_is_not_a_command(self) -> None:
        assert parse_mail_command("同意") is None
        assert parse_mail_command("请批准这个方案") is None
        assert parse_mail_command("lgtm") is None

    def test_command_like_sentence_with_extra_text_is_not_a_command(self) -> None:
        # 正常回复以命令词开头时不应被误判成命令（避免把普通正文当控制指令）。
        assert parse_mail_command("状态：还需要确认") is None
        assert parse_mail_command("帮助我看一下这个需求") is None
        assert parse_mail_command("状态。") == MailCommand(MailCommandKind.STATUS)

    def test_quoted_lines_and_signature_are_ignored(self) -> None:
        body = "> status\n> 这是引用\n\nstatus\n\n-- \n签名"
        assert parse_mail_command(body) == MailCommand(MailCommandKind.STATUS)
        assert reply_text(body) == "status"

    def test_empty_body_has_no_command(self) -> None:
        assert parse_mail_command("") is None
        assert parse_mail_command("> only quote\n") is None

    def test_line_without_command_word_is_not_a_command(self) -> None:
        assert parse_mail_command("!!! 紧急") is None

    def test_revise_without_argument_uses_following_lines(self) -> None:
        body = "revise\n第一点\n第二点"
        assert parse_mail_command(body) == MailCommand(MailCommandKind.REVISE, "第一点\n第二点")

    def test_revise_with_argument_keeps_it(self) -> None:
        assert parse_mail_command("修订 补充说明") == MailCommand(
            MailCommandKind.REVISE, "补充说明"
        )

    def test_revise_keeps_argument_and_following_lines(self) -> None:
        assert parse_mail_command("revise 第一点\n第二点") == MailCommand(
            MailCommandKind.REVISE, "第一点\n第二点"
        )

    def test_help_does_not_need_requirement(self) -> None:
        assert MailCommand(MailCommandKind.HELP).needs_requirement is False
        assert MailCommand(MailCommandKind.STATUS).needs_requirement is True


class TestRevisionText:
    def test_plain_reply_is_revision_text(self) -> None:
        assert revision_text("补充：使用 PostgreSQL\n> 原通知") == "补充：使用 PostgreSQL"

    def test_revise_command_line_is_removed_when_no_argument(self) -> None:
        assert revision_text("revise\n补充说明") == "补充说明"

    def test_bare_revise_command_has_empty_text(self) -> None:
        assert revision_text("revise") == ""

    def test_revise_argument_is_used_when_present(self) -> None:
        assert revision_text("revise 补充说明\n下一行") == "补充说明\n下一行"

    def test_quoted_only_body_is_empty(self) -> None:
        assert revision_text("> 原通知\n> 原通知") == ""

    def test_chinese_quote_separator_stops_revision_text(self) -> None:
        # QQ/网易等客户端纯文本不用 ">"，用「原始邮件」引出历史引用。
        body = "补充说明\n\n         原始邮件\n发件人：437336207 <437336207@qq.com>\n主题：测试"
        assert revision_text(body) == "补充说明"

    def test_english_quote_attribution_stops_revision_text(self) -> None:
        body = "补充说明\n\nOn Mon, Oct 19, 2026 at 12:34 PM Owner <owner@example.com> wrote:\n> 原通知"
        assert revision_text(body) == "补充说明"


class TestApprovalIntent:
    @pytest.mark.parametrize(
        "body",
        ["批准", "同意。", "同意吧", "可以", "没问题!", "lgtm", "OK", "按这个方案做"],
    )
    def test_closed_approval_phrases_are_natural_language_approval(self, body: str) -> None:
        command = parse_approval_intent(body)
        assert command is not None
        assert command.kind is MailCommandKind.APPROVE
        assert command.argument == ""
        assert command.source == "natural_language"

    @pytest.mark.parametrize(("body", "version"), [("批准 v3", "3"), ("同意V2", "2")])
    def test_version_suffix_is_preserved(self, body: str, version: str) -> None:
        command = parse_approval_intent(body)
        assert command is not None
        assert command.kind is MailCommandKind.APPROVE
        assert command.argument == version
        assert command.source == "natural_language"

    @pytest.mark.parametrize("body", ["验收", "验收通过", "接受"])
    def test_acceptance_phrases_are_natural_language_accept(self, body: str) -> None:
        command = parse_approval_intent(body)
        assert command is not None
        assert command.kind is MailCommandKind.ACCEPT
        assert command.source == "natural_language"

    @pytest.mark.parametrize(
        "body",
        [
            "同意，但先补测试",
            "请批准这个方案",
            "批准 v3 并推进",
            "通过",
            "验收 v2",
            "批准\n同意",
            "> 批准\n> 同意",
            "",
        ],
    )
    def test_ambiguous_or_extra_text_is_not_approval(self, body: str) -> None:
        assert parse_approval_intent(body) is None


class TestSender:
    def test_normalize_display_name_and_case(self) -> None:
        assert normalize_address("Owner <Owner@Example.COM>") == "owner@example.com"

    def test_invalid_address_is_empty(self) -> None:
        assert normalize_address("not-an-address") == ""

    def test_allowlist_is_fail_closed(self) -> None:
        assert sender_allowed("owner@example.com", ()) is False
        assert sender_allowed("owner@example.com", ("other@example.com",)) is False
        assert sender_allowed("Owner <OWNER@example.com>", ("owner@example.com",)) is True

    def test_empty_sender_never_matches(self) -> None:
        assert sender_allowed("", ("owner@example.com",)) is False

    def test_auto_submitted_detection(self) -> None:
        assert is_auto_submitted("auto-replied") is True
        assert is_auto_submitted("auto-generated") is True
        assert is_auto_submitted("no") is False
        assert is_auto_submitted("") is False


class TestReplyMetadata:
    def test_subject_includes_requirement(self) -> None:
        assert interaction_subject("req-1", "状态") == "[ForgeLoop][req-1][状态]"

    def test_subject_without_requirement(self) -> None:
        assert interaction_subject(None, "帮助") == "[ForgeLoop][帮助]"

    def test_label_is_sanitized(self) -> None:
        assert interaction_subject("req-1", "[状态]\n第二行") == "[ForgeLoop][req-1][(状态) 第二行]"

    def test_blank_label_is_rejected(self) -> None:
        with pytest.raises(MailInteractionError, match="标签不能为空"):
            interaction_subject("req-1", "  ")

    def test_help_contains_explicit_approval_syntax(self) -> None:
        text = command_help("req-1")
        assert "req-1" in text
        assert "approve <任务包版本>" in text
        assert "不会把自然语言「同意」当作批准" in text
