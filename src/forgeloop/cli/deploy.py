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
    health_check,
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
from forgeloop.domain.project import ProjectError, project_data_root
from forgeloop.domain.release import ReleaseRecord
from forgeloop.records.projects import (
    ProjectLocation,
    ProjectStore,
    iter_projects,
    project_records_path,
    releases_by_tag,
)
from forgeloop.records.store import RecordStore

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
    """部署前缀一律解析为**绝对路径**。

    激活指针是符号链接：相对路径会被按链接所在目录解析成 ``<前缀>/<前缀>/releases/…``，
    装完即坏（2026-10-20 实测：``--prefix .cache/x`` 安装成功但冒烟 127）。因此这里
    统一绝对化，调用方传相对路径也不会写出坏指针。
    """

    return Path(args.prefix).expanduser().resolve() if args.prefix else default_prefix()


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


def _approval_root(args: argparse.Namespace) -> Path:
    """部署批准归属的记录根：显式 ``--project`` 优先，否则要求唯一已登记项目。

    部署批准绑定 ``(tag, artifact_sha256)``，与发布回执同属一个项目；多项目下必须
    消歧，不能猜——猜错会把批准写进另一个项目的权威记录。
    """

    base = base_records_root(args)
    project_id = getattr(args, "project", "") or ""
    if project_id:
        store = ProjectStore(project_records_path(base))
        try:
            return project_data_root(base, store.require(project_id).project_id)
        except ProjectError as error:
            raise DeployRefused(str(error)) from error
        finally:
            store.close()
    locations = tuple(iter_projects(base))
    if len(locations) == 1:
        return locations[0].root
    if not locations:
        raise DeployRefused(
            f"记录根 {base} 里没有已登记项目；先运行 `forgeloop project add` 登记项目"
        )
    projects = "、".join(sorted(item.project.project_id for item in locations))
    raise DeployRefused(f"记录根里有多个已登记项目（{projects}）；请用 --project 指定部署批准归属")


def _store(args: argparse.Namespace) -> RecordStore:
    """部署批准与查询用的记录存储（按 :func:`_approval_root` 定位项目）。"""

    return RecordStore(_approval_root(args) / "records.sqlite")


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

    approve = subparsers.add_parser(
        "deploy-approve", help="人工批准某版本（标签+产物校验值）的部署（发布前需确认）"
    )
    approve.add_argument("--tag", required=True, help="版本标签：vMAJOR.MINOR.PATCH")
    approve.add_argument("--artifact-sha256", required=True, help="产物校验值（64 位十六进制小写）")
    approve.add_argument("--by", required=True, help="调用方标识（如 owner）")
    approve.add_argument("--reason", required=True, help="批准理由（安装到本机的决定）")
    approve.add_argument(
        "--project", default="", help="批准归属的项目身份（有多个已登记项目时必须指定）"
    )
    approve.add_argument("--records-root", default=default_records_root)
    approve.set_defaults(func=cmd_deploy_approve)

    rollback = subparsers.add_parser("rollback", help="回滚到已安装且校验记录完整的版本（S2）")
    rollback.add_argument("--to", default="", help="目标版本 X.Y.Z（缺省用最近记录的上一版本）")
    rollback.add_argument("--note", default="", help="回滚原因备注")
    rollback.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    rollback.set_defaults(func=cmd_rollback)


def cmd_deploy_approve(args: argparse.Namespace) -> int:
    """记录一次人工部署批准；缺少调用方标识或理由一律拒绝（零副作用）。"""

    try:
        store = _store(args)
    except DeployRefused as refusal:
        return fail(str(refusal))
    try:
        try:
            tag, digest = store.record_deploy_approval(
                args.tag,
                args.artifact_sha256,
                by=args.by,
                source="cli:deploy-approve",
                reason=args.reason,
            )
        except ValueError as error:
            return fail(str(error))
    finally:
        store.close()
    print(f"部署批准已记录：{tag}（产物 {digest[:12]}，批准人 {args.by}）")
    print("下一步：forgeloop deploy --tag " + tag + "（安装后自动健康检查；失败回滚）")
    return 0


_DEPLOY_NOTICE_TITLES = {
    "deploy": "部署成功",
    "auto-rollback": "健康检查失败，已自动回滚",
    "failed": "部署失败",
}


def deploy_notice(
    action: str, tag: str, artifact_sha256: str, detail: str, previous: str
) -> tuple[str, str]:
    """部署结果邮件通知的（主题, 正文）；纯函数，便于测试与复用。"""

    title = _DEPLOY_NOTICE_TITLES.get(action, action)
    subject = f"[ForgeLoop] {title}：{tag}"
    body = "\n".join(
        (
            f"版本：{tag}",
            f"产物校验值：{artifact_sha256}",
            f"结果：{title}",
            f"健康检查：{detail}",
            f"当前/回滚目标版本：{previous or '无'}",
            "",
            "本邮件由部署流程自动发出（best-effort）。",
        )
    )
    return subject, body


