"""提交策略命令：解析生效配置并审计提交放行/拒绝。

生效配置只有一份来源：**本机配置文件**（仓库内 ``.cache/forgeloop/commit-policy.toml``
或用户级 ``~/.config/forgeloop/commit-policy.toml``，二选一），仓库只发布模板
``config/commit-policy.template.toml``。**没有生效配置时不执行提交时间禁止**：命令
放行但在输出里显式标注"未强制"，不把"没有规则"读成"检查通过"；配置存在而损坏、
年历目录缺失时仍然拒绝（失败关闭）。限制位置是客户端，服务端不新增或放宽任何规则。

本模块是提交策略的唯一命令实现，``scripts/check_commit_policy.py`` 只是转发入口；
pre-commit/commit-msg 钩子与 CI 的历史审计都经过同一条路径。审计输出对每次放行或
拒绝都如实记录生效配置路径、机器标签与判定原因；拒绝时额外给出命中的时间窗。
"""

import argparse
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.commit_policy import (
    POLICY_CONFIG_RELATIVES,
    PolicyDocuments,
    load_policy_documents,
)
from forgeloop.domain.commit_policy import (
    POLICY_ABSENT_REASON,
    BlockedWindow,
    CommitDecision,
    CommitPolicy,
    check_commit_time,
    effective_commit_policy,
    policy_absent_decision,
    validate_commit_message,
)

# 仓库根：``src/forgeloop/cli/commit_policy.py`` 向上三级。
ROOT = Path(__file__).resolve().parents[3]
# 客户端边界的固定表述，每次放行/拒绝都带出，避免被误读为服务端强制。
CLIENT_SIDE_NOTE = "client-side local policy; not server-enforced"
# 未强制时的固定说明：判定原因 ``policy_absent`` 的人类可读补充。
NOT_ENFORCED_NOTE = "commit time restriction NOT enforced (no local config)"
# 安装说明：两个候选路径来自 adapter，避免文档与实现各写一份；
# 用户级路径按惯例写成 ``~/…``，避免被读成仓库内相对路径。
REPOSITORY_INSTALL_PATH, USER_INSTALL_PATH = POLICY_CONFIG_RELATIVES
INSTALL_PATHS = f"{REPOSITORY_INSTALL_PATH} or ~/{USER_INSTALL_PATH}"


def machine_text(label: str | None) -> str:
    return label if label else "(none)"


def window_text(window: BlockedWindow) -> str:
    return f"{window.start:%H:%M}-{window.end:%H:%M}"


class PolicyContext:
    """生效策略（可能缺失）及其原始文档：用于审计配置来源。"""

    def __init__(self, policy: CommitPolicy | None, documents: PolicyDocuments) -> None:
        self.policy = policy
        self.documents = documents

    @property
    def config_text(self) -> str:
        """生效配置的审计文本：路径与来源，或明确说明没有配置。"""

        if self.documents.config_path is None:
            return "absent (no local config)"
        origin = f" {self.documents.origin}" if self.documents.origin else ""
        return f"{self.documents.config_path}{origin}"


def load_policy_context(repo_root: Path = ROOT, *, home: Path | None = None) -> PolicyContext:
    """加载本机生效配置（可能缺失）及其原始文档。"""

    documents = load_policy_documents(repo_root, home=home)
    if not documents.has_policy:
        return PolicyContext(None, documents)
    assert documents.config is not None  # has_policy 已保证
    policy = effective_commit_policy(documents.config, documents.calendars)
    return PolicyContext(policy, documents)


def load_policy(repo_root: Path = ROOT, *, home: Path | None = None) -> CommitPolicy | None:
    """只返回生效策略的兼容入口（既有调用方与测试使用）；无配置时为 ``None``。"""

    return load_policy_context(repo_root, home=home).policy


def hit_blocked_window(policy: CommitPolicy, moment: datetime) -> BlockedWindow | None:
    """命中的禁止时间窗；不在任何窗口内（如放行）返回 ``None``。"""

    local = moment.astimezone(policy.timezone)
    for window in policy.blocked_windows:
        if window.contains(local.time()):
            return window
    return None


def audit_context_text(context: PolicyContext) -> str:
    """放行/拒绝共有的审计字段：生效配置、机器标签与客户端边界。"""

    policy = context.policy
    label = policy.machine_label if policy is not None else None
    return (
        f"effective policy {context.config_text}; "
        f"machine label {machine_text(label)}; {CLIENT_SIDE_NOTE}"
    )


