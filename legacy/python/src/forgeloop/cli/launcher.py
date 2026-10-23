"""固定启动器（T3）：托管业务进程、排空、切换与失败恢复。

systemd 只启动本模块（forgeloop-launcher），普通业务版本升级不改写 unit、不调用
systemctl。启动器从 releases/<version>/bin/forgeloop 的绝对路径启动业务进程，
独占写升级现场；切换请求只经本机 Unix socket 进入。

关键约束（方案 §3）：

- 启动器独立核对发布回执、每版本部署批准、项目/前缀绑定、标签提交与产物 SHA256；
  请求里的 by/reason 只是审计字段。
- 单启动器锁 + 单次切换互斥；相同请求幂等回查，不同并发请求确定性拒绝。
- 排空以业务进程写出的排空报告为准；超时进入 deferred，旧进程继续，不强杀。
- 新版失败且确认退出后从旧版本绝对路径恢复；恢复也失败进入 recovery_required。
- 启动器异常重启按现场对账；无法确认时等待人工，绝不启动第二个执行实例。
"""

from __future__ import annotations

import argparse
import contextlib
import os
import signal
import subprocess
import sys
import time
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, Lock
from types import FrameType

from forgeloop.adapter.deployment import (
    DeploymentError,
    activate,
    current_version,
    default_prefix,
    download_asset,
    install_wheel,
    release_assets,
    remote_slug,
    sha256_of_file,
    version_binary,
)
from forgeloop.adapter.git_workspace import tag_commit
from forgeloop.adapter.upgrade_control import (
    ControlError,
    ControlServer,
    acquire_launcher_lock,
    is_managed,
    prefix_summary,
    process_alive,
    process_start_token,
    read_owner,
    write_owner,
)
from forgeloop.domain.deploy import parse_checksum_file, select_wheel
from forgeloop.domain.project import ProjectError, project_data_root
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.upgrade import (
    PHASE_COMMITTED,
    PHASE_DEFERRED,
    PHASE_DRAINING,
    PHASE_PREPARED,
    PHASE_PROBING,
    PHASE_RECOVERY_REQUIRED,
    PHASE_ROLLED_BACK,
    PHASE_STARTING,
    PROTOCOL_VERSION,
    ArtifactManifest,
    DrainDecision,
    OwnerBinding,
    UpgradeError,
    UpgradeIdentity,
    UpgradeRequest,
    UpgradeSettings,
    UpgradeState,
    drain_decision,
    manifest_problem,
    next_generation,
    parse_upgrade_request,
    readiness_problem,
    reconcile_restart,
    resolve_upgrade_settings,
    switch_decision,
)
from forgeloop.records.projects import (
    ProjectLocation,
    ProjectStore,
    project_records_path,
    releases_by_tag,
)
from forgeloop.records.store import RecordStore
from forgeloop.records.upgrade_state import (
    UpgradeStateStore,
    read_json,
    write_json_atomic,
)

DEFAULT_SERVICE_CONFIG = "config/service.toml"
DEFAULT_WEB_CONFIG = "config/web.toml"
DEFAULT_PROJECTS_FILE = "config/projects.toml"
SHUTDOWN_GRACE_SECONDS = 10.0
CONTROL_POLL_SECONDS = 0.2
MANIFEST_NAME = "artifact.json"
SignalHandler = Callable[[int, FrameType | None], object] | int | None


class LauncherRefused(RuntimeError):
    """切换前置不满足或现场不允许继续；带可展示的中文原因。"""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _prefix(value: str) -> Path:
    return Path(value).expanduser().resolve() if value else default_prefix()


def _read_service_document(path: Path) -> Mapping[str, object] | None:
    if not path.is_file():
        return None
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise LauncherRefused(f"服务配置不可读 {path}: {error}") from error


def _upgrade_settings(path: Path) -> UpgradeSettings:
    document = _read_service_document(path)
    section = None if document is None else document.get("upgrade")
    try:
        return resolve_upgrade_settings(section)
    except UpgradeError as error:
        raise LauncherRefused(f"{path}: {error}") from error


def _manifest_for(version_dir: Path) -> ArtifactManifest | None:
    path = version_dir / MANIFEST_NAME
    if not path.is_file():
        return None
    try:
        return ArtifactManifest.from_document(read_json(path))
    except UpgradeError as error:
        raise LauncherRefused(f"{path}: {error}") from error


def _write_manifest(version_dir: Path, manifest: ArtifactManifest) -> None:
    write_json_atomic(version_dir / MANIFEST_NAME, manifest.to_document())


