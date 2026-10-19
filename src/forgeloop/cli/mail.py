"""邮件工作流 CLI：cron 单次轮询、分类建议与人工确认后的三类反馈发信。

组合根职责（只做接线，不内建领域规则）：

- ``mail poll --once``：交给 cron 的单次入口。真实 IMAP 拉取未读邮件、按领域
  规则关联或新建需求、登记入向去重；随后**只展示**分类建议与待确认动作，绝不
  自动发信。重复执行由入向 Message-ID 与出向绑定保证幂等。
- ``mail confirm <req_id> --action …``：人工确认后的唯一发信入口。消歧与接纳
  成功由人工确认发送；**不接纳是最终决定**，除命令本身外还需显式
  ``--final-not-accept``，否则拒绝执行。
- 三类反馈（消歧 / 不接纳 / 接纳成功）使用稳定主题标记
  ``[ForgeLoop][<req_id>][<类型>]`` 与固定中文纯文本正文，可经
  :func:`identify_feedback` 从主题或正文稳定识别。

分类建议由 :func:`forgeloop.domain.mail.suggest_classification` 计算：缺信息
（无分析或分析仍有待澄清）→ 消歧；信息齐全但被显式列入 ``--out-of-scope``
→ 不接纳候选；信息齐全且在受理范围 → 接纳成功。所有事实来自权威记录与调用方
显式传入的范围策略，不由模型猜测。
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    ImapSettings,
    InboundMail,
    MailAdapter,
    MailAdapterError,
    PollReport,
    SmtpMailSender,
    SmtpSettings,
)
from forgeloop.cli.common import fail, records_root
from forgeloop.domain.mail import (
    MAX_DISAMBIGUATION_ROUNDS,
    Attachment,
    Classification,
    ClassificationSuggestion,
    DisambiguationQuestion,
    MailError,
    MailReply,
    MailThread,
    parse_reply_reference,
    render_notification,
    requests_cancellation,
    suggest_classification,
)
from forgeloop.domain.requirement import (
    ACCEPTED,
    CANCELLED,
    RequirementError,
    RequirementNotFoundError,
)
from forgeloop.records.mail_threads import MailThreadStore
from forgeloop.records.requirements import RequirementStore

# 三类反馈的稳定主题标记：主题里带标记，正文用领域固定模板，二者都能识别。
_KIND_MARKERS: dict[Classification, str] = {
    Classification.DISAMBIGUATE: "消歧",
    Classification.NOT_ACCEPT_CANDIDATE: "不接纳",
    Classification.ACCEPT_SUCCESS: "接纳成功",
}
# 终态反馈：接纳成功或不接纳一旦发出，同一需求不再产生新的消歧提问。
_TERMINAL_KINDS: frozenset[Classification] = frozenset(
    {Classification.NOT_ACCEPT_CANDIDATE, Classification.ACCEPT_SUCCESS}
)
# 终态需求不再接收邮件答复回流（取消/验收后只读）。
_TERMINAL_REQUIREMENT_STATUSES = frozenset({ACCEPTED, CANCELLED})

_ACTION_KINDS: dict[str, Classification] = {
    "disambiguate": Classification.DISAMBIGUATE,
    "not_accept": Classification.NOT_ACCEPT_CANDIDATE,
    "accept": Classification.ACCEPT_SUCCESS,
}
# 识别顺序很重要：先判「不接纳」，再判「接纳成功」，最后判「消歧」。
_IDENTIFY_ORDER: tuple[tuple[Classification, str], ...] = (
    (Classification.NOT_ACCEPT_CANDIDATE, "不接纳"),
    (Classification.ACCEPT_SUCCESS, "接纳成功"),
    (Classification.DISAMBIGUATE, "消歧"),
)


def feedback_subject(req_id: str, kind: Classification) -> str:
    """三类反馈的稳定主题：``[ForgeLoop][<req_id>][<类型>]``。"""

    return f"[ForgeLoop][{req_id}][{_KIND_MARKERS[kind]}]"


def identify_feedback(subject: str, body: str) -> Classification | None:
    """从主题或正文稳定识别反馈类型；都不识别返回 ``None``。"""

    haystack = f"{subject}\n{body}"
    for kind, marker in _IDENTIFY_ORDER:
        if marker in haystack:
            return kind
    return None


def _to_reply(mail: InboundMail) -> MailReply:
    """把适配器入向邮件转成领域回复对象，供关联解析；附件只留元数据。"""

    return MailReply(
        received_at=mail.received_at,
        in_reply_to=mail.in_reply_to,
        references=mail.references,
        subject=mail.subject,
        body=mail.body,
        attachments=tuple(
            Attachment(attachment.filename, attachment.content_type, attachment.size_bytes)
            for attachment in mail.attachments
        ),
    )


def _requirement_text(mail: InboundMail) -> str:
    """无既有线索时，把邮件主题与正文作为新需求原文；不丢弃原文。"""

    subject = mail.subject.strip()
    body = mail.body.strip()
    if subject and body:
        return f"{subject}\n\n{body}"
    return subject or body


def _open_thread_connection(root: Path) -> sqlite3.Connection:
    """邮件线索记录与需求记录共用同一 ``records.sqlite``，各持独立连接。"""

    root.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(root / "records.sqlite", isolation_level=None)


def _secret(explicit: str, env_name: str) -> str:
    return explicit or os.environ.get(env_name, "")


class _ResolvedMail:
    """一次命令所需的连接参数：显式参数优先，其余由配置层补齐。"""

    imap_host: str
    imap_port: int
    imap_user: str
    imap_secret: str
    imap_folder: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_secret: str
    smtp_sender: str
    smtp_recipient: str


def _resolve_connection(args: argparse.Namespace) -> _ResolvedMail:
    """把 ``--config``（或配置链）解析成连接参数；显式参数优先，缺失即 fail-closed。"""

    explicit = str(getattr(args, "config", "") or "")
    explicit_config = Path(explicit).expanduser() if explicit else None
    # 只在**显式参数不足以建连**时才读配置文件：显式调用（含既有测试与本地假服务器）
    # 完全沿用旧行为，不会因为机器上存在别的邮件配置而被牵连。
    needs_config = not (
        args.imap_host
        and args.imap_user
        and args.smtp_host
        and (args.smtp_sender or args.imap_user)
        and args.smtp_recipient
    )
    config = None
    secret = ""
    if needs_config:
        from forgeloop.mail.config import load_mail_config
        from forgeloop.mail.presets import preset_for
        from forgeloop.mail.secret import SecretStatus, resolve_secret

        config = load_mail_config(
            explicit_path=explicit_config, repo_root=Path.cwd(), home=Path.home()
        )
        preset = preset_for(config.provider)
        account = args.imap_user or config.sender
        resolution = resolve_secret(repo_root=Path.cwd(), home=Path.home(), default_account=account)
        if not resolution.secret:
            problems = "；".join(
                f"{report.candidate.label}: {report.status}"
                for report in resolution.reports
                if report.status is not SecretStatus.AVAILABLE
            )
            raise MailAdapterError(f"口令不可用（{problems or '无候选'}）")
        secret = resolution.secret.reveal()
    resolved = _ResolvedMail()
    if config is None:
        resolved.imap_host, resolved.imap_port = args.imap_host, args.imap_port or 993
        resolved.imap_user, resolved.imap_folder = args.imap_user, args.imap_folder or "INBOX"
        resolved.smtp_host, resolved.smtp_port = args.smtp_host, args.smtp_port or 465
        resolved.smtp_user = args.smtp_user or args.imap_user
        resolved.smtp_sender = args.smtp_sender or args.imap_user
        resolved.smtp_recipient = args.smtp_recipient
    else:
        endpoint = preset.default_smtp_endpoint
        resolved.imap_host = args.imap_host or preset.imap_host
        resolved.imap_port = args.imap_port or preset.imap_port
        resolved.imap_user = args.imap_user or config.sender
        resolved.imap_folder = args.imap_folder or config.folder
        resolved.smtp_host = args.smtp_host or endpoint.host
        resolved.smtp_port = args.smtp_port or endpoint.port
        resolved.smtp_user = args.smtp_user or config.sender
        resolved.smtp_sender = args.smtp_sender or config.sender
        resolved.smtp_recipient = args.smtp_recipient or config.recipient
    resolved.imap_secret = _secret(args.imap_secret, "FORGELOOP_IMAP_SECRET") or secret
    resolved.smtp_secret = _secret(args.smtp_secret, "FORGELOOP_SMTP_SECRET") or secret
    for name in (
        "imap_host",
        "imap_user",
        "imap_secret",
        "smtp_host",
        "smtp_sender",
        "smtp_recipient",
    ):
        if not getattr(resolved, name):
            raise MailAdapterError(f"缺少连接参数 {name}：请提供 --config 或显式参数")
    return resolved


def _make_receiver(args: argparse.Namespace) -> ImapMailReceiver:
    resolved = _resolve_connection(args)
    return ImapMailReceiver(
        ImapSettings(
            host=resolved.imap_host,
            port=resolved.imap_port,
            username=resolved.imap_user,
            secret=resolved.imap_secret,
            use_ssl=not args.no_imap_ssl,
            folder=resolved.imap_folder,
        )
    )


def _make_sender(args: argparse.Namespace) -> SmtpMailSender:
    resolved = _resolve_connection(args)
    return SmtpMailSender(
        SmtpSettings(
            host=resolved.smtp_host,
            port=resolved.smtp_port,
            username=resolved.smtp_user,
            secret=resolved.smtp_secret,
            sender=resolved.smtp_sender,
            recipient=resolved.smtp_recipient,
            use_ssl=not args.no_smtp_ssl,
            starttls=args.smtp_starttls,
        )
    )


def _resolve_requirement(
    mail: InboundMail,
    thread_store: MailThreadStore,
    requirement_store: RequirementStore,
    project: str,
    *,
    whitelist: frozenset[str] = frozenset(),
    created_ids: set[str] | None = None,
) -> str | None:
    """按固定优先级把邮件关联需求；无任何线索时新建需求（幂等）。

    先查入向去重账：重复轮询的同一封邮件直接返回既有需求，绝不重复新建。无头信息
    时回退到主题/正文编号；仍无编号才把主题+正文作为新需求原文提交。
    """

    existing = thread_store.inbound_message(mail.message_id)
    if existing is not None:
        return existing.req_id
    reference = parse_reply_reference(_to_reply(mail))
    if reference is not None:
        return reference
    # 2026-10-19：让 `mail.whitelist` 配置真正生效——名单非空时只有名单内的发件人
    # 能**新建**需求；名单外只跳过并如实报告，不静默建单。回复既有需求不受限制。
    if whitelist and mail.sender.strip().lower() not in whitelist:
        return None
    created = requirement_store.submit(project, _requirement_text(mail))
    if created_ids is not None:
        # 记下"这个需求就是本封邮件建的"：它不是答复，不该再回流一遍正文。
        created_ids.add(created.req_id)
    return created.req_id


def auto_analyze_setting(args: argparse.Namespace) -> bool:
    """自动分析开关：``--auto-analyze/--no-auto-analyze`` 优先，其次邮件配置，缺省关闭。

    关闭是刻意的默认（分析要花模型调用）。配置不可读时按关闭处理并如实报告。
    """

    explicit = getattr(args, "auto_analyze", None)
    if explicit is not None:
        return bool(explicit)
    try:
        from forgeloop.mail.config import load_mail_config

        explicit_config = str(getattr(args, "config", "") or "").strip()
        config = load_mail_config(
            explicit_path=Path(explicit_config).expanduser() if explicit_config else None,
            repo_root=Path.cwd(),
            home=Path.home(),
        )
    except Exception:
        return False
    return bool(config.auto_analyze)


def auto_reply_setting(args: argparse.Namespace) -> bool:
    """自动回复开关：命令行优先，其次邮件配置 ``auto_reply``（缺省开启）。"""

    explicit = getattr(args, "auto_reply", None)
    if explicit is not None:
        return bool(explicit)
    try:
        from forgeloop.mail.config import load_mail_config

        explicit_config = str(getattr(args, "config", "") or "").strip()
        config = load_mail_config(
            explicit_path=Path(explicit_config).expanduser() if explicit_config else None,
            repo_root=Path.cwd(),
            home=Path.home(),
        )
    except Exception:
        return True
    return bool(config.auto_reply)


_MAIL_OPERATION_PREFIXES = ("操作:", "操作：", "action:")


def mail_operation(subject: str, body: str) -> tuple[str, str]:
    """解析邮件里的结构化操作指令，返回 ``(操作, 理由)``；没有指令返回 ``("", "")``。

    只认**明确行**（``操作: 批准`` / ``action: cancel``），不做自由文本推断——批准、验收
    这类高风险动作不能被一句闲聊触发。理由可写在下一行（``理由: ...``）。
    """

    lines = [line.strip() for line in f"{subject}\n{body}".splitlines() if line.strip()]
    for index, line in enumerate(lines):
        lowered = line.lower()
        prefix = next((item for item in _MAIL_OPERATION_PREFIXES if lowered.startswith(item)), "")
        if not prefix:
            continue
        operation = line[len(prefix) :].strip().lower()
        reason = ""
        for follow in lines[index + 1 : index + 3]:
            for marker in ("理由:", "理由：", "reason:"):
                if follow.lower().startswith(marker):
                    reason = follow[len(marker) :].strip()
        return operation, reason
    return "", ""


def _effective_whitelist(args: argparse.Namespace) -> tuple[frozenset[str], str]:
    """生效的发件人白名单：``--whitelist`` 优先，其次邮件配置里的 ``whitelist``。

    返回 ``(白名单, 来源说明)``。都没有时返回空集合——表示**不限制**（保持既有行为）；
    配置不可读时不报错、退回不限制，并把原因写进来源说明（fail-open 在这里是刻意的：
    白名单只影响"谁能新建需求"，不影响同一条线索的既有往来）。
    """

    explicit = [
        item.strip().lower() for item in (getattr(args, "whitelist", None) or []) if item.strip()
    ]
    if explicit:
        return frozenset(explicit), "命令行 --whitelist"
    try:
        from forgeloop.mail.config import load_mail_config

        explicit_config = str(getattr(args, "config", "") or "").strip()
        config = load_mail_config(
            explicit_path=Path(explicit_config).expanduser() if explicit_config else None,
            repo_root=Path.cwd(),
            home=Path.home(),
        )
    except Exception as error:
        return frozenset(), f"未配置（邮件配置不可用：{type(error).__name__}）"
    configured = frozenset(item.strip().lower() for item in config.whitelist if item.strip())
    if configured:
        return configured, f"邮件配置 {config.source_path} 的 whitelist"
    return frozenset(), f"未配置（{config.source_path} 没有 whitelist）"


def _build_adapter(
    args: argparse.Namespace,
    thread_store: MailThreadStore,
    requirement_store: RequirementStore,
) -> MailAdapter:
    """把真实邮箱边界接到记录/关联接缝上；由 CLI 作为组合根装配。"""

    receiver = _make_receiver(args)
    sender = _make_sender(args)

    created_by_this_poll: set[str] = set()

    def record_inbound(mail: InboundMail, req_id: str) -> bool:
        created = thread_store.record_inbound(
            mail.message_id,
            req_id,
            mail.received_at,
            sender=mail.sender,
            subject=mail.subject,
            folder=mail.folder,
        ).created
        # 邮件等价操作（所有者 2026-10-19：邮件与页面/CLI 同等位置）：白名单内发件人
        # 的取消意图**直接生效**——按该身份落库终态并留痕（source=mail），白名单外仍只是
        # 数据（仅作取消提议，等人工处理）。既有全部记录规则不变：不删记录、理由必填。
        whitelist = _effective_whitelist(args)[0]
        operation, operation_reason = mail_operation(mail.subject, mail.body)
        if created and operation and (not whitelist or mail.sender.strip().lower() in whitelist):
            plan = requirement_store.latest_task_plan(req_id)
            if operation in {"批准", "approve"} and plan is not None:
                requirement_store.record_plan_approval(
                    req_id,
                    plan.plan_version,
                    mail.sender.strip(),
                    source=f"mail:{operation_reason or '邮件批准'}",
                )
        cancelled_by_mail = False
        if (
            created
            and mail.body.strip()
            and requests_cancellation(mail.subject, mail.body)
            and (not whitelist or mail.sender.strip().lower() in whitelist)
        ):
            try:
                current = requirement_store.requirement_status(req_id)
            except RequirementNotFoundError:
                current = ""
            if current not in _TERMINAL_REQUIREMENT_STATUSES:
                with contextlib.suppress(RequirementError, RequirementNotFoundError):
                    requirement_store.record_requirement_cancellation(
                        req_id,
                        by=mail.sender.strip(),
                        reason=f"[邮件/取消] {mail.subject}".strip(),
                    )
                    cancelled_by_mail = True
        # 邮件对话闭环（所有者 2026-10-19）：同一线索引发的**新**入向邮件，把正文作为
        # 答复追加成需求的修订版本，状态回到 draft 等待重新分析——答复不再是孤立的
        # 邮件记录，而是真的进入需求材料。只追加、不覆盖；已验收/已取消的终态不追加。
        # 操作类邮件（操作: 批准/停止/…）是**决定**，不是答复材料：回流会把需求改回
        # draft、使批准失效，从而让"当前任务"消失（停止/推进随即无法定位）。取消同样不回流。
        is_operation_mail = bool(operation)
        created_this_mail = req_id in created_by_this_poll
        if (
            created
            and mail.body.strip()
            and not cancelled_by_mail
            and not is_operation_mail
            and not created_this_mail
        ):
            try:
                current = requirement_store.requirement_status(req_id)
            except RequirementNotFoundError:
                current = ""
            if current not in _TERMINAL_REQUIREMENT_STATUSES:
                try:
                    requirement_store.append(
                        req_id, f"【邮件答复】{mail.subject}\n\n{mail.body.strip()}"
                    )
                except RequirementError:
                    return created
        return created

    def record_outbound(message_id: str, req_id: str, kind: str, sent_at: datetime) -> bool:
        return thread_store.record_outbound(message_id, req_id, kind, sent_at).created

    return MailAdapter(
        receiver,
        sender,
        resolve_requirement=lambda mail: _resolve_requirement(
            mail,
            thread_store,
            requirement_store,
            args.project,
            whitelist=_effective_whitelist(args)[0],
            created_ids=created_by_this_poll,
        ),
        record_inbound=record_inbound,
        cancel_intent=lambda mail: requests_cancellation(mail.subject, mail.body),
        operation_intent=lambda mail: mail_operation(mail.subject, mail.body)[0],
        record_outbound=record_outbound,
        now=lambda: datetime.now(UTC),
    )


def _suggestion_for(
    requirement_store: RequirementStore,
    req_id: str,
    out_of_scope: frozenset[str],
) -> ClassificationSuggestion:
    """按记录事实给出分类建议：缺信息优先消歧，再看不接纳候选与接纳成功。"""

    try:
        analysis = requirement_store.latest_analysis(req_id)
    except RequirementNotFoundError:
        analysis = None
    needs_clarification = analysis is None or analysis.needs_clarification
    return suggest_classification(
        needs_clarification=needs_clarification,
        within_scope=req_id not in out_of_scope,
    )


def _entry(
    *,
    req_id: str,
    message_id: str,
    registered: bool,
    suggestion: ClassificationSuggestion | None,
    terminal: bool,
    feedback_sent: bool,
    pending_action: bool,
    cancel_proposal: bool = False,
    operation: str = "",
    mail_sender: str = "",
) -> dict:
    return {
        "req_id": req_id,
        "message_id": message_id,
        "cancel_proposal": cancel_proposal,
        "operation": operation,
        "mail_sender": mail_sender,
        "registered": registered,
        "suggestion": (
            None
            if suggestion is None
            else {"kind": suggestion.kind.value, "reason": suggestion.reason}
        ),
        "terminal": terminal,
        "initial_feedback_sent": feedback_sent,
        "awaiting_human_confirmation": pending_action,
        "confirm_command": (
            f"forgeloop mail confirm {req_id} --action <disambiguate|not_accept|accept>"
        ),
    }


def _pending_action(
    kinds: tuple[Classification, ...],
    suggestion: ClassificationSuggestion | None,
    inbound_count: int,
    disambiguation_rounds: int,
) -> bool:
    """是否还有待人工确认的发信动作。

    终态建议一旦发出即不再确认；消歧按「每一封入向邮件只对应一封出向反馈」判定，
    已反馈的入向不再重复确认，新入向到达后允许继续下一轮，达到 3 轮上限后退回人工。
    """

    if suggestion is None:
        return False
    if suggestion.kind in _TERMINAL_KINDS:
        return suggestion.kind not in kinds
    if suggestion.kind is Classification.DISAMBIGUATE and (
        disambiguation_rounds >= MAX_DISAMBIGUATION_ROUNDS
    ):
        return False
    return len(kinds) < inbound_count


def _pending_entries(
    report: PollReport,
    thread_store: MailThreadStore,
    requirement_store: RequirementStore,
    out_of_scope: frozenset[str],
) -> list[dict]:
    entries: list[dict] = []
    for result in report.results:
        if result.req_id is None:
            continue
        req_id = result.req_id
        kinds = tuple(thread_store.kind_sequence(req_id))
        terminal = any(kind in _TERMINAL_KINDS for kind in kinds)
        suggestion = None if terminal else _suggestion_for(requirement_store, req_id, out_of_scope)
        entries.append(
            _entry(
                req_id=req_id,
                message_id=result.message_id,
                registered=result.registered,
                suggestion=suggestion,
                terminal=terminal,
                feedback_sent=bool(kinds),
                cancel_proposal=result.cancel_requested,
                operation=result.operation,
                mail_sender=result.sender,
                pending_action=_pending_action(
                    kinds,
                    suggestion,
                    len(thread_store.inbound(req_id)),
                    thread_store.disambiguation_rounds(req_id),
                ),
            )
        )
    return entries


def _mail_poll_document(
    report: PollReport,
    entries: list[dict],
    *,
    whitelist: frozenset[str] = frozenset(),
    whitelist_source: str = "",
) -> dict:
    """``mail poll --once --json`` 的稳定文档：只读事实与待确认动作。"""

    return {
        "command": "forgeloop mail poll --once",
        # 建需求白名单（2026-10-19）：谁能通过邮件新建需求；source 说明它来自哪里。
        "whitelist": {
            "senders": sorted(whitelist),
            "source": whitelist_source,
            "enforced": bool(whitelist),
        },
        "fetched": report.fetched,
        "registered": report.registered,
        "skipped": len(report.skipped),
        "errors": list(report.errors),
        "requirements": entries,
    }


def _mail_confirm_document(
    req_id: str,
    kind: str,
    *,
    sent: bool,
    already_sent: bool,
    message_id: str | None,
    reason: str,
) -> dict:
    """``mail confirm`` 的稳定文档：是否真正发信、Message-ID 与原因。"""

    return {
        "command": "forgeloop mail confirm",
        "req_id": req_id,
        "kind": kind,
        "sent": sent,
        "already_sent": already_sent,
        "message_id": message_id,
        "reason": reason,
    }


def _parse_questions(raw_questions: list[str]) -> tuple[DisambiguationQuestion, ...]:
    """解析 ``--question ID=文本``；缺省用编号本身作问题文本。"""

    questions: list[DisambiguationQuestion] = []
    for raw in raw_questions:
        question_id, _, text = raw.partition("=")
        questions.append(DisambiguationQuestion(question_id.strip(), (text or question_id).strip()))
    return tuple(questions)


def _build_feedback(
    req_id: str,
    kind: Classification,
    questions: tuple[DisambiguationQuestion, ...],
    reason: str,
) -> tuple[str, str]:
    """构造稳定主题与固定中文纯文本正文；不接纳附加人工给出的原因。"""

    subject = feedback_subject(req_id, kind)
    thread = MailThread(req_id)
    if kind is Classification.DISAMBIGUATE:
        body = render_notification(thread, questions)
    elif kind is Classification.ACCEPT_SUCCESS:
        body = render_notification(thread.accept())
    else:
        body = render_notification(thread.reject())
    if reason and kind is not Classification.DISAMBIGUATE:
        body = f"{body}说明：{reason}\n"
    return subject, body


def _emit(document: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return
    if "requirements" in document:
        print(f"已拉取 {document['fetched']} 封，登记 {document['registered']} 封。")
        for error in document["errors"]:
            print(f"未能解析: {error}")
        for entry in document["requirements"]:
            suggestion = entry["suggestion"]
            kind = suggestion["kind"] if suggestion else "无（已终态或已反馈）"
            print(f"- {entry['req_id']}（{entry['message_id']}）分类建议: {kind}")
            if entry["awaiting_human_confirmation"]:
                print(f"  待人工确认: {entry['confirm_command']}")
        return
    state = (
        "已发送"
        if document["sent"]
        else ("已发送过，未重复发送" if document["already_sent"] else "未发送")
    )
    print(f"{document['req_id']} 反馈（{document['kind']}）: {state}")
    if document["message_id"]:
        print(f"Message-ID: {document['message_id']}")
    print(f"原因: {document['reason']}")


def cmd_mail_poll(args: argparse.Namespace) -> int:
    """cron 单次邮件轮询：登记需求、展示分类建议，绝不自动发信。"""

    if not args.once:
        return fail("mail poll 只支持 --once 单次执行（交给 cron）；未给出 --once 时拒绝运行")
    root = records_root(args)
    requirement_store = RequirementStore(root / "records.sqlite")
    connection = _open_thread_connection(root)
    thread_store = MailThreadStore(connection)
    adapter = _build_adapter(args, thread_store, requirement_store)
    try:
        try:
            report = adapter.poll_once()
            entries = _pending_entries(
                report, thread_store, requirement_store, frozenset(args.out_of_scope)
            )
        except MailAdapterError as error:
            return fail(str(error))
    finally:
        connection.close()
        requirement_store.close()
    whitelist, whitelist_source = _effective_whitelist(args)
    args.poll_document = _mail_poll_document(
        report, entries, whitelist=whitelist, whitelist_source=whitelist_source
    )
    _emit(args.poll_document, args.json)
    if not args.json:
        note = (
            f"建需求白名单：{'、'.join(sorted(whitelist))}（{whitelist_source}）"
            if whitelist
            else f"建需求白名单：未启用（{whitelist_source}）——任何来信都会建草稿需求"
        )
        print(note)
    return 0


def _feedback_decision(thread_store: MailThreadStore, req_id: str, kind: Classification) -> str:
    """能否发信：``""`` 表示可以；否则返回人类可读的拒绝原因（只读判定）。"""

    existing = tuple(thread_store.kind_sequence(req_id))
    if any(item in _TERMINAL_KINDS for item in existing):
        return "需求已进入终态，不再发送新的反馈"
    inbound_count = len(thread_store.inbound(req_id))
    if kind not in _TERMINAL_KINDS and len(existing) >= inbound_count:
        return "该入向邮件已有一封反馈，重复确认不重复发信"
    if (
        kind is Classification.DISAMBIGUATE
        and thread_store.disambiguation_rounds(req_id) >= MAX_DISAMBIGUATION_ROUNDS
    ):
        return f"消歧轮次已达上限 {MAX_DISAMBIGUATION_ROUNDS} 轮，退回人工处理"
    return ""


def send_feedback(
    args: argparse.Namespace,
    thread_store: MailThreadStore,
    requirement_store: RequirementStore,
    req_id: str,
    kind: Classification,
    questions: tuple[DisambiguationQuestion, ...] = (),
    reason: str = "",
) -> dict:
    """把一次反馈真正发出去并返回确认文档（人工确认与自动回复共用同一内核）。

    只做"能不能发 + 发 + 记"，不做策略判断：调用方负责决定 kind 与 questions。
    """

    refusal = _feedback_decision(thread_store, req_id, kind)
    if refusal:
        return _mail_confirm_document(
            req_id,
            kind.value,
            sent=False,
            already_sent="已有一封反馈" in refusal,
            message_id=None,
            reason=refusal,
        )
    adapter = _build_adapter(args, thread_store, requirement_store)
    try:
        subject, body = _build_feedback(req_id, kind, questions, reason)
        receipt = adapter.send_feedback(req_id=req_id, kind=kind.value, subject=subject, body=body)
    finally:
        adapter.close()
    return _mail_confirm_document(
        req_id,
        kind.value,
        sent=True,
        already_sent=False,
        message_id=receipt.message_id,
        reason="已发送并绑定需求线索",
    )


def cmd_mail_confirm(args: argparse.Namespace) -> int:
    """人工确认后的唯一发信入口；不接纳最终决定需显式确认。"""

    kind = _ACTION_KINDS[args.action]
    if kind is Classification.NOT_ACCEPT_CANDIDATE and not args.final_not_accept:
        return fail("不接纳是最终决定，必须显式 --final-not-accept 由人工确认")
    try:
        questions = _parse_questions(args.questions)
    except MailError as error:
        return fail(str(error))
    if kind is Classification.DISAMBIGUATE and not questions:
        return fail("消歧反馈至少要给出一个 --question ID=问题")

    root = records_root(args)
    requirement_store = RequirementStore(root / "records.sqlite")
    connection = _open_thread_connection(root)
    thread_store = MailThreadStore(connection)
    try:
        try:
            existing = tuple(thread_store.kind_sequence(args.req_id))
            if any(item in _TERMINAL_KINDS for item in existing):
                return fail("需求已进入终态，不再发送新的反馈")
            if (
                kind is Classification.DISAMBIGUATE
                and thread_store.disambiguation_rounds(args.req_id) >= MAX_DISAMBIGUATION_ROUNDS
                and len(existing) < len(thread_store.inbound(args.req_id))
            ):
                return fail(f"消歧轮次已达上限 {MAX_DISAMBIGUATION_ROUNDS} 轮，退回人工处理")
            document = send_feedback(
                args,
                thread_store,
                requirement_store,
                args.req_id,
                kind,
                questions,
                args.reason,
            )
        except MailAdapterError as error:
            return fail(str(error))
    finally:
        connection.close()
        requirement_store.close()
    _emit(document, args.json)
    return 0


def _add_connection_args(parser: argparse.ArgumentParser) -> None:
    """连接参数：**显式参数优先**，为空时由 ``--config`` 指定的配置链、服务商预设与口令链解析。

    2026-10-18 所有者决定（"接配置"）：已验收的 ``mail`` 配置层（provider 预设、配置
    解析链、口令候选链）接上 CLI，生产环境只需 ``--config``（或配置链自动命中）即可
    运行；显式参数仍完全可用，本地测试与旧调用不受影响。
    """

    parser.add_argument(
        "--config", default="", help="邮件配置文件（provider/sender/recipient/folder）"
    )
    parser.add_argument("--imap-host", default="")
    parser.add_argument("--imap-port", type=int, default=0)
    parser.add_argument("--imap-user", default="")
    parser.add_argument("--imap-secret", default="")
    parser.add_argument("--imap-folder", default="")
    parser.add_argument("--no-imap-ssl", action="store_true", help="本地测试用：关闭 IMAP SSL")
    parser.add_argument("--smtp-host", default="")
    parser.add_argument("--smtp-port", type=int, default=0)
    parser.add_argument("--smtp-user", default="")
    parser.add_argument("--smtp-secret", default="")
    parser.add_argument("--smtp-sender", default="")
    parser.add_argument("--smtp-recipient", default="")
    parser.add_argument("--no-smtp-ssl", action="store_true", help="本地测试用：关闭 SMTP SSL")
    parser.add_argument("--smtp-starttls", action="store_true")


def add_mail_parser(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
    *,
    poll_entry: Callable[[argparse.Namespace], int] | None = None,
) -> None:
    """注册 ``mail`` 命令组（poll/confirm）；解析器装配留在命令模块内。"""

    mail = subparsers.add_parser("mail", help="邮件工作流：cron 轮询、分类建议与人工确认发信")
    actions = mail.add_subparsers(dest="mail_command", required=True)

    poll = actions.add_parser("poll", help="单次轮询邮件需求并展示分类建议（不发信）")
    poll.add_argument("--once", action="store_true", help="cron 单次执行入口（必填）")
    poll.add_argument("--project", required=True, help="新邮件需求绑定的项目名")
    poll.add_argument(
        "--auto-reply",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="轮询后自动发出回信（发问/接纳）；缺省取邮件配置 auto_reply，默认开启",
    )
    poll.add_argument(
        "--auto-analyze",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="新入向邮件登记后自动跑一次需求分析（缺省取邮件配置 auto_analyze；需 --pi-command）",
    )
    poll.add_argument("--pi-command", default="", help="自动分析用的 PI RPC 启动命令（JSON 数组）")
    poll.add_argument("--project-path", default="", help="被开发项目路径（自动分析用）")
    poll.add_argument("--baseline", default="", help="代码基线（自动分析用）")
    poll.add_argument("--pi-timeout-seconds", type=float, default=0.0)
    poll.add_argument(
        "--whitelist",
        action="append",
        default=[],
        help="允许**新建需求**的发件人（可重复）；给出后名单外的来信只跳过并如实报告",
    )
    poll.add_argument(
        "--out-of-scope",
        action="append",
        default=[],
        metavar="REQ_ID",
        help="显式标记不在受理范围的需求（可重复）；未被标记且信息齐全即建议接纳",
    )
    poll.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    poll.add_argument("--records-root", default=default_records_root)
    _add_connection_args(poll)
    # 实际入口在组合根（main.cmd_mail_poll_with_analysis）：轮询后按 auto_analyze 决定是否分析。
    poll.set_defaults(func=poll_entry or cmd_mail_poll)

    confirm = actions.add_parser("confirm", help="人工确认后发送一类反馈邮件")
    confirm.add_argument("req_id")
    confirm.add_argument(
        "--action", required=True, choices=["disambiguate", "not_accept", "accept"]
    )
    confirm.add_argument(
        "--question",
        action="append",
        default=[],
        dest="questions",
        metavar="ID=问题",
        help="消歧待澄清问题（可重复）",
    )
    confirm.add_argument("--reason", default="", help="不接纳原因等说明")
    confirm.add_argument(
        "--final-not-accept",
        action="store_true",
        help="显式确认不接纳这一最终决定；缺少时拒绝发送",
    )
    confirm.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    confirm.add_argument("--records-root", default=default_records_root)
    _add_connection_args(confirm)
    confirm.set_defaults(func=cmd_mail_confirm)
