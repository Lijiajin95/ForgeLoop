"""邮件配置加载：按固定优先级逐层查找，全部缺失时 fail-closed。

优先级（高到低）：

1. 命令行的 ``--config <路径>``（显式指定，缺失即失败）
2. 环境变量 ``FORGELOOP_MAIL_CONFIG`` 指定的文件
3. ``<仓库>/config/mail.toml``
4. ``~/.config/mail.toml``
5. ``~/.config/forgeloop/mail.toml``

只提交不含真实值的模板 ``config/mail.example.toml``；生产配置进入
``.gitignore`` 或仓库外。本模块只依赖标准库与同层 ``ports``/``presets``。
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from forgeloop.mail.ports import MailConfigurationError
from forgeloop.mail.presets import PROVIDER_PRESETS

TEMPLATE_PATH = Path("config/mail.example.toml")
REPOSITORY_CONFIG_RELATIVE = Path("config/mail.toml")
USER_CONFIG_RELATIVE = Path(".config/mail.toml")
USER_FORGELOOP_CONFIG_RELATIVE = Path(".config/forgeloop/mail.toml")
CONFIG_ENV_VAR = "FORGELOOP_MAIL_CONFIG"

REQUIRED_KEYS = ("provider", "sender", "recipient")
OPTIONAL_KEYS = ("subject_prefix", "folder", "whitelist", "auto_analyze", "auto_reply")
KNOWN_KEYS = frozenset((*REQUIRED_KEYS, *OPTIONAL_KEYS))
DEFAULT_SUBJECT_PREFIX = "[ForgeLoop]"
DEFAULT_FOLDER = "INBOX"


@dataclass(frozen=True)
class ConfigCandidate:
    """一个配置候选来源：标签与具体路径。"""

    origin: str
    path: Path


@dataclass(frozen=True)
class MailConfig:
    """生效的邮件配置；``source_path`` 记录实际读取位置以便诊断。"""

    provider: str
    sender: str
    recipient: str
    source_path: Path
    subject_prefix: str = DEFAULT_SUBJECT_PREFIX
    folder: str = DEFAULT_FOLDER
    whitelist: tuple[str, ...] = ()
    auto_analyze: bool = False
    # 回信是否由系统自动发出（所有者 2026-10-19：回信不需要人工逐封确认）。
    auto_reply: bool = True


def config_candidates(
    *,
    repo_root: Path,
    home: Path,
    environ: Mapping[str, str] | None = None,
) -> tuple[ConfigCandidate, ...]:
    """按优先级从高到低列出配置候选（列表顺序即查找顺序）。"""

    env = os.environ if environ is None else environ
    candidates: list[ConfigCandidate] = []
    configured = env.get(CONFIG_ENV_VAR, "").strip()
    if configured:
        candidates.append(ConfigCandidate("environment", Path(configured).expanduser()))
    candidates.append(ConfigCandidate("repository", repo_root / REPOSITORY_CONFIG_RELATIVE))
    # 2026-10-18 实测修正：主机的通用 `~/.config/mail.toml` 可能属于别的工具（含 enabled/
    # from/… 等陌生键），因此 **ForgeLoop 专用路径优先**，通用路径只作为最后的兜底。
    candidates.append(ConfigCandidate("user_forgeloop", home / USER_FORGELOOP_CONFIG_RELATIVE))
    candidates.append(ConfigCandidate("user_config", home / USER_CONFIG_RELATIVE))
    return tuple(candidates)


def select_config(candidates: tuple[ConfigCandidate, ...]) -> ConfigCandidate:
    """返回第一个存在的候选；全部缺失时 fail-closed 并提示复制模板。"""

    for candidate in candidates:
        if candidate.path.is_file():
            return candidate
    searched = "\n".join(f"  - {candidate.path}" for candidate in candidates)
    copy_command = f"cp {TEMPLATE_PATH} {REPOSITORY_CONFIG_RELATIVE}"
    raise MailConfigurationError(
        f"未找到邮件配置，已按优先级查找：\n{searched}\n请复制模板并填写：{copy_command}"
    )


def parse_mail_config(document: Mapping[str, Any], *, source_path: Path) -> MailConfig:
    """校验并归一化配置文档；缺键、未知键或非法值一律拒绝。"""

    unknown = sorted(set(document) - KNOWN_KEYS)
    if unknown:
        joined = "、".join(unknown)
        raise MailConfigurationError(f"邮件配置包含未知键：{joined}（{source_path}）")
    missing = [key for key in REQUIRED_KEYS if not str(document.get(key, "")).strip()]
    if missing:
        joined = "、".join(missing)
        raise MailConfigurationError(f"邮件配置缺少必需键：{joined}（{source_path}）")
    provider = str(document["provider"]).strip().lower()
    if provider not in PROVIDER_PRESETS:
        known = "、".join(sorted(PROVIDER_PRESETS))
        raise MailConfigurationError(f"未知 provider：{provider!r}；首版仅支持 {known}")
    raw_whitelist = document.get("whitelist", [])
    if not isinstance(raw_whitelist, list) or not all(
        isinstance(item, str) for item in raw_whitelist
    ):
        raise MailConfigurationError(f"whitelist 必须是字符串列表（{source_path}）")
    auto_analyze = document.get("auto_analyze", False)
    if not isinstance(auto_analyze, bool):
        raise MailConfigurationError(f"auto_analyze 必须是布尔值（{source_path}）")
    auto_reply = document.get("auto_reply", True)
    if not isinstance(auto_reply, bool):
        raise MailConfigurationError(f"auto_reply 必须是布尔值（{source_path}）")
    subject_prefix = str(document.get("subject_prefix", DEFAULT_SUBJECT_PREFIX)).strip()
    folder = str(document.get("folder", DEFAULT_FOLDER)).strip()
    return MailConfig(
        provider=provider,
        sender=str(document["sender"]).strip(),
        recipient=str(document["recipient"]).strip(),
        source_path=source_path,
        subject_prefix=subject_prefix or DEFAULT_SUBJECT_PREFIX,
        folder=folder or DEFAULT_FOLDER,
        whitelist=tuple(item.strip().lower() for item in raw_whitelist),
        auto_analyze=auto_analyze,
        auto_reply=auto_reply,
    )


def load_mail_config(
    *,
    explicit_path: Path | None = None,
    repo_root: Path | None = None,
    home: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> MailConfig:
    """按优先级加载并解析邮件配置。

    ``explicit_path``（命令行 ``--config``）是用户显式指定，缺失即失败；
    其余候选按顺序取第一个存在的文件，全部缺失时 fail-closed。
    """

    env = os.environ if environ is None else environ
    root = Path.cwd() if repo_root is None else repo_root
    home_dir = Path.home() if home is None else home
    if explicit_path is not None:
        path = explicit_path.expanduser()
        if not path.is_file():
            raise MailConfigurationError(f"--config 指定的邮件配置不存在：{path}")
    else:
        return _load_first_usable(repo_root=root, home=home_dir, environ=env)
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise MailConfigurationError(f"邮件配置无法读取或解析：{path}（{error}）") from error
    return parse_mail_config(document, source_path=path)


def _load_first_usable(*, repo_root: Path, home: Path, environ: Mapping[str, str]) -> MailConfig:
    """按候选顺序取**第一个可用**的配置：陌生键/缺键等解析失败只跳过并继续。

    `--config` 与 `FORGELOOP_MAIL_CONFIG` 是显式指定，失败即拒绝（不静默换别的文件）；
    其余候选（仓库、`~/.config/forgeloop/mail.toml`、`~/.config/mail.toml`）可能属于
    别的工具或尚未填写，逐个尝试，全部不可用时汇总各自原因后 fail-closed。
    """

    problems: list[str] = []
    candidates = config_candidates(repo_root=repo_root, home=home, environ=environ)
    if candidates and candidates[0].origin == "environment":
        explicit = candidates[0].path
        if explicit.is_file():
            return load_mail_config(explicit_path=explicit, repo_root=repo_root, home=home)
        problems.append(f"环境变量指定的配置不可用：{explicit}")
        candidates = candidates[1:]
    existing = [candidate for candidate in candidates if candidate.path.is_file()]
    for candidate in existing:
        try:
            document = tomllib.loads(candidate.path.read_text(encoding="utf-8"))
            return parse_mail_config(document, source_path=candidate.path)
        except (OSError, tomllib.TOMLDecodeError) as error:
            problems.append(f"邮件配置无法读取或解析：{candidate.path}（{error}）")
        except MailConfigurationError as error:
            problems.append(f"{candidate.path}：{error}")
    if not existing:
        problems.append("未找到任何候选文件")
    searched = "\n".join(f"  - {problem}" for problem in problems)
    copy_command = f"cp {TEMPLATE_PATH} {REPOSITORY_CONFIG_RELATIVE}"
    raise MailConfigurationError(
        f"没有可用的邮件配置（逐个候选的结论）：\n{searched}\n请复制模板并填写：{copy_command}"
    )
