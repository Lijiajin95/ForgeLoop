"""邮件交互记录：入向命令的执行账、回信绑定与不确定现场（架构 §6 持久化）。

职责：

- **一次入向邮件只执行一次命令**：``mail_interactions`` 以入向 ``Message-ID`` 为主键，
  先占位 ``executing`` 再执行；重复轮询同一封邮件不会重复建档、重复批准或重复推进。
- **回信可重试、不重复执行**：命令执行后先把回信内容与自身 ``Message-ID`` 落库
  （``action_done``），发送成功后置 ``completed``；发送失败时下一次轮询只重发同一封
  回信，不重放命令。
- **不确定现场不盲目重放**：进程在动作中途退出留下 ``executing`` 时，标记
  ``uncertain`` 并回信说明，交由人工核对；不自动重放已可能产生副作用的动作。
- **回复线程解析**：出向回信的 ``Message-ID`` 与需求绑定，入向 ``In-Reply-To`` /
  ``References`` 可据此还原需求，避免主题被修改后丢失线程。

本模块是记录层对邮件交互账的权威写入方；不解析邮件、不访问网络、不判断命令是否
允许执行。与 ``MailThreadStore`` 共用同一 SQLite 连接（与 ``RecordStore`` 同库）。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

SCHEMA = """
CREATE TABLE IF NOT EXISTS mail_interactions (
    inbound_message_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    reply_subject TEXT NOT NULL DEFAULT '',
    reply_body TEXT NOT NULL DEFAULT '',
    reply_message_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_interactions_by_req
    ON mail_interactions (req_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS mail_interactions_by_reply
    ON mail_interactions (reply_message_id) WHERE reply_message_id <> '';
"""


class MailInteractionError(ValueError):
    """违反邮件交互账规则（身份为空、状态非法等）。"""


class InteractionState(StrEnum):
    """一封入向命令邮件的处理状态。"""

    EXECUTING = "executing"
    ACTION_DONE = "action_done"
    COMPLETED = "completed"
    UNCERTAIN = "uncertain"
    FAILED = "failed"


_ALL_STATES: frozenset[InteractionState] = frozenset(InteractionState)


@dataclass(frozen=True)
class MailInteractionRecord:
    """一封入向命令邮件的执行事实与回信状态。"""

    inbound_message_id: str
    req_id: str
    command: str
    state: InteractionState
    detail: str
    reply_subject: str
    reply_body: str
    reply_message_id: str
    created_at: datetime
    updated_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _require(value: str, field: str) -> str:
    if not value or not value.strip():
        raise MailInteractionError(f"{field} 不能为空")
    return value


def _coerce_state(state: InteractionState | str) -> InteractionState:
    if isinstance(state, InteractionState):
        return state
    try:
        normalized = InteractionState(state)
    except ValueError as error:
        raise MailInteractionError(f"未知邮件交互状态: {state}") from error
    if normalized not in _ALL_STATES:  # pragma: no cover - 枚举约束已覆盖
        raise MailInteractionError(f"未知邮件交互状态: {state}")
    return normalized


def _from_row(row: Sequence[object]) -> MailInteractionRecord:
    return MailInteractionRecord(
        inbound_message_id=str(row[0]),
        req_id=str(row[1]),
        command=str(row[2]),
        state=_coerce_state(str(row[3])),
        detail=str(row[4]),
        reply_subject=str(row[5]),
        reply_body=str(row[6]),
        reply_message_id=str(row[7]),
        created_at=_parse(str(row[8])),
        updated_at=_parse(str(row[9])),
    )


_COLUMNS = (
    "inbound_message_id, req_id, command, state, detail,"
    " reply_subject, reply_body, reply_message_id, created_at, updated_at"
)


class MailInteractionStore:
    """邮件交互账（与 ``MailThreadStore`` 共用同一 SQLite 连接的独立记录集）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._db.executescript(SCHEMA)

    @contextmanager
    def _write_transaction(self) -> Generator[None]:
        """显式写事务：占位与更新要么整体提交，要么整体回滚。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    def claim(
        self,
        inbound_message_id: str,
        req_id: str,
        command: str,
        now: datetime | None = None,
    ) -> tuple[MailInteractionRecord, bool]:
        """占用一封入向邮件的命令执行权；已存在时返回既有记录且 ``created=False``。

        ``req_id`` 允许为空（新需求邮件在受理前还没有身份），随后由
        :meth:`set_requirement` 补齐；占用先于任何业务动作，保证崩溃后不盲目重放。
        """

        message_id = _require(inbound_message_id, "inbound_message_id")
        command_name = _require(command, "command")
        moment = now if now is not None else _now()
        with self._write_transaction():
            existing = self.get(message_id)
            if existing is not None:
                return existing, False
            record = MailInteractionRecord(
                inbound_message_id=message_id,
                req_id=req_id,
                command=command_name,
                state=InteractionState.EXECUTING,
                detail="",
                reply_subject="",
                reply_body="",
                reply_message_id="",
                created_at=moment,
                updated_at=moment,
            )
            self._db.execute(
                "INSERT INTO mail_interactions"
                " (inbound_message_id, req_id, command, state, detail,"
                " reply_subject, reply_body, reply_message_id, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.inbound_message_id,
                    record.req_id,
                    record.command,
                    record.state.value,
                    record.detail,
                    record.reply_subject,
                    record.reply_body,
                    record.reply_message_id,
                    _iso(record.created_at),
                    _iso(record.updated_at),
                ),
            )
            return record, True

    def get(self, inbound_message_id: str) -> MailInteractionRecord | None:
        """按入向 Message-ID 读取交互记录；未登记返回 ``None``。"""

        row = self._db.execute(
            f"SELECT {_COLUMNS} FROM mail_interactions WHERE inbound_message_id = ?",
            (_require(inbound_message_id, "inbound_message_id"),),
        ).fetchone()
        return _from_row(row) if row is not None else None

    def entries(self) -> tuple[MailInteractionRecord, ...]:
        """按登记时间返回全部交互记录（只读，供审计与测试）。"""

        rows = self._db.execute(
            f"SELECT {_COLUMNS} FROM mail_interactions ORDER BY created_at, inbound_message_id"
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    def set_requirement(
        self, inbound_message_id: str, req_id: str, now: datetime | None = None
    ) -> None:
        """为已占位的交互补齐需求身份（新邮件受理成功后调用）。"""

        self._update(
            inbound_message_id,
            "req_id = ?",
            (_require(req_id, "req_id"),),
            now=now,
        )

    def save_reply(
        self,
        inbound_message_id: str,
        *,
        subject: str,
        body: str,
        reply_message_id: str,
        state: InteractionState | str = InteractionState.ACTION_DONE,
        detail: str = "",
        now: datetime | None = None,
    ) -> None:
        """保存待发送的回信与自身 Message-ID；命令结果已经确定但尚未投递。"""

        self._update(
            inbound_message_id,
            "reply_subject = ?, reply_body = ?, reply_message_id = ?, state = ?, detail = ?",
            (
                _require(subject, "reply_subject"),
                _require(body, "reply_body"),
                _require(reply_message_id, "reply_message_id"),
                _coerce_state(state).value,
                detail,
            ),
            now=now,
        )

    def mark_replied(self, inbound_message_id: str, now: datetime | None = None) -> None:
        """回信已成功投递，交互进入完成态。"""

        self._update(
            inbound_message_id,
            "state = ?",
            (InteractionState.COMPLETED.value,),
            now=now,
        )

    def mark_uncertain(
        self,
        inbound_message_id: str,
        detail: str,
        now: datetime | None = None,
    ) -> None:
        """命令执行现场不确定：保留记录，等待人工核对，不自动重放。"""

        _require(detail, "detail")
        self._update(
            inbound_message_id,
            "state = ?, detail = ?",
            (InteractionState.UNCERTAIN.value, detail),
            now=now,
        )

    def mark_failed(
        self,
        inbound_message_id: str,
        detail: str,
        now: datetime | None = None,
    ) -> None:
        """命令执行失败且没有可重试的确定性回信。"""

        _require(detail, "detail")
        self._update(
            inbound_message_id,
            "state = ?, detail = ?",
            (InteractionState.FAILED.value, detail),
            now=now,
        )

    def requirement_for_reply(self, reply_message_id: str) -> str | None:
        """按出向回信 Message-ID 反查需求；未绑定返回 ``None``。"""

        message_id = _require(reply_message_id, "reply_message_id")
        row = self._db.execute(
            "SELECT req_id FROM mail_interactions WHERE reply_message_id = ?",
            (message_id,),
        ).fetchone()
        if row is None:
            return None
        req_id = str(row[0])
        return req_id or None

    def _update(
        self,
        inbound_message_id: str,
        assignments: str,
        values: tuple[object, ...],
        *,
        now: datetime | None,
    ) -> None:
        message_id = _require(inbound_message_id, "inbound_message_id")
        moment = now if now is not None else _now()
        with self._write_transaction():
            cursor = self._db.execute(
                f"UPDATE mail_interactions SET {assignments}, updated_at = ?"
                " WHERE inbound_message_id = ?",
                (*values, _iso(moment), message_id),
            )
            if cursor.rowcount == 0:
                raise MailInteractionError(f"未知入向邮件: {message_id}")