def _receipt_digest(location: ProjectLocation, release: ReleaseRecord) -> str:
    """从发布回执读取产物 SHA256（与 deploy 的权威来源同一份文件）。"""

    receipt = Path(release.receipt_path)
    candidates: list[Path] = []
    if receipt.is_absolute():
        candidates.append(receipt)
    else:
        candidates.append(location.root / receipt)
        candidates.extend(sorted(location.root.glob(f"*/{receipt.name}")))
    for path in candidates:
        if not path.is_file():
            continue
        try:
            payload = read_json(path)
        except UpgradeError:
            continue
        if isinstance(payload, Mapping):
            digest = str(payload.get("artifact_sha256", ""))
            if len(digest) == 64:
                return digest
    return ""


def _identity_from_manifest(manifest: ArtifactManifest, generation: str) -> UpgradeIdentity:
    return UpgradeIdentity(
        version=manifest.version,
        tag=manifest.tag,
        artifact_sha256=manifest.artifact_sha256,
        build_commit=manifest.build_commit,
        generation=generation,
    )


def _verify_release_and_approval(
    owner: OwnerBinding, request: UpgradeRequest
) -> tuple[UpgradeIdentity, ProjectLocation, ReleaseRecord]:
    """独立核对发布回执、部署批准、项目/前缀绑定与标签提交。"""

    if request.project != owner.project:
        raise LauncherRefused(f"请求项目 {request.project} 与 owner 绑定 {owner.project} 不符")
    request_prefix = Path(request.prefix).expanduser().resolve()
    if request_prefix != Path(owner.prefix).expanduser().resolve():
        raise LauncherRefused(f"请求前缀 {request_prefix} 与 owner 绑定 {owner.prefix} 不符")
    matches = [
        item
        for item in releases_by_tag(Path(owner.registration_root), request.tag)
        if item[0].project.project_id == owner.project
    ]
    if not matches:
        raise LauncherRefused(f"缺少 {request.tag} 的发布回执；未发布的版本不升级")
    if len(matches) > 1:
        raise LauncherRefused(f"标签 {request.tag} 在同项目出现多条发布回执；拒绝")
    location, release = matches[0]
    digest = _receipt_digest(location, release)
    if not digest:
        raise LauncherRefused(f"发布回执里没有可核对的产物 SHA256：{release.receipt_path}")
    if digest != request.artifact_sha256:
        raise LauncherRefused(
            f"产物校验值与发布回执不符：回执 {digest[:12]}，请求 "
            f"{request.artifact_sha256[:12]}；拒绝（禁止重新构建）"
        )
    store = RecordStore(Path(owner.records_root) / "records.sqlite")
    try:
        approval = store.deploy_approval(request.tag)
    finally:
        store.close()
    if approval is None:
        raise LauncherRefused(
            "缺少该版本的人工部署批准：先运行 forgeloop deploy-approve --by/--reason"
        )
    if approval != (request.tag, request.artifact_sha256):
        raise LauncherRefused(
            f"部署批准与请求不符：批准 {approval[0]}/{approval[1][:12]}，"
            f"请求 {request.tag}/{request.artifact_sha256[:12]}"
        )
    repo = Path(str(location.project.repo_path))
    tagged = tag_commit(repo, request.tag) if str(repo) else ""
    if not tagged:
        raise LauncherRefused(f"无法读取标签 {request.tag} 指向的提交；拒绝升级")
    if tagged != release.merge_commit:
        raise LauncherRefused(
            f"标签提交与发布回执不一致：标签 {tagged[:12]}，"
            f"回执 {release.merge_commit[:12]}；拒绝升级"
        )
    identity = UpgradeIdentity(
        version=request.version,
        tag=request.tag,
        artifact_sha256=request.artifact_sha256,
        build_commit=release.merge_commit,
        generation="",
    )
    return identity, location, release


def _count_outstanding_actions(records_root: Path) -> int:
    db = records_root / "records.sqlite"
    if not db.is_file():
        raise LauncherRefused(f"项目记录库不存在，无法核对未完成动作：{db}")
    store = RecordStore(db)
    try:
        return sum(
            1 for task in store.all_tasks() if store.actions.outstanding(task.id) is not None
        )
    finally:
        store.close()


