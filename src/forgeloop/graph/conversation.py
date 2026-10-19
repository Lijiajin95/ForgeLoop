"""面板会话的一轮 Agent 执行（graph 层）：把一条人工消息变成一次真实的 PI 调用。

职责边界：

- **服务端多轮上下文**：一个会话一个常驻 PI 进程（``graph.session_runtime`` 的进程池）。
  暖进程只发本次输入（上下文在它手里），冷启动回放历史——两种情形都记进记录
  （``panel_messages.context_mode``），人能看到「这一轮为什么带了历史」。
- **流式落库**：整轮结束前 PI 就会推 ``message_update`` 文本增量；这里按节流把它们写进
  同一条 ``streaming`` 消息（先建行、反复更新），轮末落成 ``ok`` 或 ``error``。面板读到的是
  「正在增长的文字」，不是等整轮结束才第一次出现。
- **工具留痕与审批闸门**：逐次记录 ``tool_execution_start/end``（名字、参数与结果摘要、
  风险级别、耗时、是否报错）；本轮只要跑过需要人工确认的工具，就在**轮次边界**停下等人
  审批。**协议没有执行前的工具审批事件或命令**（206 份真实轨迹里零 permission 事件），
  因此这道闸门是「下一步之前的人工确认」，不是「执行前拦截」——文案如实这么写。
- **压缩可见**：PI 的自动压缩以 ``entry_appended`` 的 ``context_edit`` 出现；这里记一条
  系统消息并累加压缩计数，本会话的流水只追加、一条不删。
- **不碰研发业务状态**：一次对话不批准、不验收、不推进任何需求。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from forgeloop.adapter.pi_rpc import PIEvent, PIInvocationResult, PIProcess, PISpawnOptions
from forgeloop.domain.conversation import (
    HISTORY_MESSAGES_MAX,
    LIVE_SESSION_STATUSES,
    TOOL_RESULT_CHARS_MAX,
    ConversationError,
    DecisionKind,
    MessageRole,
    MessageState,
    SessionStatus,
    ToolApprovalPolicy,
    approval_required,
    build_turn_prompt,
    context_edit_notice,
    excerpt,
    interpret_agent_text,
    text_delta,
    tool_call_finished,
    tool_call_started,
    tool_call_summary,
)
from forgeloop.domain.projects import ProjectEntry
from forgeloop.graph.session_runtime import SessionProcessPool
from forgeloop.records.conversations import ConversationStore, SessionRecord

CHAT_ROLE = "chat"
"""PI 会话文件里的角色名：面板轮次与开发/审查角色的轨迹分开落盘。"""

STREAM_FLUSH_SECONDS = 0.3
"""流式落库节流：最多每 300 毫秒写一次（人眼够快，SQLite 不被打爆）。"""

STREAM_FLUSH_CHARS = 200
"""或累计到 200 个新字符就写一次（长输出不会等到节流窗口才可见）。"""

REAPER_INTERVAL_SECONDS = 5.0
"""空闲进程回收的检查间隔。"""


@dataclass(frozen=True)
class TurnTicket:
    """一次被受理的轮次：会话身份、轮次序号与是否排队等待并发额度。"""

    session_id: str
    turn_count: int
    queued: bool


@dataclass(frozen=True)
class TerminateResult:
    """终止结果：会话是否由此转为终态，以及是否真的中止了一个在跑的轮次。"""

    terminated: bool
    aborted: bool


@dataclass(frozen=True)
class TurnOutcome:
    """一轮 PI 调用的原始结果（未解释）：文本、失败原因与是否被中止。"""

    text: str
    error: str
    aborted: bool


@dataclass(frozen=True)
class TurnRun:
    """一轮执行的完整事实：原始结果 + 流式落库情况（轮末据此决定补写什么）。"""

    outcome: TurnOutcome
    streamed: bool
    last_message_id: int | None


class TurnStreamWriter:
    """把一轮里的增量事件写进记录：文本流式落库、工具留痕、压缩计数。

    写库发生在回调路径上（PI 读到事件就回调），因此每次写入都尽量小：文本按节流合并，
    工具与压缩事件各写一次。
    """

    def __init__(
        self,
        store: ConversationStore,
        session_id: str,
        *,
        policy: ToolApprovalPolicy,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._session_id = session_id
        self._policy = policy
        self._now = now
        self._message_id: int | None = None
        self._last_message_id: int | None = None
        self._streamed = False
        self._buffer = ""
        self._flushed = 0
        self._last_flush = 0.0
        self.compactions = 0
        self.tool_calls = 0
        self.approvals_required = 0

    @property
    def streamed(self) -> bool:
        """这一轮是否已经通过流式落库写出过助手消息（轮末据此避免重复追加）。"""

        return self._streamed

    @property
    def last_message_id(self) -> int | None:
        """最后一行的身份：HITL 时用它把原始输出改写成给人看的问题。"""

        return self._last_message_id

    def on_event(self, event: PIEvent) -> None:
        """事件分派：文本增量、工具调用、上下文编辑各走各的；其余事件忽略。"""

        if event.type == "message_update":
            self._append_delta(text_delta(event.payload))
        elif event.type == "message_end":
            self._finish_assistant_message(event.payload)
        elif event.type == "tool_execution_start":
            self._tool_started(event.payload)
        elif event.type == "tool_execution_end":
            self._tool_finished(event.payload)
        elif event.type == "entry_appended":
            self._context_edit(event.payload)

    def finish(self, state: MessageState = MessageState.OK) -> str:
        """轮末收尾：落定最后一段文本与消息状态，返回最后一条助手消息的文本。"""

        self._flush(force=True)
        if self._message_id is not None:
            self._store.update_message(self._message_id, content=self._buffer, state=state)
            self._last_message_id = self._message_id
            self._message_id = None
        return self._buffer

    def _append_delta(self, delta: str) -> None:
        if not delta:
            return
        if self._message_id is None:
            started = self._store.start_streaming_message(self._session_id)
            self._message_id = started.message_id
            self._last_message_id = started.message_id
            self._streamed = True
            self._last_flush = self._now()
        self._buffer += delta
        # 第一条内容立刻落库：否则要等到节流窗口或 200 字符，人在面板上会一直看到空白。
        if self._flushed == 0 or (
            self._now() - self._last_flush >= STREAM_FLUSH_SECONDS
            or len(self._buffer) - self._flushed >= STREAM_FLUSH_CHARS
        ):
            self._flush()

    def _flush(self, *, force: bool = False) -> None:
        if self._message_id is None:
            return
        if not force and len(self._buffer) == self._flushed:
            return
        self._store.update_message(
            self._message_id, content=self._buffer, state=MessageState.STREAMING
        )
        self._flushed = len(self._buffer)
        self._last_flush = self._now()

    def _finish_assistant_message(self, payload: Mapping[str, object]) -> None:
        """一条助手消息结束时落定它：下一条助手消息另起一行（工具调用会插在中间）。"""

        message = payload.get("message")
        if not isinstance(message, Mapping) or message.get("role") != "assistant":
            return
        self._finish_current()

    def _finish_current(self) -> None:
        if self._message_id is None:
            return
        self._store.update_message(self._message_id, content=self._buffer, state=MessageState.OK)
        self._last_message_id = self._message_id
        self._message_id = None
        self._buffer = ""
        self._flushed = 0

    def _tool_started(self, payload: Mapping[str, object]) -> None:
        started = tool_call_started(payload)
        if started is None:
            return
        needs = approval_required(started.risk, self._policy)
        self._store.record_tool_start(
            self._session_id,
            tool_call_id=started.tool_call_id,
            tool_name=started.tool_name,
            args_excerpt=started.args_excerpt,
            risk=started.risk.value,
            requires_approval=needs,
        )
        self.tool_calls += 1
        if needs:
            self.approvals_required += 1

    def _tool_finished(self, payload: Mapping[str, object]) -> None:
        finished = tool_call_finished(payload)
        if finished is None:
            return
        self._store.record_tool_end(
            self._session_id,
            tool_call_id=finished.tool_call_id,
            result_excerpt=excerpt(finished.result_excerpt, TOOL_RESULT_CHARS_MAX),
            is_error=finished.is_error,
            duration_ms=finished.duration_ms,
        )

    def _context_edit(self, payload: Mapping[str, object]) -> None:
        notice = context_edit_notice(payload)
        if not notice:
            return
        self.compactions += 1
        self._store.note_compaction(self._session_id)
        self._store.append_message(self._session_id, role=MessageRole.SYSTEM, content=notice)


class ConversationRunner:
    """面板会话的执行器：受理轮次、驱动 PI、登记待人工决定、支持终止与停机。"""

    def __init__(
        self,
        *,
        records_path: Path,
        session_root: Path,
        projects: Callable[[], Mapping[str, ProjectEntry]],
        readiness: Callable[[ProjectEntry], tuple[str, ...]],
        concurrency: int,
        turn_timeout_seconds: int,
        tool_approval: ToolApprovalPolicy = ToolApprovalPolicy.WRITE,
        session_idle_seconds: float = 900.0,
        max_live_sessions: int = 4,
        pi_factory: Callable[[ProjectEntry, str, Callable[[PIEvent], None]], PIProcess]
        | None = None,
    ) -> None:
        self._records_path = records_path
        self._session_root = session_root
        self._projects = projects
        self._readiness = readiness
        self._turn_timeout_seconds = turn_timeout_seconds
        self._concurrency = concurrency
        self._tool_approval = tool_approval
        self._pi_factory = pi_factory or self._spawn_pi
        self._pool = ThreadPoolExecutor(
            max_workers=concurrency, thread_name_prefix="forgeloop-panel"
        )
        self._lock = threading.Lock()
        self._running: set[str] = set()
        self._queued: set[str] = set()
        self._writers: dict[str, TurnStreamWriter] = {}
        self._closed = False
        self._sessions = SessionProcessPool(
            self._session_process,
            idle_seconds=session_idle_seconds,
            max_live=max_live_sessions,
        )
        self._reaper_stop = threading.Event()
        self._reaper = threading.Thread(
            target=self._reap_loop, name="forgeloop-panel-reaper", daemon=True
        )
        self._reaper.start()

    # ---- 受理与终止 ----------------------------------------------------------

    def start_turn(self, session_id: str, text: str, by: str) -> TurnTicket:
        """受理一轮人工输入：先落人工消息，再把执行交给线程池（HTTP 立即返回）。"""

        store = ConversationStore(self._records_path)
        try:
            self._require_live_session(store, session_id)
            store.append_message(session_id, role=MessageRole.HUMAN, content=text, author=by)
            store.start_turn(session_id)
            store.set_status(session_id, SessionStatus.ACTIVE)
            refreshed = store.get_session(session_id)
            assert refreshed is not None
        finally:
            store.close()
        with self._lock:
            if self._closed:
                raise ConversationError("会话执行器已停止，不再受理新轮次")
            queued = len(self._running) >= self._concurrency
            self._queued.add(session_id)
        self._pool.submit(self._execute, session_id, text)
        return TurnTicket(session_id=session_id, turn_count=refreshed.turn_count, queued=queued)

    def terminate(self, session_id: str, *, by: str, reason: str) -> TerminateResult:
        """终止会话：先写终态，再中止在跑的轮次并收起常驻进程。"""

        store = ConversationStore(self._records_path)
        try:
            terminated = store.terminate(session_id, by=by, reason=reason)
        finally:
            store.close()
        aborted = self._sessions.abort(session_id)
        self._sessions.release(session_id, keep=False)
        return TerminateResult(terminated=terminated, aborted=aborted)

    def is_running(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._running or session_id in self._queued

    def status(self) -> dict[str, object]:
        """运行时就绪与占用：面板「Agent Runtime」一栏的权威数字。"""

        with self._lock:
            running = sorted(self._running)
            queued = sorted(self._queued)
        live = self._sessions.status()
        return {
            "concurrency": self._concurrency,
            "turn_timeout_seconds": self._turn_timeout_seconds,
            "tool_approval": self._tool_approval.value,
            "running_turns": len(running),
            "queued_turns": len(queued),
            "running_sessions": running,
            "queued_sessions": queued,
            "live_sessions": len(live),
            "live": [
                {
                    "session_id": item.session_id,
                    "pid": item.pid,
                    "turns": item.turns,
                    "cold_starts": item.cold_starts,
                    "idle_seconds": round(item.idle_seconds, 1),
                    "started_at": item.started_at,
                    "busy": item.busy,
                }
                for item in live
            ],
        }

    def shutdown(self) -> None:
        """停机：停止回收线程、中止常驻进程并收起线程池。"""

        with self._lock:
            self._closed = True
        self._reaper_stop.set()
        self._sessions.shutdown()
        self._pool.shutdown(wait=False, cancel_futures=True)

    def reap_idle_sessions(self) -> tuple[str, ...]:
        """回收空闲超时的常驻进程，返回被回收的会话身份（回收线程与测试共用）。"""

        return self._sessions.reap()

    def _reap_loop(self) -> None:
        while not self._reaper_stop.wait(REAPER_INTERVAL_SECONDS):
            try:
                self.reap_idle_sessions()
            except Exception:
                continue  # 回收失败不能拖垮常驻进程：下一拍再试

    # ---- 一轮执行 ------------------------------------------------------------

    def _execute(self, session_id: str, text: str) -> None:
        with self._lock:
            self._queued.discard(session_id)
            self._running.add(session_id)
        store = ConversationStore(self._records_path)
        try:
            session = store.get_session(session_id)
            if session is None or session.status not in LIVE_SESSION_STATUSES:
                return  # 受理后已被终止：不再执行，也不改状态
            entry = self._projects().get(session.project)
            if entry is None:
                self._record_failure(store, session, "项目已不在项目档案里")
                return
            problems = self._readiness(entry)
            if problems:
                self._record_failure(store, session, "；".join(problems))
                return
            slot, process, cold = self._sessions.acquire(session_id)
            slot.mark_busy(True)
            try:
                run = self._invoke(store, session, entry, process, cold, text)
            finally:
                slot.touch()
                self._sessions.release(session_id, keep=True)
            self._record_outcome(store, session, run)
        except Exception as error:
            # 兜底：线程池会吞掉异常，任何未预期错误都必须留下可见记录，不能静默消失。
            self._record_failure(store, session_id, f"内部错误：{error}")
        finally:
            store.close()
            with self._lock:
                self._running.discard(session_id)

    def _invoke(
        self,
        store: ConversationStore,
        session: SessionRecord,
        entry: ProjectEntry,
        process: PIProcess,
        cold: bool,
        text: str,
    ) -> TurnRun:
        """真正跑一轮：发提示词、等 settled，并全程增量落库。"""

        writer = TurnStreamWriter(store, session.session_id, policy=self._tool_approval)
        with self._lock:
            self._writers[session.session_id] = writer
        store.update_last_human_context_mode(session.session_id, "cold" if cold else "warm")
        history = (
            store.recent_messages(session.session_id, limit=HISTORY_MESSAGES_MAX) if cold else ()
        )
        try:
            process.send_prompt(
                build_turn_prompt(
                    project=entry.name,
                    project_path=entry.path,
                    title=session.title,
                    history=history,
                    instruction=text,
                    continuation=not cold,
                )
            )
            result = process.wait_until_settled(self._turn_timeout_seconds)
        finally:
            with self._lock:
                self._writers.pop(session.session_id, None)
            writer.finish()
        return TurnRun(
            outcome=_outcome_of(result),
            streamed=writer.streamed,
            last_message_id=writer.last_message_id,
        )

    def _record_outcome(
        self, store: ConversationStore, session: SessionRecord, run: TurnRun
    ) -> None:
        """把一轮结果落成消息与状态：失败、HITL 请求与工具审批都停在「待人工决定」。

        流式已经写出的助手文本不再重复追加（同一段话只应出现在流水里一次）；HITL 时把
        那一行改写成给人看的问题——原始 JSON 仍在 PI 的事件文件里，供回查。
        """

        outcome = run.outcome
        current = store.get_session(session.session_id)
        if current is None:
            return
        if current.status is SessionStatus.TERMINATED or outcome.aborted:
            # 终止事实优先：终止会关掉常驻进程，正在收尾的那一轮可能看到 EOF 而不是
            # abort 回执；这里统一按「被人工终止」留痕，不把它记成执行失败。
            store.append_message(
                session.session_id, role=MessageRole.SYSTEM, content="本轮已被人工终止。"
            )
            return
        if outcome.error:
            self._record_failure(store, session, outcome.error)
            return
        reply = interpret_agent_text(outcome.text)
        if not reply.reply and not reply.awaiting_human:
            self._record_failure(store, session, "Agent 既没有回复文本，也没有请求人工决定")
            return
        if reply.awaiting_human:
            if run.last_message_id is not None:
                store.update_message(run.last_message_id, content=reply.question)
            else:
                store.append_message(
                    session.session_id, role=MessageRole.AGENT, content=reply.question
                )
            self._await_human(
                store, session.session_id, kind=DecisionKind.AGENT_REQUEST, question=reply.question
            )
        elif not run.streamed:
            # 没有流式落库（例如协议没给增量）时补写一条，避免回复只存在于结果文本里。
            store.append_message(session.session_id, role=MessageRole.AGENT, content=reply.reply)
        self._tool_review_gate(store, session.session_id)

    def _tool_review_gate(self, store: ConversationStore, session_id: str) -> None:
        """轮次边界的人工审批闸门：本轮跑过需确认的工具就停下等人。

        文案必须说清两点，否则人会以为工具还没跑：① 哪些工具已经跑过；② 这道闸门是
        「下一步之前确认」，不是「执行前拦截」——协议没有执行前审批。
        """

        pending = [
            item
            for item in store.list_tool_calls(session_id)
            if item.requires_approval and item.approval_status == "pending"
        ]
        if not pending:
            return
        lines = [tool_call_summary(item.tool_name, item.args_excerpt) for item in pending[:5]]
        more = f"，另有 {len(pending) - 5} 次" if len(pending) > 5 else ""
        question = (
            f"本轮执行了 {len(pending)} 次需要人工确认的工具：\n- "
            + "\n- ".join(lines)
            + more
            + "\nPI 在轮次内自行执行工具，本审批发生在轮次边界（协议没有执行前拦截）。"
            "批准=继续下一步，拒绝=终止会话。"
        )
        self._await_human(store, session_id, kind=DecisionKind.TOOL_REVIEW, question=question)

    def _record_failure(
        self, store: ConversationStore, session: SessionRecord | str, reason: str
    ) -> None:
        """失败即停在待人工决定：批准=重试这一轮，拒绝=终止会话（不自动重试）。"""

        session_id = session if isinstance(session, str) else session.session_id
        current = store.get_session(session_id)
        if current is None:
            return
        if current.status not in LIVE_SESSION_STATUSES:
            # 已被人工终止：终止事实优先，不再登记新的待决定；但这一轮必须留下终止留痕
            # ——终止会关掉常驻进程，收尾的那一轮看到的可能是 EOF 而不是 abort 回执。
            store.append_message(session_id, role=MessageRole.SYSTEM, content="本轮已被人工终止。")
            return
        store.append_message(
            session_id,
            role=MessageRole.SYSTEM,
            content=f"本轮未取得结果：{reason}",
            state=MessageState.ERROR,
        )
        self._await_human(
            store,
            session_id,
            kind=DecisionKind.TURN_FAILED,
            question=f"本轮未取得结果：{reason}。批准=重试本轮，拒绝=终止会话。",
            last_error=reason,
        )

    def _await_human(
        self,
        store: ConversationStore,
        session_id: str,
        *,
        kind: DecisionKind,
        question: str,
        last_error: str = "",
    ) -> None:
        """登记待人工决定并把会话停在等待态；并发终止时以终止为准。"""

        store.open_decision(session_id, kind=kind, question=question)
        try:
            store.set_status(session_id, SessionStatus.AWAITING_HUMAN, last_error=last_error)
        except ConversationError:
            return  # 判定与写入之间被并发终止：状态以终止为准，上面的记录保留为事实

    # ---- 依赖装配 ------------------------------------------------------------

    def _session_process(self, session_id: str) -> PIProcess:
        """按会话身份启动 PI 子进程：工作目录与隔离 HOME 来自**取用当刻**的项目档案。

        事件回调按会话绑定：替身进程工厂拿到同一个回调，因此单元层也能用真事件驱动
        流式落库与工具留痕，而不是只测「函数被调用过」。
        """

        store = ConversationStore(self._records_path)
        try:
            session = store.get_session(session_id)
        finally:
            store.close()
        if session is None:
            raise ConversationError(f"会话不存在: {session_id}")
        entry = self._projects().get(session.project)
        if entry is None:
            raise ConversationError(f"项目已不在项目档案里: {session.project}")
        return self._pi_factory(entry, session_id, self._event_sink(session_id))

    def _spawn_pi(
        self, entry: ProjectEntry, session_id: str, on_event: Callable[[PIEvent], None]
    ) -> PIProcess:
        """启动 PI 子进程：工作目录固定为项目路径，HOME 指向该项目的隔离目录。"""

        return PIProcess(
            entry.pi_command,
            session_id,
            CHAT_ROLE,
            self._session_root / session_id,
            PISpawnOptions(
                extra_env={"HOME": entry.pi_home},
                cwd=Path(entry.path),
                execution_environment="host",
            ),
            on_event=on_event,
        )

    def _event_sink(self, session_id: str) -> Callable[[PIEvent], None]:
        """事件回调：绑定到该会话当前这一轮的流式写入器。

        回调由 PIProcess 在读取线程上调用；没有登记写入器时（例如进程残留事件）忽略，
        而不是写进来路不明的记录。
        """

        def sink(event: PIEvent) -> None:
            with self._lock:
                writer = self._writers.get(session_id)
            if writer is not None:
                writer.on_event(event)

        return sink

    def _require_live_session(self, store: ConversationStore, session_id: str) -> SessionRecord:
        session = store.get_session(session_id)
        if session is None:
            raise ConversationError(f"会话不存在: {session_id}")
        pending = store.pending_decision(session_id)
        if session.status not in LIVE_SESSION_STATUSES:
            raise ConversationError("会话已终止，不能再发消息")
        if pending is not None:
            raise ConversationError("有未处理的待人工决定；先批准或拒绝它")
        if self.is_running(session_id):
            raise ConversationError("上一轮还在执行；可等待完成或先终止会话")
        return session


def _outcome_of(result: PIInvocationResult) -> TurnOutcome:
    """把 PI 的调用结果翻译成「文本 / 失败原因 / 被中止」，不吞掉任何不确定。"""

    if result.aborted:
        return TurnOutcome(text=result.text or "", error="", aborted=True)
    # 空串按「没有错误」处理：真实适配器在 provider 失败时给的是 model_error，
    # 若把空 error 当成错误，模型错误的真实原因会被一个空标签盖掉。
    if result.error:
        return TurnOutcome(text="", error=f"PI {result.error}", aborted=False)
    if result.model_error:
        return TurnOutcome(text="", error=f"模型错误：{result.model_error}", aborted=False)
    return TurnOutcome(text=result.text or "", error="", aborted=False)
