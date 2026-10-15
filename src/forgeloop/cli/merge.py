"""受控归并命令（B04）：验收交付后把候选 diff 归并到 main 并同步远程。

两条流程（S3 方案 B，所有者 2026-10-13 选定）：

- **候选分支流程**（有远程时的默认）：候选分支 ``forgeloop/<task>`` → 推送 →
  匿名等待必需检查通过 → 快进 main → 推送 main → 删除候选分支。检查未通过或
  超时：main 不动、候选分支保留供核对、如实报告。
- **直接流程**（``--no-push`` 或 ``--direct-push``）：在 main 上生成合并提交并按需
  推送，即原 B04 行为；启用分支保护后不要再用直接推送落地交付。

检查状态对公开仓库匿名可读，全程不需要凭据；证据写入 ``merge-evidence.json``。

C04 提交来源：受控执行端在合并提交消息里追加签名回执
trailer（``ForgeLoop-Provenance``），绑定任务、方案版本、基线、候选内容与验收材料。
签名密钥只从环境变量读取（见 ``config/dogfood-policy.toml``），不进入 PI 可写的
候选副本；``scripts/check_dogfood_provenance.py`` 作为可信校验端验证来源。
"""

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import sys
import time
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.deployment import remote_slug
from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    create_candidate_branch,
    delete_branch,
    fast_forward_main,
    has_remote,
    merge_candidate_to_main,
    push_branch,
    push_main,
    read_main_head,
    switch_to_main,
)
from forgeloop.adapter.github_checks import ChecksError, check_runs, github_token
from forgeloop.cli.common import fail, open_store, records_root
from forgeloop.domain.approval import ApprovalStage
from forgeloop.domain.delivery import DeliveryBinding
from forgeloop.domain.merge import (
    ChecksDecision,
    candidate_branch_name,
    check_acceptance_content,
    check_merge_readiness,
    check_required_checks,
)
from forgeloop.graph.dispatch import (
    DEFAULT_DELIVERY_TIMEOUT_SECONDS,
    ProjectDeliveryBusyError,
    project_delivery,
    project_delivery_slot,
)
from forgeloop.records.store import RecordStore

CHECK_POLL_SECONDS = 30.0
CHECK_POLL_MAX_SECONDS = 300.0
DEFAULT_REQUIRE_CHECKS = "quality,security,commit-policy"
DEFAULT_CHECKS_TIMEOUT = 1800.0

POLICY_PATH = Path(__file__).resolve().parents[3] / "config" / "dogfood-policy.toml"
PROVENANCE_SCHEMA = 1
PROVENANCE_FIELDS = (
    "schema",
    "task_id",
    "requirement_id",
    "plan_version",
    "baseline_commit",
    "candidate_sha256",
    "test_evidence_sha256",
    "review_sha256",
    "approval_fingerprint",
)
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class _MergeContext:
    """一次归并需要的现场事实（避免把长参数表在命令间传递）。"""

    project: Path
    baseline: str
    diff_text: str
    message: str
    task_dir: Path


def merge_section(store: RecordStore, task_id: str) -> dict | None:
    """状态输出中的归并节（无归并记录时为 None）。"""

    merge = store.outcomes.merge_record(task_id)
    if merge is None:
        return None
    merge_commit, pushed, push_detail, merged_at = merge
    return {
        "merge_commit": merge_commit,
        "pushed": pushed,
        "push_detail": push_detail,
        "merged_at": merged_at.isoformat(),
    }


def _required_checks(raw: str) -> tuple[str, ...]:
    """解析必需检查名；``none``（或空）表示不等待任何检查。"""

    if raw.strip().lower() in ("", "none"):
        return ()
    return tuple(name.strip() for name in raw.split(",") if name.strip())


@dataclass(frozen=True)
class ProvenancePolicy:
    """DogFood 提交来源策略（C04）：从 config/dogfood-policy.toml 读取。

    ``enabled`` 为假时校验端只报告“待启用”，不阻断；服务端准入与限定写入身份
    单独验证，未完成前不得声称来源门禁已生效。
    """

    enabled: bool
    signing_key_env: str
    trailer_name: str
    task_id_prefix: str
    required_fields: tuple[str, ...]


