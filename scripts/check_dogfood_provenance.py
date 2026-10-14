#!/usr/bin/env python3
"""DogFood 提交来源门禁（C04）：校验受控执行端签发的来源回执。

受控执行端（``forgeloop merge``）在合并提交的消息里附带
``ForgeLoop-Provenance: <base64url(载荷)>.<HMAC-SHA256>``。本脚本作为可信校验端：

1. 拒绝**普通直接提交**：提交消息没有回执；
2. 拒绝**补挂任务 ID**：只在消息里写任务 ID、没有受控执行端签名；
3. 拒绝**内容漂移**：回执绑定的候选 diff 校验值与提交实际内容不一致；
4. 拒绝**非授权更新**：签名密钥不对、回执字段不全、基线不是提交祖先或任务 ID
   不属于受控命名。

签名密钥从环境变量读取（见 ``config/dogfood-policy.toml``），只存在于受控执行端
与可信校验端，不进入实现 PI 的工作副本，因此 PI 无法自行签发或伪造证据。

当前策略 ``enabled = false``：服务端准入（仓库 ruleset）与限定写入身份尚未完成
验证，脚本只报告“待启用”并放行，不得据此声称来源门禁已生效。启用后缺密钥
fail-closed（拒绝放行）。用法与提交策略一致::

    python3 scripts/check_dogfood_provenance.py --audit <base> <head>
"""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from forgeloop.cli.merge import (
    ProvenancePolicy,
    decode_receipt,
    load_provenance_policy,
    receipt_values,
    validate_provenance_payload,
)
from forgeloop.domain.delivery import sha256_of_text

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = ROOT / "config" / "dogfood-policy.toml"


class GitError(RuntimeError):
    """读取 git 现场失败（仓库缺失、提交不存在或 git 不可用）。"""


@dataclass(frozen=True)
class Rejection:
    """一条被拒绝的提交及其原因。"""

    commit: str
    reason: str


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise GitError(result.stderr.strip()[:200] or f"git {' '.join(args)} failed")
    return result.stdout


def _resolve_commit(repo: Path, revision: str) -> str:
    return _git(repo, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}").strip()


def _is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    return result.returncode == 0


def commits_in_range(repo: Path, base: str, head: str) -> tuple[str, list[str]]:
    """返回（解析后的 head 提交号, 待校验提交列表）。

    base 为空或全零（新分支）时只校验 head 本身，不把已有历史重新判一遍；
    CI 侧会先把全零 base 解析成 origin/main 的 merge-base 再传入。
    """

    head_id = _resolve_commit(repo, head)
    if not base or set(base) == {"0"}:
        output = _git(repo, "log", "--format=%H", "-1", head_id)
    else:
        base_id = _resolve_commit(repo, base)
        output = _git(repo, "log", "--format=%H", f"{base_id}..{head_id}")
    return head_id, [line.strip() for line in output.splitlines() if line.strip()]


def verify_commit(repo: Path, policy: ProvenancePolicy, key: bytes, commit: str) -> str | None:
    """校验单个提交的来源回执；通过返回 None，拒绝返回原因。"""

    message = _git(repo, "show", "-s", "--format=%B", commit)
    values = receipt_values(message, policy.trailer_name)
    if not values:
        return "缺少来源回执：普通直接提交或补挂任务 ID 不被接受"
    if len(values) > 1:
        return "来源回执重复，来源不可信"
    payload, reason = decode_receipt(values[0], key)
    if payload is None:
        return reason
    valid, reason = validate_provenance_payload(policy, payload)
    if not valid:
        return reason
    baseline = str(payload["baseline_commit"])
    if not _is_ancestor(repo, baseline, commit):
        return f"回执基线 {baseline[:12]} 不是该提交的祖先；拒绝非受控更新"
    diff = _git(repo, "diff", "--no-color", baseline, commit)
    if sha256_of_text(diff) != payload["candidate_sha256"]:
        return "候选内容与回执不符（内容漂移）；拒绝"
    return None


def audit(
    repo: Path, policy: ProvenancePolicy, key: bytes, base: str, head: str
) -> list[Rejection]:
    """校验 base..head 范围内的每个提交，返回全部拒绝项。"""

    _head_id, commits = commits_in_range(repo, base, head)
    rejections: list[Rejection] = []
    for commit in commits:
        reason = verify_commit(repo, policy, key, commit)
        if reason is not None:
            rejections.append(Rejection(commit, reason))
    return rejections


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY, help="来源策略 TOML")
    parser.add_argument("--repo", type=Path, default=ROOT, help="待校验的 git 仓库")
    parser.add_argument("--audit", nargs=2, metavar=("BASE", "HEAD"), required=True)
    args = parser.parse_args()
    try:
        policy = load_provenance_policy(args.policy)
    except (OSError, ValueError) as error:
        print(f"DogFood 来源门禁策略读取失败: {error}", file=sys.stderr)
        return 1
    if not policy.enabled:
        print(
            "DogFood 来源门禁未启用（待服务端准入与限定写入身份验证）；跳过校验。",
            file=sys.stderr,
        )
        return 0
    key_text = os.environ.get(policy.signing_key_env, "")
    if not key_text:
        print(
            f"DogFood 来源门禁已启用，但缺少签名密钥 {policy.signing_key_env}；拒绝放行。",
            file=sys.stderr,
        )
        return 1
    base, head = args.audit
    try:
        rejections = audit(args.repo, policy, key_text.encode("utf-8"), base, head)
    except GitError as error:
        print(f"DogFood 来源门禁无法读取提交范围: {error}", file=sys.stderr)
        return 1
    for rejection in rejections:
        print(f"Rejected commit {rejection.commit[:12]}: {rejection.reason}", file=sys.stderr)
    if rejections:
        print(f"DogFood 来源门禁拒绝 {len(rejections)} 个提交。", file=sys.stderr)
        return 1
    print("DogFood 来源门禁通过：范围内提交均有受控来源回执。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
