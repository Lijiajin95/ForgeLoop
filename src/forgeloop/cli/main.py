"""ForgeLoop CLI 入口：submit / approve / grant / status / stop。

命令职责（首版需求 V1 与 V0-08）：
- submit：保存原始文本与配置快照，生成方案并运行到第一次批准中断。
- approve：记录本地批准（绑定任务与方案版本），恢复业务图执行。
- grant：记录追加授权（额度 +3，累计不清零），恢复执行。
- status：从权威记录生成查询输出，进程退出后仍可回查；
  ``--json`` 输出稳定契约（成功、失败、不存在任务行为固定）。
- stop：请求停止；运行中的图在当前工具完成并保存结果后不再启动新动作。

所有输出由 RecordStore 的实际记录生成，不由模型猜测。
"""

import argparse
import contextlib
import json
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.graph.builder import build_graph
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.state import TaskState
from forgeloop.records.store import RecordStore

DEFAULT_RECORDS_ROOT = ".forgeloop"
DEFAULT_LIMIT_SECONDS = 7200.0


def _records_root(args: argparse.Namespace) -> Path:
    root = getattr(args, "records_root", None) or DEFAULT_RECORDS_ROOT
    return Path(root)


def _read_input(raw: str) -> str:
    if raw.startswith("@"):
        path = Path(raw[1:])
        if not path.is_file():
            raise SystemExit(f"输入文件不存在: {path}")
        return path.read_text(encoding="utf-8")
    return raw


def _decode_command(raw: str, flag: str) -> tuple[str, ...]:
    try:
        command = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{flag} 必须是 JSON 字符串数组: {error}") from error
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) for part in command)
    ):
        raise SystemExit(f"{flag} 必须是非空字符串数组（JSON）")
    return tuple(command)


def _new_task_id() -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    return f"task-{stamp}-{uuid.uuid4().hex[:6]}"


def _build_runtime(
    records_root: Path, task_id: str
) -> tuple[RecordStore, NodeContext, CompiledStateGraph[TaskState]]:
    store = RecordStore(records_root / "records.sqlite")
    try:
        ctx = NodeContext.for_task(store, records_root, task_id)
    except KeyError as error:
        store.close()
        raise SystemExit(f"任务不存在: {task_id}") from error
    graph = build_graph(ctx, records_root / "checkpoints.sqlite")
    return store, ctx, graph


def _close_runtime(graph: object) -> None:
    checkpointer = getattr(graph, "checkpointer", None)
    conn = getattr(checkpointer, "conn", None)
    if conn is not None:
        with contextlib.suppress(Exception):
            conn.close()


def _run_config(task_id: str) -> RunnableConfig:
    return {"configurable": {"thread_id": task_id}}


def _describe_interrupt(graph: CompiledStateGraph[TaskState], task_id: str) -> str:
    try:
        snapshot = graph.get_state(_run_config(task_id))
    except Exception:
        return ""
    if not snapshot.next:
        return ""
    kinds = []
    for task in snapshot.tasks:
        for interrupt_info in task.interrupts:
            value = interrupt_info.value
            if isinstance(value, dict) and value.get("kind"):
                kinds.append(str(value["kind"]))
    position = ", ".join(sorted(snapshot.next)) if snapshot.next else ""
    if kinds:
        return f"等待决定: {'、'.join(kinds)}（节点: {position}）"
    return f"等待节点: {position}" if position else ""


def cmd_submit(args: argparse.Namespace) -> int:
    records_root = _records_root(args)
    original_input = _read_input(args.input)
    if args.project_path:
        source = Path(args.project_path)
        if not source.is_dir() or not (source / ".git").exists():
            raise SystemExit(f"project_path 不是 git 仓库: {source}")
    test_command = _decode_command(args.test_command, "--test-command")
    pi_command = _decode_command(args.pi_command, "--pi-command")
    task_id = _new_task_id()
    config = {
        "project_path": args.project_path or "",
        "baseline": args.baseline or "",
        "model": args.model or "",
        "pi_command": json.dumps(list(pi_command)),
        "test_command": json.dumps(list(test_command)),
        "goal": args.goal or "",
        "scope": args.scope or "",
        "acceptance": args.acceptance or "",
    }
    store = RecordStore(records_root / "records.sqlite")
    try:
        store.create_task(task_id, args.project, original_input, config, args.limit_seconds)
        ctx = NodeContext.for_task(store, records_root, task_id)
        graph = build_graph(ctx, records_root / "checkpoints.sqlite")
        try:
            graph.invoke({"task_id": task_id}, _run_config(task_id))
            task = store.get_task(task_id)
        finally:
            _close_runtime(graph)
    finally:
        store.close()
    print(f"任务已创建: {task_id}")
    print(f"状态: {task.status if task else 'unknown'}")
    print("等待第一次本地批准（范围+方案+验收标准+测试命令）。")
    print(f"批准命令: forgeloop approve {task_id}")
    return 0


