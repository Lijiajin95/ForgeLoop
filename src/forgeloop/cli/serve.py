"""常驻服务：``forgeloop serve`` 的进程生命周期、只读页复用、状态接口与页面写入口。

职责边界：

- **常驻载体**：HTTP 服务在后台线程运行，主线程等待停止事件；``SIGTERM``/``SIGINT``
  触发优雅停止（停止 worker、关闭监听、退出码 0）。R2 起 worker 可在 ``auto_advance``
  打开时自动接续已批准需求；``GET /api/service`` 如实报告开关、可执行项目与每轮筛选结果。
- **复用只读页**：``/``、``/api/progress`` 与静态模块仍由 ``cli.web`` 的读模型与
  ``ProgressRequestHandler`` 提供（同一份 ``WebSettings``），本模块只新增
  ``GET /api/service``；问题分类与计数直接取同一份进展文档，不重建第二套口径。
- **配置**：数值规则在 ``domain.service``（纯规则），本模块只负责读 TOML、检查服务化
  前提（项目档案的 PI HOME，见工程可靠性方案第 22.2 节）并在非法时拒绝启动。
- **只允许回环**：非回环监听地址由领域规则直接拒绝，页面写入口因此只可能来自本机。
- **写入口（R3）**：``POST /api/requirements`` 提交需求；``POST
  /api/requirements/{req_id}/approve|advance|accept|stop|cancel`` 做人工决定。写请求必须同时
  通过三道闸门——一次性页面令牌（``GET /`` 注入 meta）、同源校验（``Origin``/``Referer``
  的 authority 必须等于 ``Host``）与请求体大小上限；批准/验收/停止**调用与 CLI 相同的
  函数对象**（由 ``cli.main`` 以 :class:`ServeOperations` 注入），因此绑定、幂等与审计
  完全一致，页面不另写一套业务状态。只读路由仍与 ``web`` 逐字段一致。
- **不做**：没有登录与多用户（B01 触发条件未满足，监听保持回环）；没有跨重启的提交
  幂等（如实记录在状态文档里）。
"""

import argparse
import io
import json
import os
import re
import secrets
import signal
import threading
import tomllib
from collections.abc import Callable, Mapping
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import FrameType
from typing import cast
from urllib.parse import urlsplit

from forgeloop.cli.common import base_records_root, fail
from forgeloop.cli.panel import (
    PANEL_ROUTE,
    PANEL_SESSIONS_ROUTE,
    PanelContext,
    PanelRegistry,
    PanelRejected,
    handle_panel_post,
    panel_document,
    session_document,
)
from forgeloop.cli.web import (
    DEFAULT_WEB_CONFIG,
    HTML_TYPE,
    JSON_TYPE,
    ProgressDocuments,
    ProgressRequestHandler,
    WebConfigError,
    WebSettings,
    build_progress_document,
    load_web_config,
    page_html,
    refresh_text,
)
from forgeloop.domain.conversation import ToolApprovalPolicy
from forgeloop.domain.progress import (
    ProgressConfigError,
    resolve_refresh_seconds,
)
from forgeloop.domain.project import Project, project_data_root
from forgeloop.domain.projects import (
    DEFAULT_PROJECTS_FILE,
    SOURCE_PANEL,
    PanelProjectError,
    ProjectEntry,
)
from forgeloop.domain.requirement import (
    IdempotencyConflictError,
    RequirementError,
    RequirementNotFoundError,
)
from forgeloop.domain.service import (
    DEFAULT_SERVICE_HOST,
    DEFAULT_SERVICE_PORT,
    ServiceConfigError,
    ServiceSettings,
    resolve_service_settings,
)
from forgeloop.graph.conversation import ConversationRunner
from forgeloop.graph.worker import ServiceWorker, WorkerRefused
from forgeloop.records.projects import iter_projects, project_by_name
from forgeloop.records.requirements import RequirementStore

# signal.getsignal/signal.signal 的处理器类型：``signal.Handlers`` 在 3.13 是
# IntEnum（SIG_DFL/SIG_IGN），不是「可调用或整数」的联合，故用显式别名。
SignalHandler = Callable[[int, FrameType | None], object] | int | None

DEFAULT_SERVICE_CONFIG = "config/service.toml"
SERVICE_API_SCHEMA_VERSION = 1
SERVICE_STATUS_ROUTE = "/api/service"
REQUIREMENTS_ROUTE = "/api/requirements"
REQUIREMENT_ACTION_ROUTE = re.compile(
    r"/api/requirements/(?P<req_id>[A-Za-z0-9._-]+)/(?P<action>approve|advance|accept|stop|cancel)"
)
TOKEN_HEADER = "X-Forgeloop-Token"
TOKEN_PLACEHOLDER = "__FORGELOOP_TOKEN__"
"""页面 meta 里的令牌占位：替换属性值而不是整段标签，HTML 格式化不会影响注入。"""
TOKEN_BYTES = 32
MAX_BODY_BYTES = 64 * 1024
MAX_CLIENT_KEY_CHARS = 128
OPERATION_SOURCE = "web"
"""写操作的授权来源前缀：审计里能区分「页面批准」与「CLI 批准」。"""
HTTP_THREAD_NAME = "forgeloop-serve-http"
HTTP_JOIN_TIMEOUT_SECONDS = 5.0
SIGNAL_WAIT_SECONDS = 0.5
_STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)


