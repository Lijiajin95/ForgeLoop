"""ForgeLoop CLI 入口：submit / approve / grant / status / stop。

命令职责（首版需求 V1 与 V0-08）：
- submit：保存原始文本与配置快照，生成方案并运行到第一次批准中断。
- approve：记录本地批准（绑定任务与方案版本），恢复业务图执行。
- grant：记录追加授权（额度 +3，累计不清零），恢复执行。
- status：从权威记录生成查询输出，进程退出后仍可回查；
  ``--json`` 输出稳定契约（成功、失败、不存在任务行为固定）。
- stop：请求停止；运行中的图在当前工具完成并保存结果后不再启动新动作。

归并（B04）与发布（S1）命令拆到 ``cli/merge.py`` 与 ``cli/release.py``：
本入口只保留研发闭环命令与解析器装配，共享助手在 ``cli/common.py``
（模块长度自 2026-10-13 起只是结构报告里的审阅提示，不再是拆分理由）。

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

from forgeloop.cli.candidate import add_candidate_parser
from forgeloop.cli.common import open_store, records_root
from forgeloop.cli.deploy import add_deploy_parser
from forgeloop.cli.mail import add_mail_parser
from forgeloop.cli.merge import add_merge_parser, merge_section
from forgeloop.cli.release import cmd_release, release_section
from forgeloop.cli.requirements import (
    add_requirement_dispatch,
    add_requirement_retry,
    aggregate_missing,
    budget_summary_line,
    dependency_section,
    requirement_dependency_sections,
    requirement_retry_section,
    requirement_task_evidence_section,
    task_budget_summary,
    task_status_reason,
)
from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.domain.delivery import (
    DeliveryBinding,
    RequirementDelivery,
    assess_requirement_acceptance,
)
from forgeloop.domain.dependency_facts import assess_dependency
from forgeloop.domain.requirement import (
    BLOCKED,
    RequirementError,
    RequirementNotFoundError,
)
from forgeloop.domain.status import ActionActor, NextAction, next_action
from forgeloop.domain.task_plan import TaskPlan, TaskPlanApproval
from forgeloop.graph.builder import RequirementTaskRunner, build_graph, requirement_task_id
from forgeloop.graph.dispatch import DEFAULT_DELIVERY_TIMEOUT_SECONDS
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.planning import PlanningContext, analyze_requirement, plan_requirement
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
)
from forgeloop.graph.state import TaskState
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore

DEFAULT_RECORDS_ROOT = ".forgeloop"
DEFAULT_LIMIT_SECONDS = 7200.0
# 需求整体验收通过后的状态（契约精简集合 §4）；由 ``requirement accept`` 写入。
REQUIREMENT_ACCEPTED = "accepted"
# 契约 §4 的需求终态：整体验收通过或明确拒绝后不再回退到执行中。
REQUIREMENT_TERMINAL_STATUSES = frozenset({REQUIREMENT_ACCEPTED, "rejected"})


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
    """待决定说明；读取检查点失败时报到 stderr，不静默假装没有待决定节点。"""

    try:
        snapshot = graph.get_state(_run_config(task_id))
    except Exception as error:  # 检查点读取是框架/IO 边界，异常种类不可穷举；必须可见
        print(
            f"状态读取失败: {type(error).__name__}: {error}"
            "（本次决定已记录；待决定节点未知，请重跑 status 核对）",
            file=sys.stderr,
        )
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
    root = records_root(args)
    original_input = _read_input(args.input)
    if args.project_path:
        source = Path(args.project_path)
        if not source.is_dir() or not (source / ".git").exists():
            raise SystemExit(f"project_path 不是 git 仓库: {source}")
    if args.pi_timeout_seconds is not None and args.pi_timeout_seconds < 0:
        raise SystemExit("--pi-timeout-seconds 不能为负")
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
        "pi_timeout_seconds": str(args.pi_timeout_seconds or ""),
    }
    store = RecordStore(root / "records.sqlite")
    try:
        store.create_task(task_id, args.project, original_input, config, args.limit_seconds)
        ctx = NodeContext.for_task(store, root, task_id)
        graph = build_graph(ctx, root / "checkpoints.sqlite")
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


def cmd_approve(args: argparse.Namespace) -> int:
    stage = ApprovalStage(args.stage)
    resume_decision = "approved" if stage is ApprovalStage.PLAN else "accepted"
    if args.decision == "rejected":
        resume_decision = "rejected"
    root = records_root(args)
    store = open_store(root, args.task_id)
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
    _resume_graph(root, args.task_id, {"decision": resume_decision})
    return 0


def cmd_grant(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = open_store(root, args.task_id)
    try:
        ledger = store.ledger(args.task_id)
        print(
            f"追加授权前：累计失败 {ledger.cumulative_failures}，"
            f"授权次数 {ledger.grant_count}（历史保留，不清零）。"
        )
    finally:
        store.close()
    _resume_graph(root, args.task_id, {"decision": "grant"})
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
    stop = store.outcomes.stop_record(task_id)
    if stop is None:
        return None
    requested_at, confirmed_at, note = stop
    return {
        "requested_at": requested_at.isoformat(),
        "confirmed_at": confirmed_at.isoformat() if confirmed_at else None,
        "note": note,
    }


def _delivery_section(store: RecordStore, task_id: str) -> dict | None:
    delivery = store.outcomes.delivery(task_id)
    if delivery is None:
        return None
    diff_path, report_path, delivered_at = delivery
    return {
        "diff_path": diff_path,
        "report_path": report_path,
        "delivered_at": delivered_at.isoformat(),
    }


def _next_action_section(status: str) -> dict:
    """下一步动作、动作主体与阻塞/等待原因（G01：状态查询说明需要谁做什么）。"""

    action = next_action(status)
    return {
        "action": action.action,
        "actor": action.actor.value,
        "reason": action.reason,
    }


def _status_document(store: RecordStore, task_id: str) -> dict:
    task = store.get_task(task_id)
    if task is None:
        return {"task_id": task_id, "error": "task_not_found"}
    dependency = _task_dependency_section(store, task_id)
    evidence = _task_evidence_section(store, task_id)
    return {
        "task_id": task_id,
        "project": task.project,
        "status": task.status,
        "next_action": _next_action_section(task.status),
        # G03 追加：domain 阻断原因文本（只读派生），既有字段名称与语义不变。
        "blocked_reason_text": task_status_reason(store, task_id)["blocked_reason_text"],
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
        "merge": merge_section(store, task_id),
        "release": release_section(store, task_id),
        # G02 cli-contract：单任务查询同样追加依赖事实、交付证据身份与 missing。
        # 新字段追加、字段名小写下划线、时间 ISO8601；既有字段语义不变。
        "dependency": dependency,
        "evidence": evidence,
        "missing": aggregate_missing(
            [{"task_id": task_id, "dependency": dependency, "evidence": evidence}]
        ),
    }


def _task_dependency_section(store: RecordStore, task_id: str) -> dict:
    """单任务依赖事实与阻塞判断：只读权威记录，纯规则判定。

    单任务没有声明式前置（前置在需求任务包层），因此判定只反映未完成动作与
    依据完整性；记录存在时不会出现 ``unknown``。
    """

    record = store.task_dependency_record(task_id)
    facts = assess_dependency(
        task_id,
        (),
        outstanding_action=record.outstanding_action,
        subject_evidence=record.evidence,
        missing_evidence=record.missing,
        recorded_status=record.status,
        failure_rounds=record.failure_rounds,
    )
    return dependency_section(facts)


def _task_evidence_section(store: RecordStore, task_id: str) -> dict:
    """单任务交付证据身份：现场材料只读汇总，缺失逐项列入 ``missing``。"""

    plan = store.latest_plan(task_id)
    plan_version = plan.version if plan is not None else 0
    return requirement_task_evidence_section(
        store.root, store, task_id, task_id, None, plan_version
    )


def cmd_status(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = RecordStore(root / "records.sqlite")
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
    print(f"阻断原因: {document['blocked_reason_text']}")
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
    if document["release"]:
        release = document["release"]
        pushed = "成功" if release["pushed"] else "未推送"
        print(f"发布: {release['tag']}（提交 {release['merge_commit'][:12]}，标签推送 {pushed}）")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = open_store(root, args.task_id)
    try:
        store.outcomes.request_stop(args.task_id, args.note or "")
        print(f"停止请求已记录: {args.task_id}")
        print("当前工具完成并保存结果后将不再启动新动作；结果不明确时保留现场待核对。")
    finally:
        store.close()
    return 0


# ---- 需求研发线（I01 真实入口）：受理、澄清、批准、任务推进、状态回查 ----


def _open_requirement(root: Path, req_id: str) -> RequirementStore:
    """打开需求记录并确认身份存在；未知身份确定失败，不返回空结果。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        store.get(req_id)
    except RequirementNotFoundError as error:
        store.close()
        raise SystemExit(f"需求不存在: {req_id}") from error
    return store


