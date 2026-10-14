"""工时摘要的纯领域规则：按任务状态与权威 ``budget`` 行只读派生。

规则来源（V0-09）：执行时间限额默认两小时，超限停止启动新动作并报告。
本模块不做计时、不读取记录、不写状态；它只把「任务状态」与权威 ``budget``
行的存在性及读数（``limit_seconds``、``consumed_seconds``，以及由其派生的
``exhausted``）合成为一份只读摘要，供查询与排障说明「用了多少、为何停下」。

边界（不猜测、不臆造）：

- 无 ``budget`` 行且状态表明任务尚未开始时输出 ``not_started``，``consumed``/
  ``limit``/``exhausted`` 一律为 ``None``，不把「没有记录」伪装成 0 秒。
- 有 ``budget`` 行时以该行唯一权威，输出 ``consumed``/``limit``/``exhausted``。
- 状态与存在性冲突（状态说已开始却无行，或有行却状态说未开始）时，以「存在
  ``budget`` 行」为更强的存在性事实输出 ``unknown``，并在 ``note`` 说明冲突。
- ``dimensions`` 目前只声明 ``seconds`` 一个维度，不臆造其他维度。
"""

from dataclasses import dataclass
from enum import StrEnum

from forgeloop.domain.limits import ExecutionBudget

# 当前摘要只覆盖单一时间维度；新增维度必须显式登记，不由调用方推测。
DIMENSIONS: tuple[str, ...] = ("seconds",)

# 明确表示任务尚未开始、因而尚未分配执行工时的状态；其余状态视为已开始。
_UNSTARTED_STATUSES = frozenset({"pending", "created", "awaiting_plan_approval"})


class BudgetSummaryState(StrEnum):
    """工时摘要的状态标记。"""

    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    EXHAUSTED = "exhausted"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class BudgetSummary:
    """一份只读工时摘要；未知读数用 ``None`` 表示，绝不臆造为 0。"""

    state: BudgetSummaryState
    consumed_seconds: float | None
    limit_seconds: float | None
    exhausted: bool | None
    dimensions: tuple[str, ...]
    note: str


def _not_started(status: str) -> BudgetSummary:
    return BudgetSummary(
        state=BudgetSummaryState.NOT_STARTED,
        consumed_seconds=None,
        limit_seconds=None,
        exhausted=None,
        dimensions=DIMENSIONS,
        note=(f"状态 {status} 表明任务尚未开始，且无 budget 行；未产生工时，读数为未知而非 0 秒"),
    )


def _missing_budget_conflict(status: str) -> BudgetSummary:
    return BudgetSummary(
        state=BudgetSummaryState.UNKNOWN,
        consumed_seconds=None,
        limit_seconds=None,
        exhausted=None,
        dimensions=DIMENSIONS,
        note=(f"冲突：状态 {status} 表明任务已开始，但缺少 budget 行；存在性与状态不一致，不猜测"),
    )


def _row_conflict(status: str, budget: ExecutionBudget) -> BudgetSummary:
    return BudgetSummary(
        state=BudgetSummaryState.UNKNOWN,
        consumed_seconds=budget.consumed_seconds,
        limit_seconds=budget.limit_seconds,
        exhausted=budget.exhausted,
        dimensions=DIMENSIONS,
        note=(
            f"冲突：状态 {status} 表明任务尚未开始，但已存在 budget 行；"
            "以存在 budget 行为准，读数为该行事实，状态标记为未知"
        ),
    )


def _from_budget(budget: ExecutionBudget) -> BudgetSummary:
    if budget.exhausted:
        return BudgetSummary(
            state=BudgetSummaryState.EXHAUSTED,
            consumed_seconds=budget.consumed_seconds,
            limit_seconds=budget.limit_seconds,
            exhausted=True,
            dimensions=DIMENSIONS,
            note=f"执行时间限额已耗尽：已消耗 {budget.consumed_seconds}/{budget.limit_seconds} 秒",
        )
    return BudgetSummary(
        state=BudgetSummaryState.IN_PROGRESS,
        consumed_seconds=budget.consumed_seconds,
        limit_seconds=budget.limit_seconds,
        exhausted=False,
        dimensions=DIMENSIONS,
        note=f"已消耗 {budget.consumed_seconds}/{budget.limit_seconds} 秒",
    )


def summarize_budget(status: str, budget: ExecutionBudget | None) -> BudgetSummary:
    """按任务状态与权威 ``budget`` 行派生只读工时摘要。

    ``budget`` 为 ``None`` 表示权威记录中没有该任务的 budget 行；是否存在
    由调用方按记录只读读出，本函数不访问数据库、时钟或环境。
    """

    if budget is None:
        if status in _UNSTARTED_STATUSES:
            return _not_started(status)
        return _missing_budget_conflict(status)
    if status in _UNSTARTED_STATUSES:
        return _row_conflict(status, budget)
    return _from_budget(budget)
