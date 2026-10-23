"""受控升级的本机控制接口（T3）：Unix socket、单启动器锁、owner 绑定与进程身份。

边界：

- 控制目录与 socket 权限收紧到运行账户（目录 0700、socket 0600）；连接方 UID 必须
  与启动器一致（Linux SO_PEERCRED / macOS getpeereid），否则拒绝。
- 协议版本与操作名固定，只支持 `status` 与 `switch`；请求体是长度受限的 JSON 对象，
  不接受任意命令、路径或环境变量。
- `by`/`reason` 只是审计字段，不是认证或批准凭证；批准与发布回执由启动器自行读取
  权威记录核对。
- 单启动器锁用 `fcntl.flock`；第二个启动器连接同一前缀会被拒绝，不会产生双实例。
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import uuid
from collections.abc import Callable, Generator, Mapping
from pathlib import Path
from typing import cast

from forgeloop.adapter.deployment import (
    current_version,
    default_prefix,
    installed_versions,
    journal_entries,
)

DEFAULT_PROTOCOL_VERSION = 1

CONTROL_DIRNAME = "control"
OWNER_FILENAME = "owner.json"
SOCKET_FILENAME = "upgrade.sock"
LOCK_FILENAME = "launcher.lock"
MAX_MESSAGE_BYTES = 64 * 1024
CLIENT_TIMEOUT_SECONDS = 10.0

REQUEST_OPERATIONS: frozenset[str] = frozenset({"status", "switch"})


class ControlError(RuntimeError):
    """控制接口不可用、身份不符或协议非法。"""


def control_dir(prefix: Path) -> Path:
    return Path(prefix) / CONTROL_DIRNAME


def owner_path(prefix: Path) -> Path:
    return control_dir(prefix) / OWNER_FILENAME


def socket_path(prefix: Path) -> Path:
    return control_dir(prefix) / SOCKET_FILENAME


def lock_path(prefix: Path) -> Path:
    return control_dir(prefix) / LOCK_FILENAME


def is_managed(prefix: Path) -> bool:
    """前缀是否已接入固定启动器（有 owner 绑定或升级现场）。"""

    base = control_dir(prefix)
    return (base / OWNER_FILENAME).is_file() or (base / "upgrade-state.json").is_file()


def _write_json_atomic(path: Path, document: Mapping[str, object]) -> None:
    """adapter 是叶子层：原子 JSON 写在这里保留一份小实现，不反向依赖 records。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(dict(document), handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def _read_json(path: Path) -> object | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlError(f"无法读取 {path}: {error}") from error


def write_owner(prefix: Path, document: Mapping[str, object]) -> Path:
    """首次接入时写 owner.json；已存在时拒绝覆盖（避免启动参数悄悄漂移）。"""

    path = owner_path(prefix)
    if path.exists():
        raise ControlError(f"owner 绑定已存在，拒绝覆盖：{path}")
    _write_json_atomic(path, document)
    return path


def read_owner(prefix: Path) -> Mapping[str, object]:
    """读取 owner.json 原始文档；字段含义/绑定校验由 cli 层的 domain 规则完成。"""

    path = owner_path(prefix)
    document = _read_json(path)
    if document is None:
        raise ControlError(f"前缀尚未接入固定启动器（缺少 {path}）")
    if not isinstance(document, Mapping):
        raise ControlError(f"{path} 必须是 JSON 对象")
    return cast("Mapping[str, object]", document)


def new_request_id() -> str:
    return f"upg-{uuid.uuid4().hex}"


@contextlib.contextmanager
def acquire_launcher_lock(prefix: Path) -> Generator[None]:
    """单启动器 / 单次切换互斥；拿不到锁立即失败，不排队。"""

    base = control_dir(prefix)
    base.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(base, 0o700)
    path = lock_path(prefix)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ControlError(f"已有启动器持有 {path}；拒绝启动第二个实例") from error
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def peer_uid(connection: socket.socket) -> int | None:
    """连接方 UID：Linux 用 SO_PEERCRED，macOS/BSD 用 LOCAL_PEERCRED。"""

    peercred = getattr(socket, "SO_PEERCRED", None)
    if peercred is not None:
        try:
            credentials = connection.getsockopt(socket.SOL_SOCKET, peercred, struct.calcsize("3i"))
            _pid, uid, _gid = struct.unpack("3i", credentials)
            return int(uid)
        except (AttributeError, OSError, struct.error):
            pass
    # macOS/BSD: struct xucred { u_int cr_version; uid_t cr_uid; ... }。
    local_peercred = getattr(socket, "LOCAL_PEERCRED", None)
    if local_peercred is not None and sys.platform == "darwin":
        try:
            raw = connection.getsockopt(0, local_peercred, 12)
            _version, uid, _ngroups = struct.unpack("III", raw[:12])
            return int(uid)
        except (AttributeError, OSError, struct.error):
            return None
    return None


def verify_peer(connection: socket.socket) -> None:
    uid = peer_uid(connection)
    if uid is None:
        raise ControlError("无法确认控制连接的调用方身份；拒绝")
    if uid != os.getuid():
        raise ControlError(f"控制连接来自其他 UID（{uid} != {os.getuid()}）；拒绝")


def send_message(connection: socket.socket, document: Mapping[str, object]) -> None:
    payload = json.dumps(dict(document), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ControlError("控制响应超过大小上限")
    connection.sendall(payload + b"\n")


def receive_message(connection: socket.socket) -> Mapping[str, object]:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_MESSAGE_BYTES:
            raise ControlError("控制请求超过大小上限")
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    payload = b"".join(chunks).split(b"\n", 1)[0]
    if not payload:
        raise ControlError("控制请求为空")
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlError(f"控制请求不是合法 JSON：{error}") from error
    if not isinstance(document, dict):
        raise ControlError("控制请求必须是 JSON 对象")
    return cast("dict[str, object]", document)


class ControlServer:
    """单启动器的本机 Unix socket 服务；每个连接处理一次请求。"""

    def __init__(
        self,
        prefix: Path,
        handler: Callable[[str, Mapping[str, object]], Mapping[str, object]],
        *,
        protocol_version: int = DEFAULT_PROTOCOL_VERSION,
    ) -> None:
        self._prefix = Path(prefix)
        self._handler = handler
        self._protocol_version = protocol_version
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    @property
    def path(self) -> Path:
        return socket_path(self._prefix)

    def start(self) -> None:
        base = control_dir(self._prefix)
        base.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(base, 0o700)
        path = self.path
        if path.exists() or path.is_symlink():
            path.unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        os.chmod(path, 0o600)
        server.listen(8)
        server.settimeout(0.5)
        self._socket = server
        self._thread = threading.Thread(
            target=self._accept_loop, name="forgeloop-upgrade-control", daemon=True
        )
        self._thread.start()

    def _accept_loop(self) -> None:
        assert self._socket is not None
        while not self._stop.is_set():
            try:
                connection, _ = self._socket.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            try:
                with connection:
                    verify_peer(connection)
                    request = receive_message(connection)
                    try:
                        response = self._dispatch(request)
                    except Exception as error:  # 控制请求失败必须可见，不能断开装死
                        response = {
                            "ok": False,
                            "protocol_version": self._protocol_version,
                            "code": "internal_error",
                            "message": f"{type(error).__name__}: {error}",
                        }
                    send_message(connection, response)
            except Exception:
                continue

    def _dispatch(self, request: Mapping[str, object]) -> Mapping[str, object]:
        protocol = request.get("protocol_version")
        if protocol != self._protocol_version:
            return {
                "ok": False,
                "protocol_version": self._protocol_version,
                "code": "protocol_mismatch",
                "message": f"控制协议版本不支持: {protocol!r}",
            }
        operation = request.get("operation")
        if operation not in REQUEST_OPERATIONS:
            return {
                "ok": False,
                "protocol_version": self._protocol_version,
                "code": "unsupported_operation",
                "message": f"不支持的控制操作: {operation!r}",
            }
        return self._handler(str(operation), request)

    def stop(self) -> None:
        self._stop.set()
        server, self._socket = self._socket, None
        if server is not None:
            with contextlib.suppress(OSError):
                server.close()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._thread = None
        with contextlib.suppress(OSError):
            self.path.unlink()


def control_request(
    prefix: Path,
    document: Mapping[str, object],
    *,
    timeout: float = CLIENT_TIMEOUT_SECONDS,
) -> Mapping[str, object]:
    """作为同机客户端调用控制接口；连接失败如实抛错。"""

    path = socket_path(prefix)
    if not path.exists():
        raise ControlError(f"控制接口不存在（启动器未运行?）：{path}")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(timeout)
            connection.connect(str(path))
            send_message(connection, document)
            return receive_message(connection)
    except (OSError, ControlError) as error:
        raise ControlError(f"控制接口调用失败：{error}") from error


def process_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def process_start_token(pid: int | None) -> str:
    """进程身份令牌（启动时刻），用于避免仅凭 PID 数字认领进程。"""

    if pid is None or pid <= 0:
        return ""
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip()


def prefix_summary(prefix: Path) -> dict[str, object]:
    """只读现场摘要：current、已安装版本与部署日志尾部（不含凭据）。"""

    journal = journal_entries(prefix)
    return {
        "prefix": str(prefix),
        "current_version": current_version(prefix) or "",
        "installed_versions": list(installed_versions(prefix)),
        "last_deployment": journal[-1] if journal else None,
    }


def default_control_prefix() -> Path:
    return default_prefix()


__all__ = [
    "CONTROL_DIRNAME",
    "ControlError",
    "ControlServer",
    "acquire_launcher_lock",
    "control_dir",
    "control_request",
    "default_control_prefix",
    "is_managed",
    "lock_path",
    "new_request_id",
    "owner_path",
    "peer_uid",
    "prefix_summary",
    "process_alive",
    "process_start_token",
    "read_owner",
    "socket_path",
    "verify_peer",
    "write_owner",
]
