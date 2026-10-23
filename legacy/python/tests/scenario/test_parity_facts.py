"""统一记录事实读取器自身的测试：未发生的操作必须读出"未发生"。"""

from __future__ import annotations

from pathlib import Path

from parity_facts import (
    acceptance_facts,
    advance_facts,
    approval_facts,
    cancel_facts,
    submit_facts,
)
from project_support import requirement_store


def _seed(records_root: Path, text: str = "事实读取器：导出功能") -> str:
    store = requirement_store(records_root)
    try:
        return store.submit("forgeloop", text).req_id
    finally:
        store.close()


def test_facts_are_all_negative_before_any_operation(tmp_path: Path) -> None:
    req_id = _seed(tmp_path)
    assert cancel_facts(tmp_path, req_id) == {
        "status": "draft",
        "has_decision": False,
        "reason_non_empty": False,
        "by_non_empty": False,
    }
    assert approval_facts(tmp_path, req_id) == {
        "has_approval": False,
        "plan_version": None,
        "source_recorded": False,
    }
    assert acceptance_facts(tmp_path, req_id) == {
        "status": "draft",
        "accepted_by_non_empty": False,
        "acceptance_source_non_empty": False,
        "fingerprint_non_empty": False,
    }
    assert advance_facts(tmp_path, req_id) == {
        "status": "draft",
        "authorized": False,
        "plan_version": 0,
    }
    assert submit_facts(tmp_path, req_id) == {
        "status": "draft",
        "versions": 1,
        "text_non_empty": True,
    }


def test_cancel_facts_positive_after_cancellation(tmp_path: Path) -> None:
    req_id = _seed(tmp_path)
    store = requirement_store(tmp_path)
    try:
        store.record_requirement_cancellation(req_id, by="owner", reason="事实读取器测试")
    finally:
        store.close()
    assert cancel_facts(tmp_path, req_id) == {
        "status": "cancelled",
        "has_decision": True,
        "reason_non_empty": True,
        "by_non_empty": True,
    }