def describe_decision(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    """一次判定的审计描述；拒绝时含命中时间窗，未强制时含固定说明。"""

    parts = [audit_context_text(context), f"decision {decision.reason}"]
    policy = context.policy
    if not decision.allowed and policy is not None:
        window = hit_blocked_window(policy, moment)
        if window is not None:
            parts.insert(0, f"hit window {window_text(window)}")
    if decision.allowed and decision.reason == POLICY_ABSENT_REASON:
        parts.append(NOT_ENFORCED_NOTE)
    return "; ".join(parts)


def allow_line(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    return f"Commit allowed: {describe_decision(context, decision, moment)}"


def block_line(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    policy = context.policy
    assert policy is not None  # 只有生效策略才会拒绝
    windows = ", ".join(window_text(window) for window in policy.blocked_windows)
    authorized = window_text(policy.authorized_window)
    return (
        f"Commit blocked: {describe_decision(context, decision, moment)}; "
        f"{policy.timezone.key} workdays {windows}; owner-authorized commits are limited "
        f"to {authorized} on recorded dates."
    )


def check_now(context: PolicyContext) -> int:
    """按真实时钟判断当前时刻是否可提交，并输出审计信息。"""

    moment = datetime.now(UTC)
    if context.policy is None:
        print(allow_line(context, policy_absent_decision(), moment))
        return 0
    decision = check_commit_time(moment, context.policy)
    if not decision.allowed:
        print(block_line(context, decision, moment), file=sys.stderr)
        return 1
    print(allow_line(context, decision, moment))
    if decision.hint:
        year = moment.astimezone(context.policy.timezone).year
        print(f"Maintain the workday calendar for {year}.", file=sys.stderr)
    return 0


def resolve_revision(revision: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", result) is None:
        raise ValueError("Git returned an invalid commit ID")
    return result


def audit(base: str, head: str, context: PolicyContext) -> bool:
    """核对历史提交的作者/提交者时间与消息，逐条输出放行或拒绝审计。

    消息头语法与配置无关，始终校验；时间维度在没有生效配置时记为
    ``policy_absent`` 并显式标注未强制。
    """

    policy = context.policy
    head_id = resolve_revision(head)
    target = head_id if not base or set(base) == {"0"} else f"{resolve_revision(base)}..{head_id}"
    log = subprocess.run(
        ["git", "log", "--format=%H%x00%aI%x00%cI%x00%s", target],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    valid = True
    for line in log.splitlines():
        sha, author_time, committer_time, subject = line.split("\0")
        try:
            validate_commit_message(subject)
        except ValueError as error:
            print(
                f"Rejected commit {sha[:12]}: message {error}; {audit_context_text(context)}",
                file=sys.stderr,
            )
            valid = False
            continue
        for value in (author_time, committer_time):
            moment = datetime.fromisoformat(value)
            decision = (
                policy_absent_decision() if policy is None else check_commit_time(moment, policy)
            )
            description = describe_decision(context, decision, moment)
            if decision.allowed:
                print(f"Allowed commit {sha[:12]}: {description}")
            else:
                print(f"Rejected commit {sha[:12]}: {description}", file=sys.stderr)
                valid = False
    return valid


def validate_config(context: PolicyContext) -> int:
    policy = context.policy
    if policy is None:
        print(
            "No commit policy configured; commit time restriction NOT enforced "
            f"({CLIENT_SIDE_NOTE}); install the template config at {INSTALL_PATHS} to enable it."
        )
        return 0
    print(
        f"Commit policy valid; effective policy {context.config_text}; "
        f"machine label {machine_text(policy.machine_label)}; "
        f"maintained years: {sorted(policy.calendars)}; "
        f"authorized batches: {sorted(policy.authorized_dates)}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-now", action="store_true")
    mode.add_argument("--message", type=Path)
    mode.add_argument("--audit", nargs=2, metavar=("BASE", "HEAD"))
    mode.add_argument("--validate-config", action="store_true")
    args = parser.parse_args(argv)
    try:
        context = load_policy_context()
        if args.check_now:
            return check_now(context)
        if args.message is not None:
            validate_commit_message(args.message.read_text(encoding="utf-8"))
            return 0
        if args.audit is not None:
            base, head = args.audit
            return 0 if audit(base, head, context) else 1
        return validate_config(context)
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f"Commit policy check failed: {error}", file=sys.stderr)
        return 1


# 供测试与转发入口直接引用的公开入口。
__all__ = [
    "CLIENT_SIDE_NOTE",
    "NOT_ENFORCED_NOTE",
    "PolicyContext",
    "allow_line",
    "audit",
    "audit_context_text",
    "block_line",
    "check_now",
    "describe_decision",
    "hit_blocked_window",
    "load_policy",
    "load_policy_context",
    "main",
    "resolve_revision",
    "validate_config",
    "window_text",
]
