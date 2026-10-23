"""控制接口集成：真实 Unix socket、同 UID 校验、单启动器锁与固定协议。

不伪造生产批准；这里只验证“接口本身”的认证/拒绝/生命周期，切换业务由场景测试覆盖。
"""

import os
import socket
import stat
import tempfile
import threading
from collections.abc import Mapping
from pathlib import Path

import pytest

from forgeloop.adapter.upgrade_control import (
    ControlError,
    ControlServer,
    acquire_launcher_lock,
    control_request,
    is_managed,
    read_owner,
    socket_path,
    write_owner,
)
from forgeloop.domain.upgrade import PROTOCOL_VERSION, OwnerBinding

PROJECT = "forgeloop"


def _binding(tmp_path: Path) -> tuple[Path, OwnerBinding]:
    # macOS 的 AF_UNIX 路径上限约 104 字节：pytest 的临时目录太长，前缀用 /tmp 短路径。
    prefix = Path(tempfile.mkdtemp(prefix="flup-", dir="/tmp"))
    registration = tmp_path / "records"
    project_root = registration / "projects" / PROJECT
    project_root.mkdir(parents=True, exist_ok=True)
    binding = OwnerBinding(
        project=PROJECT,
        prefix=str(prefix),
        registration_root=str(registration),
        records_root=str(project_root),
        service_config=str(tmp_path / "service.toml"),
        web_config=str(tmp_path / "web.toml"),
        projects_file=str(tmp_path / "projects.toml"),
    )
    return prefix, binding


def _server(prefix: Path) -> ControlServer:
    def handler(operation: str, request: Mapping[str, object]) -> Mapping[str, object]:
        if operation == "status":
            return {"ok": True, "protocol_version": PROTOCOL_VERSION, "operation": "status"}
        return {"ok": True, "protocol_version": PROTOCOL_VERSION, "echo": request}

    server = ControlServer(prefix, handler)
    server.start()
    return server


class TestOwnerBinding:
    def test_round_trip(self, tmp_path: Path) -> None:
        prefix, binding = _binding(tmp_path)

        path = write_owner(prefix, binding.to_document())

        assert path.is_file()
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert read_owner(prefix) == binding.to_document()
        assert is_managed(prefix) is True

    def test_refuses_overwrite_and_missing(self, tmp_path: Path) -> None:
        prefix, binding = _binding(tmp_path)
        write_owner(prefix, binding.to_document())
        with pytest.raises(ControlError, match="拒绝覆盖"):
            write_owner(prefix, binding.to_document())
        with pytest.raises(ControlError, match="尚未接入"):
            read_owner(tmp_path / "other")

    def test_owner_requires_project_record_root(self, tmp_path: Path) -> None:
        _prefix, binding = _binding(tmp_path)
        with pytest.raises(ValueError, match="records_root"):
            OwnerBinding(
                project=binding.project,
                prefix=binding.prefix,
                registration_root=binding.registration_root,
                records_root=str(tmp_path / "elsewhere"),
                service_config=binding.service_config,
                web_config=binding.web_config,
                projects_file=binding.projects_file,
            )


