"""main 受控归并规则（B04）：未经验收不更新，漂移后拒绝。

规则来源（待实现列表 B04 验收要求）：
- 绑定已验收基线与 diff：只有已交付（验收批准已消费）且基线已固化的任务可归并。
- main 漂移后核对、重新验证：目标 main 当前 HEAD 必须等于交付时记录的基线提交，
  否则拒绝并要求重新执行任务（受控流程不做差异拼接后沿用旧批准）。
- 未经验收不更新：任务未到 delivered 状态一律拒绝。
- 不强制 PR：受控命令直接在 main 上生成合并提交。
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class MergeDecision:
    allowed: bool
    reason: str


def check_merge_readiness(
    task_status: str,
    acceptance_recorded: bool,
    baseline_commit: str,
    main_head: str,
    diff_text: str,
) -> MergeDecision:
    """归并前的纯规则判定；全部通过才允许更新 main。"""

    if task_status != "delivered":
        return MergeDecision(
            False, f"任务未验收交付（当前状态 {task_status}）；未经验收不更新 main"
        )
    if not acceptance_recorded:
        return MergeDecision(False, "缺少验收批准记录；未经验收不更新 main")
    if not baseline_commit:
        return MergeDecision(False, "交付未固化基线提交号（非 git 工作副本任务不能归并）")
    if not diff_text.strip():
        return MergeDecision(False, "候选 diff 为空；没有可归并的改动")
    if main_head != baseline_commit:
        return MergeDecision(
            False,
            f"main 已漂移：交付基线 {baseline_commit[:12]}，当前 {main_head[:12]}；"
            "须核对差异后重新执行任务",
        )
    return MergeDecision(True, "已验收交付且 main 未漂移")