class Launcher:
    def __init__(self, owner: OwnerBinding, prefix: Path) -> None:
        self.owner = owner
        self.prefix = prefix
        self.settings = _upgrade_settings(Path(owner.service_config))
        self.store = UpgradeStateStore(prefix / "control")
        self.state: UpgradeState | None = None
        self._child: subprocess.Popen[bytes] | None = None
        # 启动器重启后接管的是已有业务进程，没有 Popen 句柄；按 PID 存活核对与停止。
        self._adopted_pid: int | None = None
        self._child_lock = Lock()
        self._switching = False
        self._stop = Event()
        self._control: ControlServer | None = None

    def run(self) -> int:
        with acquire_launcher_lock(self.prefix):
            try:
                self.state = self._reconcile_and_start()
            except LauncherRefused as error:
                print(f"FAIL: {error}", file=sys.stderr)
                return 1
            self._control = ControlServer(
                self.prefix, self._handle_control, protocol_version=PROTOCOL_VERSION
            )
            try:
                self._control.start()
            except OSError as error:
                self._stop_child()
                print(f"FAIL: 无法建立控制接口：{error}", file=sys.stderr)
                return 1
            print(
                f"启动器已就绪：prefix={self.prefix} project={self.owner.project} "
                f"pid={os.getpid()}",
                flush=True,
            )
            try:
                return self._supervise()
            finally:
                self._stop.set()
                if self._control is not None:
                    self._control.stop()
                self._stop_child()

    def _reconcile_and_start(self) -> UpgradeState:
        state = self.store.read()
        decision = reconcile_restart(
            state,
            child_alive=state is not None and process_alive(state.child_pid),
        )
        if state is None or decision.action in {"start", "restart"}:
            if state is None:
                state = self._adopt_current()
            else:
                state = self._restart_state(state, decision.generation)
            self._start_committed(state)
            return self.state if self.state is not None else state
        if decision.action == "adopt":
            assert state is not None
            self._adopted_pid = state.child_pid
            print(
                f"启动器接管运行中的业务进程 pid={state.child_pid} generation={state.generation}",
                flush=True,
            )
            return state
        if decision.action == "rollback":
            assert state is not None
            print(f"按现场恢复上一版本：{decision.reason}", flush=True)
            return self._rollback_after_restart(state)
        assert state is not None
        print(f"启动器等待人工核对：{decision.reason}", flush=True)
        self.store.append_event("reconcile_hold", state=state, detail=decision.reason)
        return state

    def _adopt_current(self) -> UpgradeState:
        version = current_version(self.prefix) or ""
        if not version:
            raise LauncherRefused(f"前缀 {self.prefix} 没有 current 激活版本；先完成首次受控部署")
        version_dir = self.prefix / "releases" / version
        manifest = _manifest_for(version_dir)
        if manifest is None:
            raise LauncherRefused(
                f"已激活版本缺少 {MANIFEST_NAME}，无法证明安装身份：{version_dir}"
            )
        generation = "gen-000001"
        identity = _identity_from_manifest(manifest, generation)
        state = UpgradeState(
            identity=identity,
            project=self.owner.project,
            prefix=str(self.prefix),
            records_root=self.owner.records_root,
            phase=PHASE_COMMITTED,
            generation=generation,
            detail="首次接入：启动器接管 current 指向的版本",
        )
        state = self.store.write(state)
        self.store.append_event("adopt_current", state=state, detail=identity.version)
        return state

    def _restart_state(self, state: UpgradeState, generation: str) -> UpgradeState:
        if not generation:
            generation = next_generation(state.generation)
        identity = replace(state.identity, generation=generation)
        target_phase = state.phase
        if state.phase in {PHASE_PREPARED, PHASE_DRAINING, PHASE_STARTING, PHASE_PROBING}:
            target_phase = PHASE_DEFERRED if state.phase == PHASE_DRAINING else PHASE_COMMITTED
        new_state = replace(
            state,
            phase=target_phase,
            generation=generation,
            identity=identity,
            child_pid=None,
            child_started_at="",
            detail="启动器异常重启：按现场重新启动同一版本",
        )
        new_state = self.store.write(new_state)
        self.store.append_event("reconcile_restart", state=new_state, detail=identity.version)
        return new_state

    def _rollback_after_restart(self, state: UpgradeState) -> UpgradeState:
        previous = state.previous
        if previous is None:
            new_state = replace(
                state,
                phase=PHASE_RECOVERY_REQUIRED,
                child_pid=None,
                detail="启动器重启后发现不完整切换且没有上一版本；人工核对",
            )
            new_state = self.store.write(new_state)
            self.store.append_event("reconcile_recovery", state=new_state, detail=new_state.detail)
            return new_state
        try:
            restored = self._restore_previous(previous, state)
        except LauncherRefused as error:
            new_state = replace(
                state,
                phase=PHASE_RECOVERY_REQUIRED,
                child_pid=None,
                detail=f"启动器重启恢复上一版本失败：{error}",
            )
            new_state = self.store.write(new_state)
            self.store.append_event("reconcile_recovery", state=new_state, detail=new_state.detail)
            return new_state
        if isinstance(restored, UpgradeState):
            return restored
        return self.state if self.state is not None else state

    def _start_committed(self, state: UpgradeState) -> None:
        process = self._spawn(state.identity)
        with self._child_lock:
            self._child = process
        state = replace(
            state,
            phase=PHASE_COMMITTED,
            child_pid=process.pid,
            child_started_at=process_start_token(process.pid),
            updated_at=_now_iso(),
        )
        self.state = self.store.write(state)
        self.store.append_event(
            "started",
            state=self.state,
            detail=f"pid={process.pid} version={state.identity.version}",
        )
        problem = self._wait_ready(process, state.identity)
        if problem:
            self._stop_child()
            raise LauncherRefused(f"业务进程未就绪：{problem}")

    def _spawn(self, identity: UpgradeIdentity) -> subprocess.Popen[bytes]:
        binary = version_binary(self.prefix, identity.version)
        if not binary.is_file():
            raise LauncherRefused(f"版本入口不存在：{binary}")
        ready = self.store.report_path("ready", identity.generation)
        drain = self.store.report_path("drain", identity.generation)
        for path in (ready, drain):
            with contextlib.suppress(OSError):
                path.unlink()
        environment = dict(os.environ)
        environment["FORGELOOP_UPGRADE_MANAGED"] = "1"
        environment["FORGELOOP_UPGRADE_STATE"] = str(self.store.state_path)
        environment["FORGELOOP_UPGRADE_GENERATION"] = identity.generation
        environment["FORGELOOP_UPGRADE_READY"] = str(ready)
        environment["FORGELOOP_UPGRADE_DRAIN_REPORT"] = str(drain)
        environment["FORGELOOP_UPGRADE_PREFIX"] = str(self.prefix)
        # 业务进程报告里必须带上实际项目/记录根；真实 serve 从自身设置取，替身测试
        # 也从同一环境读取，避免测试脚本猜测生产绑定。
        environment["FORGELOOP_UPGRADE_PROJECT"] = self.owner.project
        environment["FORGELOOP_UPGRADE_RECORDS_ROOT"] = self.owner.records_root
        command = [
            str(binary),
            "serve",
            "--project",
            self.owner.project,
            "--records-root",
            self.owner.registration_root,
            "--service-config",
            self.owner.service_config,
            "--web-config",
            self.owner.web_config,
            "--projects-file",
            self.owner.projects_file,
        ]
        try:
            return subprocess.Popen(
                command,
                cwd=self.owner.registration_root,
                env=environment,
                shell=False,
            )
        except OSError as error:
            raise LauncherRefused(f"无法启动业务进程 {binary}: {error}") from error

    def _wait_ready(self, process: subprocess.Popen[bytes], identity: UpgradeIdentity) -> str:
        ready_path = self.store.report_path("ready", identity.generation)
        release_dir = self.prefix / "releases" / identity.version
        deadline = time.monotonic() + self.settings.readiness_timeout_seconds
        last = "尚未写出就绪报告"
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return f"进程已退出（exit={process.returncode}）"
            try:
                report = read_json(ready_path)
            except UpgradeError as error:
                return f"就绪报告不可读：{error}"
            if isinstance(report, Mapping):
                problem = readiness_problem(
                    report,
                    expected=identity,
                    expected_pid=process.pid,
                    project=self.owner.project,
                    prefix=str(self.prefix),
                    records_root=self.owner.records_root,
                    release_dir=release_dir,
                )
                if not problem:
                    return ""
                last = problem
            time.sleep(CONTROL_POLL_SECONDS)
        return f"等待就绪超时：{last}"

    def _terminate_pid(self, pid: int, timeout: float) -> bool:
        """停止一个没有 Popen 句柄的已接管进程；返回是否确认退出。"""

        if not process_alive(pid):
            return True
        with contextlib.suppress(OSError):
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + max(0.1, timeout)
        while time.monotonic() < deadline:
            if not process_alive(pid):
                return True
            time.sleep(CONTROL_POLL_SECONDS)
        with contextlib.suppress(OSError):
            os.kill(pid, signal.SIGKILL)
        time.sleep(0.1)
        return not process_alive(pid)

    def _stop_child(self) -> None:
        with self._child_lock:
            process, self._child = self._child, None
            adopted, self._adopted_pid = self._adopted_pid, None
        if adopted is not None:
            self._terminate_pid(adopted, SHUTDOWN_GRACE_SECONDS)
        if process is None:
            return
        if process.poll() is None:
            with contextlib.suppress(OSError):
                process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=SHUTDOWN_GRACE_SECONDS)
        if process.poll() is None:
            with contextlib.suppress(OSError):
                process.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=2.0)

    def _supervise(self) -> int:
        while not self._stop.wait(0.5):
            if self._switching:
                continue
            with self._child_lock:
                process = self._child
                adopted = self._adopted_pid
            if process is not None and process.poll() is not None:
                print(
                    f"业务进程已退出（exit={process.returncode}），启动器退出等待 systemd 重启",
                    file=sys.stderr,
                    flush=True,
                )
                return process.returncode or 1
            if process is None and adopted is not None and not process_alive(adopted):
                print(
                    "接管的业务进程已退出，启动器退出等待 systemd 重启",
                    file=sys.stderr,
                    flush=True,
                )
                return 1
        return 0

    def _handle_control(
        self, operation: str, request: Mapping[str, object]
    ) -> Mapping[str, object]:
        if operation == "status":
            return self._status_response()
        if operation == "switch":
            payload = request.get("request")
            try:
                upgrade_request = parse_upgrade_request(payload)
            except UpgradeError as error:
                return _control_failure("invalid_request", str(error))
            return self._switch(upgrade_request)
        return _control_failure("unsupported_operation", f"不支持的控制操作: {operation}")

    def _status_response(self) -> dict[str, object]:
        state = self.store.read() or self.state
        child = self._child
        pid = child.pid if child is not None else self._adopted_pid
        alive = child.poll() is None if child is not None else process_alive(pid)
        return {
            "ok": True,
            "protocol_version": PROTOCOL_VERSION,
            "launcher_pid": os.getpid(),
            "state": None if state is None else state.to_document(),
            "child_pid": pid,
            "child_alive": alive,
            "owner": self.owner.to_document(),
            "prefix": prefix_summary(self.prefix),
        }

    def _switch(self, request: UpgradeRequest) -> Mapping[str, object]:
        self._switching = True
        try:
            return self._switch_locked(request)
        except LauncherRefused as error:
            return _control_failure("refused", str(error))
        except (DeploymentError, UpgradeError) as error:
            return _control_failure("refused", str(error))
        finally:
            self._switching = False

    def _switch_locked(self, request: UpgradeRequest) -> Mapping[str, object]:
        state = self.store.read() or self.state
        decision = switch_decision(state, request)
        if not decision.allowed:
            return _control_failure("refused", decision.reason)
        if decision.noop:
            return {
                "ok": True,
                "protocol_version": PROTOCOL_VERSION,
                "noop": True,
                "message": decision.reason,
                "state": None if state is None else state.to_document(),
            }
        if decision.in_progress:
            return _control_failure("in_progress", decision.reason)
        target, location, _release = _verify_release_and_approval(self.owner, request)
        self._ensure_candidate(target, location, request)
        if state is None:
            state = self._adopt_current()
        current_identity = state.identity
        current_generation = state.generation
        prepared = replace(
            state,
            phase=PHASE_PREPARED,
            request_id=request.request_id,
            upgrade_key=request.upgrade_key,
            # prepared/draining 期间当前 identity 仍是旧版；previous 只记录“再上一代”，
            # 到 starting 时才把旧版移入 previous、把候选移入 identity。
            previous=state.previous,
            candidate=target,
            drain_deadline="",
            detail=f"候选 {target.version} 已安装，等待排空",
        )
        prepared = self.store.write(prepared)
        self.state = prepared
        self.store.append_event("prepared", state=prepared, detail=request.request_id)
        draining = replace(
            prepared,
            phase=PHASE_DRAINING,
            drain_deadline=datetime.fromtimestamp(
                time.time() + self.settings.drain_timeout_seconds, UTC
            ).isoformat(),
            detail="关闭新动作，等待在途调用与会话轮结束",
        )
        draining = self.store.write(draining)
        self.state = draining
        self.store.append_event("draining", state=draining, detail=request.request_id)
        drain_result = self._wait_for_drain(current_generation)
        if not drain_result.proceed:
            with self._child_lock:
                old_child = self._child
                old_pid = old_child.pid if old_child is not None else self._adopted_pid
            if old_pid is None or not process_alive(old_pid):
                # 旧进程在排空完成前退出：不能把“延期”当成旧版仍在服务。
                return self._enter_recovery(
                    draining,
                    "旧业务进程在排空完成前退出；无法确认副作用，需人工核对",
                )
            deferred = replace(
                draining,
                phase=PHASE_DEFERRED,
                detail=f"排空未完成，已延期：{drain_result.reason}",
            )
            deferred = self.store.write(deferred)
            self.state = deferred
            self.store.append_event("deferred", state=deferred, detail=drain_result.reason)
            return _control_failure("deferred", f"排空未完成，已延期：{drain_result.reason}")
        with self._child_lock:
            old_child = self._child
            old_pid = old_child.pid if old_child is not None else self._adopted_pid
        if old_pid is None:
            return self._enter_recovery(draining, "排空完成但找不到旧业务进程")
        new_generation = next_generation(current_generation)
        candidate = replace(target, generation=new_generation)
        starting = replace(
            draining,
            phase=PHASE_STARTING,
            generation=new_generation,
            identity=candidate,
            candidate=target,
            child_pid=None,
            child_started_at="",
            detail="旧进程已排空，等待其退出后启动候选",
        )
        starting = self.store.write(starting)
        self.state = starting
        self.store.append_event("starting", state=starting, detail=request.request_id)
        if old_child is not None:
            try:
                old_child.wait(timeout=self.settings.recovery_timeout_seconds)
            except subprocess.TimeoutExpired:
                return self._enter_recovery(starting, "旧业务进程在排空后未在时限内退出")
        elif not self._terminate_pid(old_pid, self.settings.recovery_timeout_seconds):
            return self._enter_recovery(starting, "接管中的旧业务进程在排空后未退出")
        with self._child_lock:
            self._child = None
            self._adopted_pid = None
        process = self._spawn(candidate)
        with self._child_lock:
            self._child = process
        probing = replace(
            starting,
            phase=PHASE_PROBING,
            child_pid=process.pid,
            child_started_at=process_start_token(process.pid),
            detail="候选进程已启动，等待就绪核对",
        )
        probing = self.store.write(probing)
        self.state = probing
        self.store.append_event("probing", state=probing, detail=f"pid={process.pid}")
        problem = self._wait_ready(process, candidate)
        if problem:
            self._terminate_and_confirm(process)
            return self._rollback(
                probing,
                previous=current_identity,
                failed=candidate,
                reason=f"候选未就绪：{problem}",
            )
        try:
            activate(self.prefix, candidate.version)
        except DeploymentError as error:
            self._terminate_and_confirm(process)
            return self._rollback(
                probing,
                previous=current_identity,
                failed=candidate,
                reason=f"激活指针失败：{error}",
            )
        committed = replace(
            probing,
            phase=PHASE_COMMITTED,
            identity=candidate,
            previous=current_identity,
            candidate=None,
            detail=f"已提交 {candidate.version}（generation {new_generation}）",
        )
        committed = self.store.write(committed)
        self.state = committed
        self.store.append_event("committed", state=committed, detail=request.request_id)
        return {
            "ok": True,
            "protocol_version": PROTOCOL_VERSION,
            "message": f"已切换到 {candidate.version}（generation {new_generation}）",
            "state": committed.to_document(),
        }

    def _ensure_candidate(
        self, target: UpgradeIdentity, location: ProjectLocation, request: UpgradeRequest
    ) -> None:
        version_dir = self.prefix / "releases" / target.version
        if version_dir.exists():
            manifest = _manifest_for(version_dir)
            problem = manifest_problem(manifest, target)
            if problem:
                raise LauncherRefused(problem)
            if not version_binary(self.prefix, target.version).is_file():
                raise LauncherRefused(f"已安装版本缺少入口：{version_dir}")
            return
        artifact = self._candidate_artifact(target, location, request)
        try:
            install_wheel(artifact, version_dir)
        except DeploymentError as error:
            raise LauncherRefused(f"候选安装失败：{error}") from error
        _write_manifest(
            version_dir,
            ArtifactManifest(
                version=target.version,
                tag=target.tag,
                artifact_sha256=target.artifact_sha256,
                build_commit=target.build_commit,
                build_commit_source="release-receipt",
                installed_at=_now_iso(),
                source="release",
            ),
        )

    def _candidate_artifact(
        self, target: UpgradeIdentity, location: ProjectLocation, request: UpgradeRequest
    ) -> Path:
        name = f"forgeloop-{target.version}-py3-none-any.whl"
        artifact = self.prefix / "artifacts" / name
        if artifact.is_file() and sha256_of_file(artifact) == target.artifact_sha256:
            return artifact
        repo_text = str(location.project.repo_path).strip()
        repo = Path(repo_text) if repo_text else None
        slug = remote_slug(repo) if repo is not None else None
        if not slug:
            raise LauncherRefused(
                f"本地产物 {artifact} 不存在且无法从项目仓库确定 GitHub owner/name"
            )
        assets = release_assets(slug, request.tag)
        checksum = assets.get("SHA256SUMS")
        if checksum is None:
            raise LauncherRefused(f"Release {request.tag} 缺少 SHA256SUMS")
        checksum_path = download_asset(checksum, self.prefix / "artifacts" / "SHA256SUMS")
        checksums = parse_checksum_file(checksum_path.read_text(encoding="utf-8"))
        selected = select_wheel(checksums, target.version)
        if selected is None or selected not in assets:
            raise LauncherRefused(f"Release {request.tag} 没有 forgeloop-{target.version} 的 wheel")
        downloaded = download_asset(assets[selected], self.prefix / "artifacts" / selected)
        digest = sha256_of_file(downloaded)
        if digest != target.artifact_sha256:
            raise LauncherRefused(
                f"下载产物校验值不符：{digest[:12]} != {target.artifact_sha256[:12]}"
            )
        return downloaded

    def _wait_for_drain(self, generation: str) -> DrainDecision:
        deadline = time.monotonic() + self.settings.drain_timeout_seconds
        report: Mapping[str, object] | None = None
        last = "尚未取得排空报告"
        while time.monotonic() < deadline:
            with self._child_lock:
                child = self._child
                pid = child.pid if child is not None else self._adopted_pid
            if pid is None or not process_alive(pid):
                return DrainDecision(False, "旧业务进程在排空完成前已退出；无法确认副作用")
            try:
                report = self.store.read_report("drain", generation)
            except UpgradeError as error:
                return DrainDecision(False, f"排空报告不可读：{error}")
            if report is not None:
                try:
                    outstanding = _count_outstanding_actions(Path(self.owner.records_root))
                except LauncherRefused as error:
                    return DrainDecision(False, str(error))
                decision = drain_decision(
                    report,
                    expected_generation=generation,
                    expected_pid=pid,
                    outstanding_actions=outstanding,
                )
                if decision.proceed:
                    return decision
                last = decision.reason
            time.sleep(CONTROL_POLL_SECONDS)
        return DrainDecision(False, f"排空超时：{last}")

    def _terminate_and_confirm(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is None:
            with contextlib.suppress(OSError):
                process.terminate()
        try:
            process.wait(timeout=SHUTDOWN_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                process.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=2.0)

    def _rollback(
        self,
        state: UpgradeState,
        *,
        previous: UpgradeIdentity,
        failed: UpgradeIdentity,
        reason: str,
    ) -> Mapping[str, object]:
        restore_generation = next_generation(failed.generation or previous.generation)
        restore = replace(previous, generation=restore_generation)
        starting = replace(
            state,
            phase=PHASE_STARTING,
            generation=restore_generation,
            identity=restore,
            previous=failed,
            candidate=None,
            child_pid=None,
            child_started_at="",
            detail=f"{reason}；准备恢复 {previous.version}",
        )
        starting = self.store.write(starting)
        self.state = starting
        self.store.append_event("rollback_start", state=starting, detail=reason)
        try:
            result = self._restore_previous(previous, starting)
        except LauncherRefused as error:
            recovery = replace(
                starting,
                phase=PHASE_RECOVERY_REQUIRED,
                detail=f"{reason}；恢复上一版本也失败：{error}",
                child_pid=None,
            )
            recovery = self.store.write(recovery)
            self.state = recovery
            self.store.append_event("recovery_required", state=recovery, detail=recovery.detail)
            return _control_failure(
                "recovery_required",
                f"{reason}；上一版本恢复失败：{error}。已停止自动推进，需人工核对",
                state=recovery,
            )
        if isinstance(result, UpgradeState):
            return _control_failure(
                "rolled_back", f"{reason}；已恢复 {result.identity.version}", state=result
            )
        if result.get("ok") is False:
            return result
        return _control_failure("rolled_back", f"{reason}；已恢复上一版本")

    def _restore_previous(
        self, previous: UpgradeIdentity, state: UpgradeState
    ) -> Mapping[str, object] | UpgradeState:
        restore_generation = next_generation(state.generation)
        restore = replace(previous, generation=restore_generation)
        starting = replace(
            state,
            phase=PHASE_STARTING,
            generation=restore_generation,
            identity=restore,
            child_pid=None,
            child_started_at="",
            detail=f"恢复上一版本 {previous.version}",
        )
        starting = self.store.write(starting)
        self.state = starting
        self.store.append_event("restore_start", state=starting, detail=previous.version)
        process = self._spawn(restore)
        with self._child_lock:
            self._child = process
        probing = replace(
            starting,
            phase=PHASE_PROBING,
            child_pid=process.pid,
            child_started_at=process_start_token(process.pid),
        )
        probing = self.store.write(probing)
        self.state = probing
        problem = self._wait_ready(process, restore)
        if problem:
            self._terminate_and_confirm(process)
            raise LauncherRefused(f"恢复上一版本未就绪：{problem}")
        try:
            activate(self.prefix, restore.version)
        except DeploymentError as error:
            self._terminate_and_confirm(process)
            raise LauncherRefused(f"恢复激活指针失败：{error}") from error
        rolled = replace(
            probing,
            phase=PHASE_ROLLED_BACK,
            identity=restore,
            previous=state.candidate or state.previous,
            candidate=None,
            detail=f"已恢复 {restore.version}（generation {restore_generation}）",
        )
        rolled = self.store.write(rolled)
        self.state = rolled
        self.store.append_event("rolled_back", state=rolled, detail=previous.version)
        return rolled

    def _enter_recovery(self, state: UpgradeState, reason: str) -> Mapping[str, object]:
        recovery = replace(state, phase=PHASE_RECOVERY_REQUIRED, detail=reason, child_pid=None)
        recovery = self.store.write(recovery)
        self.state = recovery
        self.store.append_event("recovery_required", state=recovery, detail=reason)
        return _control_failure("recovery_required", reason, state=recovery)


def _control_failure(
    code: str, message: str, *, state: UpgradeState | None = None
) -> dict[str, object]:
    document: dict[str, object] = {
        "ok": False,
        "protocol_version": PROTOCOL_VERSION,
        "code": code,
        "message": message,
    }
    if state is not None:
        document["state"] = state.to_document()
    return document


def _init_owner(args: argparse.Namespace) -> int:
    prefix = _prefix(args.prefix)
    registration_root = Path(args.records_root).expanduser().resolve()
    project_id = args.project.strip()
    if not project_id:
        return _fail("--init-owner 需要 --project")
    store = ProjectStore(project_records_path(registration_root))
    try:
        project = store.require(project_id)
    except ProjectError as error:
        return _fail(str(error))
    finally:
        store.close()
    binding = OwnerBinding(
        project=project.project_id,
        prefix=str(prefix),
        registration_root=str(registration_root),
        records_root=str(project_data_root(registration_root, project.project_id)),
        service_config=str(Path(args.service_config).expanduser().resolve()),
        web_config=str(Path(args.web_config).expanduser().resolve()),
        projects_file=str(Path(args.projects_file).expanduser().resolve()),
    )
    try:
        path = write_owner(prefix, binding.to_document())
    except ControlError as error:
        return _fail(str(error))
    print(f"owner 绑定已写入：{path}")
    print(f"项目 {binding.project}；前缀 {binding.prefix}；记录根 {binding.records_root}")
    return 0


def _fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def add_launcher_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--prefix", default="", help="部署前缀（缺省 ~/.local/share/forgeloop）")
    parser.add_argument("--init-owner", action="store_true", help="首次接入：写 owner.json 后退出")
    parser.add_argument("--project", default="", help="本项目身份（--init-owner 必填）")
    parser.add_argument("--records-root", default=".forgeloop", help="项目登记根")
    parser.add_argument("--service-config", default=DEFAULT_SERVICE_CONFIG)
    parser.add_argument("--web-config", default=DEFAULT_WEB_CONFIG)
    parser.add_argument("--projects-file", default=DEFAULT_PROJECTS_FILE)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="forgeloop-launcher")
    add_launcher_parser(parser)
    args = parser.parse_args(argv)
    if args.init_owner:
        return _init_owner(args)
    prefix = _prefix(args.prefix)
    if not is_managed(prefix):
        return _fail(f"前缀尚未接入固定启动器：{prefix}（先用 --init-owner 完成首次接入）")
    try:
        owner = OwnerBinding.from_document(read_owner(prefix))
    except (ControlError, UpgradeError) as error:
        return _fail(str(error))
    if args.project and args.project != owner.project:
        return _fail(f"--project {args.project} 与 owner 绑定 {owner.project} 不同")
    launcher = Launcher(owner, prefix)
    previous_handlers: dict[int, SignalHandler] = {}

    def handler(signum: int, frame: FrameType | None) -> None:
        del signum, frame
        launcher._stop.set()

    for signum in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handler)
    try:
        return launcher.run()
    finally:
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)


if __name__ == "__main__":
    sys.exit(main())