class TestSocketProtocol:
    def test_status_round_trip_and_permissions(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        server = _server(prefix)
        try:
            assert stat.S_IMODE(os.stat(socket_path(prefix)).st_mode) == 0o600
            response = control_request(
                prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "status"}
            )
            assert response["ok"] is True
            assert response["operation"] == "status"
        finally:
            server.stop()

    def test_protocol_and_operation_are_refused(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        server = _server(prefix)
        try:
            mismatch = control_request(prefix, {"protocol_version": 99, "operation": "status"})
            assert mismatch["ok"] is False
            assert mismatch["code"] == "protocol_mismatch"

            unsupported = control_request(
                prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "exec"}
            )
            assert unsupported["ok"] is False
            assert unsupported["code"] == "unsupported_operation"
        finally:
            server.stop()

    def test_missing_socket_is_reported(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        with pytest.raises(ControlError, match="不存在"):
            control_request(prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "status"})

    def test_oversized_request_is_rejected(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        server = _server(prefix)
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(5)
                connection.connect(str(socket_path(prefix)))
                try:
                    connection.sendall(b"x" * (70 * 1024))
                    data = connection.recv(4096)
                except (BrokenPipeError, ConnectionResetError):
                    # 服务端在读满上限前就拒绝并关闭：这是被拒绝的两种真实形态。
                    data = b""
            assert data == b"" or b"ok" not in data
        finally:
            server.stop()


class TestAdapterEdges:
    def test_peer_uid_matches_current_user(self) -> None:
        import tempfile

        from forgeloop.adapter.upgrade_control import peer_uid

        path = Path(tempfile.mkdtemp(prefix="flup-peer-", dir="/tmp")) / "s.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(1)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.connect(str(path))
            connection, _ = server.accept()
            try:
                assert peer_uid(connection) == os.getuid()
            finally:
                connection.close()
        finally:
            client.close()
            server.close()

    def test_process_helpers_and_prefix_summary(self, tmp_path: Path) -> None:
        from forgeloop.adapter.deployment import activate, append_journal
        from forgeloop.adapter.upgrade_control import (
            prefix_summary,
            process_alive,
            process_start_token,
        )

        assert process_alive(os.getpid()) is True
        assert process_alive(None) is False
        assert process_alive(99999999) is False
        assert isinstance(process_start_token(os.getpid()), str)

        prefix = tmp_path / "prefix"
        (prefix / "releases" / "0.0.1" / "bin").mkdir(parents=True)
        (prefix / "releases" / "0.0.1" / "bin" / "forgeloop").write_text("#!/bin/sh\n")
        activate(prefix, "0.0.1")
        append_journal(prefix, {"version": "0.0.1", "artifact_sha256": "a" * 64})
        summary = prefix_summary(prefix)
        assert summary["current_version"] == "0.0.1"
        assert summary["installed_versions"] == ["0.0.1"]
        deployment = summary["last_deployment"]
        assert isinstance(deployment, dict)
        assert deployment["version"] == "0.0.1"

    def test_corrupt_owner_is_refused(self, tmp_path: Path) -> None:
        prefix, _binding_data = _binding(tmp_path)
        (prefix / "control").mkdir(parents=True, exist_ok=True)
        (prefix / "control" / "owner.json").write_text("{broken", encoding="utf-8")
        with pytest.raises(ControlError, match="无法读取"):
            read_owner(prefix)

    def test_control_request_to_dead_socket_is_reported(self, tmp_path: Path) -> None:
        prefix, _binding_data = _binding(tmp_path)
        (prefix / "control").mkdir(parents=True, exist_ok=True)
        (prefix / "control" / "upgrade.sock").write_text("stale", encoding="utf-8")
        with pytest.raises(ControlError, match="调用失败"):
            control_request(prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "status"})


class TestProtocolEdges:
    def test_json_and_message_limits(self, tmp_path: Path) -> None:
        from forgeloop.adapter import upgrade_control as module

        path = tmp_path / "bad.json"
        path.write_text("{broken", encoding="utf-8")
        with pytest.raises(module.ControlError):
            module._read_json(path)
        assert module._read_json(tmp_path / "missing.json") is None

        left, right = socket.socketpair()
        try:
            left.sendall(b"\n")
            with pytest.raises(module.ControlError, match="为空"):
                module.receive_message(right)
        finally:
            left.close()
            right.close()

    def test_server_stop_is_idempotent(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        server = _server(prefix)
        server.stop()
        server.stop()

    def test_owner_requires_project_root(self, tmp_path: Path) -> None:
        from forgeloop.domain.upgrade import OwnerBinding

        prefix, binding = _binding(tmp_path)
        with pytest.raises(ValueError):
            OwnerBinding(
                project=binding.project,
                prefix=binding.prefix,
                registration_root=binding.registration_root,
                records_root=str(tmp_path / "wrong"),
                service_config=binding.service_config,
                web_config=binding.web_config,
                projects_file=binding.projects_file,
            )
        assert prefix.exists()


class TestLauncherLock:
    def test_second_launcher_is_refused(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        ready = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with acquire_launcher_lock(prefix):
                ready.set()
                release.wait(5)

        thread = threading.Thread(target=hold)
        thread.start()
        assert ready.wait(2.0)
        try:
            with (
                pytest.raises(ControlError, match="已有启动器"),
                acquire_launcher_lock(prefix),
            ):
                pass
        finally:
            release.set()
            thread.join(timeout=3.0)

    def test_lock_is_released_after_exit(self, tmp_path: Path) -> None:
        prefix, _ = _binding(tmp_path)
        with acquire_launcher_lock(prefix):
            pass
        with acquire_launcher_lock(prefix):
            pass
