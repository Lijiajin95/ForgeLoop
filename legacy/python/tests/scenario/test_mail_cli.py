"""场景测试：``mail poll --once`` 交接 cron、人工确认发信与三类反馈。

覆盖验收（t4-cli-mail）：

- ``mail poll --once`` 可作为 cron 单次执行入口；重复执行按入向 Message-ID 与
  出向绑定幂等，不重复建档、不重复发信；
- 系统先给出消歧 / 不接纳候选 / 接纳成功三类分类建议，但**发信动作与不接纳最终
  决定都只在人工确认后执行**；
- 三类反馈可通过稳定主题标记与固定正文识别；
- 一封需求邮件只产生一条初始反馈；
- CLI 契约快照覆盖 ``mail poll --once --json`` 与 ``mail confirm --json`` 的输出结构。

测试用内存假邮箱边界驱动真实 ``MailAdapter`` 与真实记录：IMAP 拉取返回真实
RFC822 报文字节，SMTP 发送被捕获；适配器、领域规则、记录写入都是真实代码路径，
只把外部 socket 边界替换为可控实现（真实 socket 边界另由 t3 集成测试覆盖）。
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
from project_support import project_records, register_project, requirement_store

from forgeloop.adapter.mail import (
    ImapMailReceiver,
    InboundResult,
    MailConnectionError,
    MailSendError,
    PollReport,
    SmtpMailSender,
)
from forgeloop.cli.mail import (
    _build_feedback,
    _make_receiver,
    _make_sender,
    _pending_entries,
    _secret,
    _suggestion_for,
    identify_feedback,
)
from forgeloop.cli.main import main as cli_main
from forgeloop.domain.mail import Classification, DisambiguationQuestion
from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.records.mail_threads import MailThreadStore

pytestmark = pytest.mark.scenario

PROJECT = "forgeloop"
WHEN = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)
SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "export_cli_contract.py"
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def isolate_mail_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """隔离开发机的生效邮件配置：否则本机 whitelist 会过滤掉测试发件人。"""

    config = tmp_path / "mail.toml"
    config.write_text(
        'provider = "qq"\nsender = "system@example.com"\nrecipient = "owner@example.com"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("FORGELOOP_MAIL_CONFIG", str(config))


# --------------------------------------------------------------------------- #
# 可控邮箱边界：真实适配器与领域路径，只替换 IMAP/SMTP socket
# --------------------------------------------------------------------------- #


class FakeReceiver:
    """单次轮询返回固定报文字节；接口与 ``ImapMailReceiver`` 一致。"""

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
    """捕获真实 ``EmailMessage`` 并返回其 ``Message-ID``。"""

    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []

    @property
    def sender(self) -> str:
        return "owner@example.com"

    @property
    def recipient(self) -> str:
        return "owner@example.com"

    def send(self, message: EmailMessage) -> str:
        self.sent.append(message)
        return str(message["Message-ID"])


class RaisingReceiver(FakeReceiver):
    """认证即失败：驱动 ``mail poll`` 的适配器错误分支。"""

    def authenticate(self) -> None:
        raise MailConnectionError("IMAP 认证失败（测试注入）")


class FailingSender(FakeSender):
    """发送即失败：驱动 ``mail confirm`` 的适配器错误分支。"""

    def send(self, message: EmailMessage) -> str:
        raise MailSendError("SMTP 发送失败（测试注入）")


def install_transport(
    monkeypatch: pytest.MonkeyPatch, messages: list[bytes]
) -> tuple[FakeReceiver, FakeSender]:
    receiver = FakeReceiver(messages)
    sender = FakeSender()
    monkeypatch.setattr(
        "forgeloop.cli.mail._make_receiver",
        lambda args: cast(ImapMailReceiver, receiver),
    )
    monkeypatch.setattr(
        "forgeloop.cli.mail._make_sender",
        lambda args: cast(SmtpMailSender, sender),
    )
    return receiver, sender


def connection_args(records_root: Path) -> list[str]:
    return [
        "--imap-host",
        "imap.example.com",
        "--imap-user",
        "owner@example.com",
        "--imap-secret",
        "authorization-code",
        "--smtp-host",
        "smtp.example.com",
        "--smtp-user",
        "owner@example.com",
        "--smtp-secret",
        "authorization-code",
        "--smtp-sender",
        "owner@example.com",
        "--smtp-recipient",
        "owner@example.com",
        "--records-root",
        str(records_root),
    ]


def run_cli(argv: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def build_message(
    message_id: str | None,
    *,
    subject: str = "",
    body: str = "",
    in_reply_to: str | None = None,
    references: tuple[str, ...] = (),
) -> bytes:
    message = EmailMessage()
    if message_id is not None:
        message["Message-ID"] = message_id
    message["From"] = "requester@example.com"
    message["To"] = "owner@example.com"
    message["Subject"] = subject
    message["Date"] = format_datetime(WHEN)
    if in_reply_to is not None:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = " ".join(references)
    message.set_content(body)
    return message.as_bytes()


def seed_requirement(
    records_root: Path,
    text: str,
    *,
    clarifications: tuple[str, ...] = (),
) -> str:
    """建立一个需求并写入一次分析；有待澄清项时即为「缺关键信息」。"""

    store = requirement_store(records_root, legacy_project=PROJECT)
    try:
        requirement = store.submit(PROJECT, text)
        analysis = RequirementAnalysis(
            analysis_version=1,
            requirement_version=1,
            goal="目标",
            scenarios=() if clarifications else ("业务场景",),
            acceptance_criteria=() if clarifications else ("验收标准",),
            clarifications=clarifications,
            created_at=WHEN,
        )
        store.record_analysis(requirement.req_id, analysis)
        return requirement.req_id
    finally:
        store.close()


def requirement_ids(records_root: Path) -> list[str]:
    store = requirement_store(records_root, legacy_project=PROJECT)
    try:
        return [requirement.req_id for requirement in store.for_project(PROJECT)]
    finally:
        store.close()


def poll(
    records_root: Path,
    capsys: pytest.CaptureFixture[str],
    *extra: str,
) -> dict:
    register_project(records_root, legacy_project=PROJECT)
    code, out = run_cli(
        [
            "mail",
            "poll",
            "--once",
            "--project",
            PROJECT,
            "--json",
            *extra,
            *connection_args(records_root),
        ],
        capsys,
    )
    assert code == 0, out
    return json.loads(out)


def confirm(
    records_root: Path,
    capsys: pytest.CaptureFixture[str],
    req_id: str,
    *extra: str,
) -> tuple[int, dict]:
    code, out = run_cli(
        ["mail", "confirm", req_id, *extra, "--json", *connection_args(records_root)],
        capsys,
    )
    document = json.loads(out) if out.strip().startswith("{") else {"raw": out}
    return code, document


# --------------------------------------------------------------------------- #
# cron 单次入口与幂等
# --------------------------------------------------------------------------- #


class TestPollOnce:
    def test_new_mail_creates_requirement_and_only_suggests(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message(
            "<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        document = poll(tmp_path, capsys)

        assert document["fetched"] == 1
        assert document["registered"] == 1
        assert len(document["requirements"]) == 1
        entry = document["requirements"][0]
        assert entry["suggestion"]["kind"] == Classification.DISAMBIGUATE.value
        assert entry["awaiting_human_confirmation"] is True
        assert entry["initial_feedback_sent"] is False
        # 系统只给建议，绝不自动发信。
        assert sender.sent == []
        assert len(requirement_ids(tmp_path)) == 1

    def test_repeated_poll_is_idempotent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message(
            "<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
        )
        _receiver, sender = install_transport(monkeypatch, [raw])

        first = poll(tmp_path, capsys)
        second = poll(tmp_path, capsys)

        assert first["registered"] == 1
        assert second["registered"] == 0
        assert len(requirement_ids(tmp_path)) == 1
        assert sender.sent == []

        connection = sqlite3.connect(
            project_records(tmp_path) / "records.sqlite", isolation_level=None
        )
        thread_store = MailThreadStore(connection)
        try:
            req_id = first["requirements"][0]["req_id"]
            assert len(thread_store.inbound(req_id)) == 1
        finally:
            connection.close()

    def test_three_classification_suggestions(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        in_scope = seed_requirement(tmp_path, "需求：完整且在范围内")
        out_of_scope = seed_requirement(tmp_path, "需求：完整但越界")
        messages = [
            build_message(
                "<in-new@example.com>", subject="[ForgeLoop] 新需求", body="信息还不完整"
            ),
            build_message(
                "<in-scope@example.com>",
                subject="补充回复",
                body="信息齐全",
                in_reply_to=f"<{in_scope}@forgeloop.local>",
            ),
            build_message(
                "<in-scope-out@example.com>",
                subject="补充回复",
                body="信息齐全但越界",
                in_reply_to=f"<{out_of_scope}@forgeloop.local>",
            ),
        ]
        install_transport(monkeypatch, messages)

        document = poll(tmp_path, capsys, "--out-of-scope", out_of_scope)

        by_reference = {
            entry["req_id"]: entry["suggestion"]["kind"] for entry in document["requirements"]
        }
        assert by_reference[in_scope] == Classification.ACCEPT_SUCCESS.value
        assert by_reference[out_of_scope] == Classification.NOT_ACCEPT_CANDIDATE.value
        new_req = next(
            req for req in requirement_ids(tmp_path) if req not in {in_scope, out_of_scope}
        )
        assert by_reference[new_req] == Classification.DISAMBIGUATE.value
        assert {
            Classification.DISAMBIGUATE.value,
            Classification.NOT_ACCEPT_CANDIDATE.value,
            Classification.ACCEPT_SUCCESS.value,
        } == set(by_reference.values())

    def test_poll_without_once_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        code, out = run_cli(
            ["mail", "poll", "--project", PROJECT, "--json", *connection_args(tmp_path)],
            capsys,
        )
        assert code == 1
        assert "--once" in out

    def test_new_mail_without_subject_uses_body_as_text(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-body@example.com>", subject="", body="只有正文的需求描述")
        install_transport(monkeypatch, [raw])

        document = poll(tmp_path, capsys)

        assert document["registered"] == 1
        req_id = document["requirements"][0]["req_id"]
        store = requirement_store(tmp_path, legacy_project=PROJECT)
        try:
            assert store.get(req_id).original_text == "只有正文的需求描述"
        finally:
            store.close()

    def test_poll_reports_adapter_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        register_project(tmp_path, legacy_project=PROJECT)
        monkeypatch.setattr(
            "forgeloop.cli.mail._make_receiver",
            lambda args: cast(ImapMailReceiver, RaisingReceiver([])),
        )

        code, out = run_cli(
            ["mail", "poll", "--once", "--project", PROJECT, "--json", *connection_args(tmp_path)],
            capsys,
        )

        assert code == 1
        assert "IMAP 认证失败" in out


# --------------------------------------------------------------------------- #
# 人工确认发信与三类反馈识别
# --------------------------------------------------------------------------- #


class TestHumanConfirmation:
    def test_disambiguation_confirm_sends_once_and_is_stable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        _receiver, sender = install_transport(
            monkeypatch,
            [build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")],
        )
        document = poll(tmp_path, capsys)
        req_id = document["requirements"][0]["req_id"]

        code, first = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=请补充使用场景"
        )
        assert code == 0
        assert first["sent"] is True
        assert first["already_sent"] is False
        assert len(sender.sent) == 1

        message = sender.sent[0]
        assert identify_feedback(str(message["Subject"]), str(message.get_content())) is (
            Classification.DISAMBIGUATE
        )

        # 重复确认同一类型不再发信，保证「一封需求邮件只产生一条初始反馈」。
        code, second = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=重复"
        )
        assert code == 0
        assert second["sent"] is False
        assert second["already_sent"] is True
        assert len(sender.sent) == 1

        # 已反馈后再次轮询：不再提示待确认，也不重复建档。
        again = poll(tmp_path, capsys)
        entry = again["requirements"][0]
        assert entry["initial_feedback_sent"] is True
        assert entry["awaiting_human_confirmation"] is False
        assert again["registered"] == 0

    def test_one_feedback_per_inbound_keeps_next_disambiguation_round(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        initial = build_message(
            "<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
        )
        _receiver, sender = install_transport(monkeypatch, [initial])
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]
        _code, first = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=补充使用场景"
        )
        assert first["sent"] is True

        # 同一入向重复确认不再发信。
        _code, repeat = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=重复"
        )
        assert repeat["already_sent"] is True

        # 新一轮回复到达后轮询登记，放开下一轮消歧确认。
        reply = build_message(
            "<in-2@example.com>",
            subject="回复",
            body="补充说明",
            in_reply_to=f"<{req_id}@forgeloop.local>",
        )
        _receiver, sender = install_transport(monkeypatch, [initial, reply])
        again = poll(tmp_path, capsys)
        assert again["registered"] == 1
        assert again["requirements"][0]["awaiting_human_confirmation"] is True

        _code, second = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q2=再补充"
        )
        assert second["sent"] is True
        assert len(sender.sent) == 1  # 新装配的发送端收到第二轮消歧邮件

    def test_disambiguation_round_limit_returns_to_human(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        initial = build_message(
            "<in-0@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
        )
        _receiver, _sender = install_transport(monkeypatch, [initial])
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]

        replies: list[bytes] = []
        for index in range(1, 4):
            replies.append(
                build_message(
                    f"<in-{index}@example.com>",
                    subject="回复",
                    body=f"补充说明 {index}",
                    in_reply_to=f"<{req_id}@forgeloop.local>",
                )
            )
            install_transport(monkeypatch, [initial, *replies])
            poll(tmp_path, capsys)
            code, result = confirm(
                tmp_path, capsys, req_id, "--action", "disambiguate", "--question", f"Q{index}=补充"
            )
            assert code == 0
            assert result["sent"] is True

        # 第三轮消歧后又有新回复到达，此时轮次已达上限：轮询不再提示待确认。
        fourth = build_message(
            "<in-4@example.com>",
            subject="回复",
            body="补充说明 4",
            in_reply_to=f"<{req_id}@forgeloop.local>",
        )
        install_transport(monkeypatch, [initial, *replies, fourth])
        document = poll(tmp_path, capsys)
        entry = document["requirements"][0]
        assert entry["suggestion"]["kind"] == Classification.DISAMBIGUATE.value
        assert entry["awaiting_human_confirmation"] is False

        code, result = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q4=补充"
        )
        assert code == 1
        assert "上限" in result["raw"]

    def test_accept_feedback_is_stably_identifiable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path, "需求：完整且在范围内")
        _receiver, sender = install_transport(
            monkeypatch,
            [
                build_message(
                    "<in-accept@example.com>",
                    subject="补充回复",
                    body="信息齐全",
                    in_reply_to=f"<{req_id}@forgeloop.local>",
                )
            ],
        )
        # 人工路径：显式关闭自动回复，验证 confirm 仍能稳定发出并绑定线索
        # （自动回复默认开启后，轮询会自己把接纳回执发出去，见 TestAutoReply）。
        document = poll(tmp_path, capsys, "--no-auto-reply")
        assert document["requirements"][0]["suggestion"]["kind"] == (
            Classification.ACCEPT_SUCCESS.value
        )

        code, result = confirm(tmp_path, capsys, req_id, "--action", "accept")
        assert code == 0
        assert result["sent"] is True
        message = sender.sent[0]
        assert identify_feedback(str(message["Subject"]), str(message.get_content())) is (
            Classification.ACCEPT_SUCCESS
        )

        # 终态后再次轮询：无新建议、无需人工确认，也不再建档。
        again = poll(tmp_path, capsys)
        entry = again["requirements"][0]
        assert entry["terminal"] is True
        assert entry["suggestion"] is None
        assert entry["awaiting_human_confirmation"] is False
        assert again["registered"] == 0

    def test_not_accept_requires_explicit_final_decision(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path, "需求：完整但越界")
        _receiver, sender = install_transport(monkeypatch, [])

        # 缺少显式最终确认：拒绝，且不发信。
        code, _ = confirm(tmp_path, capsys, req_id, "--action", "not_accept", "--reason", "越界")
        assert code == 1
        assert sender.sent == []

        code, result = confirm(
            tmp_path,
            capsys,
            req_id,
            "--action",
            "not_accept",
            "--reason",
            "不在受理范围",
            "--final-not-accept",
        )
        assert code == 0
        assert result["sent"] is True
        message = sender.sent[0]
        assert identify_feedback(str(message["Subject"]), str(message.get_content())) is (
            Classification.NOT_ACCEPT_CANDIDATE
        )

    def test_terminal_feedback_blocks_further_feedback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        req_id = seed_requirement(tmp_path, "需求：完整且在范围内")
        _receiver, sender = install_transport(monkeypatch, [])
        code, _ = confirm(tmp_path, capsys, req_id, "--action", "accept")
        assert code == 0

        code, _ = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=x"
        )
        assert code == 1
        assert len(sender.sent) == 1

    def test_confirm_rejects_malformed_question(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out = run_cli(
            [
                "mail",
                "confirm",
                "req-1",
                "--action",
                "disambiguate",
                "--question",
                "=",
                "--json",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "问题编号不能为空" in out

    def test_confirm_requires_question_for_disambiguation(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        code, out = run_cli(
            [
                "mail",
                "confirm",
                "req-1",
                "--action",
                "disambiguate",
                "--json",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "至少要给出一个" in out

    def test_confirm_reports_send_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        raw = build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")
        install_transport(monkeypatch, [raw])
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]
        monkeypatch.setattr(
            "forgeloop.cli.mail._make_sender",
            lambda args: cast(SmtpMailSender, FailingSender()),
        )

        code, out = run_cli(
            [
                "mail",
                "confirm",
                req_id,
                "--action",
                "disambiguate",
                "--question",
                "Q1=补充",
                "--json",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "SMTP 发送失败" in out


# --------------------------------------------------------------------------- #
# 人类可读输出（非 --json 分支）
# --------------------------------------------------------------------------- #


class TestHumanReadableOutput:
    def test_poll_lists_errors_and_pending_actions(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        messages = [
            build_message(
                "<in-ok@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
            ),
            build_message(None, subject="无编号", body="无法解析的信"),
        ]
        install_transport(monkeypatch, messages)
        register_project(tmp_path, legacy_project=PROJECT)

        code, out = run_cli(
            ["mail", "poll", "--once", "--project", PROJECT, *connection_args(tmp_path)],
            capsys,
        )

        assert code == 0
        assert "已拉取 2 封，登记 1 封。" in out
        assert "未能解析" in out
        assert "分类建议: disambiguate" in out
        assert "待人工确认" in out

    def test_poll_without_mail_prints_empty_summary(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(monkeypatch, [])
        register_project(tmp_path, legacy_project=PROJECT)

        code, out = run_cli(
            ["mail", "poll", "--once", "--project", PROJECT, *connection_args(tmp_path)],
            capsys,
        )

        assert code == 0
        assert "已拉取 0 封，登记 0 封。" in out

    def test_poll_after_feedback_hides_confirmation(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(
            monkeypatch,
            [build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")],
        )
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]
        confirm(tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=补充")

        code, out = run_cli(
            ["mail", "poll", "--once", "--project", PROJECT, *connection_args(tmp_path)],
            capsys,
        )

        assert code == 0
        assert "分类建议" in out
        assert "待人工确认" not in out

    def test_confirm_prints_sent_receipt(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(
            monkeypatch,
            [build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")],
        )
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]

        code, out = run_cli(
            [
                "mail",
                "confirm",
                req_id,
                "--action",
                "disambiguate",
                "--question",
                "Q1=补充",
                *connection_args(tmp_path),
            ],
            capsys,
        )

        assert code == 0
        assert "已发送" in out
        assert "Message-ID:" in out
        assert "原因:" in out

    def test_confirm_prints_repeat_receipt(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(
            monkeypatch,
            [build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")],
        )
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]
        argv = [
            "mail",
            "confirm",
            req_id,
            "--action",
            "disambiguate",
            "--question",
            "Q1=补充",
            *connection_args(tmp_path),
        ]
        run_cli(argv, capsys)

        code, out = run_cli(argv, capsys)

        assert code == 0
        assert "已发送过，未重复发送" in out
        assert "Message-ID:" not in out


# --------------------------------------------------------------------------- #
# 辅助函数边界：环境口令、适配器装配、建议与跳过分支
# --------------------------------------------------------------------------- #


class TestHelperEdges:
    def test_secret_prefers_explicit_then_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FORGELOOP_IMAP_SECRET", "env-code")
        assert _secret("explicit", "FORGELOOP_IMAP_SECRET") == "explicit"
        assert _secret("", "FORGELOOP_IMAP_SECRET") == "env-code"
        assert _secret("", "FORGELOOP_UNSET_SECRET") == ""

    def test_transport_factories_build_from_arguments(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FORGELOOP_IMAP_SECRET", "env-imap")
        monkeypatch.setenv("FORGELOOP_SMTP_SECRET", "env-smtp")
        args = argparse.Namespace(
            imap_host="imap.example.com",
            imap_port=993,
            imap_user="user@example.com",
            imap_secret="",
            imap_folder="INBOX",
            no_imap_ssl=False,
            smtp_host="smtp.example.com",
            smtp_port=465,
            smtp_user="user@example.com",
            smtp_secret="",
            smtp_sender="user@example.com",
            smtp_recipient="owner@example.com",
            no_smtp_ssl=False,
            smtp_starttls=False,
        )

        receiver = _make_receiver(args)
        sender = _make_sender(args)

        assert isinstance(receiver, ImapMailReceiver)
        assert receiver.folder == "INBOX"
        assert sender.sender == "user@example.com"
        assert sender.recipient == "owner@example.com"

    def test_suggestion_for_unknown_requirement_is_disambiguate(self, tmp_path: Path) -> None:
        store = requirement_store(tmp_path, legacy_project=PROJECT)
        try:
            suggestion = _suggestion_for(store, "req-missing", frozenset())
        finally:
            store.close()
        assert suggestion.kind is Classification.DISAMBIGUATE

    def test_pending_entries_skips_unresolved_results(self, tmp_path: Path) -> None:
        register_project(tmp_path, legacy_project=PROJECT)
        connection = sqlite3.connect(
            project_records(tmp_path) / "records.sqlite", isolation_level=None
        )
        store = requirement_store(tmp_path, legacy_project=PROJECT)
        try:
            report = PollReport(
                fetched=1,
                registered=0,
                results=(
                    InboundResult(
                        message_id="<skipped@example.com>",
                        req_id=None,
                        registered=False,
                        reason="未关联到需求编号",
                    ),
                ),
                errors=(),
            )
            entries = _pending_entries(report, MailThreadStore(connection), store, frozenset())
        finally:
            connection.close()
            store.close()
        assert entries == []

    def test_identify_feedback_from_body_and_unknown(self) -> None:
        question = DisambiguationQuestion("Q1", "请补充使用场景")
        _, disambiguation_body = _build_feedback(
            "req-1", Classification.DISAMBIGUATE, (question,), ""
        )
        assert identify_feedback("", disambiguation_body) is Classification.DISAMBIGUATE

        _, rejection_body = _build_feedback(
            "req-1", Classification.NOT_ACCEPT_CANDIDATE, (), "越界"
        )
        assert identify_feedback("", rejection_body) is Classification.NOT_ACCEPT_CANDIDATE
        assert identify_feedback("普通主题", "普通正文") is None


# --------------------------------------------------------------------------- #
# CLI 契约快照与输出结构一致
# --------------------------------------------------------------------------- #


def load_gate() -> ModuleType:
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


class TestContractSnapshot:
    def test_snapshot_matches_current_contract(self) -> None:
        gate = load_gate()
        ok, message = gate.run_check(ROOT / "contracts" / "cli-contract.json")
        assert ok, message

    def test_snapshot_covers_live_mail_poll_output(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        messages = [
            build_message(
                "<in-ok@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件工作流"
            ),
            build_message(None, subject="无编号", body="无法解析的信"),
        ]
        install_transport(monkeypatch, messages)
        document = poll(tmp_path, capsys)
        assert document["errors"]  # 非空，使契约覆盖字符串数组

        gate = load_gate()
        snapshot = json.loads(
            (ROOT / "contracts" / "cli-contract.json").read_text(encoding="utf-8")
        )
        assert "mail_poll_document" in snapshot
        assert "mail_confirm_document" in snapshot
        assert _covers(snapshot["mail_poll_document"], gate.shape(document))

    def test_snapshot_covers_live_mail_confirm_output(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        install_transport(
            monkeypatch,
            [build_message("<in-1@example.com>", subject="[ForgeLoop] 新需求", body="请实现邮件")],
        )
        req_id = poll(tmp_path, capsys)["requirements"][0]["req_id"]
        _code, result = confirm(
            tmp_path, capsys, req_id, "--action", "disambiguate", "--question", "Q1=补充"
        )

        gate = load_gate()
        snapshot = json.loads(
            (ROOT / "contracts" / "cli-contract.json").read_text(encoding="utf-8")
        )
        assert _covers(snapshot["mail_confirm_document"], gate.shape(result))


class TestCancellationProposal:
    """取消提议（所有者 2026-10-19：删除=取消+记录）：邮件表达意图时如实标注，不代替人执行。"""

    def test_cancel_intent_is_reported_as_proposal(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<cancel-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="请取消需求，我们不做了。",
                )
            ],
        )
        document = poll(tmp_path, capsys)
        entry = next(item for item in document["requirements"] if item["req_id"] == req_id)
        assert entry["cancel_proposal"] is True

    def test_ordinary_feedback_is_not_a_cancel_proposal(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<cancel-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="确认按方案实施；取消按钮的位置也请一并调整。",
                )
            ],
        )
        document = poll(tmp_path, capsys)
        entry = next(item for item in document["requirements"] if item["req_id"] == req_id)
        assert entry["cancel_proposal"] is False


class TestMailConversationLoop:
    """邮件对话闭环（所有者 2026-10-19）：答复回流成需求修订，供下一轮分析使用。"""

    def _status(self, records_root: Path, req_id: str) -> tuple[str, int, str]:
        store = requirement_store(records_root)
        try:
            requirement = store.get(req_id)
            return (
                store.requirement_status(req_id),
                len(requirement.versions),
                requirement.latest.text,
            )
        finally:
            store.close()

    def test_reply_answers_are_appended_as_new_requirement_version(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能", clarifications=("导出格式",))
        status, before, _ = self._status(tmp_path, req_id)
        assert status == "awaiting_clarification" and before == 1

        install_transport(
            monkeypatch,
            [
                build_message(
                    "<answer-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="需要 CSV 与 Excel 两种格式。",
                )
            ],
        )
        poll(tmp_path, capsys)

        status, after, text = self._status(tmp_path, req_id)
        assert status == "draft", "答复回流后应回到 draft 等待重新分析"
        assert after == before + 1 and "CSV 与 Excel" in text and "邮件答复" in text

    def test_terminal_requirement_does_not_receive_mail_answers(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        store = requirement_store(tmp_path)
        try:
            store.record_requirement_cancellation(req_id, by="owner", reason="已取消")
            before = len(store.get(req_id).versions)
        finally:
            store.close()

        install_transport(
            monkeypatch,
            [
                build_message(
                    "<answer-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充一些内容。",
                )
            ],
        )
        poll(tmp_path, capsys)
        _, after, _ = self._status(tmp_path, req_id)
        assert after == before, "终态需求不再接收答复回流"


class TestAutoAnalyzeWiring:
    """auto_analyze 接线（所有者 2026-10-19）：轮询后按设置自动分析新答复。"""

    def _patch_analyze(self, monkeypatch: pytest.MonkeyPatch) -> list[str]:
        import forgeloop.cli.main as cli_main

        calls: list[str] = []

        def fake_auto(args, req_ids):
            calls.extend(req_ids)
            return [f"{req_id}: 分析完成（替身）" for req_id in req_ids]

        monkeypatch.setattr(cli_main, "_auto_analyze_after_poll", fake_auto)
        return calls

    def test_auto_analyze_runs_for_newly_registered_reply(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能", clarifications=("导出格式?",))
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="需要 CSV 与 Excel 两种格式。",
                )
            ],
        )
        calls = self._patch_analyze(monkeypatch)
        document = poll(tmp_path, capsys, "--auto-analyze", "--pi-command", '["pi"]')
        assert calls == [req_id]
        assert document["registered"] == 1

    def test_auto_analyze_is_off_by_default(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充说明。",
                )
            ],
        )
        calls = self._patch_analyze(monkeypatch)
        poll(tmp_path, capsys)
        assert calls == [], "缺省不自动分析（模型调用需要显式开启）"

    def test_auto_analyze_requires_pi_command(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-3@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充说明。",
                )
            ],
        )
        calls = self._patch_analyze(monkeypatch)
        code, out = run_cli(
            [
                "mail",
                "poll",
                "--once",
                "--project",
                PROJECT,
                "--auto-analyze",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert code == 0 and "缺少 --pi-command" in out and calls == []


class TestAutoReply:
    """自动回信（所有者 2026-10-19：回信由系统自动分析回复，不需逐封人工确认）。"""

    def test_disambiguation_is_sent_automatically_after_poll(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(
            tmp_path, "导出功能", clarifications=("导出格式?", "历史数据保留多久?")
        )
        _receiver, sender = install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-reply-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充：希望尽快。",
                )
            ],
        )
        poll(tmp_path, capsys)
        sent = [message for message in sender.sent if req_id in str(message["Subject"])]
        assert sent, "轮询后应自动发出回信"
        part = sent[-1].get_body(preferencelist=("plain",))
        assert part is not None
        body = part.get_content()
        assert "导出格式?" in body and "请直接回复本邮件" in body

    def test_terminal_not_accept_is_left_for_human(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 不在受理范围内的需求 → 建议"不接纳"；这是终局否定决定，不自动发。
        req_id = seed_requirement(tmp_path, "无关需求")
        _receiver, sender = install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-reply-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充说明。",
                )
            ],
        )
        poll(tmp_path, capsys, "--out-of-scope", req_id)
        assert sender.sent == [], "不接纳不自动发送，留人工确认"

    def test_flag_can_turn_auto_reply_off(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能", clarifications=("导出格式?",))
        _receiver, sender = install_transport(
            monkeypatch,
            [
                build_message(
                    "<auto-reply-3@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="补充。",
                )
            ],
        )
        poll(tmp_path, capsys, "--no-auto-reply")
        assert sender.sent == []


class TestMailEquivalenceForCancel:
    """所有者 2026-10-19：邮件与页面/CLI 等价。白名单发件人的取消意图直接生效。"""

    def test_whitelisted_sender_cancels_the_requirement(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<cancel-mail-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="请取消需求，我们不再做了。",
                )
            ],
        )
        poll(tmp_path, capsys, "--whitelist", "requester@example.com")
        store = requirement_store(tmp_path)
        try:
            assert store.requirement_status(req_id) == "cancelled"
            decision = store.requirement_cancellation(req_id)
            assert decision is not None and decision["cancelled_by"] == "requester@example.com"
            assert "[邮件/取消]" in decision["reason"]
        finally:
            store.close()

    def test_sender_outside_whitelist_only_gets_a_proposal(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<cancel-mail-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="请取消需求。",
                )
            ],
        )
        document = poll(tmp_path, capsys, "--whitelist", "someone-else@example.com")
        entry = next(item for item in document["requirements"] if item["req_id"] == req_id)
        assert entry["cancel_proposal"] is True
        store = requirement_store(tmp_path)
        try:
            assert store.requirement_status(req_id) != "cancelled"
        finally:
            store.close()


class TestMailEquivalenceForApprove:
    """邮件等价入口：白名单发件人用**明确指令行**批准任务包（同 CLI 记录路径）。"""

    def _with_plan(self, tmp_path: Path) -> str:
        from forgeloop.domain.task_plan import PlannedTask, TaskPlan

        req_id = seed_requirement(tmp_path, "导出功能")
        store = requirement_store(tmp_path)
        try:
            plan = TaskPlan(
                task_plan_id="plan-1",
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
            )
            store.record_task_plan(req_id, plan)
        finally:
            store.close()
        return req_id

    def test_whitelisted_directive_approves_the_latest_plan(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = self._with_plan(tmp_path)
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<approve-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="操作: 批准\n理由: 邮件批准该方案",
                )
            ],
        )
        poll(tmp_path, capsys, "--whitelist", "requester@example.com")
        store = requirement_store(tmp_path)
        try:
            approval = store.plan_approval(req_id)
            assert approval is not None and approval.plan_version == 1
            assert approval.approved_by == "requester@example.com"
            assert approval.source.startswith("mail:")
        finally:
            store.close()

    def test_non_whitelisted_directive_is_ignored(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = self._with_plan(tmp_path)
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<approve-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="操作: 批准\n理由: 不该生效",
                )
            ],
        )
        poll(tmp_path, capsys, "--whitelist", "someone-else@example.com")
        store = requirement_store(tmp_path)
        try:
            assert store.plan_approval(req_id) is None
        finally:
            store.close()


class TestMailAcceptanceViaDataFlow:
    """邮件验收/推进：数据流分派到既有命令（无 mail → main 反向依赖）。"""

    def test_accept_operation_is_dispatched_and_refused_without_deliveries(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<flow-1@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="操作: 验收",
                )
            ],
        )
        _code, out = run_cli(
            [
                "mail",
                "poll",
                "--once",
                "--project",
                PROJECT,
                "--whitelist",
                "requester@example.com",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert "验收未通过" in out or "验收被拒绝" in out

    def test_advance_without_pi_command_explains_instead_of_running(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = seed_requirement(tmp_path, "导出功能")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<flow-2@example.com>",
                    subject=f"Re: [ForgeLoop] {req_id}",
                    body="操作: 推进",
                )
            ],
        )
        _code, out = run_cli(
            [
                "mail",
                "poll",
                "--once",
                "--project",
                PROJECT,
                "--whitelist",
                "requester@example.com",
                *connection_args(tmp_path),
            ],
            capsys,
        )
        assert "推进未执行（未配置 --pi-command）" in out
