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
from forgeloop.cli.panel import (
    PanelContext,
    PanelRegistry,
    panel_document,
    session_document,
)
from forgeloop.cli.serve import (
    ServeOperations,
    ServeSettings,
    build_service_document,
    panel_project_problems,
)
from forgeloop.cli.web import ProgressDocuments, WebSettings, build_progress_document
from forgeloop.domain.approval import Approval, ApprovalStage, Plan
from forgeloop.domain.conversation import DecisionKind, MessageRole, SessionStatus
from forgeloop.domain.counting import FailureStage
from forgeloop.domain.progress import RefreshSetting, RefreshSource
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.domain.service import resolve_service_settings
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.worker import ServiceWorker
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
        web_document = build_progress_contract(Path(tmp))
        service_document = build_service_contract(Path(tmp))
        service_operation_document = build_service_operation_contract()
        service_operation_error_document = build_service_operation_error_contract()
        panel_document_shape, panel_session_shape = build_panel_contract(Path(tmp))

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
        # 状态页（B01）只读接口：页面脚本消费的对外结构，刷新配置随文档返回。
        "web_progress_route": "GET /api/progress",
        "web_progress_document": web_document,
        # 常驻服务：HTTP 路由与 `serve --once --json` 是同一份结构。
        "service_command": "forgeloop serve --once --json",
        "service_exit_codes": {"ok": 0, "config_invalid": 1, "listen_failed": 1},
        "service_status_route": "GET /api/service",
        "service_document": service_document,
        # 页面写入口（R3）：提交与四类人工动作，成功与失败各一份结构。
        "service_submit_route": "POST /api/requirements",
        "service_action_routes": [
            "POST /api/requirements/{req_id}/approve",
            "POST /api/requirements/{req_id}/advance",
            "POST /api/requirements/{req_id}/accept",
            "POST /api/requirements/{req_id}/stop",
        ],
        # 每个写端点的成功状态码（方案 §4.2 的表）：推进与停止是「受理」，其余是「已完成」。
        "service_operation_codes": {
            "submit": 201,
            "approve": 200,
            "advance": 202,
            "accept": 200,
            "stop": 202,
        },
        "service_operation_document": service_operation_document,
        "service_operation_error_document": service_operation_error_document,
        # 会话面板：读模型两份文档 + 写端点的成功与失败结构。
        "panel_route": "GET /api/panel",
        "panel_document": panel_document_shape,
        "panel_session_route": "GET /api/panel/sessions/{session_id}",
        "panel_session_document": panel_session_shape,
        "panel_project_routes": [
            "POST /api/panel/projects",
            "POST /api/panel/projects/{name}/update",
            "POST /api/panel/projects/{name}/remove",
        ],
        "panel_session_routes": [
            "POST /api/panel/sessions",
            "POST /api/panel/sessions/{session_id}/messages",
            "POST /api/panel/sessions/{session_id}/terminate",
            "POST /api/panel/sessions/{session_id}/decisions/{decision_id}",
        ],
        "panel_operation_codes": {
            "project_create": 201,
            "project_update": 200,
            "project_remove": 200,
            "session_create": 201,
            "session_message": 202,
            "session_terminate": 200,
            "session_decision_approve": 202,
            "session_decision_reject": 200,
        },
        "panel_operation_document": build_panel_operation_contract(),
        "panel_operation_error_document": build_service_operation_error_contract(),
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
        "cancel_proposal": False,
        "operation": "",
        "mail_sender": "",
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


def build_progress_contract(root: Path) -> dict:
    """状态页 ``GET /api/progress`` 的对外结构。

    ``requirements``/``tasks`` 的数组元素就是 ``requirement_document`` 与
    ``document`` 两份文档本身（页面直接展示它们），因此元素位置写 ``$ref`` 指向
    本文件里已合并的最小/全字段结构，而不是再抄一份：同一份结构出现两次会让一次
    字段改动在两个地方各审一遍 diff。本接口新增的结构是外层信封（生成时间、生效
    刷新配置、计数）与问题项，用真实记录（一个阻断任务与一个未完成执行槽位）合成。
    """

    store = RecordStore(root / "records.sqlite")
    try:
        store.create_task(
            "task-blocked",
            "proj",
            "原始文本",
            {"pi_command": "[]", "test_command": "[]"},
            7200.0,
        )
        store.set_task_status("task-blocked", "blocked")
        store.actions.claim_slot("req-proj-1", "advance")
    finally:
        store.close()
    documents = ProgressDocuments(_requirement_document, _status_document)
    document = shape(
        build_progress_document(root, RefreshSetting(60, RefreshSource.DEFAULT), documents)
    )
    properties = document["properties"]
    properties["requirements"]["item"] = {"$ref": "#/requirement_document"}
    properties["tasks"]["item"] = {"$ref": "#/document"}
    return document


