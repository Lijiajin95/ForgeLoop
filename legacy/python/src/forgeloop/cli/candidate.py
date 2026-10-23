"""候选产物构建与验证命令（S4）：从已归并提交真实构建、独立安装冒烟并校验可复现。

流程：
1. 只授权任务已归并的提交；显式 ``--commit`` 与归并提交不一致即拒绝（未授权提交）。
2. 从该提交导出独立工作目录，真实 ``uv build`` 得到 wheel，记录身份与 SHA256。
3. 再次独立构建并对比校验值：一致才算可复现；不一致如实报告两次值并失败。
4. 在全新独立 venv 安装并 ``forgeloop --help`` 冒烟。
5. 候选产物原件保留到任务目录 ``artifacts/``，回执写入 ``candidate-artifact.json``，
   供发布/部署端核对"同一份验收产物"。

本模块只调用 adapter / domain，不直接操作 git 与构建工具。
"""

import argparse
import json
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.artifact import (
    ArtifactError,
    build_candidate,
    install_and_smoke,
    sha256_of_file,
)
from forgeloop.cli.common import (
    base_records_root,
    fail,
    open_task,
    project_repository,
)
from forgeloop.domain.artifact import (
    ArtifactRecord,
    check_artifact_identity,
    check_commit_authorization,
    compare_builds,
    wheel_version,
)


class CandidateRefused(RuntimeError):
    """候选构建前置不满足（未授权提交、未归并、缺少项目路径）；转成统一失败输出。"""


def _prepare(args: argparse.Namespace, base: Path) -> tuple[str, Path, Path]:
    """收集构建前置：只允许任务已归并的提交，返回（提交号，项目路径，项目记录根）。"""

    location = open_task(base, args.task_id)
    store, root = location.store, location.root
    try:
        task = store.get_task(args.task_id)
        assert task is not None
        merge = store.outcomes.merge_record(args.task_id)
        authorized = merge[0] if merge else ""
        commit = args.commit or authorized
        decision = check_commit_authorization(args.task_id, commit, authorized)
        if not decision.allowed:
            raise CandidateRefused(decision.reason)
        project_path = project_repository(base, task.project, task.config.get("project_path", ""))
        if not project_path:
            raise CandidateRefused("任务未绑定项目仓库，无法构建候选产物")
        project = Path(project_path)
        if not project.is_dir() or not (project / ".git").exists():
            raise CandidateRefused(f"项目路径不是 git 仓库：{project}")
        return commit, project, root
    finally:
        store.close()


def _retain(root: Path, task_id: str, wheel: Path, digest: str, wheel_name: str) -> Path:
    """把候选产物原件保留到任务目录；同名不同校验值拒绝覆盖。"""

    artifact_dir = root / task_id / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    retained = artifact_dir / wheel_name
    if retained.is_file() and sha256_of_file(retained) != digest:
        raise CandidateRefused(f"已存在同名但校验值不同的候选产物：{retained}；拒绝覆盖")
    shutil.copy2(wheel, retained)
    return retained


def _receipt_document(record: ArtifactRecord) -> dict:
    """候选产物回执：发布/部署端据此核对身份与同一份产物。"""

    return {
        "task_id": record.task_id,
        "commit": record.commit,
        "version": record.version,
        "wheel_name": record.wheel_name,
        "sha256": record.sha256,
        "rebuild_sha256": record.rebuild_sha256,
        "reproducible": record.reproducible,
        "smoke_exit_code": record.smoke_exit_code,
        "smoke_detail": record.smoke_detail,
        "wheel_path": record.wheel_path,
        "built_at": record.built_at.isoformat(),
    }


def _write_receipt(root: Path, record: ArtifactRecord) -> Path:
    receipt = root / record.task_id / "candidate-artifact.json"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(
        json.dumps(_receipt_document(record), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return receipt


def _print_result(record: ArtifactRecord, comparison_reason: str, smoke_detail: str) -> None:
    print(f"已构建候选产物: {record.wheel_name}")
    print(f"任务: {record.task_id}；提交: {record.commit}")
    print(f"版本: {record.version}；校验值: {record.sha256}")
    print(f"重复构建: {comparison_reason}")
    if record.smoke_exit_code >= 0:
        state = "通过" if record.smoke_exit_code == 0 else "失败"
        print(f"独立环境冒烟: {state}（exit {record.smoke_exit_code}）")
        if smoke_detail and record.smoke_exit_code != 0:
            print(f"冒烟详情: {smoke_detail}")
    else:
        print("独立环境冒烟: 未执行（产物不可复现）")
    print(f"候选产物: {record.wheel_path}")
    print(f"候选产物回执: {record.receipt_path}")


def cmd_candidate(args: argparse.Namespace) -> int:
    """从已归并提交构建并验证候选产物（S4）：授权提交、可复现与独立冒烟。"""

    root: Path
    try:
        commit, project, root = _prepare(args, base_records_root(args))
    except CandidateRefused as refusal:
        return fail(str(refusal))
    work = (
        Path(args.work_dir).expanduser()
        if args.work_dir
        else Path(tempfile.mkdtemp(prefix="forgeloop-candidate-"))
    )
    try:
        first = build_candidate(project, commit, work / "first")
        version = wheel_version(first.wheel_name)
        identity = check_artifact_identity(first.project_version, first.wheel_name)
        if version is None or not identity.allowed:
            return fail(identity.reason)
        second = build_candidate(project, commit, work / "second")
        comparison = compare_builds(first.sha256, second.sha256)
        try:
            retained = _retain(root, args.task_id, first.wheel, first.sha256, first.wheel_name)
        except CandidateRefused as refusal:
            return fail(str(refusal))
        smoke_code, smoke_detail = -1, "未执行（产物不可复现）"
        if comparison.consistent:
            smoke_code, smoke_detail = install_and_smoke(first.wheel, work / "environment")
        record = ArtifactRecord(
            task_id=args.task_id,
            commit=commit,
            version=version,
            wheel_name=first.wheel_name,
            sha256=first.sha256,
            rebuild_sha256=second.sha256,
            reproducible=comparison.consistent,
            smoke_exit_code=smoke_code,
            smoke_detail=smoke_detail,
            wheel_path=str(retained),
            receipt_path=str(root / args.task_id / "candidate-artifact.json"),
            built_at=datetime.now(UTC),
        )
        _write_receipt(root, record)
        _print_result(record, comparison.reason, smoke_detail)
        if not comparison.consistent:
            return 1
        return 0 if smoke_code == 0 else 1
    except ArtifactError as error:
        return fail(str(error))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def add_candidate_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    """注册 candidate 子命令；解析器装配留在命令模块内，避免入口膨胀。"""

    candidate = subparsers.add_parser("candidate", help="从已归并提交构建并验证候选产物（S4）")
    candidate.add_argument("task_id")
    candidate.add_argument(
        "--commit", default="", help="待构建提交（缺省用任务归并提交；非授权提交一律拒绝）"
    )
    candidate.add_argument("--work-dir", default="", help="构建工作目录（缺省用临时目录）")
    candidate.add_argument("--records-root", default=default_records_root)
    candidate.set_defaults(func=cmd_candidate)
