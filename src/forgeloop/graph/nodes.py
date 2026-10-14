"""业务图节点：方案、两次批准门、实现、独立审查、正式测试、追加授权与交付。

节点职责边界（架构 §4 研发闭环业务图）：
- plan 保存方案并等待第一次本地批准（范围+方案+验收标准+测试命令）。
- gate_plan_approval 用领域批准绑定校验：未批准不开始改代码；
  旧版本或重复决定不能重复执行。
- dev 由 PI 在任务工作副本实现并自验证；review 用独立 PI 会话审查
  候选 diff，阻断问题回 dev。
- test 程序执行批准的测试命令：失败计一轮失败轮次，本次授权额度
  用尽后等待追加授权；通过后等待第二次批准（整体验收）。
- 用户验收拒绝按同一正式候选轮次规则计数（重复反馈不重复加数）。
- 每个动作节点启动前检查停止请求与工时限额：超限/请求停止后
  不再启动新动作，当前工具完成并保存结果后停止。

中断恢复注意（架构 §6 持久化与记录）：LangGraph 中断恢复可能重新进入节点；
gate 节点在 interrupt 之后才消费批准，动作节点本身不含 interrupt。
动作节点在启动前登记动作身份（``records.actions``）：同一任务已有未完成动作
（上次进程在动作中途被杀）时标记 ``interrupted`` 并拒绝重放，保留现场待人工核对。
进程在动作中途崩溃后的自动恢复与副作用核对仍属 B12，不自动重跑。
"""

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from langgraph.types import interrupt

from forgeloop.adapter.git_workspace import (
    collect_candidate_change,
    is_git_workspace,
    prepare_workspace,
)
from forgeloop.adapter.pi_rpc import PIInvocationResult, PIProcess, PISpawnOptions
from forgeloop.adapter.test_runner import run_test_command
from forgeloop.domain.approval import ApprovalStage, ConsumeStatus, Plan
from forgeloop.domain.counting import FailureStage, GrantExhaustedError
from forgeloop.domain.delivery import verify_binding
from forgeloop.graph.evidence import capture_partial_candidate, previous_failure_context
from forgeloop.graph.prompts import dev_prompt, review_prompt
from forgeloop.graph.state import TaskState
from forgeloop.records.actions import ActionInFlightError, ActionRecord
from forgeloop.records.store import RecordStore

PI_TIMEOUT_CAP_SECONDS = 300.0
TEST_TIMEOUT_CAP_SECONDS = 300.0
# 节点返回的部分状态更新；工厂函数的统一签名。
NodeUpdate = dict[str, object]
# 框架边界签名放宽：langgraph add_node 的重载同时接受 (state) 与 (state, config)。
NodeFn = Callable[..., NodeUpdate]


@dataclass(frozen=True)
class NodeContext:
    """一个任务的节点执行上下文（闭包注入，不进检查点）。"""

    store: RecordStore
    task_id: str
    task_dir: Path
    workspace: Path
    sessions_dir: Path
    config: Mapping[str, str]

    @classmethod
    def for_task(cls, store: RecordStore, records_root: Path, task_id: str) -> "NodeContext":
        task = store.get_task(task_id)
        if task is None:
            raise KeyError(f"Unknown task {task_id}")
        task_dir = records_root / task_id
        return cls(
            store=store,
            task_id=task_id,
            task_dir=task_dir,
            workspace=task_dir / "workspace",
            sessions_dir=task_dir / "sessions",
            config=task.config,
        )


def _pi_command(config: Mapping[str, str]) -> tuple[str, ...]:
    raw = config.get("pi_command")
    if not raw:
        raise ValueError("Task config is missing pi_command")
    command = json.loads(raw)
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) for part in command)
    ):
        raise ValueError("pi_command must be a JSON array of command parts")
    return tuple(command)


def _interrupted(state: TaskState) -> str | None:
    """中断收口：已记录 halted_reason 时，任何节点都不再启动新动作。

    没有这道闸时，dev 因 provider 错误中断后图仍会进入审查节点：既浪费一次模型调用，
    又把终态覆盖成 reviewing（应为 interrupted）。
    """

    reason = state.get("halted_reason")
    return str(reason) if reason else None


