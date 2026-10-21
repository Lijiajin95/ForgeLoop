"""受控热升级的纯领域规则（T1-T4 共用，零 IO）。

方案：[docs/hot-upgrade-implementation-plan.md](../../../docs/hot-upgrade-implementation-plan.md)。
本模块只回答四类确定性问题，文件、socket、进程与数据库都在 adapter / records / cli：

1. **请求身份**：控制请求只允许固定字段；版本、产物校验值、项目、前缀与调用方
   理由全部校验后才形成稳定的 `upgrade_key`（审计与幂等依据，不是批准凭证）。
2. **执行准入**：只有已提交（`committed`）或已恢复（`rolled_back`）的代际可以启动新
   动作；`prepared` / `deferred` 期间旧进程继续执行；`draining` / `starting` /
   `probing` / `recovery_required` 一律拒绝。业务进程只读升级现场，不写它。
3. **状态流转**：只允许方案 §3.3 的路径；排空超时进入 `deferred`，新版失败且确认退出
   进入 `rolled_back`，回退也失败进入 `recovery_required`，不提供自动跳回。
4. **排空与就绪证据**：排空报告缺失/超时/不完整或有未核对动作时只能延期；就绪必须
   核对进程实际身份、generation、项目、记录根与模块加载路径，空输出或旧代响应不放行。

纯规则不读时钟、不读文件、不启动进程；时间戳由调用方传入。
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import cast

from forgeloop.domain.project import ProjectError, validate_project_id
from forgeloop.domain.release import DIGEST_PATTERN, parse_version

SCHEMA_VERSION = 1
PROTOCOL_VERSION = 1
"""控制协议版本：请求与状态文档都带版本号，未来不兼容时先拒绝再维护。"""

PHASE_PREPARED = "prepared"
PHASE_DRAINING = "draining"
PHASE_DEFERRED = "deferred"
PHASE_STARTING = "starting"
PHASE_PROBING = "probing"
PHASE_COMMITTED = "committed"
PHASE_ROLLED_BACK = "rolled_back"
PHASE_RECOVERY_REQUIRED = "recovery_required"

ALL_PHASES: frozenset[str] = frozenset(
    {
        PHASE_PREPARED,
        PHASE_DRAINING,
        PHASE_DEFERRED,
        PHASE_STARTING,
        PHASE_PROBING,
        PHASE_COMMITTED,
        PHASE_ROLLED_BACK,
        PHASE_RECOVERY_REQUIRED,
    }
)
ADMITTED_PHASES: frozenset[str] = frozenset(
    {PHASE_PREPARED, PHASE_DEFERRED, PHASE_COMMITTED, PHASE_ROLLED_BACK}
)
"""允许业务进程启动新动作的阶段；`prepared`/`deferred` 是“候选未切换、旧版继续”。"""

TRANSIENT_PHASES: frozenset[str] = frozenset(
    {PHASE_PREPARED, PHASE_DRAINING, PHASE_STARTING, PHASE_PROBING}
)
TERMINAL_PHASES: frozenset[str] = frozenset(
    {PHASE_COMMITTED, PHASE_DEFERRED, PHASE_ROLLED_BACK, PHASE_RECOVERY_REQUIRED}
)

DEFAULT_DRAIN_TIMEOUT_SECONDS = 300.0
DEFAULT_READINESS_TIMEOUT_SECONDS = 30.0
DEFAULT_RECOVERY_TIMEOUT_SECONDS = 30.0
DEFAULT_POLL_SECONDS = 0.25
MIN_DRAIN_TIMEOUT_SECONDS = 1.0
MAX_DRAIN_TIMEOUT_SECONDS = 3600.0
MAX_READINESS_TIMEOUT_SECONDS = 600.0
MAX_RESUME_TIMEOUT_SECONDS = 600.0

_GENERATION_PATTERN = re.compile(r"^gen-(?P<number>\d{6,})$")
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{7,64}$")
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
_BY_MAX_CHARS = 128
_REASON_MAX_CHARS = 1000

_REQUEST_FIELDS: frozenset[str] = frozenset(
    {
        "protocol_version",
        "request_id",
        "project",
        "prefix",
        "tag",
        "artifact_sha256",
        "by",
        "reason",
    }
)
_STATE_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "request_id",
        "upgrade_key",
        "phase",
        "generation",
        "identity",
        "previous",
        "candidate",
        "project",
        "prefix",
        "records_root",
        "child_pid",
        "child_started_at",
        "drain_deadline",
        "detail",
        "created_at",
        "updated_at",
    }
)
_IDENTITY_FIELDS: frozenset[str] = frozenset(
    {"version", "tag", "artifact_sha256", "build_commit", "generation"}
)
_OWNER_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "project",
        "prefix",
        "registration_root",
        "records_root",
        "service_config",
        "web_config",
        "projects_file",
    }
)
_SETTINGS_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "drain_timeout_seconds",
        "readiness_timeout_seconds",
        "recovery_timeout_seconds",
        "poll_seconds",
    }
)
_REPORT_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "ready",
        "pid",
        "generation",
        "version",
        "tag",
        "artifact_sha256",
        "build_commit",
        "project",
        "prefix",
        "records_root",
        "module_path",
        "http_host",
        "http_port",
    }
)
_DRAIN_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "generation",
        "pid",
        "completed",
        "active_calls",
        "active_turns",
        "active_agent_processes",
        "pending_requests",
        "detail",
    }
)
_MANIFEST_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "version",
        "tag",
        "artifact_sha256",
        "build_commit",
        "build_commit_source",
        "installed_at",
        "source",
    }
)


class UpgradeError(ValueError):
    """热升级规则不满足；调用方据此 fail-closed。"""


class UpgradeRequestError(UpgradeError):
    """控制请求字段、版本或身份非法。"""


class UpgradeStateError(UpgradeError):
    """升级现场不可解析或状态流转非法。"""


class UpgradeSettingsError(UpgradeError):
    """`[upgrade]` 配置非法。"""


class OwnerBindingError(UpgradeError):
    """owner.json 绑定非法。"""


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _absolute_path(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise UpgradeError(f"{field} 必须是非空绝对路径")
    text = value.strip()
    if "\x00" in text or "\n" in text or "\r" in text:
        raise UpgradeError(f"{field} 不能包含 NUL 或换行")
    path = Path(text)
    if not path.is_absolute():
        raise UpgradeError(f"{field} 必须是绝对路径: {text}")
    if ".." in path.parts:
        raise UpgradeError(f"{field} 不能包含父目录段: {text}")
    return text


def _require_mapping(value: object, kind: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise UpgradeError(f"{kind} 必须是对象")
    mapping = cast("Mapping[object, object]", value)
    if any(not isinstance(key, str) for key in mapping):
        raise UpgradeError(f"{kind} 的键必须是字符串")
    return cast("Mapping[str, object]", mapping)


def _reject_unknown(document: Mapping[str, object], allowed: frozenset[str], kind: str) -> None:
    unknown = sorted(set(document) - allowed)
    if unknown:
        raise UpgradeError(f"{kind} 含未知字段: {'、'.join(unknown)}")


def validate_generation(value: str) -> str:
    """代际标识形如 `gen-000001`；空串表示尚未启动业务进程。"""

    if value == "":
        return ""
    if not _GENERATION_PATTERN.fullmatch(value):
        raise UpgradeStateError(f"generation 非法: {value!r}（须为 gen-数字）")
    return value


def next_generation(current: str) -> str:
    """下一个代际：唯一、单调递增；从空串开始得到 `gen-000001`。"""

    if current == "":
        return "gen-000001"
    match = _GENERATION_PATTERN.fullmatch(current)
    if match is None:
        raise UpgradeStateError(f"generation 非法: {current!r}")
    number = int(match.group("number")) + 1
    return f"gen-{number:06d}"


@dataclass(frozen=True)
class UpgradeIdentity:
    """一个业务版本安装/运行的身份事实（不是批准，也不是健康证明）。"""

    version: str
    tag: str
    artifact_sha256: str
    build_commit: str = ""
    generation: str = ""

    def __post_init__(self) -> None:
        if parse_version(self.tag) is None or self.tag != f"v{self.version}":
            raise UpgradeStateError(f"版本/标签不一致: version={self.version!r} tag={self.tag!r}")
        if not DIGEST_PATTERN.match(self.artifact_sha256):
            raise UpgradeStateError("产物校验值须为 64 位十六进制小写")
        if self.build_commit and not _COMMIT_PATTERN.match(self.build_commit):
            raise UpgradeStateError(f"构建提交非法: {self.build_commit!r}")
        validate_generation(self.generation)

    def to_document(self) -> dict[str, str]:
        return {
            "version": self.version,
            "tag": self.tag,
            "artifact_sha256": self.artifact_sha256,
            "build_commit": self.build_commit,
            "generation": self.generation,
        }

    @classmethod
    def from_document(cls, document: object) -> UpgradeIdentity:
        data = _require_mapping(document, "identity")
        _reject_unknown(data, _IDENTITY_FIELDS, "identity")
        try:
            return cls(
                version=str(data["version"]),
                tag=str(data["tag"]),
                artifact_sha256=str(data["artifact_sha256"]),
                build_commit=str(data.get("build_commit", "")),
                generation=str(data.get("generation", "")),
            )
        except KeyError as error:
            raise UpgradeStateError(f"identity 缺少字段: {error.args[0]}") from error


@dataclass(frozen=True)
class UpgradeState:
    """升级现场的权威快照；由启动器独占写入，业务进程只读。"""

    identity: UpgradeIdentity
    project: str
    prefix: str
    records_root: str
    phase: str = PHASE_COMMITTED
    generation: str = "gen-000001"
    request_id: str = ""
    upgrade_key: str = ""
    previous: UpgradeIdentity | None = None
    candidate: UpgradeIdentity | None = None
    child_pid: int | None = None
    child_started_at: str = ""
    drain_deadline: str = ""
    detail: str = ""
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self) -> None:
        if self.phase not in ALL_PHASES:
            raise UpgradeStateError(f"未知升级阶段: {self.phase!r}")
        try:
            validate_project_id(self.project)
        except ProjectError as error:
            raise UpgradeStateError(str(error)) from error
        _absolute_path(self.prefix, "prefix")
        _absolute_path(self.records_root, "records_root")
        validate_generation(self.generation)
        if self.generation and self.identity.generation != self.generation:
            raise UpgradeStateError("state.generation 与 identity.generation 不一致")
        if self.child_pid is not None and (not _is_int(self.child_pid) or self.child_pid <= 0):
            raise UpgradeStateError("child_pid 必须是正整数或 null")
        if self.previous is not None and self.previous == self.identity:
            raise UpgradeStateError("previous 不能与当前 identity 相同")
        if self.candidate is not None and self.candidate == self.identity:
            raise UpgradeStateError("candidate 不能与当前 identity 相同")
        if self.upgrade_key and not DIGEST_PATTERN.match(self.upgrade_key):
            raise UpgradeStateError("upgrade_key 必须是 64 位十六进制")

    def to_document(self) -> dict[str, object]:
        return {
            "schema_version": SCHEMA_VERSION,
            "request_id": self.request_id,
            "upgrade_key": self.upgrade_key,
            "phase": self.phase,
            "generation": self.generation,
            "identity": self.identity.to_document(),
            "previous": None if self.previous is None else self.previous.to_document(),
            "candidate": None if self.candidate is None else self.candidate.to_document(),
            "project": self.project,
            "prefix": self.prefix,
            "records_root": self.records_root,
            "child_pid": self.child_pid,
            "child_started_at": self.child_started_at,
            "drain_deadline": self.drain_deadline,
            "detail": self.detail,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_document(cls, document: object) -> UpgradeState:
        try:
            data = _require_mapping(document, "升级现场")
            _reject_unknown(data, _STATE_FIELDS, "升级现场")
            if data.get("schema_version") != SCHEMA_VERSION:
                raise UpgradeStateError(
                    f"升级现场 schema_version 不支持: {data.get('schema_version')!r}"
                )
            identity = UpgradeIdentity.from_document(data["identity"])
            previous_raw = data.get("previous")
            candidate_raw = data.get("candidate")
            return cls(
                identity=identity,
                project=str(data["project"]),
                prefix=str(data["prefix"]),
                records_root=str(data["records_root"]),
                phase=str(data["phase"]),
                generation=str(data.get("generation", identity.generation)),
                request_id=str(data.get("request_id", "")),
                upgrade_key=str(data.get("upgrade_key", "")),
                previous=None
                if previous_raw is None
                else UpgradeIdentity.from_document(previous_raw),
                candidate=None
                if candidate_raw is None
                else UpgradeIdentity.from_document(candidate_raw),
                child_pid=None if data.get("child_pid") is None else int(str(data["child_pid"])),
                child_started_at=str(data.get("child_started_at", "")),
                drain_deadline=str(data.get("drain_deadline", "")),
                detail=str(data.get("detail", "")),
                created_at=str(data.get("created_at", "")),
                updated_at=str(data.get("updated_at", "")),
            )
        except KeyError as error:
            raise UpgradeStateError(f"升级现场缺少字段: {error.args[0]}") from error
        except UpgradeStateError:
            raise
        except UpgradeError as error:
            raise UpgradeStateError(str(error)) from error
        except (TypeError, ValueError) as error:
            raise UpgradeStateError(f"升级现场字段类型非法: {error}") from error


def transition_problem(current: str, target: str) -> str:
    """返回空串表示允许的状态流转；否则是可读拒绝原因。"""

    if current not in ALL_PHASES or target not in ALL_PHASES:
        return f"未知阶段流转: {current} -> {target}"
    allowed: dict[str, frozenset[str]] = {
        PHASE_PREPARED: frozenset({PHASE_DRAINING, PHASE_DEFERRED, PHASE_RECOVERY_REQUIRED}),
        PHASE_DRAINING: frozenset({PHASE_STARTING, PHASE_DEFERRED, PHASE_RECOVERY_REQUIRED}),
        PHASE_STARTING: frozenset({PHASE_PROBING, PHASE_ROLLED_BACK, PHASE_RECOVERY_REQUIRED}),
        PHASE_PROBING: frozenset({PHASE_COMMITTED, PHASE_ROLLED_BACK, PHASE_RECOVERY_REQUIRED}),
        PHASE_COMMITTED: frozenset({PHASE_PREPARED, PHASE_RECOVERY_REQUIRED}),
        PHASE_DEFERRED: frozenset({PHASE_PREPARED, PHASE_RECOVERY_REQUIRED}),
        PHASE_ROLLED_BACK: frozenset({PHASE_PREPARED, PHASE_RECOVERY_REQUIRED}),
        PHASE_RECOVERY_REQUIRED: frozenset(),
    }
    if target not in allowed[current]:
        return f"不允许的升级阶段流转: {current} -> {target}（人工核对前不自动推进）"
    return ""


def require_transition(current: str, target: str) -> None:
    problem = transition_problem(current, target)
    if problem:
        raise UpgradeStateError(problem)


@dataclass(frozen=True)
class AdmissionDecision:
    """某业务进程此刻能否启动新的执行动作。"""

    allowed: bool
    reason: str = ""
    phase: str = ""
    generation: str = ""


def admission_decision(
    *,
    managed: bool,
    phase: str,
    generation: str,
    process_generation: str,
) -> AdmissionDecision:
    """执行准入：托管现场按阶段与 generation 判定；非托管现场不改变既有行为。"""

    if not managed:
        return AdmissionDecision(True, "非托管进程：不应用热升级准入")
    if not generation or not process_generation:
        return AdmissionDecision(False, "缺少代际身份，无法准入", phase, generation)
    if phase not in ALL_PHASES:
        return AdmissionDecision(False, f"未知升级阶段: {phase}", phase, generation)
    if phase not in ADMITTED_PHASES:
        return AdmissionDecision(
            False,
            f"升级阶段 {phase}：拒绝启动新的执行动作（只读查询仍可用）",
            phase,
            generation,
        )
    if process_generation != generation:
        return AdmissionDecision(
            False,
            f"代际不匹配：现场 {generation}，本进程 {process_generation}；拒绝启动新动作",
            phase,
            generation,
        )
    return AdmissionDecision(True, "", phase, generation)


@dataclass(frozen=True)
class SwitchDecision:
    """一次切换请求相对现存现场是否可执行、是否幂等。"""

    allowed: bool
    reason: str
    noop: bool = False
    in_progress: bool = False


def switch_decision(state: UpgradeState | None, request: UpgradeRequest) -> SwitchDecision:
    """只读比对请求与现场；不安装、不排空、不改状态。"""

    if state is None:
        return SwitchDecision(True, "首次升级：没有既有现场")
    if state.project != request.project or state.prefix != request.prefix:
        return SwitchDecision(
            False,
            f"请求与现场绑定不符：现场 {state.project}@{state.prefix}，"
            f"请求 {request.project}@{request.prefix}",
        )
    if state.phase == PHASE_RECOVERY_REQUIRED:
        return SwitchDecision(False, "现场处于 recovery_required，必须先人工核对")
    same_target = (
        state.identity.version == request.version
        and state.identity.artifact_sha256 == request.artifact_sha256
    )
    if state.phase in TRANSIENT_PHASES:
        if state.upgrade_key == request.upgrade_key:
            return SwitchDecision(True, "同一升级请求正在处理中（幂等回查）", in_progress=True)
        return SwitchDecision(
            False, f"已有升级在进行中（{state.phase}）：{state.request_id or 'unknown'}"
        )
    if same_target and state.phase in {PHASE_COMMITTED, PHASE_ROLLED_BACK, PHASE_DEFERRED}:
        return SwitchDecision(True, "目标版本已是当前运行版本（幂等 noop）", noop=True)
    if (
        state.identity.version == request.version
        and state.identity.artifact_sha256 != request.artifact_sha256
    ):
        return SwitchDecision(
            False,
            f"同版本不同产物：已运行 {state.identity.artifact_sha256[:12]}，"
            f"请求 {request.artifact_sha256[:12]}；拒绝",
        )
    if state.identity.version == request.version and state.identity.tag != request.tag:
        return SwitchDecision(False, "同版本标签不一致；拒绝")
    return SwitchDecision(True, "可升级")


def request_upgrade_key(*, project: str, prefix: str, tag: str, artifact_sha256: str) -> str:
    payload = "\n".join((project, prefix, tag, artifact_sha256))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class UpgradeRequest:
    """经校验的控制请求；字段集合固定，不接受任意命令/路径/环境变量。"""

    request_id: str
    project: str
    prefix: str
    tag: str
    artifact_sha256: str
    by: str
    reason: str
    protocol_version: int = PROTOCOL_VERSION

    def __post_init__(self) -> None:
        if self.protocol_version != PROTOCOL_VERSION:
            raise UpgradeRequestError(
                f"控制协议版本不支持: {self.protocol_version}（期望 {PROTOCOL_VERSION}）"
            )
        if not _REQUEST_ID_PATTERN.fullmatch(self.request_id):
            raise UpgradeRequestError(
                "request_id 必须是 8-128 位字母/数字/./_/:/-,且以字母或数字开头"
            )
        try:
            validate_project_id(self.project)
        except ProjectError as error:
            raise UpgradeRequestError(str(error)) from error
        try:
            _absolute_path(self.prefix, "prefix")
        except UpgradeError as error:
            raise UpgradeRequestError(str(error)) from error
        if parse_version(self.tag) is None:
            raise UpgradeRequestError(f"标签不合法: {self.tag!r}；须为 vMAJOR.MINOR.PATCH")
        if not DIGEST_PATTERN.match(self.artifact_sha256):
            raise UpgradeRequestError("产物校验值须为 64 位十六进制小写")
        if not self.by.strip():
            raise UpgradeRequestError("控制请求必须带 by（审计字段，不是批准凭证）")
        if len(self.by.strip()) > _BY_MAX_CHARS:
            raise UpgradeRequestError(f"by 不能超过 {_BY_MAX_CHARS} 个字符")
        if not self.reason.strip():
            raise UpgradeRequestError("控制请求必须带 reason（审计字段，不是批准凭证）")
        if len(self.reason.strip()) > _REASON_MAX_CHARS:
            raise UpgradeRequestError(f"reason 不能超过 {_REASON_MAX_CHARS} 个字符")

    @property
    def version(self) -> str:
        return self.tag.removeprefix("v")

    @property
    def upgrade_key(self) -> str:
        return request_upgrade_key(
            project=self.project,
            prefix=self.prefix,
            tag=self.tag,
            artifact_sha256=self.artifact_sha256,
        )


def parse_upgrade_request(document: object) -> UpgradeRequest:
    try:
        data = _require_mapping(document, "控制请求")
        _reject_unknown(data, _REQUEST_FIELDS, "控制请求")
    except UpgradeError as error:
        raise UpgradeRequestError(str(error)) from error
    try:
        protocol_version = data["protocol_version"]
        request_id = data["request_id"]
        project = data["project"]
        prefix = data["prefix"]
        tag = data["tag"]
        artifact_sha256 = data["artifact_sha256"]
        by = data["by"]
        reason = data["reason"]
    except KeyError as error:
        raise UpgradeRequestError(f"控制请求缺少字段: {error.args[0]}") from error
    if not _is_int(protocol_version):
        raise UpgradeRequestError("protocol_version 必须是整数")
    for field, value in (
        ("request_id", request_id),
        ("project", project),
        ("prefix", prefix),
        ("tag", tag),
        ("artifact_sha256", artifact_sha256),
        ("by", by),
        ("reason", reason),
    ):
        if not isinstance(value, str):
            raise UpgradeRequestError(f"{field} 必须是字符串")
    try:
        return UpgradeRequest(
            request_id=cast("str", request_id),
            project=cast("str", project),
            prefix=cast("str", prefix),
            tag=cast("str", tag),
            artifact_sha256=cast("str", artifact_sha256),
            by=cast("str", by),
            reason=cast("str", reason),
            protocol_version=cast("int", protocol_version),
        )
    except UpgradeRequestError:
        raise
    except UpgradeError as error:
        raise UpgradeRequestError(str(error)) from error


@dataclass(frozen=True)
class DrainDecision:
    """排空证据判定：`proceed` 为真才允许进入 starting。"""

    proceed: bool
    reason: str


def _report_counts_are_zero(report: Mapping[str, object], fields: tuple[str, ...]) -> bool:
    for field in fields:
        value = report.get(field, 0)
        if value != 0:
            return False
    return True


def drain_decision(
    report: Mapping[str, object] | None,
    *,
    expected_generation: str,
    expected_pid: int,
    outstanding_actions: int,
) -> DrainDecision:
    """判定业务进程的排空报告是否足以证明“没有在途动作”。"""

    if outstanding_actions > 0:
        return DrainDecision(
            False,
            f"仍有 {outstanding_actions} 个未核对的未完成动作；不进入切换，需人工核对",
        )
    if report is None:
        return DrainDecision(False, "尚未取得排空报告（等待当前调用/会话轮完成）")
    _reject_unknown(report, _DRAIN_FIELDS, "排空报告")
    if report.get("schema_version") != SCHEMA_VERSION:
        return DrainDecision(False, "排空报告 schema_version 不支持")
    if report.get("generation") != expected_generation:
        return DrainDecision(
            False,
            f"排空报告代际不符：报告 {report.get('generation')!r}，期望 {expected_generation}",
        )
    if report.get("pid") != expected_pid:
        return DrainDecision(
            False, f"排空报告进程不符：报告 {report.get('pid')!r}，期望 {expected_pid}"
        )
    if report.get("completed") is not True:
        return DrainDecision(False, "排空未完成（仍有在途调用或会话轮）")
    if not _report_counts_are_zero(
        report,
        ("active_calls", "active_turns", "active_agent_processes", "pending_requests"),
    ):
        return DrainDecision(False, "排空报告仍显示在途调用/会话轮/子进程/受理请求")
    return DrainDecision(True, "排空已完成：无在途调用、会话轮或子进程")


def readiness_problem(
    report: Mapping[str, object] | None,
    *,
    expected: UpgradeIdentity,
    expected_pid: int,
    project: str,
    prefix: str,
    records_root: str,
    release_dir: str | Path,
) -> str:
    """返回空串表示就绪身份全部一致；否则是第一处不符的可读原因。"""

    if report is None:
        return "尚未取得就绪报告"
    try:
        _reject_unknown(report, _REPORT_FIELDS, "就绪报告")
    except UpgradeError as error:
        return str(error)
    if report.get("schema_version") != SCHEMA_VERSION:
        return "就绪报告 schema_version 不支持"
    if report.get("ready") is not True:
        return "新进程未声明 ready"
    if report.get("pid") != expected_pid:
        return f"就绪报告进程不符：报告 {report.get('pid')!r}，期望 {expected_pid}"
    for field, wanted in (
        ("generation", expected.generation),
        ("version", expected.version),
        ("tag", expected.tag),
        ("artifact_sha256", expected.artifact_sha256),
        ("build_commit", expected.build_commit),
        ("project", project),
        ("prefix", prefix),
        ("records_root", records_root),
    ):
        if report.get(field) != wanted:
            return f"就绪报告 {field} 不符：报告 {report.get(field)!r}，期望 {wanted!r}"
    module_path = report.get("module_path")
    if not isinstance(module_path, str) or not module_path:
        return "就绪报告缺少模块加载路径"
    try:
        loaded = Path(module_path).resolve()
        release = Path(release_dir).resolve()
    except (OSError, RuntimeError) as error:
        return f"模块加载路径无法解析: {error}"
    if not loaded.is_relative_to(release):
        return f"模块加载路径不在候选安装目录内: {loaded}（候选 {release}）"
    return ""


def parse_drain_report(document: object) -> Mapping[str, object]:
    data = _require_mapping(document, "排空报告")
    _reject_unknown(data, _DRAIN_FIELDS, "排空报告")
    return data


def parse_ready_report(document: object) -> Mapping[str, object]:
    data = _require_mapping(document, "就绪报告")
    _reject_unknown(data, _REPORT_FIELDS, "就绪报告")
    return data


@dataclass(frozen=True)
class ArtifactManifest:
    """`releases/<version>/artifact.json`：候选安装的可核对身份。"""

    version: str
    tag: str
    artifact_sha256: str
    build_commit: str = ""
    build_commit_source: str = ""
    installed_at: str = ""
    source: str = ""

    def __post_init__(self) -> None:
        if parse_version(self.tag) is None or self.tag != f"v{self.version}":
            raise UpgradeStateError(f"manifest 版本/标签不一致: {self.version!r}/{self.tag!r}")
        if not DIGEST_PATTERN.match(self.artifact_sha256):
            raise UpgradeStateError("manifest 产物校验值非法")
        if self.build_commit and not _COMMIT_PATTERN.match(self.build_commit):
            raise UpgradeStateError("manifest 构建提交非法")

    def to_document(self) -> dict[str, object]:
        return {
            "schema_version": SCHEMA_VERSION,
            "version": self.version,
            "tag": self.tag,
            "artifact_sha256": self.artifact_sha256,
            "build_commit": self.build_commit,
            "build_commit_source": self.build_commit_source,
            "installed_at": self.installed_at,
            "source": self.source,
        }

    @classmethod
    def from_document(cls, document: object) -> ArtifactManifest:
        data = _require_mapping(document, "artifact manifest")
        _reject_unknown(data, _MANIFEST_FIELDS, "artifact manifest")
        if data.get("schema_version") != SCHEMA_VERSION:
            raise UpgradeStateError("artifact manifest schema_version 不支持")
        try:
            return cls(
                version=str(data["version"]),
                tag=str(data["tag"]),
                artifact_sha256=str(data["artifact_sha256"]),
                build_commit=str(data.get("build_commit", "")),
                build_commit_source=str(data.get("build_commit_source", "")),
                installed_at=str(data.get("installed_at", "")),
                source=str(data.get("source", "")),
            )
        except KeyError as error:
            raise UpgradeStateError(f"artifact manifest 缺少字段: {error.args[0]}") from error


def manifest_problem(manifest: ArtifactManifest | None, expected: UpgradeIdentity) -> str:
    if manifest is None:
        return "候选目录缺少 artifact.json；不能证明安装身份"
    if manifest.version != expected.version or manifest.tag != expected.tag:
        return "artifact.json 的版本/标签与请求不符"
    if manifest.artifact_sha256 != expected.artifact_sha256:
        return "artifact.json 的产物校验值与请求不符"
    if expected.build_commit and manifest.build_commit != expected.build_commit:
        return "artifact.json 的构建提交与发布回执不符"
    return ""


@dataclass(frozen=True)
class RestartDecision:
    """启动器异常退出后按现场对账的结论（不启动第二个执行实例）。"""

    action: str
    reason: str
    generation: str = ""


def reconcile_restart(state: UpgradeState | None, *, child_alive: bool) -> RestartDecision:
    if state is None:
        return RestartDecision("start", "没有升级现场：按 current 指针启动业务进程")
    if state.phase in {PHASE_COMMITTED, PHASE_PREPARED, PHASE_DEFERRED, PHASE_ROLLED_BACK}:
        if child_alive:
            return RestartDecision("adopt", "已提交代际的进程仍在运行，接管监控", state.generation)
        return RestartDecision(
            "restart",
            f"阶段 {state.phase} 的业务进程已退出，按同一版本重新启动",
            next_generation(state.generation),
        )
    if state.phase == PHASE_RECOVERY_REQUIRED:
        if child_alive:
            return RestartDecision(
                "hold", "recovery_required：进程仍在运行，保持原样并等待人工核对"
            )
        return RestartDecision("hold", "recovery_required：等待人工核对，不自动启动")
    # draining / starting / probing：启动器中途退出，无法确认候选与旧进程的边界。
    if child_alive:
        return RestartDecision(
            "hold",
            f"阶段 {state.phase} 有进程仍在运行；为免启动第二个实例，等待人工核对",
            state.generation,
        )
    if state.previous is not None:
        return RestartDecision(
            "rollback",
            f"阶段 {state.phase} 的候选已确认退出，恢复上一版本 {state.previous.version}",
            next_generation(state.generation),
        )
    return RestartDecision("hold", f"阶段 {state.phase} 无法确认退出且没有上一版本；人工核对")


@dataclass(frozen=True)
class UpgradeSettings:
    """`[upgrade]` 配置的生效值；越界/布尔冒充数字一律拒绝。"""

    drain_timeout_seconds: float = DEFAULT_DRAIN_TIMEOUT_SECONDS
    readiness_timeout_seconds: float = DEFAULT_READINESS_TIMEOUT_SECONDS
    recovery_timeout_seconds: float = DEFAULT_RECOVERY_TIMEOUT_SECONDS
    poll_seconds: float = DEFAULT_POLL_SECONDS

    def __post_init__(self) -> None:
        if not MIN_DRAIN_TIMEOUT_SECONDS <= self.drain_timeout_seconds <= MAX_DRAIN_TIMEOUT_SECONDS:
            raise UpgradeSettingsError(
                f"drain_timeout_seconds 必须在 {MIN_DRAIN_TIMEOUT_SECONDS:g}.."
                f"{MAX_DRAIN_TIMEOUT_SECONDS:g} 秒之间"
            )
        if not 1.0 <= self.readiness_timeout_seconds <= MAX_READINESS_TIMEOUT_SECONDS:
            raise UpgradeSettingsError(
                f"readiness_timeout_seconds 必须在 1..{MAX_READINESS_TIMEOUT_SECONDS:g} 秒之间"
            )
        if not 1.0 <= self.recovery_timeout_seconds <= MAX_RESUME_TIMEOUT_SECONDS:
            raise UpgradeSettingsError(
                f"recovery_timeout_seconds 必须在 1..{MAX_RESUME_TIMEOUT_SECONDS:g} 秒之间"
            )
        if not 0.05 <= self.poll_seconds <= 5.0:
            raise UpgradeSettingsError("poll_seconds 必须在 0.05..5 秒之间")


def resolve_upgrade_settings(document: object | None) -> UpgradeSettings:
    if document is None:
        return UpgradeSettings()
    try:
        data = _require_mapping(document, "[upgrade] 配置")
        _reject_unknown(data, _SETTINGS_FIELDS, "[upgrade] 配置")
    except UpgradeSettingsError:
        raise
    except UpgradeError as error:
        raise UpgradeSettingsError(str(error)) from error
    if "schema_version" in data and data["schema_version"] != SCHEMA_VERSION:
        raise UpgradeSettingsError(f"[upgrade].schema_version 不支持: {data['schema_version']!r}")
    values: dict[str, float] = {}
    for field, default in (
        ("drain_timeout_seconds", DEFAULT_DRAIN_TIMEOUT_SECONDS),
        ("readiness_timeout_seconds", DEFAULT_READINESS_TIMEOUT_SECONDS),
        ("recovery_timeout_seconds", DEFAULT_RECOVERY_TIMEOUT_SECONDS),
        ("poll_seconds", DEFAULT_POLL_SECONDS),
    ):
        value = data.get(field, default)
        if not _is_number(value):
            raise UpgradeSettingsError(f"[upgrade].{field} 必须是数字（不能是布尔或字符串）")
        values[field] = float(cast("float", value))
    return UpgradeSettings(**values)


@dataclass(frozen=True)
class OwnerBinding:
    """`control/owner.json`：固定项目、登记根、前缀与启动参数的绑定。"""

    project: str
    prefix: str
    registration_root: str
    records_root: str
    service_config: str
    web_config: str
    projects_file: str
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise OwnerBindingError(f"owner 绑定 schema_version 不支持: {self.schema_version!r}")
        try:
            validate_project_id(self.project)
        except ProjectError as error:
            raise OwnerBindingError(str(error)) from error
        _absolute_path(self.prefix, "prefix")
        _absolute_path(self.registration_root, "registration_root")
        _absolute_path(self.records_root, "records_root")
        _absolute_path(self.service_config, "service_config")
        _absolute_path(self.web_config, "web_config")
        _absolute_path(self.projects_file, "projects_file")
        expected = Path(self.registration_root) / "projects" / self.project
        if Path(self.records_root) != expected:
            raise OwnerBindingError(
                f"records_root 必须是 {expected}（项目记录根），实际 {self.records_root}"
            )

    def to_document(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "project": self.project,
            "prefix": self.prefix,
            "registration_root": self.registration_root,
            "records_root": self.records_root,
            "service_config": self.service_config,
            "web_config": self.web_config,
            "projects_file": self.projects_file,
        }

    @classmethod
    def from_document(cls, document: object) -> OwnerBinding:
        data = _require_mapping(document, "owner.json")
        _reject_unknown(data, _OWNER_FIELDS, "owner.json")
        try:
            return cls(
                project=str(data["project"]),
                prefix=str(data["prefix"]),
                registration_root=str(data["registration_root"]),
                records_root=str(data["records_root"]),
                service_config=str(data["service_config"]),
                web_config=str(data["web_config"]),
                projects_file=str(data["projects_file"]),
                schema_version=int(str(data.get("schema_version", SCHEMA_VERSION))),
            )
        except KeyError as error:
            raise OwnerBindingError(f"owner.json 缺少字段: {error.args[0]}") from error
        except (TypeError, ValueError) as error:
            if isinstance(error, OwnerBindingError):
                raise
            raise OwnerBindingError(f"owner.json 字段类型非法: {error}") from error


def iso_now(value: datetime | None) -> str:
    """把调用方给出的时钟固化为 UTC ISO 字符串；缺省为空串（规则层不读时钟）。"""

    if value is None:
        return ""
    return value.isoformat()


def parse_timestamp(value: str) -> datetime | None:
    """解析现场时间戳；空串或损坏返回 None（不猜）。"""

    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


__all__ = [
    "ADMITTED_PHASES",
    "ALL_PHASES",
    "PHASE_COMMITTED",
    "PHASE_DEFERRED",
    "PHASE_DRAINING",
    "PHASE_PREPARED",
    "PHASE_PROBING",
    "PHASE_RECOVERY_REQUIRED",
    "PHASE_ROLLED_BACK",
    "PHASE_STARTING",
    "PROTOCOL_VERSION",
    "SCHEMA_VERSION",
    "TERMINAL_PHASES",
    "TRANSIENT_PHASES",
    "AdmissionDecision",
    "ArtifactManifest",
    "DrainDecision",
    "OwnerBinding",
    "OwnerBindingError",
    "RestartDecision",
    "SwitchDecision",
    "UpgradeError",
    "UpgradeIdentity",
    "UpgradeRequest",
    "UpgradeRequestError",
    "UpgradeSettings",
    "UpgradeSettingsError",
    "UpgradeState",
    "UpgradeStateError",
    "admission_decision",
    "drain_decision",
    "manifest_problem",
    "next_generation",
    "parse_drain_report",
    "parse_ready_report",
    "parse_upgrade_request",
    "readiness_problem",
    "reconcile_restart",
    "request_upgrade_key",
    "resolve_upgrade_settings",
    "switch_decision",
    "transition_problem",
]
