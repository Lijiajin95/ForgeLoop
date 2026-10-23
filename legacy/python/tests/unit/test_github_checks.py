"""GitHub 检查状态读取的单元测试：解析规则与 HTTP 读取（不访问外网）。

解析口径：同名检查取 id 最大者为最新；未完成或缺少 conclusion 一律记 pending
（不做乐观推断）；响应形态异常抛 ChecksError，绝不返回"通过"。
"""

import http.client
import http.server
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from forgeloop.adapter import github_checks
from forgeloop.adapter.github_checks import ChecksError, check_runs, fetch_json

SHA = "a" * 40


def stub(monkeypatch, payload: object) -> None:
    monkeypatch.setattr(github_checks, "fetch_json", lambda url: payload)


class TestCheckRunsParsing:
    def test_latest_run_per_name_wins(self, monkeypatch) -> None:
        runs = [
            {"id": 1, "name": "quality", "status": "completed", "conclusion": "failure"},
            {"id": 2, "name": "quality", "status": "completed", "conclusion": "success"},
        ]
        stub(monkeypatch, {"check_runs": runs})
        assert check_runs("owner/repo", SHA) == {"quality": "success"}

    def test_incomplete_run_is_pending(self, monkeypatch) -> None:
        runs = [{"id": 3, "name": "security", "status": "in_progress", "conclusion": None}]
        stub(monkeypatch, {"check_runs": runs})
        assert check_runs("owner/repo", SHA) == {"security": "pending"}

    def test_completed_without_conclusion_is_pending(self, monkeypatch) -> None:
        runs = [{"id": 4, "name": "security", "status": "completed", "conclusion": None}]
        stub(monkeypatch, {"check_runs": runs})
        assert check_runs("owner/repo", SHA) == {"security": "pending"}

    def test_conclusion_is_lowercased(self, monkeypatch) -> None:
        runs = [{"id": 5, "name": "quality", "status": "completed", "conclusion": "SUCCESS"}]
        stub(monkeypatch, {"check_runs": runs})
        assert check_runs("owner/repo", SHA) == {"quality": "success"}

    def test_malformed_entries_are_skipped(self, monkeypatch) -> None:
        runs = [
            "not-a-dict",
            {"id": "not-an-int", "name": "quality", "status": "completed", "conclusion": "x"},
            {"id": 6, "status": "completed", "conclusion": "success"},
            {"id": 7, "name": "quality", "status": "completed", "conclusion": "success"},
        ]
        stub(monkeypatch, {"check_runs": runs})
        assert check_runs("owner/repo", SHA) == {"quality": "success"}

    def test_non_dict_payload_is_rejected(self, monkeypatch) -> None:
        stub(monkeypatch, ["not-a-dict"])
        with pytest.raises(ChecksError, match="形态异常"):
            check_runs("owner/repo", SHA)

    def test_missing_check_runs_is_rejected(self, monkeypatch) -> None:
        stub(monkeypatch, {"total_count": 0})
        with pytest.raises(ChecksError, match="缺少 check_runs"):
            check_runs("owner/repo", SHA)


class _JsonHandler(http.server.BaseHTTPRequestHandler):
    payload = b"{}"

    def do_GET(self) -> None:
        body = type(self).payload
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


class _SimpleJsonHandler(_JsonHandler):
    payload = json.dumps({"check_runs": [{"id": 1, "name": "quality"}]}).encode()


class _SuccessHandler(_JsonHandler):
    payload = json.dumps(
        {
            "check_runs": [
                {"id": 9, "name": "quality", "status": "completed", "conclusion": "success"}
            ]
        }
    ).encode()


@contextmanager
def serve(handler: type[http.server.BaseHTTPRequestHandler]) -> Iterator[str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        host, port = server.server_address[:2]
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()


class TestFetchJson:
    def test_reads_json_over_http(self) -> None:
        with serve(_SimpleJsonHandler) as base:
            payload = fetch_json(f"{base}/repos/owner/repo/commits/x/check-runs")
        assert payload == {"check_runs": [{"id": 1, "name": "quality"}]}

    def test_check_runs_parses_over_http(self, monkeypatch) -> None:
        with serve(_SuccessHandler) as base:
            monkeypatch.setattr(github_checks, "CHECK_RUNS_API", f"{base}/api")
            assert check_runs("owner/repo", SHA) == {"quality": "success"}


class TestFetchJsonErrors:
    """真实使用中发现的缺陷：网络中断不能被当成检查失败或直接崩溃。"""

    def test_connection_drop_becomes_checks_error(self, monkeypatch) -> None:
        def boom(request: object, timeout: float) -> object:
            raise http.client.RemoteDisconnected("Remote end closed connection without response")

        monkeypatch.setattr(github_checks.urllib.request, "urlopen", boom)
        with pytest.raises(ChecksError, match="读取"):
            fetch_json("https://api.github.com/repos/owner/repo/commits/x/check-runs")

    def test_invalid_json_becomes_checks_error(self, monkeypatch) -> None:
        class Response:
            def read(self) -> bytes:
                return b"not json"

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *args: object) -> bool:
                return False

        monkeypatch.setattr(
            github_checks.urllib.request, "urlopen", lambda request, timeout: Response()
        )
        with pytest.raises(ChecksError, match="读取"):
            fetch_json("https://api.github.com/repos/owner/repo/commits/x/check-runs")
