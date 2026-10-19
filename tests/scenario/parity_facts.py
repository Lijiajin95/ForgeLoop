"""三入口等价性测试的**统一记录事实**读取器。

等价的标准是"同一操作抵达同一记录"，所以跨入口对照必须用同一套读取函数，
否则不同测试各写一份断言，容易出现"看起来在对照、其实口径不同"的假对照。
"""

from __future__ import annotations

from pathlib import Path

from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore


def requirement_root(records_root: Path) -> RequirementStore:
    return RequirementStore(records_root / "records.sqlite")


def cancel_facts(records_root: Path, req_id: str) -> dict[str, object]:
    """取消：终态、决定存在、理由与留痕非空。"""

    store = requirement_root(records_root)
    try:
        decision = store.requirement_cancellation(req_id)
        return {
            "status": store.requirement_status(req_id),
            "has_decision": decision is not None,
            "reason_non_empty": bool(decision and decision.get("reason")),
            "by_non_empty": bool(decision and decision.get("cancelled_by")),
        }
    finally:
        store.close()


def approval_facts(records_root: Path, req_id: str) -> dict[str, object]:
    """批准：是否产生批准、绑定的任务包版本、是否留下来源标记。"""

    store = requirement_root(records_root)
    try:
        approval = store.plan_approval(req_id)
        return {
            "has_approval": approval is not None,
            "plan_version": None if approval is None else approval.plan_version,
            "source_recorded": bool(approval and approval.source),
        }
    finally:
        store.close()


def stop_facts(records_root: Path, task_id: str) -> dict[str, object]:
    """停止：请求是否存在、操作人与入口来源是否留痕。"""

    store = RecordStore(records_root / "records.sqlite")
    try:
        requested_by, source = store.outcomes.stop_attribution(task_id)
        return {
            "has_request": store.outcomes.stop_record(task_id) is not None,
            "by_non_empty": bool(requested_by),
            "source_non_empty": bool(source),
        }
    finally:
        store.close()


def acceptance_facts(records_root: Path, req_id: str) -> dict[str, object]:
    """验收：验收入/来源/材料指纹；未验收时指纹为空。"""

    store = requirement_root(records_root)
    try:
        record = store.requirement_acceptance(req_id)
        return {
            "status": store.requirement_status(req_id),
            "accepted_by_non_empty": bool(record.get("accepted_by")),
            "acceptance_source_non_empty": bool(record.get("acceptance_source")),
            "fingerprint_non_empty": bool(record.get("acceptance_fingerprint")),
        }
    finally:
        store.close()


def advance_facts(records_root: Path, req_id: str) -> dict[str, object]:
    """推进：状态、是否已有可执行授权、任务包版本。"""

    store = requirement_root(records_root)
    try:
        plan = store.latest_task_plan(req_id)
        return {
            "status": store.requirement_status(req_id),
            "authorized": store.authorized_task_plan(req_id) is not None,
            "plan_version": 0 if plan is None else plan.plan_version,
        }
    finally:
        store.close()


def submit_facts(records_root: Path, req_id: str) -> dict[str, object]:
    """提交：状态、版本数、原文是否非空。"""

    store = requirement_root(records_root)
    try:
        requirement = store.get(req_id)
        return {
            "status": store.requirement_status(req_id),
            "versions": len(requirement.versions),
            "text_non_empty": bool(requirement.latest.text.strip()),
        }
    finally:
        store.close()