def build_panel_contract(root: Path) -> tuple[dict, dict]:
    """面板读模型的两份对外结构：总览（`GET /api/panel`）与单会话详情。

    用真实记录根与真实项目档案文件合成：一条只读（手写 ``config/service.toml`` 形状）
    与一条页面管理的项目、一条含一问一答与一条待人工决定的会话。执行器用**不启动任何
    轮次**的空跑器，因为快照只描述结构。
    """

    from forgeloop.domain.projects import PanelProject
    from forgeloop.graph.conversation import ConversationRunner

    projects_path = root / "projects.toml"
    registry = PanelRegistry({}, projects_path)
    registry.create(
        PanelProject(
            name="demo",
            path=str(root),
            description="契约样本项目",
            pi_command=("pi", "--mode", "rpc", "--no-session"),
            pi_home=str(root / "pi-home"),
        )
    )
    runner = ConversationRunner(
        records_path=root / "records.sqlite",
        session_root=root / "panel",
        projects=registry.by_name,
        readiness=panel_project_problems,
        concurrency=2,
        turn_timeout_seconds=900,
    )
    try:
        context = PanelContext(
            registry=registry,
            runner=runner,
            readiness=panel_project_problems,
            db_path=root / "records.sqlite",
        )
        store = context.store()
        try:
            session = store.create_session(
                project="demo", title="契约样本会话", by="owner", cwd=str(root)
            )
            store.append_message(
                session.session_id, role=MessageRole.HUMAN, content="看一下构建", author="owner"
            )
            store.append_message(
                session.session_id, role=MessageRole.AGENT, content="已修复构建脚本。"
            )
            store.open_decision(
                session.session_id,
                kind=DecisionKind.AGENT_REQUEST,
                question="是否删除旧的构建入口?",
            )
            store.set_status(session.session_id, SessionStatus.AWAITING_HUMAN, last_error="")
        finally:
            store.close()
        overview = shape(panel_document(context))
        detail = shape(session_document(context, session.session_id) or {})
        # 会话摘要在总览与详情里是同一份结构：详情用 $ref 指过去，
        # 避免同一份字段在两个位置各审一遍 diff（与 web_progress_document 同一口径）。
        detail["properties"]["session"] = {"$ref": "#/panel_document/properties/sessions/item"}
    finally:
        runner.shutdown()
    return overview, detail


def build_panel_operation_contract() -> dict:
    """面板写操作的成功响应结构：项目档案三动作 + 会话四动作合并。"""

    project_write = shape(
        {
            "ok": True,
            "operation": "project_update",
            "name": "demo",
            "path": "/home/link/Project/ForgeLoop",
            "source": "web:owner",
        }
    )
    session_create = shape(
        {
            "ok": True,
            "operation": "session_create",
            "session_id": "cs-20261018120000-abcdef",
            "project": "demo",
            "title": "排查构建失败",
            "source": "web:owner",
        }
    )
    message = shape(
        {
            "ok": True,
            "operation": "session_message",
            "session_id": "cs-20261018120000-abcdef",
            "turn_count": 1,
            "queued": False,
            "detail": "已受理，一轮执行在常驻进程内进行；轮询会话详情即可看到结果",
        }
    )
    terminate = shape(
        {
            "ok": True,
            "operation": "session_terminate",
            "session_id": "cs-20261018120000-abcdef",
            "terminated": True,
            "aborted": False,
            "already_terminated": False,
            "detail": "会话已终止",
        }
    )
    decision = shape(
        {
            "ok": True,
            "operation": "session_decision",
            "session_id": "cs-20261018120000-abcdef",
            "decision_id": "dc-20261018120000-123456",
            "decision": "approve",
            "turn_count": 2,
            "queued": False,
            "session_status": "active",
            "detail": "已批准并重新发起一轮执行",
        }
    )
    return merge(merge(merge(project_write, session_create), merge(message, terminate)), decision)


def build_service_operation_contract() -> dict:
    """页面写操作的成功响应结构：提交（带 ``req_id``）与人工动作（带 ``output``）合并。"""

    submit = shape(
        {
            "ok": True,
            "operation": "submit",
            "req_id": "req-20261018000000-abcdef",
            "by": "owner",
            "note": "页面提交",
            "source": "web",
        }
    )
    action = shape(
        {
            "ok": True,
            "operation": "approve",
            "req_id": "req-20261018000000-abcdef",
            "by": "owner",
            "reason": "页面批准",
            "output": "任务包 v6 已批准（授权来源 web:owner）。",
        }
    )
    advance = shape(
        {
            "ok": True,
            "operation": "advance",
            "req_id": "req-20261018000000-abcdef",
            "queued": True,
            "detail": "已受理，常驻进程将在下一次心跳执行",
        }
    )
    stop = shape(
        {
            "ok": True,
            "operation": "stop",
            "req_id": "req-20261018000000-abcdef",
            "task_id": "task-req-20261018000000-abcdef-v6-first",
            "reason": "页面停止",
            "output": "停止请求已记录",
        }
    )
    return merge(merge(merge(submit, action), advance), stop)