class OperationRejected(Exception):
    """写请求被拒绝：``status`` 是 HTTP 状态码，``code`` 是稳定的机器标签。"""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class ServeOperations:
    """页面写操作复用的 CLI 入口（由 ``cli.main`` 注入，serve 不反向导入 main）。

    注入的是**同一个函数对象**而不是副本：页面批准与 CLI 批准走同一条记录路径
    （绑定需求身份与任务包版本、写同一张批准表、同样的授权来源语义）。
    """

    approve_requirement: Callable[[argparse.Namespace], int]
    accept_requirement: Callable[[argparse.Namespace], int]
    stop_task: Callable[[argparse.Namespace], int]


class ServeConfigError(ValueError):
    """常驻服务的服务化前提不满足（配置文件不可读、PI HOME 不可用）。"""


@dataclass(frozen=True)
class ServeSettings:
    """一次常驻服务的全部依赖：只读页、生效设置、写操作入口与两份配置文件路径。"""

    web: WebSettings
    service: ServiceSettings
    config_path: Path
    operations: ServeOperations
    projects_path: Path = Path(DEFAULT_PROJECTS_FILE)
    """面板项目档案路径（页面独占写入；与手写 ``config/service.toml`` 项目不得同名）。"""

    project: Project | None = None
    """本进程服务的项目（多项目模式下记录在 ``projects/<project_id>/`` 下）。

    ``None`` 只出现在登记根尚无项目的旧现场：此时业务记录退回登记根本身，
    与 ``cli.common.records_root`` 对无 ``--project`` 命令的口径一致。
    """

    @property
    def records_root(self) -> Path:
        """业务记录根：项目记录根（有项目）或登记根（旧单根现场）。"""

        if self.project is None:
            return self.web.records_root
        return project_data_root(self.web.records_root, self.project.project_id)

    @property
    def project_id(self) -> str:
        return "" if self.project is None else self.project.project_id


def load_service_config(path: Path) -> Mapping[str, object] | None:
    """读取常驻服务配置原始文档；文件不存在返回 ``None``（由内建默认兜底）。"""

    if not path.is_file():
        return None
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
        raise ServeConfigError(f"常驻服务配置 {path} 解析失败: {error}") from error
    return document


def pi_home_problems(pi_home: str) -> tuple[str, ...]:
    """检查隔离 HOME 是否可用：``<pi_home>/.pi/agent/models.json`` 必须存在且非空。

    路径与真实 pi 布局一致（``~/.pi/agent/models.json``，见 ``.cache/dogfood`` 的隔离
    HOME 运行器）：只判断这一个文件，不猜 provider，也不在缺失时自造配置。
    """

    models = Path(pi_home).expanduser() / ".pi" / "agent" / "models.json"
    if not models.is_file():
        return (f"缺少模型配置 {models}",)
    try:
        content = models.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as error:
        return (f"读取 {models} 失败: {error}",)
    if not content:
        return (f"{models} 为空；PI 会自造空配置并报 Unknown provider",)
    return ()


def check_projects(settings: ServiceSettings) -> None:
    """服务化前提：每个项目档案的隔离 HOME 必须真的可用（§22.2 的实测判据）。"""

    problems: list[str] = []
    for name in sorted(settings.projects):
        problems.extend(
            f"projects.{name}: {reason}"
            for reason in pi_home_problems(settings.projects[name].pi_home)
        )
    if problems:
        raise ServeConfigError(
            "项目档案的 PI HOME 不可用（隔离 HOME 需含非空的 .pi/agent/models.json）："
            + "；".join(problems)
        )


def panel_project_problems(entry: ProjectEntry) -> tuple[str, ...]:
    """项目能否承载一轮会话：路径必须存在，隔离 HOME 必须可用（不猜、不代建）。

    与 ``check_projects`` 同一判据来源（``pi_home_problems``）：页面显示、会话创建与
    写路径校验共用同一份判定，避免「页面说就绪、执行时才发现」。
    """

    problems: list[str] = []
    path = Path(entry.path).expanduser()
    if not path.is_dir():
        problems.append(f"项目路径不存在或不是目录: {path}")
    problems.extend(pi_home_problems(entry.pi_home))
    return tuple(problems)


