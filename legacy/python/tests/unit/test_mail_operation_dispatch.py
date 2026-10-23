"""邮件操作分派（合成文档）：不经邮件、不经轮询，直接验证分派逻辑可达。

2026-10-19 的定位结论：邮件"停止"端到端没触发时，第一步要把"分派是否可达"与
"邮件管道是否把 operation 传上来"分开验证——本文件就是前者的最小可观测测试。
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
from pathlib import Path

from project_support import (
    project_records,
    requirement_store,
)
from project_support import (
    record_store as open_record_store,
)

from forgeloop.cli.main import _apply_mail_operations
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.worker import current_task_thread_id

WHEN = datetime(2026, 10, 19, tzinfo=UTC)
PROJECT = "forgeloop"


def _seed_with_task(records_root: Path, text: str = "分派测试：导出功能") -> tuple[str, str]:
    store = requirement_store(records_root)
    try:
        req_id = store.submit(PROJECT, text).req_id
        store.record_task_plan(
            req_id,
            TaskPlan(
                task_plan_id=f"plan-{req_id}",
                requirement_id=req_id,
                project=PROJECT,
                plan_version=1,
                requirement_version=1,
                tasks=(
                    PlannedTask(
                        task_id="task-1",
                        goal="实现导出",
                        files=("src/export.py",),
                        acceptance="测试通过",
                        test_command=("pytest", "-q"),
                    ),
                ),
                created_at=WHEN,
            ),
        )
        store.record_plan_approval(req_id, 1, "owner", source="cli")
    finally:
        store.close()
    task_id = current_task_thread_id(project_records(records_root), req_id)
    record_store = open_record_store(records_root)
    try:
        record_store.create_task(task_id, PROJECT, text, {"pi_command": "pi"}, 60.0)
    finally:
        record_store.close()
    return req_id, task_id


def _args(records_root: Path, document: dict) -> argparse.Namespace:
    return argparse.Namespace(
        records_root=str(records_root), project=PROJECT, poll_document=document
    )


class TestStopDispatch:
    def test_synthetic_document_reaches_the_stop_entry(self, tmp_path: Path) -> None:
        req_id, task_id = _seed_with_task(tmp_path)
        document = {
            "requirements": [
                {
                    "req_id": req_id,
                    "registered": True,
                    "operation": "停止",
                    "operation_reason": "现场核对",
                    "mail_sender": "requester@example.com",
                }
            ]
        }
        messages = _apply_mail_operations(_args(tmp_path, document))
        assert messages, "分派必须产生可展示结果"
        assert "停止请求已记录" in messages[0], messages

        store = open_record_store(tmp_path)
        try:
            assert store.outcomes.stop_record(task_id) is not None
            requested_by, source = store.outcomes.stop_attribution(task_id)
            assert requested_by == "requester@example.com" and source == "mail"
        finally:
            store.close()

    def test_document_without_operation_is_a_no_op(self, tmp_path: Path) -> None:
        req_id, _task_id = _seed_with_task(tmp_path)
        messages = _apply_mail_operations(
            _args(tmp_path, {"requirements": [{"req_id": req_id, "registered": True}]})
        )
        assert messages == []
