"""受控发布命令（S1）：创建并推送版本标签、固化发布回执、重复发布幂等。

流程（所有者 2026-10-12 决定把 CD 交付目标定为本机 Debian 设备）：
1. 幂等判定：同任务同标签重复执行不重复发布；换标签重复发布拒绝。
2. 前置判定（domain.release 纯规则）：已验收归并、标签与项目版本一致、
   main 未漂移、标签未被占用、候选 diff 校验值已固化。
3. 创建 annotated tag 并按需推送；推送触发 GitHub Release 构建与产物上传。
4. 写发布回执并固化记录；推送失败如实记录，不回滚本地标签（现场保留）。

标签身份即发布身份：部署端用回执里的 ``merge_commit`` 与 ``diff_sha256``
核对"同一份验收产物"，因此这里不做隐式版本递增，也不重新构建产物。
"""

import argparse
import json
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.git_workspace import (
    create_annotated_tag,
    list_tags,
    push_tag,
    read_main_head,
)
from forgeloop.cli.common import fail, open_store, records_root
from forgeloop.domain.approval import ApprovalStage
from forgeloop.domain.release import (
    ReleaseRecord,
    ReleaseRequest,
    check_release_readiness,
    check_repeat_release,
    sha256_of_text,
)
from forgeloop.records.store import RecordStore


class ReleaseRefused(RuntimeError):
    """发布前置不满足；由命令层转成统一失败输出。"""


@dataclass(frozen=True)
class _ReleasePlan:
    """通过前置判定后要固化的发布事实。"""

    project: Path
    merge_commit: str
    baseline_commit: str
    diff_sha256: str
    receipt_path: Path


def release_section(store: RecordStore, task_id: str) -> dict | None:
    """状态输出中的发布节（未发布时为 None）。"""

    release = store.outcomes.release_record(task_id)
    if release is None:
        return None
    return {
        "tag": release.tag,
        "merge_commit": release.merge_commit,
        "baseline_commit": release.baseline_commit,
        "diff_sha256": release.diff_sha256,
        "receipt_path": release.receipt_path,
        "pushed": release.pushed,
        "push_detail": release.push_detail,
        "released_at": release.released_at.isoformat(),
    }


def _project_version(project: Path) -> str:
    """读取项目声明的版本；标签必须与它一致，否则产物名与标签身份会脱节。"""

    pyproject = project / "pyproject.toml"
    if not pyproject.is_file():
        return ""
    try:
        document = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return ""
    project_table = document.get("project")
    if not isinstance(project_table, dict):
        return ""
    version = project_table.get("version")
    return version if isinstance(version, str) else ""


def _prepare_release(store: RecordStore, args: argparse.Namespace, root: Path) -> _ReleasePlan:
    """收集并校验发布前置；不满足时抛 ReleaseRefused，不写任何现场。"""

    task = store.get_task(args.task_id)
    merge = store.outcomes.merge_record(args.task_id)
    delivery = store.outcomes.delivery(args.task_id)
    if task is None or merge is None or delivery is None or store.latest_plan(args.task_id) is None:
        raise ReleaseRefused("任务尚无归并与交付记录，无法发布")
    project_path = task.config.get("project_path", "")
    if not project_path:
        raise ReleaseRefused("任务未绑定 project_path，无法发布")
    project = Path(project_path)
    digest = sha256_of_text(Path(delivery[0]).read_text(encoding="utf-8"))
    report = json.loads(Path(delivery[1]).read_text(encoding="utf-8"))
    acceptance = store.effective_approval(args.task_id, ApprovalStage.ACCEPTANCE)
    decision = check_release_readiness(
        ReleaseRequest(
            task_status=task.status,
            acceptance_recorded=acceptance is not None,
            merge_commit=merge[0],
            main_head=read_main_head(project),
            tag=args.tag,
            existing_tags=list_tags(project),
            diff_sha256=digest,
            project_version=_project_version(project),
        )
    )
    if not decision.allowed:
        raise ReleaseRefused(decision.reason)
    return _ReleasePlan(
        project=project,
        merge_commit=merge[0],
        baseline_commit=str(report.get("baseline_commit", "")),
        diff_sha256=digest,
        receipt_path=root / args.task_id / "release-receipt.json",
    )


def _receipt_document(record: ReleaseRecord) -> dict:
    """发布回执：部署端据此核对标签、归并提交与候选 diff 校验值。"""

    return {
        "task_id": record.task_id,
        "tag": record.tag,
        "merge_commit": record.merge_commit,
        "baseline_commit": record.baseline_commit,
        "diff_sha256": record.diff_sha256,
        "pushed": record.pushed,
        "push_detail": record.push_detail,
        "released_at": record.released_at.isoformat(),
        "artifact": {"source": "release-asset", "checksum_file": "SHA256SUMS"},
    }


def _publish_release(plan: _ReleasePlan, args: argparse.Namespace) -> ReleaseRecord:
    """创建标签、按需推送并写回执；推送失败如实记录但不撤销本地标签。"""

    message = args.message or f"chore(release): {args.tag}"
    create_annotated_tag(plan.project, args.tag, plan.merge_commit, message)
    pushed, push_detail = False, "未推送（--no-push）"
    if not args.no_push:
        pushed, push_detail = push_tag(plan.project, args.tag)
    record = ReleaseRecord(
        task_id=args.task_id,
        tag=args.tag,
        merge_commit=plan.merge_commit,
        baseline_commit=plan.baseline_commit,
        diff_sha256=plan.diff_sha256,
        receipt_path=str(plan.receipt_path),
        pushed=pushed,
        push_detail=push_detail,
        released_at=datetime.now(UTC),
    )
    plan.receipt_path.parent.mkdir(parents=True, exist_ok=True)
    plan.receipt_path.write_text(
        json.dumps(_receipt_document(record), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return record


def _print_release(record: ReleaseRecord) -> None:
    print(f"已发布 {record.tag}: 提交 {record.merge_commit}")
    print(f"候选 diff 校验值: {record.diff_sha256}")
    print(f"标签推送: {'成功' if record.pushed else '未推送'}")
    if record.push_detail and not record.pushed:
        print(f"推送详情: {record.push_detail}")
    print(f"发布回执: {record.receipt_path}")


def cmd_release(args: argparse.Namespace) -> int:
    """验收归并后的受控发布（S1）：创建并推送版本标签并固化回执。"""

    root = records_root(args)
    store = open_store(root, args.task_id)
    try:
        existing = store.outcomes.release_record(args.task_id)
        repeat = check_repeat_release(existing.tag if existing else None, args.tag)
        if not repeat.allowed:
            return fail(repeat.reason)
        if existing is not None:
            print(f"已发布 {existing.tag}（幂等：不重复创建或推送标签）。")
            print(f"发布回执: {existing.receipt_path}")
            return 0
        try:
            plan = _prepare_release(store, args, root)
        except ReleaseRefused as refusal:
            return fail(str(refusal))
        record = _publish_release(plan, args)
        store.outcomes.record_release(record)
        _print_release(record)
        return 0
    finally:
        store.close()
