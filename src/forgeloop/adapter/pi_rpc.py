"""PI RPC 适配器：stdin/stdout JSONL 管理容器内 PI，观察 agent_settled。

协议（pi 1.1.0 官方 RPC 文档 https://pi.dev/docs/latest/rpc，已实测验证）：
- 以参数列表启动 PI RPC 进程（``pi --mode rpc --no-session`` 或容器命令），
  不用 shell；stdin 写命令（每行一个 JSON 对象），stdout 返回响应与事件。
- 命令带自增 ``id``，响应以 ``{"type":"response","command":...,"success":...}``
  关联；prompt 被接受（disposition=started/queued/handled）不意味着任务完成。
- 只有观察到 ``agent_settled`` 事件才视为不再自动推进（``agent_end`` 之后
  仍可能有重试、压缩恢复或排队消息）；settled 后用
  ``get_last_assistant_text`` 取最终文本。
- 停止请求发送 ``abort`` 命令（中止当前操作并等待空闲）；
  优雅停机是关闭 stdin。
- stderr 分流单独保存（诊断信息，不是协议数据）；全部事件与请求按会话
  身份落盘（开发与审查会话独立）。
- 异常、超时或进程退出的不明确结果如实报告，不自动重跑、不伪装已暂停。

会话文件（session_dir 下，按 task_id 与 role 区分）：
- ``<task>-<role>.events.jsonl``：收到的事件（含接收时间）
- ``<task>-<role>.requests.jsonl``：发出的请求（含发送时间）
- ``<task>-<role>.stderr.log``：进程 stderr 原文
"""

import contextlib
import json
import os
import selectors
import subprocess
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

SETTLED_EVENT = "agent_settled"
RESPONSE_EVENT = "response"
LAST_TEXT_COMMAND = "get_last_assistant_text"
ABORT_COMMAND = "abort"


class _ReadTimeout(Exception):
    pass


@dataclass(frozen=True)
class PIEvent:
    type: str
    payload: Mapping[str, Any]
    received_at: datetime


@dataclass(frozen=True)
class PIInvocationResult:
    """一次 PI 调用的结果小结构：完成、成果与未解决事项。

    settled 表示观察到 agent_settled；实测发现 settled 只表示不再自动推进
    （provider 自动重试耗尽也会 settled），此时 model_error 携带最终消息
    stopReason=error 的 provider 错误，业务侧必须当作未取得结果处理。
    error 为 None 才代表协议层明确完成，
    其余（timeout / process-exited / invalid-json / prompt-rejected）都是
    待核对的未解决状态。text 是 get_last_assistant_text 返回的最终文本，
    result 是该文本解析为 JSON 对象时的载荷（供业务节点解释）。
    """

    settled: bool
    aborted: bool
    text: str | None
    result: Mapping[str, Any] | None
    events: tuple[PIEvent, ...]
    error: str | None = None
    model_error: str | None = None
    stderr_tail: str = field(default="")