DEFAULT_PROVENANCE_POLICY = ProvenancePolicy(
    enabled=False,
    signing_key_env="FORGELOOP_DOGFOOD_SIGNING_KEY",
    trailer_name="ForgeLoop-Provenance",
    task_id_prefix="task-",
    required_fields=PROVENANCE_FIELDS,
)


def load_provenance_policy(path: Path | None = None) -> ProvenancePolicy:
    """读取来源策略；文件缺失时返回禁用默认值（不猜测启用）。"""

    target = path or POLICY_PATH
    if not target.is_file():
        return DEFAULT_PROVENANCE_POLICY
    document = tomllib.loads(target.read_text(encoding="utf-8"))
    enabled = document.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("dogfood-policy: enabled 必须是布尔值")
    trailer_name = document.get("trailer_name", DEFAULT_PROVENANCE_POLICY.trailer_name)
    task_id_prefix = document.get("task_id_prefix", DEFAULT_PROVENANCE_POLICY.task_id_prefix)
    signing_key_env = document.get("signing_key_env", DEFAULT_PROVENANCE_POLICY.signing_key_env)
    for value, label in (
        (trailer_name, "trailer_name"),
        (task_id_prefix, "task_id_prefix"),
        (signing_key_env, "signing_key_env"),
    ):
        if not isinstance(value, str) or not value:
            raise ValueError(f"dogfood-policy: {label} 必须是非空字符串")
    raw_fields = document.get("required_fields", list(PROVENANCE_FIELDS))
    if not isinstance(raw_fields, list):
        raise ValueError("dogfood-policy: required_fields 必须是字符串列表")
    fields: list[str] = []
    for field in raw_fields:
        if not isinstance(field, str) or not field:
            raise ValueError("dogfood-policy: required_fields 必须是非空字符串列表")
        fields.append(field)
    return ProvenancePolicy(
        enabled=enabled,
        signing_key_env=signing_key_env,
        trailer_name=trailer_name,
        task_id_prefix=task_id_prefix,
        required_fields=tuple(fields),
    )


def resolve_signing_key(policy: ProvenancePolicy) -> bytes | None:
    """从环境变量解析签发密钥；未配置时返回 None（不读取仓库内文件）。"""

    value = os.environ.get(policy.signing_key_env, "")
    return value.encode("utf-8") if value else None


def canonical_payload(payload: Mapping[str, object]) -> bytes:
    """回执载荷的规范序列化：键排序、紧凑分隔、ASCII，保证签名可复算。"""

    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def sign_payload(payload: Mapping[str, object], key: bytes) -> str:
    """生成 trailer 值：base64url(载荷) + '.' + HMAC-SHA256 十六进制。"""

    raw = canonical_payload(payload)
    digest = hmac.new(key, raw, hashlib.sha256).hexdigest()
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{encoded}.{digest}"


def receipt_values(message: str, trailer_name: str) -> list[str]:
    """取出提交消息里的全部回执 trailer 值（用于拒绝缺失与重复）。"""

    prefix = f"{trailer_name}:"
    collected: list[str] = []
    for line in message.splitlines():
        if line.startswith(prefix):
            collected.append(line[len(prefix) :].strip())
    return collected


def decode_receipt(value: str, key: bytes) -> tuple[dict[str, object] | None, str]:
    """校验回执签名并解析载荷；失败返回原因，不做任何乐观放行。"""

    encoded, separator, digest = value.rpartition(".")
    if not separator or not encoded or not digest:
        return None, "来源回执格式错误"
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (ValueError, binascii.Error):
        return None, "来源回执编码错误"
    expected = hmac.new(key, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, digest):
        return None, "来源回执签名无效（非受控执行端或已被篡改）"
    try:
        payload = json.loads(raw)
    except ValueError:
        return None, "来源回执内容不是合法 JSON"
    if not isinstance(payload, dict):
        return None, "来源回执内容形态异常"
    return {str(name): item for name, item in payload.items()}, ""


