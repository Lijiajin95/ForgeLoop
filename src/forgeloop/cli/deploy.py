"""本机部署与回滚命令（S2）：把已发布产物装到独立版本目录并原子切换。

控制路径（``--tag vX.Y.Z``）：要求 S1 发布回执存在、标签指向回执里的归并提交、
下载的 Release 产物校验值等于发布的 ``SHA256SUMS``；不放宽、不重新构建。
引导路径（``--artifact <path> --bootstrap``）：只用于工具自身首次安装（此时尚
无发布回执），必须在部署日志里如实标注来源，不能冒充控制路径。

安装到 ``<prefix>/releases/<version>``（不覆盖既有版本）；切换用临时符号链接 +
``os.replace``；随后冒烟检查 ``current/bin/forgeloop --help``。任何一步失败都
如实报告：冒烟失败时**不自动回退**，保留现场，并打印**不经过坏版本**的恢复入口
（直接调用上一稳定版本的 ``releases/<previous>/bin/forgeloop``），使 `PATH` 上的
``forgeloop`` 已指向坏版本、甚至坏版本无法启动时仍能恢复。
"""

import argparse
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.deployment import (
    DeploymentError,
    activate,
    append_journal,
    current_version,
    default_prefix,
    download_asset,
    install_wheel,
    installed_digests,
    previous_version,
    release_assets,
    remote_slug,
    sha256_of_file,
    smoke_check,
    version_binary,
)
from forgeloop.adapter.git_workspace import tag_commit
from forgeloop.cli.common import base_records_root, fail
from forgeloop.domain.deploy import (
    DeployRequest,
    RollbackRequest,
    check_deploy_readiness,
    check_rollback_readiness,
    parse_checksum_file,
    select_wheel,
)
from forgeloop.domain.release import ReleaseRecord
from forgeloop.records.projects import ProjectLocation, releases_by_tag

CHECKSUM_ASSET = "SHA256SUMS"


class DeployRefused(RuntimeError):
    """部署前置不满足（缺少回执、无法确定仓库、产物缺失）；转成统一失败输出。"""


@dataclass(frozen=True)
class _DeployPlan:
    """通过前置收集后要安装与记录的事实。"""

    tag: str
    version: str
    source: str
    artifact: Path
    artifact_name: str
    artifact_sha256: str
    merge_commit: str
    request: DeployRequest


def _prefix(args: argparse.Namespace) -> Path:
    return Path(args.prefix).expanduser() if args.prefix else default_prefix()


def _print_recovery_entry(prefix: Path, previous: str) -> None:
    """打印不经过坏版本的恢复入口：直接指向上一稳定版本的 shim。

    冒烟失败时新版本已激活，``PATH`` 上的 ``forgeloop`` 会解析到坏版本；恢复命令
    必须调用 ``releases/<previous>/bin/forgeloop``，否则无法在坏版本无法启动时回滚。
    """

    entry = version_binary(prefix, previous) if previous else None
    if entry is not None and entry.is_file():
        print(
            f"恢复稳定版本（无需调用新版本）: {entry} rollback --prefix {prefix}",
            file=sys.stderr,
        )
        return
    print("无上一稳定版本可回退；请按 docs/deployment.md 重新引导部署", file=sys.stderr)


def _bootstrap_plan(args: argparse.Namespace, prefix: Path) -> _DeployPlan:
    """引导路径：显式使用本地产物；没有发布回执与标签提交可核对。"""

    if not args.bootstrap:
        raise DeployRefused("使用 --artifact 必须显式加 --bootstrap，避免引导部署被误当控制路径")
    artifact = Path(args.artifact).expanduser()
    if not artifact.is_file():
        raise DeployRefused(f"本地产物不存在：{artifact}")
    version = args.tag.removeprefix("v")
    digest = sha256_of_file(artifact)
    request = DeployRequest(
        tag=args.tag,
        version=version,
        source="bootstrap",
        release_recorded=False,
        tag_commit="",
        release_merge_commit="",
        artifact_sha256=digest,
        published_sha256="",
        active_version=current_version(prefix),
        active_sha256=installed_digests(prefix).get(current_version(prefix) or "", None),
    )
    return _DeployPlan(
        tag=args.tag,
        version=version,
        source="bootstrap",
        artifact=artifact,
        artifact_name=artifact.name,
        artifact_sha256=digest,
        merge_commit="",
        request=request,
    )


