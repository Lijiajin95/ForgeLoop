"""业务图节点工厂的守卫单元测试。"""

from pathlib import Path

import pytest

from forgeloop.graph.nodes import NodeContext, _pi_command
from forgeloop.records.store import RecordStore


@pytest.fixture()
def store(tmp_path):
    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


class TestNodeContext:
    def test_unknown_task_raises_key_error(self, store: RecordStore, tmp_path: Path) -> None:
        with pytest.raises(KeyError, match="Unknown task"):
            NodeContext.for_task(store, tmp_path, "missing-task")

    def test_context_paths_are_task_scoped(self, store: RecordStore, tmp_path: Path) -> None:
        store.create_task("task-ctx", "p", "input", {"pi_command": '["pi"]'}, limit_seconds=60.0)
        ctx = NodeContext.for_task(store, tmp_path, "task-ctx")
        assert ctx.task_dir == tmp_path / "task-ctx"
        assert ctx.workspace == tmp_path / "task-ctx" / "workspace"
        assert ctx.sessions_dir == tmp_path / "task-ctx" / "sessions"


class TestPiCommandGuard:
    def test_missing_pi_command_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="missing pi_command"):
            _pi_command({})

    def test_non_list_pi_command_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="JSON array"):
            _pi_command({"pi_command": '"just-a-string"'})

    def test_non_string_parts_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="JSON array"):
            _pi_command({"pi_command": "[1, 2]"})

    def test_valid_command_roundtrips(self) -> None:
        assert _pi_command({"pi_command": '["pi", "--rpc"]'}) == ("pi", "--rpc")
