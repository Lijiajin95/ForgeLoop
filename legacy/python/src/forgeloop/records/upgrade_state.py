"""升级现场与证据文件的持久化（T3）：原子写、追加审计、只读准入。

方案 §3.1/§3.2：启动器独占写 `control/upgrade-state.json` 与
`control/upgrade-events.jsonl`；业务进程只读其执行准入状态。本模块是 records 层的
IO 边界，规则（阶段、准入、过渡）全部来自 `domain.upgrade`，不在这里复制。

现场写入必须是“要么旧内容、要么新内容”：临时文件 → flush/fsync → `os.replace`，
并对目录做一次 best-effort fsync。凭据、轨迹与数据库不入库；控制目录默认 0700，
状态/报告文件 0600。
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from forgeloop.domain.upgrade import (
    SCHEMA_VERSION,
    UpgradeError,
    UpgradeState,
    admission_decision,
)

STATE_FILENAME = "upgrade-state.json"
EVENTS_FILENAME = "upgrade-events.jsonl"


class ManagedAdmission:
    """业务进程从环境读取的准入结论；`managed=False` 时保持既有行为。"""

    def __init__(
        self,
        *,
        managed: bool,
        allowed: bool,
        reason: str = "",
        phase: str = "",
        generation: str = "",
        process_generation: str = "",
        state_path: Path | None = None,
    ) -> None:
        self.managed = managed
        self.allowed = allowed
        self.reason = reason
        self.phase = phase
        self.generation = generation
        self.process_generation = process_generation
        self.state_path = state_path

    def document(self) -> dict[str, object]:
        return {
            "managed": self.managed,
            "admitted": self.allowed,
            "reason": self.reason,
            "phase": self.phase,
            "generation": self.generation,
            "process_generation": self.process_generation,
        }


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def write_json_atomic(path: Path, document: Mapping[str, object]) -> None:
    """原子写 JSON；内容先落临时文件并 fsync，再替换目标。"""

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
        _fsync_directory(path.parent)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def read_json(path: Path) -> object | None:
    """读取 JSON；文件不存在返回 None，损坏时抛 `UpgradeError`（不猜）。"""

    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpgradeError(f"无法读取 {path}: {error}") from error


class UpgradeStateStore:
    """`<prefix>/control` 的权威升级现场；构造时只创建目录，不写状态。"""

    def __init__(self, control_dir: Path) -> None:
        self._control_dir = Path(control_dir)
        self._control_dir.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self._control_dir, 0o700)

    @property
    def control_dir(self) -> Path:
        return self._control_dir

    @property
    def state_path(self) -> Path:
        return self._control_dir / STATE_FILENAME

    @property
    def events_path(self) -> Path:
        return self._control_dir / EVENTS_FILENAME

    def read(self) -> UpgradeState | None:
        document = read_json(self.state_path)
        if document is None:
            return None
        return UpgradeState.from_document(document)

    def write(self, state: UpgradeState) -> UpgradeState:
        """写入并返回补全时间戳后的现场；调用方以返回值为准。"""

        now = datetime.now(UTC).isoformat()
        stamped = replace(
            state,
            created_at=state.created_at or now,
            updated_at=now,
        )
        write_json_atomic(self.state_path, stamped.to_document())
        return stamped

    def append_event(
        self,
        kind: str,
        *,
        state: UpgradeState | None = None,
        detail: str = "",
        at: datetime | None = None,
    ) -> dict[str, object]:
        """追加一条升级审计（只追加，不删除）；`kind` 是稳定机器标签。"""

        moment = at or datetime.now(UTC)
        event: dict[str, object] = {
            "schema_version": SCHEMA_VERSION,
            "kind": kind,
            "at": moment.isoformat(),
            "request_id": "" if state is None else state.request_id,
            "phase": "" if state is None else state.phase,
            "generation": "" if state is None else state.generation,
            "project": "" if state is None else state.project,
            "detail": detail,
        }
        self._control_dir.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        with contextlib.suppress(OSError):
            os.chmod(self.events_path, 0o600)
        return event

    def events(self) -> tuple[dict[str, object], ...]:
        if not self.events_path.is_file():
            return ()
        items: list[dict[str, object]] = []
        for line in self.events_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                items.append(cast("dict[str, object]", parsed))
        return tuple(items)

    # ---- 证据文件（业务进程写排空/就绪报告；报告不是升级现场） ----

    def report_path(self, kind: str, generation: str) -> Path:
        if kind not in {"ready", "drain"}:
            raise ValueError(f"未知报告类型: {kind}")
        if not generation or "/" in generation or ".." in generation:
            raise ValueError(f"generation 非法: {generation!r}")
        return self._control_dir / f"{kind}-{generation}.json"

    def write_report(self, kind: str, generation: str, document: Mapping[str, object]) -> Path:
        path = self.report_path(kind, generation)
        write_json_atomic(path, document)
        return path

    def read_report(self, kind: str, generation: str) -> Mapping[str, object] | None:
        document = read_json(self.report_path(kind, generation))
        if document is None:
            return None
        if not isinstance(document, dict):
            raise UpgradeError(f"{kind} 报告不是 JSON 对象")
        return cast("dict[str, object]", document)


def read_managed_admission(environ: Mapping[str, str] | None = None) -> ManagedAdmission:
    """从业务进程环境读取代际准入；托管现场缺状态/代际时失败关闭。"""

    environment = os.environ if environ is None else environ
    state_value = environment.get("FORGELOOP_UPGRADE_STATE", "").strip()
    managed = environment.get("FORGELOOP_UPGRADE_MANAGED", "").strip() == "1" or bool(state_value)
    if not managed:
        return ManagedAdmission(managed=False, allowed=True)
    process_generation = environment.get("FORGELOOP_UPGRADE_GENERATION", "").strip()
    if not state_value:
        return ManagedAdmission(
            managed=True,
            allowed=False,
            reason="托管进程缺少 FORGELOOP_UPGRADE_STATE，无法读取执行准入",
            process_generation=process_generation,
        )
    path = Path(state_value)
    try:
        state = UpgradeStateStore(path.parent).read()
    except UpgradeError as error:
        return ManagedAdmission(
            managed=True,
            allowed=False,
            reason=f"升级现场不可读：{error}",
            process_generation=process_generation,
            state_path=path,
        )
    if state is None:
        return ManagedAdmission(
            managed=True,
            allowed=False,
            reason="升级现场不存在（启动器尚未提交代际）",
            process_generation=process_generation,
            state_path=path,
        )
    decision = admission_decision(
        managed=True,
        phase=state.phase,
        generation=state.generation,
        process_generation=process_generation,
    )
    return ManagedAdmission(
        managed=True,
        allowed=decision.allowed,
        reason=decision.reason,
        phase=decision.phase,
        generation=decision.generation,
        process_generation=process_generation,
        state_path=path,
    )
