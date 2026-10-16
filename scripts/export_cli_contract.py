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

from forgeloop.adapter.mail import InboundResult, PollReport
from forgeloop.cli.mail import _mail_confirm_document, _mail_poll_document
from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.counting import FailureStage
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.records.checkpoints import (
    CheckpointHealth,
    CheckpointInspection,
    CheckpointState,
    authorize_retry,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact
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
            store.outcomes.record_release(
                ReleaseRecord(
                    task_id="task-full",
                    tag="v0.1.0",
                    merge_commit="a" * 40,
                    baseline_commit="b" * 40,
                    diff_sha256="c" * 64,
                    receipt_path="release-receipt.json",
                    pushed=True,
                    push_detail="pushed",
                    released_at=now,
                )
            )
            full = _status_document(store, "task-full")

            missing = _status_document(store, "task-does-not-exist")
        finally:
            store.close()

        requirement_document, requirement_not_found = build_requirement_contract(Path(tmp))

    document = merge(shape(minimal), shape(full))
    mail_poll_document, mail_confirm_document = build_mail_contract()
    return {
        "schema_version": 1,
        "command": "forgeloop status --json",
        "exit_codes": {"ok": 0, "task_not_found": 1},
        "document": document,
        "not_found_document": shape(missing),
        "requirement_command": "forgeloop requirement status --json",
        "requirement_exit_codes": {"ok": 0, "requirement_not_found": 1},
        "requirement_document": requirement_document,
        "requirement_not_found_document": requirement_not_found,
        # 邮件工作流命令：cron 单次轮询展示分类建议，人工确认后才发信。
        "mail_command": "forgeloop mail poll --once --json",
        "mail_exit_codes": {"ok": 0, "refused": 1},
        "mail_poll_document": mail_poll_document,
        "mail_confirm_command": "forgeloop mail confirm <req_id> --action <...> --json",
        "mail_confirm_document": mail_confirm_document,
    }


def build_mail_contract() -> tuple[dict, dict]:
    """合成一条轮询结果与两种确认结果，提取 ``mail`` 命令的 JSON 结构。

    轮询文档只包含只读事实与待确认动作；确认文档以「已发送」与「重复确认不重复
    发信」两个样本合并，使可空 ``message_id`` 折叠为 ``null``/``string``。
    """

    report = PollReport(
        fetched=2,
        registered=1,
        results=(
            InboundResult(
                message_id="<inbound@example.com>",
                req_id="req-1",
                registered=True,
                reason="已登记",
                attachments_recorded=0,
            ),
        ),
        errors=("无法解析邮件：邮件缺少 Message-ID，无法登记与去重",),
    )
    entry = {
        "req_id": "req-1",
        "message_id": "<inbound@example.com>",
        "registered": True,
        "suggestion": {"kind": "disambiguate", "reason": "信息不完整，先进入消歧"},
        "terminal": False,
        "initial_feedback_sent": False,
        "awaiting_human_confirmation": True,
        "confirm_command": "forgeloop mail confirm req-1 --action <disambiguate|not_accept|accept>",
    }
    terminal_entry = {
        **entry,
        "suggestion": None,
        "terminal": True,
        "initial_feedback_sent": True,
        "awaiting_human_confirmation": False,
    }
    # ``shape`` 只看数组首项：用「有建议」与「已终态无建议」两个样本合并，
    # 使 ``suggestion`` 的可空结构与 ``errors`` 的非空字符串都进入快照。
    poll_document = merge(
        shape(_mail_poll_document(report, [entry])),
        shape(_mail_poll_document(report, [terminal_entry])),
    )
    confirm_document = merge(
        shape(
            _mail_confirm_document(
                "req-1",
                "disambiguate",
                sent=True,
                already_sent=False,
                message_id="<outbound@example.com>",
                reason="已发送并绑定需求线索",
            )
        ),
        shape(
            _mail_confirm_document(
                "req-1",
                "accept_success",
                sent=False,
                already_sent=True,
                message_id=None,
                reason="该入向邮件已有一封反馈，重复确认不重复发信",
            )
        ),
    )
    return poll_document, confirm_document


def build_requirement_contract(root: Path) -> tuple[dict, dict]:
    """合成需求样本（最小/全字段）与不存在样本，提取需求状态 JSON 结构。

    与 ``status --json`` 一样只从真实记录重建文档；身份与时间戳都会被
    :func:`shape` 折叠为类型，因此随机需求身份不使快照漂移。
    """

    from datetime import UTC, datetime

    store = RequirementStore(root / "records.sqlite")
    try:
        now = datetime.now(UTC)
        minimal = store.submit("proj", "原始需求文本")
        minimal_document = _requirement_document(root, store, minimal.req_id)

        full = store.submit("proj", "原始需求文本")
        store.record_analysis(
            full.req_id,
            RequirementAnalysis(
                analysis_version=1,
                requirement_version=1,
                goal="目标",
                scenarios=("场景",),
                acceptance_criteria=("标准",),
                clarifications=(),
                created_at=now,
            ),
        )
        plan = TaskPlan(
            task_plan_id=f"plan-{full.req_id}-1",
            requirement_id=full.req_id,
            project="proj",
            plan_version=1,
            requirement_version=1,
            tasks=(
                PlannedTask("alpha", "目标", ("src/a.py",), "验收", ("cmd",)),
                PlannedTask("beta", "目标", ("src/b.py",), "验收", ("cmd",), depends_on=("alpha",)),
            ),
            created_at=now,
        )
        store.record_task_plan(full.req_id, plan)
        store.record_plan_approval(full.req_id, 1, "owner")
        store.ensure_requirement_budget(full.req_id, 7200.0)
        store.charge_requirement_budget(full.req_id, 12.5)
        store.record_task_run(full.req_id, 1, "alpha", "delivered", executed_seconds=1.0)
        store.record_task_artifact(
            full.req_id,
            1,
            "alpha",
            TaskArtifact("alpha", "a" * 64, "b" * 64, "c" * 64, "accepted", "approval"),
        )
        store.record_task_run(full.req_id, 1, "beta", "awaiting_user", reason="等待验收")
        # 6ba1fd：全字段样本写入一条人工续跑决定，让快照捕获 retry 片段的字段结构；
        # 身份会被 shape 折叠为类型，因此随机需求身份不使快照漂移。
        thread_id = f"task-{full.req_id}-v1-alpha"
        authorize_retry(
            root,
            inspection=CheckpointInspection(
                CheckpointHealth.OK,
                CheckpointState(
                    task_id=thread_id,
                    checkpoint_id="contract-cp",
                    halted_reason="pi_dev_unsettled",
                    halted_node="dev",
                    recorded_task_id=thread_id,
                    plan_version=1,
                ),
            ),
            requirement_id=full.req_id,
            task_id=thread_id,
            plan_version=1,
            task_status="interrupted",
            by="owner",
            reason="人工核对后确认可续跑",
            at=now,
        )
        full_document = _requirement_document(root, store, full.req_id)

        missing = _requirement_document(root, store, "req-does-not-exist")
    finally:
        store.close()
    return merge(shape(minimal_document), shape(full_document)), shape(missing)


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