def _release_project(args: argparse.Namespace, tag: str) -> tuple[Path, str]:
    """跨项目定位标签的发布回执；重复标签必须用 ``--project`` 消歧。"""

    matches: list[tuple[ProjectLocation, ReleaseRecord]] = list(
        releases_by_tag(base_records_root(args), tag)
    )
    if args.project:
        matches = [item for item in matches if item[0].project.project_id == args.project]
    if not matches:
        raise DeployRefused(f"缺少 {tag} 的发布回执；未发布的版本不部署")
    if len(matches) > 1:
        projects = "、".join(sorted(item[0].project.project_id for item in matches))
        raise DeployRefused(
            f"标签 {tag} 在多个项目有发布回执（{projects}）；请用 --project 指定项目"
        )
    location, release = matches[0]
    return Path(location.project.repo_path), release.merge_commit


def _release_slug(args: argparse.Namespace, project: Path) -> str:
    slug = args.repo or remote_slug(project)
    if not slug:
        raise DeployRefused("无法从项目仓库确定 GitHub owner/name；请用 --repo 指定")
    return slug


def _download_release(plan_tag: str, slug: str, version: str, prefix: Path) -> tuple[Path, str]:
    """下载 Release 的 wheel 与校验清单；返回（产物路径，发布校验值）。"""

    assets = release_assets(slug, plan_tag)
    if CHECKSUM_ASSET not in assets:
        raise DeployRefused(f"Release {plan_tag} 缺少 {CHECKSUM_ASSET}；无法核对产物")
    checksum_path = download_asset(assets[CHECKSUM_ASSET], prefix / "artifacts" / CHECKSUM_ASSET)
    checksums = parse_checksum_file(checksum_path.read_text(encoding="utf-8"))
    wheel_name = select_wheel(checksums, version)
    if wheel_name is None or wheel_name not in assets:
        raise DeployRefused(f"Release {plan_tag} 没有 forgeloop-{version} 的 wheel 资产")
    artifact = download_asset(assets[wheel_name], prefix / "artifacts" / wheel_name)
    return artifact, checksums[wheel_name]


def _controlled_plan(args: argparse.Namespace, prefix: Path) -> _DeployPlan:
    """控制路径：发布回执 + 标签提交 + 发布校验值三者一致才允许部署。"""

    project, merge_commit = _release_project(args, args.tag)
    slug = _release_slug(args, project)
    version = args.tag.removeprefix("v")
    artifact, published = _download_release(args.tag, slug, version, prefix)
    digest = sha256_of_file(artifact)
    request = DeployRequest(
        tag=args.tag,
        version=version,
        source="release",
        release_recorded=True,
        tag_commit=tag_commit(project, args.tag) or "",
        release_merge_commit=merge_commit,
        artifact_sha256=digest,
        published_sha256=published,
        active_version=current_version(prefix),
        active_sha256=installed_digests(prefix).get(current_version(prefix) or "", None),
    )
    return _DeployPlan(
        tag=args.tag,
        version=version,
        source="release",
        artifact=artifact,
        artifact_name=artifact.name,
        artifact_sha256=digest,
        merge_commit=merge_commit,
        request=request,
    )


def _journal_entry(
    plan: _DeployPlan, args: argparse.Namespace, previous: str, smoke_code: int, action: str
) -> dict:
    return {
        "action": action,
        "version": plan.version,
        "tag": plan.tag,
        "artifact_name": plan.artifact_name,
        "artifact_sha256": plan.artifact_sha256,
        "artifact_source": plan.source,
        "merge_commit": plan.merge_commit,
        "previous_version": previous,
        "smoke_exit_code": smoke_code,
        "installed_at": datetime.now(UTC).isoformat(),
        "note": getattr(args, "bootstrap_note", ""),
    }