def build_panel_context(settings: ServeSettings) -> PanelContext:
    """装配面板：项目注册表（手写档案 + 页面档案）与一轮执行器。"""

    registry = PanelRegistry(settings.service.projects, settings.projects_path)
    runner = ConversationRunner(
        records_path=settings.records_root / "records.sqlite",
        session_root=settings.records_root / "panel",
        projects=registry.by_name,
        readiness=panel_project_problems,
        concurrency=settings.service.panel.concurrency,
        turn_timeout_seconds=settings.service.panel.turn_timeout_seconds,
        tool_approval=ToolApprovalPolicy(settings.service.panel.tool_approval),
        session_idle_seconds=float(settings.service.panel.session_idle_seconds),
        max_live_sessions=settings.service.panel.max_live_sessions,
    )
    return PanelContext(
        registry=registry,
        runner=runner,
        readiness=panel_project_problems,
        db_path=settings.records_root / "records.sqlite",
    )


def check_panel(registry: PanelRegistry) -> None:
    """启动前提：面板项目档案可读、无同名冲突，且每个页面项目的隔离 HOME 可用。"""

    try:
        entries = registry.entries()
    except PanelProjectError as error:
        raise ServeConfigError(f"{registry.path}: {error}") from error
    problems = [
        f"projects.{entry.name}: {reason}"
        for entry in entries
        if entry.source == SOURCE_PANEL
        for reason in pi_home_problems(entry.pi_home)
    ]
    if problems:
        raise ServeConfigError(
            f"{registry.path} 的项目档案 PI HOME 不可用"
            "（隔离 HOME 需含非空的 .pi/agent/models.json）：" + "；".join(problems)
        )


def page_html_with_token(token: str) -> str:
    """把一次性页面令牌注入 meta；``web`` 只读服务不注入，页面据此隐藏写入口。"""

    return page_html().replace(TOKEN_PLACEHOLDER, token, 1)


def _run_cli_operation(
    operation: Callable[[argparse.Namespace], int], args: argparse.Namespace
) -> tuple[bool, str]:
    """调用注入的 CLI 入口并捕获它的输出；退出码 0 视为成功。

    页面与 CLI 共用同一个函数对象，因此校验、绑定与审计完全一致；输出被捕获后作为
    响应正文返回，失败原因同样回传，不吞掉也不改写。
    """

    out, err = io.StringIO(), io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = operation(args)
    except SystemExit as error:  # CLI 用 SystemExit 表达确定失败（如需求不存在）
        return False, str(error) or "操作被拒绝"
    return code == 0, (out.getvalue() + err.getvalue()).strip()


def deploy_section(settings: ServeSettings) -> dict[str, object]:
    """待部署结论（只读）：当前激活版本、最近发布与是否已获人工批准。

    不安装任何东西、不改现场；读不到就如实写 ``unknown``/空值，不猜。
    """

    from forgeloop.adapter.deployment import current_version, default_prefix
    from forgeloop.domain.deploy import deploy_offer
    from forgeloop.records.store import RecordStore

    try:
        active = current_version(default_prefix()) or ""
    except Exception:
        active = ""
    store = RecordStore(settings.records_root / "records.sqlite")
    try:
        released = store.latest_release()
        approval = store.deploy_approval(released[0]) if released is not None else None
    finally:
        store.close()
    offer = deploy_offer(active, released, approval)
    return {
        "active_version": active or "unknown",
        "released_tag": offer.tag or (released[0] if released is not None else ""),
        "pending": offer.pending,
        "approved": offer.approved,
        "reason": offer.reason,
    }


def build_service_document(
    settings: ServeSettings,
    worker: ServiceWorker,
    *,
    generated_at: datetime | None = None,
    operations_enabled: bool = False,
) -> dict:
    """组装 ``GET /api/service``/``serve --once --json`` 的同一份文档。

    ``review_required`` 取进展文档的「问题」段（需要人工介入的事实）并并入 worker 的
    启动核对项（未核对动作 / 残留槽位，R4）——两处判定同源、按 ``(kind, ref_id)`` 去重，
    因此页面、``GET /api/progress`` 与常驻状态看到的「需人工核对」清单一致。
    """

    moment = datetime.now(UTC) if generated_at is None else generated_at
    progress = build_progress_document(
        settings.web.records_root,
        settings.web.refresh,
        settings.web.documents,
        project_id=settings.project_id,
        generated_at=moment,
    )
    review = list(progress["issues"])
    index = {(str(item.get("kind", "")), str(item.get("ref_id", ""))): item for item in review}
    for item in worker.reconcile():
        key = (item["kind"], item["ref_id"])
        existing = index.get(key)
        if existing is None:
            review.append(item)
            index[key] = item
            continue
        # 同一事实两处判定（读模型按状态/槽位，worker 按动作记录）：合成一条，
        # 摘要用读模型的稳定文案，缺少的现场证据（候选 diff 身份等）补在后面。
        evidence = item["detail"]
        if evidence and evidence not in str(existing.get("detail", "")):
            existing["detail"] = f"{existing.get('detail', '')}；现场证据：{evidence}"

    return {
        "schema_version": SERVICE_API_SCHEMA_VERSION,
        "generated_at": moment.isoformat(),
        "records_root": str(settings.web.records_root),
        "project": settings.project_id,
        "project_records_root": str(settings.records_root),
        "config_path": str(settings.config_path),
        "pid": os.getpid(),
        "started_at": worker.started_at.isoformat(),
        "worker": worker.status(),
        # 待部署结论（2026-10-18 所有者决定：只报告不安装）：本机激活版本、最近发布与
        # 是否已获人工部署批准。只读事实，页面/运维据此提示"待确认部署"。
        "deploy": deploy_section(settings),
        "projects": sorted(settings.service.projects),
        # 页面写入口是否可用：只有 serve 注入了令牌才是 true，web 只读服务恒为 false。
        "operations_enabled": operations_enabled,
        "counts": progress["counts"],
        "review_required": review,
    }


