"""面板会话记录：会话、消息与「待人工决定」三张表（架构 §6 持久化与记录）。

职责边界：

- **过程事实，不是第二套研发业务状态**：这里只记录「人在页面上与执行器对话」的过程
  ——谁在什么时候说了什么、Agent 回了什么、哪一步需要人工决定以及人工怎么决定的。
  需求、任务、批准、失败轮次、验收与停止仍以既有表为准；面板不因为一次对话改写任何
  研发工作项状态，也不据此放行任何交付动作。
- **状态迁移的唯一入口**：会话状态只经本模块写；终态（终止/失败）一旦落下就不再被
  后续轮次改回进行中——这是「终止」能在并发下真正生效的判定点。
- **决定幂等**：同一会话同一种待人工决定只登记一条（重复请求返回既有记录）；同一条
  决定重复作出且结论一致时返回既有结果，结论不同则显式失败，不覆盖已作出的决定。

三张表与 ``RecordStore`` 同库（``records.sqlite``）：同一份权威记录、同一份备份。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.conversation import (
    LIVE_SESSION_STATUSES,
    ConversationError,
    DecisionKind,
    DecisionStatus,
    MessageRole,
    MessageState,
    SessionStatus,
    new_decision_id,
    new_session_id,
    validate_title,
)
from forgeloop.domain.conversation import (
    validate_message as validate_message_text,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS panel_sessions (
    session_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '',
    turn_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    terminated_at TEXT,
    terminated_by TEXT NOT NULL DEFAULT '',
    terminate_reason TEXT NOT NULL DEFAULT '',
    -- PI 的自动压缩次数（上下文编辑事件）：只计数，本会话的流水一条都不删。
    compaction_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS panel_sessions_by_project ON panel_sessions (project, updated_at);
CREATE TABLE IF NOT EXISTS panel_messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    -- 轮次的上下文模式：cold=回放了历史（新进程），warm=发给仍在运行的同一进程。
    context_mode TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS panel_messages_by_session ON panel_messages (session_id, message_id);
CREATE TABLE IF NOT EXISTS panel_decisions (
    decision_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS panel_decisions_by_session ON panel_decisions (session_id, created_at);
CREATE TABLE IF NOT EXISTS panel_tool_calls (
    -- 主键含会话身份：PI 的 toolCallId 只在一次会话内唯一（两个会话各跑一次 bash
    -- 都会给出同名 id），用全局主键会让后一条把前一条的归属覆盖掉。
    tool_call_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_excerpt TEXT NOT NULL DEFAULT '',
    result_excerpt TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approval_status TEXT NOT NULL DEFAULT 'none',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    PRIMARY KEY (session_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS panel_tool_calls_by_session
    ON panel_tool_calls (session_id, started_at);
"""


@dataclass(frozen=True)
class SessionRecord:
    """一个面板会话：身份、目标项目、标题、状态与终止事实。"""

    session_id: str
    project: str
    title: str
    status: SessionStatus
    created_at: str
    created_by: str
    updated_at: str
    cwd: str
    turn_count: int
    last_error: str
    terminated_at: str | None
    terminated_by: str
    terminate_reason: str
    compaction_count: int = 0
    message_count: int = 0
    pending_decisions: int = 0


@dataclass(frozen=True)
class MessageRecord:
    """一条会话消息：人工、Agent 或系统（失败与状态说明）。

    ``state == streaming`` 表示这一条正在被增量写入：同一条消息会被反复更新，
    直到本轮结束落成 ``ok``（或失败时的 ``error``）。
    """

    message_id: int
    session_id: str
    role: MessageRole
    content: str
    state: MessageState
    created_at: str
    author: str
    context_mode: str = ""


@dataclass(frozen=True)
class ToolCallRecord:
    """一次工具调用的事实：名字、参数与结果摘要、风险、状态与审批状态。"""

    tool_call_id: str
    session_id: str
    tool_name: str
    args_excerpt: str
    result_excerpt: str
    risk: str
    status: str
    duration_ms: int
    requires_approval: bool
    approval_status: str
    started_at: str
    ended_at: str | None


