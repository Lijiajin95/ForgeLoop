"""check-runs 读取凭据的单元测试：``GITHUB_TOKEN`` → ``GH_TOKEN``（前者优先）。

只覆盖凭据接缝（请求头与匿名记录），不重复既有解析/网络错误行为；既有用例见
``tests/unit/test_github_checks.py``。测试不访问外网，全部经本地 HTTP 服务。
"""

import http.server
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import ClassVar

import pytest

from forgeloop.adapter import github_checks
from forgeloop.adapter.github_checks import check_runs, github_token

SHA = "a" * 40
TOKEN_ENV_VARS = ("GITHUB_TOKEN", "GH_TOKEN")


@pytest.fixture(autouse=True)
def _clear_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """每个用例都从「无凭据」起步，避免宿主环境变量串扰。"""

    for name in TOKEN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


class _RecordingHandler(http.server.BaseHTTPRequestHandler):
    """返回合法 check-runs 响应，并记录收到的请求头。"""

    seen: ClassVar[list[dict[str, str]]] = []
    payload = json.dumps({"check_runs": []}).encode()

    def do_GET(self) -> None:
        type(self).seen.append({key: value for key, value in self.headers.items()})
        body = type(self).payload
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


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


def capture_headers(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """经真实 HTTP 请求跑一次 check_runs，返回服务端看到的请求头。"""

    _RecordingHandler.seen.clear()
    with serve(_RecordingHandler) as base:
        monkeypatch.setattr(github_checks, "CHECK_RUNS_API", f"{base}/api")
        check_runs("owner/repo", SHA)
    return _RecordingHandler.seen[-1]


class TestGithubToken:
    def test_github_token_wins_over_gh_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GITHUB_TOKEN", "primary")
        monkeypatch.setenv("GH_TOKEN", "fallback")
        assert github_token() == "primary"

    def test_falls_back_to_gh_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GH_TOKEN", "fallback")
        assert github_token() == "fallback"

    def test_none_when_unset(self) -> None:
        assert github_token() is None

    def test_empty_values_are_treated_as_absent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GITHUB_TOKEN", "")
        monkeypatch.setenv("GH_TOKEN", "")
        assert github_token() is None


class TestAuthorizationHeader:
    def test_github_token_is_sent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GITHUB_TOKEN", "primary")
        monkeypatch.setenv("GH_TOKEN", "fallback")
        headers = capture_headers(monkeypatch)
        assert headers.get("Authorization") == "Bearer primary"

    def test_gh_token_is_sent_when_github_token_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GH_TOKEN", "fallback")
        headers = capture_headers(monkeypatch)
        assert headers.get("Authorization") == "Bearer fallback"

    def test_anonymous_without_tokens(self, monkeypatch: pytest.MonkeyPatch) -> None:
        headers = capture_headers(monkeypatch)
        assert "Authorization" not in headers

    def test_anonymous_read_is_recorded(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        headers = capture_headers(monkeypatch)
        assert "Authorization" not in headers
        assert "本次为匿名读取" in caplog.text
