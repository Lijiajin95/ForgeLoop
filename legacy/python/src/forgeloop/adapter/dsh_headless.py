"""DSH headless 适配器：一次性子进程 + ``--json`` 事件流，观察 turn_end。

DSH 是 Agent Runtime 的另一个实现（PI 见 ``adapter.pi_rpc``），两者共用
``adapter.agent_runtime`` 的事件、结果与会话文件契约；本模块只讲 DSH 的协议。

协议（``@deepseek-ai/dsh-headless`` 0.2.1 官方 README，机器可读契约）：
- 命令形如 ``dsh --profile headless --json``；一个进程只回答一个任务，没有交互
  命令通道，因此提示词写进 stdin 并关闭，进程自行退出。
- stdout 是 JSONL 事件流：``session``（含 sessionId）开场，中间有 ``status``/
  ``text``/``thinking``/``tool_call``/``tool_result``，``final`` 收场并携带
  完整最终文本；运行器自身的失败写 ``error`` 事件且没有 ``final``。
- 终态原因在 ``status(phase=turn_end).reason.kind``：``completed``/``aborted``/
  ``error``（provider 错误，含 ``error.code``/``error.message``）/``blocked``/
  ``max-tokens``/``interrupted``/``forked``。退出码 0 只对应 ``completed``。
- 只有 ``completed`` 与 ``aborted`` 记为 ``settled``：前者结果可用，后者业务侧按
  中止处理；其余终态按“未取得结果”如实上报（``error``），交节点 fail-closed 中断，
  不把失败的会话当成成功（与 PI 的 ``stopReason=error`` 同口径）。

会话文件（session_dir 下，与 PI 同一命名，回查口径一致）：
- ``<task>-<role>.events.jsonl``：收到的事件（含接收时间）
- ``<task>-<role>.requests.jsonl``：发出的提示词、命令与运行时身份
- ``<task>-<role>.stderr.log``：进程 stderr 原文（``dsh:`` 诊断）
"""

import contextlib
import json
import os
import subprocess
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from forgeloop.adapter.agent_runtime import (
    AgentEvent,
    AgentInvocationResult,
    AgentSpawnOptions,
    JsonLineReader,
    ReadTimeout,
    append_jsonl,
    iso,
    json_object_or_none,
    session_paths,
    tail_of,
)

RUNTIME_NAME = "dsh"
SESSION_EVENT = "session"
STATUS_EVENT = "status"
FINAL_EVENT = "final"
ERROR_EVENT = "error"
TURN_END_PHASE = "turn_end"
# 结果可用或业务侧按中止处理的终态；其余 reason.kind 一律按未取得结果上报。
_USABLE_REASONS = ("completed", "aborted")
# 读到终态事件后再等进程退出的上限：结果已经在流里，等待只为拿到真实退出码。
_EXIT_GRACE_SECONDS = 5.0


class DSHProcessError(RuntimeError):
    """DSH headless 进程或协议错误。"""


class _DSHStreamError(Exception):
    """事件流本身不合法（非 JSON 行）；由调用方转成未取得结果。"""


def parse_event_line(line: str) -> AgentEvent | None:
    """解析一行 stdout：空行返回 None，非法 JSON 抛 :class:`_DSHStreamError`。"""

    if not line.strip():
        return None
    try:
        data: object = json.loads(line)
    except json.JSONDecodeError as error:
        raise _DSHStreamError(f"non-json line: {error}") from error
    if not isinstance(data, dict):
        raise _DSHStreamError("event line is not a JSON object")
    payload = cast("dict[str, object]", data)
    return AgentEvent(
        type=str(payload.get("type", "")),
        payload=payload,
        received_at=datetime.now(UTC),
    )


def _turn_reason(events: Sequence[AgentEvent]) -> Mapping[str, Any] | None:
    """最后一个 ``status(phase=turn_end)`` 的 reason 对象；没有则返回 None。"""

    for event in reversed(events):
        if event.type != STATUS_EVENT or event.payload.get("phase") != TURN_END_PHASE:
            continue
        raw = event.payload.get("reason")
        return cast("Mapping[str, Any]", raw) if isinstance(raw, Mapping) else None
    return None


def _reason_kind(reason: Mapping[str, Any] | None) -> str:
    if reason is None:
        return ""
    raw = reason.get("kind")
    return raw if isinstance(raw, str) else ""


def _provider_error(reason: Mapping[str, Any]) -> str:
    """``reason.kind=error`` 的 provider 错误文本（code 与 message 都缺失时兜底）。"""

    raw = reason.get("error")
    code = ""
    message = ""
    if isinstance(raw, Mapping):
        error = cast("Mapping[str, Any]", raw)
        if isinstance(error.get("code"), str):
            code = str(error["code"])
        if isinstance(error.get("message"), str):
            message = str(error["message"])
    if code and message:
        return f"{code}: {message}"
    return message or code or "model error"


