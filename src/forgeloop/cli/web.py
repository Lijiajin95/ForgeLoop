"""状态页（B01）：只读 HTTP 服务与页面读模型。

职责边界：

- **只读**：只接受 ``GET``/``HEAD``，其余方法一律 405 且不写任何记录。页面读模型
  复用 ``cli.main`` 的 ``status --json`` 与 ``requirement status --json`` 文档构建器
  ——同一份权威记录、同一套查询口径，不在这里重建第二套取数或业务规则，也不新增
  任何批准/推进入口（那需要与 CLI 一致的批准绑定校验，属于后续需求）。两个构建器
  以 :class:`ProgressDocuments` 由 ``cli.main`` 注入：架构契约禁止模块间 import 环，
  而 ``cli.main`` 必须导入本模块注册 ``web`` 命令，因此本模块不反向导入它。
- **刷新间隔**：配置文件项（默认 ``config/web.toml`` 的 ``refresh_seconds``）作为
  默认值，``--refresh-seconds`` 覆盖它；来源优先级、内建默认 60 秒与非法值拒绝都在
  ``domain.progress`` 的纯规则里。配置文件损坏或版本不符时启动即失败，不静默回落。
- **页面**：结构在随包分发的 ``web_page.html``，行为在 ``static/*.js``——后者由
  ``frontend/src`` 的 TypeScript 源编译产出（``make frontend-build``），编译产物与
  源码的漂移由 ``scripts/check_frontend_build.py`` 拒绝；刷新配置由 ``/api/progress``
  返回，页面侧只做展示。
- **监听地址**：默认回环 ``127.0.0.1``。这是单用户本地工具的状态页，暴露到其他
  地址必须由使用者显式指定 ``--host``。

读取失败（记录损坏、检查点不可读等）返回 500 并把原因写入 stderr：宁可页面报错，
也不把读取失败伪装成「没有需求、没有任务」。

「只读」指不写入任何业务记录（不批准、不推进、不改状态）。查询连接与 CLI 查询
命令同源：记录库不存在时会按需建立空库（SQLite schema bootstrap），这一步是查询
本身的代价，不产生任何业务事实。
"""

import argparse
import json
import re
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from forgeloop.cli.common import fail, records_root
from forgeloop.domain.progress import (
    AUTO_REFRESH_OFF,
    IssueItem,
    ProgressConfigError,
    RefreshSetting,
    RefreshSource,
    requirement_issue,
    resolve_refresh_seconds,
    slot_issue,
    task_issue,
)
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

DEFAULT_WEB_HOST = "127.0.0.1"
DEFAULT_WEB_PORT = 8710
DEFAULT_WEB_CONFIG = "config/web.toml"
WEB_CONFIG_SCHEMA_VERSION = 1
WEB_API_SCHEMA_VERSION = 1
PAGE_FILENAME = "web_page.html"
# 页面模块目录：由 TypeScript 源（frontend/src）编译产出，随包分发。
STATIC_DIRNAME = "static"
# 只服务形如 `name.js` 的文件名：不含路径分隔符，天然拒绝目录穿越。
PAGE_MODULE_PATTERN = re.compile(r"[a-z0-9_]+\.js")
ALLOWED_METHODS = "GET, HEAD"
JSON_TYPE = "application/json; charset=utf-8"
HTML_TYPE = "text/html; charset=utf-8"
JS_TYPE = "text/javascript; charset=utf-8"
REFRESH_SOURCE_TEXT = {
    RefreshSource.CLI: "--refresh-seconds",
    RefreshSource.CONFIG: "配置文件",
    RefreshSource.DEFAULT: "内建默认",
}


class WebConfigError(ValueError):
    """状态页配置损坏：启动即失败，不静默使用默认值。"""


@dataclass(frozen=True)
class ProgressDocuments:
    """状态页读模型的两个文档构建器：需求状态文档与单任务状态文档。

    由 ``cli.main`` 在注册 ``web`` 命令时注入（同一个函数对象，不是副本），
    因此页面展示的结构与 ``--json`` 查询完全一致。
    """

    requirement: Callable[[Path, RequirementStore, str], dict]
    task: Callable[[RecordStore, str], dict]


@dataclass(frozen=True)
class WebSettings:
    """一次状态页服务的全部依赖：记录根、监听地址、生效刷新间隔与读模型。"""

    records_root: Path
    host: str
    port: int
    refresh: RefreshSetting
    config_path: Path
    documents: ProgressDocuments


def load_web_config(path: Path) -> Mapping[str, object] | None:
    """读取状态页配置原始文档；文件不存在返回 ``None``（由内建默认兜底）。"""

    if not path.is_file():
        return None
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
        raise WebConfigError(f"状态页配置 {path} 解析失败: {error}") from error
    if document.get("schema_version") != WEB_CONFIG_SCHEMA_VERSION:
        raise WebConfigError(
            f"状态页配置 {path} 的 schema_version 必须是 {WEB_CONFIG_SCHEMA_VERSION}"
        )
    return document