def _resume_graph(records_root: Path, task_id: str, resume: dict) -> RecordStore:
    store, _ctx, graph = _build_runtime(records_root, task_id)
    try:
        graph.invoke(Command(resume=resume), _run_config(task_id))
        pending = _describe_interrupt(graph, task_id)
        task = store.get_task(task_id)
        print(f"状态: {task.status if task else 'unknown'}")
        if pending:
            print(pending)
    finally:
        _close_runtime(graph)
        store.close()
    return store


def _open_store(records_root: Path, task_id: str) -> RecordStore:
    store = RecordStore(records_root / "records.sqlite")
    if store.get_task(task_id) is None:
        store.close()
        raise SystemExit(f"任务不存在: {task_id}")
    return store


def cmd_approve(args: argparse.Namespace) -> int:
    stage = ApprovalStage(args.stage)
    resume_decision = "approved" if stage is ApprovalStage.PLAN else "accepted"
    if args.decision == "rejected":
        resume_decision = "rejected"
    records_root = _records_root(args)
    store = _open_store(records_root, args.task_id)
    try:
        plan = store.latest_plan(args.task_id)
        if plan is None:
            raise SystemExit(f"任务尚无方案，无法批准: {args.task_id}")
        if args.decision == "approved":
            store.record_approval(Approval(args.task_id, plan.version, stage, datetime.now(UTC)))
            print(f"{stage.value} 批准已记录（方案版本 {plan.version}）。")
        else:
            print(f"{stage.value} 拒绝决定已记录（不写入批准）。")
    finally:
        store.close()
    _resume_graph(records_root, args.task_id, {"decision": resume_decision})
    return 0


def cmd_grant(args: argparse.Namespace) -> int:
    records_root = _records_root(args)
    store = _open_store(records_root, args.task_id)
    try:
        ledger = store.ledger(args.task_id)
        print(
            f"追加授权前：累计失败 {ledger.cumulative_failures}，"
            f"授权次数 {ledger.grant_count}（历史保留，不清零）。"
        )
    finally:
        store.close()
    _resume_graph(records_root, args.task_id, {"decision": "grant"})
    return 0


def _plan_section(store: RecordStore, task_id: str) -> dict | None:
    plan = store.latest_plan(task_id)
    if plan is None:
        return None
    return {
        "version": plan.version,
        "goal": plan.goal,
        "scope": plan.scope,
        "acceptance": plan.acceptance,
        "test_command": list(plan.test_command),
    }


def _approval_entry(approval: Approval | None) -> dict | None:
    if approval is None:
        return None
    return {
        "plan_version": approval.plan_version,
        "decided_at": approval.decided_at.isoformat(),
    }


def _failures_section(store: RecordStore, task_id: str) -> dict:
    ledger = store.ledger(task_id)
    return {
        "cumulative": ledger.cumulative_failures,
        "grants": ledger.grant_count,
        "remaining_in_current_grant": ledger.remaining_in_current_grant,
        "awaiting_grant_decision": ledger.awaiting_grant_decision,
        "rounds": [
            {
                "round_id": round_.round_id,
                "stage": round_.stage.value,
                "summary": round_.summary,
                "occurred_at": round_.occurred_at.isoformat(),
            }
            for round_ in ledger.rounds
        ],
    }


def _budget_section(store: RecordStore, task_id: str) -> dict:
    budget = store.budget(task_id)
    return {
        "limit_seconds": budget.limit_seconds,
        "consumed_seconds": budget.consumed_seconds,
        "exhausted": budget.exhausted,
    }


def _stop_section(store: RecordStore, task_id: str) -> dict | None:
    stop = store.stop_record(task_id)
    if stop is None:
        return None
    requested_at, confirmed_at, note = stop
    return {
        "requested_at": requested_at.isoformat(),
        "confirmed_at": confirmed_at.isoformat() if confirmed_at else None,
        "note": note,
    }


def _delivery_section(store: RecordStore, task_id: str) -> dict | None:
    delivery = store.delivery(task_id)
    if delivery is None:
        return None
    diff_path, report_path, delivered_at = delivery
    return {
        "diff_path": diff_path,
        "report_path": report_path,
        "delivered_at": delivered_at.isoformat(),
    }


