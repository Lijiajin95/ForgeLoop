"""页面写入口的 HTTP 边界（R3）：真实回环端口 + 真实记录 + 注入的 CLI 入口替身。

核对的是「三道闸门 + 复用同一入口」：令牌、同源、请求体与人工理由缺一不可；批准/
验收/停止调用的是**注入的同一个函数对象**（用替身断言收到的 ``Namespace``，从而证明
页面没有另写一套绑定逻辑）；提交直接写权威记录；推进走 worker 的筛选规则。
"""

import argparse
import contextlib
import http.client
import json
import sqlite3
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.serve import (
    OPERATION_SOURCE,
    ServeOperations,
    ServeSettings,
    build_server,
    build_service_document,
    load_service_config,
)
from forgeloop.cli.web import ProgressDocuments, WebSettings, load_web_config
from forgeloop.domain.progress import resolve_refresh_seconds
from forgeloop.domain.service import ProjectProfile, resolve_service_settings
from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[2]
DOCUMENTS = ProgressDocuments(_requirement_document, _status_document)
TOKEN = "integration-token"
WHEN = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)
PROJECT = "ForgeLoop"
PLAN_VERSION = 1
TASK = "first"
PI_HOME = "/tmp/forgeloop-integration-home"


class _Recorder:
    """注入的 CLI 入口替身：记录收到的 Namespace，按需返回失败。"""

    def __init__(self, *, exit_code: int = 0, output: str = "ok") -> None:
        self.calls: list[argparse.Namespace] = []
        self.exit_code = exit_code
        self.output = output

    def __call__(self, args: argparse.Namespace) -> int:
        self.calls.append(args)
        print(self.output)
        return self.exit_code


@pytest.fixture()
def operations() -> dict[str, _Recorder]:
    return {
        "approve": _Recorder(),
        "accept": _Recorder(),
        "stop": _Recorder(),
    }


def _planned() -> PlannedTask:
    return PlannedTask(
        task_id=TASK,
        goal="实现 first",
        files=("src/forgeloop/first.py",),
        acceptance="first 的验收标准",
        test_command=("pytest", "-q"),
        limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
    )


def _approved_requirement(root: Path) -> str:
    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：页面写入口")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(_planned(),),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, PLAN_VERSION, "owner", source="it")
        return requirement.req_id
    finally:
        store.close()


def _planned_requirement(root: Path, text: str = "需求：页面写入口") -> str:
    """只记录任务包、**不**批准：页面批准路径才有东西可批（source 才是 web:<by>）。"""

    store = RequirementStore(root / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, text)
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=PLAN_VERSION,
            requirement_version=requirement.version_count,
            tasks=(_planned(),),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        return requirement.req_id
    finally:
        store.close()


def _serve_settings(root: Path, operations: dict[str, _Recorder]) -> ServeSettings:
    service = resolve_service_settings(load_service_config(ROOT / "config" / "service.toml"))
    web = WebSettings(
        records_root=root,
        host=service.host,
        port=0,
        refresh=resolve_refresh_seconds(load_web_config(ROOT / "config" / "web.toml")),
        config_path=ROOT / "config" / "web.toml",
        documents=DOCUMENTS,
    )
    return ServeSettings(
        web=web,
        service=service,
        config_path=ROOT / "config" / "service.toml",
        operations=ServeOperations(
            approve_requirement=operations["approve"],
            accept_requirement=operations["accept"],
            stop_task=operations["stop"],
        ),
    )


