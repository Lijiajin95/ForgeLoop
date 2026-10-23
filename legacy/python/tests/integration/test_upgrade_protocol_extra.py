"""控制接口错误分支补充：真实 socket，不启动业务进程。"""

import os
import socket
import tempfile
from collections.abc import Mapping
from pathlib import Path

import pytest

from forgeloop.adapter import upgrade_control as module
from forgeloop.domain.upgrade import PROTOCOL_VERSION, OwnerBinding


def _binding(tmp_path: Path) -> tuple[Path, OwnerBinding]:
    prefix = Path(tempfile.mkdtemp(prefix="flup-", dir="/tmp"))
    registration = tmp_path / "records"
    project_root = registration / "projects" / "forgeloop"
    project_root.mkdir(parents=True, exist_ok=True)
    binding = OwnerBinding(
        project="forgeloop",
        prefix=str(prefix),
        registration_root=str(registration),
        records_root=str(project_root),
        service_config=str(tmp_path / "service.toml"),
        web_config=str(tmp_path / "web.toml"),
        projects_file=str(tmp_path / "projects.toml"),
    )
    return prefix, binding


def _server(prefix: Path, handler) -> module.ControlServer:
    server = module.ControlServer(prefix, handler)
    server.start()
    return server


def test_handler_exception_is_reported(tmp_path: Path) -> None:
    prefix, _ = _binding(tmp_path)

    def handler(operation: str, request: Mapping[str, object]) -> Mapping[str, object]:
        raise RuntimeError("boom")

    server = _server(prefix, handler)
    try:
        response = module.control_request(
            prefix, {"protocol_version": PROTOCOL_VERSION, "operation": "status"}
        )
        assert response["ok"] is False
        assert response["code"] == "internal_error"
    finally:
        server.stop()


def test_invalid_json_request_is_rejected() -> None:
    left, right = socket.socketpair()
    try:
        left.sendall(b"not-json\n")
        with pytest.raises(module.ControlError, match="不是合法 JSON"):
            module.receive_message(right)
    finally:
        left.close()
        right.close()


def test_non_object_request_is_rejected() -> None:
    left, right = socket.socketpair()
    try:
        left.sendall(b"[]\n")
        with pytest.raises(module.ControlError, match="JSON 对象"):
            module.receive_message(right)
    finally:
        left.close()
        right.close()


def test_owner_document_must_be_object(tmp_path: Path) -> None:
    prefix, _ = _binding(tmp_path)
    (prefix / "control").mkdir(parents=True, exist_ok=True)
    (prefix / "control" / "owner.json").write_text("[]", encoding="utf-8")
    with pytest.raises(module.ControlError, match="JSON 对象"):
        module.read_owner(prefix)


def test_peer_uid_on_unix_socketpair() -> None:
    left, right = socket.socketpair()
    try:
        uid = module.peer_uid(left)
        assert uid in (None, os.getuid())
    finally:
        left.close()
        right.close()
