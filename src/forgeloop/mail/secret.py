"""口令候选解析与逐候选状态报告。

候选顺序（高到低）：

1. 环境变量 ``FORGELOOP_MAIL_SECRET`` 指定的文件
2. ``<仓库>/.cache/forgeloop/mail-secret``（推荐）
3. ``~/.config/forgeloop/mail-secret``
4. ``~/Library/Application Support/ForgeLoop/mail-secret``
5. 环境变量 ``FORGELOOP_SMTP_USER`` / ``FORGELOOP_SMTP_PASSWORD``（备选）

文件内容为两行（第 1 行账号、第 2 行口令）或一行（仅口令，账号取自配置的
``sender``）。文件权限必须为 600，否则该候选拒绝使用。失败时逐个报告候选
状态并给出可直接复制的创建命令；任何输出都不回显口令。

本模块只依赖标准库与同层 ``ports``。
"""

from __future__ import annotations

import os
import shlex
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from forgeloop.mail.ports import MailConfigurationError, Secret

SECRET_ENV_VAR = "FORGELOOP_MAIL_SECRET"
SMTP_USER_ENV_VAR = "FORGELOOP_SMTP_USER"
SMTP_PASSWORD_ENV_VAR = "FORGELOOP_SMTP_PASSWORD"

REQUIRED_PERMISSION = 0o600
REPOSITORY_SECRET_RELATIVE = Path(".cache/forgeloop/mail-secret")
USER_SECRET_RELATIVE = Path(".config/forgeloop/mail-secret")
MACOS_SECRET_RELATIVE = Path("Library/Application Support/ForgeLoop/mail-secret")


class SecretCandidateKind(StrEnum):
    """口令候选来源类型。"""

    ENV_FILE = "env_file"
    REPOSITORY = "repository"
    USER = "user"
    MACOS = "macos"
    ENVIRONMENT = "environment"


class SecretStatus(StrEnum):
    """单个口令候选的检查状态。"""

    AVAILABLE = "available"
    MISSING = "missing"
    IS_DIRECTORY = "is_directory"
    UNREADABLE = "unreadable"
    INSECURE_PERMISSIONS = "insecure_permissions"


STATUS_LABELS: Mapping[SecretStatus, str] = {
    SecretStatus.AVAILABLE: "可用",
    SecretStatus.MISSING: "不存在",
    SecretStatus.IS_DIRECTORY: "是目录",
    SecretStatus.UNREADABLE: "不可读",
    SecretStatus.INSECURE_PERMISSIONS: "权限不合规",
}


@dataclass(frozen=True)
class SecretCandidate:
    """一个口令候选；环境变量候选没有文件路径。"""

    kind: SecretCandidateKind
    label: str
    path: Path | None = None

    @property
    def display_path(self) -> str:
        return self.label if self.path is None else str(self.path)


@dataclass(frozen=True)
class SecretCandidateReport:
    """一个候选的检查结果。"""

    candidate: SecretCandidate
    status: SecretStatus
    detail: str | None = None
    permission: int | None = None

    @property
    def available(self) -> bool:
        return self.status is SecretStatus.AVAILABLE


@dataclass(frozen=True)
class SecretResolution:
    """解析结果：账号、口令、来源与全部候选状态。"""

    account: str
    secret: Secret
    source: SecretCandidateKind
    reports: tuple[SecretCandidateReport, ...]


def secret_candidates(
    *,
    repo_root: Path,
    home: Path,
    environ: Mapping[str, str] | None = None,
) -> tuple[SecretCandidate, ...]:
    """按优先级从高到低列出口令候选。"""

    env = os.environ if environ is None else environ
    candidates: list[SecretCandidate] = []
    specified = env.get(SECRET_ENV_VAR, "").strip()
    if specified:
        candidates.append(
            SecretCandidate(
                SecretCandidateKind.ENV_FILE,
                f"{SECRET_ENV_VAR} 指定的文件",
                Path(specified).expanduser(),
            )
        )
    candidates.append(
        SecretCandidate(
            SecretCandidateKind.REPOSITORY,
            "仓库缓存 .cache/forgeloop/mail-secret",
            repo_root / REPOSITORY_SECRET_RELATIVE,
        )
    )
    candidates.append(
        SecretCandidate(
            SecretCandidateKind.USER,
            "~/.config/forgeloop/mail-secret",
            home / USER_SECRET_RELATIVE,
        )
    )
    candidates.append(
        SecretCandidate(
            SecretCandidateKind.MACOS,
            "~/Library/Application Support/ForgeLoop/mail-secret",
            home / MACOS_SECRET_RELATIVE,
        )
    )
    candidates.append(
        SecretCandidate(
            SecretCandidateKind.ENVIRONMENT,
            f"环境变量 {SMTP_USER_ENV_VAR}/{SMTP_PASSWORD_ENV_VAR}",
        )
    )
    return tuple(candidates)


