"""状态页只读 HTTP 边界的集成测试：真实回环端口 + 真实 SQLite 记录。

页面不是替身：本文件在真实回环地址上监听，由真实 ``records.sqlite`` 生成文档，
再用真实 HTTP 请求核对对外行为——只读（非 GET/HEAD 一律 405 且不写记录）、
未知路径 404、刷新配置如实反映来源、需求/任务/问题三段来自权威记录。
"""

import http.client
import json
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from project_support import project_records, record_store, register_project, requirement_store

from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.web import (
    ProgressDocuments,
    WebSettings,
    build_server,
    load_web_config,
    page_html,
)
from forgeloop.domain.progress import RefreshSetting, RefreshSource, resolve_refresh_seconds

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[2]
# 页面读模型与 --json 查询共用同一对构建器（由 cli.main 在真实命令里注入）。
DOCUMENTS = ProgressDocuments(_requirement_document, _status_document)


def make_task(
    root: Path, task_id: str, project: str = "forgeloop", status: str = "created"
) -> None:
    register_project(root)
    store = record_store(root)
    try:
        store.create_task(
            task_id,
            project,
            "原始需求文本",
            {"pi_command": '["pi"]', "test_command": '["pytest"]'},
            limit_seconds=100.0,
        )
        store.set_task_status(task_id, status)
    finally:
        store.close()


def claim_slot(root: Path, slot: str, owner: str) -> None:
    store = record_store(root)
    try:
        # claim_slot 自己加 SLOT_PREFIX，调用方只给槽位名。
        store.actions.claim_slot(slot, owner)
    finally:
        store.close()


def settings_for(root: Path, refresh: RefreshSetting | None = None) -> WebSettings:
    return WebSettings(
        records_root=root,
        host="127.0.0.1",
        port=0,
        refresh=refresh if refresh is not None else RefreshSetting(60, RefreshSource.DEFAULT),
        config_path=ROOT / "config" / "web.toml",
        documents=DOCUMENTS,
    )


@pytest.fixture()
def live_server(tmp_path: Path) -> Iterator[tuple[str, int, Path]]:
    root = tmp_path / ".forgeloop"
    root.mkdir()
    server = build_server(settings_for(root))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield str(host), int(port), root
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def http_request(
    address: tuple[str, int], method: str, path: str
) -> tuple[int, dict[str, str], bytes]:
    host, port = address
    connection = http.client.HTTPConnection(host, port, timeout=10)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        headers = {key.lower(): value for key, value in response.getheaders()}
        return response.status, headers, body
    finally:
        connection.close()