def add_deploy_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    """注册 deploy / rollback 子命令；解析器装配留在命令模块内，避免入口膨胀。"""

    deploy = subparsers.add_parser("deploy", help="部署已发布产物到本机版本目录并原子激活（S2）")
    deploy.add_argument("--tag", required=True, help="版本标签：vMAJOR.MINOR.PATCH")
    deploy.add_argument(
        "--artifact", default="", help="本地产物路径（引导路径，须同时给 --bootstrap）"
    )
    deploy.add_argument("--bootstrap", action="store_true", help="显式标注引导部署（工具首次安装）")
    deploy.add_argument("--bootstrap-note", default="", help="引导部署说明（写入部署日志）")
    deploy.add_argument(
        "--repo", default="", help="GitHub owner/name（缺省从发布回执的项目仓库推断）"
    )
    deploy.add_argument(
        "--project",
        default="",
        help="发布回执所属项目身份（同一标签在多个项目出现时必须指定）",
    )
    deploy.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    deploy.add_argument("--records-root", default=default_records_root)
    deploy.set_defaults(func=cmd_deploy)

    rollback = subparsers.add_parser("rollback", help="回滚到已安装且校验记录完整的版本（S2）")
    rollback.add_argument("--to", default="", help="目标版本 X.Y.Z（缺省用最近记录的上一版本）")
    rollback.add_argument("--note", default="", help="回滚原因备注")
    rollback.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    rollback.set_defaults(func=cmd_rollback)


def cmd_deploy(args: argparse.Namespace) -> int:
    """把已发布产物安装到独立版本目录并原子激活（S2 受控部署）。"""

    prefix = _prefix(args)
    try:
        plan = _bootstrap_plan(args, prefix) if args.artifact else _controlled_plan(args, prefix)
    except DeployRefused as refusal:
        return fail(str(refusal))
    decision = check_deploy_readiness(plan.request)
    if not decision.allowed:
        return fail(decision.reason)
    previous = current_version(prefix) or ""
    if decision.noop:
        print(f"{decision.reason}；不重复安装。")
        print(f"当前版本: {previous}（前缀 {prefix}）")
        return 0
    target = prefix / "releases" / plan.version
    try:
        install_wheel(plan.artifact, target)
        activate(prefix, plan.version)
        smoke_code, smoke_detail = smoke_check(prefix)
    except DeploymentError as error:
        return fail(str(error))
    append_journal(prefix, _journal_entry(plan, args, previous, smoke_code, "deploy"))
    if smoke_code != 0:
        print(f"FAIL: 冒烟检查失败（exit={smoke_code}）：{smoke_detail}", file=sys.stderr)
        print(f"未自动回退；上一版本: {previous or '无'}", file=sys.stderr)
        _print_recovery_entry(prefix, previous)
        return 1
    print(f"已部署 {plan.tag}（来源 {plan.source}）到 {target}")
    print(f"产物校验值: {plan.artifact_sha256}")
    print(f"当前版本: {plan.version}；上一版本: {previous or '无'}")
    print(f"部署日志: {prefix / 'deployments.jsonl'}")
    return 0


def cmd_rollback(args: argparse.Namespace) -> int:
    """回滚到已安装且留有产物校验记录的版本（S2 可核对恢复入口）。"""

    prefix = _prefix(args)
    target = (args.to or previous_version(prefix) or "").removeprefix("v")
    if not target:
        return fail("没有可回滚的上一版本记录；请用 --to X.Y.Z 指定目标版本")
    decision = check_rollback_readiness(
        RollbackRequest(
            target_version=target,
            active_version=current_version(prefix),
            installed_digests=installed_digests(prefix),
        )
    )
    if not decision.allowed:
        return fail(decision.reason)
    previous = current_version(prefix) or ""
    digest = installed_digests(prefix).get(target, "")
    try:
        activate(prefix, target)
        smoke_code, smoke_detail = smoke_check(prefix)
    except DeploymentError as error:
        return fail(str(error))
    entry = {
        "action": "rollback",
        "version": target,
        "tag": target,
        "artifact_name": "",
        "artifact_sha256": digest,
        "artifact_source": "recorded",
        "merge_commit": "",
        "previous_version": previous,
        "smoke_exit_code": smoke_code,
        "installed_at": datetime.now(UTC).isoformat(),
        "note": args.note or "",
    }
    append_journal(prefix, entry)
    if smoke_code != 0:
        print(f"FAIL: 回滚后冒烟检查失败（exit={smoke_code}）：{smoke_detail}", file=sys.stderr)
        return 1
    print(f"已回滚到 {target}（原版本 {previous or '无'}）")
    print(f"产物校验值: {digest}")
    print(f"部署日志: {prefix / 'deployments.jsonl'}")
    return 0
