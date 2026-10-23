"""Agent Runtime 通用契约：一次 Agent 会话的事件、结果、启动选项与会话文件。

PI 与 DSH 是同一类外部执行器（Agent Runtime）的两个实现，业务图只依赖本模块的
统一形状，不直接读某个运行时的私有协议：

- 两个实现都提供 ``start``/``send_prompt``/``wait_until_settled``/``close``，
  图层的 ``graph.agent_execution`` 按运行时名字构造会话，节点与规划共用同一调用路径。
- ``AgentInvocationResult`` 的语义与 PI 适配器一致：``settled`` 是**协议层**
  观察到终态，不等于成功；``model_error`` 是 provider 报错，``error`` 是协议层
  未明确完成的原因。业务侧对任一非空失败字段都按未取得结果处理（fail-closed）。
- 会话文件布局是跨层契约（架构 §6）：``<task>-<role>.events.jsonl``（事件）、
  ``<task>-<role>.requests.jsonl``（发出的请求/提示词与运行时身份）、
  ``<task>-<role>.stderr.log``（进程 stderr 原文）。文件名与 PI 既有现场一致，
  回查口径不变。

本模块只放**共同形状**，不 import 任何具体实现（``pi_rpc``/``dsh_headless`` 反向
依赖本模块），因此 ``adapter`` 层内部无环。
"""

import json
import os
import selectors
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast


class ReadTimeout(Exception):
    """在等待上限内没有读到整行（调用方决定超时语义）。"""


class JsonLineReader:
    """按行读取子进程 stdout 的缓冲读取器（PI 与 DSH 共用）。

    语义：读到一行返回不含换行的文本；EOF 返回 ``None``（缓冲里的最后一段
    仍会先返回一次）；等待超过 ``timeout_seconds`` 抛 :class:`ReadTimeout`。
    ``os.read`` 按字节读，不会因多字节字符被截断而阻塞。
    """

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._buffer = b""
        self._eof = False

    def read_line(self, timeout_seconds: float) -> str | None:
        selector = selectors.DefaultSelector()
        selector.register(self._fd, selectors.EVENT_READ)
        try:
            while True:
                if b"\n" in self._buffer:
                    line, _, self._buffer = self._buffer.partition(b"\n")
                    return line.decode("utf-8", errors="replace").rstrip("\r")
                if self._eof:
                    if self._buffer:
                        line, self._buffer = self._buffer, b""
                        return line.decode("utf-8", errors="replace")
                    return None
                events = selector.select(timeout_seconds)
                if not events:
                    raise ReadTimeout
                chunk = os.read(self._fd, 65536)
                if not chunk:
                    self._eof = True
                    continue
                self._buffer += chunk
        finally:
            selector.close()


@dataclass(frozen=True)
class AgentEvent:
    """一个运行时事件：类型、原始载荷与接收时间（落盘时一并保留）。"""

    type: str
    payload: Mapping[str, Any]
    received_at: datetime


@dataclass(frozen=True)
class AgentInvocationResult:
    """一次 Agent 调用的统一结果。

    ``settled``：观察到运行时的终态且结果可用于业务判定（PI）
    的 ``agent_settled``；DSH 的 ``turn_end: completed``）；``aborted``：运行时明确
    报告被中止；``model_error``：provider 错误（settled 也可能是错误，不能当成功）；
    ``error``：协议层未明确完成的原因。DSH 的非 ``completed`` 终态按未取得结果处理
    （``settled=False`` + ``error``），宁可中断也不放行。
    ``runtime``/``session_id``/``command`` 是这次调用的执行器身份证据。
    """

    settled: bool
    aborted: bool
    text: str | None
    result: Mapping[str, Any] | None
    events: tuple[AgentEvent, ...]
    error: str | None = None
    model_error: str | None = None
    stderr_tail: str = field(default="")
    runtime: str = ""
    session_id: str = ""
    command: tuple[str, ...] = ()


@dataclass(frozen=True)
class AgentSpawnOptions:
    """子进程启动选项：附加环境变量、显式工作目录与执行环境/运行时标签。

    工作目录必须显式给出：只把工作副本路径写进提示词不足以约束真实模型改哪里。
    ``execution_environment`` 与 ``runtime`` 只作事实记录，随会话请求落盘，
    供回查“本次到底是谁、在哪个执行环境里跑的”，不改变进程行为。
    """

    extra_env: Mapping[str, str] = field(default_factory=dict[str, str])
    cwd: Path | None = None
    execution_environment: str = "host"
    runtime: str = ""


@dataclass(frozen=True)
class AgentSessionPaths:
    """一个会话现场的三个文件；两个实现共用同一命名。"""

    events: Path
    requests: Path
    stderr: Path


def session_paths(session_dir: Path, task_id: str, role: str) -> AgentSessionPaths:
    """会话文件路径（跨层契约，改动属于架构变化）。"""

    prefix = f"{task_id}-{role}"
    return AgentSessionPaths(
        events=session_dir / f"{prefix}.events.jsonl",
        requests=session_dir / f"{prefix}.requests.jsonl",
        stderr=session_dir / f"{prefix}.stderr.log",
    )


def append_jsonl(path: Path, record: Mapping[str, Any]) -> None:
    """追加一行 JSON（不覆盖历史，保证原始记录可回查）。"""

    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(record), ensure_ascii=False) + "\n")


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def json_object_or_none(text: str | None) -> Mapping[str, Any] | None:
    """最终文本解析为 JSON 对象；容忍代码块或散文包裹，但绝不凭空构造结构。

    真实模型常把要求的 JSON 包在 ```json 代码块或一句说明里。这里先按整体解析，
    失败后从第一个 ``{`` 起解析第一个完整对象；解析不出对象仍返回 None，由调用方
    判定结果不可用（例如审查节点据此中断，而不是猜测“无阻断”）。
    """

    if not text:
        return None
    candidates = [text]
    start = text.find("{")
    if start > 0:
        candidates.append(text[start:])
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            data: object
            data, _ = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return cast("dict[str, object]", data)
    return None


def tail_of(path: Path, limit: int = 2000) -> str:
    """读取文件尾部（诊断用）；不存在或不可读时返回空串，不抛异常。"""

    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except OSError:
        return ""
