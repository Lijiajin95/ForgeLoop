"""状态页命令入口的组件测试：启动前的确定性失败与成功后的启动输出。

只覆盖不需要真正开始服务的路径（配置损坏、刷新值非法、端口被占用）；真实监听与
HTTP 行为在 ``tests/integration/test_web_server.py``（进程内真实回环）与
``tests/system/test_web_process.py``（真实子进程）里用真实请求核对。
"""

import socket
from pathlib import Path

import pytest
from project_support import register_project

from forgeloop.cli.main import main as cli_main

pytestmark = pytest.mark.component


def run_cli(argv: list[str], capsys) -> tuple[int, str, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def busy_port() -> tuple[socket.socket, int]:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    return listener, int(listener.getsockname()[1])


class TestStartupFailures:
    def test_malformed_config_fails_before_listening(self, tmp_path: Path, capsys) -> None:
        config = tmp_path / "web.toml"
        config.write_text("refresh_seconds = = 60\n", encoding="utf-8")

        code, out, err = run_cli(
            ["web", "--web-config", str(config), "--records-root", str(tmp_path)], capsys
        )

        assert code == 1
        assert out == ""
        assert "FAIL:" in err
        assert "解析失败" in err

    def test_unknown_schema_version_fails_before_listening(self, tmp_path: Path, capsys) -> None:
        config = tmp_path / "web.toml"
        config.write_text("schema_version = 9\nrefresh_seconds = 60\n", encoding="utf-8")

        code, _, err = run_cli(
            ["web", "--web-config", str(config), "--records-root", str(tmp_path)], capsys
        )

        assert code == 1
        assert "schema_version" in err

    def test_invalid_refresh_value_names_the_flag(self, tmp_path: Path, capsys) -> None:
        code, _, err = run_cli(
            ["web", "--refresh-seconds", "-30", "--records-root", str(tmp_path)], capsys
        )

        assert code == 1
        assert "--refresh-seconds" in err

    def test_busy_port_is_reported_without_switching_ports(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        listener, port = busy_port()
        try:
            code, _, err = run_cli(
                ["web", "--port", str(port), "--records-root", str(tmp_path)], capsys
            )
        finally:
            listener.close()

        assert code == 1
        assert f"无法监听 127.0.0.1:{port}" in err

    def test_invalid_config_does_not_create_records(self, tmp_path: Path, capsys) -> None:
        config = tmp_path / "web.toml"
        config.write_text("schema_version = 9\n", encoding="utf-8")

        run_cli(["web", "--web-config", str(config), "--records-root", str(tmp_path)], capsys)

        assert list(tmp_path.glob("records.sqlite")) == []
