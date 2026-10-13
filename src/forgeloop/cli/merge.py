"""受控归并命令（B04）：验收交付后把候选 diff 归并到 main 并同步远程。

两条流程（S3 方案 B，所有者 2026-10-13 选定）：

- **候选分支流程**（有远程时的默认）：候选分支 ``forgeloop/<task>`` → 推送 →
  匿名等待必需检查通过 → 快进 main → 推送 main → 删除候选分支。检查未通过或
  超时：main 不动、候选分支保留供核对、如实报告。
- **直接流程**（``--no-push`` 或 ``--direct-push``）：在 main 上生成合并提交并按需
  推送，即原 B04 行为；启用分支保护后不要再用直接推送落地交付。

检查状态对公开仓库匿名可读，全程不需要凭据；证据写入 ``merge-evidence.json``。
"""

import argparse
import json
import sys
import time
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
from forgeloop.adapter.github_checks import ChecksError, check_runs
from forgeloop.cli.common import fail, open_store, records_root
from forgeloop.domain.approval import ApprovalStage
from forgeloop.domain.merge import (
    ChecksDecision,
    candidate_branch_name,
    check_merge_readiness,
    check_required_checks,
)
from forgeloop.records.store import RecordStore

CHECK_POLL_SECONDS = 30.0
DEFAULT_REQUIRE_CHECKS = "quality,security,commit-policy"
DEFAULT_CHECKS_TIMEOUT = 1800.0


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


def _write_evidence(task_dir: Path, evidence: dict) -> None:
    """归并证据落盘（流程、候选分支、检查与推送结果），便于回查。"""

    task_dir.mkdir(parents=True, exist_ok=True)
    document = dict(evidence)
    document["recorded_at"] = datetime.now(UTC).isoformat()
    (task_dir / "merge-evidence.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _wait_for_checks(
    slug: str, sha: str, required: tuple[str, ...], timeout_seconds: float
) -> tuple[ChecksDecision, dict]:
    """轮询检查：通过/失败立即返回，未完成继续等，网络错误重试，超时如实报告。"""

    deadline = time.monotonic() + timeout_seconds
    polls = 0
    last_runs: dict[str, str] = {}
    last = ChecksDecision(False, True, "尚未取得检查状态")
    while True:
        polls += 1
        try:
            last_runs = check_runs(slug, sha)
        except ChecksError as error:
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
        time.sleep(CHECK_POLL_SECONDS)


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
        decision = check_merge_readiness(
            task.status, acceptance is not None, baseline, read_main_head(project), diff_text
        )
        if not decision.allowed:
            return fail(decision.reason)
        message = args.message or f"feat: {plan.goal}"
        if len(message.splitlines()[0]) > 100:
            message = message.splitlines()[0][:97] + "..."
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
    finally:
        store.close()


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
    merge.add_argument("--records-root", default=default_records_root)
    merge.set_defaults(func=cmd_merge)