@dataclass(frozen=True)
class DSHOutcome:
    """纯函数分类结果（便于不启动进程地验证事件流语义）。"""

    settled: bool
    aborted: bool
    text: str | None
    error: str | None
    model_error: str | None
    session_id: str
    turn_reason: str


def classify_run(
    events: Sequence[AgentEvent],
    exit_code: int | None,
    *,
    invalid_stream: bool = False,
    timed_out: bool = False,
) -> DSHOutcome:
    """把一次 DSH 运行的事件流与退出码归类为统一结果字段（纯函数）。

    判定优先级：超时/非法流 > 运行器 ``error`` 事件 > ``turn_end`` 原因 >
    退出码与 ``final``。非 ``completed`` 且非 ``aborted`` 的终态全部返回
    ``settled=False`` 与具体 ``error``，绝不因为没有结构化文本就把会话当成成功。
    """

    session_id = ""
    final_text: str | None = None
    runtime_error: str | None = None
    for event in events:
        if event.type == SESSION_EVENT and isinstance(event.payload.get("sessionId"), str):
            session_id = str(event.payload["sessionId"])
        elif event.type == FINAL_EVENT:
            raw_text = event.payload.get("text")
            final_text = raw_text if isinstance(raw_text, str) else ""
        elif event.type == ERROR_EVENT:
            message = event.payload.get("message")
            runtime_error = message if isinstance(message, str) else "runtime error"
    if timed_out:
        return DSHOutcome(
            settled=False,
            aborted=False,
            text=None,
            error="timeout",
            model_error=None,
            session_id=session_id,
            turn_reason="",
        )
    if invalid_stream:
        return DSHOutcome(
            settled=False,
            aborted=False,
            text=None,
            error="invalid-json",
            model_error=None,
            session_id=session_id,
            turn_reason="",
        )
    if runtime_error is not None:
        return DSHOutcome(
            settled=False,
            aborted=False,
            text=final_text,
            error=f"runtime-error: {runtime_error}",
            model_error=None,
            session_id=session_id,
            turn_reason="",
        )
    reason = _turn_reason(events)
    kind = _reason_kind(reason)
    if kind == "completed":
        if final_text is None:
            return DSHOutcome(
                settled=False,
                aborted=False,
                text=None,
                error="final-missing",
                model_error=None,
                session_id=session_id,
                turn_reason=kind,
            )
        return DSHOutcome(
            settled=True,
            aborted=False,
            text=final_text,
            error=None,
            model_error=None,
            session_id=session_id,
            turn_reason=kind,
        )
    if kind == "aborted":
        return DSHOutcome(
            settled=True,
            aborted=True,
            text=final_text if final_text is not None else "",
            error=None,
            model_error=None,
            session_id=session_id,
            turn_reason=kind,
        )
    if kind == "error":
        assert reason is not None  # kind 非空即 reason 存在
        return DSHOutcome(
            settled=True,
            aborted=False,
            text=final_text,
            error=None,
            model_error=_provider_error(reason),
            session_id=session_id,
            turn_reason=kind,
        )
    if kind:
        return DSHOutcome(
            settled=False,
            aborted=False,
            text=final_text,
            error=f"turn-{kind}",
            model_error=None,
            session_id=session_id,
            turn_reason=kind,
        )
    # 没有 turn_end：只有 final 且没有失败退出码时才按完成处理。
    if final_text is not None and exit_code in (0, None):
        return DSHOutcome(
            settled=True,
            aborted=False,
            text=final_text,
            error=None,
            model_error=None,
            session_id=session_id,
            turn_reason="",
        )
    if final_text is None:
        error = "final-missing" if exit_code == 0 else f"process-exited:{exit_code}"
    else:
        error = f"exit-{exit_code}"
    return DSHOutcome(
        settled=False,
        aborted=False,
        text=final_text,
        error=error,
        model_error=None,
        session_id=session_id,
        turn_reason="",
    )


