"""页面会话面板（cli 层）：项目档案、会话/运行时读模型与写端点分发。

职责边界：

- **项目档案的唯一入口**：``config/service.toml`` 的 ``[projects.<名字>]`` 由所有者手写，
  页面只读；页面新增/编辑/删除的是面板项目档案（默认 ``config/projects.toml``，整份由
  页面生成）。同名视为冲突并显式失败，项目身份只有一个来源。
- **只做装配与闸门**：会话规则在 ``domain.conversation``、项目档案规则在
  ``domain.projects``、记录在 ``records.conversations``、一轮执行在
  ``graph.conversation``。本模块读配置、组装文档、把请求分派到这些入口。
- **写入口仍是既有三道闸门**：令牌、同源与请求体上限由 ``cli.serve`` 的处理器校验；
  本模块只做业务前置判定（必填、就绪、冲突），失败一律 fail-closed 并给出原因。
- **不碰研发业务状态**：面板不批准、不验收、不推进任何需求；它与既有写入口并列，
  共用同一份权威记录，不新建第二套研发状态。

``readiness``（项目是否具备执行前提：路径、隔离 HOME）由 ``cli.serve`` 注入：这里不碰
文件系统之外的服务化判据，也不反向导入 ``cli.serve``（会形成 import 环）。
"""

from __future__ import annotations

import os
import re
import threading
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType

from forgeloop.domain.conversation import (
    ConversationError,
    DecisionKind,
    DecisionStatus,
    MessageRole,
    SessionStatus,
    can_decide,
    validate_message,
    validate_reason,
)
from forgeloop.domain.projects import (
    SOURCE_PANEL,
    PanelProject,
    PanelProjectError,
    ProjectEntry,
    merge_projects,
    project_from_fields,
    resolve_panel_projects,
    serialize_panel_projects,
)
from forgeloop.domain.service import ProjectProfile
from forgeloop.graph.conversation import ConversationRunner
from forgeloop.records.conversations import (
    ConversationStore,
    DecisionRecord,
    SessionRecord,
    ToolCallRecord,
)

PANEL_API_SCHEMA_VERSION = 1
PANEL_ROUTE = "/api/panel"
PANEL_SESSIONS_ROUTE = "/api/panel/sessions"
PANEL_PROJECTS_ROUTE = "/api/panel/projects"
SESSION_LIMIT = 50
MESSAGE_LIMIT = 200
DECISION_LIMIT = 100
TOOL_CALL_LIMIT = 200
SOURCE_WEB = "web"
"""写操作的审计来源前缀，与既有页面写入口一致（``web:<by>``）。"""


class PanelRejected(Exception):
    """面板写请求被拒绝：``status`` 是 HTTP 状态码，``code`` 是稳定的机器标签。"""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class PanelContext:
    """面板的一次装配：项目注册表、执行器、就绪判定与记录库路径。"""

    registry: PanelRegistry
    runner: ConversationRunner
    readiness: Callable[[ProjectEntry], tuple[str, ...]]
    db_path: Path

    def store(self) -> ConversationStore:
        return ConversationStore(self.db_path)


