"""口令候选状态的单元测试：顺序、状态分类、权限与保密。

覆盖 ``forgeloop.mail.secret`` 的公共行为：
- 候选顺序为 ``FORGELOOP_MAIL_SECRET`` 指定文件 > 仓库
  ``.cache/forgeloop/mail-secret`` > ``~/.config/forgeloop/mail-secret``
  > ``~/Library/Application Support/ForgeLoop/mail-secret``
  > ``FORGELOOP_SMTP_USER``/``FORGELOOP_SMTP_PASSWORD``；
- 逐个候选报告 可用/不存在/是目录/不可读/权限不合规；
- 权限非 600 拒绝使用，全部不可用时给出可复制创建命令且不回显口令。
"""

from pathlib import Path

import pytest

from forgeloop.mail.ports import MailConfigurationError
from forgeloop.mail.secret import (
    MACOS_SECRET_RELATIVE,
    REPOSITORY_SECRET_RELATIVE,
    SECRET_ENV_VAR,
    SMTP_PASSWORD_ENV_VAR,
    SMTP_USER_ENV_VAR,
    USER_SECRET_RELATIVE,
    SecretCandidate,
    SecretCandidateKind,
    SecretStatus,
    creation_command,
    inspect_candidate,
    parse_secret_content,
    resolve_secret,
    secret_candidates,
)


def write_secret(path: Path, text: str, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)
    return path


def resolve(tmp_path: Path, **kwargs: object):
    return resolve_secret(
        repo_root=tmp_path / "repo",
        home=tmp_path / "home",
        environ={},
        default_account="fallback@example.com",
        **kwargs,
    )


class TestCandidateOrder:
    def test_order_without_env_pointer(self) -> None:
        candidates = secret_candidates(
            repo_root=Path("/repo"), home=Path("/home/owner"), environ={}
        )
        assert [candidate.kind for candidate in candidates] == [
            SecretCandidateKind.REPOSITORY,
            SecretCandidateKind.USER,
            SecretCandidateKind.MACOS,
            SecretCandidateKind.ENVIRONMENT,
        ]
        assert candidates[0].path == Path("/repo") / REPOSITORY_SECRET_RELATIVE
        assert candidates[1].path == Path("/home/owner") / USER_SECRET_RELATIVE
        assert candidates[2].path == Path("/home/owner") / MACOS_SECRET_RELATIVE
        assert candidates[3].path is None

    def test_env_pointer_is_first(self) -> None:
        candidates = secret_candidates(
            repo_root=Path("/repo"),
            home=Path("/home/owner"),
            environ={SECRET_ENV_VAR: "/custom/secret"},
        )
        assert candidates[0].kind is SecretCandidateKind.ENV_FILE
        assert candidates[0].path == Path("/custom/secret")


class TestStatusClassification:
    def test_missing_file(self, tmp_path: Path) -> None:
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", tmp_path / "absent")
        report = inspect_candidate(candidate)
        assert report.status is SecretStatus.MISSING
        assert report.available is False

    def test_directory(self, tmp_path: Path) -> None:
        directory = tmp_path / "as-directory"
        directory.mkdir()
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", directory)
        report = inspect_candidate(candidate)
        assert report.status is SecretStatus.IS_DIRECTORY

    def test_insecure_permissions(self, tmp_path: Path) -> None:
        path = write_secret(tmp_path / "secret", "owner@example.com\nS3CRET\n", mode=0o644)
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", path)
        report = inspect_candidate(candidate)
        assert report.status is SecretStatus.INSECURE_PERMISSIONS
        assert report.permission == 0o644
        assert report.available is False

    def test_available_file(self, tmp_path: Path) -> None:
        path = write_secret(tmp_path / "secret", "owner@example.com\nS3CRET\n")
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", path)
        report = inspect_candidate(candidate)
        assert report.status is SecretStatus.AVAILABLE
        assert report.permission == 0o600
        assert report.available is True

    def test_empty_file_is_unreadable(self, tmp_path: Path) -> None:
        path = write_secret(tmp_path / "secret", "   \n")
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", path)
        assert inspect_candidate(candidate).status is SecretStatus.UNREADABLE

    def test_read_failure_is_unreadable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = write_secret(tmp_path / "secret", "owner@example.com\nS3CRET\n")

        def deny(self: Path, *args: object, **kwargs: object) -> str:
            raise PermissionError("denied")

        monkeypatch.setattr(Path, "read_text", deny)
        candidate = SecretCandidate(SecretCandidateKind.REPOSITORY, "repo", path)
        report = inspect_candidate(candidate)
        assert report.status is SecretStatus.UNREADABLE
        assert "denied" in (report.detail or "")

    def test_environment_candidate_status(self) -> None:
        candidate = SecretCandidate(SecretCandidateKind.ENVIRONMENT, "env")
        both = {SMTP_USER_ENV_VAR: "owner@example.com", SMTP_PASSWORD_ENV_VAR: "S3CRET"}
        assert inspect_candidate(candidate, both).status is SecretStatus.AVAILABLE
        only_user = {SMTP_USER_ENV_VAR: "owner@example.com"}
        report = inspect_candidate(candidate, only_user)
        assert report.status is SecretStatus.MISSING
        assert SMTP_PASSWORD_ENV_VAR in (report.detail or "")
        assert inspect_candidate(candidate, {}).status is SecretStatus.MISSING


