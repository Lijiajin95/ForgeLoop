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
    # 统一口径：所有跨入口对照都用 tests/scenario/parity_facts.py 的读取器。
    from parity_facts import cancel_facts

    return cancel_facts(records_root, req_id)


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


class TestSubmitParity:
    """提交：CLI 与邮件都必须产生**同一形状的需求记录**（草稿、单版本、有原文）。

    等价标准是记录事实，不是文案：邮件把"主题 + 正文"作为需求原文，CLI 用 --input；
    两者都不直接进入执行（仍是 draft，需人工批准任务包）。
    """

    def _facts(self, records_root: Path) -> list[dict[str, object]]:
        store = RequirementStore(records_root / "records.sqlite")
        try:
            return [
                {
                    "status": store.requirement_status(requirement.req_id),
                    "versions": len(requirement.versions),
                    "text_non_empty": bool(requirement.latest.text.strip()),
                }
                for requirement in store.for_project("ForgeLoop")
            ]
        finally:
            store.close()

    def _facts_of(self, records_root: Path, req_id: str) -> dict[str, object]:
        store = RequirementStore(records_root / "records.sqlite")
        try:
            requirement = store.get(req_id)
            return {
                "status": store.requirement_status(req_id),
                "versions": len(requirement.versions),
                "text_non_empty": bool(requirement.latest.text.strip()),
            }
        finally:
            store.close()

    def test_cli_and_mail_create_the_same_record_shape(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            install_transport,
            poll,
        )

        cli_root = tmp_path / "cli-submit"
        cli_root.mkdir()
        code, out = run_cli(
            [
                "requirement",
                "submit",
                "--project",
                "ForgeLoop",
                "--input",
                "等价性：希望支持批量导出",
                "--records-root",
                str(cli_root),
            ],
            capsys,
        )
        assert code == 0 and "需求已创建" in out

        mail_root = tmp_path / "mail-submit"
        mail_root.mkdir()
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-submit@example.com>",
                    subject="希望支持批量导出",
                    body="用于等价性对照。",
                )
            ],
        )
        document = poll(mail_root, capsys, "--whitelist", "requester@example.com")
        assert document["registered"] == 1, document
        mail_req = document["requirements"][0]["req_id"]
        assert mail_req, document

        expected = [{"status": "draft", "versions": 1, "text_non_empty": True}]
        assert self._facts(cli_root) == expected
        assert self._facts_of(mail_root, mail_req) == expected[0]


class TestAdvanceNoSideEffectParity:
    """推进（零副作用版）：没有命令/没有批准时，两条入口都不得改变任何记录事实。

    按 docs/entry-parity.md §2.4 的自我保护约定：端到端不给邮件配命令，
    CLI 侧用不存在的命令（拒绝判定若失效也只会启动失败，不消耗模型调用）。
    """

    def _facts(self, records_root: Path, req_id: str) -> dict[str, object]:
        store = RequirementStore(records_root / "records.sqlite")
        try:
            plan = store.latest_task_plan(req_id)
            return {
                "status": store.requirement_status(req_id),
                "authorized": store.authorized_task_plan(req_id) is not None,
                "plan_version": 0 if plan is None else plan.plan_version,
            }
        finally:
            store.close()

    def test_cli_reports_next_step_and_mail_stays_side_effect_free(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            connection_args,
            install_transport,
        )

        cli_root = tmp_path / "cli-advance-safe"
        cli_root.mkdir()
        cli_req = _seed(cli_root, "等价性：CLI 推进（零副作用）")
        code, cli_out = run_cli(
            [
                "requirement",
                "advance",
                cli_req,
                "--pi-command",
                '["/nonexistent-forgeloop-pi"]',
                "--records-root",
                str(cli_root),
            ],
            capsys,
        )
        assert code in (0, 1), cli_out
        assert "当前任务: 无" in cli_out and "生成或批准任务包" in cli_out

        mail_root = tmp_path / "mail-advance-safe"
        mail_root.mkdir()
        mail_req = _seed(mail_root, "等价性：邮件推进（零副作用）")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-advance-safe@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
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
                "ForgeLoop",
                "--whitelist",
                "requester@example.com",
                *connection_args(mail_root),
            ],
            capsys,
        )
        assert "推进未执行（未配置 --pi-command）" in out, out

        # 等价事实：两条入口都没有改变状态、没有产生授权、没有任务包。
        assert (
            self._facts(cli_root, cli_req)
            == self._facts(mail_root, mail_req)
            == {
                "status": "draft",
                "authorized": False,
                "plan_version": 0,
            }
        )


