"""CLI 契约快照的漂移负例测试。

对应可靠性方案第 11 节负例矩阵：受控漂移 → 退出 1；缺快照 → 退出 1；一致 → 退出 0。
"""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "export_cli_contract.py"
ROOT = Path(__file__).resolve().parents[2]


def load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_cli_contract", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


class TestShapeAndMerge:
    def test_shape_types_and_sorted_keys(self) -> None:
        node = gate.shape({"b": 1, "a": "x"})
        assert node["type"] == ["object"]
        assert list(node["properties"]) == ["a", "b"]
        assert node["properties"]["a"]["type"] == ["string"]
        assert node["properties"]["b"]["type"] == ["integer"]

    def test_merge_null_with_object_makes_keys_optional(self) -> None:
        left = gate.shape(None)
        right = gate.shape({"k": "v"})
        merged = gate.merge(left, right)
        assert merged["type"] == ["null", "object"]
        assert merged["optional_keys"] == ["k"]
        assert merged["properties"]["k"]["type"] == ["string"]

    def test_merge_disjoint_objects_marks_both_optional(self) -> None:
        merged = gate.merge(gate.shape({"a": 1}), gate.shape({"b": 2}))
        assert set(merged["optional_keys"]) == {"a", "b"}


class TestSnapshotCheck:
    def test_recorded_snapshot_matches_current_contract(self) -> None:
        ok, message = gate.run_check(ROOT / "contracts" / "cli-contract.json")
        assert ok, message

    def test_drifted_snapshot_fails(self, tmp_path: Path) -> None:
        snapshot = tmp_path / "cli-contract.json"
        contract = json.loads(
            (ROOT / "contracts" / "cli-contract.json").read_text(encoding="utf-8")
        )
        contract["document"]["properties"]["task_id"]["type"] = ["integer"]  # 受控漂移
        snapshot.write_text(
            json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        ok, _message = gate.run_check(snapshot)
        assert not ok

    def test_missing_snapshot_fails(self, tmp_path: Path) -> None:
        ok, message = gate.run_check(tmp_path / "missing.json")
        assert not ok
        assert "missing" in message

    def test_export_then_check_roundtrip(self, tmp_path: Path) -> None:
        snapshot = tmp_path / "cli-contract.json"
        gate.run_export(snapshot)
        ok, message = gate.run_check(snapshot)
        assert ok, message

    def test_exit_code_contract_is_recorded(self) -> None:
        contract = json.loads(
            (ROOT / "contracts" / "cli-contract.json").read_text(encoding="utf-8")
        )
        assert contract["exit_codes"] == {"ok": 0, "task_not_found": 1}
        assert contract["not_found_document"]["properties"]["error"]["type"] == ["string"]
