"""需求并行推进的 CLI 入口（A05）：一次推进多条已批准需求。

职责边界：

- 复用 ``graph.dispatch.RequirementDispatcher`` 并行推进多条需求；每条需求仍走
  ``graph.builder.RequirementTaskRunner`` 的单任务业务图，不新增业务规则。
- 同需求重复启动由记录层执行槽位拒绝，命令如实报告并以非零退出码结束。
- 状态输出来自 ``RequirementProgress``（权威记录汇总），不由模型猜测。

同项目归并/发布的互斥由 ``RequirementDispatcher.project_delivery`` 提供，并已接入
``cli.merge``/``cli.release`` 的真实入口；本模块把并行推进与槽位核对接进 CLI。
"""

import argparse
import json
import sys
from pathlib import Path

from forgeloop.cli.common import records_root
from forgeloop.domain.requirement import BLOCKED, RequirementNotFoundError
from forgeloop.graph.builder import RequirementTaskRunner
from forgeloop.graph.dispatch import RequirementDispatcher
from forgeloop.graph.requirements import RequirementAlreadyRunningError
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore


def _decode_pi_command(raw: str) -> tuple[str, ...]:
    """解析 PI RPC 启动命令；必须是 JSON 非空字符串数组。"""

    try:
        command = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"--pi-command 必须是 JSON 字符串数组: {error}") from error
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) for part in command)
    ):
        raise SystemExit("--pi-command 必须是非空字符串数组（JSON）")
    return tuple(command)


def _runner_for(
    args: argparse.Namespace,
    root: Path,
    req_id: str,
    pi_command: tuple[str, ...],
) -> RequirementTaskRunner:
    """读取需求身份与最新任务包版本，构造接单任务业务图的执行器。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        try:
            requirement = store.get(req_id)
        except RequirementNotFoundError as error:
            raise SystemExit(f"需求不存在: {req_id}") from error
        plan = store.latest_task_plan(req_id)
        plan_version = plan.plan_version if plan is not None else 0
    finally:
        store.close()
    return RequirementTaskRunner(
        records_root=root,
        req_id=req_id,
        plan_version=plan_version,
        project=requirement.project,
        pi_command=pi_command,
        project_path=args.project_path,
        baseline=args.baseline,
        pi_timeout_seconds=args.pi_timeout_seconds or None,
    )


def cmd_requirement_slot_list(args: argparse.Namespace) -> int:
    """列出所有未完成的执行槽位，供中断后人工核对现场。"""

    root = records_root(args)
    store = RecordStore(root / "records.sqlite")
    try:
        slots = store.actions.outstanding_slots()
    finally:
        store.close()
    if not slots:
        print("没有未完成的执行槽位。")
        return 0
    for record in slots:
        name = record.task_id.removeprefix(SLOT_PREFIX)
        print(f"槽位: {name}")
        print(f"  占用者: {record.role or '未知'}")
        print(f"  开始: {record.started_at.isoformat()}")
        print(f"  清理: forgeloop requirement slot clear --slot {name}")
    return 0


def cmd_requirement_slot_clear(args: argparse.Namespace) -> int:
    """人工核对现场后清理一个残留执行槽位；未被占用时明确失败。"""

    root = records_root(args)
    store = RecordStore(root / "records.sqlite")
    try:
        try:
            cleared = store.actions.clear_slot(args.slot, detail="cleared by operator")
        except KeyError as error:
            print(str(error), file=sys.stderr)
            return 1
    finally:
        store.close()
    print(
        f"已清理执行槽位: {args.slot}"
        f"（占用者 {cleared.role or '未知'}，开始于 {cleared.started_at.isoformat()}）"
    )
    return 0


def cmd_requirement_dispatch(args: argparse.Namespace) -> int:
    """并行推进多条已批准需求，逐条报告状态；任一阻塞则整体退出码为 1。"""

    root = records_root(args)
    pi_command = _decode_pi_command(args.pi_command)
    requests = {req_id: _runner_for(args, root, req_id, pi_command) for req_id in args.req_ids}
    dispatcher = RequirementDispatcher(root, max_concurrent=max(1, args.max_concurrent))
    try:
        results = dispatcher.advance_all(requests)
    except RequirementAlreadyRunningError as error:
        print(str(error), file=sys.stderr)
        return 1
    blocked = False
    for req_id in args.req_ids:
        progress = results[req_id]
        print(f"需求: {req_id}")
        print(f"  状态: {progress.requirement_status}")
        print(f"  当前任务: {progress.current_task or '无'}")
        print(f"  已完成: {'、'.join(progress.completed_tasks) or '无'}")
        print(f"  下一步: {progress.next_step.action}（{progress.next_step.actor.value}）")
        if progress.blocked_reason:
            print(f"  原因: {progress.blocked_reason}")
        blocked = blocked or progress.requirement_status == BLOCKED
    return 1 if blocked else 0


def add_requirement_dispatch(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
) -> None:
    """把 ``requirement dispatch`` 与 ``requirement slot`` 子命令登记到需求子解析器上。"""

    dispatch = subparsers.add_parser(
        "dispatch", help="并行推进多条已批准需求（同需求不重复运行、限制并发资源）"
    )
    dispatch.add_argument("req_ids", nargs="+", help="一条或多条已批准需求身份")
    dispatch.add_argument("--pi-command", required=True, help="PI RPC 启动命令（JSON 数组）")
    dispatch.add_argument("--project-path", default="", help="被开发项目路径")
    dispatch.add_argument("--baseline", default="", help="代码基线")
    dispatch.add_argument("--pi-timeout-seconds", type=float, default=0.0)
    dispatch.add_argument(
        "--max-concurrent",
        type=int,
        default=2,
        help="同时推进的需求数上限（正整数）",
    )
    dispatch.add_argument("--records-root", default=default_records_root)
    dispatch.set_defaults(func=cmd_requirement_dispatch)

    slot = subparsers.add_parser("slot", help="查看或清理残留执行槽位（中断后人工核对）")
    slot_actions = slot.add_subparsers(dest="requirement_slot_command", required=True)

    slot_list = slot_actions.add_parser("list", help="列出所有未完成的执行槽位")
    slot_list.add_argument("--records-root", default=default_records_root)
    slot_list.set_defaults(func=cmd_requirement_slot_list)

    slot_clear = slot_actions.add_parser("clear", help="人工核对后清理一个残留执行槽位")
    slot_clear.add_argument(
        "--slot",
        required=True,
        help="槽位名，如 requirement:req-... 或 project-delivery:project",
    )
    slot_clear.add_argument("--records-root", default=default_records_root)
    slot_clear.set_defaults(func=cmd_requirement_slot_clear)