def notify_deploy_result(
    action: str, tag: str, artifact_sha256: str, detail: str, previous: str
) -> str:
    """best-effort 发出部署结果通知；发送失败只返回状态，绝不影响部署结论。

    2026-10-18 所有者决定（"需要邮件通知"）：成功/自动回滚/失败都要通知。收件人与
    provider 取邮件配置链（`--config`之外由 `~/.config/forgeloop/mail.toml` 命中）。
    """

    subject, body = deploy_notice(action, tag, artifact_sha256, detail, previous)
    try:
        from email.message import EmailMessage

        from forgeloop.adapter.mail import SmtpMailSender, SmtpSettings
        from forgeloop.mail.config import load_mail_config
        from forgeloop.mail.ports import MailEncryption
        from forgeloop.mail.presets import preset_for
        from forgeloop.mail.secret import resolve_secret

        config = load_mail_config(repo_root=Path.cwd(), home=Path.home())
        preset = preset_for(config.provider)
        resolution = resolve_secret(
            repo_root=Path.cwd(), home=Path.home(), default_account=config.sender
        )
        if not resolution.secret:
            return "邮件通知未发送：口令不可用"
        endpoint = preset.default_smtp_endpoint
        sender = SmtpMailSender(
            SmtpSettings(
                host=endpoint.host,
                port=endpoint.port,
                username=config.sender,
                secret=resolution.secret.reveal(),
                sender=config.sender,
                recipient=config.recipient,
                use_ssl=endpoint.encryption is MailEncryption.SSL,
            )
        )
        message = EmailMessage()
        message["From"] = config.sender
        message["To"] = config.recipient
        message["Subject"] = subject
        message.set_content(body)
        sender.send(message)
    except Exception as error:
        return f"邮件通知未发送：{type(error).__name__}: {error}"
    return f"邮件通知已发送：{config.recipient}"


def cmd_deploy(args: argparse.Namespace) -> int:
    """把已发布产物安装到独立版本目录并原子激活（S2 受控部署）。"""

    prefix = _prefix(args)
    try:
        plan = _bootstrap_plan(args, prefix) if args.artifact else _controlled_plan(args, prefix)
    except DeployRefused as refusal:
        return fail(str(refusal))
    approval = None
    if plan.request.source != "bootstrap":
        try:
            store = _store(args)
        except DeployRefused as refusal:
            return fail(str(refusal))
        try:
            approval = store.deploy_approval(plan.request.tag)
        finally:
            store.close()
    decision = check_deploy_readiness(plan.request, deploy_approval=approval)
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
    # 2026-10-18 所有者决定（保留健康检查）：受控路径激活后再做一次真实健康检查，
    # 不通过即**自动回滚到上一版本**，不留半激活前缀；bootstrap（工具首次安装，机器上
    # 通常还没有服务配置）只要求冒烟通过，也不写 health 日志。
    health_code, health_detail = 0, "bootstrap：跳过服务健康检查"
    if plan.request.source == "release":
        health_code, health_detail = health_check(prefix)
        append_journal(prefix, _journal_entry(plan, args, previous, health_code, "health"))
        if health_code != 0:
            print(f"FAIL: 健康检查失败（exit={health_code}）：{health_detail}", file=sys.stderr)
            if not previous:
                print("没有可回滚的上一版本；请人工处理", file=sys.stderr)
                print(
                    notify_deploy_result(
                        "failed", plan.tag, plan.artifact_sha256, health_detail, previous
                    ),
                    file=sys.stderr,
                )
                _print_recovery_entry(prefix, previous)
                return 1
            try:
                activate(prefix, previous)
            except DeploymentError as error:
                print(
                    f"自动回滚失败：{error}；已停在 {plan.version}，请人工处理",
                    file=sys.stderr,
                )
                _print_recovery_entry(prefix, previous)
                return 1
            append_journal(
                prefix, _journal_entry(plan, args, previous, health_code, "auto-rollback")
            )
            print(f"已自动回滚到 {previous}；服务保持可用", file=sys.stderr)
            print(
                notify_deploy_result(
                    "auto-rollback", plan.tag, plan.artifact_sha256, health_detail, previous
                ),
                file=sys.stderr,
            )
            _print_recovery_entry(prefix, previous)
            return 1
        print(f"健康检查通过：{health_detail}")
    print(f"已部署 {plan.tag}（来源 {plan.source}）到 {target}")
    print(f"产物校验值: {plan.artifact_sha256}")
    print(f"当前版本: {plan.version}；上一版本: {previous or '无'}")
    print(f"部署日志: {prefix / 'deployments.jsonl'}")
    print(notify_deploy_result("deploy", plan.tag, plan.artifact_sha256, health_detail, previous))
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
