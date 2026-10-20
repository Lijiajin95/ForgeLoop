"""场景测试：``mail interact --once`` 的邮箱交互闭环。

覆盖验收（邮箱作为与 CLI 同源的交互入口）：

- 新邮件受理为新需求并回信需求编号与下一步；同一封邮件重复轮询不重复建档、不重复回信；
- 非允许发件人与 ``Auto-Submitted`` 自动回复不执行命令、不回信；
- 回复既有通知可按出向 Message-ID 关联需求，执行 status / revise / approve / help；
- 批准必须显式写出任务包版本，版本不符不写批准；需求修订使旧任务包失效；
- 命令先落库再回信：发送失败留下 ``action_done``，下次轮询只重发同一封回信；
- 进程中断留下的 ``executing`` 现场标记为不确定并在回信中说明，不自动重放。

测试用可控邮箱边界驱动真实 ``MailInteractionGateway`` 与真实记录：IMAP 拉取返回
真实 RFC822 报文字节，SMTP 回信被捕获；适配器解析、命令协议、记录与需求规则都是
真实代码路径，只把外部 socket 换成可控实现（真实 socket 边界另由集成测试覆盖）。
"""

import argparse
import importlib.util
import json
import sqlite3
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest
from project_support import project_records, register_project

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    MailConnectionError,
    MailSendError,
    SmtpMailSender,
)
from forgeloop.cli.main import main as cli_main
from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.domain.status import ActionActor, NextAction
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.planning import AnalysisOutcome, PlanningOutcome
from forgeloop.graph.requirements import RequirementAlreadyRunningError, RequirementProgress
from forgeloop.records.mail_interactions import InteractionState, MailInteractionStore
from forgeloop.records.requirements import RequirementStore

pytestmark = pytest.mark.scenario

PROJECT = "forgeloop"
OWNER = "owner@example.com"
OTHER = "stranger@example.com"
WHEN = datetime(2026, 10, 19, 9, 0, tzinfo=UTC)
ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "export_cli_contract.py"


def load_contract_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_cli_contract", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _covers(documented: dict, actual: dict) -> bool:
    """快照结构是否覆盖实际输出：类型包含、对象键包含、数组递归包含。"""

    if not set(actual.get("type", [])) <= set(documented.get("type", [])):
        return False
    actual_props = actual.get("properties")
    if actual_props is not None:
        documented_props = documented.get("properties")
        if not isinstance(documented_props, dict):
            return False
        for key, node in actual_props.items():
            if key not in documented_props or not _covers(documented_props[key], node):
                return False
    if "item" in actual:
        if "item" not in documented:
            return False
        actual_item = cast("dict[str, Any]", actual["item"])
        if actual_item.get("type") == ["empty-array"]:
            return True
        if not _covers(cast("dict[str, Any]", documented["item"]), actual_item):
            return False
    return True


# --------------------------------------------------------------------------- #
# 可控邮箱边界：捕获回信参数，返回稳定 Message-ID
# --------------------------------------------------------------------------- #


class FakeReceiver:
    def __init__(self, messages: list[bytes]) -> None:
        self._messages = tuple(messages)
        self.folder = "INBOX"
        self.authenticated = 0
        self.closed = False

    def authenticate(self) -> None:
        self.authenticated += 1

    def fetch_unseen(self) -> tuple[bytes, ...]:
        return self._messages

    def close(self) -> None:
        self.closed = True