class TestAcceptRefusalParity:
    """验收（拒绝语义）：没有可验收材料时，两条入口都必须拒绝且不写任何验收记录。"""

    def _facts(self, records_root: Path, req_id: str) -> dict[str, object]:
        store = RequirementStore(records_root / "records.sqlite")
        try:
            return {
                "status": store.requirement_status(req_id),
                # 未验收时指纹为空（requirement_acceptance 始终返回结构，空指纹即无验收）.
                "acceptance_fingerprint": store.requirement_acceptance(req_id).get(
                    "fingerprint", ""
                ),
            }
        finally:
            store.close()

    def test_both_entries_refuse_and_record_nothing(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            connection_args,
            install_transport,
        )

        cli_root = tmp_path / "cli-accept"
        cli_root.mkdir()
        cli_req = _seed(cli_root, "等价性：CLI 验收被拒")
        code, cli_out = run_cli(
            [
                "requirement",
                "accept",
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
        assert code == 1, cli_out
        assert "被拒绝" in cli_out, cli_out

        mail_root = tmp_path / "mail-accept"
        mail_root.mkdir()
        mail_req = _seed(mail_root, "等价性：邮件验收被拒")
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<parity-accept@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
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
                "ForgeLoop",
                "--whitelist",
                "requester@example.com",
                *connection_args(mail_root),
            ],
            capsys,
        )
        assert "验收未通过" in out, out

        # 等价事实：两条入口都拒绝、状态不变、都没有写出验收记录。
        assert (
            self._facts(cli_root, cli_req)
            == self._facts(mail_root, mail_req)
            == {
                "status": "draft",
                "acceptance_fingerprint": "",
            }
        )


class TestAcceptanceSuccessParity:
    """验收成功路径：合法现场（真实图 + 替身 runner + 公开批准/消费 API）下，
    CLI 与邮件各做一次整体验收，验收记录必须等价。

    现场构造严格遵守纪律：跑真实 `RequirementExecutor.advance()` 让任务交付，再用图内
    acceptance 门消费的**同一对公开 API**（`record_approval` + `consume_approval`）生成
    验收绑定——不手写表、不伪造记录。
    """

    def _acceptable_scene(self, root: Path) -> str:
        from datetime import UTC, datetime

        from test_requirement_execution import (
            FakeClock,
            ScriptedRunner,
            approved_scene,
            artifact,
            planned,
        )

        from forgeloop.domain.approval import Approval, ApprovalStage
        from forgeloop.graph.builder import requirement_task_id
        from forgeloop.graph.requirements import (
            RequirementExecutor,
            TaskResult,
            TaskRunState,
        )
        from forgeloop.records.store import RecordStore

        store, req_id = approved_scene(root, (planned("task-1"),))
        try:
            clock = FakeClock()
            runner = ScriptedRunner(
                clock,
                {"task-1": (10.0, TaskResult(TaskRunState.DELIVERED, artifact("task-1", "a")))},
            )
            RequirementExecutor(store, req_id, runner, clock=clock).advance()
        finally:
            store.close()

        task_id = requirement_task_id(req_id, 1, "task-1")
        task_dir = root / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "candidate.diff").write_text("diff --git a/x b/x\n", encoding="utf-8")
        (task_dir / "test-run.jsonl").write_text('{"status":"passed"}\n', encoding="utf-8")
        (task_dir / "review-report.json").write_text('{"verdict":"ok"}\n', encoding="utf-8")

        record_store = RecordStore(root / "records.sqlite")
        try:
            binding = record_store.capture_delivery_binding(task_id, 1)
            record_store.record_approval(
                Approval(
                    task_id=task_id,
                    plan_version=1,
                    stage=ApprovalStage.ACCEPTANCE,
                    decided_at=datetime.now(UTC),
                    binding=binding,
                    approved_by="owner",
                    source="cli",
                )
            )
            assert (
                record_store.consume_approval(
                    task_id, 1, ApprovalStage.ACCEPTANCE, binding
                ).status.value
                == "ok"
            )
        finally:
            record_store.close()
        return req_id

    def _facts(self, root: Path, req_id: str) -> dict[str, object]:
        store = RequirementStore(root / "records.sqlite")
        try:
            record = store.requirement_acceptance(req_id)
            return {
                "accepted_by_non_empty": bool(record.get("accepted_by")),
                "fingerprint_non_empty": bool(record.get("acceptance_fingerprint")),
                "status": store.requirement_status(req_id),
            }
        finally:
            store.close()

    def test_cli_and_mail_accept_the_same_record_shape(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.scenario.test_mail_cli import (
            build_message,
            connection_args,
            install_transport,
        )

        cli_root = tmp_path / "cli-accept-ok"
        cli_root.mkdir()
        cli_req = self._acceptable_scene(cli_root)
        code, _out = run_cli(
            [
                "requirement",
                "accept",
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

        mail_root = tmp_path / "mail-accept-ok"
        mail_root.mkdir()
        mail_req = self._acceptable_scene(mail_root)
        install_transport(
            monkeypatch,
            [
                build_message(
                    "<accept-ok@example.com>",
                    subject=f"Re: [ForgeLoop] {mail_req}",
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
                "ForgeLoop",
                "--whitelist",
                "requester@example.com",
                *connection_args(mail_root),
            ],
            capsys,
        )
        assert "验收完成" in out or "验收通过" in out, out

        cli_facts = self._facts(cli_root, cli_req)
        mail_facts = self._facts(mail_root, mail_req)
        expected = {
            "accepted_by_non_empty": True,
            "fingerprint_non_empty": True,
            "status": "accepted",
        }
        assert cli_facts == mail_facts == expected, (cli_facts, mail_facts)
