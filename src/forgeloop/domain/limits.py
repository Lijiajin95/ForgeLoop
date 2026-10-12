"""任务执行时间限额：默认两小时，用户等待不计入。

规则来源（首版需求 V0-09）：
- 默认任务执行限额两小时，可在执行前配置。
- 超限停止启动新动作并报告；支持请求停止。
- 用户等待不计入实际执行时间（由调用方只对执行段计时后 charge）。
- 新的失败授权不自动延长耗尽的工时；超时后先决定延长或拆分。
"""

from dataclasses import dataclass

DEFAULT_LIMIT_SECONDS = 7200.0


@dataclass
class ExecutionBudget:
    """执行时间账目：只记录实际执行耗时，等待时间由调用方排除。"""

    limit_seconds: float
    consumed_seconds: float = 0.0

    def __post_init__(self) -> None:
        if self.limit_seconds <= 0:
            raise ValueError("Execution limit must be positive")
        if self.consumed_seconds < 0:
            raise ValueError("Consumed time cannot be negative")

    @property
    def remaining_seconds(self) -> float:
        return max(0.0, self.limit_seconds - self.consumed_seconds)

    @property
    def exhausted(self) -> bool:
        return self.consumed_seconds >= self.limit_seconds

    def can_start_action(self) -> bool:
        """超限后停止启动新动作；已开始的动作自然完成并保存结果。"""

        return not self.exhausted

    def charge(self, seconds: float) -> None:
        """记录一段实际执行耗时（用户等待不计入）。"""

        if seconds < 0:
            raise ValueError("Charged duration cannot be negative")
        self.consumed_seconds += seconds

    def extend(self, new_limit_seconds: float) -> None:
        """超时后的显式决定：延长限额；消耗不清零。"""

        if new_limit_seconds <= self.consumed_seconds:
            raise ValueError("Extended limit must exceed the already consumed time")
        self.limit_seconds = new_limit_seconds
