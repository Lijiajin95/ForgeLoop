"""常驻服务 HTTP 边界的集成测试：真实回环端口 + 真实 SQLite 记录。

核对的是常驻载体本身的行为：只读路由与 ``web`` 完全一致（非 GET/HEAD 一律 405、
未知路径 404、不写记录），新增的 ``GET /api/service`` 如实报告 worker 状态与
「需人工核对」清单，且清单与 ``/api/progress`` 的「问题」段同源。
"""

import argparse
import http.client
import json
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.serve import (
    ServeOperations,
    ServeSettings,
    build_server,
    build_service_document,
    load_service_config,
)
from forgeloop.cli.web import ProgressDocuments, WebSettings, load_web_config
from forgeloop.domain.progress import resolve_refresh_seconds
from forgeloop.domain.service import ServiceSettings, resolve_service_settings
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[2]
DOCUMENTS = ProgressDocuments(_requirement_document, _status_document)


def _stub_approve(args: argparse.Namespace) -> int:
    return 0


def _stub_accept(args: argparse.Namespace) -> int:
    return 0


def _stub_stop(args: argparse.Namespace) -> int:
    return 0


STUB_OPERATIONS = ServeOperations(
    approve_requirement=_stub_approve,
    accept_requirement=_stub_accept,
    stop_task=_stub_stop,
)


def make_blocked_task(root: Path) -> None:
    """造一个真实阻断任务与一个残留槽位：两类「需人工核对」事实各一条。"""

    store = RecordStore(root / "records.sqlite")
    try:
        store.create_task(
            "task-blocked",
            "forgeloop",
            "常驻服务的阻断任务",
            {"pi_command": '["pi"]', "test_command": '["pytest"]'},
            limit_seconds=100.0,
        )
        store.set_task_status("task-blocked", "blocked")
        store.actions.claim_slot("req-forgeloop-1", "advance")
    finally:
        store.close()


def serve_settings(root: Path, service_document: dict | None = None) -> ServeSettings:
    service: ServiceSettings = resolve_service_settings(
        service_document
        if service_document is not None
        else load_service_config(ROOT / "config" / "service.toml")
    )
    web = WebSettings(
        records_root=root,
        host=service.host,
        port=0,
        refresh=resolve_refresh_seconds(
            load_web_config(ROOT / "config" / "web.toml"), cli_value=None
        ),
        config_path=ROOT / "config" / "web.toml",
        documents=DOCUMENTS,
    )
    return ServeSettings(
        web=web,
        service=service,
        config_path=ROOT / "config" / "service.toml",
        operations=STUB_OPERATIONS,
    )


@pytest.fixture()
def live_service(tmp_path: Path) -> Iterator[tuple[str, int, Path, ServiceWorker]]:
    root = tmp_path / ".forgeloop"
    root.mkdir()
    worker = ServiceWorker(root, poll_seconds=1, auto_advance=False)
    server = build_server(serve_settings(root), worker)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield str(host), int(port), root, worker
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        worker.stop()


def http_request(
    address: tuple[str, int], method: str, path: str, *, body: bytes | None = None
) -> tuple[int, dict[str, str], bytes]:
    host, port = address
    connection = http.client.HTTPConnection(host, port, timeout=10)
    try:
        connection.request(method, path, body=body)
        response = connection.getresponse()
        body = response.read()
        headers = {key.lower(): value for key, value in response.getheaders()}
        return response.status, headers, body
    finally:
        connection.close()