def _action_gate(ctx: NodeContext) -> str | None:
    """动作启动门：未核对动作或任何停止记录都不再启动新动作。

    未完成动作优先于停止记录：即使已确认停止，只要还有未核对的动作，
    终态就是 ``interrupted``（结果不明确）而不是干净的 ``stopped``。
    """

    unchecked = _unchecked_action_halt(ctx)
    if unchecked is not None:
        return unchecked
    stop = ctx.store.outcomes.stop_record(ctx.task_id)
    if stop is not None:
        if stop[1] is None:
            ctx.store.set_task_status(ctx.task_id, "stop_requested")
            return "stop_requested"
        ctx.store.set_task_status(ctx.task_id, "stopped")
        return "stop_confirmed"
    if not ctx.store.budget(ctx.task_id).can_start_action():
        ctx.store.set_task_status(ctx.task_id, "time_exhausted")
        return "time_exhausted"
    return None


def _unchecked_action_halt(ctx: NodeContext) -> str | None:
    """未完成动作的停止原因；没有则 ``None``。用于门节点与动作节点。"""

    outstanding = ctx.store.actions.outstanding(ctx.task_id)
    if outstanding is None:
        return None
    ctx.store.set_task_status(ctx.task_id, "interrupted")
    return f"action_unchecked:{outstanding.node}"


def _action_preflight(ctx: NodeContext, node: str) -> tuple[ActionRecord | None, str]:
    """启动动作前的守卫：原子登记启动身份，并拒绝并发重放。

    返回 ``(动作, 停止原因)``。``begin`` 在同一事务内检查未完成动作并登记，
    「门检查」与「登记」之间被其他进程抢占时只有一个能成功，另一个抛
    ``ActionInFlightError``：此时动作为 ``None``、原因为事实描述，调用方据此
    标记中断、保留现场待人工核对。正常时动作已登记为 ``started``，由调用方在
    ``finally`` 中登记完成。
    """

    try:
        return ctx.store.actions.begin(ctx.task_id, node), ""
    except ActionInFlightError as error:
        # 门检查与登记之间被并发占用：按未完成动作处理，不启动。
        ctx.store.set_task_status(ctx.task_id, "interrupted")
        return None, f"action_unchecked:{error.node}"


def _record_candidate_failure(ctx: NodeContext, state: TaskState) -> NodeUpdate:
    """按正式候选轮次计一次失败；额度用尽时转等待追加授权。"""

    round_id = f"candidate-{state.get('dev_attempts', 1)}"
    try:
        cumulative = ctx.store.record_failure(
            ctx.task_id, round_id, FailureStage.FORMAL_TEST, "formal candidate failed"
        )
    except GrantExhaustedError:
        ctx.store.set_task_status(ctx.task_id, "awaiting_grant")
        return {"needs_grant": True, "last_test_passed": False}
    if ctx.store.ledger(ctx.task_id).awaiting_grant_decision:
        ctx.store.set_task_status(ctx.task_id, "awaiting_grant")
        return {"failure_cumulative": cumulative, "needs_grant": True, "last_test_passed": False}
    ctx.store.set_task_status(ctx.task_id, "fixing")
    return {"failure_cumulative": cumulative, "needs_grant": False, "last_test_passed": False}


def make_plan_node(ctx: NodeContext) -> NodeFn:
    def plan_node(state: TaskState) -> NodeUpdate:
        task = ctx.store.get_task(ctx.task_id)
        if task is None:
            raise KeyError(f"Unknown task {ctx.task_id}")
        goal = ctx.config.get("goal") or task.original_input
        scope = ctx.config.get("scope") or task.original_input
        acceptance = ctx.config.get("acceptance") or task.original_input
        test_command = json.loads(ctx.config["test_command"])
        if not isinstance(test_command, list) or not test_command:
            raise ValueError("test_command must be a non-empty JSON array")
        latest = ctx.store.latest_plan(ctx.task_id)
        version = latest.version + 1 if latest else 1
        ctx.store.save_plan(
            Plan(ctx.task_id, version, goal, scope, acceptance, tuple(test_command))
        )
        ctx.store.set_task_status(ctx.task_id, "awaiting_plan_approval")
        return {"plan_version": version}

    return plan_node