def validate_provenance_payload(
    policy: ProvenancePolicy, payload: Mapping[str, object]
) -> tuple[bool, str]:
    """校验回执字段完整性与受控身份；与 git 内容核对分开，便于单元测试。"""

    missing = [name for name in policy.required_fields if name not in payload]
    if missing:
        return False, "来源回执缺少字段：" + "、".join(missing)
    task_id = payload.get("task_id")
    if not isinstance(task_id, str) or not task_id.startswith(policy.task_id_prefix):
        return False, "来源回执任务 ID 不属于受控命名（疑似补挂任务 ID）"
    plan_version = payload.get("plan_version")
    if not isinstance(plan_version, int) or isinstance(plan_version, bool) or plan_version < 1:
        return False, "来源回执方案版本无效"
    baseline = payload.get("baseline_commit")
    if not isinstance(baseline, str) or not COMMIT_PATTERN.match(baseline):
        return False, "来源回执基线提交号格式错误"
    digest_fields = (
        "candidate_sha256",
        "test_evidence_sha256",
        "review_sha256",
        "approval_fingerprint",
    )
    for field in digest_fields:
        value = payload.get(field)
        if not isinstance(value, str) or not DIGEST_PATTERN.match(value):
            return False, f"来源回执 {field} 校验值缺失或格式错误"
    return True, ""


def build_provenance_payload(
    binding: DeliveryBinding, requirement_id: str, baseline_commit: str
) -> dict[str, object]:
    """由验收材料绑定构造回执载荷；基线取实际归并基线。"""

    return {
        "schema": PROVENANCE_SCHEMA,
        "task_id": binding.task_id,
        "requirement_id": requirement_id,
        "plan_version": binding.plan_version,
        "baseline_commit": baseline_commit,
        "candidate_sha256": binding.candidate_sha256,
        "test_evidence_sha256": binding.test_evidence_sha256,
        "review_sha256": binding.review_sha256,
        "approval_fingerprint": binding.fingerprint,
    }


def attach_provenance(
    message: str, policy: ProvenancePolicy, payload: Mapping[str, object]
) -> tuple[str, str]:
    """把来源回执追加到合并提交消息；返回（消息, 失败原因）。

    密钥只存在于受控执行端与可信校验端的环境变量里，不在仓库或候选可写路径，
    因此实现 PI 无法自行签发或伪造回执。策略启用但缺密钥时 fail-closed，
    拒绝生成未签名提交。
    """

    key = resolve_signing_key(policy)
    if key is None:
        if policy.enabled:
            return message, (
                f"来源门禁已启用但缺少签名密钥环境变量 {policy.signing_key_env}；拒绝生成未签名提交"
            )
        return message, ""
    trailer = f"{policy.trailer_name}: {sign_payload(payload, key)}"
    return f"{message}\n\n{trailer}\n", ""