class PIProcessError(RuntimeError):
    """PI RPC 进程或协议错误。"""


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _json_object_or_none(text: str | None) -> Mapping[str, Any] | None:
    """最终文本解析为 JSON 对象；容忍代码块或散文包裹，但绝不凭空构造结构。

    真实模型常把要求的 JSON 包在 ```json 代码块或一句说明里。这里先按整体解析，
    失败后从第一个 ``{`` 起解析第一个完整对象；解析不出对象仍返回 None，由调用方
    判定结果不可用（例如审查节点据此中断，而不是猜测"无阻断"）。
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


@dataclass(frozen=True)
class PISpawnOptions:
    """PI 子进程启动选项：附加环境变量、显式工作目录与执行环境标签。

    工作目录必须显式给出：只把工作副本路径写进提示词不足以约束真实模型改哪里。
    ``execution_environment`` 只作事实记录（host/container），随会话请求落盘，
    供回查“本次 PI 到底是不是在受限执行环境里跑的”，不改变进程行为。
    """

    extra_env: Mapping[str, str] = field(default_factory=dict[str, str])
    cwd: Path | None = None
    execution_environment: str = "host"


class PIProcess:
    """一个 PI RPC 子进程会话（开发或审查独立会话各建一个）。"""

    def __init__(
        self,
        command: Sequence[str],
        task_id: str,
        role: str,
        session_dir: Path,
        options: PISpawnOptions | None = None,
    ) -> None:
        if not command:
            raise ValueError("PI command must not be empty")
        self._command = tuple(command)
        self._task_id = task_id
        self._role = role
        self._session_dir = session_dir
        self._options = options or PISpawnOptions()
        self._proc: subprocess.Popen[bytes] | None = None
        self._events: list[PIEvent] = []
        self._events_path = session_dir / f"{task_id}-{role}.events.jsonl"
        self._requests_path = session_dir / f"{task_id}-{role}.requests.jsonl"
        self._stderr_path = session_dir / f"{task_id}-{role}.stderr.log"
        self._stderr_file = None
        self._buffer = b""
        self._eof = False
        self._request_counter = 0
        self._prompt_request_id: str | None = None
        self._text_request_id: str | None = None
        self._settled_aborted = False
        self._model_error: str | None = None

    @property
    def events(self) -> tuple[PIEvent, ...]:
        return tuple(self._events)

    def start(self) -> None:
        if self._proc is not None:
            raise PIProcessError("PI process already started")
        self._session_dir.mkdir(parents=True, exist_ok=True)
        # stderr 重定向句柄随会话存活，close() 统一关闭。
        self._stderr_file = open(self._stderr_path, "ab")  # noqa: SIM115
        env = os.environ.copy()
        env.update(self._options.extra_env)
        self._proc = subprocess.Popen(
            list(self._command),
            cwd=None if self._options.cwd is None else str(self._options.cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file,
            shell=False,
            env=env,
        )

    def send_prompt(self, text: str) -> None:
        """发送一个 prompt 命令；接受与否由 response 与事件流回答。"""

        self._prompt_request_id = self._send_request({"type": "prompt", "message": text})

    def request_stop(self) -> None:
        """发送 abort 命令：中止当前操作并等待会话空闲。"""

        self._send_request({"type": ABORT_COMMAND})

    def _send_request(self, request: Mapping[str, Any]) -> str:
        if self._proc is None or self._proc.stdin is None:
            raise PIProcessError("PI process is not running")
        self._request_counter += 1
        request_id = f"req-{self._request_counter}"
        record = {"id": request_id, **dict(request)}
        line = json.dumps(record, ensure_ascii=False)
        try:
            self._proc.stdin.write((line + "\n").encode("utf-8"))
            self._proc.stdin.flush()
        except BrokenPipeError as error:
            raise PIProcessError(f"PI process closed its input: {error}") from error
        with open(self._requests_path, "a", encoding="utf-8") as requests_file:
            requests_file.write(
                json.dumps(
                    {
                        "sent_at": _iso(datetime.now(UTC)),
                        "execution_environment": self._options.execution_environment,
                        "request": record,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
        return request_id

    def wait_until_settled(self, timeout_seconds: float) -> PIInvocationResult:
        """读取事件直到 agent_settled 并取最终文本，或超时/退出/协议错误。

        prompt 响应 success=false 时返回 prompt-rejected 错误；
        settled 事件后发送 get_last_assistant_text 并等待其响应。
        """

        if self._proc is None or self._proc.stdout is None:
            raise PIProcessError("PI process is not running")
        if timeout_seconds <= 0:
            raise ValueError("Settlement timeout must be positive")
        deadline = time.monotonic() + timeout_seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._deadline_result()
            status = self._read_record(remaining)
            if isinstance(status, str):
                return self._label_result(status)
            if status is None:
                continue
            event = status
            self._record_event(event)
            outcome = self._apply_event(event)
            if outcome is not None:
                return outcome

    def _apply_event(self, event: PIEvent) -> PIInvocationResult | None:
        """事件分派：响应可能直接给出结果；settled 触发取文本；其余记录。"""

        if event.type == RESPONSE_EVENT:
            return self._apply_response(event)
        if event.type == "agent_end":
            self._track_model_error(event)
        elif event.type == SETTLED_EVENT:
            self._settled_aborted = bool(event.payload.get("aborted", False))
            self._text_request_id = self._send_request({"type": LAST_TEXT_COMMAND})
        return None

    def _track_model_error(self, event: PIEvent) -> None:
        """agent_end 最终消息 stopReason=error 时记录 provider 错误。

        自动重试会产生多个 agent_end；最后一个的最终状态才是结果
        （实测：重试 3 次后 settled，最终消息 stopReason=error、内容为空）。
        """

        raw_messages: object = event.payload.get("messages")
        if not isinstance(raw_messages, list):
            return
        for raw in reversed(cast("list[object]", raw_messages)):
            if not isinstance(raw, Mapping):
                continue
            message = cast("Mapping[str, object]", raw)
            if message.get("role") != "assistant":
                continue
            if message.get("stopReason") == "error":
                reason = message.get("errorMessage")
                self._model_error = reason if isinstance(reason, str) else "model error"
            else:
                self._model_error = None
            return

    def _apply_response(self, event: PIEvent) -> PIInvocationResult | None:
        """响应记录处理：拒绝返回错误结果；最终文本到达返回完成结果。"""

        rejection = self._prompt_rejection(event)
        if rejection:
            return self._unsettled(rejection)
        text = self._extract_text(event)
        if self._text_request_id is not None and text is not None:
            return self._settled_result(text)
        return None

    def _label_result(self, label: str) -> PIInvocationResult:
        if label == "timeout":
            return self._deadline_result()
        if label == "eof":
            return self._eof_result()
        return self._unsettled("invalid-json")

    def _read_record(self, timeout_seconds: float) -> PIEvent | str | None:
        """读取并解析一条记录：事件对象、timeout/eof/invalid 标签或 None(空行)。"""

        try:
            line = self._read_line(timeout_seconds)
        except _ReadTimeout:
            return "timeout"
        if line is None:
            return "eof"
        event = self._parse_event(line)
        if event is None:
            return "invalid"
        if event.type == "" and not line.strip():
            return None
        return event

    def _deadline_result(self) -> PIInvocationResult:
        if self._text_request_id:
            return self._settled_without_text("text-unavailable:timeout")
        return self._unsettled("timeout")

    def _eof_result(self) -> PIInvocationResult:
        if self._text_request_id:
            return self._settled_without_text("text-unavailable:process-exited")
        return self._unsettled("process-exited")

    def poll_exit_code(self) -> int | None:
        """核对进程真实退出状态；None 表示仍在运行。"""

        if self._proc is None:
            return None
        return self._proc.poll()

    def close(self) -> None:
        """关闭会话：先关 stdin 请求优雅停机，超时才终止进程。"""

        if self._proc is not None:
            if self._proc.stdin is not None:
                with contextlib.suppress(OSError):
                    self._proc.stdin.close()
            if self._proc.poll() is None:
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.terminate()
                    try:
                        self._proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self._proc.kill()
                        self._proc.wait()
            if self._proc.stdout is not None:
                self._proc.stdout.close()
            self._proc = None
        if self._stderr_file is not None:
            self._stderr_file.close()
            self._stderr_file = None

    def _read_line(self, timeout_seconds: float) -> str | None:
        """读取一行 stdout；EOF 返回 None；超时抛 _ReadTimeout。"""

        assert self._proc is not None and self._proc.stdout is not None
        fd = self._proc.stdout.fileno()
        selector = selectors.DefaultSelector()
        selector.register(fd, selectors.EVENT_READ)
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
                    raise _ReadTimeout
                chunk = os.read(fd, 65536)
                if not chunk:
                    self._eof = True
                    continue
                self._buffer += chunk
        finally:
            selector.close()

    def _parse_event(self, line: str) -> PIEvent | None:
        if not line.strip():
            return PIEvent(type="", payload={}, received_at=datetime.now(UTC))
        try:
            data: object = json.loads(line)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        payload = cast("dict[str, object]", data)
        return PIEvent(
            type=str(payload.get("type", "")),
            payload=payload,
            received_at=datetime.now(UTC),
        )

    def _prompt_rejection(self, event: PIEvent) -> str | None:
        """prompt 命令被拒绝时返回错误标签。"""

        if self._prompt_request_id is None:
            return None
        if event.payload.get("command") != "prompt":
            return None
        if event.payload.get("id") != self._prompt_request_id:
            return None
        if event.payload.get("success") is False:
            return "prompt-rejected"
        return None

    def _extract_text(self, event: PIEvent) -> str | None:
        """get_last_assistant_text 响应到达时提取最终文本；其余响应返回 None。"""

        if self._text_request_id is None:
            return None
        if event.payload.get("command") != LAST_TEXT_COMMAND:
            return None
        if event.payload.get("id") != self._text_request_id:
            return None
        if event.payload.get("success") is False:
            return ""
        data = event.payload.get("data")
        if isinstance(data, Mapping):
            value = cast("Mapping[str, object]", data).get("text")
            return value if isinstance(value, str) else ""
        if isinstance(data, str):
            return data
        return ""

    def _record_event(self, event: PIEvent) -> None:
        self._events.append(event)
        with open(self._events_path, "a", encoding="utf-8") as events_file:
            events_file.write(
                json.dumps(
                    {"received_at": _iso(event.received_at), "event": dict(event.payload)},
                    ensure_ascii=False,
                )
                + "\n"
            )

    def _settled_result(self, text: str) -> PIInvocationResult:
        return PIInvocationResult(
            settled=True,
            aborted=self._settled_aborted,
            text=text,
            result=_json_object_or_none(text),
            events=tuple(self._events),
            error=None,
            model_error=self._model_error,
            stderr_tail=self._stderr_tail(),
        )

    def _settled_without_text(self, error: str) -> PIInvocationResult:
        return PIInvocationResult(
            settled=True,
            aborted=self._settled_aborted,
            text=None,
            result=None,
            events=tuple(self._events),
            error=error,
            model_error=self._model_error,
            stderr_tail=self._stderr_tail(),
        )

    def _unsettled(self, error: str) -> PIInvocationResult:
        return PIInvocationResult(
            settled=False,
            aborted=False,
            text=None,
            result=None,
            events=tuple(self._events),
            error=error,
            model_error=self._model_error,
            stderr_tail=self._stderr_tail(),
        )

    def _stderr_tail(self, limit: int = 2000) -> str:
        if not self._stderr_path.exists():
            return ""
        try:
            return self._stderr_path.read_text(encoding="utf-8", errors="replace")[-limit:]
        except OSError:
            return ""
