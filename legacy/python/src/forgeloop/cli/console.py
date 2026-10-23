"""前台 Web 操作管理台：``forgeloop web`` 的进程入口。

定位（所有者 2026-10-22）：

- Web 是**操作管理界面**，不再只是只读状态页。前台进程 ``forgeloop web`` 与常驻
  进程 ``forgeloop serve`` 共用同一套页面、会话面板、需求写入口与心跳执行栈；
  区别只在生命周期——``web`` 前台运行到 Ctrl+C，``serve`` 常驻并承担自动接续、
  邮箱轮询与受控热升级。
- **一个前台进程服务一个已登记项目**：页面读写、会话与需求操作都作用于该项目的
  记录根；多项目时必须用 ``--project`` 指定（与 ``serve`` 同一口径，不猜）。
- **不自动接续**：前台控制台只执行人工点下的推进/分析/规划请求；``auto_advance``
  的自动接续属于常驻 ``serve``，避免在交互进程里悄悄跑任务。
- 复用 ``cli.serve`` 的服务器、写端口与闸门：本模块只负责前台生命周期与启动输出，
  不复制第二套业务规则。
"""

from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path

import forgeloop.cli.serve as serve
from forgeloop.cli.common import base_records_root, fail
from forgeloop.cli.serve import ServeOperations
from forgeloop.cli.web import (
    DEFAULT_WEB_CONFIG,
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
    ProgressDocuments,
)
from forgeloop.domain.progress import ProgressConfigError
from forgeloop.domain.projects import DEFAULT_PROJECTS_FILE, PanelProjectError
from forgeloop.domain.service import ServiceConfigError
from forgeloop.graph.worker import ServiceWorker


def cmd_web(args: argparse.Namespace) -> int:
    """启动前台 Web 操作管理台：Ctrl+C 停止，工作线程随进程退出。"""

    root = base_records_root(args)
    service_config_path = Path(args.service_config)
    web_config_path = Path(args.web_config)
    try:
        settings = serve._resolve_settings(args, root, service_config_path, web_config_path)
    except (
        serve.ServeConfigError,
        ServiceConfigError,
        serve.WebConfigError,
        ProgressConfigError,
    ) as error:
        return fail(str(error))
    if settings.project is None:
        return fail(
            "Web 操作管理台需要已登记项目：先运行 `forgeloop project add`，"
            "再用 --project 指定要操作的项目"
        )
    panel = serve.build_panel_context(settings)
    try:
        serve.check_panel(panel.registry)
    except (serve.ServeConfigError, PanelProjectError) as error:
        panel.runner.shutdown()
        return fail(str(error))
    # 前台控制台不自动接续：auto_advance 的自动执行属于常驻 serve。
    worker = ServiceWorker(
        settings.records_root,
        poll_seconds=settings.service.poll_seconds,
        auto_advance=False,
        projects=serve.execution_profiles(settings, panel.registry.entries()),
        max_concurrent=settings.service.max_concurrent,
        process_home=os.environ.get("HOME", ""),
    )
    token = secrets.token_urlsafe(serve.TOKEN_BYTES)
    try:
        server = serve.build_server(settings, worker, panel, token=token)
    except OSError as error:
        panel.runner.shutdown()
        return fail(f"无法监听 {settings.service.host}:{settings.service.port}: {error}")
    host, port = server.server_address[:2]
    print(f"Web 操作管理台: http://{host}:{port}/", flush=True)
    print(f"项目: {settings.project.project_id}", flush=True)
    print(f"记录根: {settings.records_root}", flush=True)
    print(f"面板: 会话、运行时与项目档案（项目档案 {args.projects_file}）", flush=True)
    print(
        "自动接续: 关闭（只执行页面点下的推进/分析/规划；常驻接续请用 forgeloop serve）", flush=True
    )
    print("按 Ctrl+C 停止。", flush=True)
    worker.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("已停止。", flush=True)
    finally:
        worker.stop()
        panel.runner.shutdown()
        server.server_close()
    return 0


def add_web_parser(
    subparsers: argparse._SubParsersAction,
    default_records_root: str,
    documents: ProgressDocuments,
    operations: ServeOperations,
) -> None:
    """登记 ``forgeloop web``：前台 Web 操作管理台（与 serve 共用写入口）。"""

    web = subparsers.add_parser(
        "web",
        help="Web 操作管理台：前台运行，提供会话、需求 CRUD 与人工操作",
    )
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
        help=f"页面刷新配置文件（默认 {DEFAULT_WEB_CONFIG}）",
    )
    web.add_argument(
        "--service-config",
        default=serve.DEFAULT_SERVICE_CONFIG,
        help=f"服务与执行档案配置（默认 {serve.DEFAULT_SERVICE_CONFIG}）",
    )
    web.add_argument(
        "--projects-file",
        default=DEFAULT_PROJECTS_FILE,
        help=f"页面管理的项目档案（默认 {DEFAULT_PROJECTS_FILE}）",
    )
    web.add_argument(
        "--project",
        default="",
        help="本进程服务的项目身份（缺省取唯一已登记项目；有多个项目时必须指定）",
    )
    web.add_argument("--records-root", default=default_records_root)
    web.set_defaults(
        func=cmd_web,
        progress_documents=documents,
        operations=operations,
    )
