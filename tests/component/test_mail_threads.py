"""组件测试：邮件线索记录的出向绑定、出向幂等、入向去重与完整往来还原。

走真实的 SQLite 记录库与 ``MailThreadStore``，验证三张记录表
（``mail_threads``/``mail_deliveries``/``mail_inbound``）协同后的事实：

- 每条出向反馈记录自己的 Message-ID 并绑定 ``req_id``、``kind``、``sent_at``；
- 同一需求多轮消歧历史只追加、不覆盖，上下文累计完整；
- 重复投递同一 Message-ID 出向幂等，重复入向邮件按 Message-ID 去重；
- 线索可由三张表共同还原出同一需求的完整收发往来，且进程重开后仍在。
"""

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from forgeloop.domain.mail import Classification
from forgeloop.records.mail_threads import (
    MailDirection,
    MailThreadError,
    MailThreadStore,
)

pytestmark = pytest.mark.component

REQ = "req-20261016071651-c4f6e4"
OTHER_REQ = "req-20261016120000-abcdef"
WHEN = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)


def open_store(db_path: Path) -> tuple[MailThreadStore, sqlite3.Connection]:
    connection = sqlite3.connect(db_path)
    return MailThreadStore(connection), connection


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "records.sqlite"


@pytest.fixture
def store(db_path: Path) -> Iterator[MailThreadStore]:
    store, connection = open_store(db_path)
    yield store
    connection.close()


class TestOutboundBinding:
    """出向反馈的 Message-ID、需求、类型与发送时间绑定。"""

    def test_records_its_own_message_id_and_binding(self, store: MailThreadStore) -> None:
        outcome = store.record_outbound("<msg-1@forgeloop>", REQ, Classification.DISAMBIGUATE, WHEN)

        assert outcome.created
        record = outcome.record
        assert record.message_id == "<msg-1@forgeloop>"
        assert record.req_id == REQ
        assert record.kind is Classification.DISAMBIGUATE
        assert record.sent_at == WHEN
        # 绑定同时可从 mail_threads（线程索引）与 mail_deliveries（出向幂等账）读到。
        assert store.outbound(REQ) == (record,)
        assert store.delivery("<msg-1@forgeloop>") == record

    def test_each_feedback_has_its_own_message_id(self, store: MailThreadStore) -> None:
        first = store.record_outbound("<msg-a@x>", REQ, Classification.DISAMBIGUATE, WHEN).record
        second = store.record_outbound("<msg-b@x>", REQ, Classification.ACCEPT_SUCCESS, WHEN).record

        assert first.message_id != second.message_id
        assert store.outbound(REQ) == (first, second)

    def test_multi_round_disambiguation_history_is_accumulated(
        self, store: MailThreadStore
    ) -> None:
        # 同一需求连续三轮消歧，再给出接纳成功；历史轮次必须全部保留。
        for round_number in range(1, 4):
            store.record_outbound(
                f"<round-{round_number}@x>",
                REQ,
                Classification.DISAMBIGUATE,
                WHEN + timedelta(hours=round_number),
            )
        store.record_outbound(
            "<accept@x>", REQ, Classification.ACCEPT_SUCCESS, WHEN + timedelta(hours=4)
        )

        assert store.disambiguation_rounds(REQ) == 3
        assert store.kind_sequence(REQ) == (
            Classification.DISAMBIGUATE,
            Classification.DISAMBIGUATE,
            Classification.DISAMBIGUATE,
            Classification.ACCEPT_SUCCESS,
        )
        # 每一轮的问题邮件都保留自己的 Message-ID，没有被后续轮次覆盖。
        assert [record.message_id for record in store.outbound(REQ)] == [
            "<round-1@x>",
            "<round-2@x>",
            "<round-3@x>",
            "<accept@x>",
        ]

    def test_outbound_is_written_to_both_tables(
        self, store: MailThreadStore, db_path: Path
    ) -> None:
        store.record_outbound("<msg-1@x>", REQ, Classification.ACCEPT_SUCCESS, WHEN)

        # 直接检查真实表：出向事实同时进入 mail_threads 与 mail_deliveries。
        connection = sqlite3.connect(db_path)
        try:
            thread_rows = connection.execute(
                "SELECT message_id, req_id, kind, sent_at FROM mail_threads"
            ).fetchall()
            delivery_rows = connection.execute(
                "SELECT message_id, req_id, kind FROM mail_deliveries"
            ).fetchall()
        finally:
            connection.close()

        assert thread_rows == [("<msg-1@x>", REQ, "accept_success", WHEN.isoformat())]
        assert delivery_rows == [("<msg-1@x>", REQ, "accept_success")]

    def test_blank_identities_are_rejected(self, store: MailThreadStore) -> None:
        with pytest.raises(MailThreadError, match="message_id 不能为空"):
            store.record_outbound("  ", REQ, Classification.DISAMBIGUATE, WHEN)
        with pytest.raises(MailThreadError, match="req_id 不能为空"):
            store.record_outbound("<msg@x>", "  ", Classification.DISAMBIGUATE, WHEN)

    def test_unknown_kind_is_rejected(self, store: MailThreadStore) -> None:
        with pytest.raises(MailThreadError, match="未知反馈类型"):
            store.record_outbound("<msg@x>", REQ, "not-a-kind", WHEN)


