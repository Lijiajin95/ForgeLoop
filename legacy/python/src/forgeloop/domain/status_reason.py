"""从权威记录推导中文阻断原因 ``blocked_reason_text``：纯逻辑，不读记录、时钟或环境。

规则来源（任务 ``status-reason-domain``）：

- 只依据权威记录（``tasks``/``plans``/``approvals``/``approval_consumption``/
  ``actions``/``failure_rounds``/``grants``/``budget``）推导，调用方把只读取数
  组装成 :class:`TaskFacts`，本模块不读写任何持久化介质、也不猜测缺省值。
- 主句按固定优先级选择：① 等待人工决定（方案批准/追加授权/验收）→ ② 依赖未
  满足 → ③ 失败轮次用尽等待追加授权 → ④ 运行中 → ⑤ 已终态；工时限额与人工核对
  作为低优先级的补充条件，保证任何状态都能给出一句非空结论。
- 「等待人工决定」写明是哪道门，「依赖未满足」列出所缺前置，「失败轮次用尽」
  同时给出已用轮次与轮次上限（``grant_count * MAX_ROUNDS_PER_GRANT``），
  「运行中」的当前动作身份只来自 ``actions`` 表 ``started`` 未完成动作，
  「已终态」给出终态与本轮结论。
- 除主句外，最多再补两条其他同时成立的条件，接在句末「；另外还有…」之后，按
  同一优先级顺序截取，不省略关键事实（失败轮次与当前动作同样带出数字与身份）。
- 判定依据缺失时输出 ``unknown`` 并逐条列出缺少哪条记录身份，绝不猜测为已满足
  或未满足。
- 本模块只读既有事实、不改变任何既有字段的名称与语义；状态词只作为事实之一，
  有权威记录时以记录为准（例如方案已批准时不因状态词滞后而误报等待批准）。
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from forgeloop.domain.counting import MAX_ROUNDS_PER_GRANT
from forgeloop.domain.dependency_facts import TerminalState


class StatusReasonError(ValueError):
    """阻断原因输入违反任务身份、配额或限额规则。"""


class ReasonCondition(StrEnum):
    """一个可从权威记录判定的阻断或推进条件。"""

    AWAITING_PLAN_APPROVAL = "awaiting_plan_approval"
    AWAITING_GRANT = "awaiting_grant"
    AWAITING_ACCEPTANCE = "awaiting_acceptance"
    DEPENDENCY_UNMET = "dependency_unmet"
    GRANT_EXHAUSTED = "grant_exhausted"
    RUNNING = "running"
    TERMINAL = "terminal"
    BUDGET_EXHAUSTED = "budget_exhausted"
    MANUAL_REVIEW = "manual_review"


# 主句与补充句都按此顺序取用：越靠前越优先。
_PRIORITY: tuple[ReasonCondition, ...] = (
    ReasonCondition.AWAITING_PLAN_APPROVAL,
    ReasonCondition.AWAITING_GRANT,
    ReasonCondition.AWAITING_ACCEPTANCE,
    ReasonCondition.DEPENDENCY_UNMET,
    ReasonCondition.GRANT_EXHAUSTED,
    ReasonCondition.RUNNING,
    ReasonCondition.TERMINAL,
    ReasonCondition.BUDGET_EXHAUSTED,
    ReasonCondition.MANUAL_REVIEW,
)

# 达到终态的状态词（权威终态记录由 ``terminal`` 单独给出）。
_TERMINAL_STATUSES = frozenset({"delivered", "merged", "rejected", "stopped"})

# 需要人工核对现场的状态词：既非三类人工决定，也非正常推进或终态。
_MANUAL_REVIEW_STATUSES = frozenset({"blocked", "interrupted", "stop_requested"})

# 等待验收的状态词：候选已通过正式测试，等待所有者整体验收。
_AWAITING_ACCEPTANCE_STATUSES = frozenset({"tested", "awaiting_acceptance"})

_UNKNOWN_PREFIX = "unknown"


@dataclass(frozen=True)
class TaskFacts:
    """一个任务的权威记录事实；只用于推导，不被本模块改写。

    状态词 ``status`` 只是事实之一：有方案/批准/终态等权威记录时以记录为准，
    记录缺失与否由 ``missing`` 如实列出。
    """

    task_id: str
    status: str = ""
    # plans（最高方案版本；None 表示没有方案记录）
    plan_version: int | None = None
    # approvals（生效的方案/验收批准版本；None 表示对应批准未记录）
    plan_approval_version: int | None = None
    acceptance_approval_version: int | None = None
    # actions（最早的 started 未完成动作身份）
    outstanding_action: str | None = None
    # failure_rounds/grants（累计失败轮次与授权次数）
    failure_rounds: int = 0
    grant_count: int = 1
    # budget（工时限额与已消耗；None 表示缺少该记录，不据此判定）
    budget_limit_seconds: float | None = None
    budget_consumed_seconds: float | None = None
    # 终态记录（approval_consumption/deliveries/merges/releases 汇总）
    terminal: TerminalState | None = None
    # 依赖事实（由 dependency_facts 判定后传入）
    unmet_prerequisites: tuple[str, ...] = ()
    # 缺少的权威记录身份；非空即输出 unknown
    missing: tuple[str, ...] = ()
    # 判定所依据的记录身份，随结果如实返回
    evidence: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.task_id.strip():
            raise StatusReasonError("任务身份不能为空")
        if self.plan_version is not None and self.plan_version < 1:
            raise StatusReasonError("方案版本必须从 1 开始")
        if self.failure_rounds < 0:
            raise StatusReasonError("失败轮次数不能为负")
        if self.grant_count < 1:
            raise StatusReasonError("至少要有一次初始授权")
        if self.budget_limit_seconds is not None and self.budget_limit_seconds <= 0:
            raise StatusReasonError("工时限额必须为正数")
        if self.budget_consumed_seconds is not None and self.budget_consumed_seconds < 0:
            raise StatusReasonError("已消耗工时不能为负")


@dataclass(frozen=True)
class StatusReason:
    """阻断原因推导结果：一句话、生效条件与依据。"""

    task_id: str
    blocked_reason_text: str
    main_condition: ReasonCondition | None
    supplements: tuple[ReasonCondition, ...]
    active_conditions: tuple[ReasonCondition, ...]
    missing: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()

    @property
    def is_unknown(self) -> bool:
        """依据缺失：结论为 unknown，不退化成猜测。"""

        return bool(self.missing)


def _awaiting_plan_approval(facts: TaskFacts) -> bool:
    """等待方案批准：有方案记录但生效批准版本不匹配；无方案时以状态词兜底。"""

    if facts.plan_version is None:
        return facts.status == "awaiting_plan_approval"
    return facts.plan_approval_version != facts.plan_version


def _awaiting_grant(facts: TaskFacts) -> bool:
    """等待追加授权决定：状态词显式记录为 awaiting_grant。"""

    return facts.status == "awaiting_grant"


def _awaiting_acceptance(facts: TaskFacts) -> bool:
    """等待验收：状态词表明候选已就绪，且当前方案版本尚无验收批准。"""

    if facts.terminal is not None:
        return False
    if facts.status not in _AWAITING_ACCEPTANCE_STATUSES:
        return False
    return facts.acceptance_approval_version != facts.plan_version


def _dependency_unmet(facts: TaskFacts) -> bool:
    return bool(facts.unmet_prerequisites)


def _grant_exhausted(facts: TaskFacts) -> bool:
    """失败轮次用尽：累计失败达到历次授权允许的上限。"""

    return facts.failure_rounds >= facts.grant_count * MAX_ROUNDS_PER_GRANT


def _running(facts: TaskFacts) -> bool:
    """运行中：唯一依据是 ``actions`` 表中 ``started`` 未完成动作。

    状态词（``implementing``/``reviewing`` 等）可能滞后或与记录不一致，绝不据此
    判定运行中；只有 ``outstanding_action`` 非空才算在推进。
    """

    return facts.outstanding_action is not None


def _terminal(facts: TaskFacts) -> bool:
    return facts.terminal is not None or facts.status in _TERMINAL_STATUSES


def _budget_exhausted(facts: TaskFacts) -> bool:
    if facts.status == "time_exhausted":
        return True
    if facts.budget_limit_seconds is None or facts.budget_consumed_seconds is None:
        return False
    return facts.budget_consumed_seconds >= facts.budget_limit_seconds


def _manual_review(facts: TaskFacts) -> bool:
    return facts.status in _MANUAL_REVIEW_STATUSES


# 判定顺序与 :data:`_PRIORITY` 一致；同一份事实可同时满足多条。
_CONDITION_CHECKS: tuple[tuple[ReasonCondition, Callable[[TaskFacts], bool]], ...] = (
    (ReasonCondition.AWAITING_PLAN_APPROVAL, _awaiting_plan_approval),
    (ReasonCondition.AWAITING_GRANT, _awaiting_grant),
    (ReasonCondition.AWAITING_ACCEPTANCE, _awaiting_acceptance),
    (ReasonCondition.DEPENDENCY_UNMET, _dependency_unmet),
    (ReasonCondition.GRANT_EXHAUSTED, _grant_exhausted),
    (ReasonCondition.RUNNING, _running),
    (ReasonCondition.TERMINAL, _terminal),
    (ReasonCondition.BUDGET_EXHAUSTED, _budget_exhausted),
    (ReasonCondition.MANUAL_REVIEW, _manual_review),
)

# 主句：完整说明「为什么停住、等谁做什么」。
_MAIN_CLAUSES: dict[ReasonCondition, str] = {
    ReasonCondition.AWAITING_PLAN_APPROVAL: "等待人工批准方案（范围、方案、验收标准与测试命令）",
    ReasonCondition.AWAITING_GRANT: "等待人工决定是否追加失败轮次授权",
    ReasonCondition.AWAITING_ACCEPTANCE: "等待人工整体验收（核对 diff、审查与测试证据）",
    ReasonCondition.DEPENDENCY_UNMET: "前置任务未满足，等待依赖完成",
    ReasonCondition.GRANT_EXHAUSTED: "失败轮次额度已用尽，等待人工追加授权",
    ReasonCondition.RUNNING: "任务正在执行中，等待当前动作完成",
    ReasonCondition.TERMINAL: "任务已到达终态",
    ReasonCondition.BUDGET_EXHAUSTED: "执行工时限额已耗尽，等待人工延长限额或拆分任务",
    ReasonCondition.MANUAL_REVIEW: "任务需要人工核对现场",
}

# 补充句：短标签，跟在「；另外还有…」之后，最多两条。
_SUPPLEMENT_LABELS: dict[ReasonCondition, str] = {
    ReasonCondition.AWAITING_PLAN_APPROVAL: "等待方案批准",
    ReasonCondition.AWAITING_GRANT: "等待追加授权决定",
    ReasonCondition.AWAITING_ACCEPTANCE: "等待验收",
    ReasonCondition.DEPENDENCY_UNMET: "依赖未满足",
    ReasonCondition.GRANT_EXHAUSTED: "失败轮次用尽",
    ReasonCondition.RUNNING: "正在执行",
    ReasonCondition.TERMINAL: "已到终态",
    ReasonCondition.BUDGET_EXHAUSTED: "工时限额耗尽",
    ReasonCondition.MANUAL_REVIEW: "需要人工核对",
}

_FALLBACK_MAIN = "任务正常推进，暂无阻断条件"
_SUPPLEMENT_PREFIX = "；另外还有"
_MAX_SUPPLEMENTS = 2


def _unique(items: Sequence[str]) -> tuple[str, ...]:
    """稳定去重：保持首次出现顺序。"""

    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return tuple(ordered)


def _round_limit(facts: TaskFacts) -> int:
    """授权次数允许的累计失败轮次上限（每次授权 3 轮，累计不清零）。"""

    return facts.grant_count * MAX_ROUNDS_PER_GRANT


def _grant_usage(facts: TaskFacts) -> str:
    """失败轮次用尽时必须给出的关键事实：已用轮次与轮次上限。"""

    return f"已用 {facts.failure_rounds} 轮，上限 {_round_limit(facts)} 轮"


def _grant_exhausted_main(facts: TaskFacts) -> str:
    return f"失败轮次额度已用尽（{_grant_usage(facts)}），等待人工追加授权"


def _running_main(facts: TaskFacts) -> str:
    if facts.outstanding_action is None:
        return _MAIN_CLAUSES[ReasonCondition.RUNNING]
    return f"任务正在执行中，当前动作：{facts.outstanding_action}，等待其完成"


def _supplement_label(condition: ReasonCondition, facts: TaskFacts) -> str:
    """补充句也带出关键事实：失败轮次的数字与运行中的动作身份。"""

    if condition is ReasonCondition.GRANT_EXHAUSTED:
        return f"失败轮次用尽（{_grant_usage(facts)}）"
    if condition is ReasonCondition.RUNNING and facts.outstanding_action is not None:
        return f"正在执行（当前动作：{facts.outstanding_action}）"
    return _SUPPLEMENT_LABELS[condition]


def active_conditions(facts: TaskFacts) -> tuple[ReasonCondition, ...]:
    """返回全部成立条件，按固定优先级排序。"""

    return tuple(condition for condition, check in _CONDITION_CHECKS if check(facts))


def _main_clause(condition: ReasonCondition | None, facts: TaskFacts) -> str:
    if condition is None:
        return _FALLBACK_MAIN
    if condition is ReasonCondition.DEPENDENCY_UNMET:
        dependencies = "、".join(facts.unmet_prerequisites) or "未给出依赖身份"
        return f"{_MAIN_CLAUSES[condition]}：{dependencies}"
    if condition is ReasonCondition.GRANT_EXHAUSTED:
        return _grant_exhausted_main(facts)
    if condition is ReasonCondition.RUNNING:
        return _running_main(facts)
    if condition is ReasonCondition.TERMINAL:
        label = facts.terminal.value if facts.terminal is not None else facts.status
        return f"{_MAIN_CLAUSES[condition]}（{label}），本轮已结束"
    if condition is ReasonCondition.MANUAL_REVIEW:
        return f"{_MAIN_CLAUSES[condition]}（状态：{facts.status}）"
    return _MAIN_CLAUSES[condition]


def _supplement_clause(conditions: tuple[ReasonCondition, ...], facts: TaskFacts) -> str:
    if not conditions:
        return ""
    labels = "、".join(_supplement_label(condition, facts) for condition in conditions)
    return f"{_SUPPLEMENT_PREFIX}{labels}"


def derive_status_reason(facts: TaskFacts) -> StatusReason:
    """从权威事实推导一句中文阻断原因与生效条件（纯函数）。

    ``facts.missing`` 非空时优先输出 ``unknown`` 并列出缺少的记录身份；否则按
    :data:`_PRIORITY` 取最高优先级的主句，再以「；另外还有…」补出最多两条其他
    成立条件，任何情况下都不返回空串。
    """

    missing = _unique(facts.missing)
    evidence_items = list(facts.evidence)
    if facts.outstanding_action is not None:
        evidence_items.append(f"actions:{facts.outstanding_action}")
    evidence = _unique(evidence_items)
    if missing:
        return StatusReason(
            task_id=facts.task_id,
            blocked_reason_text=f"{_UNKNOWN_PREFIX}：依据缺失（{'、'.join(missing)}）",
            main_condition=None,
            supplements=(),
            active_conditions=(),
            missing=missing,
            evidence=evidence,
        )
    active = active_conditions(facts)
    main_condition = active[0] if active else None
    supplements = active[1 : 1 + _MAX_SUPPLEMENTS]
    text = f"{_main_clause(main_condition, facts)}{_supplement_clause(supplements, facts)}"
    return StatusReason(
        task_id=facts.task_id,
        blocked_reason_text=text,
        main_condition=main_condition,
        supplements=supplements,
        active_conditions=active,
        missing=(),
        evidence=evidence,
    )


def blocked_reason_text(facts: TaskFacts) -> str:
    """便捷入口：只取推导结果中的一句话。"""

    return derive_status_reason(facts).blocked_reason_text