def build_service_operation_error_contract() -> dict:
    """页面写操作的失败响应结构：稳定机器标签 + 可直接展示的原因。"""

    return shape({"error": "refused", "detail": "该需求当前不可自动推进"})


def _contract_operations() -> ServeOperations:
    """契约快照用的写入口替身：只提供函数形状，不执行任何动作。"""

    def _noop(args: argparse.Namespace) -> int:
        return 0

    return ServeOperations(approve_requirement=_noop, accept_requirement=_noop, stop_task=_noop)


def _seed_worker_sample(root: Path) -> None:
    """合成「一条可自动接续 + 一条项目未配置会被跳过」的需求，供常驻状态快照使用。"""

    from datetime import UTC, datetime

    from forgeloop.domain.task_plan import PlannedTask, TaskPlan

    store = RequirementStore(root / "records.sqlite")
    try:
        for project in ("demo", "proj"):
            requirement = store.submit(project, f"常驻服务契约样本（{project}）")
            plan = TaskPlan(
                task_plan_id=f"plan-{requirement.req_id}-1",
                requirement_id=requirement.req_id,
                project=project,
                plan_version=1,
                requirement_version=requirement.version_count,
                tasks=(
                    PlannedTask(
                        task_id="sample",
                        goal="契约样本任务",
                        files=("src/sample.py",),
                        acceptance="样本验收",
                        test_command=("pytest", "-q"),
                    ),
                ),
                created_at=datetime.now(UTC),
            )
            store.record_task_plan(requirement.req_id, plan)
            store.record_plan_approval(requirement.req_id, 1, "owner", source="contract-sample")
            if project == "proj":
                # 再给「未配置项目」那条留一个未释放动作：契约快照要覆盖
                # outstanding_action 这一问題种类（页面「问题」段与常驻清单共用）。
                thread_id = f"task-{requirement.req_id}-v1-sample"
                record = RecordStore(root / "records.sqlite")
                try:
                    record.create_task(
                        thread_id,
                        project,
                        "契约样本任务",
                        {"pi_command": '["pi"]', "test_command": '["pytest", "-q"]'},
                        7200.0,
                    )
                    record.actions.begin(thread_id, "dev")
                finally:
                    record.close()
    finally:
        store.close()


def build_service_contract(root: Path) -> dict:
    """常驻服务 ``GET /api/service``/``serve --once --json`` 的对外结构。

    ``counts`` 与 ``review_required`` 的元素就是进展文档的对应结构（同一份读模型、
    同一套问题分类），因此这里写 ``$ref`` 指向 ``web_progress_document`` 的相关位置，
    不重复抄一份；本接口新增的只有常驻进程自身的 worker 状态与配置信息。
    """

    store = RecordStore(root / "records.sqlite")
    try:
        store.create_task(
            "task-serve-blocked",
            "proj",
            "原始文本",
            {"pi_command": "[]", "test_command": "[]"},
            7200.0,
        )
        store.set_task_status("task-serve-blocked", "blocked")
        store.actions.claim_slot("req-proj-serve", "advance")
    finally:
        store.close()
    _seed_worker_sample(root)
    # 合成一个项目档案，让 ``projects`` 的元素形状被快照记录为字符串（空数组只能
    # 记成 empty-array，会丢掉元素类型）。
    service = resolve_service_settings(
        {
            "schema_version": 1,
            "projects": {
                "demo": {
                    "path": "/tmp/demo",
                    "pi_command": ["pi"],
                    "test_command": ["pytest"],
                    "baseline": "",
                    "pi_home": "/tmp/demo-home",
                }
            },
        }
    )
    web = WebSettings(
        root,
        service.host,
        service.port,
        RefreshSetting(60, RefreshSource.DEFAULT),
        Path("config/web.toml"),
        ProgressDocuments(_requirement_document, _status_document),
    )
    worker = ServiceWorker(
        root,
        poll_seconds=service.poll_seconds,
        auto_advance=service.auto_advance,
        projects=service.projects,
        process_home="/tmp/demo-home",
    )
    # 只读筛选一次：让 ``last_tick.candidates``（字符串数组）与 ``skipped``（对象数组）
    # 的元素类型进入快照；``executed``/``results`` 在合成现场里没有执行，保持空数组。
    worker.survey()
    document = shape(
        build_service_document(
            ServeSettings(
                web=web,
                service=service,
                config_path=Path("config/service.toml"),
                operations=_contract_operations(),
            ),
            worker,
            operations_enabled=True,
        )
    )
    properties = document["properties"]
    properties["counts"] = {"$ref": "#/web_progress_document/properties/counts"}
    properties["review_required"]["item"] = {
        "$ref": "#/web_progress_document/properties/issues/item"
    }
    return document


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
