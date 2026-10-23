"""main 受控归并规则（B04）：未经验收不更新，漂移后拒绝。

规则来源（待实现列表 B04 验收要求）：
- 绑定已验收基线与 diff：只有已交付（验收批准已消费）且基线已固化的任务可归并。
- main 漂移后核对、重新验证：目标 main 当前 HEAD 必须等于交付时记录的基线提交，
  否则拒绝并要求重新执行任务（受控流程不做差异拼接后沿用旧批准）。
- 未经验收不更新：任务未到 delivered 状态一律拒绝。
- 不强制 PR：受控命令直接在 main 上生成合并提交。

S3 候选分支流程（所有者 2026-10-13 选定方案 B）追加的规则：
- 必需检查判定是纯规则：只有全部必需检查以成功/中立/跳过结束才允许快进 main；
  未完成的检查算"待继续等待"，失败/取消/超时算"失败且不再等待"。
- 候选分支名由任务身份派生，便于回查且不会与人工分支混淆。
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from forgeloop.domain.delivery import DeliveryBinding, verify_binding

SUCCESS_CONCLUSIONS = ("success", "neutral", "skipped")
FAILURE_CONCLUSIONS = (
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
)
PENDING_CONCLUSION = "pending"
# 已知结论之外一律判为未知：未知检查状态不放行（K11），也不当成失败去重试。
KNOWN_CONCLUSIONS = (*SUCCESS_CONCLUSIONS, *FAILURE_CONCLUSIONS, PENDING_CONCLUSION)
CANDIDATE_BRANCH_PREFIX = "forgeloop/"


@dataclass(frozen=True)
class MergeDecision:
    allowed: bool
    reason: str


@dataclass(frozen=True)
class ChecksDecision:
    """必需检查判定：是否通过、是否还应继续等待，以及可回查的原因。"""

    passed: bool
    pending: bool
    reason: str


def candidate_branch_name(task_id: str) -> str:
    """候选分支名：由任务身份派生（``forgeloop/<task_id>``）。"""

    return f"{CANDIDATE_BRANCH_PREFIX}{task_id}"


def check_required_checks(required: Sequence[str], runs: Mapping[str, str]) -> ChecksDecision:
    """判定必需检查状态；``runs`` 是"检查名 → 最新结论"，未完成的记为 pending。"""

    if not required:
        return ChecksDecision(True, False, "未要求必需检查")
    unknown = sorted(
        name for name in required if name in runs and runs[name] not in KNOWN_CONCLUSIONS
    )
    if unknown:
        return ChecksDecision(
            False,
            False,
            f"必需检查状态未知：{', '.join(unknown)}；未知状态不放行",
        )
    failed = sorted(name for name in required if runs.get(name) in FAILURE_CONCLUSIONS)
    if failed:
        return ChecksDecision(False, False, f"必需检查未通过：{', '.join(failed)}")
    waiting = sorted(
        name for name in required if name not in runs or runs.get(name) == PENDING_CONCLUSION
    )
    if waiting:
        return ChecksDecision(False, True, f"必需检查尚未完成：{', '.join(waiting)}")
    return ChecksDecision(True, False, "全部必需检查已通过")


def check_acceptance_content(approved: DeliveryBinding, current: DeliveryBinding) -> MergeDecision:
    """核对当前交付材料是否仍是验收批准时的那一份（K11 同一候选）。

    候选 diff 被替换、正式测试证据变化、审查结论变化或交付基线改变都判为内容漂移，
    拒绝沿用原验收。产物校验值在验收时可能尚未生成，归并阶段不据它判漂移。
    """

    decision = verify_binding(
        replace(approved, artifact_sha256=""),
        replace(current, artifact_sha256=""),
    )
    if not decision.valid:
        return MergeDecision(False, f"验收内容已漂移：{decision.reason}")
    return MergeDecision(True, "交付材料与验收批准一致")


def check_merge_readiness(
    task_status: str,
    acceptance_recorded: bool,
    diff_text: str,
    *,
    materials_unchanged: bool,
    applies_cleanly: bool,
) -> MergeDecision:
    """归并前的纯规则判定；全部通过才允许更新 main。

    2026-10-18 所有者决定的关联模型：任务与 commit 是**一对多的累积关系**，不再要求
    ``main HEAD == 交付基线``——代码先提交、任务后验收，或验收不通过继续改（关联多个
    commit）都属于正常情形，不该判成漂移。取而代之的两条判定是：

    1. **验收材料未变**：候选 diff、测试证据与审查结论仍与验收批准时绑定的那一份一致
       （由 :func:`check_acceptance_content` 得出，调用方传入结论）；
    2. **候选可干净应用**：改动能直接应用到当前 main（由适配层 ``git apply --check``
       得出，调用方传入结论）；冲突必须人工解决并留痕，不做自动拼接。

    不放松的仍然是：未验收交付、缺少验收批准、候选为空、材料漂移、应用不干净。
    """

    if task_status != "delivered":
        return MergeDecision(
            False, f"任务未验收交付（当前状态 {task_status}）；未经验收不更新 main"
        )
    if not acceptance_recorded:
        return MergeDecision(False, "缺少验收批准记录；未经验收不更新 main")
    if not diff_text.strip():
        return MergeDecision(False, "候选 diff 为空；没有可归并的改动")
    if not materials_unchanged:
        return MergeDecision(False, "验收材料已漂移；拒绝沿用原验收归并")
    if not applies_cleanly:
        return MergeDecision(
            False,
            "候选改动不能干净应用到当前 main：请人工解决冲突、保留冲突处理过程后再归并",
        )
    return MergeDecision(True, "验收材料未变且候选可干净应用")
