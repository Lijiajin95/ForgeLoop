"""面板会话记录的单元测试：状态迁移、幂等与终态不可回退。

钉住三条业务不变量：① 终止是终态，后续轮次不能把会话改回进行中；② 同一会话同类
待人工决定只登记一条、重复作出同结论幂等而不同结论显式失败；③ 消息只追加不覆盖。
"""

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from forgeloop.domain.conversation import (
    ConversationError,
    DecisionKind,
    DecisionStatus,
    MessageRole,
    MessageState,
    SessionStatus,
)
from forgeloop.records.conversations import ConversationStore

BASE = datetime(2026, 10, 18, 12, 0, 0, tzinfo=UTC)


@pytest.fixture()
def store(tmp_path: Path) -> Iterator[ConversationStore]:
    instance = ConversationStore(tmp_path / "records.sqlite")
    try:
        yield instance
    finally:
        instance.close()


def session(store: ConversationStore, **overrides: object):
    fields: dict = {"project": "demo", "title": "排查失败", "by": "owner", "cwd": "/srv/demo"}
    fields.update(overrides)
    return store.create_session(**fields)


class TestSessions:
    def test_create_session_starts_active(self, store: ConversationStore) -> None:
        created = session(store)
        assert created.status is SessionStatus.ACTIVE
        assert created.project == "demo"
        assert created.message_count == 0
        assert created.turn_count == 0

    def test_create_session_requires_project(self, store: ConversationStore) -> None:
        with pytest.raises(ConversationError):
            session(store, project="  ")

    def test_list_is_newest_first(self, store: ConversationStore) -> None:
        first = session(store, title="第一条", moment=BASE)
        second = session(store, title="第二条", moment=BASE + timedelta(seconds=1))
        assert [item.session_id for item in store.list_sessions()] == [
            second.session_id,
            first.session_id,
        ]

    def test_get_unknown_session_is_none(self, store: ConversationStore) -> None:
        assert store.get_session("cs-nope") is None

    def test_set_status_unknown_session_fails(self, store: ConversationStore) -> None:
        with pytest.raises(ConversationError):
            store.set_status("cs-nope", SessionStatus.ACTIVE)

    def test_start_turn_counts_and_touches(self, store: ConversationStore) -> None:
        created = session(store)
        store.start_turn(created.session_id, moment=BASE + timedelta(seconds=5))
        refreshed = store.get_session(created.session_id)
        assert refreshed is not None
        assert refreshed.turn_count == 1
        assert refreshed.updated_at == (BASE + timedelta(seconds=5)).isoformat()


class TestTermination:
    def test_terminate_records_who_and_why(self, store: ConversationStore) -> None:
        created = session(store)
        assert store.terminate(created.session_id, by="owner", reason="换方案") is True
        terminated = store.get_session(created.session_id)
        assert terminated is not None
        assert terminated.status is SessionStatus.TERMINATED
        assert terminated.terminated_by == "owner"
        assert terminated.terminate_reason == "换方案"
        assert terminated.terminated_at is not None

    def test_terminate_is_idempotent_and_keeps_first_fact(self, store: ConversationStore) -> None:
        created = session(store)
        store.terminate(created.session_id, by="owner", reason="第一次")
        assert store.terminate(created.session_id, by="other", reason="第二次") is False
        terminated = store.get_session(created.session_id)
        assert terminated is not None
        assert terminated.terminated_by == "owner"
        assert terminated.terminate_reason == "第一次"

    def test_terminated_session_cannot_return_to_active(self, store: ConversationStore) -> None:
        created = session(store)
        store.terminate(created.session_id, by="owner", reason="停")
        with pytest.raises(ConversationError) as error:
            store.set_status(created.session_id, SessionStatus.ACTIVE)
        assert "已终止" in str(error.value)

    def test_terminated_session_cannot_await_human_again(self, store: ConversationStore) -> None:
        created = session(store)
        store.terminate(created.session_id, by="owner", reason="停")
        with pytest.raises(ConversationError):
            store.set_status(created.session_id, SessionStatus.AWAITING_HUMAN)

    def test_terminate_unknown_session_fails(self, store: ConversationStore) -> None:
        with pytest.raises(ConversationError):
            store.terminate("cs-nope", by="owner", reason="停")

    def test_live_session_ids_drive_the_project_removal_guard(
        self, store: ConversationStore
    ) -> None:
        live = session(store, project="demo", title="进行中")
        done = session(store, project="demo", title="已终止")
        store.terminate(done.session_id, by="owner", reason="停")
        assert store.live_session_ids("demo") == (live.session_id,)
        assert store.live_session_ids("other") == ()