class TestReadOnlyRoutes:
    def test_page_and_progress_match_the_web_contract(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        status, headers, body = http_request(address, "GET", "/")
        assert status == 200
        assert headers["content-type"] == "text/html; charset=utf-8"
        assert "ForgeLoop 研发进展" in body.decode("utf-8")

        status, headers, body = http_request(address, "GET", "/api/progress")
        assert status == 200
        document = json.loads(body)
        assert document["schema_version"] == 1
        assert document["refresh_seconds"] == 60

    def test_write_methods_are_refused_without_records(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        # POST 是**写入口的动词**：R3 起它先过令牌闸门，所以这里拒绝码是 403 而不是 405
        # （且不会因「先路由后鉴权」泄露哪些写路径存在）；其余写方法仍按只读路由回 405。
        status, _, body = http_request(address, "POST", "/api/service", body=b"{}")
        assert status == 403
        assert json.loads(body)["error"] == "token_required"
        for method in ("PUT", "PATCH", "DELETE"):
            status, headers, _ = http_request(address, method, "/api/service")
            assert status == 405
            assert headers["allow"] == "GET, HEAD"
        # 被拒绝的写请求不能留下任何业务事实：任务、槽位、动作都必须是空的。
        store = RecordStore(root / "records.sqlite")
        try:
            assert store.all_tasks() == ()
            assert store.actions.outstanding_slots() == ()
        finally:
            store.close()

    def test_unknown_path_is_404(self, live_service: tuple[str, int, Path, ServiceWorker]) -> None:
        status, _, body = http_request(live_service[:2], "GET", "/api/nope")
        assert status == 404
        assert json.loads(body)["error"] == "not_found"


class TestServiceStatusRoute:
    def test_document_reports_skeleton_and_is_same_shape_as_once(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        _, _, root, worker = live_service
        status, headers, body = http_request(live_service[:2], "GET", "/api/service")
        assert status == 200
        assert headers["content-type"] == "application/json; charset=utf-8"
        document = json.loads(body)
        assert document["schema_version"] == 1
        assert document["records_root"] == str(root)
        assert document["worker"]["running"] is True
        assert document["worker"]["execution_enabled"] is False
        assert document["worker"]["auto_advance"] is False
        assert document["worker"]["poll_seconds"] == 1
        assert document["projects"] == []
        # 与 --once 走同一个构建函数：结构（键集合）必须一致。
        offline = build_service_document(serve_settings(root), worker)
        assert set(document) == set(offline)

    def test_review_required_shares_the_progress_issue_list(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        address = live_service[:2]
        root = live_service[2]
        make_blocked_task(root)
        _, _, progress_body = http_request(address, "GET", "/api/progress")
        _, _, service_body = http_request(address, "GET", "/api/service")
        progress = json.loads(progress_body)
        service = json.loads(service_body)

        # 同一份事实：常驻清单是进展问题段 + worker 启动核对的合并结果（按 kind+ref_id 去重），
        # 因此逐项相同、且读模型的摘要与依据原样保留（现场证据只会追加在后面）。
        def key(item: dict) -> tuple[str, str]:
            return (str(item["kind"]), str(item["ref_id"]))

        assert [key(item) for item in service["review_required"]] == [
            key(item) for item in progress["issues"]
        ]
        for merged, original in zip(service["review_required"], progress["issues"], strict=True):
            assert merged["summary"] == original["summary"]
            assert original["detail"] in merged["detail"]
        kinds = {item["kind"] for item in service["review_required"]}
        assert kinds == {"task_blocked", "slot_residue"}
        assert service["counts"] == progress["counts"]

    def test_worker_heartbeat_is_visible(
        self, live_service: tuple[str, int, Path, ServiceWorker]
    ) -> None:
        worker = live_service[3]
        worker.start()  # 重复启动不产生第二个线程
        assert worker.status()["running"] is True
        document = json.loads(http_request(live_service[:2], "GET", "/api/service")[2])
        assert document["worker"]["running"] is True


class TestDocumentShape:
    def test_generated_at_is_injectable_for_stable_output(self, tmp_path: Path) -> None:
        from datetime import UTC, datetime

        root = tmp_path / ".forgeloop"
        root.mkdir()
        worker = ServiceWorker(root, poll_seconds=1, auto_advance=False)
        moment = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
        document = build_service_document(serve_settings(root), worker, generated_at=moment)
        assert document["generated_at"] == moment.isoformat()
        assert document["started_at"] == worker.started_at.isoformat()
        assert isinstance(document["pid"], int)

    def test_cli_refresh_override_wins_over_config(self, tmp_path: Path) -> None:
        from forgeloop.domain.progress import AUTO_REFRESH_OFF

        root = tmp_path / ".forgeloop"
        root.mkdir()
        service = resolve_service_settings(load_service_config(ROOT / "config" / "service.toml"))
        web = WebSettings(
            records_root=root,
            host=service.host,
            port=0,
            refresh=resolve_refresh_seconds(
                load_web_config(ROOT / "config" / "web.toml"), cli_value=AUTO_REFRESH_OFF
            ),
            config_path=ROOT / "config" / "web.toml",
            documents=DOCUMENTS,
        )
        document = build_service_document(
            ServeSettings(
                web=web,
                service=service,
                config_path=ROOT / "config" / "service.toml",
                operations=STUB_OPERATIONS,
            ),
            ServiceWorker(root, poll_seconds=1, auto_advance=False),
        )
        assert document["counts"] == {"requirements": 0, "tasks": 0, "issues": 0}
        assert web.refresh.seconds == AUTO_REFRESH_OFF