@dataclass(frozen=True)
class DecisionRecord:
    """一条待人工决定：Agent 主动请求，或一轮失败后需要人工判断下一步。"""

    decision_id: str
    session_id: str
    kind: DecisionKind
    question: str
    status: DecisionStatus
    created_at: str
    decided_at: str | None
    decided_by: str
    reason: str


def _now() -> datetime:
    return datetime.now(UTC)


class ConversationStore:
    """面板会话记录（与 ``RecordStore`` 同库的独立记录集）。"""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        # 与既有记录库同样的等待口径：两个连接争用时等锁，而不是立刻报错。
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """为旧库补列：``CREATE TABLE IF NOT EXISTS`` 不会给已存在的表加列。"""

        columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(panel_sessions)")}
        if "compaction_count" not in columns:
            self._db.execute(
                "ALTER TABLE panel_sessions ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0"
            )
        self._migrate_tool_calls()

    def _migrate_tool_calls(self) -> None:
        """把早期单列主键的工具表重建成 ``(session_id, tool_call_id)`` 复合主键。

        本表在本批次引入、尚未随版本发布，但仍然处理旧现场：这是开发机上真实存在的
        表形状，重建比让它在跨会话时静默丢行便宜。
        """

        info = self._db.execute("PRAGMA table_info(panel_tool_calls)").fetchall()
        if not info:
            return
        # 主键列按 pk 序号排序读：PRAGMA 按列顺序返回，主键声明顺序要另看 pk 字段。
        primary_key = [
            str(row[1])
            for row in sorted((row for row in info if int(row[5]) > 0), key=lambda row: int(row[5]))
        ]
        if primary_key == ["session_id", "tool_call_id"]:
            return  # 已经是复合主键：迁移幂等，重复打开不会反复重建
        # 不用 _write_transaction：executescript 会隐式提交，套在显式事务里会在 commit
        # 时报「no transaction is active」。这里逐条执行并显式提交，语义同样是一次性。
        self._db.execute("ALTER TABLE panel_tool_calls RENAME TO panel_tool_calls_old")
        self._db.executescript(SCHEMA)
        self._db.execute(
            "INSERT OR IGNORE INTO panel_tool_calls (tool_call_id, session_id, tool_name,"
            " args_excerpt, result_excerpt, risk, status, duration_ms, requires_approval,"
            " approval_status, started_at, ended_at)"
            " SELECT tool_call_id, session_id, tool_name, args_excerpt, result_excerpt, risk,"
            " status, duration_ms, requires_approval, approval_status, started_at, ended_at"
            " FROM panel_tool_calls_old"
        )
        self._db.execute("DROP TABLE panel_tool_calls_old")
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    @contextmanager
    def _write_transaction(self) -> Generator[None]:
        """显式写事务：判定与写入要么整体提交，要么整体回滚。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    # ---- 会话 ----------------------------------------------------------------

    def create_session(
        self,
        *,
        project: str,
        title: str,
        by: str,
        cwd: str = "",
        moment: datetime | None = None,
    ) -> SessionRecord:
        """新建会话：项目名与标题必填；身份由时间戳与随机后缀生成。"""

        stamp = _now() if moment is None else moment
        if not project.strip():
            raise ConversationError("新建会话必须指定项目")
        session_id = new_session_id(stamp)
        iso = stamp.isoformat()
        with self._write_transaction():
            self._db.execute(
                "INSERT INTO panel_sessions (session_id, project, title, status, created_at,"
                " created_by, updated_at, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    project.strip(),
                    validate_title(title),
                    SessionStatus.ACTIVE.value,
                    iso,
                    by.strip(),
                    iso,
                    cwd,
                ),
            )
        session = self.get_session(session_id)
        assert session is not None  # 刚写入且在同一事务外读取，缺失即为记录层故障
        return session

    def get_session(self, session_id: str) -> SessionRecord | None:
        row = self._db.execute(
            f"SELECT {_SESSION_COLUMNS}, {_SESSION_COUNTS} FROM panel_sessions s WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return None if row is None else _session(row)

    def list_sessions(self, *, limit: int = 50) -> tuple[SessionRecord, ...]:
        rows = self._db.execute(
            f"SELECT {_SESSION_COLUMNS}, {_SESSION_COUNTS} FROM panel_sessions s"
            " ORDER BY s.updated_at DESC, s.session_id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return tuple(_session(row) for row in rows)

    def live_session_ids(self, project: str) -> tuple[str, ...]:
        """该项目下仍在进行（未终止、未失败）的会话：删除项目前的占用检查。"""

        placeholders = ", ".join("?" for _ in LIVE_SESSION_STATUSES)
        rows = self._db.execute(
            "SELECT session_id FROM panel_sessions WHERE project = ?"
            f" AND status IN ({placeholders}) ORDER BY session_id",
            (project, *(status.value for status in LIVE_SESSION_STATUSES)),
        ).fetchall()
        return tuple(str(row[0]) for row in rows)

    def set_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        last_error: str = "",
        moment: datetime | None = None,
    ) -> SessionRecord:
        """写会话状态：终态不可被后续轮次改回进行中（终止生效的判定点）。"""

        current = self.get_session(session_id)
        if current is None:
            raise ConversationError(f"会话不存在: {session_id}")
        if current.status not in LIVE_SESSION_STATUSES and status in LIVE_SESSION_STATUSES:
            raise ConversationError(
                f"会话 {session_id} 已{_status_text(current.status)}，不能回到{_status_text(status)}"
            )
        stamp = _now() if moment is None else moment
        fields = ["status = ?", "updated_at = ?"]
        values: list[object] = [status.value, stamp.isoformat()]
        if last_error:
            fields.append("last_error = ?")
            values.append(last_error)
        values.append(session_id)
        with self._write_transaction():
            self._db.execute(
                f"UPDATE panel_sessions SET {', '.join(fields)} WHERE session_id = ?", values
            )
        refreshed = self.get_session(session_id)
        assert refreshed is not None
        return refreshed

    def start_turn(self, session_id: str, *, moment: datetime | None = None) -> None:
        """登记一轮开始：轮次计数 +1，并刷新会话的更新时间。"""

        stamp = _now() if moment is None else moment
        with self._write_transaction():
            self._db.execute(
                "UPDATE panel_sessions SET turn_count = turn_count + 1, updated_at = ?"
                " WHERE session_id = ?",
                (stamp.isoformat(), session_id),
            )

    def terminate(
        self, session_id: str, *, by: str, reason: str, moment: datetime | None = None
    ) -> bool:
        """终止会话：已经终止时返回 ``False``（幂等），不改写首次的终止事实。"""

        current = self.get_session(session_id)
        if current is None:
            raise ConversationError(f"会话不存在: {session_id}")
        if current.status is SessionStatus.TERMINATED:
            return False
        stamp = _now() if moment is None else moment
        with self._write_transaction():
            self._db.execute(
                "UPDATE panel_sessions SET status = ?, updated_at = ?, terminated_at = ?,"
                " terminated_by = ?, terminate_reason = ? WHERE session_id = ?",
                (
                    SessionStatus.TERMINATED.value,
                    stamp.isoformat(),
                    stamp.isoformat(),
                    by.strip(),
                    reason.strip(),
                    session_id,
                ),
            )
        return True

    # ---- 消息 ----------------------------------------------------------------

    def append_message(
        self,
        session_id: str,
        *,
        role: MessageRole,
        content: str,
        state: MessageState = MessageState.OK,
        author: str = "",
        context_mode: str = "",
        moment: datetime | None = None,
    ) -> MessageRecord:
        """追加一条消息；人工消息走同一份校验（非空、长度受限）。"""

        body = validate_message_text(content) if role is MessageRole.HUMAN else content
        stamp = _now() if moment is None else moment
        with self._write_transaction():
            cursor = self._db.execute(
                "INSERT INTO panel_messages (session_id, role, content, state, created_at, author,"
                " context_mode) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    role.value,
                    body,
                    state.value,
                    stamp.isoformat(),
                    author.strip(),
                    context_mode,
                ),
            )
            self._db.execute(
                "UPDATE panel_sessions SET updated_at = ? WHERE session_id = ?",
                (stamp.isoformat(), session_id),
            )
        return MessageRecord(
            message_id=int(cursor.lastrowid or 0),
            session_id=session_id,
            role=role,
            content=body,
            state=state,
            created_at=stamp.isoformat(),
            author=author.strip(),
            context_mode=context_mode,
        )

    def list_messages(self, session_id: str, *, limit: int = 200) -> tuple[MessageRecord, ...]:
        rows = self._db.execute(
            "SELECT message_id, session_id, role, content, state, created_at, author, context_mode"
            " FROM panel_messages WHERE session_id = ? ORDER BY message_id LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return tuple(
            MessageRecord(
                message_id=int(row[0]),
                session_id=str(row[1]),
                role=MessageRole(row[2]),
                content=str(row[3]),
                state=MessageState(row[4]),
                created_at=str(row[5]),
                author=str(row[6]),
                context_mode=str(row[7]),
            )
            for row in rows
        )

    def recent_messages(
        self, session_id: str, *, limit: int
    ) -> tuple[tuple[MessageRole, str], ...]:
        """最近 N 条消息（最旧在前）：单轮调用没有服务端会话，历史要回放进提示词。"""

        rows = self._db.execute(
            "SELECT role, content FROM panel_messages WHERE session_id = ?"
            " ORDER BY message_id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return tuple((MessageRole(row[0]), str(row[1])) for row in reversed(rows))

    def start_streaming_message(
        self, session_id: str, *, moment: datetime | None = None
    ) -> MessageRecord:
        """先落一条空的 Agent 消息（``state=streaming``），随后增量更新它。

        先建行再更新，而不是等整轮结束才写：这样人能在面板上看到「它正在说」，
        而记录里也只有一条消息（不会为每个增量塞一行）。
        """

        return self.append_message(
            session_id,
            role=MessageRole.AGENT,
            content="",
            state=MessageState.STREAMING,
            moment=moment,
        )

    def update_message(
        self,
        message_id: int,
        *,
        content: str | None = None,
        state: MessageState | None = None,
        moment: datetime | None = None,
    ) -> MessageRecord | None:
        """更新一条消息的正文与状态；消息不存在时返回 ``None``（不静默新建）。"""

        current = self.get_message(message_id)
        if current is None:
            return None
        fields: list[str] = []
        values: list[object] = []
        if content is not None:
            fields.append("content = ?")
            values.append(content)
        if state is not None:
            fields.append("state = ?")
            values.append(state.value)
        if not fields:
            return current
        values.append(message_id)
        with self._write_transaction():
            self._db.execute(
                f"UPDATE panel_messages SET {', '.join(fields)} WHERE message_id = ?", values
            )
            self._db.execute(
                "UPDATE panel_sessions SET updated_at = ? WHERE session_id = ?",
                ((_now() if moment is None else moment).isoformat(), current.session_id),
            )
        return self.get_message(message_id)

    def get_message(self, message_id: int) -> MessageRecord | None:
        row = self._db.execute(
            "SELECT message_id, session_id, role, content, state, created_at, author, context_mode"
            " FROM panel_messages WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        if row is None:
            return None
        return MessageRecord(
            message_id=int(row[0]),
            session_id=str(row[1]),
            role=MessageRole(row[2]),
            content=str(row[3]),
            state=MessageState(row[4]),
            created_at=str(row[5]),
            author=str(row[6]),
            context_mode=str(row[7]),
        )

    def update_last_human_context_mode(self, session_id: str, mode: str) -> None:
        """把该会话最近一条人工消息的上下文模式写成 ``cold`` 或 ``warm``。

        模式只有真正发车时才知道（进程可能在排队期间退出），因此先落人工消息、发车前
        再补写，而不是在受理时猜一个值。
        """

        with self._write_transaction():
            self._db.execute(
                "UPDATE panel_messages SET context_mode = ? WHERE message_id ="
                " (SELECT MAX(message_id) FROM panel_messages WHERE session_id = ?"
                "  AND role = 'human')",
                (mode, session_id),
            )

    # ---- 工具调用与上下文压缩 ------------------------------------------------

    def record_tool_start(
        self,
        session_id: str,
        *,
        tool_call_id: str,
        tool_name: str,
        args_excerpt: str,
        risk: str,
        requires_approval: bool,
        moment: datetime | None = None,
    ) -> None:
        """登记一次工具调用开始：``status=running``，``ended_at`` 为空。

        同一个会话内重复的 ``tool_call_id`` 只更新一次事实（幂等）：重放或重复事件不会
        造出两条记录，也不会把已经结束的那条打回 running；**不同会话的同名 id 各记一行**
        （PI 的 ``toolCallId`` 只在一次会话内唯一）。``approval_status`` 只在
        需要人工确认时才是 ``pending``——只读工具直接记 ``none``，面板不会误标待批。
        """

        stamp = _now() if moment is None else moment
        with self._write_transaction():
            self._db.execute(
                "INSERT INTO panel_tool_calls (tool_call_id, session_id, tool_name, args_excerpt,"
                " risk, status, requires_approval, approval_status, started_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(session_id, tool_call_id) DO UPDATE SET"
                " args_excerpt = excluded.args_excerpt,"
                " risk = excluded.risk,"
                " requires_approval = MAX(panel_tool_calls.requires_approval,"
                " excluded.requires_approval)",
                (
                    tool_call_id,
                    session_id,
                    tool_name,
                    args_excerpt,
                    risk,
                    "running",
                    1 if requires_approval else 0,
                    # 不需要确认的工具不挂「待审批」：否则面板会把只读调用也标成待批。
                    "pending" if requires_approval else "none",
                    stamp.isoformat(),
                ),
            )
            self._db.execute(
                "UPDATE panel_sessions SET updated_at = ? WHERE session_id = ?",
                (stamp.isoformat(), session_id),
            )

    def record_tool_end(
        self,
        session_id: str,
        *,
        tool_call_id: str,
        result_excerpt: str,
        is_error: bool,
        duration_ms: int,
        moment: datetime | None = None,
    ) -> None:
        """登记一次工具调用结束：写结果摘要、状态与耗时（未登记过的调用补一行）。"""

        stamp = _now() if moment is None else moment
        with self._write_transaction():
            cursor = self._db.execute(
                "UPDATE panel_tool_calls SET result_excerpt = ?, status = ?, duration_ms = ?,"
                " ended_at = ? WHERE session_id = ? AND tool_call_id = ?",
                (
                    result_excerpt,
                    "error" if is_error else "ok",
                    duration_ms,
                    stamp.isoformat(),
                    session_id,
                    tool_call_id,
                ),
            )
            if cursor.rowcount == 0:
                # 只收到结束事件（例如重启后接手）：补一行，不假装看见过开始。
                self._db.execute(
                    "INSERT INTO panel_tool_calls (tool_call_id, session_id, tool_name,"
                    " result_excerpt, risk, status, duration_ms, approval_status, started_at,"
                    " ended_at) VALUES (?, ?, '', ?, 'unknown', ?, ?, 'pending', ?, ?)",
                    (
                        tool_call_id,
                        session_id,
                        result_excerpt,
                        "error" if is_error else "ok",
                        duration_ms,
                        stamp.isoformat(),
                        stamp.isoformat(),
                    ),
                )
            self._db.execute(
                "UPDATE panel_sessions SET updated_at = ? WHERE session_id = ?",
                (stamp.isoformat(), session_id),
            )

    def list_tool_calls(self, session_id: str, *, limit: int = 200) -> tuple[ToolCallRecord, ...]:
        rows = self._db.execute(
            "SELECT tool_call_id, session_id, tool_name, args_excerpt, result_excerpt, risk,"
            " status, duration_ms, requires_approval, approval_status, started_at, ended_at"
            " FROM panel_tool_calls WHERE session_id = ? ORDER BY started_at, tool_call_id LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return tuple(
            ToolCallRecord(
                tool_call_id=str(row[0]),
                session_id=str(row[1]),
                tool_name=str(row[2]),
                args_excerpt=str(row[3]),
                result_excerpt=str(row[4]),
                risk=str(row[5]),
                status=str(row[6]),
                duration_ms=int(row[7]),
                requires_approval=bool(row[8]),
                approval_status=str(row[9]),
                started_at=str(row[10]),
                ended_at=None if row[11] is None else str(row[11]),
            )
            for row in rows
        )

    def mark_tool_approval(self, session_id: str, status: str) -> int:
        """把该会话所有待审工具标成批准或拒绝；返回受影响条数。"""

        with self._write_transaction():
            cursor = self._db.execute(
                "UPDATE panel_tool_calls SET approval_status = ?"
                " WHERE session_id = ? AND approval_status = 'pending'",
                (status, session_id),
            )
        return int(cursor.rowcount)

    def count_pending_tool_approvals(self, session_id: str) -> int:
        row = self._db.execute(
            "SELECT COUNT(*) FROM panel_tool_calls WHERE session_id = ?"
            " AND requires_approval = 1 AND approval_status = 'pending'",
            (session_id,),
        ).fetchone()
        return 0 if row is None else int(row[0])

    def note_compaction(self, session_id: str, *, moment: datetime | None = None) -> int:
        """记一次上下文压缩（PI 的 context_edit），返回累计次数。

        只计数：本模块的会话流水一条都不删——压缩发生在 PI 手里的上下文里，
        面板侧的记录始终是完整、只追加的。
        """

        stamp = _now() if moment is None else moment
        with self._write_transaction():
            self._db.execute(
                "UPDATE panel_sessions SET compaction_count = compaction_count + 1, updated_at = ?"
                " WHERE session_id = ?",
                (stamp.isoformat(), session_id),
            )
        session = self.get_session(session_id)
        return 0 if session is None else session.compaction_count

    # ---- 待人工决定 ----------------------------------------------------------

    def open_decision(
        self,
        session_id: str,
        *,
        kind: DecisionKind,
        question: str,
        moment: datetime | None = None,
    ) -> DecisionRecord:
        """登记一条待人工决定；同会话同类已有待决时返回既有记录（不重复登记）。"""

        existing = self.pending_decision(session_id)
        if existing is not None and existing.kind is kind:
            return existing
        stamp = _now() if moment is None else moment
        decision_id = new_decision_id(stamp)
        with self._write_transaction():
            self._db.execute(
                "INSERT INTO panel_decisions (decision_id, session_id, kind, question, status,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    decision_id,
                    session_id,
                    kind.value,
                    question.strip(),
                    DecisionStatus.PENDING.value,
                    stamp.isoformat(),
                ),
            )
        decision = self.get_decision(decision_id)
        assert decision is not None
        return decision

    def get_decision(self, decision_id: str) -> DecisionRecord | None:
        row = self._db.execute(
            "SELECT decision_id, session_id, kind, question, status, created_at, decided_at,"
            " decided_by, reason FROM panel_decisions WHERE decision_id = ?",
            (decision_id,),
        ).fetchone()
        return None if row is None else _decision(row)

    def list_decisions(self, session_id: str, *, limit: int = 100) -> tuple[DecisionRecord, ...]:
        rows = self._db.execute(
            "SELECT decision_id, session_id, kind, question, status, created_at, decided_at,"
            " decided_by, reason FROM panel_decisions WHERE session_id = ?"
            " ORDER BY created_at, decision_id LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return tuple(_decision(row) for row in rows)

    def pending_decision(self, session_id: str) -> DecisionRecord | None:
        row = self._db.execute(
            "SELECT decision_id, session_id, kind, question, status, created_at, decided_at,"
            " decided_by, reason FROM panel_decisions WHERE session_id = ? AND status = ?"
            " ORDER BY created_at, decision_id LIMIT 1",
            (session_id, DecisionStatus.PENDING.value),
        ).fetchone()
        return None if row is None else _decision(row)

    def resolve_decision(
        self,
        decision_id: str,
        *,
        status: DecisionStatus,
        by: str,
        reason: str,
        moment: datetime | None = None,
    ) -> DecisionRecord:
        """作出人工决定：结论一致时返回既有结果（幂等），结论不同即显式失败。"""

        current = self.get_decision(decision_id)
        if current is None:
            raise ConversationError(f"待人工决定不存在: {decision_id}")
        if current.status is not DecisionStatus.PENDING:
            if current.status is status:
                return current
            raise ConversationError(
                f"决定 {decision_id} 已作出（{current.status}），不能用 {status} 覆盖"
            )
        stamp = _now() if moment is None else moment
        with self._write_transaction():
            self._db.execute(
                "UPDATE panel_decisions SET status = ?, decided_at = ?, decided_by = ?, reason = ?"
                " WHERE decision_id = ? AND status = ?",
                (
                    status.value,
                    stamp.isoformat(),
                    by.strip(),
                    reason.strip(),
                    decision_id,
                    DecisionStatus.PENDING.value,
                ),
            )
        decided = self.get_decision(decision_id)
        assert decided is not None
        return decided


_SESSION_COLUMNS = (
    "s.session_id, s.project, s.title, s.status, s.created_at, s.created_by, s.updated_at,"
    " s.cwd, s.turn_count, s.last_error, s.terminated_at, s.terminated_by, s.terminate_reason,"
    " s.compaction_count"
)
_SESSION_COUNTS = (
    "(SELECT COUNT(*) FROM panel_messages m WHERE m.session_id = s.session_id) AS message_count,"
    " (SELECT COUNT(*) FROM panel_decisions d WHERE d.session_id = s.session_id"
    "  AND d.status = 'pending') AS pending_decisions"
)


def _status_text(status: SessionStatus) -> str:
    return {SessionStatus.TERMINATED: "终止"}.get(status, "进行中")


def _session(row: sqlite3.Row | tuple[object, ...]) -> SessionRecord:
    values = tuple(row)
    return SessionRecord(
        session_id=str(values[0]),
        project=str(values[1]),
        title=str(values[2]),
        status=SessionStatus(values[3]),
        created_at=str(values[4]),
        created_by=str(values[5]),
        updated_at=str(values[6]),
        cwd=str(values[7]),
        turn_count=int(values[8]),
        last_error=str(values[9]),
        terminated_at=None if values[10] is None else str(values[10]),
        terminated_by=str(values[11]),
        terminate_reason=str(values[12]),
        compaction_count=int(values[13]),
        message_count=int(values[14]),
        pending_decisions=int(values[15]),
    )


def _decision(row: sqlite3.Row | tuple[object, ...]) -> DecisionRecord:
    values = tuple(row)
    return DecisionRecord(
        decision_id=str(values[0]),
        session_id=str(values[1]),
        kind=DecisionKind(values[2]),
        question=str(values[3]),
        status=DecisionStatus(values[4]),
        created_at=str(values[5]),
        decided_at=None if values[6] is None else str(values[6]),
        decided_by=str(values[7]),
        reason=str(values[8]),
    )
