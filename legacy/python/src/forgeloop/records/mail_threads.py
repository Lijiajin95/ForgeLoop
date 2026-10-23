"""邮件线索记录：出向反馈邮件的 Message-ID 与需求绑定（架构 §6 持久化与记录）。

职责：

- **出向绑定**：每次发出反馈邮件后，把该邮件**自己的 Message-ID** 与需求编号
  ``req_id``、反馈类型 ``kind``、发送时间 ``sent_at`` 绑定进 ``mail_threads``，
  同一需求的多轮消歧记录只追加、不覆盖，历史轮次完整保留。
- **出向幂等**：``mail_deliveries`` 以 Message-ID 为幂等键记录已投递事实；同一封
  邮件重复投递只落一条记录，重复调用返回既有绑定而不新增线程行。
- **入向去重**：``mail_inbound`` 以收到的 Message-ID 为幂等键记录入向邮件及其来源
  （发件人、主题、收件文件夹、收到时间），同一封邮件重复轮询不重复登记。
- **完整线索**：``trace`` 由 ``mail_threads``（出向绑定）与 ``mail_inbound``
  （入向来源）按时间合并，并以 ``mail_deliveries`` 复核出向投递事实，还原同一需求
  的完整收发往来。

三张表共用同一 SQLite 连接（与 ``RecordStore`` 同库），本模块是记录层对邮件线索的
权威写入方；不解析附件、不访问网络、不判断业务是否该发信。

``mail_deliveries`` 与 ``mail_inbound`` 是出向幂等与入向去重的账本：本模块以
``CREATE TABLE IF NOT EXISTS`` 保证它们存在（已由别处创建则沿用同一张表），从而在
适配器模块落地前后都能与它们协同，而不是各自维护一份私有去重状态。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from forgeloop.domain.mail import Classification

# 邮件线索三张记录表：绑定、出向幂等账、入向去重账，同库共存、共同还原往来。
SCHEMA = """
CREATE TABLE IF NOT EXISTS mail_threads (
    message_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_threads_by_req ON mail_threads (req_id, sent_at);
CREATE TABLE IF NOT EXISTS mail_deliveries (
    message_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_deliveries_by_req ON mail_deliveries (req_id, delivered_at);
CREATE TABLE IF NOT EXISTS mail_inbound (
    message_id TEXT PRIMARY KEY,
    req_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mail_inbound_by_req ON mail_inbound (req_id, received_at);
"""


class MailThreadError(ValueError):
    """违反邮件线索记录规则（身份为空、同一 Message-ID 绑定冲突等）。"""


class MailDirection(StrEnum):
    """邮件方向：出向反馈与入向需求邮件。"""

    OUTBOUND = "outbound"
    INBOUND = "inbound"


@dataclass(frozen=True)
class MailThreadRecord:
    """一封出向反馈邮件与需求的绑定事实。"""

    message_id: str
    req_id: str
    kind: Classification
    sent_at: datetime


@dataclass(frozen=True)
class InboundMailRecord:
    """一封入向邮件的来源事实；附件不在此解析。"""

    message_id: str
    req_id: str
    received_at: datetime
    sender: str = ""
    subject: str = ""
    folder: str = ""


@dataclass(frozen=True)
class OutboundOutcome:
    """一次出向登记结果；``created`` 为假表示命中幂等、未新增线程行。"""

    record: MailThreadRecord
    created: bool


@dataclass(frozen=True)
class InboundOutcome:
    """一次入向登记结果；``created`` 为假表示该 Message-ID 已登记过去重。"""

    record: InboundMailRecord
    created: bool


@dataclass(frozen=True)
class MailTraceEntry:
    """完整线索中的一条往来记录，按时间排序。"""

    direction: MailDirection
    message_id: str
    req_id: str
    occurred_at: datetime
    kind: str = ""
    detail: str = ""


@dataclass(frozen=True)
class MailTrace:
    """同一需求由 ``mail_threads`` 与 ``mail_inbound`` 合并出的完整往来。

    ``entries`` 是出向与入向按时间合并后的时间线；``outbound``/``inbound`` 保留
    两个方向各自的原始记录；``delivered_message_ids`` 是 ``mail_deliveries`` 中
    确认已投递的出向 Message-ID，供复核线程绑定确实对应一次真实投递。
    """

    req_id: str
    entries: tuple[MailTraceEntry, ...]
    outbound: tuple[MailThreadRecord, ...]
    inbound: tuple[InboundMailRecord, ...]
    delivered_message_ids: frozenset[str]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _coerce_kind(kind: Classification | str) -> Classification:
    if isinstance(kind, Classification):
        return kind
    try:
        return Classification(kind)
    except ValueError as error:
        raise MailThreadError(f"未知反馈类型: {kind}") from error


def _require_identity(value: str, field: str) -> str:
    if not value or not value.strip():
        raise MailThreadError(f"{field} 不能为空")
    return value


def _thread_from_row(row: Sequence[object]) -> MailThreadRecord:
    return MailThreadRecord(
        message_id=str(row[0]),
        req_id=str(row[1]),
        kind=_coerce_kind(str(row[2])),
        sent_at=_parse(str(row[3])),
    )


def _inbound_from_row(row: Sequence[object]) -> InboundMailRecord:
    return InboundMailRecord(
        message_id=str(row[0]),
        req_id=str(row[1]),
        received_at=_parse(str(row[2])),
        sender=str(row[3]),
        subject=str(row[4]),
        folder=str(row[5]),
    )


_THREAD_COLUMNS = "message_id, req_id, kind, sent_at"
_INBOUND_COLUMNS = "message_id, req_id, received_at, sender, subject, folder"


class MailThreadStore:
    """邮件线索记录（与 ``RecordStore`` 共用同一 SQLite 连接的独立记录集）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._db.executescript(SCHEMA)

    @contextmanager
    def _write_transaction(self) -> Generator[None]:
        """显式写事务：查重与写入要么整体提交，要么整体回滚。"""

        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    # ---- 出向反馈：Message-ID 绑定与幂等 ----

    def record_outbound(
        self,
        message_id: str,
        req_id: str,
        kind: Classification | str,
        sent_at: datetime | None = None,
    ) -> OutboundOutcome:
        """登记一封已发出的反馈邮件并绑定需求；重复投递保持幂等。

        同一 Message-ID 首次登记时同时写入 ``mail_deliveries``（出向幂等账）与
        ``mail_threads``（需求绑定索引）。再次登记同一 Message-ID 且需求与类型一致
        时返回既有绑定（``created=False``），不产生第二行；需求或类型不一致属于把
        同一封邮件错绑到别处，显式拒绝而不是静默覆盖。
        """

        message_id = _require_identity(message_id, "message_id")
        req_id = _require_identity(req_id, "req_id")
        normalized_kind = _coerce_kind(kind)
        moment = sent_at if sent_at is not None else _now()
        with self._write_transaction():
            existing = self._delivery(message_id)
            if existing is not None:
                if existing.req_id != req_id or existing.kind is not normalized_kind:
                    raise MailThreadError(
                        f"Message-ID {message_id} 已绑定需求 {existing.req_id}"
                        f"（{existing.kind.value}），拒绝改绑 {req_id}（{normalized_kind.value}）"
                    )
                if self._thread(message_id) is None:
                    self._insert_thread(existing)
                return OutboundOutcome(existing, created=False)
            record = MailThreadRecord(message_id, req_id, normalized_kind, moment)
            self._db.execute(
                "INSERT INTO mail_deliveries (message_id, req_id, kind, delivered_at)"
                " VALUES (?, ?, ?, ?)",
                (record.message_id, record.req_id, record.kind.value, _iso(record.sent_at)),
            )
            self._insert_thread(record)
            return OutboundOutcome(record, created=True)

    def _insert_thread(self, record: MailThreadRecord) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO mail_threads (message_id, req_id, kind, sent_at)"
            " VALUES (?, ?, ?, ?)",
            (record.message_id, record.req_id, record.kind.value, _iso(record.sent_at)),
        )

    def _delivery(self, message_id: str) -> MailThreadRecord | None:
        row = self._db.execute(
            "SELECT message_id, req_id, kind, delivered_at FROM mail_deliveries"
            " WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        return _thread_from_row(row) if row is not None else None

    def _thread(self, message_id: str) -> MailThreadRecord | None:
        row = self._db.execute(
            f"SELECT {_THREAD_COLUMNS} FROM mail_threads WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        return _thread_from_row(row) if row is not None else None

    def delivery(self, message_id: str) -> MailThreadRecord | None:
        """按 Message-ID 读取投递事实；未投递返回 ``None``。"""

        return self._delivery(_require_identity(message_id, "message_id"))

    def outbound(self, req_id: str) -> tuple[MailThreadRecord, ...]:
        """按发送时间返回某需求的全部出向反馈，历史轮次只增不覆盖。"""

        req_id = _require_identity(req_id, "req_id")
        rows = self._db.execute(
            f"SELECT {_THREAD_COLUMNS} FROM mail_threads WHERE req_id = ?"
            " ORDER BY sent_at, message_id",
            (req_id,),
        ).fetchall()
        return tuple(_thread_from_row(row) for row in rows)

    def kind_sequence(self, req_id: str) -> tuple[Classification, ...]:
        """按时间返回某需求已发出反馈的类型序列（如消歧多轮的累计上下文）。"""

        return tuple(record.kind for record in self.outbound(req_id))

    def disambiguation_rounds(self, req_id: str) -> int:
        """某需求已发出的消歧反馈轮次数（历史累计不清零）。"""

        return sum(
            1 for record in self.outbound(req_id) if record.kind is Classification.DISAMBIGUATE
        )

    # ---- 入向邮件：Message-ID 去重 ----

    def record_inbound(
        self,
        message_id: str,
        req_id: str,
        received_at: datetime | None = None,
        *,
        sender: str = "",
        subject: str = "",
        folder: str = "",
    ) -> InboundOutcome:
        """登记一封收到的需求邮件；同一 Message-ID 重复轮询只登记一次。"""

        message_id = _require_identity(message_id, "message_id")
        req_id = _require_identity(req_id, "req_id")
        moment = received_at if received_at is not None else _now()
        with self._write_transaction():
            existing = self.inbound_message(message_id)
            if existing is not None:
                if existing.req_id != req_id:
                    raise MailThreadError(
                        f"入向 Message-ID {message_id} 已关联需求 {existing.req_id}，"
                        f"拒绝改绑 {req_id}"
                    )
                return InboundOutcome(existing, created=False)
            record = InboundMailRecord(message_id, req_id, moment, sender, subject, folder)
            self._db.execute(
                "INSERT OR IGNORE INTO mail_inbound"
                " (message_id, req_id, received_at, sender, subject, folder)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record.message_id,
                    record.req_id,
                    _iso(record.received_at),
                    record.sender,
                    record.subject,
                    record.folder,
                ),
            )
            return InboundOutcome(record, created=True)

    def inbound_message(self, message_id: str) -> InboundMailRecord | None:
        """按 Message-ID 读取入向记录；未登记返回 ``None``。"""

        row = self._db.execute(
            f"SELECT {_INBOUND_COLUMNS} FROM mail_inbound WHERE message_id = ?",
            (_require_identity(message_id, "message_id"),),
        ).fetchone()
        return _inbound_from_row(row) if row is not None else None

    def inbound(self, req_id: str) -> tuple[InboundMailRecord, ...]:
        """按收到时间返回某需求的全部入向邮件。"""

        req_id = _require_identity(req_id, "req_id")
        rows = self._db.execute(
            f"SELECT {_INBOUND_COLUMNS} FROM mail_inbound WHERE req_id = ?"
            " ORDER BY received_at, message_id",
            (req_id,),
        ).fetchall()
        return tuple(_inbound_from_row(row) for row in rows)

    # ---- 完整线索 ----

    def trace(self, req_id: str) -> MailTrace:
        """合并出向绑定与入向来源，还原某需求的完整收发往来。

        合并只读取记录：出向来自 ``mail_threads``，入向来自 ``mail_inbound``；
        ``mail_deliveries`` 单独复核出向 Message-ID 确实有过一次投递。时间相同时按
        Message-ID 排序，保证同一份记录任何时候还原出的顺序一致。
        """

        req_id = _require_identity(req_id, "req_id")
        outbound = self.outbound(req_id)
        inbound = self.inbound(req_id)
        entries = [
            MailTraceEntry(
                direction=MailDirection.OUTBOUND,
                message_id=record.message_id,
                req_id=record.req_id,
                occurred_at=record.sent_at,
                kind=record.kind.value,
            )
            for record in outbound
        ] + [
            MailTraceEntry(
                direction=MailDirection.INBOUND,
                message_id=record.message_id,
                req_id=record.req_id,
                occurred_at=record.received_at,
                detail=record.subject,
            )
            for record in inbound
        ]
        entries.sort(key=lambda entry: (entry.occurred_at, entry.message_id))
        delivered = frozenset(
            record.message_id
            for record in outbound
            if self._delivery(record.message_id) is not None
        )
        return MailTrace(
            req_id=req_id,
            entries=tuple(entries),
            outbound=outbound,
            inbound=inbound,
            delivered_message_ids=delivered,
        )
