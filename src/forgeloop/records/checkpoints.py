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
from datetime import UTC, datetime
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

# 人工续跑只对中断现场生效：任务状态为 interrupted，或检查点落有 halted_reason。
INTERRUPTED = "interrupted"

# ``--by`` 去首尾空白后的合法长度上限；下限是 1（不允许空标识）。
MAX_DECIDED_BY_LENGTH = 64

# 人工续跑决定的记录表：与权威业务记录同库（records.sqlite），不改检查点库。
RETRY_DECISION_TABLE = "requirement_retry_decisions"

_RETRY_DECISION_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {RETRY_DECISION_TABLE} (
    decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    req_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    plan_version INTEGER,
    checkpoint_id TEXT
);
CREATE INDEX IF NOT EXISTS retry_decisions_by_task
    ON {RETRY_DECISION_TABLE} (req_id, task_id, decided_at);
"""

# 旧决定表缺列时按需补齐：新增的绑定列必须持久化，但不重写既有历史行（补为 NULL）。
_RETRY_DECISION_EXTRA_COLUMNS: Mapping[str, str] = {
    "plan_version": "INTEGER",
    "checkpoint_id": "TEXT",
}


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
    # 检查点内部随图状态落库的任务身份与任务包版本；用于人工续跑前的可信核对。
    # 旧检查点未携带时为 ``""`` / ``None``，据此一律判为不可信（fail-closed）。
    recorded_task_id: str = ""
    plan_version: int | None = None

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


class CheckpointHealth(StrEnum):
    """只读检查点的健康判定：可用、缺失、不可读或状态损坏。"""

    OK = "ok"
    MISSING = "missing"
    UNREADABLE = "unreadable"
    CORRUPT = "corrupt"


@dataclass(frozen=True)
class CheckpointInspection:
    """一次只读检查点检查：健康判定与可用时的摘要。

    ``state`` 只在 ``health is OK`` 时非空；其余健康值一律没有可用摘要，人工续跑
    前置校验据此 fail-closed 拒绝，不猜测「可不可以续跑」。
    """

    health: CheckpointHealth
    state: CheckpointState | None = None


@dataclass(frozen=True)
class RetryDecision:
    """一条人工续跑决定：调用方标识、时间、理由、目标任务/需求身份与绑定现场。

    ``plan_version`` 与 ``checkpoint_id`` 记录授权时被校验过的方案版本与检查点
    身份：读取叠加清除时据此重新核对，过期决定不得清除已被替换的检查点现场。
    旧记录缺列时为 ``None`` / ``""``，一律不匹配任何现场（fail-closed）。
    """

    requirement_id: str
    task_id: str
    decided_by: str
    reason: str
    decided_at: datetime
    plan_version: int | None = None
    checkpoint_id: str = ""


@dataclass(frozen=True)
class RetryCheck:
    """人工续跑前置校验结果：是否放行与逐条可操作拒绝原因。"""

    allowed: bool
    reasons: tuple[str, ...] = ()

    @property
    def reason(self) -> str:
        """把逐条拒绝原因拼成可直接展示给人工的文本；放行时为空串。"""

        return "；".join(self.reasons)


@dataclass(frozen=True)
class RetryAuthorization:
    """一次人工续跑授权：校验结果、落库决定与清除 halted 后的检查点摘要。

    校验失败时 ``checkpoint`` 与 ``decision`` 都为 ``None``，表示没有发生清除或
    写入；校验通过时 ``checkpoint`` 是 ``halted_reason`` 已清空的摘要，
    ``decision`` 是同一次授权写入并可回查的记录。
    """

    allowed: bool
    check: RetryCheck
    decision: RetryDecision | None = None
    checkpoint: CheckpointState | None = None


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


def _plan_version(values: Mapping[str, Any]) -> int | None:
    """从检查点的 ``channel_values`` 还原任务包版本；缺失或不可解析时为 ``None``。"""

    raw = values.get("plan_version")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def inspect_checkpoint(records_root: str | Path, task_id: str) -> CheckpointInspection:
    """只读检查某线程身份下最近检查点的健康与摘要。

    与 :func:`read_checkpoint` 同源，但保留失败分类：库缺失、库不可读、内容损坏
    分别返回不同健康值，供人工续跑前置校验给出可操作的拒绝原因。读取绝不连接会
    触发建表的写入路径，也不改造现场。
    """

    root = Path(records_root)
    records_dir = root.parent if root.is_file() else root
    # 记录根目录或直接指向数据库文件都能定位到检查点库。
    path = root if root.is_file() else root / CHECKPOINT_DB_NAME
    if not path.exists():
        return CheckpointInspection(CheckpointHealth.MISSING)
    if path.is_dir():
        return CheckpointInspection(CheckpointHealth.UNREADABLE)
    if path.stat().st_size == 0:
        # 空文件不连接、不建表、不改造现场，等同于没有可用检查点。
        return CheckpointInspection(CheckpointHealth.MISSING)
    connection = _connect_read_only(path)
    if connection is None:
        return CheckpointInspection(CheckpointHealth.UNREADABLE)
    try:
        try:
            row = connection.execute(_LATEST_CHECKPOINT_SQL, (task_id,)).fetchone()
        except sqlite3.Error:
            # 缺表或损坏检查点：如实视为不可信，不猜测可续跑。
            return CheckpointInspection(CheckpointHealth.CORRUPT)
        if row is None:
            return CheckpointInspection(CheckpointHealth.MISSING)
        checkpoint_id, type_, blob = row
        saver = SqliteSaver(connection)
        try:
            loaded = saver.serde.loads_typed((type_, blob))
            if not isinstance(loaded, Mapping):
                raise ValueError("检查点不是映射")
            checkpoint = cast("Checkpoint", loaded)
            values = checkpoint.get("channel_values") or {}
            state = CheckpointState(
                task_id=task_id,
                checkpoint_id=str(checkpoint_id or ""),
                next_nodes=_pending_nodes(values),
                halted_reason=str(values.get("halted_reason") or ""),
                recorded_task_id=str(values.get("task_id") or ""),
                plan_version=_plan_version(values),
            )
        except (
            sqlite3.Error,
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
            NotImplementedError,
        ):
            return CheckpointInspection(CheckpointHealth.CORRUPT)
    finally:
        connection.close()
    return CheckpointInspection(
        CheckpointHealth.OK,
        replace(
            state,
            outstanding_node=outstanding_action_node(records_dir, task_id),
            completed_actions=completed_action_ids(records_dir, task_id),
        ),
    )


def read_checkpoint(
    records_root: str | Path,
    task_id: str,
) -> CheckpointState | None:
    """只读读取某线程身份下最近的检查点摘要；无记录或不可读时返回 ``None``。

    ``records_root`` 可以是记录根目录，也可以直接是检查点数据库文件；缺省按
    ``<records_root>/checkpoints.sqlite`` 定位。库文件不存在时不创建空库，直接
    返回 ``None``，避免读取动作产生副作用。检查点身份与动作事实一起返回，供推进器
    判定可续跑与重复推进的幂等口径。需要区分失败类别时改用
    :func:`inspect_checkpoint`。
    """

    return inspect_checkpoint(records_root, task_id).state


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


# ---- 人工续跑决定：持久化、回查与前置校验 ----


def _open_decision_store(records_root: str | Path) -> sqlite3.Connection:
    """打开（必要时创建）人工续跑决定表；只写 records.sqlite，不碰检查点库。"""

    root = Path(records_root)
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(root / RECORDS_DB_NAME, isolation_level=None)
    connection.executescript(_RETRY_DECISION_SCHEMA)
    existing = {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({RETRY_DECISION_TABLE})").fetchall()
    }
    for name, declaration in _RETRY_DECISION_EXTRA_COLUMNS.items():
        if name not in existing:
            connection.execute(
                f"ALTER TABLE {RETRY_DECISION_TABLE} ADD COLUMN {name} {declaration}"
            )
    return connection


def _record_retry_decision(records_root: str | Path, decision: RetryDecision) -> RetryDecision:
    """把一条人工续跑决定写入 records.sqlite；写入失败向上抛出，不静默吞掉。"""

    connection = _open_decision_store(records_root)
    try:
        connection.execute(
            f"INSERT INTO {RETRY_DECISION_TABLE}"
            " (req_id, task_id, decided_by, reason, decided_at, plan_version, checkpoint_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                decision.requirement_id,
                decision.task_id,
                decision.decided_by,
                decision.reason,
                decision.decided_at.astimezone(UTC).isoformat(),
                decision.plan_version,
                decision.checkpoint_id,
            ),
        )
    finally:
        connection.close()
    return decision


def _row_to_decision(row: tuple[Any, ...]) -> RetryDecision:
    return RetryDecision(
        requirement_id=str(row[0]),
        task_id=str(row[1]),
        decided_by=str(row[2]),
        reason=str(row[3]),
        decided_at=datetime.fromisoformat(str(row[4])),
        plan_version=None if row[5] is None else int(row[5]),
        checkpoint_id="" if row[6] is None else str(row[6]),
    )


def retry_decisions(
    records_root: str | Path,
    requirement_id: str,
    task_id: str | None = None,
) -> tuple[RetryDecision, ...]:
    """按需求身份（可选再按目标任务）回查人工续跑决定，按时间与写入顺序升序。

    记录库或决定表缺失时返回空元组（确实没有决定），不臆造也不静默失败；读取经
    只读连接，绝不建表或改造现场。
    """

    root = Path(records_root)
    path = root / RECORDS_DB_NAME
    if not path.is_file():
        return ()
    connection = _connect_read_only(path)
    if connection is None:
        return ()
    try:
        try:
            columns = {
                str(row[1])
                for row in connection.execute(
                    f"PRAGMA table_info({RETRY_DECISION_TABLE})"
                ).fetchall()
            }
        except sqlite3.Error:
            return ()
        if not columns:
            return ()
        # 旧库可能缺新增的绑定列：缺失时补 NULL，读取不掩盖既有决定。
        plan_expr = "plan_version" if "plan_version" in columns else "NULL"
        checkpoint_expr = "checkpoint_id" if "checkpoint_id" in columns else "NULL"
        statement = (
            "SELECT req_id, task_id, decided_by, reason, decided_at,"
            f" {plan_expr}, {checkpoint_expr}"
            f" FROM {RETRY_DECISION_TABLE} WHERE req_id = ?"
            + (" AND task_id = ?" if task_id is not None else "")
            + " ORDER BY decided_at, decision_id"
        )
        parameters: tuple[object, ...] = (requirement_id,)
        if task_id is not None:
            parameters = (requirement_id, task_id)
        try:
            rows = connection.execute(statement, parameters).fetchall()
        except sqlite3.Error:
            return ()
    finally:
        connection.close()
    return tuple(_row_to_decision(tuple(row)) for row in rows)


def latest_retry_decision(
    records_root: str | Path,
    requirement_id: str,
    task_id: str | None = None,
) -> RetryDecision | None:
    """最近一次人工续跑决定；没有决定时返回 ``None``。"""

    decisions = retry_decisions(records_root, requirement_id, task_id)
    return decisions[-1] if decisions else None


def clear_halted_reason(state: CheckpointState | None) -> CheckpointState | None:
    """返回清除 ``halted_reason`` 的检查点摘要；没有检查点时保持 ``None``。

    只返回新摘要，不改写 LangGraph 检查点库；持久化事实由人工续跑决定记录承载，
    :func:`read_authorized_checkpoint` 据此叠加出「已清除」的有效现场。
    """

    if state is None:
        return None
    return replace(state, halted_reason="")


def read_authorized_checkpoint(
    records_root: str | Path,
    thread_id: str,
    *,
    requirement_id: str,
    task_id: str,
) -> CheckpointState | None:
    """读取检查点，并在存在**匹配当前现场**的人工续跑决定时把 ``halted_reason`` 视为已清除。

    清除前必须重新核对现场：仅当读到的检查点健康、记录的任务身份与目标任务一致，
    且存在一条决定同时绑定同一 ``plan_version`` 与 ``checkpoint_id`` 时才叠加清除。
    检查点被替换或方案版本变化后，过期决定不再生效，``halted_reason`` 原样保留，
    避免「授权过就永远放行」的越权。无匹配决定或检查点不可用时行为与
    :func:`read_checkpoint` 一致。
    """

    state = inspect_checkpoint(records_root, thread_id).state
    if state is None:
        return None
    if state.recorded_task_id != task_id or state.plan_version is None:
        return state
    for decision in reversed(retry_decisions(records_root, requirement_id, task_id)):
        if (
            decision.plan_version == state.plan_version
            and decision.checkpoint_id == state.checkpoint_id
        ):
            return clear_halted_reason(state)
    return state


def validate_retry(
    inspection: CheckpointInspection,
    *,
    requirement_id: str,
    task_id: str,
    plan_version: int,
    task_status: str,
    by: str,
    reason: str,
) -> RetryCheck:
    """可复用的人工续跑前置校验：状态、检查点可信与取值全部通过才放行。

    状态必须为 ``interrupted`` 或检查点落有 ``halted_reason``；检查点的缺失、读取
    失败、状态损坏、``task_id`` 与目标任务不一致、``plan_version`` 与已批准任务包
    版本不一致，以及「任务为 interrupted 但检查点无 halted_reason」一律判为不可信。
    每条拒绝都给出可操作原因，调用方据此 fail-closed。
    """

    reasons: list[str] = []
    if not requirement_id.strip():
        reasons.append("需求身份不能为空")
    if not task_id.strip():
        reasons.append("目标任务身份不能为空")

    decided_by = by.strip()
    if not decided_by:
        reasons.append("调用方标识 --by 不能为空（例如 --by owner）")
    elif len(decided_by) > MAX_DECIDED_BY_LENGTH:
        reasons.append(f"调用方标识 --by 去首尾空白后长度须为 1-{MAX_DECIDED_BY_LENGTH} 个字符")
    elif not decided_by.isprintable():
        reasons.append("调用方标识 --by 只能包含可打印字符")

    if not reason.strip():
        reasons.append("续跑理由 --reason 不能为空")

    state = inspection.state
    halted = bool(state and state.halted_reason.strip())
    if task_status != INTERRUPTED and not halted:
        reasons.append(
            f"任务状态不符：当前 {task_status}，只有 {INTERRUPTED}"
            " 或存在 halted_reason 的任务可人工续跑"
        )

    health = inspection.health
    if health is CheckpointHealth.MISSING:
        reasons.append("检查点缺失：找不到可续跑的 LangGraph 现场，禁止盲目续跑，请人工核对后处理")
    elif health is CheckpointHealth.UNREADABLE:
        reasons.append("检查点读取失败：SqliteSaver 无法打开检查点库，禁止盲目续跑，请人工核对现场")
    elif health is CheckpointHealth.CORRUPT or state is None:
        reasons.append("检查点状态损坏：无法解析最近检查点，禁止盲目续跑，请人工核对现场")
    else:
        if state.recorded_task_id != task_id:
            recorded_task = state.recorded_task_id or "缺失"
            reasons.append(
                f"检查点 task_id 与目标任务不一致：{recorded_task} != {task_id}，"
                "请人工核对现场后处理"
            )
        if state.plan_version != plan_version:
            recorded_plan = "缺失" if state.plan_version is None else str(state.plan_version)
            reasons.append(
                f"检查点 plan_version 与已批准任务包版本不一致：{recorded_plan} != {plan_version}，"
                "请重新批准任务包后处理"
            )
        if task_status == INTERRUPTED and not halted:
            reasons.append(
                "任务为 interrupted 但检查点无 halted_reason，无法确认中断现场，禁止盲目续跑"
            )

    return RetryCheck(allowed=not reasons, reasons=tuple(reasons))


def authorize_retry(
    records_root: str | Path,
    *,
    inspection: CheckpointInspection,
    requirement_id: str,
    task_id: str,
    plan_version: int,
    task_status: str,
    by: str,
    reason: str,
    at: datetime | None = None,
) -> RetryAuthorization:
    """校验通过后才记录人工决定并清除 ``halted_reason``；失败时零副作用。

    固定次序：先 :func:`validate_retry`，只有全部通过才写入决定记录并返回把
    ``halted_reason`` 清空的检查点摘要。任何一项不通过都直接返回拒绝结果，既不写
    决定也不改动检查点现场。
    """

    check = validate_retry(
        inspection,
        requirement_id=requirement_id,
        task_id=task_id,
        plan_version=plan_version,
        task_status=task_status,
        by=by,
        reason=reason,
    )
    if not check.allowed:
        return RetryAuthorization(False, check)
    cleared = clear_halted_reason(inspection.state)
    state = inspection.state
    decision = RetryDecision(
        requirement_id=requirement_id,
        task_id=task_id,
        decided_by=by.strip(),
        reason=reason,
        decided_at=at or datetime.now(UTC),
        plan_version=plan_version,
        checkpoint_id=state.checkpoint_id if state is not None else "",
    )
    _record_retry_decision(records_root, decision)
    return RetryAuthorization(True, check, decision, cleared)