class TestOutboundIdempotency:
    """重复投递同一 Message-ID 出向幂等。"""

    def test_repeated_delivery_does_not_create_second_thread_row(
        self, store: MailThreadStore
    ) -> None:
        first = store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)
        second = store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)

        assert first.created is True
        assert second.created is False
        assert len(store.outbound(REQ)) == 1

    def test_repeated_delivery_returns_original_binding(self, store: MailThreadStore) -> None:
        first = store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN).record
        later = WHEN + timedelta(hours=12)
        second = store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, later).record

        # 幂等重放保留首次发送时间，不把既有绑定改写成后来时间。
        assert second == first
        assert store.outbound(REQ) == (first,)

    def test_repeated_delivery_keeps_existing_delivery_row(self, store: MailThreadStore) -> None:
        store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)
        store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)

        assert store.delivery("<msg-1@x>") is not None

    def test_rebinding_same_message_id_to_another_requirement_is_rejected(
        self, store: MailThreadStore
    ) -> None:
        original = store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN).record

        with pytest.raises(MailThreadError, match="拒绝改绑"):
            store.record_outbound("<msg-1@x>", OTHER_REQ, Classification.DISAMBIGUATE, WHEN)

        # 冲突不产生副作用：原绑定保持原样，也不误写到另一个需求。
        assert store.outbound(REQ) == (original,)
        assert store.outbound(OTHER_REQ) == ()

    def test_same_message_id_with_different_kind_is_rejected(self, store: MailThreadStore) -> None:
        store.record_outbound("<msg-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)

        with pytest.raises(MailThreadError, match="拒绝改绑"):
            store.record_outbound("<msg-1@x>", REQ, Classification.ACCEPT_SUCCESS, WHEN)


class TestInboundDedup:
    """入向邮件按收到的 Message-ID 去重并记录来源。"""

    def test_inbound_records_source_metadata(self, store: MailThreadStore) -> None:
        outcome = store.record_inbound(
            "<in-1@x>",
            REQ,
            WHEN,
            sender="user@example.com",
            subject="[ForgeLoop][req-20261016071651-c4f6e4] 新需求",
            folder="INBOX",
        )

        assert outcome.created
        assert outcome.record.sender == "user@example.com"
        assert outcome.record.subject.startswith("[ForgeLoop]")
        assert outcome.record.folder == "INBOX"
        assert store.inbound(REQ) == (outcome.record,)

    def test_repeated_inbound_message_is_deduped(self, store: MailThreadStore) -> None:
        first = store.record_inbound("<in-1@x>", REQ, WHEN, sender="user@example.com")
        second = store.record_inbound("<in-1@x>", REQ, WHEN, sender="user@example.com")

        assert first.created is True
        assert second.created is False
        assert second.record == first.record
        assert len(store.inbound(REQ)) == 1

    def test_distinct_inbound_messages_are_all_kept(self, store: MailThreadStore) -> None:
        store.record_inbound("<in-1@x>", REQ, WHEN)
        store.record_inbound("<in-2@x>", REQ, WHEN + timedelta(hours=1))

        assert [record.message_id for record in store.inbound(REQ)] == ["<in-1@x>", "<in-2@x>"]

    def test_rebinding_inbound_to_another_requirement_is_rejected(
        self, store: MailThreadStore
    ) -> None:
        store.record_inbound("<in-1@x>", REQ, WHEN)

        with pytest.raises(MailThreadError, match="拒绝改绑"):
            store.record_inbound("<in-1@x>", OTHER_REQ, WHEN)


class TestFullTrace:
    """线索由三张表共同还原出完整往来。"""

    def test_trace_reconstructs_a_disambiguation_exchange(self, store: MailThreadStore) -> None:
        # 用户来信 -> 系统消歧 -> 用户补充 -> 系统接纳。
        store.record_inbound("<in-1@x>", REQ, WHEN, subject="新需求")
        store.record_outbound(
            "<out-1@x>", REQ, Classification.DISAMBIGUATE, WHEN + timedelta(hours=1)
        )
        store.record_inbound("<in-2@x>", REQ, WHEN + timedelta(hours=2), subject="补充说明")
        store.record_outbound(
            "<out-2@x>", REQ, Classification.ACCEPT_SUCCESS, WHEN + timedelta(hours=3)
        )

        trace = store.trace(REQ)

        assert [entry.message_id for entry in trace.entries] == [
            "<in-1@x>",
            "<out-1@x>",
            "<in-2@x>",
            "<out-2@x>",
        ]
        assert [entry.direction for entry in trace.entries] == [
            MailDirection.INBOUND,
            MailDirection.OUTBOUND,
            MailDirection.INBOUND,
            MailDirection.OUTBOUND,
        ]
        assert [
            entry.kind for entry in trace.entries if entry.direction is MailDirection.OUTBOUND
        ] == [
            "disambiguate",
            "accept_success",
        ]
        # 出向线程绑定与出向幂等账一致：两个出向 Message-ID 都有投递事实。
        assert trace.delivered_message_ids == {"<out-1@x>", "<out-2@x>"}

    def test_trace_is_scoped_to_one_requirement(self, store: MailThreadStore) -> None:
        store.record_inbound("<in-1@x>", REQ, WHEN)
        store.record_outbound("<out-1@x>", REQ, Classification.DISAMBIGUATE, WHEN)
        store.record_inbound("<in-9@x>", OTHER_REQ, WHEN)
        store.record_outbound("<out-9@x>", OTHER_REQ, Classification.DISAMBIGUATE, WHEN)

        assert [entry.message_id for entry in store.trace(REQ).entries] == [
            "<in-1@x>",
            "<out-1@x>",
        ]

    def test_trace_survives_reopening_the_record_store(self, db_path: Path) -> None:
        store, connection = open_store(db_path)
        store.record_inbound("<in-1@x>", REQ, WHEN)
        store.record_outbound(
            "<out-1@x>", REQ, Classification.DISAMBIGUATE, WHEN + timedelta(hours=1)
        )
        connection.close()

        reopened, reopened_connection = open_store(db_path)
        try:
            trace = reopened.trace(REQ)
            assert [entry.message_id for entry in trace.entries] == ["<in-1@x>", "<out-1@x>"]
            assert reopened.delivery("<out-1@x>") is not None
        finally:
            reopened_connection.close()

    def test_trace_of_unknown_requirement_is_empty(self, store: MailThreadStore) -> None:
        trace = store.trace(OTHER_REQ)

        assert trace.entries == ()
        assert trace.outbound == ()
        assert trace.inbound == ()
        assert trace.delivered_message_ids == frozenset()