def inspect_candidate(
    candidate: SecretCandidate,
    environ: Mapping[str, str] | None = None,
) -> SecretCandidateReport:
    """检查一个候选并返回状态；只读元数据与内容，不返回口令本身。"""

    env = os.environ if environ is None else environ
    if candidate.kind is SecretCandidateKind.ENVIRONMENT:
        return _inspect_environment(candidate, env)
    path = candidate.path
    if path is None:  # pragma: no cover - 由构造函数保证
        return SecretCandidateReport(candidate, SecretStatus.MISSING)
    try:
        if not path.exists():
            return SecretCandidateReport(candidate, SecretStatus.MISSING)
        if path.is_dir():
            return SecretCandidateReport(candidate, SecretStatus.IS_DIRECTORY)
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as error:
        return SecretCandidateReport(candidate, SecretStatus.UNREADABLE, detail=str(error))
    if mode != REQUIRED_PERMISSION:
        return SecretCandidateReport(
            candidate,
            SecretStatus.INSECURE_PERMISSIONS,
            detail=f"权限为 {mode:o}，必须为 600",
            permission=mode,
        )
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return SecretCandidateReport(candidate, SecretStatus.UNREADABLE, detail=str(error))
    if not text.strip():
        return SecretCandidateReport(
            candidate, SecretStatus.UNREADABLE, detail="口令文件为空", permission=mode
        )
    return SecretCandidateReport(candidate, SecretStatus.AVAILABLE, permission=mode)


def _inspect_environment(
    candidate: SecretCandidate,
    environ: Mapping[str, str],
) -> SecretCandidateReport:
    user = environ.get(SMTP_USER_ENV_VAR, "").strip()
    password = environ.get(SMTP_PASSWORD_ENV_VAR, "")
    if user and password:
        return SecretCandidateReport(candidate, SecretStatus.AVAILABLE)
    present = [
        name
        for name, value in (
            (SMTP_USER_ENV_VAR, user),
            (SMTP_PASSWORD_ENV_VAR, password),
        )
        if value
    ]
    absent = [name for name in (SMTP_USER_ENV_VAR, SMTP_PASSWORD_ENV_VAR) if name not in present]
    detail = f"缺少 {'、'.join(absent)}" if absent else "环境变量为空"
    return SecretCandidateReport(candidate, SecretStatus.MISSING, detail=detail)


def parse_secret_content(text: str, *, default_account: str | None) -> tuple[str, Secret]:
    """解析口令文件内容：两行取账号+口令，一行只取口令。"""

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise MailConfigurationError("口令文件为空")
    if len(lines) >= 2:
        account, secret_value = lines[0], lines[1]
    else:
        account, secret_value = (default_account or "").strip(), lines[0]
    if not account:
        raise MailConfigurationError("口令来源未提供账号，且配置未给出 sender")
    if not secret_value:
        raise MailConfigurationError("口令文件缺少口令")
    return account, Secret(secret_value)


def creation_command(path: Path) -> str:
    """给出可直接复制执行的创建命令，使用占位符而非真实口令。"""

    quoted = shlex.quote(str(path))
    parent = shlex.quote(str(path.parent))
    return (
        f"mkdir -p {parent} && "
        f"printf '%s\\n%s\\n' '账号' '授权码或应用专用密码' > {quoted} && "
        f"chmod 600 {quoted}"
    )


def _render_reports(reports: tuple[SecretCandidateReport, ...]) -> str:
    lines: list[str] = []
    for report in reports:
        label = STATUS_LABELS[report.status]
        detail = f"（{report.detail}）" if report.detail else ""
        lines.append(f"  [{label}] {report.candidate.display_path}{detail}")
    return "\n".join(lines)


def resolve_secret(
    *,
    repo_root: Path,
    home: Path,
    environ: Mapping[str, str] | None = None,
    default_account: str | None = None,
) -> SecretResolution:
    """按顺序解析口令：返回第一个可用候选，全部不可用时 fail-closed。"""

    env = os.environ if environ is None else environ
    reports: list[SecretCandidateReport] = []
    selected: SecretCandidateReport | None = None
    for candidate in secret_candidates(repo_root=repo_root, home=home, environ=env):
        report = inspect_candidate(candidate, env)
        reports.append(report)
        if report.available and selected is None:
            selected = report
    if selected is not None:
        account, secret = _read_candidate_value(selected.candidate, env, default_account)
        return SecretResolution(
            account=account,
            secret=secret,
            source=selected.candidate.kind,
            reports=tuple(reports),
        )
    recommended = repo_root / REPOSITORY_SECRET_RELATIVE
    raise MailConfigurationError(
        "未找到可用的邮件口令，候选状态：\n"
        f"{_render_reports(tuple(reports))}\n"
        f"请创建权限为 600 的口令文件：{creation_command(recommended)}"
    )


def _read_candidate_value(
    candidate: SecretCandidate,
    environ: Mapping[str, str],
    default_account: str | None,
) -> tuple[str, Secret]:
    if candidate.kind is SecretCandidateKind.ENVIRONMENT:
        account = environ.get(SMTP_USER_ENV_VAR, "").strip()
        return account, Secret(environ.get(SMTP_PASSWORD_ENV_VAR, ""))
    path = candidate.path
    if path is None:  # pragma: no cover - 由构造函数保证
        raise MailConfigurationError("口令候选缺少文件路径")
    return parse_secret_content(path.read_text(encoding="utf-8"), default_account=default_account)
