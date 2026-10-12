"""Export and check the CLI JSON output contract snapshot.

EvidHist 用 OpenAPI 快照守住 HTTP 契约；ForgeLoop 的对外契约是
``forgeloop status --json`` 的输出。本脚本从当前代码构建合成任务样本
（最小任务、全字段任务、不存在任务），提取字段结构（类型与键集合），
写入 ``contracts/cli-contract.json`` 快照。``--check`` 拒绝漂移：
快照缺失、结构不一致都使检查失败；修改输出结构后须重新导出并审阅兼容影响。
"""

import argparse
import json
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from forgeloop.cli.main import _status_document
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.counting import FailureStage
from forgeloop.records.store import RecordStore

ROOT = Path(__file__).resolve().parents[1]
EMPTY_ARRAY = "empty-array"


def shape(value: Any) -> dict:
    """把样本值折叠为类型结构（键按字母序，输出确定）。"""

    if value is None:
        return {"type": ["null"]}
    if isinstance(value, bool):
        return {"type": ["boolean"]}
    if isinstance(value, int):
        return {"type": ["integer"]}
    if isinstance(value, float):
        return {"type": ["number"]}
    if isinstance(value, str):
        return {"type": ["string"]}
    if isinstance(value, list):
        item = shape(value[0]) if value else {"type": [EMPTY_ARRAY]}
        return {"type": ["array"], "item": item}
    if isinstance(value, Mapping):
        return {
            "type": ["object"],
            "properties": {str(key): shape(val) for key, val in sorted(value.items())},
        }
    raise ValueError(f"Unsupported contract sample value: {type(value)!r}")


def merge(left: dict, right: dict) -> dict:
    """合并两个结构：类型并集；对象键并集，单侧出现的键记为可选。"""

    types: list[str] = []
    for candidate in [*left.get("type", []), *right.get("type", [])]:
        if candidate not in types:
            types.append(candidate)
    merged: dict[str, Any] = {"type": types}
    left_props = left.get("properties")
    right_props = right.get("properties")
    if isinstance(left_props, dict) and isinstance(right_props, dict):
        properties: dict[str, Any] = {}
        optional: list[str] = []
        for name in sorted(set(left_props) | set(right_props)):
            if name in left_props and name in right_props:
                properties[name] = merge(left_props[name], right_props[name])
            else:
                optional.append(name)
                properties[name] = left_props[name] if name in left_props else right_props[name]
        merged["properties"] = properties
        if optional:
            merged["optional_keys"] = optional
    elif isinstance(left_props, dict) or isinstance(right_props, dict):
        # 仅单侧为对象（另一侧为 null 等）：对象键全部可选。
        props = left_props if isinstance(left_props, dict) else right_props
        assert isinstance(props, dict)
        merged["properties"] = dict(props)
        merged["optional_keys"] = sorted(props)
    if "item" in left and "item" in right:
        merged["item"] = merge(left["item"], right["item"])
    elif "item" in left or "item" in right:
        merged["item"] = left.get("item") or right.get("item")
    return merged


def build_contract() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        records = Path(tmp) / "records.sqlite"
        store = RecordStore(records)
        try:
            store.create_task(
                "task-min", "proj", "原始文本", {"pi_command": "[]", "test_command": "[]"}, 7200.0
            )
            minimal = _status_document(store, "task-min")

            from datetime import UTC, datetime

            store.create_task(
                "task-full", "proj", "原始文本", {"pi_command": "[]", "test_command": "[]"}, 7200.0
            )
            store.save_plan(Plan("task-full", 1, "goal", "scope", "accept", ("cmd",)))
            now = datetime.now(UTC)
            store.record_approval(Approval("task-full", 1, ApprovalStage.PLAN, now))
            store.record_approval(Approval("task-full", 1, ApprovalStage.ACCEPTANCE, now))
            store.record_failure("task-full", "candidate-1", FailureStage.FORMAL_TEST, "failed")
            store.append_grant("task-full")
            store.charge_budget("task-full", 12.5)
            store.outcomes.request_stop("task-full", "核对后停止")
            store.outcomes.confirm_stop("task-full", "已核对")
            store.outcomes.record_delivery("task-full", "candidate.diff", "delivery-report.json")
            store.outcomes.record_merge("task-full", "a" * 40, True, "pushed")
            full = _status_document(store, "task-full")

            missing = _status_document(store, "task-does-not-exist")
        finally:
            store.close()

    document = merge(shape(minimal), shape(full))
    return {
        "schema_version": 1,
        "command": "forgeloop status --json",
        "exit_codes": {"ok": 0, "task_not_found": 1},
        "document": document,
        "not_found_document": shape(missing),
    }


def serialize(contract: dict) -> str:
    return json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def run_export(snapshot_path: Path) -> dict:
    contract = build_contract()
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text(serialize(contract), encoding="utf-8")
    return contract


def run_check(snapshot_path: Path) -> tuple[bool, str]:
    if not snapshot_path.is_file():
        return False, f"contract snapshot is missing: {snapshot_path}"
    try:
        current = serialize(build_contract())
        recorded = snapshot_path.read_text(encoding="utf-8")
    except (OSError, ValueError) as error:
        return False, f"contract comparison failed: {error}"
    if current == recorded:
        return True, "CLI contract snapshot matches the current output structure."
    return False, "CLI contract drifted; run scripts/export_cli_contract.py and review the change."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "contracts/cli-contract.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.check:
        ok, message = run_check(args.snapshot.resolve())
        print(("OK: " if ok else "FAIL: ") + message)
        return 0 if ok else 1
    contract = run_export(args.snapshot.resolve())
    print(f"CLI contract snapshot written: {args.snapshot}")
    print(f"exit codes: {contract['exit_codes']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