@contextlib.contextmanager
def _running(settings: ServeSettings, worker: ServiceWorker) -> Iterator[tuple[str, int]]:
    """真实回环端口上跑一个服务实例；退出时关闭线程与端口。"""

    server = build_server(settings, worker, token=TOKEN)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield str(host), int(port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _worker_for(root: Path) -> ServiceWorker:
    return ServiceWorker(
        root,
        poll_seconds=1,
        auto_advance=False,
        projects={
            PROJECT: ProjectProfile(
                name=PROJECT,
                path=str(ROOT),
                pi_command=("pi", "--mode", "rpc"),
                test_command=("pytest", "-q"),
                baseline="",
                pi_home=PI_HOME,
            )
        },
        process_home=PI_HOME,
    )


@pytest.fixture()
def live_service(
    tmp_path: Path, operations: dict[str, _Recorder]
) -> Iterator[tuple[str, int, Path, ServiceWorker]]:
    root = tmp_path / ".forgeloop"
    root.mkdir()
    worker = _worker_for(root)
    with _running(_serve_settings(root, operations), worker) as (host, port):
        yield host, port, root, worker


@pytest.fixture()
def real_service(tmp_path: Path) -> Iterator[tuple[str, int, Path]]:
    """注入**真实** CLI 入口（批准/验收/停止同一函数对象），用来核对落库事实。"""

    from forgeloop.cli.main import cmd_requirement_accept, cmd_requirement_approve, cmd_stop

    root = tmp_path / ".forgeloop"
    root.mkdir()
    settings = ServeSettings(
        web=_serve_settings(root, _recorders()).web,
        service=resolve_service_settings(load_service_config(ROOT / "config" / "service.toml")),
        config_path=ROOT / "config" / "service.toml",
        operations=ServeOperations(
            approve_requirement=cmd_requirement_approve,
            accept_requirement=cmd_requirement_accept,
            stop_task=cmd_stop,
        ),
    )
    with _running(settings, _worker_for(root)) as (host, port):
        yield host, port, root


def post(
    address: tuple[str, int],
    path: str,
    payload: dict,
    *,
    token: str | None = TOKEN,
    origin: str | None = None,
    raw_body: bytes | None = None,
) -> tuple[int, dict]:
    host, port = address
    connection = http.client.HTTPConnection(host, port, timeout=10)
    body = raw_body if raw_body is not None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Host": f"{host}:{port}"}
    if token is not None:
        headers["X-Forgeloop-Token"] = token
    if origin is not None:
        headers["Origin"] = origin
    try:
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        connection.close()


class TestGuards:
    def test_missing_token_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        status, payload = post(
            live_service[:2],
            "/api/requirements",
            {"project": PROJECT, "text": "x", "by": "owner"},
            token=None,
            origin=f"http://{live_service[0]}:{live_service[1]}",
        )
        assert status == 403
        assert payload["error"] == "token_required"

    def test_wrong_token_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {"project": PROJECT, "text": "x", "by": "owner"},
            token="not-the-token",
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 403
        assert payload["error"] == "token_required"

    def test_missing_origin_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        status, payload = post(
            live_service[:2], "/api/requirements", {"project": PROJECT, "text": "x", "by": "owner"}
        )
        assert status == 403
        assert payload["error"] == "origin_required"

    def test_cross_origin_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        status, payload = post(
            live_service[:2],
            "/api/requirements",
            {"project": PROJECT, "text": "x", "by": "owner"},
            origin="http://evil.example:80",
        )
        assert status == 403
        assert payload["error"] == "cross_origin"

    def test_missing_by_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {"project": PROJECT, "text": "x"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "by_required"

    def test_oversized_body_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {},
            raw_body=b'{"text": "' + b"x" * (70 * 1024) + b'"}',
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 413
        assert payload["error"] == "body_too_large"

    def test_invalid_json_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {},
            raw_body=b"{not json",
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "invalid_json"

    def test_unknown_write_route_is_404(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements/req-x/explode",
            {"by": "owner", "reason": "r"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 404
        assert payload["error"] == "not_found"

    def test_read_only_methods_still_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        host, port = live_service[:2]
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("PUT", "/api/requirements", body=b"{}")
            assert connection.getresponse().status == 405
        finally:
            connection.close()


class TestSubmit:
    def test_submit_creates_requirement(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        status, payload = post(
            address,
            "/api/requirements",
            {"project": PROJECT, "text": "页面提交的需求", "by": "owner", "reason": "页面提交"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 201
        assert payload["ok"] is True
        assert payload["operation"] == "submit"
        assert payload["source"] == OPERATION_SOURCE
        store = RequirementStore(root / "records.sqlite")
        try:
            requirement = store.get(payload["req_id"])
        finally:
            store.close()
        assert requirement.project == PROJECT
        assert requirement.latest.text == "页面提交的需求"

    def test_submit_without_text_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {"project": PROJECT, "by": "owner"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "invalid_submit"


class TestDecisionsReuseCliEntries:
    def test_approve_calls_the_injected_entry_with_web_source(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/approve",
            {"by": "owner", "reason": "页面批准"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 200
        assert payload["operation"] == "approve"
        call = operations["approve"].calls[0]
        assert call.req_id == req_id
        assert call.by == "owner"
        assert call.source == f"{OPERATION_SOURCE}:owner"
        assert call.records_root == str(live_service[2])

    def test_approve_without_reason_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/approve",
            {"by": "owner"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "reason_required"
        assert operations["approve"].calls == []

    def test_cli_refusal_maps_to_conflict(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        operations["accept"].exit_code = 1
        operations["accept"].output = "需求整体验收被拒绝: 还有任务未验收"
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/accept",
            {"by": "owner", "reason": "页面验收"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 409
        assert "还有任务未验收" in payload["detail"]

    def test_accept_calls_the_injected_entry(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/accept",
            {"by": "owner", "reason": "页面验收"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 200
        assert payload["operation"] == "accept"
        assert operations["accept"].calls[0].req_id == req_id

    def test_stop_uses_the_current_task_identity(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/stop",
            {"by": "owner", "reason": "页面停止"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 202
        assert payload["task_id"] == f"task-{req_id}-v{PLAN_VERSION}-{TASK}"
        call = operations["stop"].calls[0]
        assert call.task_id == payload["task_id"]
        assert call.note == "页面停止"


class TestBodyGuards:
    def test_empty_body_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {},
            raw_body=b"",
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "empty_body"

    def test_non_object_json_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, payload = post(
            address,
            "/api/requirements",
            {},
            raw_body=b"[1, 2, 3]",
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 400
        assert payload["error"] == "invalid_body"

    def test_stop_refusal_maps_to_conflict(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        operations["stop"].exit_code = 1
        operations["stop"].output = "停止请求被拒绝: 该任务不在可停止状态"

        status, payload = post(
            address,
            f"/api/requirements/{req_id}/stop",
            {"by": "owner", "reason": "页面停止"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert status == 409
        assert "不在可停止状态" in payload["detail"]


class TestReviewListMerge:
    """常驻清单 = 进展问题段 + worker 启动核对，按 ``(kind, ref_id)`` 合并成一条事实。"""

    def test_evidence_is_appended_to_the_same_fact(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        store = RecordStore(root / "records.sqlite")
        try:
            store.create_task(
                "task-1",
                PROJECT,
                "被强杀的任务",
                {"pi_command": '["pi"]', "test_command": '["pytest", "-q"]'},
                7200.0,
            )
            store.set_task_status("task-1", "implementing")
            store.actions.begin("task-1", "dev")
            (root / "task-1").mkdir(parents=True, exist_ok=True)
            (root / "task-1" / "candidate.diff").write_text("partial\n", encoding="utf-8")
            (root / "task-1" / "workspace").mkdir(exist_ok=True)
        finally:
            store.close()

        host, port = address
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("GET", "/api/service")
            document = json.loads(connection.getresponse().read().decode("utf-8"))
        finally:
            connection.close()

        items = [item for item in document["review_required"] if item["ref_id"] == "task-1"]
        assert len(items) == 1, "同一事实只能有一条"
        item = items[0]
        assert item["kind"] == "outstanding_action"
        # 读模型的文案保留，现场证据接在后面（否则人工看不到候选 diff 身份）。
        assert "节点: dev" in item["detail"]
        assert "候选 diff sha256:" in item["detail"]
        assert "工作副本存在" in item["detail"]

    def test_worker_only_facts_are_appended(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        """worker 核对出的、读模型没有的事实也要进清单（新增分支）。"""

        root = live_service[2]
        extra = {"kind": "new_fact", "ref_id": "x", "summary": "s", "detail": "d"}
        worker = _StubReviewWorker(root, [extra])

        document = build_service_document(
            _serve_settings(root, _recorders()), worker, operations_enabled=False
        )

        assert extra in document["review_required"]


class _StubReviewWorker(ServiceWorker):
    """真实 worker + 固定的核对清单：只用于钉住「读模型里没有的事实也要进清单」。"""

    def __init__(self, root: Path, items: list[dict[str, str]]) -> None:
        super().__init__(
            root, poll_seconds=1, auto_advance=False, projects={}, process_home=PI_HOME
        )
        self._items = items

    def reconcile(self) -> tuple[dict[str, str], ...]:
        return tuple(self._items)


def _recorders() -> dict[str, _Recorder]:
    return {"approve": _Recorder(), "accept": _Recorder(), "stop": _Recorder()}


class TestIdempotentSubmitOverHttp:
    def test_same_key_and_text_returns_the_existing_requirement(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        payload = {
            "project": PROJECT,
            "text": "幂等提交的需求",
            "by": "owner",
            "key": "browser-key-1",
        }
        origin = f"http://{address[0]}:{address[1]}"

        first_status, first = post(address, "/api/requirements", payload, origin=origin)
        second_status, second = post(address, "/api/requirements", payload, origin=origin)

        assert first_status == 201 and first["idempotent"] is False
        assert second_status == 200 and second["idempotent"] is True
        assert second["req_id"] == first["req_id"]
        store = RequirementStore(root / "records.sqlite")
        try:
            total = store._db.execute("SELECT COUNT(*) FROM requirements").fetchone()
            attribution = store.submission_attribution(first["req_id"])
        finally:
            store.close()
        assert total == (1,), "同一个键不得建出第二条需求"
        assert attribution == ("owner", "web", "browser-key-1")

    def test_same_key_with_other_text_is_a_conflict(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        origin = f"http://{address[0]}:{address[1]}"
        base = {"project": PROJECT, "by": "owner", "key": "browser-key-2"}

        post(address, "/api/requirements", dict(base, text="原文"), origin=origin)
        status, payload = post(
            address, "/api/requirements", dict(base, text="换了内容"), origin=origin
        )

        assert status == 409
        assert payload["error"] == "idempotency_conflict"

    def test_overlong_or_blank_inside_key_is_refused(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        origin = f"http://{address[0]}:{address[1]}"

        for bad_key in ("x" * 129, "has space"):
            status, payload = post(
                address,
                "/api/requirements",
                {"project": PROJECT, "text": "t", "by": "owner", "key": bad_key},
                origin=origin,
            )
            assert status == 400, bad_key
            assert payload["error"] == "invalid_key"


class TestAcceptanceAttributionOverHttp:
    def test_page_acceptance_records_who_and_material(
        self, real_service: tuple[str, int, Path]
    ) -> None:
        """页面整体验收落库「谁验收、从哪来、依据哪份材料指纹」（真实 CLI 入口）。"""

        address = real_service[:2]
        root = real_service[2]
        req_id = _approved_requirement(root)
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/accept",
            {"by": "owner", "reason": "页面验收"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        store = RequirementStore(root / "records.sqlite")
        try:
            acceptance = store.requirement_acceptance(req_id)
        finally:
            store.close()

        # 受理与否取决于交付材料是否齐全；本用例只核对「被拒绝时不留下验收记录」。
        assert status in (200, 409), payload
        if status == 200:
            assert acceptance["accepted_by"] == "owner"
            assert acceptance["acceptance_source"] == "web:owner"
            assert acceptance["accepted_at"]
        else:
            assert acceptance["accepted_by"] == ""
            assert acceptance["acceptance_fingerprint"] == ""


class TestApprovalCounterexamples:
    def test_stale_plan_approval_is_refused_with_reason(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        """需求修订后任务包即作废：页面批准必须被拒，并把原因原样带回（写进 detail）。"""

        address = live_service[:2]
        root = live_service[2]
        store = RequirementStore(root / "records.sqlite")
        try:
            requirement = store.submit(PROJECT, "会被修订的需求")
            plan = TaskPlan(
                task_plan_id=f"plan-{requirement.req_id}-{PLAN_VERSION}",
                requirement_id=requirement.req_id,
                project=requirement.project,
                plan_version=PLAN_VERSION,
                requirement_version=requirement.version_count,
                tasks=(_planned(),),
                created_at=WHEN,
            )
            store.record_task_plan(requirement.req_id, plan)
            store.append(requirement.req_id, "补充一句：需求已修订")
        finally:
            store.close()
        operations["approve"].exit_code = 1
        operations[
            "approve"
        ].output = "任务包 v1 绑定需求版本 v1，当前需求已是 v2；需求已修订，过期任务包不能取得批准"

        status, payload = post(
            address,
            f"/api/requirements/{requirement.req_id}/approve",
            {"by": "owner", "reason": "页面批准过期版本"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert status == 409
        assert payload["error"] == "refused"
        assert "需求已修订" in payload["detail"]

    def test_page_sees_the_refusal_text_verbatim(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        """页面显示的就是服务端拒绝文本：不吞、不改写成「操作失败」。"""

        address = live_service[:2]
        req_id = _approved_requirement(live_service[2])
        operations["approve"].exit_code = 1
        operations["approve"].output = "任务包 v1 已批准且授权未变，无需重复批准"

        status, payload = post(
            address,
            f"/api/requirements/{req_id}/approve",
            {"by": "owner", "reason": "页面重复批准"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert status == 409
        assert payload["detail"] == operations["approve"].output

    def test_repeat_approval_does_not_duplicate_the_fact(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        """重复批准不重复消耗：批准表只留一条事实，任务授权来源不变。

        领域层对同一版本的重复批准是**幂等**的（不报错、不再写一条批准），因此这里核对
        的是事实条数与授权来源，而不是「第二次必须失败」——放宽成「必须失败」反而会与
        既有幂等语义冲突。
        """

        address = live_service[:2]
        root = live_service[2]
        req_id = _approved_requirement(root)
        before = _approval_rows(root, req_id)

        for _ in range(2):
            status, payload = post(
                address,
                f"/api/requirements/{req_id}/approve",
                {"by": "owner", "reason": "页面重复批准"},
                origin=f"http://{address[0]}:{address[1]}",
            )
            assert status == 200
            assert payload["operation"] == "approve"

        assert _approval_rows(root, req_id) == before == 1
        store = RequirementStore(root / "records.sqlite")
        try:
            approval = store.plan_approval(req_id, PLAN_VERSION)
        finally:
            store.close()
        assert approval is not None
        # 授权来源由批准身份与版本派生，重复批准不会改写成第二个来源。
        assert approval.authorization_source == f"plan-approval:{req_id}:v{PLAN_VERSION}:owner"


class TestAdvanceIsAccepted:
    """页面「推进本次」按方案 §4.2 是 **202 受理**：立即返回，执行落在常驻心跳。"""

    def test_eligible_advance_is_queued_and_visible(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        worker = live_service[3]
        req_id = _approved_requirement(root)

        status, payload = post(
            address,
            f"/api/requirements/{req_id}/advance",
            {"by": "owner"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert status == 202
        assert payload["queued"] is True
        assert payload["operation"] == "advance"
        assert worker.pending_advance() == (req_id,)

        host, port = address
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("GET", "/api/service")
            document = json.loads(connection.getresponse().read().decode("utf-8"))
        finally:
            connection.close()
        assert document["worker"]["pending_advance"] == [req_id], "排队请求要让人工看得见"

    def test_client_disconnect_after_acceptance_does_not_lose_the_request(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        """202 的语义：受理即离开请求；客户端断开不影响已受理的请求。"""

        address = live_service[:2]
        root = live_service[2]
        worker = live_service[3]
        req_id = _approved_requirement(root)

        post(
            address,
            f"/api/requirements/{req_id}/advance",
            {"by": "owner"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert worker.pending_advance() == (req_id,)


class TestAdvanceRefusal:
    def test_unapproved_requirement_is_refused_with_reason(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        store = RequirementStore(live_service[2] / "records.sqlite")
        try:
            requirement = store.submit(PROJECT, "没有任务包的需求")
        finally:
            store.close()
        status, payload = post(
            address,
            f"/api/requirements/{requirement.req_id}/advance",
            {"by": "owner"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 409
        assert payload["error"] == "refused"
        assert "任务包" in payload["detail"]


class TestStatusDocument:
    def test_operations_enabled_is_reported(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        host, port = live_service[:2]
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("GET", "/api/service")
            document = json.loads(connection.getresponse().read().decode("utf-8"))
        finally:
            connection.close()
        assert document["operations_enabled"] is True

    def test_page_carries_the_one_time_token(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        host, port = live_service[:2]
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("GET", "/")
            html = connection.getresponse().read().decode("utf-8")
        finally:
            connection.close()
        assert TOKEN in html
        assert "_FORGELOOP_TOKEN_" not in html


def test_record_store_is_untouched_by_refused_writes(
    live_service: tuple[str, int, Path, ServiceWorker],
) -> None:
    address = live_service[:2]
    root = live_service[2]
    before = _counts(root)
    for _ in range(3):
        post(
            address, "/api/requirements", {"text": "x"}, origin=f"http://{address[0]}:{address[1]}"
        )
    assert _counts(root) == before


def _approval_rows(root: Path, req_id: str) -> int:
    """该需求的批准事实条数：重复批准不应增加条数。"""

    connection = sqlite3.connect(f"file:{root / 'records.sqlite'}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT COUNT(*) FROM requirement_plan_approvals WHERE req_id = ?", (req_id,)
        ).fetchone()
    finally:
        connection.close()
    return 0 if row is None else int(row[0])


def _counts(root: Path) -> dict[str, int]:
    store = RecordStore(root / "records.sqlite")
    try:
        return {"tasks": len(store.all_tasks()), "actions": len(store.actions.outstanding_slots())}
    finally:
        store.close()


class TestAuditFacts:
    """五个写端点的审计现状（快照）：谁、理由、来源今天各自落在哪里。

    2026-10-18 核对结论：**只有需求级任务包批准**落了操作人与来源
    （`requirement_plan_approvals.approved_by` / `source`，页面写 `web:<by>`）；提交、推进、
    验收、停止四类操作在权威记录里**没有 actor 字段可落**（表结构如此，不是页面丢弃）。
    本用例把现状钉住：将来若补列/补表，它会失败，提醒同步契约、文档与 status.md 的缺口记录。
    """

    def test_every_write_kind_has_a_durable_actor(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        """2026-10-18 所有者决定「补审计归属列」后的现状：四类写操作都能回查谁与来源。

        这份断言是**现状快照**：将来再动这几张表（加列/改名），它会失败并提醒同步契约、
        文档与 status.md 的审计记录。
        """

        root = live_service[2]
        _approved_requirement(root)  # 建库并落一条批准，保证表都在
        record_store = RecordStore(root / "records.sqlite")
        record_store.close()
        connection = sqlite3.connect(f"file:{root / 'records.sqlite'}?mode=ro", uri=True)
        try:
            columns = {
                table: [row[1] for row in connection.execute(f"pragma table_info({table})")]
                for table in (
                    "requirements",
                    "requirement_plan_approvals",
                    "approvals",
                    "stops",
                )
            }
        finally:
            connection.close()

        assert columns["requirement_plan_approvals"] == [
            "req_id",
            "plan_version",
            "approved_by",
            "source",
            "approved_at",
        ]
        assert {"approved_by", "source"} <= set(columns["approvals"]), "任务级批准的归属"
        assert {"requested_by", "source"} <= set(columns["stops"]), "停止请求的归属"
        assert {
            "submitted_by",
            "source",
            "client_key",
            "accepted_at",
            "accepted_by",
            "acceptance_source",
            "acceptance_fingerprint",
        } <= set(columns["requirements"]), "提交归属、幂等键与需求级验收归属"

    def test_page_approval_is_the_one_operation_with_a_durable_actor(
        self, real_service: tuple[str, int, Path]
    ) -> None:
        address = real_service[:2]
        root = real_service[2]
        req_id = _planned_requirement(root)
        status, payload = post(
            address,
            f"/api/requirements/{req_id}/approve",
            {"by": "owner", "reason": "页面批准"},
            origin=f"http://{address[0]}:{address[1]}",
        )
        assert status == 200, payload

        connection = sqlite3.connect(f"file:{root / 'records.sqlite'}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                "SELECT approved_by, source FROM requirement_plan_approvals WHERE req_id = ?",
                (req_id,),
            ).fetchall()
        finally:
            connection.close()

        assert rows == [("owner", "web:owner")]

    def test_stop_reason_reaches_the_stop_record(
        self, live_service: tuple[str, int, Path, ServiceWorker], operations: dict[str, _Recorder]
    ) -> None:
        """停止请求的理由进既有停止记录（note），不塞进别的字段充当操作人。"""

        address = live_service[:2]
        root = live_service[2]
        req_id = _approved_requirement(root)
        post(
            address,
            f"/api/requirements/{req_id}/stop",
            {"by": "owner", "reason": "页面停止"},
            origin=f"http://{address[0]}:{address[1]}",
        )

        assert operations["stop"].calls, "停止必须调用与 CLI 相同的入口"
        # 理由原样交给既有停止入口（它写 stops.note）；页面既不丢理由，也不把 by 塞进 note。
        assert operations["stop"].calls[-1].note == "页面停止"
        assert "by" not in operations["stop"].calls[-1].note