class TestResolution:
    def test_repository_file_two_lines(self, tmp_path: Path) -> None:
        write_secret(
            tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE,
            "owner@example.com\nS3CRET\n",
        )
        resolution = resolve(tmp_path)
        assert resolution.account == "owner@example.com"
        assert resolution.secret.reveal() == "S3CRET"
        assert resolution.source is SecretCandidateKind.REPOSITORY
        assert resolution.reports[-1].candidate.kind is SecretCandidateKind.ENVIRONMENT

    def test_one_line_uses_default_account(self, tmp_path: Path) -> None:
        write_secret(tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE, "S3CRET\n")
        resolution = resolve(tmp_path)
        assert resolution.account == "fallback@example.com"
        assert resolution.secret.reveal() == "S3CRET"

    def test_one_line_without_default_account_fails(self, tmp_path: Path) -> None:
        write_secret(tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE, "S3CRET\n")
        with pytest.raises(MailConfigurationError, match="未提供账号"):
            resolve_secret(
                repo_root=tmp_path / "repo",
                home=tmp_path / "home",
                environ={},
                default_account=None,
            )

    def test_env_pointer_file_wins(self, tmp_path: Path) -> None:
        pointer = write_secret(tmp_path / "custom" / "secret", "custom@example.com\nENV\n")
        write_secret(tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE, "repo@example.com\nREPO\n")
        resolution = resolve_secret(
            repo_root=tmp_path / "repo",
            home=tmp_path / "home",
            environ={SECRET_ENV_VAR: str(pointer)},
            default_account="fallback@example.com",
        )
        assert resolution.account == "custom@example.com"
        assert resolution.secret.reveal() == "ENV"
        assert resolution.source is SecretCandidateKind.ENV_FILE

    def test_missing_env_pointer_falls_through_with_report(self, tmp_path: Path) -> None:
        write_secret(tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE, "repo@example.com\nREPO\n")
        resolution = resolve_secret(
            repo_root=tmp_path / "repo",
            home=tmp_path / "home",
            environ={SECRET_ENV_VAR: str(tmp_path / "absent")},
            default_account="fallback@example.com",
        )
        assert resolution.source is SecretCandidateKind.REPOSITORY
        reports = {report.candidate.kind: report.status for report in resolution.reports}
        assert reports[SecretCandidateKind.ENV_FILE] is SecretStatus.MISSING
        assert reports[SecretCandidateKind.REPOSITORY] is SecretStatus.AVAILABLE

    def test_insecure_high_priority_file_is_skipped(self, tmp_path: Path) -> None:
        write_secret(
            tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE,
            "insecure@example.com\nINSECURE\n",
            mode=0o644,
        )
        write_secret(tmp_path / "home" / USER_SECRET_RELATIVE, "user@example.com\nUSER\n")
        resolution = resolve(tmp_path)
        assert resolution.account == "user@example.com"
        assert resolution.source is SecretCandidateKind.USER
        statuses = {report.candidate.kind: report.status for report in resolution.reports}
        assert statuses[SecretCandidateKind.REPOSITORY] is SecretStatus.INSECURE_PERMISSIONS

    def test_environment_fallback_is_last_resort(self, tmp_path: Path) -> None:
        resolution = resolve_secret(
            repo_root=tmp_path / "repo",
            home=tmp_path / "home",
            environ={
                SMTP_USER_ENV_VAR: "env@example.com",
                SMTP_PASSWORD_ENV_VAR: "ENV",
            },
        )
        assert resolution.account == "env@example.com"
        assert resolution.secret.reveal() == "ENV"
        assert resolution.source is SecretCandidateKind.ENVIRONMENT

    def test_all_unavailable_reports_every_candidate_and_command(self, tmp_path: Path) -> None:
        with pytest.raises(MailConfigurationError) as error:
            resolve(tmp_path)
        message = str(error.value)
        assert "不存在" in message
        assert "chmod 600" in message
        assert "printf" in message
        assert creation_command(tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE) in message

    def test_failure_never_echoes_secret_value(self, tmp_path: Path) -> None:
        write_secret(
            tmp_path / "repo" / REPOSITORY_SECRET_RELATIVE,
            "insecure@example.com\nTOP-SECRET-VALUE\n",
            mode=0o644,
        )
        with pytest.raises(MailConfigurationError) as error:
            resolve(tmp_path)
        assert "TOP-SECRET-VALUE" not in str(error.value)


class TestParseSecretContent:
    def test_two_lines(self) -> None:
        account, secret = parse_secret_content("a@example.com\nSECRET\n", default_account=None)
        assert account == "a@example.com"
        assert secret.reveal() == "SECRET"

    def test_one_line_uses_default_account(self) -> None:
        account, secret = parse_secret_content("SECRET\n", default_account="a@example.com")
        assert account == "a@example.com"
        assert secret.reveal() == "SECRET"

    def test_blank_lines_are_ignored(self) -> None:
        account, secret = parse_secret_content(
            "\n a@example.com \n\n SECRET \n", default_account=None
        )
        assert account == "a@example.com"
        assert secret.reveal() == "SECRET"

    def test_empty_content_is_rejected(self) -> None:
        with pytest.raises(MailConfigurationError, match="口令文件为空"):
            parse_secret_content("\n \n", default_account="a@example.com")
