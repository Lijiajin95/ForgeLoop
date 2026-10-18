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
