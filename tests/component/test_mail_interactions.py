"""邮件交互记录测试：占位幂等、回信绑定与不确定状态。

走真实 SQLite 连接与真实 ``MailInteractionStore``，验证记录事实：
同一入向 Message-ID 只占位一次；回信 Message-ID 可反查需求；发送失败留下的
``action_done`` 可以重发；进程中断留下的 ``executing`` 标记为 ``uncertain``。
"""

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.records.mail_interactions import (
    InteractionState,
    MailInteractionError,
    MailInteractionStore,
)

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 19, 9, 0, tzinfo=UTC)


def open_store(db_path: Path) -> tuple[MailInteractionStore, sqlite3.Connection]:
    connection = sqlite3.connect(db_path, isolation_level=None)
    return MailInteractionStore(connection), connection


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MailInteractionStore]:
    interaction_store, connection = open_store(tmp_path / "records.sqlite")
    try:
        yield interaction_store
    finally:
        connection.close()


class TestClaim:
    def test_first_claim_creates_executing_record(self, store: MailInteractionStore) -> None:
        record, created = store.claim("<in-1@example.com>", "req-1", "status", WHEN)

        assert created is True
        assert record.state is InteractionState.EXECUTING
        assert record.req_id == "req-1"
        assert store.get("<in-1@example.com>") == record

    def test_repeated_claim_is_idempotent(self, store: MailInteractionStore) -> None:
        first, _ = store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        second, created = store.claim("<in-1@example.com>", "req-1", "status", WHEN)

        assert created is False
        assert second == first
        assert len(store.entries()) == 1

    def test_claim_allows_unknown_requirement_then_backfills(
        self, store: MailInteractionStore
    ) -> None:
        record, created = store.claim("<in-new@example.com>", "", "submit", WHEN)
        assert created is True
        assert record.req_id == ""

        store.set_requirement("<in-new@example.com>", "req-new", WHEN)

        updated = store.get("<in-new@example.com>")
        assert updated is not None
        assert updated.req_id == "req-new"

    def test_blank_identity_is_rejected(self, store: MailInteractionStore) -> None:
        with pytest.raises(MailInteractionError, match="inbound_message_id 不能为空"):
            store.claim("", "req-1", "status")
        with pytest.raises(MailInteractionError, match="command 不能为空"):
            store.claim("<in-1@example.com>", "req-1", "")


class TestReplyLedger:
    def test_save_reply_and_lookup_requirement(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        store.save_reply(
            "<in-1@example.com>",
            subject="[ForgeLoop][req-1][状态]",
            body="状态：executing",
            reply_message_id="<out-1@forgeloop.local>",
            now=WHEN,
        )

        record = store.get("<in-1@example.com>")
        assert record is not None
        assert record.state is InteractionState.ACTION_DONE
        assert record.reply_body == "状态：executing"
        assert store.requirement_for_reply("<out-1@forgeloop.local>") == "req-1"

    def test_lookup_unknown_reply_returns_none(self, store: MailInteractionStore) -> None:
        assert store.requirement_for_reply("<missing@forgeloop.local>") is None

    def test_empty_requirement_reply_does_not_bind(self, store: MailInteractionStore) -> None:
        store.claim("<in-new@example.com>", "", "help", WHEN)
        store.save_reply(
            "<in-new@example.com>",
            subject="[ForgeLoop][帮助]",
            body="帮助",
            reply_message_id="<out-help@forgeloop.local>",
            now=WHEN,
        )

        assert store.requirement_for_reply("<out-help@forgeloop.local>") is None

    def test_mark_replied_moves_to_completed(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        store.save_reply(
            "<in-1@example.com>",
            subject="s",
            body="b",
            reply_message_id="<out-1@forgeloop.local>",
            now=WHEN,
        )
        store.mark_replied("<in-1@example.com>", WHEN)

        record = store.get("<in-1@example.com>")
        assert record is not None
        assert record.state is InteractionState.COMPLETED

    def test_uncertain_and_failed_states_keep_detail(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "advance", WHEN)
        store.mark_uncertain("<in-1@example.com>", "进程中断，未自动重放", WHEN)
        uncertain = store.get("<in-1@example.com>")
        assert uncertain is not None
        assert uncertain.state is InteractionState.UNCERTAIN
        assert uncertain.detail == "进程中断，未自动重放"

        store.claim("<in-2@example.com>", "req-1", "advance", WHEN)
        store.mark_failed("<in-2@example.com>", "数据库写入失败", WHEN)
        failed = store.get("<in-2@example.com>")
        assert failed is not None
        assert failed.state is InteractionState.FAILED

    def test_reply_message_id_is_unique(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        store.claim("<in-2@example.com>", "req-1", "status", WHEN)
        store.save_reply(
            "<in-1@example.com>",
            subject="s",
            body="b",
            reply_message_id="<same@forgeloop.local>",
            now=WHEN,
        )

        with pytest.raises(sqlite3.IntegrityError):
            store.save_reply(
                "<in-2@example.com>",
                subject="s",
                body="b",
                reply_message_id="<same@forgeloop.local>",
                now=WHEN,
            )


class TestValidation:
    def test_unknown_message_update_is_rejected(self, store: MailInteractionStore) -> None:
        with pytest.raises(MailInteractionError, match="未知入向邮件"):
            store.mark_replied("<missing@example.com>")

    def test_unknown_state_is_rejected(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        with pytest.raises(MailInteractionError, match="未知邮件交互状态"):
            store.save_reply(
                "<in-1@example.com>",
                subject="s",
                body="b",
                reply_message_id="<out@forgeloop.local>",
                state="not-a-state",
                now=WHEN,
            )

    def test_blank_reply_fields_are_rejected(self, store: MailInteractionStore) -> None:
        store.claim("<in-1@example.com>", "req-1", "status", WHEN)
        with pytest.raises(MailInteractionError, match="reply_subject 不能为空"):
            store.save_reply(
                "<in-1@example.com>",
                subject=" ",
                body="b",
                reply_message_id="<out@forgeloop.local>",
                now=WHEN,
            )