def make_gate_plan_approval(ctx: NodeContext) -> NodeFn:
    def gate_plan_approval(state: TaskState) -> NodeUpdate:
        # 未核对动作优先于新批准：不消费新批准，也不重放旧动作。
        halt = _unchecked_action_halt(ctx)
        if halt is not None:
            return {"halted_reason": halt}
        plan = ctx.store.latest_plan(ctx.task_id)
        if plan is None:
            ctx.store.set_task_status(ctx.task_id, "interrupted")
            return {"halted_reason": "plan_missing"}
        resume = interrupt(
            {
                "kind": "plan_approval",
                "task_id": ctx.task_id,
                "plan_version": plan.version,
                "goal": plan.goal,
                "scope": plan.scope,
                "acceptance": plan.acceptance,
                "test_command": list(plan.test_command),
            }
        )
        decision = resume.get("decision") if isinstance(resume, dict) else None
        if decision != "approved":
            ctx.store.set_task_status(ctx.task_id, "rejected")
            return {"halted_reason": "plan_rejected"}
        result = ctx.store.consume_approval(ctx.task_id, plan.version, ApprovalStage.PLAN)
        if result.status is not ConsumeStatus.OK:
            ctx.store.set_task_status(ctx.task_id, "blocked")
            return {"halted_reason": f"plan_approval_{result.status.value}"}
        return {}

    return gate_plan_approval


def _pi_outcome_halt(outcome: PIInvocationResult) -> str | None:
    """PI 结果的未完成判定：中止、协议错误或 provider 模型错误都据实标记。

    实测发现：agent_settled 只表示不再自动推进——provider 自动重试耗尽后
    也会 settled（最终消息 stopReason=error）。模型错误不伪装为完成。
    """

    if outcome.aborted:
        return "aborted"
    if outcome.model_error:
        return f"model_error:{outcome.model_error}"
    if not outcome.settled:
        return outcome.error or "unsettled"
    return None


def pi_timeout_seconds(ctx: NodeContext) -> float:
    """单次 PI 调用的等待上限：任务配置可覆盖默认 300s，且不超过剩余预算。

    重任务（多文件实现、需自行探索的审查）会超过默认 300s；此时由提交方用
    ``--pi-timeout-seconds`` 显式抬高上限，而不是改默认值让所有任务都变慢。
    配置缺失或非法一律回落到默认值。
    """

    configured = ctx.config.get("pi_timeout_seconds", "")
    try:
        cap = float(configured) if configured else PI_TIMEOUT_CAP_SECONDS
    except (TypeError, ValueError):
        cap = PI_TIMEOUT_CAP_SECONDS
    if cap <= 0:
        cap = PI_TIMEOUT_CAP_SECONDS
    return min(ctx.store.budget(ctx.task_id).remaining_seconds, cap)


def _invoke_pi(ctx: NodeContext, role: str, prompt: str) -> PIInvocationResult:
    """运行一个 PI 会话并计工时：未明确结果如实返回，不自动重跑。

    子进程显式在任务范围内运行：实现会话在独立工作副本内（可写），审查会话在任务
    记录目录内（其结论来自提示词中的候选 diff，避免误改候选工作区）；不依赖提示词
    里的路径让模型自觉。
    """

    timeout = pi_timeout_seconds(ctx)
    cwd = ctx.workspace if role == "dev" else ctx.task_dir
    cwd.mkdir(parents=True, exist_ok=True)
    options = PISpawnOptions(cwd=cwd)
    process = PIProcess(_pi_command(ctx.config), ctx.task_id, role, ctx.sessions_dir, options)
    process.start()
    started = time.monotonic()
    try:
        process.send_prompt(prompt)
        return process.wait_until_settled(timeout + 1.0)
    finally:
        ctx.store.charge_budget(ctx.task_id, time.monotonic() - started)
        process.close()