class TestMessages:
    def test_messages_are_appended_in_order(self, store: ConversationStore) -> None:
        created = session(store)
        store.append_message(
            created.session_id, role=MessageRole.HUMAN, content="你好", author="owner"
        )
        store.append_message(created.session_id, role=MessageRole.AGENT, content="收到")
        store.append_message(
            created.session_id,
            role=MessageRole.SYSTEM,
            content="本轮失败",
            state=MessageState.ERROR,
        )
        messages = store.list_messages(created.session_id)
        assert [message.role for message in messages] == [
            MessageRole.HUMAN,
            MessageRole.AGENT,
            MessageRole.SYSTEM,
        ]
        assert messages[0].author == "owner"
        assert messages[2].state is MessageState.ERROR

    def test_human_messages_are_validated(self, store: ConversationStore) -> None:
        created = session(store)
        with pytest.raises(ConversationError):
            store.append_message(created.session_id, role=MessageRole.HUMAN, content="  ")

    def test_recent_messages_return_oldest_first(self, store: ConversationStore) -> None:
        created = session(store)
        for index in range(5):
            store.append_message(
                created.session_id, role=MessageRole.HUMAN, content=f"第 {index} 条"
            )
        recent = store.recent_messages(created.session_id, limit=3)
        assert [text for _, text in recent] == ["第 2 条", "第 3 条", "第 4 条"]

    def test_message_count_is_reported_on_the_session(self, store: ConversationStore) -> None:
        created = session(store)
        store.append_message(created.session_id, role=MessageRole.HUMAN, content="你好")
        refreshed = store.get_session(created.session_id)
        assert refreshed is not None
        assert refreshed.message_count == 1


class TestDecisions:
    def test_open_decision_is_pending(self, store: ConversationStore) -> None:
        created = session(store)
        decision = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?"
        )
        assert decision.status is DecisionStatus.PENDING
        assert store.pending_decision(created.session_id) == decision
        refreshed = store.get_session(created.session_id)
        assert refreshed is not None
        assert refreshed.pending_decisions == 1

    def test_same_kind_reuses_the_pending_decision(self, store: ConversationStore) -> None:
        created = session(store)
        first = store.open_decision(
            created.session_id, kind=DecisionKind.TURN_FAILED, question="失败一"
        )
        second = store.open_decision(
            created.session_id, kind=DecisionKind.TURN_FAILED, question="失败二"
        )
        assert first.decision_id == second.decision_id
        assert second.question == "失败一"

    def test_other_kind_opens_a_second_decision(self, store: ConversationStore) -> None:
        created = session(store)
        first = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?"
        )
        second = store.open_decision(
            created.session_id, kind=DecisionKind.TURN_FAILED, question="失败了"
        )
        assert first.decision_id != second.decision_id

    def test_resolve_records_the_decision(self, store: ConversationStore) -> None:
        created = session(store)
        decision = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?"
        )
        decided = store.resolve_decision(
            decision.decision_id,
            status=DecisionStatus.APPROVED,
            by="owner",
            reason="继续",
        )
        assert decided.status is DecisionStatus.APPROVED
        assert decided.decided_by == "owner"
        assert decided.reason == "继续"
        assert decided.decided_at is not None
        assert store.pending_decision(created.session_id) is None

    def test_same_outcome_is_idempotent(self, store: ConversationStore) -> None:
        created = session(store)
        decision = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?"
        )
        first = store.resolve_decision(
            decision.decision_id, status=DecisionStatus.APPROVED, by="owner", reason="第一次"
        )
        again = store.resolve_decision(
            decision.decision_id, status=DecisionStatus.APPROVED, by="other", reason="第二次"
        )
        assert again == first

    def test_opposite_outcome_is_refused(self, store: ConversationStore) -> None:
        created = session(store)
        decision = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="继续吗?"
        )
        store.resolve_decision(
            decision.decision_id, status=DecisionStatus.APPROVED, by="owner", reason="继续"
        )
        with pytest.raises(ConversationError) as error:
            store.resolve_decision(
                decision.decision_id, status=DecisionStatus.REJECTED, by="owner", reason="反悔"
            )
        assert "已作出" in str(error.value)

    def test_resolve_unknown_decision_fails(self, store: ConversationStore) -> None:
        with pytest.raises(ConversationError):
            store.resolve_decision(
                "dc-nope", status=DecisionStatus.APPROVED, by="owner", reason="继续"
            )

    def test_decisions_are_listed_in_order(self, store: ConversationStore) -> None:
        created = session(store)
        first = store.open_decision(
            created.session_id, kind=DecisionKind.AGENT_REQUEST, question="一", moment=BASE
        )
        second = store.open_decision(
            created.session_id,
            kind=DecisionKind.TURN_FAILED,
            question="二",
            moment=BASE + timedelta(seconds=1),
        )
        assert [item.decision_id for item in store.list_decisions(created.session_id)] == [
            first.decision_id,
            second.decision_id,
        ]