def service_text(document: Mapping[str, object]) -> tuple[str, ...]:
    """``serve --once`` 的人读输出；数值取同一份文档，不另算一遍。"""

    worker = document.get("worker")
    counts = document.get("counts")
    issues = document.get("review_required")
    projects = document.get("projects")
    fields: Mapping[str, object] = worker if isinstance(worker, Mapping) else {}
    counters: Mapping[str, object] = counts if isinstance(counts, Mapping) else {}
    names = "、".join(str(name) for name in projects) if isinstance(projects, list) else ""
    if not names:
        names = "无（只提供只读页面）"
    issue_count = len(issues) if isinstance(issues, list) else 0
    executable = fields.get("executable_projects")
    executable_names = (
        "、".join(str(name) for name in executable) if isinstance(executable, list) else ""
    )
    tick = fields.get("last_tick")
    tick_fields: Mapping[str, object] = tick if isinstance(tick, Mapping) else {}
    candidates = tick_fields.get("candidates")
    skipped = tick_fields.get("skipped")
    return (
        "常驻服务自检（--once：不监听端口、不执行任务；写入口只在常驻运行时启用）",
        f"记录根: {document.get('records_root', '')}",
        f"生效配置: {document.get('config_path', '')}",
        f"轮询间隔: {fields.get('poll_seconds', '')} 秒",
        f"自动接续: {'开启' if fields.get('auto_advance') else '关闭（只报告，不推进）'}",
        f"项目档案: {names}",
        f"可执行项目: {executable_names or '无（PI HOME 与进程 HOME 不一致或未配置）'}",
        f"本轮候选: {len(candidates) if isinstance(candidates, list) else 0} 条，"
        f"跳过 {len(skipped) if isinstance(skipped, Mapping) else 0} 条",
        f"启动核对: {issue_count} 项需人工核对（未核对动作 / 残留槽位不自动重放）",
        f"需求/任务/问题: {counters.get('requirements', 0)}/{counters.get('tasks', 0)}/{issue_count}",
    )