def _append_dev_report(
    ctx: NodeContext, attempt: int, text: str, diff_source: str, baseline: str
) -> None:
    """PI 的最终文本与候选来源按尝试追加保留（原始记录不丢失）。"""

    reports_path = ctx.task_dir / "dev-reports.jsonl"
    reports_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "attempt": attempt,
        "text": text,
        "diff_source": diff_source,
        "baseline_commit": baseline,
    }
    with reports_path.open("a", encoding="utf-8") as reports_file:
        reports_file.write(json.dumps(entry, ensure_ascii=False) + "\n")


def make_dev_node(ctx: NodeContext) -> NodeFn:
    def dev_node(state: TaskState) -> NodeUpdate:
        halt = _interrupted(state) or _action_gate(ctx)
        if halt:
            return {"halted_reason": halt}
        plan = ctx.store.latest_plan(ctx.task_id)
        if plan is None:
            ctx.store.set_task_status(ctx.task_id, "interrupted")
            return {"halted_reason": "plan_missing"}
        action, halt = _action_preflight(ctx, "dev")
        if action is None:
            return {"halted_reason": halt}
        try:
            ctx.store.set_task_status(ctx.task_id, "implementing")
            ctx.workspace.mkdir(parents=True, exist_ok=True)
            project_path = ctx.config.get("project_path", "")
            prepared = time.monotonic()
            try:
                if project_path:
                    prepare_workspace(
                        Path(project_path), ctx.config.get("baseline", ""), ctx.workspace
                    )
            finally:
                ctx.store.charge_budget(ctx.task_id, time.monotonic() - prepared)
            attempt = state.get("dev_attempts", 0) + 1
            prompt = dev_prompt(
                plan,
                workspace=str(ctx.workspace),
                attempt=attempt,
                # 失败回边带真实证据：上次正式测试输出与审查阻断问题（截断后）。
                previous_failure=previous_failure_context(ctx.task_dir),
            )
            outcome = _invoke_pi(ctx, "dev", prompt)
            halt = _pi_outcome_halt(outcome)
            if halt:
                # 未取得明确结果时把副本已有改动落盘为部分候选（只写 partial-*，供人工恢复）。
                capture_partial_candidate(ctx.task_dir, ctx.workspace, f"pi_dev_unsettled:{halt}")
                ctx.store.set_task_status(ctx.task_id, "interrupted")
                return {"halted_reason": f"pi_dev_unsettled:{halt}"}
            result = dict(outcome.result or {})
            candidate = ctx.task_dir / "candidate.diff"
            candidate.parent.mkdir(parents=True, exist_ok=True)
            if is_git_workspace(ctx.workspace):
                # 候选 diff 来自工作副本对基线的真实差异，不依赖 PI 文本自述。
                change = collect_candidate_change(ctx.workspace)
                candidate.write_text(change.diff, encoding="utf-8")
                _append_dev_report(ctx, attempt, outcome.text or "", "git", change.baseline_commit)
            else:
                diff = result.get("diff")
                candidate.write_text(diff if isinstance(diff, str) else "", encoding="utf-8")
                _append_dev_report(ctx, attempt, outcome.text or "", "payload", "")
            return {"dev_attempts": attempt}
        finally:
            ctx.store.actions.finish(action.action_id, "dev 动作结束")

    return dev_node


