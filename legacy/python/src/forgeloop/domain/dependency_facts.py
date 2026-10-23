"""依赖事实与真实阻塞判定：纯规则，不读取记录、时钟或环境。

规则来源（G02 依赖事实任务、DogFood 交接约定 §4、§5）：

- 一个任务的前置任务只有在权威记录里达到终态（``accepted``/``delivered``/
  ``merged``/``released``）才算满足；未达终态即依赖未满足。
- 判定只依据权威记录，不依据可能滞后的状态词：前置已落库为终态时，即使任务
  状态词仍写着 ``blocked``/``implementing``，也不判为阻塞——状态滞后不是依据。
- 只有在「存在未满足前置且没有未完成动作」时才判为 ``waiting``；存在 ``started``
  未完成动作时判为 ``running``（在推进，不是等待）。依赖等待与既有状态词的
  ``blocked`` 含义不同，本模块不新增状态词。
- 缺少判定依据时（例如前置任务记录根本不存在）输出 ``unknown``，并逐条列出
  缺少哪条记录，绝不猜测为已满足或未满足。
- 判定所依据的权威记录身份（``tasks``/``deliveries``/``approval_consumption``/
  ``actions`` 等）随结果返回，供查询层如实展示。

本模块只维护不可变事实与纯判定；记录读取由 ``records`` 层负责。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum


class DependencyFactsError(ValueError):
    """依赖事实输入违反任务身份或终态取值规则。"""


class TerminalState(StrEnum):
    """前置任务在权威记录中的达标终态。

    ``accepted`` 由已消费的验收批准证明，``delivered`` 由交付记录证明，
    ``merged``/``released`` 是更靠后的终态；任一即视为依赖已满足。
    """

    ACCEPTED = "accepted"
    DELIVERED = "delivered"
    MERGED = "merged"
    RELEASED = "released"


TERMINAL_STATES: frozenset[TerminalState] = frozenset(TerminalState)


class DependencyVerdict(StrEnum):
    """一个任务相对其前置任务的判定结果。"""

    READY = "ready"
    WAITING = "waiting"
    RUNNING = "running"
    UNKNOWN = "unknown"


def _unique(items: Sequence[str]) -> tuple[str, ...]:
    """稳定去重：保持首次出现顺序。"""

    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return tuple(ordered)


@dataclass(frozen=True)
class PrerequisiteFact:
    """一个前置任务的权威事实。

    ``terminal`` 为 ``None`` 表示权威记录显示尚未达到终态；``missing`` 列出
    判定该前置所缺少的记录身份（例如 ``tasks:<task_id>``）。``recorded_status``
    只用于如实展示，绝不参与判定。
    """

    task_id: str
    terminal: TerminalState | None = None
    recorded_status: str = ""
    evidence: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.task_id.strip():
            raise DependencyFactsError("前置任务必须给出任务身份")
        if self.terminal is not None and self.terminal not in TERMINAL_STATES:
            raise DependencyFactsError(f"未知的终态取值: {self.terminal!r}")

    @property
    def terminal_reached(self) -> bool:
        """前置是否已在权威记录中达到终态。"""

        return self.terminal is not None


@dataclass(frozen=True)
class DependencyFacts:
    """一个任务的依赖事实与阻塞判定结果。"""

    task_id: str
    verdict: DependencyVerdict
    unmet_prerequisites: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()
    outstanding_action: str | None = None
    missing_evidence: tuple[str, ...] = ()
    recorded_status: str = ""
    failure_rounds: int = 0

    @property
    def has_outstanding_action(self) -> bool:
        """是否存在 ``started`` 未完成动作。"""

        return self.outstanding_action is not None

    @property
    def is_ready(self) -> bool:
        return self.verdict is DependencyVerdict.READY

    @property
    def is_waiting(self) -> bool:
        """是否真实等待：有未满足前置且无未完成动作，且依据齐全。"""

        return self.verdict is DependencyVerdict.WAITING

    @property
    def is_running(self) -> bool:
        return self.verdict is DependencyVerdict.RUNNING

    @property
    def is_unknown(self) -> bool:
        return self.verdict is DependencyVerdict.UNKNOWN


def assess_dependency(
    task_id: str,
    prerequisites: Sequence[PrerequisiteFact] = (),
    *,
    outstanding_action: str | None = None,
    subject_evidence: Sequence[str] = (),
    missing_evidence: Sequence[str] = (),
    recorded_status: str = "",
    failure_rounds: int = 0,
) -> DependencyFacts:
    """由权威事实判定一个任务是否需要真实等待（纯函数）。

    判定优先级（与「依据缺失不猜测」一致）：

    1. 缺少依据（前置记录缺失）→ ``unknown``，并列出缺少的记录；
    2. 存在未完成 ``started`` 动作 → ``running``；
    3. 存在未满足前置且无未完成动作 → ``waiting``；
    4. 前置全部满足 → ``ready``。

    ``recorded_status`` 与 ``failure_rounds`` 只随结果如实返回，不参与判定，
    因此状态滞后或历史失败都不会把「前置已满足」误判为阻塞。
    """

    if not task_id.strip():
        raise DependencyFactsError("任务身份不能为空")
    if failure_rounds < 0:
        raise DependencyFactsError("失败轮次数不能为负")

    unmet = tuple(item.task_id for item in prerequisites if not item.terminal_reached)
    missing: list[str] = list(missing_evidence)
    for item in prerequisites:
        missing.extend(item.missing)

    evidence: list[str] = list(subject_evidence)
    for item in prerequisites:
        evidence.extend(item.evidence)
    if outstanding_action is not None:
        evidence.append(f"actions:{outstanding_action}")

    missing_records = _unique(missing)
    if missing_records:
        verdict = DependencyVerdict.UNKNOWN
    elif outstanding_action is not None:
        verdict = DependencyVerdict.RUNNING
    elif unmet:
        verdict = DependencyVerdict.WAITING
    else:
        verdict = DependencyVerdict.READY

    return DependencyFacts(
        task_id=task_id,
        verdict=verdict,
        unmet_prerequisites=unmet,
        evidence=_unique(evidence),
        outstanding_action=outstanding_action,
        missing_evidence=missing_records,
        recorded_status=recorded_status,
        failure_rounds=failure_rounds,
    )
