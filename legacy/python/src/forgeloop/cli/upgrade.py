"""受控热升级薄入口（T4）：status / apply 只调用本机控制接口。

CLI 是客户端：不直接写部署前缀、不激活 current、不启动业务进程。批准、产物、
项目/前缀绑定与 SHA256 全部由固定启动器自行核对；这里的 by/reason 只是审计字段。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from forgeloop.adapter.deployment import default_prefix
from forgeloop.adapter.upgrade_control import (
    ControlError,
    control_request,
    is_managed,
    new_request_id,
    read_owner,
)
from forgeloop.cli.common import fail
from forgeloop.domain.upgrade import PROTOCOL_VERSION, OwnerBinding, UpgradeError
from forgeloop.records.store import RecordStore


def _prefix(value: str) -> Path:
    return Path(value).expanduser().resolve() if value else default_prefix()


def _owner(prefix: Path) -> OwnerBinding:
    if not is_managed(prefix):
        raise ControlError(
            f"前缀未接入固定启动器：{prefix}（先用 scripts/install_local_service.sh 完成首次接入）"
        )
    try:
        return OwnerBinding.from_document(read_owner(prefix))
    except UpgradeError as error:
        raise ControlError(str(error)) from error


def _control(prefix: Path, document: dict[str, object]) -> dict[str, object]:
    response = control_request(prefix, document)
    return dict(response)


def _state_line(response: dict[str, object]) -> str:
    state = response.get("state")
    if not isinstance(state, dict):
        return "升级现场：无"
    raw_identity = state.get("identity")
    identity = raw_identity if isinstance(raw_identity, dict) else {}
    return (
        f"升级现场：{state.get('phase', '?')} generation={state.get('generation', '?')} "
        f"version={identity.get('version', '?')} sha256={str(identity.get('artifact_sha256', ''))[:12]}"
    )


def cmd_upgrade_status(args: argparse.Namespace) -> int:
    prefix = _prefix(args.prefix)
    try:
        owner = _owner(prefix)
        response = _control(prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "status"})
    except ControlError as error:
        return fail(str(error))
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2))
        return 0 if response.get("ok") else 1
    print(f"前缀：{prefix}")
    print(f"项目：{owner.project}；记录根：{owner.records_root}")
    print(
        f"启动器 pid：{response.get('launcher_pid', '?')}；业务进程：{response.get('child_pid', '无')}"
    )
    print(_state_line(response))
    summary = response.get("prefix")
    if isinstance(summary, dict):
        print(f"current：{summary.get('current_version', '') or '无'}")
        print(
            f"已安装版本：{'、'.join(str(item) for item in summary.get('installed_versions', [])) or '无'}"
        )
    return 0 if response.get("ok") else 1


def cmd_upgrade_apply(args: argparse.Namespace) -> int:
    prefix = _prefix(args.prefix)
    try:
        owner = _owner(prefix)
    except ControlError as error:
        return fail(str(error))
    project = args.project.strip() or owner.project
    if project != owner.project:
        return fail(f"--project {project} 与 owner 绑定 {owner.project} 不符")
    if args.tag != f"v{args.tag.removeprefix('v')}":
        return fail(f"标签不合法：{args.tag}")
    digest = args.artifact_sha256.strip()
    if not digest:
        # 客户端便利：从本机权威批准的 (tag, sha) 取产物身份；启动器仍会独立复核。
        store = RecordStore(Path(owner.records_root) / "records.sqlite")
        try:
            approval = store.deploy_approval(args.tag)
        finally:
            store.close()
        if approval is None:
            return fail(
                f"缺少 {args.tag} 的部署批准；先运行 forgeloop deploy-approve --by/--reason"
            )
        digest = approval[1]
    payload = {
        "protocol_version": PROTOCOL_VERSION,
        "operation": "switch",
        "request": {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": args.request_id or new_request_id(),
            "project": owner.project,
            "prefix": str(prefix),
            "tag": args.tag,
            "artifact_sha256": digest,
            "by": args.by,
            "reason": args.reason,
        },
    }
    try:
        response = _control(prefix, payload)
    except ControlError as error:
        return fail(str(error))
    message = str(response.get("message", ""))
    if not response.get("ok"):
        print(f"FAIL: {message}", file=__import__("sys").stderr)
        state = response.get("state")
        if isinstance(state, dict):
            print(_state_line(response), file=__import__("sys").stderr)
        return 1
    print(message)
    print(_state_line(response))
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0


def add_upgrade_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    upgrade = subparsers.add_parser(
        "upgrade", help="受控热升级：查询现场 / 经固定启动器切换已批准版本"
    )
    actions = upgrade.add_subparsers(dest="upgrade_command", required=True)

    status = actions.add_parser("status", help="只读查看启动器、业务进程与升级现场")
    status.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    status.add_argument("--json", action="store_true", help="输出控制接口的完整 JSON")
    status.add_argument("--records-root", default=default_records_root)
    status.set_defaults(func=cmd_upgrade_status)

    apply_cmd = actions.add_parser("apply", help="请求切换到一个已发布且已获人工部署批准的版本")
    apply_cmd.add_argument("--tag", required=True, help="版本标签：vMAJOR.MINOR.PATCH")
    apply_cmd.add_argument(
        "--artifact-sha256",
        default="",
        help="产物校验值（缺省取该标签已记录的人工部署批准）",
    )
    apply_cmd.add_argument("--by", required=True, help="调用方标识（审计字段）")
    apply_cmd.add_argument("--reason", required=True, help="切换理由（审计字段）")
    apply_cmd.add_argument("--project", default="", help="必须与 owner 绑定一致")
    apply_cmd.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    apply_cmd.add_argument("--request-id", default="", help="幂等请求身份（缺省自动生成）")
    apply_cmd.add_argument("--json", action="store_true", help="输出控制接口的完整 JSON")
    apply_cmd.add_argument("--records-root", default=default_records_root)
    apply_cmd.set_defaults(func=cmd_upgrade_apply)