class FakeSender:
    """捕获回信参数并返回调用方指定的 Message-ID（或生成一个）。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.fail = False

    def send_reply(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        message_id: str = "",
        in_reply_to: str | None = None,
        references: tuple[str, ...] = (),
    ) -> str:
        if self.fail:
            raise MailSendError("SMTP 发送失败（测试注入）")
        delivered = message_id or "<generated@forgeloop.local>"
        self.calls.append(
            {
                "to": to,
                "subject": subject,
                "body": body,
                "message_id": delivered,
                "in_reply_to": in_reply_to,
                "references": references,
            }
        )
        return delivered


class RaisingReceiver(FakeReceiver):
    def authenticate(self) -> None:
        raise MailConnectionError("IMAP 连接失败（测试注入）")


def install_transport(
    monkeypatch: pytest.MonkeyPatch, messages: list[bytes], sender: FakeSender | None = None
) -> tuple[FakeReceiver, FakeSender]:
    receiver = FakeReceiver(messages)
    fake_sender = sender if sender is not None else FakeSender()
    monkeypatch.setattr(
        "forgeloop.cli.mail_interaction._make_receiver",
        lambda args: cast(ImapMailReceiver, receiver),
    )
    monkeypatch.setattr(
        "forgeloop.cli.mail_interaction._make_sender",
        lambda args: cast(SmtpMailSender, fake_sender),
    )
    return receiver, fake_sender


@pytest.fixture(autouse=True)
def registered_project(tmp_path: Path) -> Path:
    """每个用例都先登记项目；``mail interact`` 按项目边界打开记录。"""

    return register_project(tmp_path)


def connection_args(records_root: Path) -> list[str]:
    return [
        "--imap-host",
        "imap.example.com",
        "--imap-user",
        OWNER,
        "--imap-secret",
        "authorization-code",
        "--smtp-host",
        "smtp.example.com",
        "--smtp-user",
        OWNER,
        "--smtp-secret",
        "authorization-code",
        "--smtp-sender",
        OWNER,
        "--smtp-recipient",
        OWNER,
        "--records-root",
        str(records_root),
    ]


def build_message(
    message_id: str,
    *,
    subject: str = "",
    body: str = "",
    sender: str = OWNER,
    in_reply_to: str | None = None,
    references: tuple[str, ...] = (),
    auto_submitted: str | None = None,
) -> bytes:
    message = EmailMessage()
    message["Message-ID"] = message_id
    message["From"] = sender
    message["To"] = OWNER
    message["Subject"] = subject
    message["Date"] = format_datetime(WHEN)
    if in_reply_to is not None:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = " ".join(references)
    if auto_submitted is not None:
        message["Auto-Submitted"] = auto_submitted
    message.set_content(body)
    return message.as_bytes()


def run_interact(
    records_root: Path,
    capsys: pytest.CaptureFixture[str],
    *extra: str,
    sender: str = OWNER,
) -> tuple[int, dict]:
    code = cli_main(
        [
            "mail",
            "interact",
            "--once",
            "--project",
            PROJECT,
            "--allowed-sender",
            sender,
            "--json",
            *extra,
            *connection_args(records_root),
        ]
    )
    captured = capsys.readouterr()
    text = captured.out + captured.err
    if text.strip().startswith("{"):
        return code, json.loads(text)
    return code, {"raw": text}


def seed_requirement(base: Path, text: str = "需求：邮箱交互") -> str:
    store = RequirementStore(project_records(base, PROJECT) / "records.sqlite")
    try:
        return store.submit(PROJECT, text).req_id
    finally:
        store.close()


def seed_plan(base: Path, req_id: str) -> int:
    store = RequirementStore(project_records(base, PROJECT) / "records.sqlite")
    try:
        requirement = store.get(req_id)
        plan = TaskPlan(
            task_plan_id=f"plan-{req_id}-1",
            requirement_id=req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask(
                    task_id="t1",
                    goal="实现邮箱交互入口",
                    files=("src/forgeloop/cli/mail_interaction.py",),
                    acceptance="邮箱可以收发命令",
                    test_command=("pytest", "-q", "tests/scenario/test_mail_interaction.py"),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(req_id, plan)
        return plan.plan_version
    finally:
        store.close()


def requirement_count(base: Path) -> int:
    store = RequirementStore(project_records(base, PROJECT) / "records.sqlite")
    try:
        return len(store.for_project(PROJECT))
    finally:
        store.close()


def requirement_versions(base: Path, req_id: str) -> int:
    store = RequirementStore(project_records(base, PROJECT) / "records.sqlite")
    try:
        return store.get(req_id).version_count
    finally:
        store.close()


def interaction_record(base: Path, message_id: str):
    connection = sqlite3.connect(
        project_records(base, PROJECT) / "records.sqlite", isolation_level=None
    )
    try:
        return MailInteractionStore(connection).get(message_id)
    finally:
        connection.close()


# --------------------------------------------------------------------------- #
# 受理与幂等
# --------------------------------------------------------------------------- #


class TestSubmitAndDedup:
    def test_new_mail_creates_requirement_and_replies(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-1@example.com>", subject="邮箱交互", body="请实现邮箱交互入口")
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        assert document["fetched"] == 1
        assert document["processed"] == 1
        assert document["replied"] == 1
        assert requirement_count(tmp_path) == 1
        assert len(sender.calls) == 1
        reply = sender.calls[0]
        assert reply["to"] == OWNER
        assert "已受理" in str(reply["subject"])
        assert "已受理需求" in str(reply["body"])
        # 未配置 PI 时明确说明下一步不能在邮件里执行，不假装已具备分析能力。
        assert "--pi-command" in str(reply["body"])
        assert reply["in_reply_to"] == "<in-1@example.com>"
        entry = document["interactions"][0]
        assert entry["command"] == "submit"
        assert entry["state"] == "completed"
        assert entry["req_id"]

    def test_repeated_poll_is_idempotent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-2@example.com>", subject="邮箱交互", body="新需求")
        _receiver, sender = install_transport(monkeypatch, [raw])

        first_code, first = run_interact(tmp_path, capsys)
        second_code, second = run_interact(tmp_path, capsys)

        assert first_code == 0 and second_code == 0
        assert first["replied"] == 1
        assert second["processed"] == 0
        assert second["skipped"] == 1
        assert requirement_count(tmp_path) == 1
        # 同一封入向邮件不重复回信。
        assert len(sender.calls) == 1
        assert "未重复执行" in second["interactions"][0]["detail"]

    def test_unauthorized_sender_is_ignored(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-3@example.com>", subject="越权命令", body="status", sender=OTHER)
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        assert requirement_count(tmp_path) == 0
        assert sender.calls == []
        entry = document["interactions"][0]
        assert entry["authorized"] is False
        assert entry["processed"] is False

    def test_auto_submitted_is_ignored(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message(
            "<in-4@example.com>",
            subject="休假自动回复",
            body="status",
            auto_submitted="auto-replied",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert requirement_count(tmp_path) == 0
        assert sender.calls == []
        assert "自动回复" in document["interactions"][0]["detail"]

    def test_help_without_requirement_does_not_create_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-5@example.com>", subject="求助", body="help")
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert requirement_count(tmp_path) == 0
        assert len(sender.calls) == 1
        assert "可用命令" in str(sender.calls[0]["body"])
        assert document["interactions"][0]["command"] == "help"

    def test_unlinked_command_is_rejected_without_creating_requirement(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-6@example.com>", subject="查询", body="status")
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert requirement_count(tmp_path) == 0
        assert len(sender.calls) == 1
        assert "没有关联到需求编号" in str(sender.calls[0]["body"])
        assert document["interactions"][0]["command"] == "status"

    def test_interact_requires_once(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        code = cli_main(
            [
                "mail",
                "interact",
                "--project",
                PROJECT,
                "--allowed-sender",
                OWNER,
                *connection_args(tmp_path),
            ]
        )
        captured = capsys.readouterr()
        assert code == 1
        assert "--once" in captured.out + captured.err


# --------------------------------------------------------------------------- #
# 回复既有需求：status / revise / approve
# --------------------------------------------------------------------------- #


class TestLinkedCommands:
    def _seed_and_ack(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> tuple[str, str, FakeSender]:
        raw = build_message("<seed@example.com>", subject="邮箱交互", body="请实现邮箱交互")
        _receiver, sender = install_transport(monkeypatch, [raw])
        _code, document = run_interact(tmp_path, capsys)
        return (
            document["interactions"][0]["req_id"],
            document["interactions"][0]["reply_message_id"],
            sender,
        )

    def test_status_reply_resolves_by_outbound_message_id(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, reply_message_id, _sender = self._seed_and_ack(tmp_path, monkeypatch, capsys)
        assert reply_message_id

        raw = build_message(
            "<status-1@example.com>",
            subject="Re: [ForgeLoop] 状态",
            body="status",
            in_reply_to=reply_message_id,
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        assert document["interactions"][0]["req_id"] == req_id
        assert document["interactions"][0]["command"] == "status"
        body = str(sender.calls[0]["body"])
        assert f"需求：{req_id}" in body
        assert "下一步" in body

    def test_reply_with_rewritten_message_id_resolves_by_subject(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # 真实邮箱发现：QQ 会重写出向 Message-ID，In-Reply-To 指向服务端生成的 ID；
        # 此时仍须能按主题里的 req-… 关联回原需求。
        req_id, _reply_message_id, _sender = self._seed_and_ack(tmp_path, monkeypatch, capsys)
        raw = build_message(
            "<rewritten@example.com>",
            subject=f"Re: [ForgeLoop][{req_id}][已受理]",
            body="status",
            in_reply_to="<tencent_rewritten@qq.com>",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert document["interactions"][0]["req_id"] == req_id
        assert document["interactions"][0]["command"] == "status"
        assert f"需求：{req_id}" in str(sender.calls[0]["body"])

    def test_plain_reply_appends_requirement_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, reply_message_id, _sender = self._seed_and_ack(tmp_path, monkeypatch, capsys)
        raw = build_message(
            "<revise-1@example.com>",
            subject="Re: [ForgeLoop] 补充",
            body="补充：使用 SQLite 记录",
            references=(reply_message_id,),
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert document["interactions"][0]["command"] == "revise"
        assert requirement_versions(tmp_path, req_id) == 2
        assert "已修订" in str(sender.calls[0]["subject"])

    def test_revise_command_uses_explicit_text(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id, reply_message_id, _sender = self._seed_and_ack(tmp_path, monkeypatch, capsys)
        raw = build_message(
            "<revise-2@example.com>",
            subject="Re: [ForgeLoop] 修订",
            body="revise 补充：只允许白名单发件人",
            references=(reply_message_id,),
        )
        install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert document["interactions"][0]["command"] == "revise"
        assert requirement_versions(tmp_path, req_id) == 2

    def test_approve_binds_plan_version_and_records_email_source(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        version = seed_plan(tmp_path, req_id)
        raw = build_message(
            "<approve-1@example.com>",
            subject=f"[ForgeLoop][{req_id}][任务包]",
            body=f"approve {version}",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            approval = store.plan_approval(req_id, version)
        finally:
            store.close()
        assert approval is not None
        assert approval.approved_by == OWNER
        assert approval.source.startswith("email:")
        assert "已批准" in str(sender.calls[0]["subject"])
        assert document["interactions"][0]["state"] == "completed"

    def test_approve_without_version_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)
        raw = build_message(
            "<approve-2@example.com>",
            subject=f"[ForgeLoop][{req_id}][任务包]",
            body="approve",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            assert store.plan_approval(req_id) is None
        finally:
            store.close()
        assert "必须写出任务包版本" in str(sender.calls[0]["body"])

    def test_approve_with_stale_version_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)
        raw = build_message(
            "<approve-3@example.com>",
            subject=f"[ForgeLoop][{req_id}][任务包]",
            body="approve 9",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            assert store.plan_approval(req_id) is None
        finally:
            store.close()
        assert "版本不匹配" in str(sender.calls[0]["body"])

    def test_natural_language_agreement_is_not_approval(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)
        raw = build_message(
            "<approve-4@example.com>",
            subject=f"[ForgeLoop][{req_id}][任务包]",
            body="同意，可以开始",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            assert store.plan_approval(req_id) is None
        finally:
            store.close()
        # 未识别成命令时按需求修订处理，绝不据此批准。
        assert document["interactions"][0]["command"] == "revise"
        assert "已修订" in str(sender.calls[0]["subject"])


# --------------------------------------------------------------------------- #
# 失败与不确定现场
# --------------------------------------------------------------------------- #


class TestFailureHandling:
    def test_send_failure_keeps_action_done_and_retries_without_reexecution(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<retry-1@example.com>", subject="邮箱交互", body="新需求")
        failing = FakeSender()
        failing.fail = True
        install_transport(monkeypatch, [raw], failing)

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        assert document["replied"] == 0
        assert requirement_count(tmp_path) == 1
        record = interaction_record(tmp_path, "<retry-1@example.com>")
        assert record is not None
        assert record.state is InteractionState.ACTION_DONE
        assert "回信发送失败" in document["interactions"][0]["detail"]

        working = FakeSender()
        install_transport(monkeypatch, [raw], working)
        _code, second = run_interact(tmp_path, capsys)

        assert second["replied"] == 1
        assert requirement_count(tmp_path) == 1
        assert len(working.calls) == 1
        record = interaction_record(tmp_path, "<retry-1@example.com>")
        assert record is not None
        assert record.state is InteractionState.COMPLETED

    def test_interrupted_execution_is_marked_uncertain_and_not_replayed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        message_id = "<uncertain-1@example.com>"
        connection = sqlite3.connect(
            project_records(tmp_path, PROJECT) / "records.sqlite", isolation_level=None
        )
        try:
            MailInteractionStore(connection).claim(message_id, req_id, "revise")
        finally:
            connection.close()
        raw = build_message(
            message_id,
            subject=f"[ForgeLoop][{req_id}][修订]",
            body="revise 这封邮件曾经中断",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert requirement_versions(tmp_path, req_id) == 1
        assert len(sender.calls) == 1
        assert "未自动重放" in str(sender.calls[0]["body"])
        record = interaction_record(tmp_path, message_id)
        assert record is not None
        assert record.state is InteractionState.UNCERTAIN
        assert "未自动重放" in record.detail
        assert document["interactions"][0]["command"] == "revise"

    def test_analyze_without_pi_config_replies_unavailable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<analyze-1@example.com>",
            subject=f"[ForgeLoop][{req_id}][分析]",
            body="analyze",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "未配置 --pi-command" in str(sender.calls[0]["body"])

    def test_imap_failure_is_reported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        receiver = RaisingReceiver([])
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction._make_receiver",
            lambda args: cast(ImapMailReceiver, receiver),
        )
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction._make_sender",
            lambda args: cast(SmtpMailSender, FakeSender()),
        )

        code, document = run_interact(tmp_path, capsys)

        assert code == 1
        assert "IMAP 连接失败" in document["raw"]


# --------------------------------------------------------------------------- #
# argparse 命名空间兼容（避免测试替身与真实解析器漂移）
# --------------------------------------------------------------------------- #


def test_namespace_has_required_fields() -> None:
    from forgeloop.cli.main import build_parser

    args = build_parser().parse_args(
        [
            "mail",
            "interact",
            "--once",
            "--project",
            PROJECT,
            "--allowed-sender",
            OWNER,
            "--imap-host",
            "h",
            "--imap-user",
            "u",
            "--imap-secret",
            "s",
            "--smtp-host",
            "h",
            "--smtp-user",
            "u",
            "--smtp-secret",
            "s",
            "--smtp-sender",
            OWNER,
            "--smtp-recipient",
            OWNER,
        ]
    )
    assert isinstance(args, argparse.Namespace)
    assert args.func.__name__ == "cmd_mail_interact"


# --------------------------------------------------------------------------- #
# PI 相关命令的接线（真实分析/规划/推进由 graph 层测试覆盖，这里验证邮箱编排）
# --------------------------------------------------------------------------- #


class TestPiBackedCommands:
    def test_new_mail_ack_mentions_analyze_when_pi_configured(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<pi-ack@example.com>", subject="邮箱交互 PI", body="新需求")
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        body = str(sender.calls[0]["body"])
        assert "回复 analyze" in body

    def test_analyze_reports_ready_analysis(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        analysis = RequirementAnalysis(
            analysis_version=1,
            requirement_version=1,
            goal="实现邮箱交互",
            scenarios=("场景",),
            acceptance_criteria=("标准",),
            clarifications=(),
            created_at=WHEN,
        )
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction.analyze_requirement",
            lambda context: AnalysisOutcome("draft", analysis, None),
        )
        raw = build_message(
            "<analyze-2@example.com>",
            subject=f"[ForgeLoop][{req_id}][分析]",
            body="analyze",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert code == 0
        assert document["interactions"][0]["command"] == "analyze"
        body = str(sender.calls[0]["body"])
        assert "实现邮箱交互" in body
        assert "回复 plan" in body

    def test_analyze_reports_clarifications(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        analysis = RequirementAnalysis(
            analysis_version=1,
            requirement_version=1,
            goal="实现邮箱交互",
            scenarios=(),
            acceptance_criteria=(),
            clarifications=("使用哪个邮箱服务\uff1f",),
            created_at=WHEN,
        )
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction.analyze_requirement",
            lambda context: AnalysisOutcome("awaiting_clarification", analysis, None),
        )
        raw = build_message(
            "<analyze-3@example.com>",
            subject=f"[ForgeLoop][{req_id}][分析]",
            body="analyze",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        body = str(sender.calls[0]["body"])
        assert "使用哪个邮箱服务\uff1f" in body
        assert "请直接回复本邮件" in body

    def test_plan_reports_approval_command(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            requirement = store.get(req_id)
        finally:
            store.close()
        plan = TaskPlan(
            task_plan_id=f"plan-{req_id}-1",
            requirement_id=req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask(
                    task_id="t1",
                    goal="实现入口",
                    files=("src/forgeloop/cli/mail_interaction.py",),
                    acceptance="可收发",
                    test_command=("pytest", "-q"),
                ),
            ),
            created_at=WHEN,
        )
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction.plan_requirement",
            lambda context: PlanningOutcome("plan_proposed", plan, None),
        )
        raw = build_message(
            "<plan-1@example.com>",
            subject=f"[ForgeLoop][{req_id}][规划]",
            body="plan",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert document["interactions"][0]["command"] == "plan"
        body = str(sender.calls[0]["body"])
        assert "任务包 v1" in body
        assert "approve 1" in body

    def test_advance_reports_progress_from_executor(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)

        class FakeExecutor:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            def _progress(self) -> RequirementProgress:
                return RequirementProgress(
                    req_id=req_id,
                    plan_version=1,
                    requirement_status="executing",
                    current_task="t1",
                    completed_tasks=(),
                    blocked_reason="",
                    next_step=NextAction("等待验收", ActionActor.USER, "任务等待验收"),
                )

            def advance(self) -> RequirementProgress:
                return self._progress()

            def progress(self) -> RequirementProgress:
                return self._progress()

        monkeypatch.setattr("forgeloop.cli.mail_interaction.RequirementExecutor", FakeExecutor)
        raw = build_message(
            "<advance-1@example.com>",
            subject=f"[ForgeLoop][{req_id}][推进]",
            body="advance",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert code == 0
        assert document["interactions"][0]["command"] == "advance"
        body = str(sender.calls[0]["body"])
        assert "当前任务：t1" in body
        assert "等待验收" in body

    def test_invalid_pi_command_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        code, document = run_interact(tmp_path, capsys, "--pi-command", "not-json")

        assert code == 1
        assert "--pi-command" in document["raw"]


# --------------------------------------------------------------------------- #
# 整体验收与只读边界
# --------------------------------------------------------------------------- #


class TestAcceptanceCommand:
    def test_accept_without_delivery_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)
        raw = build_message(
            "<accept-1@example.com>",
            subject=f"[ForgeLoop][{req_id}][验收]",
            body="accept",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert document["interactions"][0]["command"] == "accept"
        assert "尚无已消费的验收材料" in str(sender.calls[0]["body"])
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            assert store.requirement_status(req_id) != "accepted"
        finally:
            store.close()

    def test_accept_when_already_accepted_is_idempotent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            store.set_requirement_status(req_id, "accepted", "")
        finally:
            store.close()
        raw = build_message(
            "<accept-2@example.com>",
            subject=f"[ForgeLoop][{req_id}][验收]",
            body="验收",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "已经完成整体验收" in str(sender.calls[0]["body"])

    def test_status_for_unknown_requirement_is_reported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message(
            "<status-unknown@example.com>",
            subject="[ForgeLoop][req-20260101000000-abcdef][状态]",
            body="status",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert "需求不存在" in str(sender.calls[0]["body"])
        assert document["interactions"][0]["replied"] is True

    def test_unparseable_mail_is_reported_without_crash(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = b"From: owner@example.com\r\nSubject: no message id\r\n\r\nbody"
        install_transport(monkeypatch, [raw])

        code, document = run_interact(tmp_path, capsys)

        assert code == 0
        assert document["fetched"] == 1
        assert document["processed"] == 0
        assert any("无法解析邮件" in error for error in document["errors"])


# --------------------------------------------------------------------------- #
# 边界分支：配置错误、空正文、终态与文本输出
# --------------------------------------------------------------------------- #


def run_interact_cli(
    base: Path,
    *,
    project: str = PROJECT,
    json_output: bool = True,
    extra: tuple[str, ...] = (),
) -> int:
    argv = [
        "mail",
        "interact",
        "--once",
        "--project",
        project,
        "--allowed-sender",
        OWNER,
    ]
    if json_output:
        argv.append("--json")
    argv.extend(extra)
    argv.extend(connection_args(base))
    return cli_main(argv)


class TestEdgeBranches:
    def test_subject_only_mail_becomes_requirement(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<subject-only@example.com>", subject="只有主题的需求", body="")
        install_transport(monkeypatch, [raw])

        code, _document = run_interact(tmp_path, capsys)

        assert code == 0
        assert requirement_count(tmp_path) == 1

    def test_empty_mail_is_not_admitted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<empty@example.com>", subject="", body="")
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert requirement_count(tmp_path) == 0
        assert sender.calls == []
        assert document["interactions"][0]["state"] == "failed"

    def test_pi_command_must_be_nonempty_string_array(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        for raw in ("[]", "[1]", '"pi"'):
            code = run_interact_cli(tmp_path, extra=("--pi-command", raw))
            assert code == 1
            assert "非空字符串数组" in capsys.readouterr().err

    def test_references_only_reply_resolves_requirement(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<seed-ref@example.com>", subject="邮箱交互", body="请实现邮箱交互")
        _receiver, sender = install_transport(monkeypatch, [raw])
        _code, document = run_interact(tmp_path, capsys)
        req_id = document["interactions"][0]["req_id"]
        ack = str(sender.calls[0]["message_id"])

        reply = build_message(
            "<refs-only@example.com>",
            subject="Re: 无关联主题",
            body="status",
            references=(ack,),
        )
        install_transport(monkeypatch, [reply])
        _code, second = run_interact(tmp_path, capsys)

        assert second["interactions"][0]["req_id"] == req_id
        assert second["interactions"][0]["command"] == "status"

    def test_revise_without_text_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<revise-empty@example.com>",
            subject=f"[ForgeLoop][{req_id}][修订]",
            body="revise",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert requirement_versions(tmp_path, req_id) == 1
        assert "没有可追加的内容" in str(sender.calls[0]["body"])

    def test_revise_unknown_requirement_is_reported_as_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message(
            "<revise-unknown@example.com>",
            subject="[ForgeLoop][req-20260101000000-abcdef][修订]",
            body="revise 内容",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "命令处理失败" in str(sender.calls[0]["body"])

    def test_approve_without_plan_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<approve-noplan@example.com>",
            subject=f"[ForgeLoop][{req_id}][批准]",
            body="approve 1",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "还没有任务包" in str(sender.calls[0]["body"])

    def test_accept_without_plan_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<accept-noplan@example.com>",
            subject=f"[ForgeLoop][{req_id}][验收]",
            body="accept",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "还没有任务包" in str(sender.calls[0]["body"])

    def test_accept_for_rejected_requirement_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            store.set_requirement_status(req_id, "rejected", "")
        finally:
            store.close()
        raw = build_message(
            "<accept-rejected@example.com>",
            subject=f"[ForgeLoop][{req_id}][验收]",
            body="accept",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "不能再次验收" in str(sender.calls[0]["body"])

    def test_help_for_existing_requirement(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<help-existing@example.com>",
            subject=f"[ForgeLoop][{req_id}][帮助]",
            body="help",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert document["interactions"][0]["req_id"] == req_id
        assert "可用命令" in str(sender.calls[0]["body"])

    def test_status_shows_blocked_reason_and_clarifications(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            store.record_analysis(
                req_id,
                RequirementAnalysis(
                    analysis_version=1,
                    requirement_version=1,
                    goal="目标",
                    scenarios=(),
                    acceptance_criteria=(),
                    clarifications=("需要澄清的问题",),
                    created_at=WHEN,
                ),
            )
            store.set_requirement_status(req_id, "awaiting_clarification", "等待答复")
        finally:
            store.close()
        raw = build_message(
            "<status-blocked@example.com>",
            subject=f"[ForgeLoop][{req_id}][状态]",
            body="status",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        body = str(sender.calls[0]["body"])
        assert "阻塞原因：等待答复" in body
        assert "需要澄清的问题" in body

    def test_analyze_halted_is_reported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction.analyze_requirement",
            lambda context: AnalysisOutcome("blocked", None, "分析被阻塞"),
        )
        raw = build_message(
            "<analyze-halted@example.com>",
            subject=f"[ForgeLoop][{req_id}][分析]",
            body="analyze",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert "分析未完成：分析被阻塞" in str(sender.calls[0]["body"])

    def test_plan_halted_is_reported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        monkeypatch.setattr(
            "forgeloop.cli.mail_interaction.plan_requirement",
            lambda context: PlanningOutcome("blocked", None, "规划被阻塞"),
        )
        raw = build_message(
            "<plan-halted@example.com>",
            subject=f"[ForgeLoop][{req_id}][规划]",
            body="plan",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert "任务规划未完成：规划被阻塞" in str(sender.calls[0]["body"])

    def test_advance_without_pi_config_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        raw = build_message(
            "<advance-nopi@example.com>",
            subject=f"[ForgeLoop][{req_id}][推进]",
            body="advance",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys)

        assert "未配置 --pi-command，无法推进" in str(sender.calls[0]["body"])

    def test_advance_terminal_requirement_does_not_execute(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)
        store = RequirementStore(project_records(tmp_path, PROJECT) / "records.sqlite")
        try:
            store.set_requirement_status(req_id, "accepted", "")
        finally:
            store.close()

        class FakeExecutor:
            def __init__(self, *args: object, **kwargs: object) -> None:
                self.called = False

            def advance(self) -> RequirementProgress:
                self.called = True
                raise AssertionError("终态需求不得推进")

            def progress(self) -> RequirementProgress:
                return RequirementProgress(
                    req_id=req_id,
                    plan_version=1,
                    requirement_status="accepted",
                    current_task=None,
                    completed_tasks=("t1",),
                    blocked_reason="",
                    next_step=NextAction("归并并发布", ActionActor.AGENT, "需求整体验收已完成"),
                )

        monkeypatch.setattr("forgeloop.cli.mail_interaction.RequirementExecutor", FakeExecutor)
        raw = build_message(
            "<advance-terminal@example.com>",
            subject=f"[ForgeLoop][{req_id}][推进]",
            body="advance",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert "不再推进" in str(sender.calls[0]["body"])

    def test_advance_reports_already_running(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        seed_plan(tmp_path, req_id)

        class FakeExecutor:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            def advance(self) -> RequirementProgress:
                raise RequirementAlreadyRunningError(req_id)

            def progress(self) -> RequirementProgress:
                return RequirementProgress(
                    req_id=req_id,
                    plan_version=1,
                    requirement_status="executing",
                    current_task="t1",
                    completed_tasks=(),
                    blocked_reason="",
                    next_step=NextAction("等待", ActionActor.USER, "占用中"),
                )

        monkeypatch.setattr("forgeloop.cli.mail_interaction.RequirementExecutor", FakeExecutor)
        raw = build_message(
            "<advance-running@example.com>",
            subject=f"[ForgeLoop][{req_id}][推进]",
            body="advance",
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, _document = run_interact(tmp_path, capsys, "--pi-command", '["fake-pi"]')

        assert "推进未启动" in str(sender.calls[0]["body"])

    def test_uncertain_reply_is_not_resent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        message_id = "<uncertain-again@example.com>"
        connection = sqlite3.connect(
            project_records(tmp_path, PROJECT) / "records.sqlite", isolation_level=None
        )
        try:
            MailInteractionStore(connection).claim(message_id, req_id, "status")
        finally:
            connection.close()
        raw = build_message(message_id, subject=f"[ForgeLoop][{req_id}][状态]", body="status")
        _receiver, first_sender = install_transport(monkeypatch, [raw])

        _code, first = run_interact(tmp_path, capsys)

        assert first["replied"] == 1
        assert len(first_sender.calls) == 1

        _receiver, second_sender = install_transport(monkeypatch, [raw])
        _code, second = run_interact(tmp_path, capsys)

        assert second["replied"] == 0
        assert second_sender.calls == []

    def test_failed_interaction_is_not_reprocessed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path)
        message_id = "<failed-before@example.com>"
        connection = sqlite3.connect(
            project_records(tmp_path, PROJECT) / "records.sqlite", isolation_level=None
        )
        try:
            store = MailInteractionStore(connection)
            store.claim(message_id, req_id, "status")
            store.mark_failed(message_id, "注入失败")
        finally:
            connection.close()
        raw = build_message(message_id, subject=f"[ForgeLoop][{req_id}][状态]", body="status")
        _receiver, sender = install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        assert sender.calls == []
        assert document["interactions"][0]["state"] == "failed"
        assert "注入失败" in document["interactions"][0]["detail"]

    def test_unregistered_project_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        code = run_interact_cli(tmp_path, project="other-project")
        captured = capsys.readouterr()
        assert code == 1
        assert "项目未登记" in captured.err

    def test_project_path_mismatch_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        code = run_interact_cli(tmp_path, extra=("--project-path", str(tmp_path / "other")))
        captured = capsys.readouterr()
        assert code == 1
        assert "不一致" in captured.err

    def test_text_output_lists_results(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<text-mode@example.com>", subject="邮箱交互", body="新需求")
        install_transport(monkeypatch, [raw])

        code = run_interact_cli(tmp_path, json_output=False)

        captured = capsys.readouterr()
        assert code == 0
        assert "已拉取 1 封" in captured.out
        assert "已回信" in captured.out


class TestContractSnapshot:
    def test_snapshot_covers_live_interact_output(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<contract@example.com>", subject="邮箱交互", body="新需求")
        install_transport(monkeypatch, [raw])

        _code, document = run_interact(tmp_path, capsys)

        gate = load_contract_gate()
        snapshot = json.loads(
            (ROOT / "contracts" / "cli-contract.json").read_text(encoding="utf-8")
        )
        assert "mail_interact_document" in snapshot
        assert _covers(snapshot["mail_interact_document"], gate.shape(document))
