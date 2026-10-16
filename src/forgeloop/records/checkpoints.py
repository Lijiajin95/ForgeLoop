"""检查点读取与可续跑判定：从记录根 ``checkpoints.sqlite`` 读取图检查点。

职责（架构 §6 持久化与记录）：

- **只读读取**：按单任务图的线程身份（记录层稳定身份，如
  ``task-<req_id>-v<plan_version>-<task_id>``）读取 LangGraph
  ``SqliteSaver`` 落盘的最近检查点，给出待执行节点、``halted_reason`` 与检查点
  身份；同时只读记录根下 ``records.sqlite`` 的 ``actions`` 表，给出未完成动作与
  已完成动作身份。不写检查点、不构造业务图、不新增依赖（``langgraph`` 已是既有
  依赖）。
- **可续跑判定**：``next`` 非空且节点都落在业务动作节点集合（``dev``/``review``/
  ``test``，含它们之间的自动回边）且没有 ``halted_reason`` 时判定为可续跑；但若
  该任务仍有 ``started`` 未完成动作（B03 未核对），一律不自动续跑——未完成动作的
  结果不明确，重放会越过「禁止盲目重放」的红线，保持等待人工核对。停在人工决策
  节点（计划批准、追加授权、整体验收）、终态节点（``deliver``/END）或存在
  ``halted_reason`` 时同样等待人工决定。
- **幂等口径**：同一任务的已完成动作身份（``actions.action_id``）用于判断重复推进
  是否真的产生了新进展；结合检查点身份形成 :class:`AdvanceFingerprint`。记录库或
  动作表缺失时如实输出 :data:`UNKNOWN`，不猜测为「已完成」或「未完成」。

本模块只读记录，判定为纯规则，供 ``graph.requirements`` 的推进流程调用。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, cast

from langgraph.checkpoint.base import Checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

# 记录根下的检查点数据库文件名（架构 §6：图检查点由 LangGraph SqliteSaver 管理）。
CHECKPOINT_DB_NAME = "checkpoints.sqlite"

# 字符串记录库名（与 RecordStore 同库，不用重复导入以避免环）。
RECORDS_DB_NAME = "records.sqlite"

# LangGraph 以待执行分支通道 ``branch:to:<node>`` 表达「下一个要跑的节点」。
_BRANCH_PREFIX = "branch:to:"

# 最近检查点查询：直接读 ``checkpoints`` 表，不调用会执行 ``CREATE TABLE`` 的
# ``SqliteSaver.setup``（只读读取不得改造现场）。
_LATEST_CHECKPOINT_SQL = (
    "SELECT checkpoint_id, type, checkpoint FROM checkpoints"
    " WHERE thread_id = ? AND checkpoint_ns = ''"
    " ORDER BY checkpoint_id DESC LIMIT 1"
)

# 可续跑业务节点：处理实际动作的节点，以及审查/测试经自动回边重新进入的 dev。
RESUMABLE_NODES: frozenset[str] = frozenset({"dev", "review", "test"})

# 人工决策节点：必须等所有者决定，不自动续跑。
DECISION_NODES: frozenset[str] = frozenset({"gate_plan_approval", "gate_grant", "gate_acceptance"})

# 终态节点：交付节点之后即 END，不能续跑。
TERMINAL_NODES: frozenset[str] = frozenset({"deliver"})

# 记录缺失时的显式标记，绝不臆造为「已完成」或「未完成」。
UNKNOWN = "unknown"


@dataclass(frozen=True)
class CheckpointState:
    """读取到的任务图检查点摘要（只保留续跑判定所需的最小事实）。

    ``next_nodes`` 是图当前待执行的节点名；为空表示图已到终态（END）或尚无待执行
    节点。``halted_reason`` 是节点如实落库的中断原因，非空时一律不自动续跑。

    ``outstanding_node`` 是该任务当前 ``started`` 未完成动作所在节点（无则为空）：
    未完成动作结果不明确，禁止盲目重放，即使停在业务节点也保持等待人工核对。
    ``completed_actions`` 是已完成动作身份集合（按 ``action_id`` 去重）；记录缺失时
    为 :data:`UNKNOWN`。两者与 ``checkpoint_id`` 一起构成重复推进的幂等指纹。
    """

    task_id: str
    checkpoint_id: str = ""
    next_nodes: tuple[str, ...] = ()
    halted_reason: str = ""
    outstanding_node: str = ""
    completed_actions: frozenset[str] | str = UNKNOWN

    @property
    def parked_node(self) -> str | None:
        """当前停下的待执行节点；没有待执行节点时为空。"""

        return self.next_nodes[0] if self.next_nodes else None


class ResumeDecision(StrEnum):
    """检查点判定结果：全新开始、可续跑、等待人工或有 halted 原因。"""

    FRESH = "fresh"
    RESUME = "resume"
    WAIT_USER = "wait_user"
    HALTED = "halted"


# 检查点读取接缝：把任务身份映射为检查点摘要；无记录返回 ``None``。
CheckpointReader = Callable[[str], "CheckpointState | None"]


def _pending_nodes(channel_values: Mapping[str, Any]) -> tuple[str, ...]:
    """从检查点的 ``channel_values`` 还原待执行节点名。"""

    names = [
        name[len(_BRANCH_PREFIX) :] for name in channel_values if name.startswith(_BRANCH_PREFIX)
    ]
    return tuple(sorted(names))


def _connect_read_only(path: Path) -> sqlite3.Connection | None:
    """以只读方式打开 SQLite 库；不可读时返回 ``None``。

    用 ``mode=ro`` URI 打开，绝不触发建表或写入：``SqliteSaver.get_tuple`` 会调用
    ``setup`` 执行 ``CREATE TABLE IF NOT EXISTS``，在空库或只读文件系统上制造写入，
    因此检查点读取改为直接查询 ``checkpoints`` 表，不经过该写入路径。
    """

    try:
        connection = sqlite3.connect(
            f"{path.resolve().as_uri()}?mode=ro", uri=True, check_same_thread=False
        )
    except sqlite3.Error:
        return None
    try:
        # 双保险：即使连接方式被误改，也只允许只读查询。
        connection.execute("PRAGMA query_only = ON")
    except sqlite3.Error:
        connection.close()
        return None
    return connection


def _read_only(
    records_root: Path, statement: str, parameters: tuple[object, ...]
) -> list[tuple[object, ...]] | None:
    """在动作表上执行一条只读查询；库或表缺失时返回 ``None``（记录缺失）。"""

    path = records_root / RECORDS_DB_NAME
    if not path.is_file():
        return None
    connection = _connect_read_only(path)
    if connection is None:
        return None
    try:
        try:
            return connection.execute(statement, parameters).fetchall()
        except sqlite3.Error:
            return None
    finally:
        connection.close()


def read_checkpoint(
    records_root: str | Path,
    task_id: str,
) -> CheckpointState | None:
    """只读读取某线程身份下最近的检查点摘要；无记录或库不可读时返回 ``None``。

    ``records_root`` 可以是记录根目录，也可以直接是检查点数据库文件；缺省按
    ``<records_root>/checkpoints.sqlite`` 定位。库文件不存在时不创建空库，直接
    返回 ``None``，避免读取动作产生副作用。检查点身份与动作事实一起返回，供推进器
    判定可续跑与重复推进的幂等口径。
    """

    root = Path(records_root)
    records_dir = root.parent if root.is_file() else root
    # 记录根目录或直接指向数据库文件都能定位到检查点库。
    path = root if root.is_file() else root / CHECKPOINT_DB_NAME
    if not path.is_file() or path.stat().st_size == 0:
        # 文件不存在或为空都是「没有可用检查点」：不连接、不建表、不改造现场。
        return None
    connection = _connect_read_only(path)
    if connection is None:
        return None
    try:
        try:
            row = connection.execute(_LATEST_CHECKPOINT_SQL, (task_id,)).fetchone()
        except sqlite3.Error:
            # 缺表或损坏检查点：如实视为「没有可用检查点」，不猜测可续跑。
            return None
        if row is None:
            return None
        checkpoint_id, type_, blob = row
        saver = SqliteSaver(connection)
        try:
            checkpoint = cast("Checkpoint", saver.serde.loads_typed((type_, blob)))
        except (sqlite3.Error, ValueError, KeyError):
            return None
        values = checkpoint.get("channel_values") or {}
        state = CheckpointState(
            task_id=task_id,
            checkpoint_id=str(checkpoint_id or ""),
            next_nodes=_pending_nodes(values),
            halted_reason=str(values.get("halted_reason") or ""),
        )
    finally:
        connection.close()
    return replace(
        state,
        outstanding_node=outstanding_action_node(records_dir, task_id),
        completed_actions=completed_action_ids(records_dir, task_id),
    )


def classify_checkpoint(state: CheckpointState | None) -> ResumeDecision:
    """判定检查点能否就地续跑。

    无 halted 原因时仅业务动作节点可续跑；但存在未核对 ``started`` 动作时保持等待
    人工核对（禁止盲目重放），不停在业务集合内的节点（决策门、终态、空 ``next``）
    同样等待人工决定。
    """

    if state is None:
        return ResumeDecision.FRESH
    if state.halted_reason.strip():
        return ResumeDecision.HALTED
    pending = set(state.next_nodes)
    # 人工决策节点与终态节点明确排除；空 ``next``（END）同样等待人工决定。
    if pending & (DECISION_NODES | TERMINAL_NODES):
        return ResumeDecision.WAIT_USER
    if pending and pending.issubset(RESUMABLE_NODES):
        if state.outstanding_node:
            # 未完成动作结果不明确：不自动续跑，保留现场待人工核对。
            return ResumeDecision.WAIT_USER
        return ResumeDecision.RESUME
    return ResumeDecision.WAIT_USER


def completed_action_ids(
    records_root: str | Path,
    task_id: str,
) -> frozenset[str] | str:
    """该任务已完成的动作身份集合（按 ``action_id`` 去重）；记录缺失输出 ``unknown``。

    同一动作身份只计一次，用于判定重复推进是否产生了新进展；记录库、动作表或列
    缺失时返回 :data:`UNKNOWN`，不臆造为空集。
    """

    rows = _read_only(
        Path(records_root),
        "SELECT action_id FROM actions WHERE task_id = ? AND state = 'completed'",
        (task_id,),
    )
    if rows is None:
        return UNKNOWN
    return frozenset(str(row[0]) for row in rows)


def outstanding_action_node(records_root: str | Path, task_id: str) -> str:
    """该任务当前 ``started`` 未完成动作所在节点；没有或记录缺失时返回空串。

    记录缺失与「确实没有未完成动作」都返回空串是保守选择：读取失败时不额外制造
    等待理由，但可续跑仍受检查点 ``next``/``halted_reason`` 的独立判定约束。
    """

    rows = _read_only(
        Path(records_root),
        "SELECT node FROM actions WHERE task_id = ? AND state = 'started'"
        " ORDER BY started_at LIMIT 1",
        (task_id,),
    )
    if not rows:
        return ""
    return str(rows[0][0])


@dataclass(frozen=True)
class AdvanceFingerprint:
    """一次推进的幂等指纹：检查点身份 + 已完成动作身份（去重）。"""

    checkpoint_id: str
    action_ids: tuple[str, ...] | str = UNKNOWN

    def same_as(self, other: AdvanceFingerprint) -> bool | str:
        """两次推进是否完全一致；动作记录缺失时返回 ``unknown``（无法判定）。"""

        if isinstance(self.action_ids, str) or isinstance(other.action_ids, str):
            return UNKNOWN
        return self.checkpoint_id == other.checkpoint_id and self.action_ids == other.action_ids


def advance_fingerprint(state: CheckpointState | None) -> AdvanceFingerprint:
    """组合检查点身份与已完成动作身份，供调用方判定重复推进是否无新进展。"""

    if state is None:
        return AdvanceFingerprint("", ())
    actions = state.completed_actions
    ordered: tuple[str, ...] | str
    ordered = actions if isinstance(actions, str) else tuple(sorted(actions))
    return AdvanceFingerprint(state.checkpoint_id, ordered)