def _write_review_reports(ctx: NodeContext, attempt: int, blocking: list, result: dict) -> None:
    """审查结论按尝试追加保留（原始记录不丢失），并保存最新摘要。

    ``blocking_issues_valid`` 记录该轮是否给出了结构化阻断列表；为假表示结果
    不可用（审查节点据此中断，而不是判为"无阻断"）。
    """

    payload = {
        "blocking_issues": blocking,
        "blocking_issues_valid": bool(result.get("blocking_issues_valid", True)),
        "summary": result.get("summary", ""),
    }
    reviews_path = ctx.task_dir / "reviews.jsonl"
    reviews_path.parent.mkdir(parents=True, exist_ok=True)
    with reviews_path.open("a", encoding="utf-8") as reviews_file:
        reviews_file.write(json.dumps({"attempt": attempt, **payload}, ensure_ascii=False) + "\n")
    report_path = ctx.task_dir / "review-report.json"
    report_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def make_review_node(ctx: NodeContext) -> NodeFn:
    def review_node(state: TaskState) -> NodeUpdate:
        halt = _interrupted(state) or _action_gate(ctx)
        if halt:
            return {"halted_reason": halt}
        plan = ctx.store.latest_plan(ctx.task_id)
        candidate = ctx.task_dir / "candidate.diff"
        diff_text = candidate.read_text(encoding="utf-8") if candidate.exists() else ""
        action, halt = _action_preflight(ctx, "review")
        if action is None:
            return {"halted_reason": halt}
        try:
            ctx.store.set_task_status(ctx.task_id, "reviewing")
            prompt = review_prompt(plan, candidate_diff=diff_text)
            outcome = _invoke_pi(ctx, "review", prompt)
            halt = _pi_outcome_halt(outcome)
            if halt:
                ctx.store.set_task_status(ctx.task_id, "interrupted")
                return {"halted_reason": f"pi_review_unsettled:{halt}"}
            result = dict(outcome.result or {})
            if not result.get("summary") and outcome.text:
                result["summary"] = outcome.text
            raw_issues = result.get("blocking_issues")
            valid = isinstance(raw_issues, list)
            blocking = list(raw_issues) if valid else []
            _write_review_reports(
                ctx,
                state.get("dev_attempts", 0) + 1,
                blocking,
                {**result, "blocking_issues_valid": valid},
            )
            if not valid:
                # 结果缺失或非结构化时不能得出"无阻断"：中断交人工决定，禁止错误放行。
                ctx.store.set_task_status(ctx.task_id, "interrupted")
                return {"halted_reason": "review_result_invalid"}
            return {"last_review_blocking": bool(blocking)}
        finally:
            ctx.store.actions.finish(action.action_id, "review 动作结束")

    return review_node


def make_test_node(ctx: NodeContext) -> NodeFn:
    def test_node(state: TaskState) -> NodeUpdate:
        halt = _interrupted(state) or _action_gate(ctx)
        if halt:
            return {"halted_reason": halt}
        plan = ctx.store.latest_plan(ctx.task_id)
        if plan is None:
            ctx.store.set_task_status(ctx.task_id, "interrupted")
            return {"halted_reason": "plan_missing"}
        action, halt = _action_preflight(ctx, "test")
        if action is None:
            return {"halted_reason": halt}
        try:
            ctx.store.set_task_status(ctx.task_id, "testing")
            timeout = min(ctx.store.budget(ctx.task_id).remaining_seconds, TEST_TIMEOUT_CAP_SECONDS)
            started = time.monotonic()
            outcome = run_test_command(
                plan.test_command,
                ctx.workspace,
                timeout,
                ctx.task_dir / "test-run.jsonl",
            )
            ctx.store.charge_budget(ctx.task_id, time.monotonic() - started)
            if outcome.timed_out:
                ctx.store.set_task_status(ctx.task_id, "interrupted")
                return {"halted_reason": "test_timeout"}
            if outcome.exit_code == 0:
                ctx.store.set_task_status(ctx.task_id, "tested")
                return {"last_test_passed": True}
            return _record_candidate_failure(ctx, state)
        finally:
            ctx.store.actions.finish(action.action_id, "test 动作结束")

    return test_node


def make_gate_grant(ctx: NodeContext) -> NodeFn:
    def gate_grant(state: TaskState) -> NodeUpdate:
        ledger = ctx.store.ledger(ctx.task_id)
        ctx.store.set_task_status(ctx.task_id, "awaiting_grant")
        resume = interrupt(
            {
                "kind": "grant_decision",
                "task_id": ctx.task_id,
                "cumulative_failures": ledger.cumulative_failures,
                "grants": ledger.grant_count,
                "consumed_in_current_grant": ledger.consumed_in_current_grant,
            }
        )
        decision = resume.get("decision") if isinstance(resume, dict) else None
        if decision != "grant":
            # 拒绝追加授权也是"停止自动推进"：留下停止事实，最终状态才有依据。
            ctx.store.outcomes.request_stop(ctx.task_id, "未追加授权，停止自动推进")
            ctx.store.outcomes.confirm_stop(ctx.task_id, "未追加授权，停止自动推进")
            ctx.store.set_task_status(ctx.task_id, "stopped")
            return {"halted_reason": "grant_denied"}
        ctx.store.append_grant(ctx.task_id)
        ctx.store.set_task_status(ctx.task_id, "granted")
        return {"needs_grant": False}

    return gate_grant


