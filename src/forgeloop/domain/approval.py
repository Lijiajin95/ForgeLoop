"""方案与执行前批准：批准绑定任务身份与方案版本。

规则来源（首版需求 V0-02 与第 3 节）：
- 第一次批准同时确认目标、边界、验收标准、技术方案与正式测试命令；
  第二次确认实际小场景及交付证据。
- 正式批准绑定任务身份和方案版本；重复或旧版本决定不能重复执行。
"""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class ApprovalStage(StrEnum):
    """两次本地批准：方案（范围+方案+测试命令）与整体验收。"""

    PLAN = "plan"
    ACCEPTANCE = "acceptance"


@dataclass(frozen=True)
class Plan:
    """一份可批准的方案快照（范围与方案分别记录，一次批准完成）。"""

    task_id: str
    version: int
    goal: str
    scope: str
    acceptance: str
    test_command: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.version < 1:
            raise ValueError("Plan version must be positive")
        if not self.test_command:
            raise ValueError("A plan requires the approved formal test command")


@dataclass(frozen=True)
class Approval:
    task_id: str
    plan_version: int
    stage: ApprovalStage
    decided_at: datetime


class ConsumeStatus(StrEnum):
    OK = "ok"
    MISSING = "missing"
    STALE = "stale"
    ALREADY_USED = "already_used"


@dataclass(frozen=True)
class ConsumeResult:
    status: ConsumeStatus
    approval: Approval | None = None
    reason: str = ""


class ApprovalBook:
    """批准记录簿：记录批准、校验执行前绑定、拒绝重复或旧版本执行。"""

    def __init__(self, approvals: tuple[Approval, ...] = ()) -> None:
        self._recorded: dict[tuple[str, ApprovalStage], Approval] = {}
        self._consumed: set[tuple[str, int, ApprovalStage]] = set()
        for approval in approvals:
            key = (approval.task_id, approval.stage)
            current = self._recorded.get(key)
            if current is None or approval.plan_version >= current.plan_version:
                self._recorded[key] = approval

    def mark_consumed(self, task_id: str, plan_version: int, stage: ApprovalStage) -> None:
        """从持久化重建消费状态；不改变已记录的批准。"""

        self._consumed.add((task_id, plan_version, stage))

    def record(self, approval: Approval) -> None:
        """记录一次批准；同阶段再次记录时以更新版本为准。"""

        key = (approval.task_id, approval.stage)
        current = self._recorded.get(key)
        if current is not None and approval.plan_version < current.plan_version:
            raise ValueError("Cannot record an approval older than the effective one")
        self._recorded[key] = approval

    def effective(self, task_id: str, stage: ApprovalStage) -> Approval | None:
        return self._recorded.get((task_id, stage))

    def consume(self, task_id: str, plan_version: int, stage: ApprovalStage) -> ConsumeResult:
        """执行前消费批准：一次批准只允许触发一次执行。"""

        approval = self._recorded.get((task_id, stage))
        if approval is None:
            return ConsumeResult(
                ConsumeStatus.MISSING, None, "未找到该阶段的批准；未批准不开始执行"
            )
        if plan_version != approval.plan_version:
            return ConsumeResult(
                ConsumeStatus.STALE,
                approval,
                f"方案版本 {plan_version} 不是生效版本 {approval.plan_version}；旧版本决定不能重复执行",
            )
        key = (task_id, plan_version, stage)
        if key in self._consumed:
            return ConsumeResult(
                ConsumeStatus.ALREADY_USED,
                approval,
                "该批准已触发过执行；重复决定不能重复执行",
            )
        self._consumed.add(key)
        return ConsumeResult(ConsumeStatus.OK, approval)
