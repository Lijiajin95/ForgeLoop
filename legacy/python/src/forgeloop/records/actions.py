"""动作生命周期记录：启动/完成身份与单任务并发占用（B03）。

职责（架构 §6 持久化与记录）：
- 会产生副作用的节点动作（dev/review/test）在启动前登记 ``started``，正常结束
  时登记 ``completed``；进程被杀只留下 ``started``，构成「未核对动作」的事实依据。
- 同一任务同时最多一个未完成动作；``begin`` 在 ``BEGIN IMMEDIATE`` 事务内检查后
  插入，并发调用只有一个能成功，其余抛 :class:`ActionInFlightError`。
- 动作事实只增不改写：``finish`` 只把 ``started`` 置为 ``completed``，对未知或
  已完成的动作显式失败，避免把不一致静默吞掉。

记录由 ``graph.nodes`` 的动作节点写入；本模块只负责持久化，不判断业务是否该启动。
"""

import os
import sqlite3
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum


class ActionState(StrEnum):
    """动作生命周期状态：只在启动后、核对前处于 ``STARTED``。

    ``RELEASED`` 表示该 ``started`` 动作已由人工核对并释放：结果仍然不明确，因此
    不算 ``completed``，也不再是未完成动作；B03 的未完成动作判定据此不再把它计入，
    后续 ``begin`` 也不会因它被拒。释放的审计（谁/何时/理由/动作身份）另见
    ``records.checkpoints.release_action``。
    """

    STARTED = "started"
    COMPLETED = "completed"
    RELEASED = "released"


@dataclass(frozen=True)
class ActionRecord:
    """一次动作的事实记录：身份、所属节点、起止时间与进程身份。

    ``pid`` 是发起动作的进程身份，``heartbeat_at`` 是最近一次心跳时间；两者都是
    槽位残留判定的权威事实。旧记录可能没有它们（``None``），此时判定为不确定。
    """

    action_id: str
    task_id: str
    node: str
    role: str
    state: ActionState
    started_at: datetime
    finished_at: datetime | None
    detail: str
    pid: int | None = None
    heartbeat_at: datetime | None = None


class ProcessLiveness(StrEnum):
    """进程存活探测结果：三种取值，避免把「查不到」误当成「已死」。"""

    ALIVE = "alive"
    DEAD = "dead"
    UNKNOWN = "unknown"


class SlotResidue(StrEnum):
    """槽位残留判定：空闲、已死残留、存活占用或不确定。"""

    FREE = "free"
    DEAD = "dead"
    LIVE = "live"
    UNCERTAIN = "uncertain"


# 进程存活探测接缝：默认用 ``os.kill(pid, 0)``，测试与特殊环境可替换实现。
ProcessProbe = Callable[[int], ProcessLiveness]


def default_process_probe(pid: int) -> ProcessLiveness:
    """用 ``os.kill(pid, 0)`` 探测进程是否存活。

    ``ProcessLookupError`` 表示进程已不存在；``PermissionError`` 表示进程存在但
    当前用户无权发信号，按存活处理（宁可不清，也不误清存活占用者）；其余 ``OSError``
    无法确认，按不确定处理。只有权威记录里的进程身份可探测时才调用本函数。
    """

    if pid <= 0:
        return ProcessLiveness.UNKNOWN
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return ProcessLiveness.DEAD
    except PermissionError:
        return ProcessLiveness.ALIVE
    except OSError:
        return ProcessLiveness.UNKNOWN
    return ProcessLiveness.ALIVE


@dataclass(frozen=True)
class SlotResidueAssessment:
    """一个槽位的残留判定：结论、当时占用者与可读判定依据。"""

    slot: str
    residue: SlotResidue
    occupant: ActionRecord | None
    reason: str


@dataclass(frozen=True)
class SlotCleanupRecord:
    """一次残留清理的事实记录：槽位、原占用者、判定依据与清理时间。"""

    cleanup_id: str
    slot: str
    occupant_action_id: str
    occupant_owner: str
    occupant_pid: int | None
    reason: str
    cleaned_at: datetime


@dataclass(frozen=True)
class SlotCleanupOutcome:
    """清理结果：判定 + 实际写入的清理记录；未清理时 ``cleanup`` 为 ``None``。"""

    assessment: SlotResidueAssessment
    cleanup: SlotCleanupRecord | None

    @property
    def cleaned(self) -> bool:
        """本次调用是否真的结束了残留占用（幂等重放为假）。"""

        return self.cleanup is not None


