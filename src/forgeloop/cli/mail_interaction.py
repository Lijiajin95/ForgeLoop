"""邮箱交互入口：把邮件收发接到既有需求、批准与执行记录上。

职责（组合根与命令编排，不新增业务状态）：

- ``mail interact --once`` 是交给 cron 的单次入口：认证 IMAP、拉取未读邮件、按
  确定性协议解析命令，并把命令接到与 CLI 同一套 ``RequirementStore`` /
  ``graph`` / ``RecordStore`` 事实与规则上。
- **来源验证**：只有 ``--allowed-sender`` 列出的发件地址能触发命令；不在列表内
  的邮件不建档、不回信、不执行。``Auto-Submitted`` 自动回复同样不执行。
- **确定性命令**：命令词固定、大小写不敏感；批准必须显式写出任务包版本，系统
  不把「同意」等自然语言当作批准。无法识别的回复按需求修订内容处理。
- **幂等与不确定现场**：入向 ``Message-ID`` 先占位再执行，重复轮询不重复建档、
  重复批准或重复推进；命令执行后先落回信再发送，发送失败只重发同一封回信；
  进程中断留下的执行现场标记为不确定并回信说明，不盲目重放。
- **回信即交互**：新邮件受理并回信需求编号与下一步；回复既有通知即可查询状态、
  修订、批准、验收；命令结果与当前状态一并回信，供离开终端的异步交互。
- **长任务**：``analyze`` / ``plan`` / ``advance`` 需要 ``--pi-command`` 等执行配置，
  在本次轮询内同步执行（推进可能较久）；未配置时只回复配置缺失，不改动记录。

本模块由 ``cli.main`` 注册；记录根、连接参数与 PI 配置来自命令行，密钥优先显式
传入、否则读环境变量，不回显、不落盘。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    InboundMail,
    MailAdapterError,
    MailParseError,
    MailSendError,
    SmtpMailSender,
    parse_inbound,
)
from forgeloop.cli.common import base_records_root, fail, project_for, records_root
from forgeloop.cli.mail import (
    _add_connection_args,
    _make_receiver,
    _make_sender,
    _open_thread_connection,
)
from forgeloop.domain.delivery import RequirementDelivery, assess_requirement_acceptance
from forgeloop.domain.mail import MailReply, parse_reply_reference
from forgeloop.domain.mail_interaction import (
    MailCommand,
    MailCommandKind,
    MailInteractionError,
    command_help,
    interaction_subject,
    is_auto_submitted,
    normalize_address,
    parse_mail_command,
    revision_text,
    sender_allowed,
)
from forgeloop.domain.requirement import RequirementError, RequirementNotFoundError
from forgeloop.domain.task_plan import TaskPlanError
from forgeloop.graph.builder import RequirementTaskRunner, requirement_task_id
from forgeloop.graph.planning import PlanningContext, analyze_requirement, plan_requirement
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
)
from forgeloop.records.mail_interactions import (
    InteractionState,
    MailInteractionRecord,
    MailInteractionStore,
)
from forgeloop.records.mail_threads import MailThreadStore
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

# 需求终态（与 ``cli.main`` 的契约词表一致）：整体验收通过或明确拒绝后不再推进。
ACCEPTED = "accepted"
REJECTED = "rejected"
TERMINAL_REQUIREMENT_STATUSES = frozenset({ACCEPTED, REJECTED})
# 回信落款：固定说明入口与帮助命令，便于人工直接照做。
REPLY_FOOTER = (
    "\n-- \nForgeLoop 邮箱交互入口。回复本邮件并在正文第一行写命令；发送 help 查看全部命令。\n"
)
# 线程 References 上限，避免长线程头无限增长。
_MAX_REFERENCES = 20


@dataclass(frozen=True)
class CommandResult:
    """一次邮件命令的确定性结果；``label`` 用于回信主题标签。"""

    ok: bool
    summary: str
    label: str = "状态"


@dataclass(frozen=True)
class InteractionOutcome:
    """一封入向邮件的处理结果，供 JSON 文档与人工审计。"""

    message_id: str
    req_id: str
    command: str
    authorized: bool
    processed: bool
    replied: bool
    state: str
    detail: str
    reply_message_id: str = ""


@dataclass(frozen=True)
class InteractionReport:
    """一次 ``mail interact --once`` 的可观测结果。"""

    fetched: int
    outcomes: tuple[InteractionOutcome, ...]
    errors: tuple[str, ...]

    @property
    def processed(self) -> tuple[InteractionOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if outcome.processed)

    @property
    def replied(self) -> tuple[InteractionOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if outcome.replied)

    @property
    def skipped(self) -> tuple[InteractionOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if not outcome.processed)


def _read_only_runner(execution: TaskExecution) -> TaskResult:  # pragma: no cover - 只读汇总
    raise AssertionError("状态查询不得执行任何任务")


def _requirement_text(mail: InboundMail) -> str:
    """无既有线索时，把邮件主题与正文作为新需求原文；不丢弃原文。"""

    subject = mail.subject.strip()
    body = revision_text(mail.body).strip()
    if subject and body:
        return f"{subject}\n\n{body}"
    return subject or body


def _reply_message_id(inbound_message_id: str) -> str:
    """由入向 Message-ID 派生稳定的回信 Message-ID，发送失败重试时不改身份。"""

    digest = hashlib.sha256(inbound_message_id.encode("utf-8")).hexdigest()[:24]
    return f"<forgeloop-{digest}@forgeloop.local>"


def _thread_references(mail: InboundMail) -> tuple[str, ...]:
    """构造回信 References：保留既有线程并追加本封入向邮件，去掉重复项。"""

    references: list[str] = []
    for item in (*mail.references, mail.message_id):
        value = item.strip()
        if value and value not in references:
            references.append(value)
    return tuple(references[-_MAX_REFERENCES:])


def _parse_pi_command(raw: str) -> tuple[str, ...]:
    """解析 ``--pi-command``；为空表示未配置，非法时明确失败。"""

    if not raw.strip():
        return ()
    try:
        command = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MailInteractionError(f"--pi-command 必须是 JSON 字符串数组: {error}") from error
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(part, str) and part for part in command)
    ):
        raise MailInteractionError("--pi-command 必须是非空字符串数组（JSON）")
    return tuple(command)


class MailInteractionGateway:
    """把邮件收发接到需求、批准与执行记录上的组合根。

    只做命令编排与状态汇总，业务判定全部委托既有领域规则与记录层；真实 IMAP/SMTP
    由调用方注入，测试用可控实现替换外部 socket。
    """

    def __init__(
        self,
        receiver: ImapMailReceiver,
        sender: SmtpMailSender,
        *,
        root: Path,
        project: str,
        allowed_senders: tuple[str, ...],
        pi_command: tuple[str, ...] = (),
        project_path: str = "",
        baseline: str = "",
        pi_timeout_seconds: float = 300.0,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._receiver = receiver
        self._sender = sender
        self._root = root
        self._project = project
        self._allowed_senders = tuple(allowed_senders)
        self._pi_command = pi_command
        self._project_path = project_path
        self._baseline = baseline
        self._pi_timeout_seconds = pi_timeout_seconds
        self._now = now if now is not None else lambda: datetime.now(UTC)

    def process_once(self) -> InteractionReport:
        """拉取未读邮件并逐封处理；单封失败登记到报告，不拖垮其余邮件。"""

        self._receiver.authenticate()
        raw_messages = self._receiver.fetch_unseen()
        outcomes: list[InteractionOutcome] = []
        errors: list[str] = []
        requirement_store = RequirementStore(self._root / "records.sqlite")
        connection = _open_thread_connection(self._root)
        try:
            thread_store = MailThreadStore(connection)
            interaction_store = MailInteractionStore(connection)
            for raw in raw_messages:
                try:
                    mail = parse_inbound(
                        raw,
                        folder=self._receiver.folder,
                        default_received_at=self._now(),
                    )
                except MailParseError as error:
                    errors.append(f"无法解析邮件：{error}")
                    continue
                try:
                    outcomes.append(
                        self._process(mail, requirement_store, thread_store, interaction_store)
                    )
                except sqlite3.Error as error:
                    errors.append(f"处理邮件 {mail.message_id} 时记录库失败：{error}")
                except MailAdapterError as error:
                    errors.append(f"处理邮件 {mail.message_id} 时邮箱边界失败：{error}")
        finally:
            connection.close()
            requirement_store.close()
        return InteractionReport(
            fetched=len(raw_messages),
            outcomes=tuple(outcomes),
            errors=tuple(errors),
        )

    # ---- 单封邮件：来源校验、关联与占位 ----

    def _process(
        self,
        mail: InboundMail,
        requirement_store: RequirementStore,
        thread_store: MailThreadStore,
        interaction_store: MailInteractionStore,
    ) -> InteractionOutcome:
        if not sender_allowed(mail.sender, self._allowed_senders):
            return InteractionOutcome(
                message_id=mail.message_id,
                req_id="",
                command="",
                authorized=False,
                processed=False,
                replied=False,
                state="skipped",
                detail="发件人不在允许列表，未建档、未执行命令、未回信",
            )
        if is_auto_submitted(mail.auto_submitted):
            return InteractionOutcome(
                message_id=mail.message_id,
                req_id="",
                command="",
                authorized=True,
                processed=False,
                replied=False,
                state="skipped",
                detail="Auto-Submitted 自动回复不执行命令",
            )
        existing = thread_store.inbound_message(mail.message_id)
        req_id = (
            existing.req_id
            if existing is not None
            else self._resolve_req_id(mail, interaction_store)
        )
        command = parse_mail_command(mail.body)
        if req_id is None:
            return self._process_unlinked(
                mail, command, requirement_store, thread_store, interaction_store
            )
        if command is None:
            command = MailCommand(MailCommandKind.REVISE, revision_text(mail.body))
        return self._process_linked(
            mail, req_id, command, requirement_store, thread_store, interaction_store
        )

    def _resolve_req_id(
        self, mail: InboundMail, interaction_store: MailInteractionStore
    ) -> str | None:
        """按出向回信身份、邮件头与正文编号解析需求；无任何线索返回 ``None``。

        正文只取去掉引用与签名后的部分，避免把引用通知里的旧需求编号误当作
        本封邮件的关联目标；主题与邮件头仍按领域规则回退解析。
        """

        candidates = [mail.in_reply_to or "", *mail.references]
        for candidate in candidates:
            if not candidate.strip():
                continue
            req_id = interaction_store.requirement_for_reply(candidate.strip())
            if req_id:
                return req_id
        return parse_reply_reference(
            MailReply(
                received_at=mail.received_at,
                in_reply_to=mail.in_reply_to,
                references=mail.references,
                subject=mail.subject,
                body=revision_text(mail.body),
            )
        )

    def _process_unlinked(
        self,
        mail: InboundMail,
        command: MailCommand | None,
        requirement_store: RequirementStore,
        thread_store: MailThreadStore,
        interaction_store: MailInteractionStore,
    ) -> InteractionOutcome:
        """没有关联需求的邮件：帮助、显式拒绝未关联命令，或受理为新需求。"""

        if command is not None and command.kind is not MailCommandKind.HELP:
            claim_command = command.kind.value
            record, created = interaction_store.claim(mail.message_id, "", claim_command)
            if not created:
                return self._handle_existing(mail, record, interaction_store)
            result = CommandResult(
                False,
                "这封邮件没有关联到需求编号，命令未执行。\n"
                "对新需求请直接描述需求内容；对已有需求请回复该需求的通知邮件。\n\n"
                + command_help(),
                "未关联需求",
            )
            return self._reply(mail, None, claim_command, result, interaction_store)
        if command is not None and command.kind is MailCommandKind.HELP:
            record, created = interaction_store.claim(mail.message_id, "", command.kind.value)
            if not created:
                return self._handle_existing(mail, record, interaction_store)
            return self._reply(
                mail,
                None,
                command.kind.value,
                CommandResult(True, command_help(), "帮助"),
                interaction_store,
            )
        # 无命令的新邮件按新需求受理；先占位再建档，崩溃后不重复建档。
        record, created = interaction_store.claim(mail.message_id, "", "submit")
        if not created:
            return self._handle_existing(mail, record, interaction_store)
        text = _requirement_text(mail)
        if not text.strip():
            interaction_store.mark_failed(mail.message_id, "新需求邮件没有可用正文")
            return InteractionOutcome(
                mail.message_id,
                "",
                "submit",
                True,
                True,
                False,
                "failed",
                "新需求邮件没有可用正文，未建档",
            )
        try:
            requirement = requirement_store.submit(self._project, text)
        except (RequirementError, sqlite3.Error) as error:
            interaction_store.mark_failed(mail.message_id, f"受理失败：{error}")
            return InteractionOutcome(
                mail.message_id,
                "",
                "submit",
                True,
                True,
                False,
                "failed",
                f"受理失败：{error}",
            )
        interaction_store.set_requirement(mail.message_id, requirement.req_id)
        thread_store.record_inbound(
            mail.message_id,
            requirement.req_id,
            mail.received_at,
            sender=mail.sender,
            subject=mail.subject,
            folder=mail.folder,
        )
        next_step = (
            "下一步：回复 analyze 执行只读分析。"
            if self._pi_command
            else "下一步：邮件入口未配置 --pi-command，无法在邮件中执行分析；"
            "请通过 CLI 运行 `forgeloop requirement analyze`。"
        )
        result = CommandResult(
            True,
            f"已受理需求 {requirement.req_id}。\n{next_step}\n\n"
            + self._status_text(requirement_store, requirement.req_id),
            "已受理",
        )
        return self._reply(mail, requirement.req_id, "submit", result, interaction_store)

    def _process_linked(
        self,
        mail: InboundMail,
        req_id: str,
        command: MailCommand,
        requirement_store: RequirementStore,
        thread_store: MailThreadStore,
        interaction_store: MailInteractionStore,
    ) -> InteractionOutcome:
        """已关联需求的邮件：占位、登记入向、执行命令并回信。"""

        command_name = command.kind.value
        record, created = interaction_store.claim(mail.message_id, req_id, command_name)
        if not created:
            return self._handle_existing(mail, record, interaction_store)
        thread_store.record_inbound(
            mail.message_id,
            req_id,
            mail.received_at,
            sender=mail.sender,
            subject=mail.subject,
            folder=mail.folder,
        )
        try:
            result = self._execute(req_id, command, mail, requirement_store)
        except (
            RequirementError,
            RequirementNotFoundError,
            TaskPlanError,
            MailInteractionError,
            sqlite3.Error,
        ) as error:
            result = CommandResult(False, f"命令处理失败：{error}", "处理失败")
        return self._reply(mail, req_id, command_name, result, interaction_store)

    # ---- 命令实现：全部落在既有记录与规则上 ----

    def _execute(
        self,
        req_id: str,
        command: MailCommand,
        mail: InboundMail,
        requirement_store: RequirementStore,
    ) -> CommandResult:
        kind = command.kind
        if kind is MailCommandKind.HELP:
            return CommandResult(True, command_help(req_id), "帮助")
        if kind is MailCommandKind.STATUS:
            return CommandResult(True, self._status_text(requirement_store, req_id), "状态")
        if kind is MailCommandKind.REVISE:
            return self._revise(req_id, command.argument, requirement_store)
        if kind is MailCommandKind.APPROVE:
            return self._approve(req_id, command.argument, mail, requirement_store)
        if kind is MailCommandKind.ACCEPT:
            return self._accept(req_id, requirement_store)
        if kind is MailCommandKind.ANALYZE:
            return self._analyze(req_id, requirement_store)
        if kind is MailCommandKind.PLAN:
            return self._plan(req_id, requirement_store)
        return self._advance(req_id, requirement_store)

    def _revise(
        self, req_id: str, argument: str, requirement_store: RequirementStore
    ) -> CommandResult:
        text = argument.strip()
        if not text:
            return CommandResult(
                False,
                "没有可追加的内容：请在 revise 后写内容，或直接在正文写补充说明。",
                "修订未执行",
            )
        updated = requirement_store.append(req_id, text)
        return CommandResult(
            True,
            f"需求已修订（版本 {updated.version_count}）。需求修订后旧任务包与旧批准失效。\n\n"
            + self._status_text(requirement_store, req_id),
            "已修订",
        )

    def _approve(
        self,
        req_id: str,
        argument: str,
        mail: InboundMail,
        requirement_store: RequirementStore,
    ) -> CommandResult:
        plan = requirement_store.latest_task_plan(req_id)
        if plan is None:
            return CommandResult(False, "需求还没有任务包，无法批准。", "批准被拒绝")
        version_text = argument.strip().lstrip("vV")
        if not version_text.isdigit():
            return CommandResult(
                False,
                f"批准命令必须写出任务包版本，例如：approve {plan.plan_version}",
                "批准被拒绝",
            )
        version = int(version_text)
        if version != plan.plan_version:
            return CommandResult(
                False,
                f"任务包版本不匹配：当前最新为 v{plan.plan_version}，收到 v{version}；未记录批准。",
                "批准被拒绝",
            )
        approved_by = normalize_address(mail.sender) or mail.sender
        approval = requirement_store.record_plan_approval(
            req_id, version, approved_by, source=f"email:{mail.message_id}"
        )
        return CommandResult(
            True,
            f"任务包 v{approval.plan_version} 已批准（批准来源 email:{mail.message_id}）。\n"
            "下一步：回复 advance 推进。\n\n" + self._status_text(requirement_store, req_id),
            "已批准",
        )

    def _accept(self, req_id: str, requirement_store: RequirementStore) -> CommandResult:
        status = requirement_store.requirement_status(req_id)
        if status == ACCEPTED:
            return CommandResult(True, f"需求 {req_id} 已经完成整体验收。", "已验收")
        if status == REJECTED:
            return CommandResult(
                False, f"需求 {req_id} 已处于终态 rejected，不能再次验收。", "验收被拒绝"
            )
        plan = requirement_store.latest_task_plan(req_id)
        if plan is None:
            return CommandResult(False, "需求还没有任务包，无法整体验收。", "验收被拒绝")
        record_store = RecordStore(self._root / "records.sqlite")
        try:
            deliveries = []
            for task in plan.tasks:
                single_task_id = requirement_task_id(req_id, plan.plan_version, task.task_id)
                delivery = record_store.task_delivery(single_task_id)
                if delivery is None:
                    return CommandResult(
                        False,
                        f"任务 {task.task_id} 尚无已消费的验收材料；整体验收不部分放行。",
                        "验收被拒绝",
                    )
                deliveries.append(delivery)
            authorization = requirement_store.plan_authorization(req_id)
            if not authorization.can_execute:
                return CommandResult(False, f"验收被拒绝：{authorization.reason}", "验收被拒绝")
            delivery = RequirementDelivery(req_id, tuple(deliveries))
            current = {
                item.binding.task_id: record_store.capture_delivery_binding(
                    item.binding.task_id, item.binding.plan_version
                )
                for item in delivery.deliveries
            }
            decision = assess_requirement_acceptance(delivery, current_bindings=current)
            if not decision.allowed:
                return CommandResult(False, f"验收被拒绝：{decision.reason}", "验收被拒绝")
            requirement_store.set_requirement_status(req_id, ACCEPTED, "")
            reason = decision.reason
        finally:
            record_store.close()
        return CommandResult(
            True,
            f"需求 {req_id} 整体验收通过。\n依据：{reason}\n下一步：归并并发布已验收任务。",
            "已验收",
        )

    def _analyze(self, req_id: str, requirement_store: RequirementStore) -> CommandResult:
        if not self._pi_command:
            return CommandResult(
                False,
                "邮件入口未配置 --pi-command，无法执行分析；请通过 CLI 运行。",
                "分析未执行",
            )
        context = PlanningContext(
            requirement_store,
            req_id,
            self._root / "requirements" / req_id / "analysis",
            self._pi_command,
            timeout_seconds=self._pi_timeout_seconds,
        )
        outcome = analyze_requirement(context)
        if outcome.analysis is None:
            return CommandResult(False, f"分析未完成：{outcome.halted_reason}", "分析未完成")
        lines = [
            f"需求状态：{outcome.requirement_status}",
            f"目标：{outcome.analysis.goal}",
        ]
        if outcome.needs_clarification:
            lines.append("待澄清：")
            lines.extend(f"- {question}" for question in outcome.analysis.clarifications)
            lines.append("请直接回复本邮件写出补充说明，或回复 revise <内容>。")
        else:
            lines.append("分析已就绪，下一步：回复 plan 生成任务包。")
        return CommandResult(True, "\n".join(lines), "分析结果")

    def _plan(self, req_id: str, requirement_store: RequirementStore) -> CommandResult:
        if not self._pi_command:
            return CommandResult(
                False,
                "邮件入口未配置 --pi-command，无法生成任务包；请通过 CLI 运行。",
                "规划未执行",
            )
        context = PlanningContext(
            requirement_store,
            req_id,
            self._root / "requirements" / req_id / "analysis",
            self._pi_command,
            timeout_seconds=self._pi_timeout_seconds,
        )
        outcome = plan_requirement(context)
        if outcome.plan is None:
            return CommandResult(False, f"任务规划未完成：{outcome.halted_reason}", "规划未完成")
        plan = outcome.plan
        lines = [f"任务包 v{plan.plan_version}（{len(plan.tasks)} 个任务）已生成，等待批准。"]
        lines.extend(f"- {task.task_id}: {task.goal}" for task in plan.tasks)
        lines.append(f"批准命令（回复本邮件）：approve {plan.plan_version}")
        return CommandResult(True, "\n".join(lines), "任务包")

    def _advance(self, req_id: str, requirement_store: RequirementStore) -> CommandResult:
        if not self._pi_command:
            return CommandResult(
                False,
                "邮件入口未配置 --pi-command，无法推进；请通过 CLI 运行。",
                "推进未执行",
            )
        requirement = requirement_store.get(req_id)
        plan = requirement_store.latest_task_plan(req_id)
        runner = RequirementTaskRunner(
            records_root=self._root,
            req_id=req_id,
            plan_version=plan.plan_version if plan is not None else 0,
            project=requirement.project,
            pi_command=self._pi_command,
            project_path=self._project_path,
            baseline=self._baseline,
            pi_timeout_seconds=self._pi_timeout_seconds or None,
        )
        record_store = RecordStore(self._root / "records.sqlite")
        try:
            executor = RequirementExecutor(
                requirement_store, req_id, runner, slots=record_store.actions
            )
            status = requirement_store.requirement_status(req_id)
            if status in TERMINAL_REQUIREMENT_STATUSES:
                return CommandResult(
                    True,
                    f"需求已处于终态 {status}，不再推进。\n\n"
                    + self._status_text(requirement_store, req_id),
                    "推进结果",
                )
            progress = executor.advance()
        except RequirementAlreadyRunningError as error:
            return CommandResult(False, f"推进未启动：{error}", "推进未启动")
        finally:
            record_store.close()
        lines = [
            f"需求状态：{progress.requirement_status}",
            f"当前任务：{progress.current_task or '无'}",
            f"已完成：{'、'.join(progress.completed_tasks) or '无'}",
            f"下一步：{progress.next_step.action}"
            f"（{progress.next_step.actor.value}；{progress.next_step.reason}）",
        ]
        if progress.blocked_reason:
            lines.append(f"原因：{progress.blocked_reason}")
        lines.append("")
        lines.append(self._status_text(requirement_store, req_id))
        return CommandResult(True, "\n".join(lines), "推进结果")

    def _status_text(self, requirement_store: RequirementStore, req_id: str) -> str:
        """由权威记录汇总需求状态、任务包、批准与下一步；不执行任何任务。"""

        try:
            requirement = requirement_store.get(req_id)
        except RequirementNotFoundError:
            return f"需求不存在：{req_id}"
        status = requirement_store.requirement_status(req_id)
        lines = [f"需求：{req_id}（项目：{requirement.project}）", f"状态：{status}"]
        blocked = requirement_store.blocked_reason(req_id)
        if blocked:
            lines.append(f"阻塞原因：{blocked}")
        analysis = requirement_store.latest_analysis(req_id)
        if analysis is not None:
            readiness = "待澄清" if analysis.needs_clarification else "已就绪"
            lines.append(f"分析：v{analysis.analysis_version}（{readiness}）")
            if analysis.needs_clarification:
                lines.extend(f"- 待澄清：{question}" for question in analysis.clarifications)
        plan = requirement_store.latest_task_plan(req_id)
        if plan is not None:
            lines.append(f"任务包：v{plan.plan_version}（{len(plan.tasks)} 个任务）")
            approval = requirement_store.plan_approval(req_id)
            authorization = requirement_store.plan_authorization(req_id)
            approved = f"v{approval.plan_version}" if approval is not None else "无"
            lines.append(
                f"批准：{approved}；可执行：{'是' if authorization.can_execute else '否'}"
                f"（{authorization.reason}）"
            )
            runs = {
                run.task_id: run for run in requirement_store.task_runs(req_id, plan.plan_version)
            }
            for task in plan.tasks:
                run = runs.get(task.task_id)
                state = run.state if run is not None else "pending"
                reason = f"（{run.reason}）" if run is not None and run.reason else ""
                single_task_id = requirement_task_id(req_id, plan.plan_version, task.task_id)
                lines.append(f"- {task.task_id}: {state}{reason}（单任务 {single_task_id}）")
        progress = RequirementExecutor(requirement_store, req_id, _read_only_runner).progress()
        lines.append(f"当前任务：{progress.current_task or '无'}")
        lines.append(
            f"下一步：{progress.next_step.action}"
            f"（{progress.next_step.actor.value}；{progress.next_step.reason}）"
        )
        return "\n".join(lines)

    # ---- 回信：先落库再发送，失败只重发 ----

    def _reply(
        self,
        mail: InboundMail,
        req_id: str | None,
        command_name: str,
        result: CommandResult,
        interaction_store: MailInteractionStore,
        *,
        reply_state: InteractionState = InteractionState.ACTION_DONE,
        detail: str | None = None,
    ) -> InteractionOutcome:
        subject = interaction_subject(req_id, result.label)
        body = self._compose(result.summary, req_id)
        reply_message_id = _reply_message_id(mail.message_id)
        interaction_store.save_reply(
            mail.message_id,
            subject=subject,
            body=body,
            reply_message_id=reply_message_id,
            state=reply_state,
            detail=result.summary if detail is None else detail,
        )
        return self._send(
            mail,
            req_id or "",
            command_name,
            subject,
            body,
            reply_message_id,
            interaction_store,
            reply_state=reply_state,
        )

    def _send(
        self,
        mail: InboundMail,
        req_id: str,
        command_name: str,
        subject: str,
        body: str,
        reply_message_id: str,
        interaction_store: MailInteractionStore,
        *,
        reply_state: InteractionState = InteractionState.ACTION_DONE,
    ) -> InteractionOutcome:
        try:
            delivered = self._sender.send_reply(
                to=mail.sender,
                subject=subject,
                body=body,
                message_id=reply_message_id,
                in_reply_to=mail.message_id,
                references=_thread_references(mail),
            )
        except MailSendError as error:
            return InteractionOutcome(
                message_id=mail.message_id,
                req_id=req_id,
                command=command_name,
                authorized=True,
                processed=True,
                replied=False,
                state=reply_state.value,
                detail=f"回信发送失败：{error}",
            )
        if reply_state is InteractionState.ACTION_DONE:
            interaction_store.mark_replied(mail.message_id)
            state = InteractionState.COMPLETED.value
            detail = "已执行命令并回信"
        else:
            # 不确定现场的回信只说明事实；保留 uncertain 状态，避免下次轮询重放。
            state = reply_state.value
            detail = "已就不确定现场回信说明，未自动重放"
        return InteractionOutcome(
            message_id=mail.message_id,
            req_id=req_id,
            command=command_name,
            authorized=True,
            processed=True,
            replied=True,
            state=state,
            detail=detail,
            reply_message_id=delivered,
        )

    def _handle_existing(
        self,
        mail: InboundMail,
        record: MailInteractionRecord,
        interaction_store: MailInteractionStore,
    ) -> InteractionOutcome:
        """同一封入向邮件重复出现时：不重放命令，只按需补发回信或说明不确定。"""

        if record.state is InteractionState.COMPLETED:
            return self._existing_outcome(
                mail, record, processed=False, replied=False, detail="该邮件已处理过，未重复执行"
            )
        if record.state is InteractionState.ACTION_DONE:
            if not record.reply_body:
                return self._existing_outcome(
                    mail,
                    record,
                    processed=False,
                    replied=False,
                    detail="上次回信内容缺失，未重发",
                )
            return self._send(
                mail,
                record.req_id,
                record.command,
                record.reply_subject,
                record.reply_body,
                record.reply_message_id,
                interaction_store,
            )
        if record.state is InteractionState.EXECUTING:
            detail = "上次执行在完成前中断，未自动重放；请人工核对记录后再决定"
            interaction_store.mark_uncertain(mail.message_id, detail)
        elif record.state is not InteractionState.UNCERTAIN:
            return self._existing_outcome(
                mail,
                record,
                processed=False,
                replied=False,
                detail=record.detail or "该邮件未处于可继续处理的状态",
            )
        current = interaction_store.get(mail.message_id)
        if current is None:  # pragma: no cover - 刚写入或已存在，读取必然成功
            return self._existing_outcome(
                mail, record, processed=False, replied=False, detail=record.detail
            )
        if current.reply_message_id:
            return self._existing_outcome(
                mail,
                current,
                processed=False,
                replied=False,
                detail=current.detail or "执行结果不确定，已回信说明",
            )
        result = CommandResult(
            False,
            f"这封邮件的命令未自动重放：{current.detail}\n"
            f"需求：{current.req_id or '未关联'}\n命令：{current.command}\n"
            "请先用 CLI 核对记录，再决定是否重新发送本命令。",
            "待人工核对",
        )
        return self._reply(
            mail,
            current.req_id or None,
            current.command,
            result,
            interaction_store,
            reply_state=InteractionState.UNCERTAIN,
            detail=current.detail,
        )

    def _existing_outcome(
        self,
        mail: InboundMail,
        record: MailInteractionRecord,
        *,
        processed: bool,
        replied: bool,
        detail: str,
    ) -> InteractionOutcome:
        return InteractionOutcome(
            message_id=mail.message_id,
            req_id=record.req_id,
            command=record.command,
            authorized=True,
            processed=processed,
            replied=replied,
            state=record.state.value,
            detail=detail,
            reply_message_id=record.reply_message_id,
        )

    def _compose(self, summary: str, req_id: str | None) -> str:
        header = f"需求：{req_id}\n\n" if req_id else ""
        return f"{header}{summary}\n{REPLY_FOOTER}"


def _mail_interact_document(report: InteractionReport) -> dict:
    """``mail interact --once --json`` 的稳定文档：处理事实与回信身份。"""

    return {
        "command": "forgeloop mail interact --once",
        "fetched": report.fetched,
        "processed": len(report.processed),
        "replied": len(report.replied),
        "skipped": len(report.skipped),
        "errors": list(report.errors),
        "interactions": [
            {
                "message_id": outcome.message_id,
                "req_id": outcome.req_id,
                "command": outcome.command,
                "authorized": outcome.authorized,
                "processed": outcome.processed,
                "replied": outcome.replied,
                "state": outcome.state,
                "detail": outcome.detail,
                "reply_message_id": outcome.reply_message_id,
            }
            for outcome in report.outcomes
        ],
    }


def _emit(document: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return
    print(
        f"已拉取 {document['fetched']} 封，处理 {document['processed']} 封，"
        f"回信 {document['replied']} 封，跳过 {document['skipped']} 封。"
    )
    for error in document["errors"]:
        print(f"错误: {error}")
    for entry in document["interactions"]:
        state = "已回信" if entry["replied"] else entry["state"]
        print(
            f"- {entry['message_id']} | {entry['command'] or '无命令'} | {state}：{entry['detail']}"
        )


def cmd_mail_interact(args: argparse.Namespace) -> int:
    """cron 单次邮箱交互：处理命令、批准与状态回查，并按需回信。"""

    if not args.once:
        return fail("mail interact 只支持 --once 单次执行（交给 cron）；未给出 --once 时拒绝运行")
    if not args.allowed_sender:
        return fail("必须至少配置一个 --allowed-sender；未配置时邮箱入口不处理任何命令")
    try:
        pi_command = _parse_pi_command(args.pi_command)
    except MailInteractionError as error:
        return fail(str(error))
    try:
        root = records_root(args)
        project = project_for(base_records_root(args), args.project)
    except SystemExit as error:
        return fail(str(error))
    project_path = args.project_path
    if project_path:
        if Path(project_path).expanduser().resolve() != Path(project.repo_path).resolve():
            return fail(
                f"--project-path 与已登记项目 {project.project_id} 的仓库不一致："
                f"{project_path} != {project.repo_path}；请用 `forgeloop project update` 更新登记"
            )
    else:
        project_path = project.repo_path
    receiver = _make_receiver(args)
    sender = _make_sender(args)
    gateway = MailInteractionGateway(
        receiver,
        sender,
        root=root,
        project=project.project_id,
        allowed_senders=tuple(args.allowed_sender),
        pi_command=pi_command,
        project_path=project_path,
        baseline=args.baseline,
        pi_timeout_seconds=args.pi_timeout_seconds,
    )
    try:
        report = gateway.process_once()
    except MailAdapterError as error:
        return fail(str(error))
    finally:
        receiver.close()
    _emit(_mail_interact_document(report), args.json)
    return 0


def add_mail_interaction_parser(
    subparsers: argparse._SubParsersAction, default_records_root: str
) -> None:
    """注册 ``mail interact`` 子命令；连接参数与 ``mail poll`` 同源。"""

    interact = subparsers.add_parser(
        "interact", help="邮箱交互入口：收发命令、批准、验收与状态回查"
    )
    interact.add_argument("--once", action="store_true", help="cron 单次执行入口（必填）")
    interact.add_argument("--project", required=True, help="项目身份（project_id），须已登记")
    interact.add_argument(
        "--allowed-sender",
        action="append",
        default=[],
        required=True,
        metavar="ADDR",
        help="允许触发命令的发件地址（可重复，需登记全部实际发件地址）；未配置时拒绝运行",
    )
    interact.add_argument(
        "--pi-command",
        default="",
        help="PI RPC 启动命令（JSON 数组）；缺省时 analyze/plan/advance 只回复配置缺失",
    )
    interact.add_argument("--project-path", default="", help="被开发项目路径")
    interact.add_argument("--baseline", default="", help="代码基线")
    interact.add_argument(
        "--pi-timeout-seconds",
        type=float,
        default=300.0,
        help="单次 PI 调用等待上限（秒）",
    )
    interact.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    interact.add_argument(
        "--records-root",
        default=default_records_root,
        help="项目登记根；业务记录在 <root>/projects/<project_id>",
    )
    _add_connection_args(interact)
    interact.set_defaults(func=cmd_mail_interact)
