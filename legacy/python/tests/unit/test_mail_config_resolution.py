"""邮件配置解析的单元测试：优先级、fail-closed 与字段校验。

覆盖 ``forgeloop.mail.config`` 的公共行为：
- 优先级 ``--config`` > ``FORGELOOP_MAIL_CONFIG`` > ``<repo>/config/mail.toml``
  > ``~/.config/mail.toml`` > ``~/.config/forgeloop/mail.toml``；
- 全部缺失时 fail-closed 并提示复制模板 ``config/mail.example.toml``；
- 必需键、未知键、provider 与可选字段类型校验；
- 记录实际读取的 ``source_path``。
"""

from pathlib import Path

import pytest

from forgeloop.mail.config import (
    CONFIG_ENV_VAR,
    DEFAULT_FOLDER,
    DEFAULT_SUBJECT_PREFIX,
    MailConfig,
    config_candidates,
    load_mail_config,
    parse_mail_config,
)
from forgeloop.mail.ports import MailConfigurationError

REPO = Path("/repo")


def write_config(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def minimal_config(*, provider: str = "qq", sender: str = "owner@example.com") -> str:
    return f'provider = "{provider}"\nsender = "{sender}"\nrecipient = "owner@example.com"\n'


def load(tmp_path: Path, **kwargs: object) -> MailConfig:
    home = tmp_path / "home"
    return load_mail_config(
        repo_root=tmp_path / "repo",
        home=home,
        environ={},
        **kwargs,  # type: ignore[arg-type]
    )


class TestPriorityResolution:
    def test_explicit_path_wins_over_all_candidates(self, tmp_path: Path) -> None:
        explicit = write_config(tmp_path / "explicit.toml", minimal_config(provider="gmail"))
        write_config(tmp_path / "repo/config/mail.toml", minimal_config(provider="qq"))
        write_config(tmp_path / "home/.config/mail.toml", minimal_config(provider="qq"))
        config = load(tmp_path, explicit_path=explicit)
        assert config.provider == "gmail"
        assert config.source_path == explicit

    def test_environment_wins_over_repository(self, tmp_path: Path) -> None:
        env_config = write_config(tmp_path / "env.toml", minimal_config(provider="gmail"))
        write_config(tmp_path / "repo/config/mail.toml", minimal_config(provider="qq"))
        config = load_mail_config(
            repo_root=tmp_path / "repo",
            home=tmp_path / "home",
            environ={CONFIG_ENV_VAR: str(env_config)},
        )
        assert config.provider == "gmail"
        assert config.source_path == env_config

    def test_repository_wins_over_user_configs(self, tmp_path: Path) -> None:
        repository = write_config(tmp_path / "repo/config/mail.toml", minimal_config(provider="qq"))
        write_config(tmp_path / "home/.config/mail.toml", minimal_config(provider="gmail"))
        write_config(
            tmp_path / "home/.config/forgeloop/mail.toml", minimal_config(provider="gmail")
        )
        config = load(tmp_path)
        assert config.source_path == repository

    def test_user_forgeloop_wins_over_user_config(self, tmp_path: Path) -> None:
        """2026-10-18 实测修正：专用路径优先，主机通用的 ~/.config/mail.toml 只作兜底。"""

        write_config(tmp_path / "home/.config/mail.toml", minimal_config(provider="qq"))
        specific = write_config(
            tmp_path / "home/.config/forgeloop/mail.toml", minimal_config(provider="gmail")
        )
        config = load(tmp_path)
        assert config.source_path == specific and config.provider == "gmail"

    def test_user_forgeloop_used_when_alone(self, tmp_path: Path) -> None:
        path = write_config(
            tmp_path / "home/.config/forgeloop/mail.toml", minimal_config(provider="gmail")
        )
        config = load(tmp_path)
        assert config.source_path == path

    def test_candidates_are_ordered_high_to_low(self) -> None:
        candidates = config_candidates(
            repo_root=REPO,
            home=Path("/home/owner"),
            environ={CONFIG_ENV_VAR: "/env.toml"},
        )
        assert (
            [candidate.origin for candidate in candidates]
            == [
                "environment",
                "repository",
                "user_forgeloop",
                "user_config",
            ]
            == [
                "environment",
                "repository",
                # 2026-10-18 实测修正：专用路径优先（通用路径可能属于别的工具）。
                "user_forgeloop",
                "user_config",
            ]
        )
        assert candidates[0].path == Path("/env.toml")
        assert candidates[1].path == REPO / "config/mail.toml"
        assert candidates[2].path == Path("/home/owner/.config/forgeloop/mail.toml")
        assert candidates[3].path == Path("/home/owner/.config/mail.toml")


class TestFailClosed:
    def test_all_missing_reports_template_copy_hint(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError) as error:
            load(tmp_path)
        message = str(error.value)
        assert "config/mail.example.toml" in message
        assert "config/mail.toml" in message
        assert "cp " in message

    def test_explicit_missing_path_fails_without_fallback(self, tmp_path: Path) -> None:
        write_config(tmp_path / "repo/config/mail.toml", minimal_config())
        with pytest.raises(MailConfigurationError, match="--config"):
            load(tmp_path, explicit_path=tmp_path / "missing.toml")

    def test_invalid_toml_fails_loudly(self, tmp_path: Path) -> None:
        write_config(tmp_path / "repo/config/mail.toml", "provider = [unterminated\n")
        with pytest.raises(MailConfigurationError, match="无法读取或解析"):
            load(tmp_path)


class TestParsing:
    def test_minimal_document_applies_defaults(self, tmp_path: Path) -> None:
        config = parse_mail_config(
            {
                "provider": "QQ",
                "sender": "owner@example.com",
                "recipient": "to@example.com",
            },
            source_path=tmp_path / "mail.toml",
        )
        assert config.provider == "qq"
        assert config.subject_prefix == DEFAULT_SUBJECT_PREFIX
        assert config.folder == DEFAULT_FOLDER
        assert config.whitelist == ()
        assert config.auto_analyze is False

    def test_full_document_is_normalized(self, tmp_path: Path) -> None:
        config = parse_mail_config(
            {
                "provider": "gmail",
                "sender": "owner@example.com",
                "recipient": "to@example.com",
                "subject_prefix": " [ForgeLoop] ",
                "folder": "其他文件夹/FORGE_INBOX",
                "whitelist": [" Owner@Example.com ", "second@example.com"],
                "auto_analyze": True,
            },
            source_path=tmp_path / "mail.toml",
        )
        assert config.subject_prefix == "[ForgeLoop]"
        assert config.folder == "其他文件夹/FORGE_INBOX"
        assert config.whitelist == ("owner@example.com", "second@example.com")
        assert config.auto_analyze is True

    def test_unknown_key_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError, match="未知键"):
            parse_mail_config(
                {
                    "provider": "qq",
                    "sender": "owner@example.com",
                    "recipient": "to@example.com",
                    "unexpected": 1,
                },
                source_path=tmp_path / "mail.toml",
            )

    @pytest.mark.parametrize("missing", ["provider", "sender", "recipient"])
    def test_missing_required_key_is_rejected(self, tmp_path: Path, missing: str) -> None:
        document = {
            "provider": "qq",
            "sender": "owner@example.com",
            "recipient": "to@example.com",
        }
        document.pop(missing)
        with pytest.raises(MailConfigurationError, match="缺少必需键"):
            parse_mail_config(document, source_path=tmp_path / "mail.toml")

    def test_unknown_provider_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError, match="未知 provider"):
            parse_mail_config(
                {
                    "provider": "outlook",
                    "sender": "owner@example.com",
                    "recipient": "to@example.com",
                },
                source_path=tmp_path / "mail.toml",
            )

    def test_whitelist_must_be_a_string_list(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError, match="whitelist"):
            parse_mail_config(
                {
                    "provider": "qq",
                    "sender": "owner@example.com",
                    "recipient": "to@example.com",
                    "whitelist": "owner@example.com",
                },
                source_path=tmp_path / "mail.toml",
            )

    def test_auto_analyze_must_be_boolean(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError, match="auto_analyze"):
            parse_mail_config(
                {
                    "provider": "qq",
                    "sender": "owner@example.com",
                    "recipient": "to@example.com",
                    "auto_analyze": "yes",
                },
                source_path=tmp_path / "mail.toml",
            )

    def test_blank_subject_prefix_falls_back_to_default(self, tmp_path: Path) -> None:
        config = parse_mail_config(
            {
                "provider": "qq",
                "sender": "owner@example.com",
                "recipient": "to@example.com",
                "subject_prefix": "   ",
            },
            source_path=tmp_path / "mail.toml",
        )
        assert config.subject_prefix == DEFAULT_SUBJECT_PREFIX
