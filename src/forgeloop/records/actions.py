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

import sqlite3
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum


class ActionState(StrEnum):
    """动作生命周期状态：只在启动后、核对前处于 ``STARTED``。"""

    STARTED = "started"
    COMPLETED = "completed"


@dataclass(frozen=True)
class ActionRecord:
    """一次动作的事实记录：身份、所属节点与起止时间。"""

    action_id: str
    task_id: str
    node: str
    role: str
    state: ActionState
    started_at: datetime
    finished_at: datetime | None
    detail: str


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
    )


class ActionStore:
    """动作生命周期记录（与 ``RecordStore`` 共用同一 SQLite 连接的内聚类）。"""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def begin(self, task_id: str, node: str, role: str = "") -> ActionRecord:
        """原子登记动作启动；已有未完成动作时抛 :class:`ActionInFlightError`。"""

        started = _now()
        action_id = f"{task_id}:{node}:{uuid.uuid4().hex[:8]}"
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._db.execute(
                "SELECT action_id, task_id, node, role, state, started_at, finished_at, detail"
                " FROM actions WHERE task_id = ? AND state = ? ORDER BY started_at LIMIT 1",
                (task_id, ActionState.STARTED.value),
            ).fetchone()
            if row is not None:
                raise ActionInFlightError(task_id, str(row[2]))
            self._db.execute(
                "INSERT INTO actions"
                " (action_id, task_id, node, role, state, started_at, finished_at, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, NULL, '')",
                (action_id, task_id, node, role, ActionState.STARTED.value, _iso(started)),
            )
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        return ActionRecord(action_id, task_id, node, role, ActionState.STARTED, started, None, "")

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
            "SELECT action_id, task_id, node, role, state, started_at, finished_at, detail"
            " FROM actions WHERE action_id = ?",
            (action_id,),
        ).fetchone()
        if row is None:  # pragma: no cover - 紧接成功更新之后的读取
            raise KeyError(f"动作不存在: {action_id}")
        return _from_row(row)

    def outstanding(self, task_id: str) -> ActionRecord | None:
        """返回该任务最早的未完成动作；没有则返回 ``None``。"""

        row = self._db.execute(
            "SELECT action_id, task_id, node, role, state, started_at, finished_at, detail"
            " FROM actions WHERE task_id = ? AND state = ? ORDER BY started_at LIMIT 1",
            (task_id, ActionState.STARTED.value),
        ).fetchone()
        return _from_row(row) if row is not None else None

    def history(self, task_id: str) -> tuple[ActionRecord, ...]:
        """按启动时间返回该任务的全部动作记录。"""

        rows = self._db.execute(
            "SELECT action_id, task_id, node, role, state, started_at, finished_at, detail"
            " FROM actions WHERE task_id = ? ORDER BY started_at",
            (task_id,),
        ).fetchall()
        return tuple(_from_row(row) for row in rows)

    # ---- 粗粒度执行槽位（A05）：同一资源同时只允许一个未完成占用 ----

    def claim_slot(self, slot: str, owner: str = "") -> ActionRecord:
        """原子占用一个命名执行槽位；已有未完成占用时抛 :class:`ExecutionSlotBusyError`。

        槽位与单任务动作共用同一张 ``actions`` 表，但用 :data:`SLOT_PREFIX` 区分
        身份，因此调度层占用不会出现在任何真实任务的 ``history`` 里。占用与
        ``begin`` 一样在 ``BEGIN IMMEDIATE`` 内检查后插入，并发只有一个能成功。
        """

        try:
            return self.begin(f"{SLOT_PREFIX}{slot}", "execution_slot", role=owner)
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
            "SELECT action_id, task_id, node, role, state, started_at, finished_at, detail"
            " FROM actions WHERE task_id LIKE ? AND state = ? ORDER BY started_at",
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
