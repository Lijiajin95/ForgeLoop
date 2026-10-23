"""Agent Runtime 运行状态记录：当前选择、切换审计与 fail-closed 校验。"""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.agent_runtime import DSH, PI, AgentRuntimeError
from forgeloop.records.agent_runtimes import AgentRuntimeStore

MOMENT = datetime(2026, 10, 19, 2, 30, tzinfo=UTC)


@pytest.fixture()
def store(tmp_path: Path):
    store = AgentRuntimeStore(tmp_path / "records.sqlite")
    yield store
    store.close()


class TestCurrent:
    def test_fresh_store_has_no_selection(self, store: AgentRuntimeStore) -> None:
        assert store.current() is None

    def test_selection_round_trips(self, store: AgentRuntimeStore) -> None:
        store.set_runtime(DSH, command=("dsh", "--json"), by="owner", reason="切换", at=MOMENT)
        current = store.current()
        assert current is not None
        assert current.runtime == DSH
        assert current.command == ("dsh", "--json")
        assert current.updated_at == MOMENT
        assert current.updated_by == "owner"
        assert current.reason == "切换"

    def test_state_survives_reopen(self, tmp_path: Path) -> None:
        first = AgentRuntimeStore(tmp_path / "records.sqlite")
        first.set_runtime(DSH, by="owner", reason="切换", at=MOMENT)
        first.close()
        second = AgentRuntimeStore(tmp_path / "records.sqlite")
        try:
            current = second.current()
            assert current is not None
            assert current.runtime == DSH
            assert current.command == ("dsh", "--profile", "headless", "--json")
        finally:
            second.close()


class TestSetRuntimeRules:
    def test_dsh_without_command_records_official_default(self, store: AgentRuntimeStore) -> None:
        state = store.set_runtime(DSH, by="owner", reason="先跑一轮 DSH", at=MOMENT)
        assert state.command == ("dsh", "--profile", "headless", "--json")

    def test_pi_without_command_stays_empty(self, store: AgentRuntimeStore) -> None:
        state = store.set_runtime(PI, by="owner", reason="回到 PI", at=MOMENT)
        assert state.command == ()

    def test_unknown_runtime_is_rejected_without_side_effect(
        self, store: AgentRuntimeStore
    ) -> None:
        with pytest.raises(AgentRuntimeError):
            store.set_runtime("codex", by="owner", reason="x", at=MOMENT)
        assert store.current() is None
        assert store.history() == ()

    def test_blank_operator_is_rejected(self, store: AgentRuntimeStore) -> None:
        with pytest.raises(AgentRuntimeError, match="调用方标识"):
            store.set_runtime(DSH, by="   ", reason="x", at=MOMENT)
        assert store.current() is None

    def test_blank_reason_is_rejected(self, store: AgentRuntimeStore) -> None:
        with pytest.raises(AgentRuntimeError, match="理由"):
            store.set_runtime(DSH, by="owner", reason=" ", at=MOMENT)
        assert store.current() is None

    def test_invalid_command_is_rejected_without_side_effect(
        self, store: AgentRuntimeStore
    ) -> None:
        with pytest.raises(AgentRuntimeError):
            store.set_runtime(DSH, command=("dsh", ""), by="owner", reason="x", at=MOMENT)
        assert store.current() is None
        assert store.history() == ()


class TestHistory:
    def test_switches_append_newest_first(self, store: AgentRuntimeStore) -> None:
        store.set_runtime(PI, by="owner", reason="初始", at=MOMENT)
        later = MOMENT.replace(hour=3)
        store.set_runtime(DSH, by="owner", reason="试验 DSH", at=later)
        history = store.history()
        assert [item.to_runtime for item in history] == [DSH, PI]
        assert history[0].from_runtime == PI
        assert history[1].from_runtime == ""
        assert history[0].switched_by == "owner"
        assert history[0].switched_at == later
        assert history[0].command == ("dsh", "--profile", "headless", "--json")

    def test_limit_truncates(self, store: AgentRuntimeStore) -> None:
        for index in range(3):
            store.set_runtime(PI, by="owner", reason=f"第 {index} 次", at=MOMENT)
        assert len(store.history(limit=2)) == 2
        assert store.history(limit=0) == ()

    def test_switch_ids_are_unique(self, store: AgentRuntimeStore) -> None:
        first = store.set_runtime(PI, by="owner", reason="a", at=MOMENT)
        second = store.set_runtime(DSH, by="owner", reason="b", at=MOMENT)
        assert first.runtime != second.runtime
        ids = [item.switch_id for item in store.history()]
        assert len(set(ids)) == 2