def page_html() -> str:
    """随包分发的静态页面；无服务端模板替换，刷新配置由 API 返回。"""

    return (resources.files("forgeloop.cli") / PAGE_FILENAME).read_text(encoding="utf-8")


def static_dir() -> Traversable:
    """页面模块目录（编译产物）。"""

    return resources.files("forgeloop.cli") / STATIC_DIRNAME


def page_module(name: str) -> bytes | None:
    """读取一个页面模块；名字不合法或文件不存在时返回 ``None``。

    名字先经 :data:`PAGE_MODULE_PATTERN` 全匹配（不含路径分隔符与点段），因此
    请求无法跳出模块目录；文件缺失如实返回 ``None``，由调用方给 404。
    """

    if PAGE_MODULE_PATTERN.fullmatch(name) is None:
        return None
    path = static_dir() / name
    if not path.is_file():
        return None
    return path.read_bytes()


def issue_section(issue: IssueItem) -> dict:
    """问题项 → JSON 段：机器标签与中文摘要分开，页面按标签分组。"""

    return {
        "kind": str(issue.kind),
        "ref_id": issue.ref_id,
        "summary": issue.summary,
        "detail": issue.detail,
    }


def build_progress_document(
    root: Path,
    refresh: RefreshSetting,
    documents: ProgressDocuments,
    *,
    generated_at: datetime | None = None,
) -> dict:
    """组装 ``/api/progress``：只读权威记录，需求/任务/问题三段一次取齐。"""

    moment = datetime.now(UTC) if generated_at is None else generated_at
    requirements: list[dict] = []
    tasks: list[dict] = []
    issues: list[IssueItem] = []

    requirement_store = RequirementStore(root / "records.sqlite")
    try:
        for requirement in requirement_store.all_requirements():
            document = documents.requirement(root, requirement_store, requirement.req_id)
            requirements.append(document)
            issue = requirement_issue(
                str(document.get("requirement_status", "")),
                ref_id=requirement.req_id,
                detail=str(
                    document.get("blocked_reason") or document.get("blocked_reason_text") or ""
                ),
            )
            if issue is not None:
                issues.append(issue)
    finally:
        requirement_store.close()

    record_store = RecordStore(root / "records.sqlite")
    try:
        for task in record_store.all_tasks():
            document = documents.task(record_store, task.id)
            tasks.append(document)
            issue = task_issue(
                str(document.get("status", "")),
                ref_id=task.id,
                detail=str(document.get("blocked_reason_text") or ""),
            )
            if issue is not None:
                issues.append(issue)
        for occupant in record_store.actions.outstanding_slots():
            issues.append(
                slot_issue(
                    slot=occupant.task_id.removeprefix(SLOT_PREFIX),
                    owner=occupant.role or "",
                    started_at=occupant.started_at.isoformat(),
                )
            )
    finally:
        record_store.close()

    return {
        "schema_version": WEB_API_SCHEMA_VERSION,
        "generated_at": moment.isoformat(),
        "records_root": str(root),
        "refresh_seconds": refresh.seconds,
        "refresh_source": str(refresh.source),
        "counts": {
            "requirements": len(requirements),
            "tasks": len(tasks),
            "issues": len(issues),
        },
        "requirements": requirements,
        "tasks": tasks,
        "issues": [issue_section(issue) for issue in issues],
    }


def refresh_text(refresh: RefreshSetting, config_path: Path) -> str:
    """生效刷新间隔的中文说明，启动时打印一次。"""

    if refresh.seconds == AUTO_REFRESH_OFF:
        return "已关闭自动刷新（页面只保留手动刷新）"
    origin = REFRESH_SOURCE_TEXT[refresh.source]
    if refresh.source is RefreshSource.CONFIG:
        origin = f"{origin} {config_path}"
    return f"每 {refresh.seconds} 秒（来源: {origin}）"


