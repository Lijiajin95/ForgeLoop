"""三入口等价性（邮件 / CLI / 页面）：同一操作经不同入口应产生**同一记录事实**。

本文件先覆盖取消（三入口均已实现），对比断言只看记录事实：终态、决定存在性与理由非空；
入口来源允许不同（CLI 用 --by、页面用请求体 by、邮件用发件人），但都必须如实留痕。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from support import run_cli

from forgeloop.records.requirements import RequirementStore


def _seed(records_root: Path, text: str = "等价性：导出功能") -> str:
    store = RequirementStore(records_root / "records.sqlite")
    try:
        return store.submit("ForgeLoop", text).req_id
    finally:
        store.close()


def _cancel_facts(records_root: Path, req_id: str) -> dict[str, object]:
    store = RequirementStore(records_root / "records.sqlite")
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


class TestCancelParity:
    def test_cli_and_mail_yield_the_same_record_facts(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            connection_args,
            install_transport,
        )

        cli_root = tmp_path / "cli"
        cli_root.mkdir()
        cli_req = _seed(cli_root)
        code, _out = run_cli(
            [
                "requirement",
                "cancel",
                cli_req,
                "--by",
                "owner",
                "--reason",
                "核对取消",
                "--records-root",
                str(cli_root),
            ],
            capsys,
        )
        assert code == 0

        mail_root = tmp_path / "mail"
        mail_root.mkdir()
        mail_req = _seed(mail_root)
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-1@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
                    body="请取消需求。",
                )
            ],
        )
        _code, _out = run_cli(
            [
                "mail",
                "poll",
                "--once",
                "--project",
                "ForgeLoop",
                "--whitelist",
                "requester@example.com",
                *connection_args(mail_root),
            ],
            capsys,
        )

        cli_facts = _cancel_facts(cli_root, cli_req)
        mail_facts = _cancel_facts(mail_root, mail_req)
        # 记录事实必须一致；入口来源（by）允许不同但都必须留痕。
        assert cli_facts == mail_facts
        assert cli_facts["status"] == "cancelled"
        assert cli_facts["has_decision"] and cli_facts["reason_non_empty"]


class TestApproveParity:
    """批准：CLI 与邮件两条入口必须落在**同一批准记录**（同版本绑定、同来源留痕）。"""

    def _with_plan(self, records_root: Path, text: str) -> str:
        from forgeloop.domain.task_plan import PlannedTask, TaskPlan

        req_id = _seed(records_root, text)
        store = RequirementStore(records_root / "records.sqlite")
        try:
            store.record_task_plan(
                req_id,
                TaskPlan(
                    task_plan_id=f"plan-{req_id}",
                    requirement_id=req_id,
                    project="ForgeLoop",
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
                    created_at=__import__("datetime").datetime(
                        2026, 10, 19, tzinfo=__import__("datetime").UTC
                    ),
                ),
            )
        finally:
            store.close()
        return req_id

    def _approval_facts(self, records_root: Path, req_id: str) -> dict[str, object]:
        store = RequirementStore(records_root / "records.sqlite")
        try:
            approval = store.plan_approval(req_id)
            return {
                "has_approval": approval is not None,
                "plan_version": None if approval is None else approval.plan_version,
                "source_marks_entry": False if approval is None else bool(approval.source),
            }
        finally:
            store.close()

    def test_cli_and_mail_bind_the_same_plan_version(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            connection_args,
            install_transport,
        )

        cli_root = tmp_path / "cli-approve"
        cli_root.mkdir()
        cli_req = self._with_plan(cli_root, "等价性：CLI 批准")
        code, _out = run_cli(
            [
                "requirement",
                "approve",
                cli_req,
                "--by",
                "owner",
                "--source",
                "cli",
                "--records-root",
                str(cli_root),
            ],
            capsys,
        )
        assert code == 0

        mail_root = tmp_path / "mail-approve"
        mail_root.mkdir()
        mail_req = self._with_plan(mail_root, "等价性：邮件批准")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-approve@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
                    body="操作: 批准\n理由: 邮件批准",
                )
            ],
        )
        _code, _out = run_cli(
            [
                "mail",
                "poll",
                "--once",
                "--project",
                "ForgeLoop",
                "--whitelist",
                "requester@example.com",
                *connection_args(mail_root),
            ],
            capsys,
        )

        cli_facts = self._approval_facts(cli_root, cli_req)
        mail_facts = self._approval_facts(mail_root, mail_req)
        # 等价标准：都产生批准、都绑定任务包 v1、都必须留下来源标记。
        assert (
            cli_facts
            == mail_facts
            == {
                "has_approval": True,
                "plan_version": 1,
                "source_marks_entry": True,
            }
        )


class TestStopParity:
    """停止：CLI 与邮件落在同一停止请求记录（任务、操作人、来源都留痕）。"""

    def _approved_with_task(self, records_root: Path, text: str) -> tuple[str, str]:
        from datetime import UTC, datetime

        from forgeloop.domain.task_plan import PlannedTask, TaskPlan
        from forgeloop.graph.worker import current_task_thread_id
        from forgeloop.records.store import RecordStore

        req_id = _seed(records_root, text)
        store = RequirementStore(records_root / "records.sqlite")
        try:
            store.record_task_plan(
                req_id,
                TaskPlan(
                    task_plan_id=f"plan-{req_id}",
                    requirement_id=req_id,
                    project="ForgeLoop",
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
                    created_at=datetime(2026, 10, 19, tzinfo=UTC),
                ),
            )
            store.record_plan_approval(req_id, 1, "owner", source="cli")
        finally:
            store.close()
        task_id = current_task_thread_id(records_root, req_id)
        record_store = RecordStore(records_root / "records.sqlite")
        try:
            record_store.create_task(task_id, "ForgeLoop", text, {"pi_command": "pi"}, 60.0)
        finally:
            record_store.close()
        return req_id, task_id

    def _facts(self, records_root: Path, task_id: str) -> dict[str, object]:
        from forgeloop.records.store import RecordStore

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

    def test_cli_and_mail_record_the_same_stop_facts(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            install_transport,
            poll,
        )

        cli_root = tmp_path / "cli-stop"
        cli_root.mkdir()
        _cli_req, cli_task = self._approved_with_task(cli_root, "等价性：CLI 停止")
        code, _out = run_cli(
            [
                "stop",
                cli_task,
                "--note",
                "现场核对",
                "--by",
                "owner",
                "--source",
                "cli",
                "--records-root",
                str(cli_root),
            ],
            capsys,
        )
        assert code == 0

        mail_root = tmp_path / "mail-stop"
        mail_root.mkdir()
        mail_req, mail_task = self._approved_with_task(mail_root, "等价性：邮件停止")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-stop@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
                    body="操作: 停止\n理由: 现场核对",
                )
            ],
        )
        document = poll(mail_root, capsys, "--whitelist", "requester@example.com")
        entry = next(item for item in document["requirements"] if item["req_id"] == mail_req)
        # 先钉住管道：轮询文档必须把指令带上，否则后面断言失败无法区分是哪一层。
        assert entry["operation"] == "停止", entry

        cli_facts = self._facts(cli_root, cli_task)
        mail_facts = self._facts(mail_root, mail_task)
        # 完整等价：两条入口都产生停止请求、都留下操作人、都记录入口来源。
        assert (
            cli_facts
            == mail_facts
            == {
                "has_request": True,
                "by_non_empty": True,
                "source_non_empty": True,
            }
        )