class ServiceRequestHandler(ProgressRequestHandler):
    """只读页处理器 + 常驻状态与面板读路由；其余写方法仍一律 405。"""

    server_version = "ForgeLoopServe/1"

    @property
    def serve_settings(self) -> ServeSettings:
        return cast("ServiceHTTPServer", self.server).serve_settings

    @property
    def worker(self) -> ServiceWorker:
        return cast("ServiceHTTPServer", self.server).worker

    @property
    def token(self) -> str:
        return cast("ServiceHTTPServer", self.server).token

    @property
    def panel(self) -> PanelContext:
        return cast("ServiceHTTPServer", self.server).panel

    def _route(self, route: str) -> tuple[int, str, bytes]:
        panel_route = self._panel_read(route)
        if panel_route is not None:
            return panel_route
        if route == SERVICE_STATUS_ROUTE:
            document = build_service_document(
                self.serve_settings, self.worker, operations_enabled=bool(self.token)
            )
            return 200, JSON_TYPE, json.dumps(document, ensure_ascii=False).encode("utf-8")
        if route in ("/", "/index.html"):
            return 200, HTML_TYPE, page_html_with_token(self.token).encode("utf-8")
        return super()._route(route)

    def _panel_read(self, route: str) -> tuple[int, str, bytes] | None:
        """面板的两条读路由；未命中返回 ``None``，交给只读页路由继续判定。"""

        if route == PANEL_ROUTE:
            document = panel_document(self.panel)
            return 200, JSON_TYPE, json.dumps(document, ensure_ascii=False).encode("utf-8")
        if route.startswith(f"{PANEL_SESSIONS_ROUTE}/"):
            session_id = route[len(PANEL_SESSIONS_ROUTE) + 1 :]
            session = session_document(self.panel, session_id)
            if session is None:
                return (
                    404,
                    JSON_TYPE,
                    json.dumps(
                        {"error": "session_not_found", "detail": f"会话不存在: {session_id}"},
                        ensure_ascii=False,
                    ).encode("utf-8"),
                )
            return 200, JSON_TYPE, json.dumps(session, ensure_ascii=False).encode("utf-8")
        return None

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        try:
            status, payload = self._handle_post(route)
        except OperationRejected as rejection:
            status = rejection.status
            payload = {"error": rejection.code, "detail": str(rejection)}
        except PanelRejected as rejection:
            status = rejection.status
            payload = {"error": rejection.code, "detail": str(rejection)}
        except Exception as error:  # 内部错误必须可见，不伪装成成功
            self.log_error("写操作失败（%s）: %s", route, error)
            status, payload = 500, {"error": "operation_failed", "detail": str(error)}
        self._respond(
            status,
            JSON_TYPE,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            send_body=True,
        )

    def _handle_post(self, route: str) -> tuple[int, dict]:
        """写请求的统一入口：先过三道闸门，再按路径分发到既有业务入口。"""

        server = cast("ServiceHTTPServer", self.server)
        self._require_token(server.token)
        self._require_same_origin()
        body = self._read_json_body()
        by = str(body.get("by", "")).strip()
        reason = str(body.get("reason", "")).strip()
        if not by:
            raise OperationRejected(400, "by_required", "写操作必须带 by（例如 owner）")
        if route == PANEL_ROUTE or route.startswith(f"{PANEL_ROUTE}/"):
            # 面板写入口：与既有五类操作同一道令牌 + 同源 + 请求体上限闸门。
            return handle_panel_post(self.panel, route, body, by)
        if route == REQUIREMENTS_ROUTE:
            return self._submit_requirement(body, by, reason)
        match = REQUIREMENT_ACTION_ROUTE.fullmatch(route)
        if match is None:
            raise OperationRejected(404, "not_found", f"未知写路径: {route}")
        action = match.group("action")
        if action != "advance" and not reason:
            # 批准/验收/停止是人工决定，理由会被写进权威记录；推进与提交不写决定记录。
            raise OperationRejected(400, "reason_required", f"{action} 必须给出人工理由（reason）")
        return self._requirement_action(action, match.group("req_id"), by, reason)

    def _require_token(self, expected: str) -> None:
        provided = self.headers.get(TOKEN_HEADER, "")
        if not expected or not provided or not secrets.compare_digest(provided, expected):
            raise OperationRejected(403, "token_required", "缺少或错误的页面令牌；请刷新页面后重试")

    def _require_same_origin(self) -> None:
        host = self.headers.get("Host", "").strip()
        candidate = (
            self.headers.get("Origin", "").strip() or self.headers.get("Referer", "").strip()
        )
        if not candidate:
            raise OperationRejected(403, "origin_required", "写请求必须带 Origin 或 Referer")
        authority = urlsplit(candidate).netloc
        if not host or authority != host:
            raise OperationRejected(403, "cross_origin", f"拒绝跨源写请求：{authority} != {host}")

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise OperationRejected(400, "empty_body", "写请求必须带 JSON 请求体")
        if length > MAX_BODY_BYTES:
            raise OperationRejected(413, "body_too_large", f"请求体不得超过 {MAX_BODY_BYTES} 字节")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise OperationRejected(400, "invalid_json", f"请求体不是合法 JSON：{error}") from error
        if not isinstance(payload, dict):
            raise OperationRejected(400, "invalid_body", "请求体必须是 JSON 对象")
        return payload

    def _submit_requirement(self, body: dict, by: str, reason: str) -> tuple[int, dict]:
        project = str(body.get("project", "")).strip()
        text = str(body.get("text", "")).strip()
        if not project or not text:
            raise OperationRejected(400, "invalid_submit", "提交需求需要 project 与 text")
        key = str(body.get("key", "")).strip()
        if len(key) > MAX_CLIENT_KEY_CHARS or any(char.isspace() for char in key):
            raise OperationRejected(
                400, "invalid_key", f"幂等键必须是 ≤{MAX_CLIENT_KEY_CHARS} 字符且不含空白的字符串"
            )
        root = self.serve_settings.records_root
        store = RequirementStore(root / "records.sqlite")
        try:
            outcome = store.submit_once(
                project,
                text,
                submitted_by=by,
                source=OPERATION_SOURCE,
                client_key=key,
            )
        except IdempotencyConflictError as error:
            # 同一个键配不同内容：fail-closed 报冲突，不猜用户想改哪一条。
            raise OperationRejected(409, "idempotency_conflict", str(error)) from error
        finally:
            store.close()
        return (201 if outcome.created else 200), {
            "ok": True,
            "operation": "submit",
            "req_id": outcome.requirement.req_id,
            "by": by,
            "note": reason,
            "source": OPERATION_SOURCE,
            "idempotent": not outcome.created,
        }

    def _requirement_action(
        self, action: str, req_id: str, by: str, reason: str
    ) -> tuple[int, dict]:
        if action == "advance":
            return self._advance(req_id)
        if action == "stop":
            return self._stop(req_id, by, reason)
        if action == "cancel":
            return self._cancel(req_id, by, reason)
        return self._decide(action, req_id, by, reason)

    def _advance(self, req_id: str) -> tuple[int, dict]:
        """受理一次推进请求（202）：先只读判定，再排队交给常驻心跳执行。

        一次推进要跑完当前任务的 dev/review/test（分钟级），HTTP 请求不该陪着一起等；
        方案 §4.2 定的就是「202 受理 + 同需求并发只允许一个」。前提不成立时**同步**拒绝
        并把原因带回页面，不排一个注定失败的队。
        """

        try:
            decision = self.worker.advance_eligibility(req_id)
        except RequirementNotFoundError as error:
            raise OperationRejected(404, "requirement_not_found", str(error)) from error
        if not decision.eligible:
            raise OperationRejected(409, "refused", decision.reason or "该需求当前不可推进")
        self.worker.request_advance(req_id)
        return 202, {
            "ok": True,
            "operation": "advance",
            "req_id": req_id,
            "queued": True,
            "detail": "已受理，常驻进程将在下一次心跳执行",
        }

    def _cancel(self, req_id: str, by: str, reason: str) -> tuple[int, dict]:
        """取消需求（所有者 2026-10-19：页面上取消，理由必填）。

        取消 = 撤下 + 留痕，不删除记录：终态 ``cancelled``，身份、版本、批准、交付与
        现场原样保留，后续推进一律拦下（与 CLI ``requirement cancel`` 同一条记录路径）。
        """

        if not reason.strip():
            raise OperationRejected(400, "reason_required", "取消需求必须填写理由")
        root = self.serve_settings.records_root
        store = RequirementStore(root / "records.sqlite")
        try:
            try:
                store.record_requirement_cancellation(
                    req_id, by=by or "page", reason=reason.strip()
                )
            except RequirementNotFoundError as error:
                raise OperationRejected(404, "requirement_not_found", str(error)) from error
            except RequirementError as error:
                raise OperationRejected(409, "refused", str(error)) from error
            decision = store.requirement_cancellation(req_id) or {}
        finally:
            store.close()
        return 200, {
            "ok": True,
            "operation": "cancel",
            "req_id": req_id,
            "by": decision.get("cancelled_by", by),
            "reason": decision.get("reason", reason.strip()),
            "source": OPERATION_SOURCE,
            "note": "已取消（记录保留：身份、版本、批准与交付均保留）",
        }

    def _stop(self, req_id: str, by: str, reason: str) -> tuple[int, dict]:
        try:
            task_id = self.worker.current_task_thread_id(req_id)
        except WorkerRefused as refusal:
            raise OperationRejected(409, "refused", str(refusal)) from refusal
        except RequirementNotFoundError as error:
            raise OperationRejected(404, "requirement_not_found", str(error)) from error
        ok, output = _run_cli_operation(
            self.serve_settings.operations.stop_task,
            argparse.Namespace(
                task_id=task_id,
                note=reason,
                by=by,
                source=OPERATION_SOURCE,
                records_root=str(self.serve_settings.web.records_root),
            ),
        )
        if not ok:
            raise OperationRejected(409, "refused", output or "停止请求被拒绝")
        return 202, {
            "ok": True,
            "operation": "stop",
            "req_id": req_id,
            "task_id": task_id,
            "reason": reason,
            "output": output,
        }

    def _decide(self, action: str, req_id: str, by: str, reason: str) -> tuple[int, dict]:
        """批准与验收：调用与 CLI 相同的函数对象，来源标注为 ``web:<by>``。"""

        operations = self.serve_settings.operations
        root = str(self.serve_settings.web.records_root)
        if action == "approve":
            operation = operations.approve_requirement
            args = argparse.Namespace(
                req_id=req_id, by=by, source=f"{OPERATION_SOURCE}:{by}", records_root=root
            )
        else:
            operation = operations.accept_requirement
            args = argparse.Namespace(
                req_id=req_id,
                records_root=root,
                by=by,
                source=f"{OPERATION_SOURCE}:{by}",
            )
        ok, output = _run_cli_operation(operation, args)
        if not ok:
            raise OperationRejected(409, "refused", output or f"{action} 被拒绝")
        return 200, {
            "ok": True,
            "operation": action,
            "req_id": req_id,
            "by": by,
            "reason": reason,
            "output": output,
        }