def _status_document(store: RecordStore, task_id: str) -> dict:
    task = store.get_task(task_id)
    if task is None:
        return {"task_id": task_id, "error": "task_not_found"}
    return {
        "task_id": task_id,
        "project": task.project,
        "status": task.status,
        "created_at": task.created_at.isoformat(),
        "plan": _plan_section(store, task_id),
        "approvals": {
            "plan": _approval_entry(store.effective_approval(task_id, ApprovalStage.PLAN)),
            "acceptance": _approval_entry(
                store.effective_approval(task_id, ApprovalStage.ACCEPTANCE)
            ),
        },
        "failures": _failures_section(store, task_id),
        "budget": _budget_section(store, task_id),
        "stop": _stop_section(store, task_id),
        "delivery": _delivery_section(store, task_id),
    }


def cmd_status(args: argparse.Namespace) -> int:
    records_root = _records_root(args)
    store = RecordStore(records_root / "records.sqlite")
    try:
        document = _status_document(store, args.task_id)
    finally:
        store.close()
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return 0 if "error" not in document else 1
    if "error" in document:
        print(f"任务不存在: {args.task_id}", file=sys.stderr)
        return 1
    print(f"任务: {document['task_id']}（项目: {document['project']}）")
    print(f"状态: {document['status']}")
    if document["plan"]:
        plan = document["plan"]
        print(f"方案版本: {plan['version']}；目标: {plan['goal']}")
        print(f"测试命令: {' '.join(plan['test_command'])}")
    failures = document["failures"]
    print(
        f"失败轮次: 累计 {failures['cumulative']}，授权 {failures['grants']} 次，"
        f"本次剩余 {failures['remaining_in_current_grant']}"
    )
    budget = document["budget"]
    print(
        f"工时: 已用 {budget['consumed_seconds']:.1f}s / 限额 {budget['limit_seconds']:.0f}s"
        + ("（已耗尽）" if budget["exhausted"] else "")
    )
    if document["stop"]:
        stop = document["stop"]
        print(f"停止请求: {stop['requested_at']}（备注: {stop['note']}）")
    if document["delivery"]:
        delivery = document["delivery"]
        print(f"交付: diff={delivery['diff_path']} 报告={delivery['report_path']}")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    records_root = _records_root(args)
    store = _open_store(records_root, args.task_id)
    try:
        store.request_stop(args.task_id, args.note or "")
        print(f"停止请求已记录: {args.task_id}")
        print("当前工具完成并保存结果后将不再启动新动作；结果不明确时保留现场待核对。")
    finally:
        store.close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="forgeloop",
        description="ForgeLoop：CLI 自动研发闭环（提交、批准、查询、停止）",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    submit = subparsers.add_parser("submit", help="提交文本小任务并生成方案")
    submit.add_argument("--project", required=True, help="任务绑定的项目名")
    submit.add_argument("--input", required=True, help="任务正文；@path 读取 UTF-8 文本文件")
    submit.add_argument(
        "--test-command", required=True, help="批准的正式测试命令（JSON 字符串数组）"
    )
    submit.add_argument("--pi-command", required=True, help="PI RPC 启动命令（JSON 字符串数组）")
    submit.add_argument("--goal", default="", help="目标（缺省用正文）")
    submit.add_argument("--scope", default="", help="边界（缺省用正文）")
    submit.add_argument("--acceptance", default="", help="验收标准（缺省用正文）")
    submit.add_argument("--project-path", default="", help="项目路径")
    submit.add_argument("--baseline", default="", help="代码基线")
    submit.add_argument("--model", default="", help="模型配置标识")
    submit.add_argument(
        "--limit-seconds", type=float, default=DEFAULT_LIMIT_SECONDS, help="执行时间限额（秒）"
    )
    submit.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT, help="记录根目录")
    submit.set_defaults(func=cmd_submit)

    approve = subparsers.add_parser("approve", help="记录本地批准并恢复执行")
    approve.add_argument("task_id")
    approve.add_argument("--stage", choices=["plan", "acceptance"], default="plan")
    approve.add_argument("--decision", choices=["approved", "rejected"], default="approved")
    approve.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    approve.set_defaults(func=cmd_approve)

    grant = subparsers.add_parser("grant", help="追加三个失败轮次并恢复执行")
    grant.add_argument("task_id")
    grant.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    grant.set_defaults(func=cmd_grant)

    status = subparsers.add_parser("status", help="查询任务状态与记录")
    status.add_argument("task_id")
    status.add_argument("--json", action="store_true", help="输出 JSON 契约")
    status.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    status.set_defaults(func=cmd_status)

    stop = subparsers.add_parser("stop", help="请求停止（当前工具完成后生效）")
    stop.add_argument("task_id")
    stop.add_argument("--note", default="", help="停止原因备注")
    stop.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    stop.set_defaults(func=cmd_stop)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
