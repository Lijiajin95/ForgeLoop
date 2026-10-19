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
