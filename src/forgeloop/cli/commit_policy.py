"""提交策略命令：解析生效策略并审计提交放行/拒绝。

限制位置是**客户端**：由本机提交策略（随仓库分发的 ``config/commit-policy.toml``
加上一份不进入版本控制的本地覆盖）决定，服务端不新增或放宽任何规则。本模块是
提交策略的唯一命令实现，``scripts/check_commit_policy.py`` 只是转发入口；
pre-commit/commit-msg 钩子与 CI 的历史审计都经过同一条路径。

审计输出对每次放行或拒绝都如实记录生效策略来源（仓库默认/本地覆盖）与机器
标签；拒绝时额外给出命中的时间窗，以及该时间窗来自仓库默认还是本地覆盖。文案
明确标注这是客户端限制，而不是服务端强制。
"""

import argparse
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.commit_policy import PolicyDocuments, load_policy_documents
from forgeloop.domain.commit_policy import (
    BlockedWindow,
    CommitDecision,
    CommitPolicy,
    CommitPolicySource,
    check_commit_time,
    effective_commit_policy,
    validate_commit_message,
)

# 仓库根：``src/forgeloop/cli/commit_policy.py`` 向上三级。
ROOT = Path(__file__).resolve().parents[3]
# 时间窗的来源只看这一项：本地覆盖整体替换它，未声明时才继承仓库默认。
WINDOW_KEY = "blocked_windows"
SOURCE_TEXT = {
    CommitPolicySource.REPOSITORY_DEFAULT: "repository default",
    CommitPolicySource.LOCAL_OVERRIDE: "local override",
}
# 客户端边界的固定表述，每次放行/拒绝都带出，避免被误读为服务端强制。
CLIENT_SIDE_NOTE = "client-side local policy; not server-enforced"


def source_text(source: CommitPolicySource) -> str:
    return SOURCE_TEXT[source]


def machine_text(label: str | None) -> str:
    return label if label else "(none)"


def window_text(window: BlockedWindow) -> str:
    return f"{window.start:%H:%M}-{window.end:%H:%M}"


class PolicyContext:
    """生效策略及其原始文档：用于区分命中时间窗来自默认还是本地覆盖。"""

    def __init__(self, policy: CommitPolicy, documents: PolicyDocuments) -> None:
        self.policy = policy
        self.documents = documents

    @property
    def blocked_window_source(self) -> CommitPolicySource:
        override = self.documents.override
        if override is not None and WINDOW_KEY in override:
            return CommitPolicySource.LOCAL_OVERRIDE
        return CommitPolicySource.REPOSITORY_DEFAULT


def load_policy_context(repo_root: Path = ROOT, *, home: Path | None = None) -> PolicyContext:
    """加载仓库默认与（可选）本地覆盖后的生效策略及其原始文档。"""

    documents = load_policy_documents(repo_root, home=home)
    policy = effective_commit_policy(documents.default, documents.override, documents.calendars)
    return PolicyContext(policy, documents)


def load_policy(repo_root: Path = ROOT, *, home: Path | None = None) -> CommitPolicy:
    """只返回生效策略的兼容入口（既有调用方与测试使用）。"""

    return load_policy_context(repo_root, home=home).policy


def hit_blocked_window(policy: CommitPolicy, moment: datetime) -> BlockedWindow | None:
    """命中的禁止时间窗；不在任何窗口内（如放行）返回 ``None``。"""

    local = moment.astimezone(policy.timezone)
    for window in policy.blocked_windows:
        if window.contains(local.time()):
            return window
    return None


def audit_context_text(context: PolicyContext) -> str:
    """放行/拒绝共有的审计字段：生效来源、机器标签与客户端边界。"""

    policy = context.policy
    return (
        f"effective policy {source_text(policy.source)}; "
        f"machine label {machine_text(policy.machine_label)}; {CLIENT_SIDE_NOTE}"
    )


def describe_decision(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    """一次判定的审计描述；拒绝时含命中时间窗及其来源。"""

    parts = [audit_context_text(context), f"decision {decision.reason}"]
    if not decision.allowed:
        window = hit_blocked_window(context.policy, moment)
        if window is not None:
            parts.insert(
                0,
                f"hit window {window_text(window)} ({source_text(context.blocked_window_source)})",
            )
    return "; ".join(parts)


def allow_line(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    return f"Commit allowed: {describe_decision(context, decision, moment)}"


def block_line(context: PolicyContext, decision: CommitDecision, moment: datetime) -> str:
    policy = context.policy
    windows = ", ".join(window_text(window) for window in policy.blocked_windows)
    authorized = window_text(policy.authorized_window)
    return (
        f"Commit blocked: {describe_decision(context, decision, moment)}; "
        f"{policy.timezone.key} workdays {windows}; owner-authorized commits are limited "
        f"to {authorized} on recorded dates."
    )


def check_now(context: PolicyContext) -> int:
    """按真实时钟判断当前时刻是否可提交，并输出审计信息。"""

    policy = context.policy
    moment = datetime.now(UTC)
    decision = check_commit_time(moment, policy)
    if not decision.allowed:
        print(block_line(context, decision, moment), file=sys.stderr)
        return 1
    print(allow_line(context, decision, moment))
    if decision.hint:
        year = moment.astimezone(policy.timezone).year
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
    """核对历史提交的作者/提交者时间与消息，逐条输出放行或拒绝审计。"""

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
            decision = check_commit_time(moment, policy)
            description = describe_decision(context, decision, moment)
            if decision.allowed:
                print(f"Allowed commit {sha[:12]}: {description}")
            else:
                print(f"Rejected commit {sha[:12]}: {description}", file=sys.stderr)
                valid = False
    return valid


def validate_config(context: PolicyContext) -> int:
    policy = context.policy
    print(
        f"Commit policy valid; effective policy {source_text(policy.source)}; "
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