def make_gate_acceptance(ctx: NodeContext) -> NodeFn:
    def gate_acceptance(state: TaskState) -> NodeUpdate:
        # 未核对动作优先于整体验收：不消费验收批准，也不重放旧动作。
        halt = _unchecked_action_halt(ctx)
        if halt is not None:
            return {"halted_reason": halt}
        plan = ctx.store.latest_plan(ctx.task_id)
        ctx.store.set_task_status(ctx.task_id, "awaiting_acceptance")
        resume = interrupt(
            {
                "kind": "acceptance",
                "task_id": ctx.task_id,
                "plan_version": plan.version if plan else 0,
                "diff_path": str(ctx.task_dir / "candidate.diff"),
                "test_evidence": str(ctx.task_dir / "test-run.jsonl"),
                "review_report": str(ctx.task_dir / "review-report.json"),
            }
        )
        decision = resume.get("decision") if isinstance(resume, dict) else None
        if decision == "accepted":
            if plan is None:
                ctx.store.set_task_status(ctx.task_id, "interrupted")
                return {"halted_reason": "plan_missing"}
            # 消费时重新读取实际材料：批准后替换 diff/测试/产物则原批准失效。
            current = ctx.store.capture_delivery_binding(ctx.task_id, plan.version)
            result = ctx.store.consume_approval(
                ctx.task_id, plan.version, ApprovalStage.ACCEPTANCE, current
            )
            if result.status is not ConsumeStatus.OK:
                ctx.store.set_task_status(ctx.task_id, "blocked")
                return {"halted_reason": f"acceptance_approval_{result.status.value}"}
            return {"acceptance_passed": True}
        # 用户验收发现明确交付失败：按同一正式候选轮次规则计数。
        return _record_candidate_failure(ctx, state)

    return gate_acceptance


def make_deliver_node(ctx: NodeContext) -> NodeFn:
    def deliver_node(state: TaskState) -> NodeUpdate:
        plan = ctx.store.latest_plan(ctx.task_id)
        ledger = ctx.store.ledger(ctx.task_id)
        # 二次核对：验收后到落交付前材料若被替换，不写出交付记录。
        plan_version = plan.version if plan else 0
        accepted = ctx.store.acceptance_binding(ctx.task_id)
        current = ctx.store.capture_delivery_binding(ctx.task_id, plan_version)
        if accepted is not None:
            decision = verify_binding(accepted, current)
            if not decision.valid:
                ctx.store.set_task_status(ctx.task_id, "blocked")
                return {"halted_reason": "delivery_material_changed"}
        report_path = ctx.task_dir / "delivery-report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "task_id": ctx.task_id,
                    "plan": {
                        "version": plan_version,
                        "goal": plan.goal if plan else "",
                        "test_command": list(plan.test_command) if plan else [],
                    },
                    "dev_attempts": state.get("dev_attempts", 0),
                    "baseline_commit": (
                        collect_candidate_change(ctx.workspace).baseline_commit
                        if is_git_workspace(ctx.workspace)
                        else ""
                    ),
                    "cumulative_failures": ledger.cumulative_failures,
                    "grants": ledger.grant_count,
                    "diff_path": str(ctx.task_dir / "candidate.diff"),
                    "test_evidence": str(ctx.task_dir / "test-run.jsonl"),
                    "review_report": str(ctx.task_dir / "review-report.json"),
                    "binding": {
                        "fingerprint": current.fingerprint,
                        "candidate_sha256": current.candidate_sha256,
                        "test_evidence_sha256": current.test_evidence_sha256,
                        "review_sha256": current.review_sha256,
                        "artifact_sha256": current.artifact_sha256,
                        "baseline_commit": current.baseline_commit,
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        ctx.store.outcomes.record_delivery(
            ctx.task_id,
            str(ctx.task_dir / "candidate.diff"),
            str(report_path),
        )
        ctx.store.set_task_status(ctx.task_id, "delivered")
        return {}

    return deliver_node