class PanelRegistry:
    """面板项目档案的读写入口：手写配置只读，页面档案由页面独占写入。"""

    def __init__(self, service_projects: Mapping[str, ProjectProfile], projects_path: Path) -> None:
        self._service = service_projects
        self._path = projects_path
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._path

    def entries(self) -> tuple[ProjectEntry, ...]:
        """合并两个来源并按名字排序；文件损坏或同名冲突即显式失败。"""

        with self._lock:
            return merge_projects(self._service, self._read())

    def by_name(self) -> Mapping[str, ProjectEntry]:
        return MappingProxyType({entry.name: entry for entry in self.entries()})

    def create(self, project: PanelProject) -> None:
        """新增页面项目：与手写配置同名即失败（项目身份只有一个来源）。"""

        with self._lock:
            current = self._read()
            self._require_available(project.name, current)
            updated = dict(current)
            updated[project.name] = project
            self._write(updated)

    def update(self, name: str, project: PanelProject) -> None:
        """编辑页面项目：手写配置不可改（由所有者改文件），未登记的项目不存在。"""

        with self._lock:
            current = self._read()
            if name in self._service:
                raise PanelRejected(
                    409, "service_managed", f"项目 {name} 由 config/service.toml 管理，页面不可编辑"
                )
            if name not in current:
                raise PanelRejected(404, "project_not_found", f"项目不存在: {name}")
            if project.name != name:
                self._require_available(project.name, current)
            updated = {key: value for key, value in current.items() if key != name}
            updated[project.name] = project
            self._write(updated)

    def remove(self, name: str) -> None:
        """删除页面项目：手写配置与仍有进行中会话的项目都不可删。"""

        with self._lock:
            current = self._read()
            if name in self._service:
                raise PanelRejected(
                    409, "service_managed", f"项目 {name} 由 config/service.toml 管理，页面不可删除"
                )
            if name not in current:
                raise PanelRejected(404, "project_not_found", f"项目不存在: {name}")
            self._write({key: value for key, value in current.items() if key != name})

    def _require_available(self, name: str, current: Mapping[str, PanelProject]) -> None:
        if name in self._service:
            raise PanelRejected(
                409, "name_conflict", f"项目名 {name} 已被 config/service.toml 使用，页面不得重名"
            )
        if name in current:
            raise PanelRejected(409, "name_conflict", f"项目名已存在: {name}")

    def _read(self) -> Mapping[str, PanelProject]:
        if not self._path.is_file():
            return MappingProxyType({})
        try:
            document = tomllib.loads(self._path.read_text(encoding="utf-8"))
        except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
            raise PanelProjectError(f"面板项目档案 {self._path} 解析失败: {error}") from error
        return resolve_panel_projects(document)

    def _write(self, projects: Mapping[str, PanelProject]) -> None:
        """原子写整份档案：先写同目录临时文件再替换，避免读到半份配置。"""

        text = serialize_panel_projects(projects)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".{self._path.name}.tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, self._path)


# ---- 读模型 ------------------------------------------------------------------


def panel_document(
    context: PanelContext, *, generated_at: datetime | None = None
) -> dict[str, object]:
    """``GET /api/panel``：项目（含运行时就绪）、运行时占用与会话清单。"""

    moment = datetime.now(UTC) if generated_at is None else generated_at
    store = context.store()
    try:
        sessions = store.list_sessions(limit=SESSION_LIMIT)
        live_by_project = _live_sessions_by_project(sessions)
    finally:
        store.close()
    running_by_project = _running_by_project(context, sessions)
    return {
        "schema_version": PANEL_API_SCHEMA_VERSION,
        "generated_at": moment.isoformat(),
        "projects": [
            _project_document(
                entry,
                context,
                live_sessions=live_by_project.get(entry.name, 0),
                running_turns=running_by_project.get(entry.name, 0),
            )
            for entry in context.registry.entries()
        ],
        "runtime": context.runner.status(),
        "sessions": [
            _session_document(session, running=context.runner.is_running(session.session_id))
            for session in sessions
        ],
    }


def session_document(
    context: PanelContext, session_id: str, *, generated_at: datetime | None = None
) -> dict[str, object] | None:
    """``GET /api/panel/sessions/<id>``：单会话详情（消息与待人工决定全量）。"""

    moment = datetime.now(UTC) if generated_at is None else generated_at
    store = context.store()
    try:
        session = store.get_session(session_id)
        if session is None:
            return None
        messages = store.list_messages(session_id, limit=MESSAGE_LIMIT)
        decisions = store.list_decisions(session_id, limit=DECISION_LIMIT)
        tool_calls = store.list_tool_calls(session_id, limit=TOOL_CALL_LIMIT)
    finally:
        store.close()
    running = context.runner.is_running(session_id)
    return {
        "schema_version": PANEL_API_SCHEMA_VERSION,
        "generated_at": moment.isoformat(),
        "session": _session_document(session, running=running),
        "messages": [
            {
                "message_id": message.message_id,
                "role": message.role.value,
                "content": message.content,
                "state": message.state.value,
                "created_at": message.created_at,
                "author": message.author,
                # 这一轮是冷启动（回放了历史）还是暖进程续接：人能看到上下文从哪来。
                "context_mode": message.context_mode,
            }
            for message in messages
        ],
        "decisions": [_decision_document(decision) for decision in decisions],
        "tool_calls": [_tool_call_document(call) for call in tool_calls],
    }


def _running_by_project(
    context: PanelContext, sessions: tuple[SessionRecord, ...]
) -> dict[str, int]:
    """项目维度正在执行的轮次数：由会话清单与执行器登记共同推导，不另存一份状态。"""

    counts: dict[str, int] = {}
    for session in sessions:
        if context.runner.is_running(session.session_id):
            counts[session.project] = counts.get(session.project, 0) + 1
    return counts


