"""受控发布命令（S1）：创建并推送版本标签、固化发布回执、重复发布幂等。

流程（所有者 2026-10-12 决定把 CD 交付目标定为本机 Debian 设备）：
1. 幂等判定：同任务同标签重复执行不重复发布；换标签重复发布拒绝。
2. 前置判定（domain.release 纯规则）：已验收归并、标签与项目版本一致、
   main 未漂移、标签未被占用、候选 diff 校验值已固化，且 C01 已验收产物原件可用。
3. 创建 annotated tag 并推送；把已验收产物原件上传为该标签的草稿 Release 资产。
4. Release 工作流只下载并核对这份产物，不在标签工作流重新构建。
5. 写发布回执并固化记录；推送失败如实记录，不回滚本地标签（现场保留）。

标签身份即发布身份：部署端用回执里的 ``merge_commit``、``diff_sha256`` 与
``artifact_sha256`` 核对"同一份验收产物"；因此这里不做隐式版本递增，也不重新构建产物。
"""

import argparse
import json
import subprocess
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.deployment import sha256_of_file
from forgeloop.adapter.git_workspace import (
    create_annotated_tag,
    list_tags,
    push_tag,
    read_main_head,
    tag_commit,
)
from forgeloop.cli.common import fail, open_store, records_root
from forgeloop.domain.approval import ApprovalStage
from forgeloop.domain.merge import check_acceptance_content
from forgeloop.domain.release import (
    ReleaseRecord,
    ReleaseRequest,
    check_release_artifact,
    check_release_readiness,
    check_release_retry,
    sha256_of_text,
)
from forgeloop.graph.dispatch import (
    ProjectDeliveryBusyError,
    project_delivery,
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
    wheel_name: str
    artifact_sha256: str
    artifact_path: Path
    receipt_path: Path


def _read_receipt(path: Path) -> dict:
    """读取发布/候选产物回执 JSON；缺失或损坏时返回空字典（如实当作未知）。"""

    if not path.is_file():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return document if isinstance(document, dict) else {}


def _candidate_artifact(task_dir: Path) -> dict:
    """读取 C01 候选产物回执；缺失或损坏时返回空字典。"""

    return _read_receipt(task_dir / "candidate-artifact.json")


def _current_artifact_sha256(task_dir: Path) -> str:
    """当前候选产物回执里的校验值；未知时返回空串。"""

    digest = _candidate_artifact(task_dir).get("sha256", "")
    return digest if isinstance(digest, str) else ""


def _accepted_artifact(task_dir: Path, version: str, merge_commit: str) -> tuple[str, str]:
    """校验 C01 候选产物是同一份可复现、已冒烟且绑定归并提交的产物。

    返回（wheel 文件名，产物校验值）；不满足时抛 ``ReleaseRefused``，不写任何现场。
    """

    document = _candidate_artifact(task_dir)
    if not document:
        raise ReleaseRefused(
            "缺少已构建的候选产物回执（candidate-artifact.json）；"
            "先运行 forgeloop candidate 构建并验证候选产物再发布"
        )
    if document.get("reproducible") is not True:
        raise ReleaseRefused("候选产物不可复现（两次构建不一致）；拒绝发布")
    smoke = document.get("smoke_exit_code")
    if smoke != 0:
        raise ReleaseRefused(f"候选产物独立环境冒烟未通过（exit {smoke}）；拒绝发布")
    commit = document.get("commit")
    if commit != merge_commit:
        raise ReleaseRefused(
            f"候选产物提交 {str(commit)[:12]} 与归并提交 {merge_commit[:12]} 不一致；拒绝发布"
        )
    if document.get("version") != version:
        raise ReleaseRefused(
            f"候选产物版本 {document.get('version') or '未知'} 与标签版本 {version} 不一致；拒绝发布"
        )
    wheel_name = document.get("wheel_name")
    digest = document.get("sha256")
    if not isinstance(wheel_name, str) or not isinstance(digest, str):
        raise ReleaseRefused("候选产物回执缺少 wheel 文件名或校验值；拒绝发布")
    wheel = task_dir / "artifacts" / wheel_name
    if not wheel.is_file():
        raise ReleaseRefused(f"候选产物原件缺失：{wheel}；拒绝发布")
    actual = sha256_of_file(wheel)
    if actual != digest:
        raise ReleaseRefused(
            f"候选产物原件校验值不符：记录 {digest[:12]}，实际 {actual[:12]}；拒绝发布"
        )
    return wheel_name, digest


def _tag_identity(plan: _ReleasePlan) -> str:
    """标签注解必须携带的已验收产物身份行（发布工作流据此核对同一产物）。"""

    return (
        f"accepted-artifact-sha256: {plan.artifact_sha256}\n"
        f"accepted-artifact-wheel: {plan.wheel_name}"
    )


def _tag_message(args: argparse.Namespace, plan: _ReleasePlan) -> str:
    """构造标签注解：已验收产物身份由本次发布强制附加，自定义 --message 不能覆盖。

    去掉自定义消息里同名的 ``accepted-artifact-*`` 行，避免与本次验收产物冲突。
    """

    identity = _tag_identity(plan)
    lines = (
        [line for line in args.message.splitlines() if not line.startswith("accepted-artifact-")]
        if args.message
        else []
    )
    base = "\n".join(lines).strip() or f"chore(release): {args.tag}"
    return f"{base}\n\n{identity}"


def _tag_binding(project: Path, tag: str) -> tuple[str, str]:
    """读取标签注解里的已验收产物身份行；缺失时返回空串。"""

    result = subprocess.run(
        ["git", "-C", str(project), "tag", "-l", "--format=%(contents)", tag],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        return "", ""
    sha, wheel = "", ""
    for line in result.stdout.splitlines():
        if line.startswith("accepted-artifact-sha256: "):
            sha = line.removeprefix("accepted-artifact-sha256: ").strip()
        elif line.startswith("accepted-artifact-wheel: "):
            wheel = line.removeprefix("accepted-artifact-wheel: ").strip()
    return sha, wheel


def _idempotent_mismatch(store: RecordStore, existing: ReleaseRecord, receipt: dict) -> str:
    """幂等重试时核对标签仍绑定回执里的已验收产物；不一致返回拒绝原因。

    防止「已推送标签但注解缺产物身份」时静默返回"已发布"，让问题永久无法补正。
    """

    recorded_sha = str(receipt.get("artifact_sha256", ""))
    recorded_wheel = str(receipt.get("wheel_name", ""))
    task = store.get_task(existing.task_id)
    project_path = task.config.get("project_path", "") if task is not None else ""
    if not recorded_sha or not project_path:
        return ""
    project = Path(project_path)
    if tag_commit(project, existing.tag) != existing.merge_commit:
        return f"已发布标签 {existing.tag} 指向的提交与回执不一致；拒绝静默幂等，请核对后重建标签"
    sha, wheel = _tag_binding(project, existing.tag)
    if sha != recorded_sha or wheel != recorded_wheel:
        return (
            f"已发布标签 {existing.tag} 的注解未绑定回执中的已验收产物"
            f"（注解 {sha[:12] or '缺失'}/{wheel or '缺失'}，"
            f"回执 {recorded_sha[:12]}/{recorded_wheel}）；拒绝静默幂等，请核对后重建标签"
        )
    return ""


def _upload_accepted_artifact(plan: _ReleasePlan, args: argparse.Namespace) -> None:
    """把 C01 已验收产物原件上传为该标签的草稿 Release 资产。

    发布工作流只下载并核对它，不在标签工作流重新构建。上传失败时抛
    ``ReleaseRefused``；此时标签已推送但发布未记录，可按同标签重试。
    """

    identity = _tag_identity(plan)
    try:
        view = subprocess.run(
            ["gh", "release", "view", args.tag],
            cwd=str(plan.project),
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
    except OSError as error:
        raise ReleaseRefused(
            f"无法执行 gh 上传已验收产物：{error}；请安装并登录 gh 后重试"
        ) from error
    if view.returncode == 0:
        command = ["gh", "release", "upload", args.tag, str(plan.artifact_path), "--clobber"]
    else:
        command = [
            "gh",
            "release",
            "create",
            args.tag,
            str(plan.artifact_path),
            "--draft",
            "--verify-tag",
            "--title",
            args.tag,
            "--notes",
            identity,
        ]
    try:
        result = subprocess.run(
            command,
            cwd=str(plan.project),
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
    except OSError as error:
        raise ReleaseRefused(
            f"无法执行 gh 上传已验收产物：{error}；请安装并登录 gh 后重试"
        ) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-400:]
        raise ReleaseRefused(
            f"上传已验收产物到 Release 失败：{detail}；"
            "标签已推送但发布未完成，核对 gh 凭据与网络后重试"
        )


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
    existing_tags = list(list_tags(project))
    if tag_commit(project, args.tag) == merge[0]:
        # 标签已推送但发布未完成的部分失败：允许按同标签重试，不制造新发布身份。
        existing_tags = [tag for tag in existing_tags if tag != args.tag]
    decision = check_release_readiness(
        ReleaseRequest(
            task_status=task.status,
            acceptance_recorded=acceptance is not None,
            merge_commit=merge[0],
            main_head=read_main_head(project),
            tag=args.tag,
            existing_tags=existing_tags,
            diff_sha256=digest,
            project_version=_project_version(project),
        )
    )
    if not decision.allowed:
        raise ReleaseRefused(decision.reason)
    version = args.tag.removeprefix("v")
    accepted = store.acceptance_binding(args.task_id)
    if accepted is not None:
        # 验收后到发布前材料被换掉：拒绝沿用原验收（K11/K12）。
        current = store.capture_delivery_binding(args.task_id, accepted.plan_version)
        content = check_acceptance_content(accepted, current)
        if not content.allowed:
            raise ReleaseRefused(content.reason)
    wheel_name, artifact_sha256 = _accepted_artifact(root / args.task_id, version, merge[0])
    artifact = check_release_artifact(
        version,
        wheel_name,
        artifact_sha256,
        accepted.artifact_sha256 if accepted is not None else "",
    )
    if not artifact.allowed:
        raise ReleaseRefused(artifact.reason)
    return _ReleasePlan(
        project=project,
        merge_commit=merge[0],
        baseline_commit=str(report.get("baseline_commit", "")),
        diff_sha256=digest,
        wheel_name=wheel_name,
        artifact_sha256=artifact_sha256,
        artifact_path=root / args.task_id / "artifacts" / wheel_name,
        receipt_path=root / args.task_id / "release-receipt.json",
    )


def _receipt_document(record: ReleaseRecord, plan: _ReleasePlan) -> dict:
    """发布回执：部署端据此核对标签、归并提交、候选 diff 与已验收产物身份。"""

    return {
        "task_id": record.task_id,
        "tag": record.tag,
        "merge_commit": record.merge_commit,
        "baseline_commit": record.baseline_commit,
        "diff_sha256": record.diff_sha256,
        "wheel_name": plan.wheel_name,
        "artifact_sha256": plan.artifact_sha256,
        "pushed": record.pushed,
        "push_detail": record.push_detail,
        "released_at": record.released_at.isoformat(),
        "artifact": {"source": "candidate", "checksum_file": "SHA256SUMS"},
    }


def _publish_release(plan: _ReleasePlan, args: argparse.Namespace) -> ReleaseRecord:
    """创建标签、按需推送、上传已验收产物并写回执。

    标签注解强制携带 C01 已验收产物的身份（sha256 与 wheel 文件名），Release 工作流据此
    核对下载到的产物是同一份，不重新构建，也不另造发布身份。推送失败如实记录但不撤销
    本地标签；标签已存在且指向同一归并提交时按部分失败重试。
    """

    message = _tag_message(args, plan)
    existing_commit = tag_commit(plan.project, args.tag)
    if existing_commit is None:
        create_annotated_tag(plan.project, args.tag, plan.merge_commit, message)
    elif existing_commit != plan.merge_commit:
        raise ReleaseRefused(
            f"标签 {args.tag} 已存在并指向 {existing_commit[:12]}，"
            f"与归并提交 {plan.merge_commit[:12]} 不一致；拒绝发布"
        )
    pushed, push_detail = False, "未推送（--no-push）"
    if not args.no_push:
        pushed, push_detail = push_tag(plan.project, args.tag)
        if pushed:
            _upload_accepted_artifact(plan, args)
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
        json.dumps(_receipt_document(record, plan), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return record


def _print_release(record: ReleaseRecord, plan: _ReleasePlan) -> None:
    print(f"已发布 {record.tag}: 提交 {record.merge_commit}")
    print(f"候选 diff 校验值: {record.diff_sha256}")
    print(f"已验收产物: {plan.wheel_name}（sha256 {plan.artifact_sha256}）")
    print(f"标签推送: {'成功' if record.pushed else '未推送'}")
    if record.push_detail and not record.pushed:
        print(f"推送详情: {record.push_detail}")
    print(f"发布回执: {record.receipt_path}")


def cmd_release(args: argparse.Namespace) -> int:
    """验收归并后的受控发布（S1）：创建并推送版本标签并固化回执。"""

    root = records_root(args)
    store = open_store(root, args.task_id)
    try:
        task = store.get_task(args.task_id)
        assert task is not None
        try:
            # 发布也要更新同项目主干（标签指向 main），与归并及另一发布互斥。
            with project_delivery(root, task.project, timeout=args.delivery_timeout):
                return _release_locked(args, store, root)
        except ProjectDeliveryBusyError as error:
            return fail(str(error))
    finally:
        store.close()


def _release_locked(args: argparse.Namespace, store: RecordStore, root: Path) -> int:
    """持有同项目交付互斥后的发布主体（调用方保证已取得项目槽位）。"""

    existing = store.outcomes.release_record(args.task_id)
    existing_receipt = _read_receipt(Path(existing.receipt_path)) if existing else {}
    repeat = check_release_retry(
        existing.tag if existing is not None else None,
        args.tag,
        str(existing_receipt.get("artifact_sha256", "")),
        _current_artifact_sha256(root / args.task_id),
    )
    if not repeat.allowed:
        return fail(repeat.reason)
    if existing is not None:
        mismatch = _idempotent_mismatch(store, existing, existing_receipt)
        if mismatch:
            return fail(mismatch)
        print(f"已发布 {existing.tag}（幂等：不重复创建或推送标签）。")
        print(f"发布回执: {existing.receipt_path}")
        return 0
    try:
        plan = _prepare_release(store, args, root)
        record = _publish_release(plan, args)
    except ReleaseRefused as refusal:
        return fail(str(refusal))
    store.outcomes.record_release(record)
    _print_release(record, plan)
    return 0