def _planning_context(
    args: argparse.Namespace, root: Path, store: RequirementStore
) -> PlanningContext:
    return PlanningContext(
        store,
        args.req_id,
        root / "requirements" / args.req_id / "analysis",
        _decode_command(args.pi_command, "--pi-command"),
        timeout_seconds=args.pi_timeout_seconds,
    )


def cmd_requirement_submit(args: argparse.Namespace) -> int:
    root = records_root(args)
    text = _read_input(args.input)
    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(args.project, text)
    finally:
        store.close()
    print(f"需求已创建: {requirement.req_id}")
    print("下一步: 只读分析（clarify 缺的关键信息）。")
    return 0


def cmd_requirement_revise(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    try:
        updated = store.append(args.req_id, _read_input(args.input))
    finally:
        store.close()
    print(f"需求已修订: {updated.req_id}（版本 {updated.version_count}）")
    return 0


def cmd_requirement_analyze(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    try:
        outcome = analyze_requirement(_planning_context(args, root, store))
    finally:
        store.close()
    if outcome.analysis is None:
        print(f"分析未完成: {outcome.halted_reason}")
        return 1
    print(f"需求状态: {outcome.requirement_status}")
    print(f"目标: {outcome.analysis.goal}")
    if outcome.needs_clarification:
        for question in outcome.analysis.clarifications:
            print(f"待澄清: {question}")
        print("澄清命令: forgeloop requirement revise <req_id> --input ...")
    else:
        print("分析已就绪，可生成任务包。")
    return 0


def cmd_requirement_plan(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    try:
        outcome = plan_requirement(_planning_context(args, root, store))
    finally:
        store.close()
    if outcome.plan is None:
        print(f"任务规划未完成: {outcome.halted_reason}")
        return 1
    plan = outcome.plan
    print(f"任务包 v{plan.plan_version}（{len(plan.tasks)} 个任务）已生成，等待批准。")
    for task in plan.tasks:
        print(f"- {task.task_id}: {task.goal}")
    print(f"批准命令: forgeloop requirement approve {args.req_id}")
    return 0


def cmd_requirement_approve(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    try:
        plan = store.latest_task_plan(args.req_id)
        if plan is None:
            raise SystemExit("需求尚无任务包，无法批准")
        approval = store.record_plan_approval(
            args.req_id, plan.plan_version, args.by, source=args.source
        )
        print(f"任务包 v{plan.plan_version} 已批准（授权来源 {approval.authorization_source}）。")
    finally:
        store.close()
    return 0


def cmd_requirement_advance(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    record_store = RecordStore(root / "records.sqlite")
    try:
        requirement = store.get(args.req_id)
        plan = store.latest_task_plan(args.req_id)
        runner = RequirementTaskRunner(
            records_root=root,
            req_id=args.req_id,
            plan_version=plan.plan_version if plan else 0,
            project=requirement.project,
            pi_command=_decode_command(args.pi_command, "--pi-command"),
            project_path=args.project_path,
            baseline=args.baseline,
            pi_timeout_seconds=args.pi_timeout_seconds or None,
        )
        executor = RequirementExecutor(store, args.req_id, runner, slots=record_store.actions)
        status = store.requirement_status(args.req_id)
        if status in REQUIREMENT_TERMINAL_STATUSES:
            # 终态不回退：整体验收已完成（或已拒绝）后重复推进只做只读回查，
            # 不把 accepted/rejected 覆盖成 executing；后续归并/发布在候选/任务层（契约 §4）。
            progress = executor.progress()
            next_step = _terminal_next_step(status)
            requirement_status = status
        else:
            progress = executor.advance()
            next_step = progress.next_step
            requirement_status = progress.requirement_status
    except RequirementAlreadyRunningError as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        record_store.close()
        store.close()
    print(f"需求状态: {requirement_status}")
    print(f"当前任务: {progress.current_task or '无'}")
    print(f"已完成: {'、'.join(progress.completed_tasks) or '无'}")
    print(f"下一步: {next_step.action}（{next_step.actor.value}）")
    if progress.blocked_reason:
        print(f"原因: {progress.blocked_reason}")
    return 0 if requirement_status != BLOCKED else 1


def _terminal_next_step(status: str) -> NextAction:
    """需求终态的下一步：整体验收通过后归并发布；其余终态交人工处理。"""

    if status == REQUIREMENT_ACCEPTED:
        return NextAction("归并并发布已验收任务", ActionActor.AGENT, "需求整体验收已完成")
    return NextAction("人工处理需求终态", ActionActor.USER, f"需求已处于终态: {status}")


def _read_only_runner(execution: TaskExecution) -> TaskResult:  # pragma: no cover - 只读汇总
    raise AssertionError("status 查询不得执行任何任务")


def _requirement_delivery(
    store: RequirementStore, record_store: RecordStore, req_id: str
) -> tuple[RequirementDelivery, str]:
    """把需求内全部任务映射为交付汇总；缺任一任务材料即明确报告，不部分验收。"""

    plan: TaskPlan | None = store.latest_task_plan(req_id)
    if plan is None:
        return RequirementDelivery(req_id), "需求尚无任务包，无法整体验收"
    deliveries = []
    for task in plan.tasks:
        single_task_id = requirement_task_id(req_id, plan.plan_version, task.task_id)
        delivery = record_store.task_delivery(single_task_id)
        if delivery is None:
            return RequirementDelivery(req_id), f"任务 {task.task_id} 尚无已消费的验收材料"
        deliveries.append(delivery)
    return RequirementDelivery(req_id, tuple(deliveries)), ""


def cmd_requirement_accept(args: argparse.Namespace) -> int:
    """需求整体验收：全部任务已验收且材料与批准一致时置 ``accepted``。"""

    root = records_root(args)
    store = _open_requirement(root, args.req_id)
    record_store = RecordStore(root / "records.sqlite")
    try:
        delivery, incomplete = _requirement_delivery(store, record_store, args.req_id)
        if incomplete:
            print(f"需求整体验收被拒绝: {incomplete}")
            return 1
        # 批准绑定：整体验收必须由当前有效批准驱动。需求一经修订，已批准任务包
        # 立即失效（契约 §5.3），即使各任务材料齐全也不得据此完成整体验收。
        authorization = store.plan_authorization(args.req_id)
        if not authorization.can_execute:
            print(f"需求整体验收被拒绝: {authorization.reason}")
            return 1
        current: dict[str, DeliveryBinding] = {
            item.binding.task_id: record_store.capture_delivery_binding(
                item.binding.task_id, item.binding.plan_version
            )
            for item in delivery.deliveries
        }
        decision = assess_requirement_acceptance(delivery, current_bindings=current)
        if not decision.allowed:
            print(f"需求整体验收被拒绝: {decision.reason}")
            return 1
        store.set_requirement_status(args.req_id, REQUIREMENT_ACCEPTED, "")
        print(f"需求整体验收通过: {args.req_id}")
        print(f"依据: {decision.reason}")
        print("下一步: 归并并发布已验收任务。")
        return 0
    finally:
        record_store.close()
        store.close()


def _requirement_approval_section(approval: TaskPlanApproval | None) -> dict | None:
    if approval is None:
        return None
    return {
        "plan_version": approval.plan_version,
        "approved_by": approval.approved_by,
        "source": approval.source,
    }


def _requirement_analysis_section(store: RequirementStore, req_id: str) -> dict | None:
    analysis = store.latest_analysis(req_id)
    if analysis is None:
        return None
    return {
        "analysis_version": analysis.analysis_version,
        "requirement_version": analysis.requirement_version,
        "goal": analysis.goal,
        "scenarios": list(analysis.scenarios),
        "acceptance_criteria": list(analysis.acceptance_criteria),
        "clarifications": list(analysis.clarifications),
        "needs_clarification": analysis.needs_clarification,
    }


def _requirement_plan_section(store: RequirementStore, req_id: str) -> dict | None:
    plan = store.latest_task_plan(req_id)
    if plan is None:
        return None
    return {
        "plan_version": plan.plan_version,
        "tasks": [
            {
                "task_id": task.task_id,
                "goal": task.goal,
                "files": list(task.files),
                "acceptance": task.acceptance,
                "test_command": list(task.test_command),
                "depends_on": list(task.depends_on),
                "authorization_source": task.authorization_source,
            }
            for task in plan.tasks
        ],
    }


def _requirement_artifact_section(artifact: TaskArtifact | None) -> dict | None:
    if artifact is None:
        return None
    return {
        "candidate_sha256": artifact.candidate_sha256,
        "test_evidence_sha256": artifact.test_evidence_sha256,
        "review_sha256": artifact.review_sha256,
        "acceptance": artifact.acceptance,
        "authorization_source": artifact.authorization_source,
    }


def _requirement_single_task(store: RecordStore, task_id: str) -> dict | None:
    """映射出的单任务记录摘要（归并/发布状态从同一权威记录回查）。"""

    task = store.get_task(task_id)
    if task is None:
        return None
    return {
        "status": task.status,
        "delivery": _delivery_section(store, task_id),
        "merge": merge_section(store, task_id),
        "release": release_section(store, task_id),
    }


def _requirement_tasks_section(root: Path, store: RequirementStore, req_id: str) -> list[dict]:
    plan = store.latest_task_plan(req_id)
    if plan is None:
        return []
    runs = {run.task_id: run for run in store.task_runs(req_id, plan.plan_version)}
    artifacts = {item.task_id: item for item in store.task_artifacts(req_id, plan.plan_version)}
    dependencies = requirement_dependency_sections(store, req_id, plan)
    record_store = RecordStore(root / "records.sqlite")
    try:
        entries: list[dict] = []
        for task in plan.tasks:
            run = runs.get(task.task_id)
            single_task_id = requirement_task_id(req_id, plan.plan_version, task.task_id)
            artifact = artifacts.get(task.task_id)
            task_state = run.state if run else "pending"
            single_task = _requirement_single_task(record_store, single_task_id)
            # 工时摘要的状态源：存在映射单任务时以单任务权威状态为准（需求侧推进会
            # 记录只在任务返回后写入，任务执行中会缺 run，用 run 状态会误报冲突）；
            # 仅在无单任务记录时回退到需求侧任务状态，保留 not_started/unknown 分支。
            budget_status = single_task["status"] if single_task else task_state
            entries.append(
                {
                    "task_id": task.task_id,
                    "state": task_state,
                    "reason": run.reason if run else "",
                    "executed_seconds": run.executed_seconds if run else 0.0,
                    "artifact": _requirement_artifact_section(artifact),
                    "single_task_id": single_task_id,
                    "single_task": single_task,
                    # G03 追加：domain 工时摘要（只读派生），既有任务字段不变。
                    "budget_summary": task_budget_summary(
                        record_store, single_task_id, budget_status
                    ),
                    "dependency": dependencies[task.task_id],
                    "blocked_reason_text": task_status_reason(
                        record_store,
                        single_task_id,
                        unmet_prerequisites=tuple(
                            dependencies[task.task_id]["unmet_prerequisites"]
                        ),
                    )["blocked_reason_text"],
                    "evidence": requirement_task_evidence_section(
                        root,
                        record_store,
                        task.task_id,
                        single_task_id,
                        artifact,
                        plan.plan_version,
                    ),
                }
            )
    finally:
        record_store.close()
    return entries


def _requirement_document(root: Path, store: RequirementStore, req_id: str) -> dict:
    try:
        requirement = store.get(req_id)
        status = store.requirement_status(req_id)
    except RequirementNotFoundError:
        return {"req_id": req_id, "error": "requirement_not_found"}
    authorization = store.plan_authorization(req_id)
    budget: dict | None = None
    try:
        ledger = store.requirement_budget(req_id)
    except RequirementError:
        pass
    else:
        budget = {
            "limit_seconds": ledger.limit_seconds,
            "consumed_seconds": ledger.consumed_seconds,
        }
    progress = RequirementExecutor(store, req_id, _read_only_runner).progress()
    next_step = progress.next_step
    if status == REQUIREMENT_ACCEPTED:
        next_step = NextAction("归并并发布已验收任务", ActionActor.AGENT, "需求整体验收已完成")
    tasks = _requirement_tasks_section(root, store, req_id)
    return {
        "req_id": req_id,
        "project": requirement.project,
        "requirement_status": status,
        "blocked_reason": store.blocked_reason(req_id),
        "blocked_reason_text": progress.blocked_reason or next_step.reason,
        "versions": [{"version": v.version, "text": v.text} for v in requirement.versions],
        "analysis": _requirement_analysis_section(store, req_id),
        "plan": _requirement_plan_section(store, req_id),
        "approval": _requirement_approval_section(store.plan_approval(req_id)),
        "authorization": {
            "can_execute": authorization.can_execute,
            "reason": authorization.reason,
        },
        "budget": budget,
        "tasks": tasks,
        "next_step": {
            "action": next_step.action,
            "actor": next_step.actor.value,
            "reason": next_step.reason,
        },
        # 6ba1fd 追加：最近一次人工续跑决定（只读回查），无决定为 null。
        "retry": requirement_retry_section(root, req_id),
        "missing": aggregate_missing(tasks),
    }


def cmd_requirement_status(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = RequirementStore(root / "records.sqlite")
    try:
        document = _requirement_document(root, store, args.req_id)
    finally:
        store.close()
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return 0 if "error" not in document else 1
    if "error" in document:
        print(f"需求不存在: {args.req_id}", file=sys.stderr)
        return 1
    print(f"需求: {document['req_id']}（项目: {document['project']}）")
    print(f"状态: {document['requirement_status']}")
    if document["blocked_reason"]:
        print(f"阻塞原因: {document['blocked_reason']}")
    if document["analysis"]:
        print(f"目标: {document['analysis']['goal']}")
    if document["plan"]:
        print(f"任务包版本: {document['plan']['plan_version']}")
        for entry in document["tasks"]:
            print(f"- {entry['task_id']}: {entry['state']}")
            print(f"  工时: {budget_summary_line(entry['budget_summary'])}")
            print(f"  阻断原因: {entry['blocked_reason_text']}")
    print(f"下一步: {document['next_step']['action']}（{document['next_step']['actor']}）")
    if document["retry"]:
        retry = document["retry"]
        print(
            f"最近人工续跑: 任务 {retry['task_id']}，by={retry['decided_by']}，"
            f"时间 {retry['decided_at']}，理由 {retry['reason']}"
        )
    return 0


def _add_requirement_parsers(
    subparsers: argparse._SubParsersAction, default_records_root: str
) -> None:
    requirement = subparsers.add_parser("requirement", help="需求研发线：受理、澄清、批准、推进")
    actions = requirement.add_subparsers(dest="requirement_command", required=True)

    submit = actions.add_parser("submit", help="受理需求原文并分配需求身份")
    submit.add_argument("--project", required=True, help="需求绑定的项目名")
    submit.add_argument("--input", required=True, help="需求正文；@path 读取 UTF-8 文本文件")
    submit.add_argument("--records-root", default=default_records_root)
    submit.set_defaults(func=cmd_requirement_submit)

    revise = actions.add_parser("revise", help="追加澄清回答或修订（保留历史版本）")
    revise.add_argument("req_id")
    revise.add_argument("--input", required=True, help="澄清回答或修订正文；@path 读取文件")
    revise.add_argument("--records-root", default=default_records_root)
    revise.set_defaults(func=cmd_requirement_revise)

    analyze = actions.add_parser("analyze", help="只读分析（PI）并记录结构化结论")
    analyze.add_argument("req_id")
    analyze.add_argument("--pi-command", required=True, help="PI RPC 启动命令（JSON 数组）")
    analyze.add_argument("--pi-timeout-seconds", type=float, default=300.0)
    analyze.add_argument("--records-root", default=default_records_root)
    analyze.set_defaults(func=cmd_requirement_analyze)

    plan = actions.add_parser("plan", help="从就绪分析生成任务包（PI）")
    plan.add_argument("req_id")
    plan.add_argument("--pi-command", required=True, help="PI RPC 启动命令（JSON 数组）")
    plan.add_argument("--pi-timeout-seconds", type=float, default=300.0)
    plan.add_argument("--records-root", default=default_records_root)
    plan.set_defaults(func=cmd_requirement_plan)

    approve = actions.add_parser("approve", help="批准任务包（绑定需求身份与版本）")
    approve.add_argument("req_id")
    approve.add_argument("--by", default="owner", help="批准人身份")
    approve.add_argument("--source", default="", help="批准来源批次")
    approve.add_argument("--records-root", default=default_records_root)
    approve.set_defaults(func=cmd_requirement_approve)

    advance = actions.add_parser("advance", help="按依赖推进任务（接单任务业务图，含验收）")
    advance.add_argument("req_id")
    advance.add_argument("--pi-command", required=True, help="PI RPC 启动命令（JSON 数组）")
    advance.add_argument("--project-path", default="", help="被开发项目路径")
    advance.add_argument("--baseline", default="", help="代码基线")
    advance.add_argument("--pi-timeout-seconds", type=float, default=0.0)
    advance.add_argument("--records-root", default=default_records_root)
    advance.set_defaults(func=cmd_requirement_advance)

    accept = actions.add_parser("accept", help="需求整体验收（全部任务验收且材料一致）")
    accept.add_argument("req_id")
    accept.add_argument("--records-root", default=default_records_root)
    accept.set_defaults(func=cmd_requirement_accept)

    status = actions.add_parser("status", help="回查需求状态与任务推进记录")
    status.add_argument("req_id")
    status.add_argument("--json", action="store_true", help="输出完整 JSON")
    status.add_argument("--records-root", default=default_records_root)
    status.set_defaults(func=cmd_requirement_status)

    add_requirement_dispatch(actions, default_records_root)
    add_requirement_retry(actions, default_records_root)


def _add_submit_parser(subparsers: argparse._SubParsersAction) -> None:
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
    submit.add_argument(
        "--pi-timeout-seconds",
        type=float,
        default=None,
        help="单次 PI 调用等待上限（秒）；缺省 300，非法或缺失回落到缺省",
    )
    submit.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT, help="记录根目录")
    submit.set_defaults(func=cmd_submit)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="forgeloop",
        description="ForgeLoop：CLI 自动研发闭环（提交、批准、查询、停止）",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    _add_submit_parser(subparsers)

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

    add_merge_parser(subparsers, DEFAULT_RECORDS_ROOT)

    release = subparsers.add_parser("release", help="验收归并后受控发布：创建并推送版本标签（S1）")
    release.add_argument("task_id")
    release.add_argument(
        "--tag", required=True, help="版本标签：vMAJOR.MINOR.PATCH，须与项目版本一致"
    )
    release.add_argument("--message", default="", help="标签注释（缺省 chore(release): <tag>）")
    release.add_argument("--no-push", action="store_true", help="只创建本地标签，不推送远程")
    release.add_argument(
        "--delivery-timeout",
        type=float,
        default=DEFAULT_DELIVERY_TIMEOUT_SECONDS,
        help="等待同项目交付互斥的上限秒数（超时拒绝，不并发更新主干）",
    )
    release.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    release.set_defaults(func=cmd_release)

    stop = subparsers.add_parser("stop", help="请求停止（当前工具完成后生效）")
    stop.add_argument("task_id")
    stop.add_argument("--note", default="", help="停止原因备注")
    stop.add_argument("--records-root", default=DEFAULT_RECORDS_ROOT)
    stop.set_defaults(func=cmd_stop)

    add_deploy_parser(subparsers, DEFAULT_RECORDS_ROOT)

    add_candidate_parser(subparsers, DEFAULT_RECORDS_ROOT)

    add_mail_parser(subparsers, DEFAULT_RECORDS_ROOT)

    _add_requirement_parsers(subparsers, DEFAULT_RECORDS_ROOT)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