def _live_sessions_by_project(sessions: tuple[SessionRecord, ...]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for session in sessions:
        if session.status in (SessionStatus.ACTIVE, SessionStatus.AWAITING_HUMAN):
            counts[session.project] = counts.get(session.project, 0) + 1
    return counts


def _project_document(
    entry: ProjectEntry, context: PanelContext, *, live_sessions: int, running_turns: int
) -> dict[str, object]:
    problems = context.readiness(entry)
    return {
        "name": entry.name,
        "path": entry.path,
        "description": entry.description,
        "source": entry.source,
        "editable": entry.editable,
        "is_git_repo": (Path(entry.path) / ".git").exists(),
        "problems": list(problems),
        "live_sessions": live_sessions,
        "runtime": {
            "ready": not problems,
            "problems": list(problems),
            "pi_command": list(entry.pi_command),
            "pi_home": entry.pi_home,
            "running_turns": running_turns,
        },
    }


def _session_document(session: SessionRecord, *, running: bool) -> dict[str, object]:
    return {
        "session_id": session.session_id,
        "project": session.project,
        "title": session.title,
        "status": session.status.value,
        "created_at": session.created_at,
        "created_by": session.created_by,
        "updated_at": session.updated_at,
        "cwd": session.cwd,
        "turn_count": session.turn_count,
        "last_error": session.last_error,
        "terminated_at": session.terminated_at,
        "terminated_by": session.terminated_by,
        "terminate_reason": session.terminate_reason,
        "message_count": session.message_count,
        "pending_decisions": session.pending_decisions,
        "compaction_count": session.compaction_count,
        "running": running,
    }


def _tool_call_document(call: ToolCallRecord) -> dict[str, object]:
    return {
        "tool_call_id": call.tool_call_id,
        "tool_name": call.tool_name,
        "args_excerpt": call.args_excerpt,
        "result_excerpt": call.result_excerpt,
        "risk": call.risk,
        "status": call.status,
        "duration_ms": call.duration_ms,
        "requires_approval": call.requires_approval,
        "approval_status": call.approval_status,
        "started_at": call.started_at,
        "ended_at": call.ended_at,
    }


def _decision_document(decision: DecisionRecord) -> dict[str, object]:
    return {
        "decision_id": decision.decision_id,
        "kind": decision.kind.value,
        "question": decision.question,
        "status": decision.status.value,
        "created_at": decision.created_at,
        "decided_at": decision.decided_at,
        "decided_by": decision.decided_by,
        "reason": decision.reason,
    }


# ---- 写端点 ------------------------------------------------------------------


def handle_panel_post(
    context: PanelContext, route: str, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    """把面板写请求分派到对应入口；未知路径抛 :class:`PanelRejected`（404）。"""

    if route == PANEL_SESSIONS_ROUTE:
        return _create_session(context, body, by)
    if route == PANEL_PROJECTS_ROUTE:
        return _create_project(context, body, by)
    message = _match(route, r"/api/panel/sessions/(?P<sid>[A-Za-z0-9._-]+)/messages")
    if message is not None:
        return _post_message(context, message["sid"], body, by)
    terminate = _match(route, r"/api/panel/sessions/(?P<sid>[A-Za-z0-9._-]+)/terminate")
    if terminate is not None:
        return _terminate(context, terminate["sid"], body, by)
    decision = _match(
        route,
        r"/api/panel/sessions/(?P<sid>[A-Za-z0-9._-]+)/decisions/(?P<did>[A-Za-z0-9._-]+)",
    )
    if decision is not None:
        return _decide(context, decision["sid"], decision["did"], body, by)
    update = _match(route, r"/api/panel/projects/(?P<name>[A-Za-z0-9._-]+)/update")
    if update is not None:
        return _update_project(context, update["name"], body, by)
    remove = _match(route, r"/api/panel/projects/(?P<name>[A-Za-z0-9._-]+)/remove")
    if remove is not None:
        return _remove_project(context, remove["name"], body, by)
    raise PanelRejected(404, "not_found", f"未知写路径: {route}")


def _match(route: str, pattern: str) -> dict[str, str] | None:
    found = re.fullmatch(pattern, route)
    return None if found is None else found.groupdict()


def _required_text(body: Mapping[str, object], key: str, label: str) -> str:
    value = str(body.get(key, "")).strip()
    if not value:
        raise PanelRejected(400, "invalid_request", f"{label}不能为空")
    return value


def _required_reason(body: Mapping[str, object], action: str) -> str:
    """人工决定类动作必须给理由：理由会被写进记录，供回查。"""

    try:
        reason = validate_reason(str(body.get("reason", "")))
    except ValueError as error:
        raise PanelRejected(400, "reason_invalid", str(error)) from error
    if not reason:
        raise PanelRejected(400, "reason_required", f"{action} 必须给出人工理由（reason）")
    return reason


def _create_session(
    context: PanelContext, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    project = _required_text(body, "project", "项目")
    title = _required_text(body, "title", "会话标题")
    entry = context.registry.by_name().get(project)
    if entry is None:
        raise PanelRejected(404, "project_not_found", f"项目不存在: {project}")
    problems = context.readiness(entry)
    if problems:
        raise PanelRejected(
            409, "runtime_not_ready", f"项目 {project} 的运行时未就绪：{'；'.join(problems)}"
        )
    store = context.store()
    try:
        session = store.create_session(project=project, title=title, by=by, cwd=entry.path)
    except ConversationError as error:
        raise PanelRejected(400, "invalid_session", str(error)) from error
    finally:
        store.close()
    return 201, {
        "ok": True,
        "operation": "session_create",
        "session_id": session.session_id,
        "project": session.project,
        "title": session.title,
        "source": f"{SOURCE_WEB}:{by}",
    }


def _post_message(
    context: PanelContext, session_id: str, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    try:
        text = validate_message(_required_text(body, "text", "消息内容"))
    except ConversationError as error:
        raise PanelRejected(400, "invalid_message", str(error)) from error
    try:
        ticket = context.runner.start_turn(session_id, text, by)
    except ConversationError as error:
        raise PanelRejected(409, "refused", str(error)) from error
    return 202, {
        "ok": True,
        "operation": "session_message",
        "session_id": session_id,
        "turn_count": ticket.turn_count,
        "queued": ticket.queued,
        "detail": "已受理，一轮执行在常驻进程内进行；轮询会话详情即可看到结果",
    }


def _terminate(
    context: PanelContext, session_id: str, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    reason = _required_reason(body, "终止会话")
    store = context.store()
    try:
        session = store.get_session(session_id)
    finally:
        store.close()
    if session is None:
        raise PanelRejected(404, "session_not_found", f"会话不存在: {session_id}")
    result = context.runner.terminate(session_id, by=by, reason=reason)
    return 200, {
        "ok": True,
        "operation": "session_terminate",
        "session_id": session_id,
        "terminated": result.terminated,
        "aborted": result.aborted,
        "already_terminated": not result.terminated,
        "detail": (
            "会话已终止" + ("（在跑的一轮已中止）" if result.aborted else "")
            if result.terminated
            else "会话此前已终止，未改写首次终止事实"
        ),
    }


def _decide(
    context: PanelContext,
    session_id: str,
    decision_id: str,
    body: Mapping[str, object],
    by: str,
) -> tuple[int, dict[str, object]]:
    """作出人工决定：批准=继续（可带指令并立即重跑），拒绝=终止会话。"""

    choice = str(body.get("decision", "")).strip()
    if choice not in ("approve", "reject"):
        raise PanelRejected(400, "invalid_decision", "decision 必须是 approve 或 reject")
    reason = _required_reason(body, "人工决定")
    text = str(body.get("text", "")).strip()
    store = context.store()
    try:
        session = store.get_session(session_id)
        if session is None:
            raise PanelRejected(404, "session_not_found", f"会话不存在: {session_id}")
        decision = store.get_decision(decision_id)
        if decision is None or decision.session_id != session_id:
            raise PanelRejected(404, "decision_not_found", f"待人工决定不存在: {decision_id}")
        allowed = can_decide(session.status, decision.status)
        if not allowed.allowed:
            raise PanelRejected(409, "refused", allowed.reason)
        if choice == "reject":
            store.resolve_decision(
                decision_id, status=DecisionStatus.REJECTED, by=by, reason=reason
            )
            store.mark_tool_approval(session_id, "rejected")
            context.runner.terminate(session_id, by=by, reason=f"拒绝待人工决定：{reason}")
            return 200, {
                "ok": True,
                "operation": "session_decision",
                "session_id": session_id,
                "decision_id": decision_id,
                "decision": choice,
                "session_status": SessionStatus.TERMINATED.value,
            }
        store.resolve_decision(decision_id, status=DecisionStatus.APPROVED, by=by, reason=reason)
        # 人工批准这条决定即视为把本轮跑过的工具一并放行（含工具审批闸门那一类）。
        store.mark_tool_approval(session_id, "approved")
        store.set_status(session_id, SessionStatus.ACTIVE)
        # 只有「上一轮失败」的批准才是重试：把同一条人工消息再发一次。
        # 工具审批与 Agent 提问的批准不自动重放——否则会重复执行同一批动作；
        # 要给出下一步指令就填 text，那才是一条新的输入。
        fallback = (
            _last_human_message(store, session_id)
            if decision.kind is DecisionKind.TURN_FAILED
            else ""
        )
        retry_text = text or fallback
        if retry_text:
            ticket = context.runner.start_turn(session_id, retry_text, by)
            return 202, {
                "ok": True,
                "operation": "session_decision",
                "session_id": session_id,
                "decision_id": decision_id,
                "decision": choice,
                "turn_count": ticket.turn_count,
                "queued": ticket.queued,
                "detail": "已批准并重新发起一轮执行",
            }
        return 200, {
            "ok": True,
            "operation": "session_decision",
            "session_id": session_id,
            "decision_id": decision_id,
            "decision": choice,
            "session_status": SessionStatus.ACTIVE.value,
            "detail": "已批准；会话回到可对话状态，等待你的下一条消息",
        }
    finally:
        store.close()


def _last_human_message(store: ConversationStore, session_id: str) -> str:
    for message in reversed(store.list_messages(session_id, limit=MESSAGE_LIMIT)):
        if message.role is MessageRole.HUMAN:
            return message.content
    return ""


def _project_fields(body: Mapping[str, object]) -> dict[str, object]:
    fields: dict[str, object] = {}
    for key in ("path", "description", "pi_command", "pi_home"):
        if key in body:
            fields[key] = body[key]
    return fields


def _validated_project(
    context: PanelContext, name: str, body: Mapping[str, object]
) -> PanelProject:
    try:
        project = project_from_fields(name, _project_fields(body))
    except PanelProjectError as error:
        raise PanelRejected(400, "invalid_project", str(error)) from error
    entry = ProjectEntry(
        name=project.name,
        path=project.path,
        description=project.description,
        pi_command=project.pi_command,
        pi_home=project.pi_home,
        source=SOURCE_PANEL,
    )
    problems = context.readiness(entry)
    if problems:
        raise PanelRejected(
            400, "runtime_not_ready", f"项目 {project.name} 不可用：{'；'.join(problems)}"
        )
    return project


def _create_project(
    context: PanelContext, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    name = _required_text(body, "name", "项目名")
    project = _validated_project(context, name, body)
    context.registry.create(project)
    return 201, {
        "ok": True,
        "operation": "project_create",
        "name": project.name,
        "path": project.path,
        "source": f"{SOURCE_WEB}:{by}",
    }


def _update_project(
    context: PanelContext, name: str, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    new_name = str(body.get("name", "")).strip() or name
    project = _validated_project(context, new_name, body)
    context.registry.update(name, project)
    return 200, {
        "ok": True,
        "operation": "project_update",
        "name": project.name,
        "path": project.path,
        "source": f"{SOURCE_WEB}:{by}",
    }


def _remove_project(
    context: PanelContext, name: str, body: Mapping[str, object], by: str
) -> tuple[int, dict[str, object]]:
    _required_reason(body, "删除项目")
    store = context.store()
    try:
        live = store.live_session_ids(name)
    finally:
        store.close()
    if live:
        raise PanelRejected(
            409,
            "sessions_live",
            f"项目 {name} 还有进行中的会话（{'、'.join(live)}）；先终止它们再删除",
        )
    context.registry.remove(name)
    return 200, {
        "ok": True,
        "operation": "project_remove",
        "name": name,
        "source": f"{SOURCE_WEB}:{by}",
    }


__all__ = [
    "PANEL_API_SCHEMA_VERSION",
    "PANEL_PROJECTS_ROUTE",
    "PANEL_ROUTE",
    "PANEL_SESSIONS_ROUTE",
    "PanelContext",
    "PanelRegistry",
    "PanelRejected",
    "handle_panel_post",
    "panel_document",
    "session_document",
]