def assess_slot_occupant(
    slot: str, occupant: ActionRecord | None, probe: ProcessProbe = default_process_probe
) -> SlotResidueAssessment:
    """按权威记录判定槽位残留；只依赖进程身份，不依赖等待时长或心跳年龄。

    空闲（无占用者）返回 ``FREE``；占用者没有进程身份返回 ``UNCERTAIN``；进程身份
    可探测时按存活结果给出 ``LIVE``/``DEAD``/``UNCERTAIN``。判定过程从不读取
    ``started_at`` 或 ``heartbeat_at``，所以槽位持有多久都不改变结论。
    """

    if occupant is None:
        return SlotResidueAssessment(slot, SlotResidue.FREE, None, "槽位当前空闲，无残留")
    if occupant.pid is None:
        return SlotResidueAssessment(
            slot, SlotResidue.UNCERTAIN, occupant, "占用记录缺少进程身份，无法判定存活"
        )
    liveness = probe(occupant.pid)
    if liveness is ProcessLiveness.ALIVE:
        return SlotResidueAssessment(
            slot, SlotResidue.LIVE, occupant, f"占用进程 {occupant.pid} 仍存活"
        )
    if liveness is ProcessLiveness.DEAD:
        return SlotResidueAssessment(
            slot, SlotResidue.DEAD, occupant, f"占用进程 {occupant.pid} 已不存在"
        )
    return SlotResidueAssessment(
        slot, SlotResidue.UNCERTAIN, occupant, f"无法确认进程 {occupant.pid} 是否存活"
    )


# 执行槽位在 ``actions`` 表中使用的保留身份前缀：与单任务动作身份区分，
# 使粗粒度的调度占用不污染 B03 的单任务动作历史。
SLOT_PREFIX = "slot:"


class ActionInFlightError(RuntimeError):
    """同一任务已有未完成动作：拒绝并发启动，需人工核对现场。"""

    def __init__(self, task_id: str, node: str) -> None:
        super().__init__(f"任务 {task_id} 尚有未完成动作（{node}）；拒绝重复启动")
        self.task_id = task_id
        self.node = node


class ExecutionSlotBusyError(RuntimeError):
    """命名执行槽位已有未完成占用：拒绝并发进入同一槽位。

    与 :class:`ActionInFlightError` 分工明确：后者约束单个任务同一时刻只有一个
    动作；本错误约束调度层更粗粒度的资源（同一需求推进、同项目交付）。
    """

    def __init__(self, slot: str) -> None:
        super().__init__(f"执行槽位已被占用: {slot}")
        self.slot = slot


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


# 动作行字段顺序；所有查询共用，避免新增列时漏读。
_ACTION_COLUMNS = (
    "action_id, task_id, node, role, state, started_at, finished_at, detail, pid, heartbeat_at"
)
_SELECT_ACTION = f"SELECT {_ACTION_COLUMNS} FROM actions"


def _from_row(row: Sequence[object]) -> ActionRecord:
    return ActionRecord(
        action_id=str(row[0]),
        task_id=str(row[1]),
        node=str(row[2]),
        role=str(row[3]),
        state=ActionState(str(row[4])),
        started_at=_parse(str(row[5])),
        finished_at=_parse(str(row[6])) if row[6] else None,
        detail=str(row[7]),
        pid=int(str(row[8])) if row[8] is not None else None,
        heartbeat_at=_parse(str(row[9])) if row[9] else None,
    )


def _cleanup_from_row(row: Sequence[object]) -> SlotCleanupRecord:
    return SlotCleanupRecord(
        cleanup_id=str(row[0]),
        slot=str(row[1]),
        occupant_action_id=str(row[2]),
        occupant_owner=str(row[3]),
        occupant_pid=int(str(row[4])) if row[4] is not None else None,
        reason=str(row[5]),
        cleaned_at=_parse(str(row[6])),
    )


