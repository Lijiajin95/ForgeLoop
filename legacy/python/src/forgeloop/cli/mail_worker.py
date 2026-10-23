"""邮箱交互的常驻轮询：把 ``mail interact --once`` 搬进 ``serve`` 的后台线程。

职责边界：

- 只负责调度与可观测状态（启动/停止、间隔、最近一次报告、错误累计）；
- 连接参数、白名单与邮件收发全部复用 ``cli.mail`` 与 ``cli.mail_interaction``，
  不在这里另写一套配置或业务规则；
- 单次处理失败只记录并等待下一轮，不让邮件服务拖垮常驻服务。
"""

from __future__ import annotations

import argparse
import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from forgeloop.cli.mail import _make_receiver, _make_sender
from forgeloop.cli.mail_interaction import InteractionReport, MailInteractionGateway
from forgeloop.mail.config import load_mail_config

LOGGER = logging.getLogger("forgeloop.mail")


class MailWorkerConfigError(ValueError):
    """邮件网关配置不可用（缺白名单、配置链或口令）；启动时失败关闭。"""


class MailProject(Protocol):
    """``MailWorker`` 需要的项目字段；与 records 的 Project 结构一致。"""

    @property
    def project_id(self) -> str: ...

    @property
    def repo_path(self) -> str: ...


class MailProcessor(Protocol):
    """可注入的单次处理器；测试用假实现替换真实 IMAP/SMTP。"""

    def process_once(self) -> InteractionReport: ...


@dataclass
class MailWorker:
    """在后台线程按固定间隔调用一次 ``process_once``。"""

    processor: MailProcessor
    interval_seconds: float = 60.0
    logger: logging.Logger = field(default=LOGGER)
    description: Mapping[str, object] = field(default_factory=dict)
    _stop: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _thread: threading.Thread | None = field(default=None, init=False, repr=False)
    _runs: int = field(default=0, init=False)
    _failures: int = field(default=0, init=False)
    _last_report: InteractionReport | None = field(default=None, init=False)
    _last_error: str = field(default="", init=False)

    def __post_init__(self) -> None:
        if self.interval_seconds <= 0:
            raise ValueError("邮件轮询间隔必须大于 0 秒")

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """启动后台线程；重复启动是空操作。"""

        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="forgeloop-mail-gateway", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        """请求停止并等待线程退出；超时不强杀（线程是 daemon）。"""

        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=max(0.0, timeout))
        self._thread = None

    def tick_once(self) -> InteractionReport | None:
        """同步执行一轮；异常记录后返回 ``None``。测试与首轮自检复用。"""

        self._runs += 1
        try:
            report = self.processor.process_once()
        except Exception as error:
            self._failures += 1
            self._last_error = f"{type(error).__name__}: {error}"
            self.logger.exception("邮件轮询失败，重置连接后等待下一轮")
            reset = getattr(self.processor, "reset", None)
            if callable(reset):
                try:
                    reset()
                except Exception:
                    self.logger.exception("重置邮件连接失败")
            return None
        self._last_report = report
        self.logger.info(
            "邮件轮询完成: fetched=%d processed=%d replied=%d skipped=%d errors=%d",
            report.fetched,
            len(report.processed),
            len(report.replied),
            len(report.skipped),
            len(report.errors),
        )
        for error in report.errors:
            self.logger.warning("邮件轮询错误: %s", error)
        return report

    def _run(self) -> None:
        while not self._stop.is_set():
            self.tick_once()
            if self._stop.wait(self.interval_seconds):
                break

    def status(self) -> dict[str, object]:
        """稳定的可观测摘要；不包含口令与邮件正文。"""

        last = self._last_report
        return {
            "running": self.running,
            "interval_seconds": self.interval_seconds,
            "runs": self._runs,
            "failures": self._failures,
            "last_error": self._last_error,
            "last_report": None
            if last is None
            else {
                "fetched": last.fetched,
                "processed": len(last.processed),
                "replied": len(last.replied),
                "skipped": len(last.skipped),
                "errors": len(last.errors),
            },
            **dict(self.description),
        }


def build_mail_worker(
    *,
    project: MailProject,
    records_root: Path,
    config_path: Path | None = None,
    interval_seconds: float = 60.0,
    logger: logging.Logger | None = None,
) -> MailWorker:
    """按配置链构造真实 IMAP/SMTP 网关；不建立网络连接，连接在首轮轮询时进行。"""

    config = load_mail_config(
        explicit_path=config_path,
        repo_root=Path.cwd(),
        home=Path.home(),
    )
    if not config.whitelist:
        raise MailWorkerConfigError(
            "邮件白名单为空：请先在 mail.toml 的 whitelist 登记允许对话的发件地址"
        )
    connection = argparse.Namespace(
        config=str(config.source_path),
        imap_host="",
        imap_port=0,
        imap_user="",
        imap_secret="",
        imap_folder="",
        no_imap_ssl=False,
        smtp_host="",
        smtp_port=0,
        smtp_user="",
        smtp_secret="",
        smtp_sender="",
        smtp_recipient="",
        no_smtp_ssl=False,
        smtp_starttls=False,
    )
    receiver = _make_receiver(connection)
    sender = _make_sender(connection)
    gateway = MailInteractionGateway(
        receiver,
        sender,
        root=records_root,
        project=project.project_id,
        allowed_senders=config.whitelist,
        project_path=project.repo_path,
    )
    return MailWorker(
        gateway,
        interval_seconds=interval_seconds,
        logger=logger or LOGGER,
        description={
            "config": str(config.source_path),
            "folder": config.folder,
            "allowed_senders": len(config.whitelist),
        },
    )


__all__ = [
    "MailProcessor",
    "MailProject",
    "MailWorker",
    "MailWorkerConfigError",
    "build_mail_worker",
]
