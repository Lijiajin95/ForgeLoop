"""GitHub 检查读取凭据与 403 限流快速失败的真实集成测试。

在本地 HTTP 服务上真实走一遍 adapter（urllib → ``fetch_json``/``check_runs``）与
归并轮询（``merge._wait_for_checks``），覆盖三条路径：

- 带凭据：请求真实携带 ``Authorization``，优先级 ``GITHUB_TOKEN`` → ``GH_TOKEN``；
- 不带凭据：请求保持匿名、不携带 ``Authorization``，并留下"本次为匿名读取"日志；
- 403 rate limit：归并第一次轮询即快速失败，诊断含是否匿名、限额与复位时间。

测试不访问外网，也不打桩 urllib；服务端记录真实收到的请求头与命中次数。
"""

import http.server
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import ClassVar

import pytest

from forgeloop.adapter import github_checks
from forgeloop.adapter.github_checks import ChecksError, check_runs, fetch_json
from forgeloop.cli import merge
from forgeloop.domain.merge import ChecksDecision

SHA = "a" * 40
TOKEN_ENV_VARS = ("GITHUB_TOKEN", "GH_TOKEN")
RESET_EPOCH = 1_700_000_000
CHECK_PAYLOAD = json.dumps(
    {"check_runs": [{"id": 1, "name": "quality", "status": "completed", "conclusion": "success"}]}
).encode()
FORBIDDEN_PAYLOAD = json.dumps({"message": "Resource not accessible by integration"}).encode()
RATE_LIMIT_PAYLOAD = json.dumps({"message": "API rate limit exceeded"}).encode()


@pytest.fixture(autouse=True)
def _clear_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """每个用例都从「无凭据」起步，避免宿主环境变量串扰。"""

    for name in TOKEN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


class _RecordingHandler(http.server.BaseHTTPRequestHandler):
    """按测试配置返回响应，并记录真实收到的请求头与命中次数。"""

    status: ClassVar[int] = 200
    response_headers: ClassVar[dict[str, str]] = {}
    payload: ClassVar[bytes] = CHECK_PAYLOAD
    requests: ClassVar[list[dict[str, str]]] = []

    def do_GET(self) -> None:
        type(self).requests.append({key: value for key, value in self.headers.items()})
        body = type(self).payload
        self.send_response(type(self).status)
        for key, value in type(self).response_headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


def handler_for(
    *, status: int = 200, headers: dict[str, str] | None = None, payload: bytes = CHECK_PAYLOAD
) -> type[_RecordingHandler]:
    """为单条用例生成隔离的处理器，避免类级状态跨用例串扰。"""

    class Handler(_RecordingHandler):
        pass

    Handler.status = status
    Handler.response_headers = dict(headers or {})
    Handler.payload = payload
    Handler.requests = []
    return Handler


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


def read_checks(
    monkeypatch: pytest.MonkeyPatch, handler: type[_RecordingHandler]
) -> dict[str, str]:
    """经真实 HTTP 跑一次 ``check_runs``，返回服务端记录的请求头。"""

    with serve(handler) as base:
        monkeypatch.setattr(github_checks, "CHECK_RUNS_API", f"{base}/api")
        result = check_runs("owner/repo", SHA)
    assert result == {"quality": "success"}
    return handler.requests[-1]


def wait_for_checks(
    monkeypatch: pytest.MonkeyPatch, handler: type[_RecordingHandler], *, timeout: float = 5.0
) -> tuple[ChecksDecision, dict]:
    """经真实 HTTP 跑一次归并检查轮询（等待基数置 0，避免真实睡眠）。"""

    monkeypatch.setattr(merge, "CHECK_POLL_SECONDS", 0.0)
    with serve(handler) as base:
        monkeypatch.setattr(github_checks, "CHECK_RUNS_API", f"{base}/api")
        return merge._wait_for_checks("owner/repo", SHA, ("quality",), timeout)


class TestCredentialsOverRealHttp:
    def test_github_token_is_sent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GITHUB_TOKEN", "primary")
        monkeypatch.setenv("GH_TOKEN", "fallback")
        headers = read_checks(monkeypatch, handler_for())
        assert headers.get("Authorization") == "Bearer primary"

    def test_gh_token_is_sent_when_github_token_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GH_TOKEN", "fallback")
        headers = read_checks(monkeypatch, handler_for())
        assert headers.get("Authorization") == "Bearer fallback"

    def test_anonymous_request_omits_authorization_and_is_recorded(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        headers = read_checks(monkeypatch, handler_for())
        assert "Authorization" not in headers
        assert "本次为匿名读取" in caplog.text


class TestRateLimitFastFailOverRealHttp:
    def test_anonymous_403_rate_limit_fails_fast_with_full_diagnostics(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = handler_for(
            status=403,
            headers={
                "X-RateLimit-Limit": "60",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(RESET_EPOCH),
            },
            payload=RATE_LIMIT_PAYLOAD,
        )
        decision, evidence = wait_for_checks(monkeypatch, handler)

        assert len(handler.requests) == 1, "限流后应立即失败，不再轮询"
        assert decision.passed is False
        assert decision.pending is False
        assert "本次为匿名读取" in decision.reason
        assert "限额 60" in decision.reason
        assert str(RESET_EPOCH) in decision.reason
        assert datetime.fromtimestamp(RESET_EPOCH, UTC).isoformat() in decision.reason
        assert evidence["rate_limited"] is True
        assert evidence["polls"] == 1

    def test_authenticated_403_rate_limit_reports_authenticated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GITHUB_TOKEN", "secret")
        handler = handler_for(
            status=403,
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "5000"},
            payload=RATE_LIMIT_PAYLOAD,
        )
        decision, _ = wait_for_checks(monkeypatch, handler)

        assert len(handler.requests) == 1
        assert decision.pending is False
        assert "本次为认证读取" in decision.reason
        assert "匿名" not in decision.reason
        assert "限额 5000" in decision.reason

    def test_secondary_rate_limit_retry_after_fails_fast(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = handler_for(
            status=403,
            headers={"Retry-After": "60"},
            payload=RATE_LIMIT_PAYLOAD,
        )
        decision, _ = wait_for_checks(monkeypatch, handler)

        assert len(handler.requests) == 1
        assert decision.pending is False
        assert "Retry-After 60s" in decision.reason

    def test_403_without_rate_limit_signal_keeps_retrying(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = handler_for(status=403, payload=FORBIDDEN_PAYLOAD)
        decision, evidence = wait_for_checks(monkeypatch, handler, timeout=0.02)

        assert len(handler.requests) >= 2, "普通 403 不应被误判为限流"
        assert decision.passed is False
        assert decision.pending is True
        assert "超时" in decision.reason
        assert "rate_limited" not in evidence


class TestChecksErrorDiagnostics:
    def test_403_error_carries_http_status_and_rate_limit_headers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler = handler_for(
            status=403,
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(RESET_EPOCH)},
            payload=RATE_LIMIT_PAYLOAD,
        )
        with serve(handler) as base, pytest.raises(ChecksError) as raised:
            fetch_json(f"{base}/api")
        cause = raised.value.__cause__
        try:
            assert getattr(cause, "code", None) == 403
            headers = getattr(cause, "headers", None)
            assert headers is not None
            assert headers.get("X-RateLimit-Remaining") == "0"
            assert headers.get("X-RateLimit-Reset") == str(RESET_EPOCH)
        finally:
            # HTTPError 持有响应 socket；不关闭会在 GC 时抛出 ResourceWarning。
            close = getattr(cause, "close", None)
            if callable(close):
                close()