class TestProgressApi:
    def test_empty_records_root_returns_empty_sections(
        self, live_server: tuple[str, int, Path]
    ) -> None:
        status, headers, body = http_request(live_server[:2], "GET", "/api/progress")
        assert status == 200
        assert headers["content-type"] == "application/json; charset=utf-8"
        document = json.loads(body)
        assert document["schema_version"] == 1
        assert document["requirements"] == []
        assert document["tasks"] == []
        assert document["issues"] == []
        assert document["counts"] == {"projects": 0, "requirements": 0, "tasks": 0, "issues": 0}
        assert document["generated_at"]

    def test_requirements_and_tasks_come_from_records(
        self, live_server: tuple[str, int, Path]
    ) -> None:
        _, _, root = live_server
        store = requirement_store(root)
        try:
            requirement = store.submit("forgeloop", "页面要显示需求进展")
        finally:
            store.close()
        make_task(root, "task-1")

        status, _, body = http_request(live_server[:2], "GET", "/api/progress")

        assert status == 200
        document = json.loads(body)
        assert [item["req_id"] for item in document["requirements"]] == [requirement.req_id]
        assert [item["task_id"] for item in document["tasks"]] == ["task-1"]
        assert document["counts"]["requirements"] == 1
        assert document["counts"]["tasks"] == 1

    def test_blocked_task_and_slot_residue_become_issues(
        self, live_server: tuple[str, int, Path]
    ) -> None:
        _, _, root = live_server
        make_task(root, "task-blocked", status="blocked")
        claim_slot(root, "req-forgeloop-1", "advance")

        _, _, body = http_request(live_server[:2], "GET", "/api/progress")

        document = json.loads(body)
        kinds = {issue["kind"]: issue for issue in document["issues"]}
        assert set(kinds) == {"task_blocked", "slot_residue"}
        assert kinds["task_blocked"]["ref_id"] == "task-blocked"
        assert kinds["task_blocked"]["summary"]
        assert kinds["slot_residue"]["ref_id"] == "req-forgeloop-1"
        assert "advance" in kinds["slot_residue"]["detail"]
        assert document["counts"]["issues"] == 2

    def test_normal_flow_task_is_not_an_issue(self, live_server: tuple[str, int, Path]) -> None:
        _, _, root = live_server
        make_task(root, "task-waiting", status="awaiting_plan_approval")

        _, _, body = http_request(live_server[:2], "GET", "/api/progress")

        document = json.loads(body)
        assert document["tasks"]
        assert document["issues"] == []

    def test_default_refresh_is_reported(self, live_server: tuple[str, int, Path]) -> None:
        _, _, body = http_request(live_server[:2], "GET", "/api/progress")
        document = json.loads(body)
        assert document["refresh_seconds"] == 60
        assert document["refresh_source"] == "default"

    def test_configured_refresh_is_reported(self, tmp_path: Path) -> None:
        root = tmp_path / ".forgeloop"
        root.mkdir()
        server = build_server(settings_for(root, refresh=RefreshSetting(120, RefreshSource.CONFIG)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            _, _, body = http_request(
                (str(server.server_address[0]), int(server.server_address[1])),
                "GET",
                "/api/progress",
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        document = json.loads(body)
        assert document["refresh_seconds"] == 120
        assert document["refresh_source"] == "config"


class TestPage:
    def test_root_serves_the_html_page(self, live_server: tuple[str, int, Path]) -> None:
        status, headers, body = http_request(live_server[:2], "GET", "/")
        assert status == 200
        assert headers["content-type"] == "text/html; charset=utf-8"
        text = body.decode("utf-8")
        assert text == page_html()
        assert "ForgeLoop" in text

    def test_head_returns_headers_without_body(self, live_server: tuple[str, int, Path]) -> None:
        status, headers, body = http_request(live_server[:2], "HEAD", "/")
        assert status == 200
        assert int(headers["content-length"]) > 0
        assert body == b""

    def test_serves_the_compiled_page_modules(self, live_server: tuple[str, int, Path]) -> None:
        status, headers, body = http_request(live_server[:2], "GET", "/app.js")

        assert status == 200
        assert headers["content-type"] == "text/javascript; charset=utf-8"
        assert b"bootstrap" in body

    @pytest.mark.parametrize(
        "path",
        ["/../web.py", "/static/app.js", "/APP.JS", "/app.js/../format.js", "/nope.js"],
    )
    def test_module_names_outside_the_pattern_are_not_found(
        self, live_server: tuple[str, int, Path], path: str
    ) -> None:
        status, _, _ = http_request(live_server[:2], "GET", path)

        assert status == 404, path

    def test_unknown_path_is_not_found(self, live_server: tuple[str, int, Path]) -> None:
        status, headers, body = http_request(live_server[:2], "GET", "/nope")
        assert status == 404
        assert headers["content-type"] == "application/json; charset=utf-8"
        assert json.loads(body)["error"] == "not_found"


class TestProtocol:
    def test_connection_closes_after_each_response(
        self, live_server: tuple[str, int, Path]
    ) -> None:
        """HTTP/1.0 语义：响应后关连接，避免空闲长连接占线程并每 30 秒写超时日志。"""

        host, port, _ = live_server
        connection = http.client.HTTPConnection(host, port, timeout=10)
        try:
            connection.request("GET", "/api/progress")
            response = connection.getresponse()
            body = response.read()
        finally:
            connection.close()

        assert response.version == 10
        assert response.will_close is True
        assert json.loads(body)["schema_version"] == 1


class TestReadOnly:
    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    def test_write_methods_are_rejected(
        self, live_server: tuple[str, int, Path], method: str
    ) -> None:
        status, headers, body = http_request(live_server[:2], method, "/api/progress")
        assert status == 405
        assert headers["allow"] == "GET, HEAD"
        assert json.loads(body)["error"] == "method_not_allowed"

    def test_rejected_write_does_not_change_records(
        self, live_server: tuple[str, int, Path]
    ) -> None:
        _, _, root = live_server
        make_task(root, "task-1")
        before = (project_records(root) / "records.sqlite").read_bytes()

        http_request(live_server[:2], "POST", "/api/progress")

        assert (project_records(root) / "records.sqlite").read_bytes() == before


class TestWebConfigFile:
    def test_missing_file_keeps_the_one_minute_default(self, tmp_path: Path) -> None:
        assert load_web_config(tmp_path / "web.toml") is None
        assert resolve_refresh_seconds(None).seconds == 60

    def test_repository_config_ships_the_default(self) -> None:
        config = load_web_config(ROOT / "config" / "web.toml")
        assert config is not None
        assert resolve_refresh_seconds(config).seconds == 60

    def test_file_value_is_used(self, tmp_path: Path) -> None:
        path = tmp_path / "web.toml"
        path.write_text("schema_version = 1\nrefresh_seconds = 120\n", encoding="utf-8")
        config = load_web_config(path)
        assert config is not None
        assert resolve_refresh_seconds(config).seconds == 120

    def test_unknown_schema_version_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "web.toml"
        path.write_text("schema_version = 2\nrefresh_seconds = 60\n", encoding="utf-8")
        with pytest.raises(ValueError, match="schema_version"):
            load_web_config(path)

    def test_malformed_toml_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "web.toml"
        path.write_text("refresh_seconds = = 60\n", encoding="utf-8")
        with pytest.raises(ValueError, match="解析"):
            load_web_config(path)
