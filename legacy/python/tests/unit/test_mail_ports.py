"""邮箱端口的单元测试：抽象接口、消息模型、错误族与 provider 预设。

覆盖 ``forgeloop.mail.ports`` 与 ``forgeloop.mail.presets`` 的公共行为：
- 四类错误各自可区分且都继承 ``MailError``；
- 消息模型校验不变量（收件人非法、发件人非法、口令保密）；
- ``MailSender``/``MailReceiver`` 是抽象接口，必须由适配器实现；
- QQ/Gmail 预设表达端点与加密差异，未知 provider 明确失败。
"""

from datetime import UTC, datetime

import pytest

from forgeloop.mail.ports import (
    IncomingMessage,
    MailAccount,
    MailAuthenticationError,
    MailConfigurationError,
    MailEncryption,
    MailError,
    MailNetworkError,
    MailReceiver,
    MailRecipientError,
    MailSender,
    OutgoingMessage,
    Receipt,
    Secret,
)
from forgeloop.mail.presets import (
    GMAIL_PRESET,
    PROVIDER_PRESETS,
    QQ_PRESET,
    SmtpEndpoint,
    preset_for,
)


class FakeSender(MailSender):
    def __init__(self) -> None:
        self.sent: list[OutgoingMessage] = []

    def send(self, message: OutgoingMessage) -> Receipt:
        self.sent.append(message)
        return Receipt("msg-1", datetime(2026, 10, 16, tzinfo=UTC), message.recipients)


class FakeReceiver(MailReceiver):
    def __init__(self, messages: tuple[IncomingMessage, ...] = ()) -> None:
        self.messages = messages

    def list_folders(self) -> tuple[str, ...]:
        return ("INBOX",)

    def fetch(self, folder: str) -> tuple[IncomingMessage, ...]:
        return self.messages


class TestErrorFamily:
    def test_each_error_is_a_mail_error(self) -> None:
        for error_type in (
            MailConfigurationError,
            MailAuthenticationError,
            MailNetworkError,
            MailRecipientError,
        ):
            assert issubclass(error_type, MailError)
            assert issubclass(error_type, RuntimeError)

    def test_errors_are_distinct_types(self) -> None:
        types = {
            MailConfigurationError,
            MailAuthenticationError,
            MailNetworkError,
            MailRecipientError,
        }
        assert len(types) == 4


class TestSecret:
    def test_reveal_returns_the_value(self) -> None:
        assert Secret("s3cr3t").reveal() == "s3cr3t"

    def test_repr_and_str_do_not_echo_the_value(self) -> None:
        secret = Secret("s3cr3t")
        assert "s3cr3t" not in repr(secret)
        assert "s3cr3t" not in str(secret)
        assert repr(secret) == "Secret(***)"
        assert str(secret) == "***"

    def test_truthiness_tracks_emptiness(self) -> None:
        assert bool(Secret("x"))
        assert not bool(Secret(""))

    def test_equality_compares_the_value(self) -> None:
        assert Secret("a") == Secret("a")
        assert Secret("a") != Secret("b")


class TestMailAccount:
    def test_valid_account_keeps_the_secret_hidden_in_repr(self) -> None:
        account = MailAccount("qq", "owner@example.com", Secret("auth-code"))
        assert account.provider == "qq"
        assert "auth-code" not in repr(account)

    def test_missing_at_sign_is_rejected(self) -> None:
        with pytest.raises(MailConfigurationError, match="邮箱地址不合法"):
            MailAccount("qq", "owner.example.com", Secret("x"))

    def test_empty_secret_is_rejected(self) -> None:
        with pytest.raises(MailConfigurationError, match="口令为空"):
            MailAccount("qq", "owner@example.com", Secret(""))

    def test_empty_provider_is_rejected(self) -> None:
        with pytest.raises(MailConfigurationError, match="provider"):
            MailAccount("   ", "owner@example.com", Secret("x"))


class TestOutgoingMessage:
    def test_valid_message_exposes_primary_recipient(self) -> None:
        message = OutgoingMessage(
            sender="owner@example.com",
            recipients=("to@example.com",),
            subject="subject",
            body="body",
            event_id="event-1",
        )
        assert message.primary_recipient == "to@example.com"
        assert message.event_id == "event-1"

    def test_empty_recipients_are_rejected(self) -> None:
        with pytest.raises(MailRecipientError, match="至少需要一个收件人"):
            OutgoingMessage("owner@example.com", (), "s", "b")

    @pytest.mark.parametrize(
        "recipient",
        ["without-at-sign", " two@example.com", "two@example.com ", "a b@example.com"],
    )
    def test_invalid_recipients_are_rejected(self, recipient: str) -> None:
        with pytest.raises(MailRecipientError, match="收件人地址不合法"):
            OutgoingMessage("owner@example.com", (recipient,), "s", "b")

    def test_invalid_sender_is_a_configuration_error(self) -> None:
        with pytest.raises(MailConfigurationError, match="发件人地址不合法"):
            OutgoingMessage("no-at-sign", ("to@example.com",), "s", "b")


