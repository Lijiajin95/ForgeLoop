"""需求线的 CLI 命令实现：并行推进（A05）与人工续跑（6ba1fd）。

职责边界：

- 复用 ``graph.dispatch.RequirementDispatcher`` 并行推进多条需求；每条需求仍走
  ``graph.builder.RequirementTaskRunner`` 的单任务业务图，不新增业务规则。
- 同需求重复启动由记录层执行槽位拒绝，命令如实报告并以非零退出码结束。
- 状态输出来自 ``RequirementProgress``（权威记录汇总），不由模型猜测。
- ``requirement retry`` 在 records 层 fail-closed 校验与决定记录（``authorize_retry``）
  之后，先把该任务仍未完成的动作按同一理由人工释放（``release_outstanding_action``，
  置为 ``released`` 并写回审计），再用 ``graph.requirements.RequirementExecutor`` 从
  检查点就地续跑；命令本身不新增续跑或释放规则。

同项目归并/发布的互斥由 ``RequirementDispatcher.project_delivery`` 提供，并已接入
``cli.merge``/``cli.release`` 的真实入口；本模块把并行推进与槽位核对接进 CLI。
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from forgeloop.cli.common import records_root
from forgeloop.domain.agent_runtime import AgentRuntimeError
from forgeloop.domain.budget_summary import (
    BudgetSummary,
    BudgetSummaryState,
    summarize_budget,
)
from forgeloop.domain.dependency_facts import DependencyFacts
from forgeloop.domain.requirement import BLOCKED, RequirementNotFoundError
from forgeloop.domain.status_reason import StatusReason, derive_status_reason
from forgeloop.domain.task_plan import TaskPlan, TaskPlanNotFoundError
from forgeloop.graph.builder import RequirementTaskRunner, requirement_task_id
from forgeloop.graph.dispatch import RequirementDispatcher
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    RequirementExecutor,
)
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.checkpoints import (
    INTERRUPTED,
    CheckpointHealth,
    CheckpointInspection,
    RetryAuthorization,
    authorize_retry,
    inspect_checkpoint,
    latest_retry_decision,
    outstanding_action_node,
    outstanding_actions,
    release_action,
    release_outstanding_action,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact
from forgeloop.records.store import RecordStore


def _decode_pi_command(raw: str) -> tuple[str, ...]:
    """解析 PI RPC 启动命令（可缺省）。

    空串返回空元组：运行状态可能已切到 DSH，此时真正用的命令来自运行状态或
    ``FORGELOOP_DSH_COMMAND``；缺可用命令时由 ``graph.agent_execution`` 在动作
    启动前 fail-closed，不在这里猜。
    """

    if raw is None or not str(raw).strip():
        return ()
    try:
        command = json.loads(str(raw))
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


def cmd_requirement_actions_list(args: argparse.Namespace) -> int:
    """列出未完成动作（任务身份、节点、开始时间、动作 ID），供中断后人工核对。"""

    root = records_root(args)
    actions = outstanding_actions(root, task_id=args.task or None)
    if not actions:
        print("没有未完成动作。")
        return 0
    for action in actions:
        print(f"动作: {action.action_id}")
        print(f"  任务: {action.task_id}")
        print(f"  节点: {action.node}")
        print(f"  开始: {action.started_at.isoformat()}")
        print(
            "  释放: forgeloop requirement actions clear"
            f" --task {action.task_id} --action {action.action_id}"
            " --by <by> --reason <reason>"
        )
    return 0


def cmd_requirement_actions_clear(args: argparse.Namespace) -> int:
    """人工核对后释放一个未完成动作并写回审计；缺理由或身份不明时 fail-closed。"""

    root = records_root(args)
    if args.action:
        result = release_action(
            root,
            task_id=args.task,
            action_id=args.action,
            by=args.by,
            reason=args.reason,
        )
    else:
        result = release_outstanding_action(root, task_id=args.task, by=args.by, reason=args.reason)
    if not result.allowed or result.release is None:
        print("人工核对释放被拒绝（fail-closed）：", file=sys.stderr)
        for reason in result.check.reasons:
            print(f"- {reason}", file=sys.stderr)
        return 1
    release = result.release
    print(
        f"已释放未完成动作: {release.action_id}（任务 {release.task_id}，"
        f"节点 {release.node}，by={release.released_by}，"
        f"时间 {release.released_at.isoformat()}）"
    )
    print(f"理由: {release.reason}")
    return 0


# ---- 人工续跑（6ba1fd）：fail-closed 校验、记录决定并就地续跑 ----
#
# 执行次序固定：校验通过 → 记录人工决定 → 清除 halted_reason → 从检查点就地续跑。
# 取值错误、状态不符或检查点不可信都在写入任何记录、改动任何现场之前拒绝
# （fail-closed）。判定与「校验失败零副作用」由 records 层 ``authorize_retry`` 承担；
# 本层负责把拒绝原因转成可操作提示，并在放行后立即驱动 ``RequirementExecutor``。
#
# 省略 ``--task`` 时只接受「需求恰有一个中断任务」：0 个或多个都拒绝并列出候选，
# 绝不猜测任务身份。


@dataclass(frozen=True)
class RetryCandidate:
    """可人工续跑的中断任务候选：逻辑任务身份、单任务身份与现场事实。"""

    task_id: str
    thread_id: str
    task_status: str
    halted_reason: str

    @property
    def is_halted(self) -> bool:
        return bool(self.halted_reason.strip())

    @property
    def is_interrupted(self) -> bool:
        return self.is_halted or self.task_status == INTERRUPTED


def _retry_candidates(
    root: Path,
    req_id: str,
    plan: TaskPlan,
    record_store: RecordStore,
) -> tuple[RetryCandidate, ...]:
    """只读汇总任务包内每个任务的现场：是否中断、单任务状态与检查点原因。

    「中断」判定同时看权威记录状态与检查点原因：任一表明中断即列入候选，因此
    检查点不可信（缺失/损坏）但记录仍为 ``interrupted`` 的任务也会被列出，交由后续
    校验 fail-closed 拒绝并提示人工处置，而不是静默漏报。
    """

    candidates: list[RetryCandidate] = []
    for task in plan.tasks:
        thread_id = requirement_task_id(req_id, plan.plan_version, task.task_id)
        state = inspect_checkpoint(root, thread_id).state
        record = record_store.get_task(thread_id)
        candidates.append(
            RetryCandidate(
                task_id=task.task_id,
                thread_id=thread_id,
                task_status=record.status if record is not None else "unknown",
                halted_reason=state.halted_reason if state is not None else "",
            )
        )
    return tuple(candidates)


def _format_retry_candidate(candidate: RetryCandidate) -> str:
    detail = f"状态 {candidate.task_status}"
    if candidate.is_halted:
        detail += f"，中断原因 {candidate.halted_reason}"
    return f"- {candidate.task_id}（单任务 {candidate.thread_id}，{detail}）"


def _print_retry_candidates(candidates: tuple[RetryCandidate, ...]) -> None:
    for candidate in candidates:
        print(_format_retry_candidate(candidate), file=sys.stderr)


def _select_retry_candidate(
    candidates: tuple[RetryCandidate, ...],
) -> RetryCandidate | None:
    """按「恰有一个中断任务」选择；0 个或多个时列出候选并返回 ``None``。"""

    interrupted = tuple(candidate for candidate in candidates if candidate.is_interrupted)
    if len(interrupted) == 1:
        return interrupted[0]
    if not interrupted:
        print("人工续跑被拒绝：需求当前没有处于中断状态的任务。", file=sys.stderr)
        if candidates:
            print("任务包内任务:", file=sys.stderr)
            _print_retry_candidates(candidates)
    else:
        print(
            "人工续跑被拒绝：省略 --task 时要求需求恰有一个中断任务，"
            f"实际发现 {len(interrupted)} 个。",
            file=sys.stderr,
        )
        print("中断任务候选:", file=sys.stderr)
        _print_retry_candidates(interrupted)
    print("请用 `--task <task_id>` 指定要续跑的任务后重试。", file=sys.stderr)
    return None


def _print_retry_rejection(
    root: Path,
    req_id: str,
    outcome: RetryAuthorization,
    inspection: CheckpointInspection,
) -> None:
    """把 fail-closed 拒绝原因与人工处置路径写 stderr；不写记录、不改现场。"""

    print("人工续跑被拒绝（fail-closed）：", file=sys.stderr)
    for reason in outcome.check.reasons:
        print(f"- {reason}", file=sys.stderr)
    checkpoint_untrusted = inspection.health is not CheckpointHealth.OK or any(
        reason.startswith("检查点") for reason in outcome.check.reasons
    )
    if checkpoint_untrusted:
        print(
            "检查点不可信：请用 "
            f"`forgeloop requirement slot list --records-root {root}` 核对现场；"
            "确认没有推进在运行后，必要时用 "
            f"`forgeloop requirement slot clear --slot requirement:{req_id}` "
            "清理残留槽位，再人工核对检查点后重试。",
            file=sys.stderr,
        )
    else:
        print(
            "请按上述原因人工处置后重试；未通过校验不会记录决定，也不会清除 halted_reason。",
            file=sys.stderr,
        )


def cmd_requirement_retry(args: argparse.Namespace) -> int:
    """人工续跑一条需求内被中断的任务：校验、记录决定并立即就地续跑。"""

    root = records_root(args)
    # --pi-command 可省略（运行状态可能已切到 DSH）；内容非法在此确定失败，
    # 尚未写任何记录。真正缺少可用运行时命令时由动作启动前的解析 fail-closed。
    pi_command = _decode_pi_command(args.pi_command)
    store = RequirementStore(root / "records.sqlite")
    record_store = RecordStore(root / "records.sqlite")
    try:
        try:
            requirement = store.get(args.req_id)
        except RequirementNotFoundError:
            print(f"需求不存在: {args.req_id}", file=sys.stderr)
            return 1

        authorization = store.plan_authorization(args.req_id)
        plan = store.authorized_task_plan(args.req_id)
        if plan is None:
            print(
                f"人工续跑被拒绝（fail-closed）：{authorization.reason}",
                file=sys.stderr,
            )
            return 1

        candidates = _retry_candidates(root, args.req_id, plan, record_store)
        if args.task:
            try:
                task = plan.task(args.task)
            except TaskPlanNotFoundError:
                print(f"人工续跑被拒绝：任务包内没有任务 {args.task}", file=sys.stderr)
                print("任务包内任务:", file=sys.stderr)
                _print_retry_candidates(candidates)
                return 1
            selected = next(
                candidate for candidate in candidates if candidate.task_id == task.task_id
            )
        else:
            selected = _select_retry_candidate(candidates)
            if selected is None:
                return 1

        inspection = inspect_checkpoint(root, selected.thread_id)
        outcome = authorize_retry(
            root,
            inspection=inspection,
            requirement_id=args.req_id,
            task_id=selected.thread_id,
            plan_version=plan.plan_version,
            task_status=selected.task_status,
            by=args.by,
            reason=args.reason,
        )
        if not outcome.allowed or outcome.decision is None:
            _print_retry_rejection(root, args.req_id, outcome, inspection)
            return 1
        decision = outcome.decision
        print(f"实际处理任务: {selected.task_id}")
        print(f"单任务身份: {selected.thread_id}")
        print(
            f"人工续跑决定已记录: by={decision.decided_by}，"
            f"时间 {decision.decided_at.isoformat()}，理由 {decision.reason}"
        )

        # 记录决定后释放该任务仍未完成的动作：未完成动作是独立的阻塞事实，只清除
        # halted_reason 不足以解除 B03 红线。释放与决定使用同一人工理由，动作身份
        # 不明或与任务不匹配时 fail-closed 拒绝，不再启动真实执行器。
        if outstanding_action_node(root, selected.thread_id):
            released = release_outstanding_action(
                root,
                task_id=selected.thread_id,
                by=args.by,
                reason=args.reason,
            )
            if not released.allowed or released.release is None:
                print("人工核对释放未完成动作被拒绝（fail-closed）：", file=sys.stderr)
                for reason in released.check.reasons:
                    print(f"- {reason}", file=sys.stderr)
                return 1
            print(
                f"已释放未完成动作: {released.release.action_id}"
                f"（节点 {released.release.node}，by={released.release.released_by}，"
                f"时间 {released.release.released_at.isoformat()}）"
            )

        runner = RequirementTaskRunner(
            records_root=root,
            req_id=args.req_id,
            plan_version=plan.plan_version,
            project=requirement.project,
            pi_command=pi_command,
            project_path=args.project_path,
            baseline=args.baseline,
            pi_timeout_seconds=args.pi_timeout_seconds or None,
        )
        executor = RequirementExecutor(store, args.req_id, runner, slots=record_store.actions)
        try:
            progress = executor.advance()
        except RequirementAlreadyRunningError as error:
            print(str(error), file=sys.stderr)
            return 1
        except AgentRuntimeError as error:
            # 运行时配置缺失/非法：就地 fail-closed，不伪装续跑成功，也不重跑。
            print(f"人工续跑未启动执行器（运行时不可用）：{error}", file=sys.stderr)
            return 1
        print(f"需求状态: {progress.requirement_status}")
        print(f"当前任务: {progress.current_task or '无'}")
        print(f"已完成: {'、'.join(progress.completed_tasks) or '无'}")
        print(f"下一步: {progress.next_step.action}（{progress.next_step.actor.value}）")
        if progress.blocked_reason:
            print(f"原因: {progress.blocked_reason}")
        return 0 if progress.requirement_status != BLOCKED else 1
    finally:
        record_store.close()
        store.close()


def requirement_retry_section(root: Path, req_id: str) -> dict | None:
    """最近一次人工续跑决定（只读回查）；没有决定时返回 ``None``。"""

    latest = latest_retry_decision(root, req_id)
    if latest is None:
        return None
    return {
        "task_id": latest.task_id,
        "decided_by": latest.decided_by,
        "reason": latest.reason,
        "decided_at": latest.decided_at.isoformat(),
        "plan_version": latest.plan_version,
        "checkpoint_id": latest.checkpoint_id,
    }


def add_requirement_retry(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
) -> None:
    """把 ``requirement retry`` 子命令登记到需求子解析器上。"""

    retry = subparsers.add_parser(
        "retry",
        help="人工核对现场后续跑一条中断任务（必填 --by/--reason，立即续跑）",
    )
    retry.add_argument("req_id", help="需求身份")
    retry.add_argument(
        "--task",
        default="",
        help="任务包内任务身份；省略时要求需求恰有一个中断任务",
    )
    retry.add_argument("--by", required=True, help="调用方标识（如 owner）")
    retry.add_argument("--reason", required=True, help="人工续跑理由（不能为空白）")
    retry.add_argument(
        "--pi-command", default="", help="PI RPC 启动命令（JSON 数组）；运行状态为 DSH 时可省略"
    )
    retry.add_argument("--project-path", default="", help="被开发项目路径")
    retry.add_argument("--baseline", default="", help="代码基线")
    retry.add_argument("--pi-timeout-seconds", type=float, default=0.0)
    retry.add_argument("--records-root", default=default_records_root)
    retry.set_defaults(func=cmd_requirement_retry)


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
    except AgentRuntimeError as error:
        print(f"并行推进未启动执行器（运行时不可用）：{error}", file=sys.stderr)
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
    dispatch.add_argument(
        "--pi-command", default="", help="PI RPC 启动命令（JSON 数组）；运行状态为 DSH 时可省略"
    )
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


def add_requirement_actions(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
) -> None:
    """把 ``requirement actions list|clear`` 登记到需求子解析器上。

    与 ``requirement slot list|clear`` 同型：list 只读列出未完成动作（任务身份、
    节点、开始时间、动作 ID），clear 要求人工给出 ``--by``/``--reason`` 后才释放
    并写回审计；缺理由或动作身份不明由 records 层 fail-closed 拒绝。
    """

    actions = subparsers.add_parser(
        "actions", help="查看或人工释放未完成动作（中断后核对，释放写回审计）"
    )
    action_commands = actions.add_subparsers(dest="requirement_actions_command", required=True)

    action_list = action_commands.add_parser("list", help="列出仍未完成的任务动作")
    action_list.add_argument("--task", default="", help="只看某个单任务身份的动作")
    action_list.add_argument("--records-root", default=default_records_root)
    action_list.set_defaults(func=cmd_requirement_actions_list)

    action_clear = action_commands.add_parser(
        "clear", help="人工核对后释放一个未完成动作（必填 --task/--by/--reason）"
    )
    action_clear.add_argument("--task", required=True, help="动作所属的单任务身份")
    action_clear.add_argument(
        "--action",
        default="",
        help="动作 ID；省略时释放该任务当前的未完成动作",
    )
    action_clear.add_argument("--by", required=True, help="调用方标识（如 owner）")
    action_clear.add_argument("--reason", required=True, help="人工核对释放理由（不能为空白）")
    action_clear.add_argument("--records-root", default=default_records_root)
    action_clear.set_defaults(func=cmd_requirement_actions_clear)


# ---- 查询：依赖事实、阻塞判断与交付证据身份（G02 cli-contract） ----
#
# 新字段一律追加、字段名小写下划线、时间为 ISO8601；既有字段语义与状态词不变。
# 依赖事实由 ``RequirementStore.dependency_facts``/``RecordStore`` 只读取数、
# ``domain.dependency_facts`` 纯规则判定；证据身份由权威绑定记录加现场材料只读汇总。
# 任何一项缺失都显式列入 ``missing``，不省略字段、不猜测时间。

REVIEW_REPORT_NAME = "review-report.json"
TEST_EVIDENCE_NAME = "test-run.jsonl"
CANDIDATE_NAME = "candidate.diff"


def dependency_section(facts: DependencyFacts) -> dict:
    """把依赖事实纯规则结果映射为稳定 JSON 片段（新字段追加）。"""

    return {
        "task_id": facts.task_id,
        "verdict": facts.verdict.value,
        "is_waiting": facts.is_waiting,
        "is_running": facts.is_running,
        "is_unknown": facts.is_unknown,
        "unmet_prerequisites": list(facts.unmet_prerequisites),
        "outstanding_action": facts.outstanding_action,
        "recorded_status": facts.recorded_status,
        "failure_rounds": facts.failure_rounds,
        "evidence": list(facts.evidence),
        "missing": list(facts.missing_evidence),
    }


def requirement_dependency_sections(
    store: RequirementStore, req_id: str, plan: TaskPlan
) -> dict[str, dict]:
    """按任务包版本只读汇总每个任务的依赖事实与真实等待判定。"""

    facts = store.dependency_facts(
        req_id,
        plan.plan_version,
        single_task_id=lambda task_id: requirement_task_id(req_id, plan.plan_version, task_id),
    )
    return {item.task_id: dependency_section(item) for item in facts}


def _read_candidate_summary(task_dir: Path) -> str:
    """候选 diff 的内容摘要（文件数与增删行数）；缺失或空候选返回空串。"""

    path = task_dir / CANDIDATE_NAME
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    if not text.strip():
        return ""
    files = insertions = deletions = 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            files += 1
        elif line.startswith("+++") or line.startswith("---"):
            continue
        elif line.startswith("+"):
            insertions += 1
        elif line.startswith("-"):
            deletions += 1
    return f"{files} files changed, +{insertions} -{deletions}"


def _read_review_blocking(task_dir: Path) -> bool | None:
    """审查结论是否阻断；报告缺失、不可解析或结果不可用时返回 ``None``（不猜）。

    ``blocking_issues_valid`` 为假表示该轮审查未给出结构化阻断列表（审查节点据此
    中断），此时报告可能写入 ``blocking_issues: []``，不能据此判为"无阻断"；缺少该
    标志同样不可判定。两种情况都返回 ``None``，由调用方列入 ``review.blocking`` 缺失。
    """

    path = task_dir / REVIEW_REPORT_NAME
    if not path.is_file():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict):
        return None
    if document.get("blocking_issues_valid") is not True:
        return None
    issues = document.get("blocking_issues")
    if not isinstance(issues, list):
        return None
    return bool(issues)


def _read_test_result(task_dir: Path) -> tuple[str, int | None]:
    """正式测试证据最后一轮的结果与退出码；缺失/未知不推测为通过。"""

    path = task_dir / TEST_EVIDENCE_NAME
    if not path.is_file():
        return "missing", None
    try:
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        entry = json.loads(lines[-1]) if lines else None
    except (OSError, ValueError):
        return "unknown", None
    if not isinstance(entry, dict):
        return "unknown", None
    exit_code = entry.get("exit_code")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        return "unknown", None
    return ("passed" if exit_code == 0 else "failed"), exit_code


def evidence_section(
    task_id: str,
    *,
    candidate_summary: str,
    candidate_sha256: str,
    review_sha256: str,
    review_blocking: bool | None,
    test_evidence_sha256: str,
    test_result: str,
    test_exit_code: int | None,
    artifact_sha256: str,
    baseline_commit: str,
    acceptance_bound: bool,
    acceptance_accepted: bool,
    acceptance_plan_version: int | None,
    acceptance_fingerprint: str,
) -> dict:
    """交付证据身份汇总；缺哪一项都显式列入 ``missing``，字段永不省略。"""

    missing: list[str] = []
    if not candidate_summary:
        missing.append("candidate.summary")
    if not candidate_sha256:
        missing.append("candidate.sha256")
    if not review_sha256:
        missing.append("review.sha256")
    if review_blocking is None:
        missing.append("review.blocking")
    if not test_evidence_sha256:
        missing.append("test.sha256")
    if test_result in {"missing", "unknown"}:
        missing.append("test.result")
    if not artifact_sha256:
        missing.append("artifact.sha256")
    if not baseline_commit:
        missing.append("baseline_commit")
    if not acceptance_bound:
        missing.append("acceptance.binding")
    return {
        "task_id": task_id,
        "candidate": {"summary": candidate_summary, "sha256": candidate_sha256},
        "review": {"sha256": review_sha256, "blocking": review_blocking},
        "test": {
            "sha256": test_evidence_sha256,
            "result": test_result,
            "exit_code": test_exit_code,
        },
        "artifact": {"sha256": artifact_sha256},
        "baseline_commit": baseline_commit,
        "acceptance": {
            "bound": acceptance_bound,
            "accepted": acceptance_accepted,
            "plan_version": acceptance_plan_version,
            "fingerprint": acceptance_fingerprint,
        },
        "missing": missing,
    }


def requirement_task_evidence_section(
    root: Path,
    store: RecordStore,
    task_id: str,
    single_task_id: str,
    artifact: TaskArtifact | None,
    plan_version: int,
) -> dict:
    """需求内任务的交付证据身份：优先当前验收绑定，否则回落到任务产物记录。"""

    task_dir = root / single_task_id
    binding = store.acceptance_binding(single_task_id)
    delivery = store.task_delivery(single_task_id)
    test_result, test_exit_code = _read_test_result(task_dir)
    candidate_sha256 = binding.candidate_sha256 if binding else ""
    review_sha256 = binding.review_sha256 if binding else ""
    test_evidence_sha256 = binding.test_evidence_sha256 if binding else ""
    if artifact is not None:
        candidate_sha256 = candidate_sha256 or artifact.candidate_sha256
        review_sha256 = review_sha256 or artifact.review_sha256
        test_evidence_sha256 = test_evidence_sha256 or artifact.test_evidence_sha256
    return evidence_section(
        task_id,
        candidate_summary=_read_candidate_summary(task_dir),
        candidate_sha256=candidate_sha256,
        review_sha256=review_sha256,
        review_blocking=_read_review_blocking(task_dir),
        test_evidence_sha256=test_evidence_sha256,
        test_result=test_result,
        test_exit_code=test_exit_code,
        artifact_sha256=binding.artifact_sha256 if binding else "",
        baseline_commit=binding.baseline_commit if binding else "",
        acceptance_bound=binding is not None,
        acceptance_accepted=delivery.accepted if delivery else False,
        acceptance_plan_version=binding.plan_version if binding else plan_version,
        acceptance_fingerprint=binding.fingerprint if binding else "",
    )


def aggregate_missing(entries: list[dict]) -> list[str]:
    """把各任务的依赖/证据缺失项汇总为稳定排序的扁平列表（不重复）。"""

    items: list[str] = []
    for entry in entries:
        task_id = str(entry["task_id"])
        for item in entry["dependency"]["missing"]:
            items.append(f"{task_id}:dependency:{item}")
        for item in entry["evidence"]["missing"]:
            items.append(f"{task_id}:evidence:{item}")
    return sorted(set(items))


# ---- 查询：工时摘要（domain 纯规则接入；只读派生，不写预算状态） ----
#
# 摘要由 ``domain.budget_summary.summarize_budget`` 按任务状态与权威 ``budget``
# 行派生；本层只负责把 ``ExecutionBudget | None`` 只读取出并映射为稳定 JSON。
# 新字段一律追加、字段名小写下划线；既有字段名称、含义与取值不变。


def _format_seconds(value: float) -> str:
    """秒数展示：整数值不补小数点，非整数保留一位小数。"""

    if float(value).is_integer():
        return str(int(value))
    return f"{value:.1f}"


def budget_summary_section(summary: BudgetSummary) -> dict:
    """把只读工时摘要映射为稳定 JSON 片段（新增字段，键名小写下划线）。

    未知读数以 ``null`` 如实输出，绝不臆造为 0 秒；``state`` 使用领域层状态词。
    """

    return {
        "state": summary.state.value,
        "consumed_seconds": summary.consumed_seconds,
        "limit_seconds": summary.limit_seconds,
        "exhausted": summary.exhausted,
        "dimensions": list(summary.dimensions),
        "note": summary.note,
    }


def budget_summary_line(section: dict) -> str:
    """把工时摘要片段映射为一行简短说明；未开始/冲突/未耗尽/耗尽均显式标注。"""

    state = section["state"]
    if state == BudgetSummaryState.NOT_STARTED.value:
        return "未开始"
    if state == BudgetSummaryState.UNKNOWN.value:
        return f"unknown（{section['note']}）"
    seconds = (
        f"已用 {_format_seconds(section['consumed_seconds'])}"
        f"/{_format_seconds(section['limit_seconds'])} 秒"
    )
    return f"{seconds}，已耗尽" if section["exhausted"] else f"{seconds}，未耗尽"


def task_budget_summary(store: RecordStore, task_id: str, status: str) -> dict:
    """只读派生一个任务的工时摘要：任务状态 + 权威 budget 行；不写入任何记录。

    ``store`` 必须是打开的 :class:`RecordStore`；是否存在 budget 行由
    :meth:`RecordStore.find_budget` 只读读出，不猜测。
    """

    return budget_summary_section(summarize_budget(status, store.find_budget(task_id)))


# ---- 查询：阻断原因文本（domain 纯规则接入；只读派生，不写记录） ----
#
# ``blocked_reason_text`` 由 ``domain.status_reason.derive_status_reason`` 从
# ``RecordStore.status_reason_facts`` 只读读出的权威事实推导；本层只负责把结果
# 映射为稳定 JSON 片段。新字段一律追加、字段名小写下划线；既有字段名称、含义
# 与取值不变。


def status_reason_section(reason: StatusReason) -> dict:
    """把阻断原因推导结果映射为稳定 JSON 片段（新字段追加）。"""

    return {"blocked_reason_text": reason.blocked_reason_text}


def task_status_reason(
    store: RecordStore,
    task_id: str,
    *,
    unmet_prerequisites: tuple[str, ...] = (),
) -> dict:
    """只读派生一个任务的阻断原因片段：权威事实 + 待满足前置，不写入任何记录。

    ``store`` 必须是打开的 :class:`RecordStore`；缺少权威记录时由领域层输出
    ``unknown`` 并列出所缺身份，不猜测为已满足或未满足。
    """

    facts = store.status_reason_facts(task_id, unmet_prerequisites=unmet_prerequisites)
    return status_reason_section(derive_status_reason(facts))