def _write_evidence(task_dir: Path, evidence: dict) -> None:
    """归并证据落盘（流程、候选分支、检查与推送结果），便于回查。"""

    task_dir.mkdir(parents=True, exist_ok=True)
    document = dict(evidence)
    document["recorded_at"] = datetime.now(UTC).isoformat()
    (task_dir / "merge-evidence.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def check_poll_delay(attempt: int, base: float) -> float:
    """第 attempt 次轮询前的等待秒数：线性退避到上限。

    匿名读取 GitHub 检查状态只有 60 次/小时的配额；固定 30s 轮询一次最长 1800s 的归并
    会发约 60 次请求，正好耗尽配额（实测首轮归并就在 403 rate limit exceeded 后超时放弃）。
    退避后同一次归并约 10-15 次请求。测试把 base 设为 0 表示不等待。
    """

    if base <= 0:
        return 0.0
    return min(base * max(attempt, 1), CHECK_POLL_MAX_SECONDS)


def _format_reset(value: str) -> str:
    """把 ``X-RateLimit-Reset`` 的 epoch 秒转为可读 UTC 时间；非数字原样返回。"""

    try:
        epoch = int(value)
    except ValueError:
        return value
    return datetime.fromtimestamp(epoch, UTC).isoformat()


def rate_limit_reason(error: ChecksError) -> str | None:
    """识别 403 速率限制并给出可诊断原因；非限流错误返回 ``None``。

    GitHub 在配额耗尽时返回 403：主配额带 ``X-RateLimit-Remaining: 0``，次级限流
    常带 ``Retry-After``。只有这些明确信号（或错误文本显式点明 rate limit）才判为
    限流；权限不足等普通 403 与其它网络错误保持既有语义，不在此快速失败。
    """

    cause = error.__cause__
    headers = getattr(cause, "headers", None)
    status = getattr(cause, "code", None)
    limited_by_header = (
        status == 403
        and headers is not None
        and (headers.get("X-RateLimit-Remaining") == "0" or bool(headers.get("Retry-After")))
    )
    limited_by_text = "rate limit" in f"{error} {cause}".lower()
    if not limited_by_header and not limited_by_text:
        return None
    parts = [
        "GitHub 检查状态读取触发速率限制",
        "本次为匿名读取" if github_token() is None else "本次为认证读取",
    ]
    if headers is not None:
        limit = headers.get("X-RateLimit-Limit")
        reset = headers.get("X-RateLimit-Reset")
        retry_after = headers.get("Retry-After")
        if limit:
            parts.append(f"限额 {limit}")
        if reset:
            parts.append(f"复位时间 {reset}（{_format_reset(reset)}）")
        if retry_after:
            parts.append(f"Retry-After {retry_after}s")
    parts.append("立即失败，不再等待检查")
    return "；".join(parts)


def _wait_for_checks(
    slug: str, sha: str, required: tuple[str, ...], timeout_seconds: float
) -> tuple[ChecksDecision, dict]:
    """轮询检查：通过/失败立即返回，未完成继续等，网络错误重试，超时如实报告。

    403 速率限制是例外：它是配额已耗尽的确定性信号，继续轮询只会持续空转并
    放大限流，因此在第一次出现时立即失败，并附上是否匿名、限额与复位时间。
    """

    deadline = time.monotonic() + timeout_seconds
    polls = 0
    last_runs: dict[str, str] = {}
    last = ChecksDecision(False, True, "尚未取得检查状态")
    while True:
        polls += 1
        try:
            last_runs = check_runs(slug, sha)
        except ChecksError as error:
            reason = rate_limit_reason(error)
            if reason is not None:
                return ChecksDecision(False, False, reason), {
                    "polls": polls,
                    "last_runs": last_runs,
                    "rate_limited": True,
                }
            last = ChecksDecision(False, True, f"检查状态读取失败：{error}")
        else:
            last = check_required_checks(required, last_runs)
            if not last.pending:
                return last, {"polls": polls, "last_runs": last_runs}
        if time.monotonic() >= deadline:
            reason = f"等待检查超时（{timeout_seconds:.0f}s）：{last.reason}"
            return ChecksDecision(False, last.pending, reason), {
                "polls": polls,
                "last_runs": last_runs,
            }
        time.sleep(check_poll_delay(polls, CHECK_POLL_SECONDS))


def _checks_outcome(
    args: argparse.Namespace, slug: str, sha: str, required: tuple[str, ...]
) -> tuple[ChecksDecision, dict]:
    if not required:
        return ChecksDecision(True, False, "未要求必需检查"), {"polls": 0, "last_runs": {}}
    return _wait_for_checks(slug, sha, required, args.checks_timeout)


def _abandon(context: _MergeContext, evidence: dict, reason: str, branch: str) -> int:
    """未落地时的统一收尾：回到 main、保留候选分支、写证据并如实报告。"""

    switch_to_main(context.project)
    _write_evidence(context.task_dir, evidence)
    print(f"FAIL: {reason}", file=sys.stderr)
    print(f"main 未更新；候选分支保留供核对：{branch}", file=sys.stderr)
    print(
        f"核对后可清理：git push origin --delete {branch} && git branch -D {branch}",
        file=sys.stderr,
    )
    return 1


class _Abandoned(Exception):
    """必须保留现场并如实报告的情形（携带证据、原因与候选分支）。"""

    def __init__(self, evidence: dict, reason: str, branch: str) -> None:
        super().__init__(reason)
        self.evidence = evidence
        self.reason = reason
        self.branch = branch


def _start_candidate(args: argparse.Namespace, context: _MergeContext) -> tuple[str, dict]:
    """创建并推送候选分支；任何未落地情形抛 ``_Abandoned``。"""

    branch = candidate_branch_name(args.task_id)
    evidence = {
        "task_id": args.task_id,
        "flow": "candidate-branch",
        "branch": branch,
        "required_checks": list(_required_checks(args.require_checks)),
    }
    try:
        candidate = create_candidate_branch(
            context.project, branch, context.baseline, context.diff_text, context.message
        )
    except WorkspaceError as error:
        raise _Abandoned(evidence, str(error), branch) from error
    pushed, push_detail = push_branch(context.project, branch)
    evidence.update(
        {"candidate_commit": candidate, "branch_pushed": pushed, "branch_push_detail": push_detail}
    )
    if not pushed:
        evidence["result"] = "candidate_push_failed"
        raise _Abandoned(evidence, f"候选分支推送失败：{push_detail}", branch)
    return candidate, evidence


def _finish_landing(
    args: argparse.Namespace,
    store: RecordStore,
    context: _MergeContext,
    branch: str,
    evidence: dict,
) -> int:
    """快进后的落地：推送 main、删除候选分支、写记录与证据并汇报。"""

    merge_commit = read_main_head(context.project)
    main_pushed, main_detail = push_main(context.project)
    deleted, delete_detail = delete_branch(
        context.project, branch, remote="origin" if main_pushed else None
    )
    reason = str(evidence.get("checks", {}).get("reason", ""))
    store.outcomes.record_merge(
        args.task_id, merge_commit, main_pushed, f"via {branch}；{reason}；{main_detail[:160]}"
    )
    store.set_task_status(args.task_id, "merged")
    evidence.update(
        {
            "result": "merged",
            "main_commit": merge_commit,
            "main_pushed": main_pushed,
            "main_push_detail": main_detail,
            "branch_deleted": deleted,
            "branch_delete_detail": delete_detail,
        }
    )
    _write_evidence(context.task_dir, evidence)
    print(f"已归并 main: {merge_commit}")
    print(f"候选分支: {branch}（{'已删除' if deleted else '保留'}）")
    print(f"检查: {reason}")
    print(f"推送: {'成功' if main_pushed else '未推送'}")
    if not main_pushed:
        print(f"推送详情: {main_detail}")
    return 0


def _merge_via_branch(args: argparse.Namespace, store: RecordStore, context: _MergeContext) -> int:
    """候选分支流程：检查在候选分支上通过后再快进 main，最后清理候选分支。"""

    slug = remote_slug(context.project)
    if slug is None:
        return fail("无法从 origin 解析 GitHub owner/name；候选分支流程需要等待检查")
    branch = candidate_branch_name(args.task_id)
    try:
        candidate, evidence = _start_candidate(args, context)
    except _Abandoned as abandoned:
        return _abandon(context, abandoned.evidence, abandoned.reason, abandoned.branch)
    required = _required_checks(args.require_checks)
    decision, checks_evidence = _checks_outcome(args, slug, candidate, required)
    evidence["checks"] = {
        "required": list(required),
        "passed": decision.passed,
        "reason": decision.reason,
        **checks_evidence,
    }
    if not decision.passed:
        evidence["result"] = "checks_not_passed"
        return _abandon(context, evidence, decision.reason, branch)
    try:
        fast_forward_main(context.project, branch)
    except WorkspaceError as error:
        evidence["result"] = "fast_forward_failed"
        return _abandon(context, evidence, str(error), branch)
    return _finish_landing(args, store, context, branch, evidence)


def _merge_direct(args: argparse.Namespace, store: RecordStore, context: _MergeContext) -> int:
    """直接流程：在 main 上生成合并提交并按需推送（原 B04 行为）。"""

    try:
        merge_commit = merge_candidate_to_main(
            context.project, context.baseline, context.diff_text, context.message
        )
    except WorkspaceError as error:
        return fail(str(error))
    pushed, push_detail = False, ""
    if not args.no_push and has_remote(context.project):
        pushed, push_detail = push_main(context.project)
    store.outcomes.record_merge(args.task_id, merge_commit, pushed, push_detail)
    store.set_task_status(args.task_id, "merged")
    print(f"已归并 main: {merge_commit}")
    print(f"推送: {'成功' if pushed else '未推送'}")
    if push_detail and not pushed:
        print(f"推送详情: {push_detail}")
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    """验收后受控归并 main（B04）：绑定基线与 diff，漂移拒绝，未验收不更新。"""

    root = records_root(args)
    store = open_store(root, args.task_id)
    try:
        task = store.get_task(args.task_id)
        assert task is not None
        slot_key = project_delivery_slot(task.project)
        # 获取交付互斥前先按权威进程身份处理残留：只有已死占用者自动清理并继续，
        # 存活或不确定一律不清理，把具体原因留给下面的等待与失败报告。
        residue = store.actions.cleanup_slot_residue(slot_key)
        if residue.cleaned:
            print(
                f"已自动清理已死残留交付槽位 {slot_key}：{residue.assessment.reason}",
                file=sys.stderr,
            )
        try:
            # 同项目交付整体串行：检查—归并—推送在同一互斥内，避免两个同项目需求
            # 同时读到旧 main 再各自快进/推送。
            with project_delivery(root, task.project, timeout=args.delivery_timeout):
                return _merge_locked(args, store, root)
        except ProjectDeliveryBusyError as error:
            hint = ""
            if not residue.cleaned and residue.assessment.occupant is not None:
                hint = f"；残留判定：{residue.assessment.reason}"
            return fail(f"{error}{hint}")
    finally:
        store.close()


def _merge_locked(args: argparse.Namespace, store: RecordStore, root: Path) -> int:
    """持有同项目交付互斥后的归并主体（调用方保证已取得项目槽位）。"""

    task = store.get_task(args.task_id)
    assert task is not None
    delivery = store.outcomes.delivery(args.task_id)
    plan = store.latest_plan(args.task_id)
    if delivery is None or plan is None:
        return fail("任务尚无交付记录，无法归并")
    diff_text = Path(delivery[0]).read_text(encoding="utf-8")
    report = json.loads(Path(delivery[1]).read_text(encoding="utf-8"))
    baseline = str(report.get("baseline_commit", ""))
    project_path = task.config.get("project_path", "")
    if not project_path:
        return fail("任务未绑定 project_path，无法归并")
    project = Path(project_path)
    acceptance = store.effective_approval(args.task_id, ApprovalStage.ACCEPTANCE)
    binding = acceptance.binding if acceptance is not None else None
    decision = check_merge_readiness(
        task.status, acceptance is not None, baseline, read_main_head(project), diff_text
    )
    if not decision.allowed:
        return fail(decision.reason)
    current = store.capture_delivery_binding(args.task_id, plan.version)
    if acceptance is not None:
        if binding is None:
            return fail("验收批准缺少交付材料绑定；无法核对同一候选，拒绝归并")
        content = check_acceptance_content(binding, current)
        if not content.allowed:
            return fail(content.reason)
    message = args.message or f"feat: {plan.goal}"
    if len(message.splitlines()[0]) > 100:
        message = message.splitlines()[0][:97] + "..."
    payload = build_provenance_payload(
        current, str(task.config.get("requirement_id", "")), baseline
    )
    message, provenance_error = attach_provenance(message, load_provenance_policy(), payload)
    if provenance_error:
        return fail(provenance_error)
    context = _MergeContext(
        project=project,
        baseline=baseline,
        diff_text=diff_text,
        message=message,
        task_dir=root / args.task_id,
    )
    if has_remote(project) and not args.no_push and not args.direct_push:
        return _merge_via_branch(args, store, context)
    return _merge_direct(args, store, context)


def add_merge_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    """注册 merge 子命令；解析器装配留在命令模块内，避免入口膨胀。"""

    merge = subparsers.add_parser("merge", help="验收后受控归并 main 并同步远程（B04）")
    merge.add_argument("task_id")
    merge.add_argument("--message", default="", help="合并提交消息（缺省 feat: 任务目标）")
    merge.add_argument("--no-push", action="store_true", help="只归并本地 main，不推送远程")
    merge.add_argument(
        "--direct-push",
        action="store_true",
        help="直接推送 main（跳过候选分支与检查等待；未启用分支保护时才可用）",
    )
    merge.add_argument(
        "--require-checks",
        default=DEFAULT_REQUIRE_CHECKS,
        help="等待通过的必需检查名（逗号分隔；none 表示不等待）",
    )
    merge.add_argument(
        "--checks-timeout",
        type=float,
        default=DEFAULT_CHECKS_TIMEOUT,
        help="等待检查的超时秒数（超时后 main 不动、候选分支保留）",
    )
    merge.add_argument(
        "--delivery-timeout",
        type=float,
        default=DEFAULT_DELIVERY_TIMEOUT_SECONDS,
        help="等待同项目交付互斥的上限秒数（超时拒绝，不并发更新主干）",
    )
    merge.add_argument("--records-root", default=default_records_root)
    merge.set_defaults(func=cmd_merge)