class TestIncomingMessageAndReceipt:
    def test_incoming_message_defaults(self) -> None:
        message = IncomingMessage(
            message_id="<id@example.com>",
            sender="owner@example.com",
            subject="[ForgeLoop] hello",
            body="text",
            received_at=datetime(2026, 10, 16, tzinfo=UTC),
        )
        assert message.folder == "INBOX"
        assert message.attachments == ()

    def test_receipt_requires_a_message_id(self) -> None:
        with pytest.raises(MailConfigurationError, match="Message-ID"):
            Receipt("  ", datetime(2026, 10, 16, tzinfo=UTC), ("to@example.com",))


class TestAbstractPorts:
    def test_ports_cannot_be_instantiated(self) -> None:
        with pytest.raises(TypeError):
            MailSender()  # type: ignore[abstract]
        with pytest.raises(TypeError):
            MailReceiver()  # type: ignore[abstract]

    def test_implementations_satisfy_the_interfaces(self) -> None:
        sender = FakeSender()
        retried = OutgoingMessage("owner@example.com", ("to@example.com",), "s", "b")
        assert isinstance(sender.send(retried), Receipt)

        receiver = FakeReceiver(
            (
                IncomingMessage(
                    "<id@example.com>",
                    "owner@example.com",
                    "subject",
                    "body",
                    datetime(2026, 10, 16, tzinfo=UTC),
                ),
            )
        )
        assert receiver.list_folders() == ("INBOX",)
        assert len(receiver.fetch("INBOX")) == 1


class TestProviderPresets:
    def test_qq_uses_ssl_465(self) -> None:
        endpoint = QQ_PRESET.default_smtp_endpoint
        assert endpoint == SmtpEndpoint("smtp.qq.com", 465, MailEncryption.SSL)
        assert QQ_PRESET.imap_host == "imap.qq.com"
        assert "授权码" in QQ_PRESET.credential_label

    def test_gmail_offers_ssl_465_and_starttls_587(self) -> None:
        assert GMAIL_PRESET.default_smtp_endpoint == SmtpEndpoint(
            "smtp.gmail.com", 465, MailEncryption.SSL
        )
        assert SmtpEndpoint("smtp.gmail.com", 587, MailEncryption.STARTTLS) in (
            GMAIL_PRESET.smtp_endpoints
        )
        assert "应用专用密码" in GMAIL_PRESET.credential_label

    def test_presets_cover_only_qq_and_gmail(self) -> None:
        assert set(PROVIDER_PRESETS) == {"qq", "gmail"}

    @pytest.mark.parametrize("provider", ["qq", "QQ", " qq ", "gmail", "Gmail"])
    def test_preset_lookup_is_case_and_space_insensitive(self, provider: str) -> None:
        assert preset_for(provider).name in {"qq", "gmail"}

    def test_unknown_provider_fails_closed(self) -> None:
        with pytest.raises(MailConfigurationError, match="未知邮箱 provider"):
            preset_for("outlook")


class TestNotificationCarriesQuestionText:
    """出向回执带问题正文与作答指引（所有者 2026-10-19：只发编号对方看不懂）。"""

    def test_question_texts_and_reply_hint_are_rendered(self) -> None:
        from forgeloop.domain.mail import (
            DisambiguationQuestion,
            MailStatus,
            MailThread,
            render_notification,
        )

        thread = MailThread(req_id="req-1", status=MailStatus.DISAMBIGUATING)
        body = render_notification(
            thread,
            (
                DisambiguationQuestion("q1", "导出格式是什么?"),
                DisambiguationQuestion("q2", "需要保留多少历史数据?"),
            ),
        )
        assert "q1：导出格式是什么?" in body
        assert "q2：需要保留多少历史数据?" in body
        assert "请直接回复本邮件" in body

    def test_no_questions_renders_the_plain_notification(self) -> None:
        from forgeloop.domain.mail import MailStatus, MailThread, render_notification

        thread = MailThread(req_id="req-1", status=MailStatus.DISAMBIGUATING)
        body = render_notification(thread)
        assert "待澄清问题编号：无" in body and "请直接回复" not in body
