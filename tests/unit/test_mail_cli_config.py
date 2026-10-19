"""`mail poll` 与 `mail confirm` 的配置解析（所有者 2026-10-18 决定「接配置」）。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pytest

from forgeloop.cli.mail import _resolve_connection
from forgeloop.mail.ports import MailConfigurationError

CONFIG = """provider = "qq"
sender = "owner@qq.com"
recipient = "notify@qq.com"
folder = "&UXZO1mWHTvZZOQ-/FORGE_INBOX"
"""


@pytest.fixture
def configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "mail.toml"
    config.write_text(CONFIG, encoding="utf-8")
    secret = tmp_path / "mail-secret"
    secret.write_text("owner@qq.com\nAUTHCODE\n", encoding="utf-8")
    secret.chmod(0o600)
    monkeypatch.setenv("FORGELOOP_MAIL_SECRET", str(secret))
    return config


def args(**overrides: object) -> argparse.Namespace:
    base = {
        "config": "",
        "imap_host": "",
        "imap_port": 0,
        "imap_user": "",
        "imap_secret": "",
        "imap_folder": "",
        "smtp_host": "",
        "smtp_port": 0,
        "smtp_user": "",
        "smtp_secret": "",
        "smtp_sender": "",
        "smtp_recipient": "",
    }
    base.update(overrides)
    return argparse.Namespace(**base)


class TestResolveConnection:
    def test_config_only_uses_provider_preset_folder_and_secret(self, configured: Path) -> None:
        resolved = _resolve_connection(args(config=str(configured)))
        assert (resolved.imap_host, resolved.imap_port) == ("imap.qq.com", 993)
        assert (resolved.smtp_host, resolved.smtp_port) == ("smtp.qq.com", 465)
        assert resolved.imap_user == "owner@qq.com"
        assert resolved.smtp_sender == "owner@qq.com"
        assert resolved.smtp_recipient == "notify@qq.com"
        assert resolved.imap_folder == "&UXZO1mWHTvZZOQ-/FORGE_INBOX"
        assert resolved.imap_secret == "AUTHCODE" == resolved.smtp_secret

    def test_explicit_arguments_still_win(self, configured: Path) -> None:
        resolved = _resolve_connection(
            args(
                config=str(configured),
                imap_host="127.0.0.1",
                imap_port=1993,
                imap_user="local",
                imap_folder="INBOX",
                imap_secret="LOCAL",
            )
        )
        assert (resolved.imap_host, resolved.imap_port) == ("127.0.0.1", 1993)
        assert resolved.imap_folder == "INBOX"
        assert resolved.imap_secret == "LOCAL"
        # 未显式给出的部分仍由配置层补齐。
        assert resolved.smtp_host == "smtp.qq.com"
        assert resolved.smtp_recipient == "notify@qq.com"

    def test_no_config_and_no_arguments_fails_closed(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("FORGELOOP_MAIL_CONFIG", raising=False)
        with pytest.raises(MailConfigurationError):
            _resolve_connection(args())

    def test_missing_secret_is_reported_with_candidate_status(
        self, configured: Path, monkeypatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_MAIL_SECRET", raising=False)
        monkeypatch.setenv("HOME", str(configured.parent / "empty-home"))
        os.makedirs(configured.parent / "empty-home", exist_ok=True)
        from forgeloop.mail.ports import MailError

        with pytest.raises(MailError, match="口令"):
            _resolve_connection(args(config=str(configured)))


class TestWhitelistGateForNewRequirements:
    """2026-10-19：`mail.whitelist` 真正生效——名单外的来信不建需求（只报告跳过）。"""

    def _mail(self, sender: str):
        from datetime import UTC, datetime
        from email.message import EmailMessage

        from forgeloop.adapter.mail import parse_inbound

        message = EmailMessage()
        message["From"] = sender
        message["To"] = "owner@qq.com"
        message["Subject"] = "希望支持批量导出"
        message["Message-ID"] = "<w-1@example.com>"
        message["Date"] = "Mon, 19 Oct 2026 08:00:00 +0800"
        message.set_content("这是正文")
        return parse_inbound(
            message.as_bytes(), folder="INBOX", default_received_at=datetime.now(UTC)
        )

    def _resolvers(self):
        class _Threads:
            def inbound_message(self, message_id: str):
                return None

        class _Requirements:
            def __init__(self) -> None:
                self.submitted: list[tuple[str, str]] = []

            def submit(self, project: str, text: str):
                self.submitted.append((project, text))
                from types import SimpleNamespace

                return SimpleNamespace(req_id="req-new-1")

        return _Threads(), _Requirements()

    def test_sender_outside_whitelist_does_not_create_requirement(self) -> None:
        from typing import cast

        from forgeloop.cli.mail import _resolve_requirement
        from forgeloop.records.mail_threads import MailThreadStore
        from forgeloop.records.requirements import RequirementStore

        threads, requirements = self._resolvers()
        resolved = _resolve_requirement(
            self._mail("stranger@example.com"),
            cast("MailThreadStore", threads),
            cast("RequirementStore", requirements),
            "ForgeLoop",
            whitelist=frozenset({"owner@example.com"}),
        )
        assert resolved is None and requirements.submitted == []

    def test_whitelisted_sender_creates_requirement(self) -> None:
        from typing import cast

        from forgeloop.cli.mail import _resolve_requirement
        from forgeloop.records.mail_threads import MailThreadStore
        from forgeloop.records.requirements import RequirementStore

        threads, requirements = self._resolvers()
        resolved = _resolve_requirement(
            self._mail("owner@example.com"),
            cast("MailThreadStore", threads),
            cast("RequirementStore", requirements),
            "ForgeLoop",
            whitelist=frozenset({"owner@example.com"}),
        )
        assert resolved == "req-new-1" and requirements.submitted[0][0] == "ForgeLoop"

    def test_empty_whitelist_keeps_previous_behaviour(self) -> None:
        from typing import cast

        from forgeloop.cli.mail import _resolve_requirement
        from forgeloop.records.mail_threads import MailThreadStore
        from forgeloop.records.requirements import RequirementStore

        threads, requirements = self._resolvers()
        resolved = _resolve_requirement(
            self._mail("anyone@example.com"),
            cast("MailThreadStore", threads),
            cast("RequirementStore", requirements),
            "ForgeLoop",
        )
        assert resolved == "req-new-1"


class TestEffectiveWhitelist:
    """生效白名单：命令行优先 → 邮件配置 → 都不限制（2026-10-19）。"""

    def test_command_line_wins(self, configured: Path, monkeypatch) -> None:
        from forgeloop.cli.mail import _effective_whitelist

        monkeypatch.chdir(configured.parent)
        senders, source = _effective_whitelist(args(config=str(configured), whitelist=["A@x.com"]))
        assert senders == frozenset({"a@x.com"}) and "命令行" in source

    def test_config_whitelist_is_used_when_no_flag(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli.mail import _effective_whitelist

        config = tmp_path / "mail.toml"
        config.write_text(
            'provider = "qq"\nsender = "o@qq.com"\nrecipient = "r@qq.com"\n'
            'whitelist = ["Owner@Example.com"]\n',
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)
        senders, source = _effective_whitelist(args(config=str(config)))
        assert senders == frozenset({"owner@example.com"}) and "whitelist" in source

    def test_no_whitelist_anywhere_means_unrestricted(self, tmp_path: Path, monkeypatch) -> None:
        from forgeloop.cli.mail import _effective_whitelist

        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("FORGELOOP_MAIL_CONFIG", raising=False)
        senders, source = _effective_whitelist(args())
        assert senders == frozenset() and "未" in source