class TestToolCallIdentity:
    """工具调用的身份口径：``toolCallId`` 只在会话内唯一（真实试验抓到的缺陷）。"""

    def test_same_tool_call_id_in_two_sessions_keeps_both_rows(self, tmp_path: Path) -> None:
        store = ConversationStore(tmp_path / "records.sqlite")
        try:
            first = store.create_session(project="demo", title="第一个", by="owner").session_id
            second = store.create_session(project="demo", title="第二个", by="owner").session_id
            for session_id in (first, second):
                store.record_tool_start(
                    session_id,
                    tool_call_id="call-bash-1",
                    tool_name="bash",
                    args_excerpt=f"ls {session_id[-4:]}",
                    risk="execute",
                    requires_approval=True,
                )
                store.record_tool_end(
                    session_id,
                    tool_call_id="call-bash-1",
                    result_excerpt=f"输出 {session_id[-4:]}",
                    is_error=False,
                    duration_ms=5,
                )
            rows = {session: store.list_tool_calls(session) for session in (first, second)}
            assert len(rows[first]) == 1
            assert len(rows[second]) == 1
            # 两条各归各的会话，参数与结果没有被对方覆盖。
            assert rows[first][0].session_id == first
            assert rows[second][0].session_id == second
            assert rows[first][0].args_excerpt != rows[second][0].args_excerpt
            assert store.count_pending_tool_approvals(first) == 1
            assert store.count_pending_tool_approvals(second) == 1
            # 批准只作用于一个会话。
            assert store.mark_tool_approval(first, "approved") == 1
            assert store.count_pending_tool_approvals(second) == 1
        finally:
            store.close()

    def test_legacy_single_column_primary_key_is_migrated(self, tmp_path: Path) -> None:
        """旧现场（`tool_call_id` 单列主键）自动重建成复合主键，且不丢已有行。"""

        path = tmp_path / "records.sqlite"
        store = ConversationStore(path)
        session_id = store.create_session(project="demo", title="旧现场", by="owner").session_id
        store.record_tool_start(
            session_id,
            tool_call_id="call-old",
            tool_name="read",
            args_excerpt="path",
            risk="read",
            requires_approval=False,
        )
        store.close()

        legacy = sqlite3.connect(path)
        legacy.executescript(
            "ALTER TABLE panel_tool_calls RENAME TO panel_tool_calls_old;"
            "CREATE TABLE panel_tool_calls (tool_call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,"
            " tool_name TEXT NOT NULL, args_excerpt TEXT NOT NULL DEFAULT '',"
            " result_excerpt TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL, status TEXT NOT NULL,"
            " duration_ms INTEGER NOT NULL DEFAULT 0, requires_approval INTEGER NOT NULL DEFAULT 0,"
            " approval_status TEXT NOT NULL DEFAULT 'none', started_at TEXT NOT NULL, ended_at TEXT);"
            "INSERT INTO panel_tool_calls SELECT * FROM panel_tool_calls_old;"
            "DROP TABLE panel_tool_calls_old;"
        )
        legacy.commit()
        legacy.close()

        migrated = ConversationStore(path)
        try:
            rows = migrated.list_tool_calls(session_id)
            assert [row.tool_call_id for row in rows] == ["call-old"]
        finally:
            migrated.close()
        check = sqlite3.connect(path)
        try:
            info = list(check.execute("PRAGMA table_info(panel_tool_calls)"))
            assert info[0][1] == "tool_call_id"
            primary = [row[1] for row in sorted((r for r in info if r[5]), key=lambda r: r[5])]
            assert primary == ["session_id", "tool_call_id"]
        finally:
            check.close()