class ActionStore:
    """动作生命周期记录（与 ``RecordStore`` 共用同一 SQLite 连接的内聚类）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def begin(
        self, task_id: str, node: str, role: str = "", *, pid: int | None = None
    ) -> ActionRecord:
        """原子登记动作启动；已有未完成动作时抛 :class:`ActionInFlightError`。

        ``pid`` 是发起动作的进程身份，供槽位残留判定核对存活；``None`` 表示记录
        未携带进程身份，残留判定据此返回不确定而不是猜测存活或已死。
        """

        started = _now()
        action_id = f"{task_id}:{node}:{uuid.uuid4().hex[:8]}"
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._db.execute(
                f"{_SELECT_ACTION} WHERE task_id = ? AND state = ? ORDER BY started_at LIMIT 1",
                (task_id, ActionState.STARTED.value),
            ).fetchone()
            if row is not None:
                raise ActionInFlightError(task_id, str(row[2]))
            self._db.execute(
                "INSERT INTO actions"
                " (action_id, task_id, node, role, state, started_at, finished_at, detail,"
                " pid, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, NULL, '', ?, ?)",
                (
                    action_id,
                    task_id,
                    node,
                    role,
                    ActionState.STARTED.value,
                    _iso(started),
                    pid,
                    _iso(started),
                ),
            )
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        return ActionRecord(
            action_id,
            task_id,
            node,
            role,
            ActionState.STARTED,
            started,
            None,
            "",
            pid,
            started,
        )

    def finish(self, action_id: str, detail: str = "") -> ActionRecord:
        """把未完成动作置为完成；未知或已完成的动作显式失败。"""

        finished = _now()
        changed = self._db.execute(
            "UPDATE actions SET state = ?, finished_at = ?, detail = ?"
            " WHERE action_id = ? AND state = ?",
            (
                ActionState.COMPLETED.value,
                _iso(finished),
                detail,
                action_id,
                ActionState.STARTED.value,
            ),
        ).rowcount
        if changed == 0:
            raise KeyError(f"没有未完成动作: {action_id}")
        row = self._db.execute(
            f"{_SELECT_ACTION} WHERE action_id = ?",
            (action_id,),
        ).fetchone()
        if row is None:  # pragma: no cover - 紧接成功更新之后的读取
            raise KeyError(f"动作不存在: {action_id}")
        return _from_row(row)

    def outstanding(self, task_id: str) -> ActionRecord | None:
        """返回该任务最早的未完成动作；没有则返回 ``None``。"""

        row = self._db.execute(
            f"{_SELECT_ACTION} WHERE task_id = ? AND state = ? ORDER BY started_at LIMIT 1",
            (task_id, ActionState.STARTED.value),
        ).fetchone()
        return _from_row(row) if row is not None else None

    def history(self, task_id: str) -> tuple[ActionRecord, ...]:
        """按启动时间返回该任务的全部动作记录。"""

        rows = self._db.execute(
            f"{_SELECT_ACTION} WHERE task_id = ? ORDER BY started_at",
            (task_id,),
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    # ---- 粗粒度执行槽位（A05）：同一资源同时只允许一个未完成占用 ----

    def claim_slot(self, slot: str, owner: str = "", *, pid: int | None = None) -> ActionRecord:
        """原子占用一个命名执行槽位；已有未完成占用时抛 :class:`ExecutionSlotBusyError`。

        槽位与单任务动作共用同一张 ``actions`` 表，但用 :data:`SLOT_PREFIX` 区分
        身份，因此调度层占用不会出现在任何真实任务的 ``history`` 里。占用与
        ``begin`` 一样在 ``BEGIN IMMEDIATE`` 内检查后插入，并发只有一个能成功。
        进程身份默认记为当前进程 ``os.getpid()``，供残留判定核对存活。
        """

        try:
            return self.begin(
                f"{SLOT_PREFIX}{slot}",
                "execution_slot",
                role=owner,
                pid=os.getpid() if pid is None else pid,
            )
        except ActionInFlightError as error:
            raise ExecutionSlotBusyError(slot) from error

    def release_slot(self, action_id: str, detail: str = "") -> ActionRecord:
        """释放命名执行槽位；未知或已完成的槽位明确失败（不静默吞掉）。"""

        return self.finish(action_id, detail=detail)

    def slot_owner(self, slot: str) -> ActionRecord | None:
        """返回当前占用该槽位的最早记录；空闲时为 ``None``。"""

        return self.outstanding(f"{SLOT_PREFIX}{slot}")

    def outstanding_slots(self) -> tuple[ActionRecord, ...]:
        """返回全部未完成的命名执行槽位，按开始时间排序；空闲时为空元组。

        用于中断后人工核对现场：残留槽位会拒绝后续推进，必须先看清占用者与开始时
        间，确认没有推进在运行后再清理。
        """

        rows = self._db.execute(
            f"{_SELECT_ACTION} WHERE task_id LIKE ? AND state = ? ORDER BY started_at",
            (f"{SLOT_PREFIX}%", ActionState.STARTED.value),
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    def clear_slot(self, slot: str, detail: str = "") -> ActionRecord:
        """人工核对现场后清理一个残留槽位；当前未被占用时明确失败。

        只结束 ``started`` 记录，不改写历史；与 B03 未完成动作的恢复口径一致：先由
        操作者确认没有推进在运行，再清理占用，让后续推进进入业务图并由 B03 标记未
        完成动作 ``interrupted``。
        """

        record = self.slot_owner(slot)
        if record is None:
            raise KeyError(f"执行槽位当前未被占用: {slot}")
        return self.finish(record.action_id, detail=detail or "cleared")

    # ---- 槽位残留判定与安全清理 ----

    def assess_slot_residue(
        self, slot: str, *, probe: ProcessProbe = default_process_probe
    ) -> SlotResidueAssessment:
        """只读判定命名槽位是否残留：空闲、已死、存活或不确定。

        判定只依据权威动作记录里的进程身份（``pid``）当前是否存活，不依据槽位已
        持有时长或心跳年龄，因此不会因等待时长误判。记录缺少进程身份或存活状态
        无法确认时返回不确定并给出具体原因，交由调用方决定是否人工核对。
        """

        return assess_slot_occupant(slot, self.slot_owner(slot), probe)

    def cleanup_slot_residue(
        self, slot: str, *, probe: ProcessProbe = default_process_probe
    ) -> SlotCleanupOutcome:
        """清理已死的槽位残留并持久化清理记录；存活或不确定时不清理。

        在 ``BEGIN IMMEDIATE`` 事务内重新读取占用者并判定，保证并发调用只有一个
        能完成清理，其余调用看到槽位已空闲，按幂等返回 ``cleaned=False``，不会产生
        重复清理记录，也不会误清存活占用者。只有判定为已死才结束占用并写入
        ``slot_cleanups``；否则把具体原因放进
        :attr:`SlotResidueAssessment.reason` 一并返回。
        """

        self._db.execute("BEGIN IMMEDIATE")
        try:
            occupant = self.slot_owner(slot)
            assessment = assess_slot_occupant(slot, occupant, probe)
            if assessment.residue is not SlotResidue.DEAD or occupant is None:
                self._db.execute("COMMIT")
                return SlotCleanupOutcome(assessment, None)
            cleaned_at = _now()
            changed = self._db.execute(
                "UPDATE actions SET state = ?, finished_at = ?, detail = ?"
                " WHERE action_id = ? AND state = ?",
                (
                    ActionState.COMPLETED.value,
                    _iso(cleaned_at),
                    f"residue-cleaned: {assessment.reason}",
                    occupant.action_id,
                    ActionState.STARTED.value,
                ),
            ).rowcount
            if changed == 0:  # pragma: no cover - 持有写锁时占用者不会被并发改写
                raise RuntimeError(f"清理槽位时占用者已变化: {slot}")
            record = SlotCleanupRecord(
                cleanup_id=uuid.uuid4().hex,
                slot=slot,
                occupant_action_id=occupant.action_id,
                occupant_owner=occupant.role,
                occupant_pid=occupant.pid,
                reason=assessment.reason,
                cleaned_at=cleaned_at,
            )
            self._db.execute(
                "INSERT INTO slot_cleanups"
                " (cleanup_id, slot, occupant_action_id, occupant_owner, occupant_pid,"
                " reason, cleaned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    record.cleanup_id,
                    record.slot,
                    record.occupant_action_id,
                    record.occupant_owner,
                    record.occupant_pid,
                    record.reason,
                    _iso(record.cleaned_at),
                ),
            )
            self._db.execute("COMMIT")
            return SlotCleanupOutcome(assessment, record)
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    def cleanup_history(self, slot: str) -> tuple[SlotCleanupRecord, ...]:
        """按清理时间返回某槽位的清理记录（槽位、原占用者、判定依据与清理时间）。"""

        rows = self._db.execute(
            "SELECT cleanup_id, slot, occupant_action_id, occupant_owner, occupant_pid,"
            " reason, cleaned_at FROM slot_cleanups WHERE slot = ?"
            " ORDER BY cleaned_at, cleanup_id",
            (slot,),
        ).fetchall()
        return tuple(_cleanup_from_row(row) for row in rows)

    def heartbeat(self, action_id: str, *, at: datetime | None = None) -> ActionRecord:
        """更新未完成动作的心跳时间；未知或已完成的动作显式失败。"""

        moment = at if at is not None else _now()
        changed = self._db.execute(
            "UPDATE actions SET heartbeat_at = ? WHERE action_id = ? AND state = ?",
            (_iso(moment), action_id, ActionState.STARTED.value),
        ).rowcount
        if changed == 0:
            raise KeyError(f"没有未完成动作可更新心跳: {action_id}")
        row = self._db.execute(f"{_SELECT_ACTION} WHERE action_id = ?", (action_id,)).fetchone()
        if row is None:  # pragma: no cover - 紧接成功更新之后的读取
            raise KeyError(f"动作不存在: {action_id}")
        return _from_row(row)