class ProgressRequestHandler(BaseHTTPRequestHandler):
    """只读状态页的请求处理器：按请求打开自己的连接，不跨线程共享。

    协议保持标准库默认的 HTTP/1.0：每次响应后关闭连接。这样既不会让被遗弃的空闲
    长连接长期占用线程，也不会每 30 秒写一条「Request timed out」。若将来改成
    长连接，必须同时处理 405 路径不读取请求体导致的连接错位。
    """

    server_version = "ForgeLoopWeb/1"

    @property
    def settings(self) -> WebSettings:
        return cast("ProgressHTTPServer", self.server).settings

    def do_GET(self) -> None:
        self._serve(send_body=True)

    def do_HEAD(self) -> None:
        self._serve(send_body=False)

    def do_POST(self) -> None:
        self._method_not_allowed()

    def do_PUT(self) -> None:
        self._method_not_allowed()

    def do_PATCH(self) -> None:
        self._method_not_allowed()

    def do_DELETE(self) -> None:
        self._method_not_allowed()

    def _serve(self, *, send_body: bool) -> None:
        route = urlsplit(self.path).path
        try:
            status, content_type, body = self._route(route)
        except Exception as error:  # 读取失败必须可见，不能伪装成空页面
            self.log_error("状态页读取失败（%s）: %s", route, error)
            status = 500
            content_type = JSON_TYPE
            body = self._error_bytes("progress_failed", str(error))
        self._respond(status, content_type, body, send_body=send_body)

    def _route(self, route: str) -> tuple[int, str, bytes]:
        if route in ("/", "/index.html"):
            return 200, HTML_TYPE, page_html().encode("utf-8")
        if route.endswith(".js"):
            module = page_module(route.removeprefix("/"))
            if module is not None:
                return 200, JS_TYPE, module
        if route == "/api/progress":
            document = build_progress_document(
                self.settings.records_root, self.settings.refresh, self.settings.documents
            )
            return 200, JSON_TYPE, json.dumps(document, ensure_ascii=False).encode("utf-8")
        return 404, JSON_TYPE, self._error_bytes("not_found", f"未知路径: {route}")

    def _respond(self, status: int, content_type: str, body: bytes, *, send_body: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # 进展数据每次都不同，禁止浏览器缓存，否则页面会显示过期进展。
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _method_not_allowed(self) -> None:
        body = self._error_bytes("method_not_allowed", "状态页只读：只接受 GET 与 HEAD")
        # 本方法不读取请求体，必须关闭连接，否则同一连接上的下一个请求会被错解析；
        # HTTP/1.0 响应本来就在本次响应后关闭，这里显式写出以免将来改协议时漏掉。
        self.send_response(405)
        self.send_header("Allow", ALLOWED_METHODS)
        self.send_header("Content-Type", JSON_TYPE)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _error_bytes(code: str, detail: str) -> bytes:
        return json.dumps({"error": code, "detail": detail}, ensure_ascii=False).encode("utf-8")


class ProgressHTTPServer(ThreadingHTTPServer):
    """状态页服务：设置随实例传递，处理器经 ``self.server.settings`` 读取。"""

    daemon_threads = True

    def __init__(self, settings: WebSettings) -> None:
        self.settings = settings
        super().__init__((settings.host, settings.port), ProgressRequestHandler)


def build_server(settings: WebSettings) -> ProgressHTTPServer:
    """按设置绑定真实回环地址；端口冲突等绑定错误由调用方处理。"""

    return ProgressHTTPServer(settings)


def cmd_web(args: argparse.Namespace) -> int:
    root = records_root(args)
    config_path = Path(args.web_config)
    try:
        config = load_web_config(config_path)
        refresh = resolve_refresh_seconds(config, cli_value=args.refresh_seconds)
    except (WebConfigError, ProgressConfigError) as error:
        return fail(str(error))
    try:
        server = build_server(
            WebSettings(root, args.host, args.port, refresh, config_path, args.progress_documents)
        )
    except OSError as error:
        return fail(f"无法监听 {args.host}:{args.port}: {error}")
    host, port = server.server_address[:2]
    print(f"状态页: http://{host}:{port}/", flush=True)
    print(f"记录根: {root}", flush=True)
    print(f"自动刷新: {refresh_text(refresh, config_path)}", flush=True)
    print("按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("已停止。", flush=True)
    finally:
        server.server_close()
    return 0


def add_web_parser(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
    documents: ProgressDocuments,
) -> None:
    web = subparsers.add_parser("web", help="状态页：只读查看需求、任务与问题处理进展")
    web.add_argument(
        "--host",
        default=DEFAULT_WEB_HOST,
        help=f"监听地址（默认 {DEFAULT_WEB_HOST}，仅本机可访问）",
    )
    web.add_argument(
        "--port",
        type=int,
        default=DEFAULT_WEB_PORT,
        help=f"监听端口（默认 {DEFAULT_WEB_PORT}；0 表示由系统分配）",
    )
    web.add_argument(
        "--refresh-seconds",
        type=int,
        default=None,
        help="页面自动刷新间隔秒数；0 表示关闭自动刷新（覆盖配置文件）",
    )
    web.add_argument(
        "--web-config",
        default=DEFAULT_WEB_CONFIG,
        help=f"状态页配置文件（默认 {DEFAULT_WEB_CONFIG}）",
    )
    web.add_argument("--records-root", default=default_records_root)
    web.set_defaults(func=cmd_web, progress_documents=documents)