class ServiceHTTPServer(ThreadingHTTPServer):
    """常驻服务监听：持有只读页设置、worker 与会话面板上下文。"""

    daemon_threads = True

    def __init__(
        self,
        settings: ServeSettings,
        worker: ServiceWorker,
        panel: PanelContext,
        token: str = "",
    ) -> None:
        self.serve_settings = settings
        self.worker = worker
        self.panel = panel
        # 令牌每次启动随机生成：只注入页面 meta，重启即失效。
        self.token = token
        # 继承的 ProgressRequestHandler 经 self.server.settings 取只读页设置。
        self.settings = settings.web
        super().__init__((settings.web.host, settings.web.port), ServiceRequestHandler)


def build_server(
    settings: ServeSettings,
    worker: ServiceWorker,
    panel: PanelContext | None = None,
    *,
    token: str = "",
) -> ServiceHTTPServer:
    """按设置绑定真实回环地址；端口冲突等绑定错误由调用方处理。

    ``panel`` 缺省时按生效设置现场装配（与 ``cmd_serve`` 同一条路径）：调用方只在需要
    注入替代执行器（测试）时才显式传入。
    """

    return ServiceHTTPServer(
        settings, worker, panel if panel is not None else build_panel_context(settings), token
    )


def _served_project(base: Path, requested: str) -> Project | None:
    """解析本进程服务的项目：显式 ``--project`` 优先，否则要求唯一已登记项目。

    登记根尚无项目时返回 ``None``（旧单根现场的兼容口径，与 CLI 无 ``--project`` 的
    命令一致）；有多个项目却不指定时明确失败——让服务进程自己挑一个会把页面写入口
    与常驻接续作用到错误的项目上。
    """

    if requested:
        project = project_by_name(base, requested)
        if project is None:
            raise ServeConfigError(
                f"项目未登记: {requested}（先运行 `forgeloop project add` 登记要服务的项目）"
            )
        return project
    locations = list(iter_projects(base))
    if not locations:
        return None
    if len(locations) > 1:
        listed = "、".join(sorted(item.project.project_id for item in locations))
        raise ServeConfigError(
            f"记录根里有多个已登记项目（{listed}）；请用 --project 指定本进程服务的项目"
        )
    return locations[0].project