class DSHProcess:
    """一个 DSH headless 一次性会话（开发、审查、分析各建一个）。"""

    def __init__(
        self,
        command: Sequence[str],
        task_id: str,
        role: str,
        session_dir: Path,
        options: AgentSpawnOptions | None = None,
    ) -> None:
        if not command:
            raise ValueError("DSH command must not be empty")
        self._command = tuple(command)
        self._task_id = task_id
        self._role = role
        self._session_dir = session_dir
        self._options = options or AgentSpawnOptions(runtime=RUNTIME_NAME)
        paths = session_paths(session_dir, task_id, role)
        self._events_path = paths.events
        self._requests_path = paths.requests
        self._stderr_path = paths.stderr
        self._proc: subprocess.Popen[bytes] | None = None
        self._stderr_file = None
        self._reader: JsonLineReader | None = None
        self._events: list[AgentEvent] = []
        self._last_exit_code: int | None = None

    @property
    def events(self) -> tuple[AgentEvent, ...]:
        return tuple(self._events)

    @property
    def command(self) -> tuple[str, ...]:
        return self._command

    @property
    def last_exit_code(self) -> int | None:
        """最近一次观察到的进程退出码；仍在运行或尚未收尾时为 ``None``。"""

        return self._last_exit_code

    def start(self) -> None:
        if self._proc is not None:
            raise DSHProcessError("DSH process already started")
        self._session_dir.mkdir(parents=True, exist_ok=True)
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
        """把提示词写进 stdin 并关闭：headless 一个进程只读一个任务。"""

        if self._proc is None or self._proc.stdin is None:
            raise DSHProcessError("DSH process is not running")
        try:
            self._proc.stdin.write(text.encode("utf-8"))
            self._proc.stdin.flush()
            self._proc.stdin.close()
        except (BrokenPipeError, OSError) as error:
            raise DSHProcessError(f"DSH process closed its input: {error}") from error
        # 只有提示词真正写进进程之后才记录请求：证据里不出现“发过但没送达”的假记录。
        append_jsonl(
            self._requests_path,
            {
                "sent_at": iso(datetime.now(UTC)),
                "agent_runtime": self._options.runtime or RUNTIME_NAME,
                "execution_environment": self._options.execution_environment,
                "command": list(self._command),
                "prompt": text,
            },
        )

    def wait_until_settled(self, timeout_seconds: float) -> AgentInvocationResult:
        """读到终态事件或进程退出；超时、非法流与失败终态都如实上报。"""

        if self._proc is None or self._proc.stdout is None:
            raise DSHProcessError("DSH process is not running")
        if timeout_seconds <= 0:
            raise ValueError("Settlement timeout must be positive")
        if self._reader is None:
            self._reader = JsonLineReader(self._proc.stdout.fileno())
        deadline = time.monotonic() + timeout_seconds
        timed_out = False
        invalid_stream = False
        terminal_seen = False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                line = self._reader.read_line(remaining)
            except ReadTimeout:
                timed_out = True
                break
            if line is None:
                break
            try:
                event = parse_event_line(line)
            except _DSHStreamError:
                invalid_stream = True
                break
            if event is None:
                continue
            self._record_event(event)
            if event.type in (FINAL_EVENT, ERROR_EVENT):
                terminal_seen = True
                break
        exit_code = self._await_exit(terminal_seen)
        outcome = classify_run(
            self._events, exit_code, invalid_stream=invalid_stream, timed_out=timed_out
        )
        return AgentInvocationResult(
            settled=outcome.settled,
            aborted=outcome.aborted,
            text=outcome.text,
            result=json_object_or_none(outcome.text),
            events=tuple(self._events),
            error=outcome.error,
            model_error=outcome.model_error,
            stderr_tail=tail_of(self._stderr_path),
            runtime=self._options.runtime or RUNTIME_NAME,
            session_id=outcome.session_id,
            command=self._command,
        )

    def _await_exit(self, terminal_seen: bool) -> int | None:
        """拿到真实退出码：读到终态后给一小段收尾时间，进程未退出则返回 None。"""

        if self._proc is None:
            return None
        if terminal_seen:
            try:
                return self._proc.wait(timeout=_EXIT_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                return None
        try:
            return self._proc.wait(timeout=_EXIT_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            return None

    def poll_exit_code(self) -> int | None:
        """核对进程真实退出状态；None 表示仍在运行。"""

        if self._proc is None:
            return None
        return self._proc.poll()

    def close(self) -> None:
        """关闭会话：先关 stdin，超时才终止进程（一次性运行本就会自行退出）。"""

        if self._proc is not None:
            if self._proc.stdin is not None:
                with contextlib.suppress(OSError):
                    self._proc.stdin.close()
            if self._proc.poll() is None:
                try:
                    self._proc.wait(timeout=_EXIT_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    self._proc.terminate()
                    try:
                        self._proc.wait(timeout=_EXIT_GRACE_SECONDS)
                    except subprocess.TimeoutExpired:
                        self._proc.kill()
                        self._proc.wait()
            self._last_exit_code = self._proc.poll()
            if self._proc.stdout is not None:
                self._proc.stdout.close()
            self._proc = None
        if self._stderr_file is not None:
            self._stderr_file.close()
            self._stderr_file = None

    def _record_event(self, event: AgentEvent) -> None:
        self._events.append(event)
        append_jsonl(
            self._events_path,
            {"received_at": iso(event.received_at), "event": dict(event.payload)},
        )
