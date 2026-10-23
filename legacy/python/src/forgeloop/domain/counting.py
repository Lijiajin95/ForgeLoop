"""研发失败轮次与自动处理授权：纯领域规则。

规则来源（首版需求 V0-06 与领域术语）：
- 正式转测后，一轮候选结果在测试或用户验收中失败计一个失败轮次；
  转测前的实现、自验证、审查失败不在此计数。
- 同一轮的重复反馈不重复加数（按轮次标识幂等）。
- 每次自动处理授权允许最多三个失败轮次；初始授权累计 1-3，
  追加授权 1 为 4-6，再追加为 7-9；累计不清零，历次授权记录保留。
- 额度用尽后停止自动推进，等待追加授权或其他决定；
  新的授权不自动延长已耗尽的工时（工时见 limits 模块）。

持久化由 records 层负责；本模块只维护不可变事实的内存视图。
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

MAX_ROUNDS_PER_GRANT = 3


class FailureStage(StrEnum):
    """计入研发失败轮次的失败来源。"""

    FORMAL_TEST = "formal_test"
    USER_ACCEPTANCE = "user_acceptance"


@dataclass(frozen=True)
class FailureRound:
    """一个已计入的失败轮次。

    round_id 标识一轮正式候选：同一轮内多个失败用例或重复反馈
    使用相同 round_id，不重复计数。
    """

    round_id: str
    stage: FailureStage
    summary: str
    occurred_at: datetime


class GrantExhaustedError(RuntimeError):
    """本次授权的失败轮次额度已用尽，需要追加授权或其他决定。"""


@dataclass(frozen=True)
class RecordOutcome:
    recorded: bool
    cumulative_failures: int


class GrantLedger:
    """失败轮次账本与追加授权计数。"""

    def __init__(
        self,
        grants: int = 1,
        rounds: tuple[FailureRound, ...] = (),
    ) -> None:
        if grants < 1:
            raise ValueError("At least one initial grant is required")
        if len(rounds) > grants * MAX_ROUNDS_PER_GRANT:
            raise ValueError("Recorded failures exceed the granted quota")
        self._grants = grants
        self._rounds = tuple(rounds)
        self._seen_round_ids = {round_.round_id for round_ in self._rounds}

    @property
    def grant_count(self) -> int:
        return self._grants

    @property
    def cumulative_failures(self) -> int:
        return len(self._rounds)

    @property
    def rounds(self) -> tuple[FailureRound, ...]:
        return self._rounds

    @property
    def consumed_in_current_grant(self) -> int:
        return self.cumulative_failures - (self._grants - 1) * MAX_ROUNDS_PER_GRANT

    @property
    def remaining_in_current_grant(self) -> int:
        return max(0, self._grants * MAX_ROUNDS_PER_GRANT - self.cumulative_failures)

    @property
    def can_record_failure(self) -> bool:
        return self.remaining_in_current_grant > 0

    @property
    def awaiting_grant_decision(self) -> bool:
        """额度用尽：自动推进停止，等待追加授权或停止决定。"""

        return self.remaining_in_current_grant == 0

    def record_failure(
        self,
        round_id: str,
        stage: FailureStage,
        summary: str,
        occurred_at: datetime,
    ) -> RecordOutcome:
        """计入一个失败轮次；同 round_id 重复反馈不加数。"""

        if round_id in self._seen_round_ids:
            return RecordOutcome(False, self.cumulative_failures)
        if not self.can_record_failure:
            raise GrantExhaustedError("本次授权的三个失败轮次已用尽；追加授权后才能继续记录")
        self._rounds = (*self._rounds, FailureRound(round_id, stage, summary, occurred_at))
        self._seen_round_ids.add(round_id)
        return RecordOutcome(True, self.cumulative_failures)

    def append_grant(self) -> None:
        """用户明确追加一次授权：额度 +3，累计失败与历史保留，不清零。"""

        self._grants += 1