def _resolve_settings(
    args: argparse.Namespace,
    root: Path,
    service_config_path: Path,
    web_config_path: Path,
) -> ServeSettings:
    """解析配置文件与命令行的生效设置；任何非法值都抛异常，不静默回落。"""

    try:
        service_settings = resolve_service_settings(
            load_service_config(service_config_path), host=args.host, port=args.port
        )
        check_projects(service_settings)
    except (ServiceConfigError, ServeConfigError) as error:
        # 领域规则与服务化检查都不知道文件位置：在这里补上前缀，失败信息才能定位到配置。
        raise ServeConfigError(f"{service_config_path}: {error}") from error
    refresh = resolve_refresh_seconds(
        load_web_config(web_config_path), cli_value=args.refresh_seconds
    )
    web = WebSettings(
        root,
        service_settings.host,
        service_settings.port,
        refresh,
        web_config_path,
        args.progress_documents,
    )
    return ServeSettings(
        web=web,
        service=service_settings,
        config_path=service_config_path,
        operations=args.operations,
        projects_path=Path(args.projects_file),
        project=_served_project(root, getattr(args, "project", "") or ""),
    )


def _emit(document: Mapping[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return
    for line in service_text(document):
        print(line)


def _install_stop_handlers(stop: threading.Event) -> dict[int, SignalHandler]:
    """把 SIGTERM/SIGINT 变成停止事件；非主线程调用时跳过（信号只在主线程可注册）。"""

    if threading.current_thread() is not threading.main_thread():
        return {}

    def handler(signum: int, frame: FrameType | None) -> None:
        stop.set()

    previous: dict[int, SignalHandler] = {}
    for signum in _STOP_SIGNALS:
        previous[signum] = signal.getsignal(signum)
        signal.signal(signum, handler)
    return previous


def _restore_stop_handlers(previous: Mapping[int, SignalHandler]) -> None:
    for signum, handler in previous.items():
        signal.signal(signum, handler)


def _serve_until_stopped(
    server: ServiceHTTPServer,
    worker: ServiceWorker,
    settings: ServeSettings,
    web_config_path: Path,
) -> int:
    """启动 worker 与 HTTP 线程，等待停止信号后优雅关闭。"""

    host, port = server.server_address[:2]
    service = settings.service
    print(f"状态页: http://{host}:{port}/", flush=True)
    print(f"记录根: {settings.web.records_root}", flush=True)
    print(
        f"服务项目: {settings.project_id or '（未登记项目：旧单根现场）'}，"
        f"业务记录根 {settings.records_root}",
        flush=True,
    )
    print(f"自动刷新: {refresh_text(settings.web.refresh, web_config_path)}", flush=True)
    status = worker.status()
    print(f"常驻 worker: 每 {service.poll_seconds} 秒心跳", flush=True)
    print(
        f"自动接续: {'开启（自动推进已批准需求）' if service.auto_advance else '关闭（只报告，不推进）'}",
        flush=True,
    )
    executable = "、".join(status["executable_projects"]) or "无"
    print(f"可执行项目: {executable}（PI HOME 与进程 HOME 一致）", flush=True)
    review = status["startup_review"]
    print(
        f"启动核对: {len(review)} 项需人工核对"
        + ("（未核对动作 / 残留槽位：不会自动重放）" if review else ""),
        flush=True,
    )
    print(f"服务配置: {settings.config_path}", flush=True)
    print(
        "页面写入口: 已启用（提交/批准/推进/验收/停止；仅本机 + 页面令牌 + 同源校验）",
        flush=True,
    )
    panel = settings.service.panel
    print(
        f"会话面板: 并发 {panel.concurrency}，单轮超时 {panel.turn_timeout_seconds} 秒，"
        f"常驻会话 {panel.max_live_sessions} 个（空闲 {panel.session_idle_seconds} 秒回收），"
        f"工具审批 {panel.tool_approval}，项目档案 {settings.projects_path}",
        flush=True,
    )
    print("按 Ctrl+C 或 SIGTERM 停止。", flush=True)

    stop = threading.Event()
    previous = _install_stop_handlers(stop)
    http_thread = threading.Thread(target=server.serve_forever, name=HTTP_THREAD_NAME, daemon=True)
    worker.start()
    http_thread.start()
    try:
        while not stop.wait(SIGNAL_WAIT_SECONDS):
            pass
    finally:
        _restore_stop_handlers(previous)
    server.shutdown()
    http_thread.join(timeout=HTTP_JOIN_TIMEOUT_SECONDS)
    server.server_close()
    worker.stop()
    # 面板执行器：中止在跑的轮次并收起线程池，避免留下无人认领的 PI 子进程。
    server.panel.runner.shutdown()
    print("已停止。", flush=True)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    """常驻服务入口：默认常驻；``--once`` 只做一次启动核对。"""

    # ``--records-root`` 是登记根：业务记录在所选项目的记录根下（见 ServeSettings.records_root）。
    root = base_records_root(args)
    service_config_path = Path(args.service_config)
    web_config_path = Path(args.web_config)
    try:
        settings = _resolve_settings(args, root, service_config_path, web_config_path)
    except (ServeConfigError, ServiceConfigError, WebConfigError, ProgressConfigError) as error:
        return fail(str(error))
    worker = ServiceWorker(
        settings.records_root,
        poll_seconds=settings.service.poll_seconds,
        auto_advance=settings.service.auto_advance,
        projects=settings.service.projects,
        max_concurrent=settings.service.max_concurrent,
        process_home=os.environ.get("HOME", ""),
    )
    panel = build_panel_context(settings)
    try:
        check_panel(panel.registry)
    except (ServeConfigError, PanelProjectError) as error:
        panel.runner.shutdown()
        return fail(str(error))
    if args.once:
        # 只读筛选一次：让自检也回答「现在会不会被执行、为什么不会」，但不启动任何动作。
        worker.survey()
        _emit(build_service_document(settings, worker), args.json)
        return 0
    # 页面写入口的一次性令牌：每次启动随机生成，只注入页面 meta，重启即失效。
    token = secrets.token_urlsafe(TOKEN_BYTES)
    try:
        server = build_server(settings, worker, panel, token=token)
    except OSError as error:
        panel.runner.shutdown()
        return fail(f"无法监听 {settings.service.host}:{settings.service.port}: {error}")
    return _serve_until_stopped(server, worker, settings, web_config_path)


def add_serve_parser(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
    documents: ProgressDocuments,
    operations: ServeOperations,
) -> None:
    serve = subparsers.add_parser(
        "serve", help="常驻服务：只读状态页 + 常驻 worker（R1 骨架，不执行任务）"
    )
    serve.add_argument(
        "--host",
        default=None,
        help=f"监听地址（默认 {DEFAULT_SERVICE_HOST}；只允许回环，其他地址拒绝启动）",
    )
    serve.add_argument(
        "--port",
        type=int,
        default=None,
        help=f"监听端口（默认 {DEFAULT_SERVICE_PORT}；0 表示由系统分配）",
    )
    serve.add_argument(
        "--service-config",
        default=DEFAULT_SERVICE_CONFIG,
        help=f"常驻服务配置文件（默认 {DEFAULT_SERVICE_CONFIG}）",
    )
    serve.add_argument(
        "--web-config",
        default=DEFAULT_WEB_CONFIG,
        help=f"页面刷新配置文件（默认 {DEFAULT_WEB_CONFIG}）",
    )
    serve.add_argument(
        "--projects-file",
        default=DEFAULT_PROJECTS_FILE,
        help=f"页面管理的项目档案（默认 {DEFAULT_PROJECTS_FILE}；与手写项目不得同名）",
    )
    serve.add_argument(
        "--refresh-seconds",
        type=int,
        default=None,
        help="页面自动刷新间隔秒数；0 表示关闭自动刷新（覆盖配置文件）",
    )
    serve.add_argument(
        "--once",
        action="store_true",
        help="只做一次启动核对并打印状态（不监听端口、不常驻）",
    )
    serve.add_argument("--json", action="store_true", help="配合 --once 输出稳定 JSON 文档")
    serve.add_argument(
        "--project",
        default="",
        help="本进程服务的项目身份（缺省取唯一已登记项目；有多个项目时必须指定）",
    )
    serve.add_argument("--records-root", default=default_records_root)
    serve.set_defaults(func=cmd_serve, progress_documents=documents, operations=operations)
