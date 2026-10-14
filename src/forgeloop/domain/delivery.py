"""验收交付绑定领域规则（B04）：不可变候选、测试证据、审查与产物身份。

规则来源（DogFood 交接约定 §7、执行计划 B04）：
- 代码验收先绑定不可变候选与测试证据：候选 diff、正式测试证据、独立审查结论
  各自用内容寻址 sha256 固化，产物存在时再绑定产物校验值。
- 批准后材料变化使决定失效：替换 diff、测试或产物后，原批准不能再被沿用。
- 单个任务通过不自动等于需求整体验收：需求整体验收要求需求下全部任务都已验收，
  且每个任务绑定的材料仍与当前一致；缺产物身份时不整体验收。
- 本模块是纯规则：不做任何 IO，文件内容由调用方在边界读取后传入。
"""

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass

DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DeliveryError(ValueError):
    """违反交付绑定或需求整体验收规则。"""


def sha256_of_text(text: str) -> str:
    """交付材料的内容寻址校验值；与发布/部署端同一算法。"""

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _require_digest(value: str, field_name: str) -> None:
    if not DIGEST_PATTERN.match(value):
        raise DeliveryError(f"{field_name}校验值缺失或格式错误（须为 64 位十六进制小写）")


@dataclass(frozen=True)
class DeliveryBinding:
    """一次任务交付的不可变材料身份。

    ``task_id`` 与 ``plan_version`` 绑定批准对象；四个校验值绑定实际材料。
    产物在校验值未取得时允许为空，但需求整体验收要求全部任务都有产物身份。
    """

    task_id: str
    plan_version: int
    candidate_sha256: str
    test_evidence_sha256: str
    review_sha256: str
    artifact_sha256: str = ""
    baseline_commit: str = ""

    def __post_init__(self) -> None:
        if not self.task_id:
            raise DeliveryError("交付绑定缺少任务身份")
        if self.plan_version < 1:
            raise DeliveryError("交付绑定必须绑定一个正的方案版本")
        _require_digest(self.candidate_sha256, "候选 diff ")
        _require_digest(self.test_evidence_sha256, "正式测试证据 ")
        _require_digest(self.review_sha256, "独立审查结论 ")
        if self.artifact_sha256:
            _require_digest(self.artifact_sha256, "候选产物 ")

    @property
    def has_artifact(self) -> bool:
        """是否已经绑定候选产物校验值（C01 交接后才具备）。"""

        return bool(self.artifact_sha256)

    @property
    def fingerprint(self) -> str:
        """全部材料字段的稳定指纹；用于回查与去重，不替代逐字段核对。"""

        payload = "\n".join(
            (
                self.task_id,
                str(self.plan_version),
                self.candidate_sha256,
                self.test_evidence_sha256,
                self.review_sha256,
                self.artifact_sha256,
                self.baseline_commit,
            )
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_binding(
    task_id: str,
    plan_version: int,
    *,
    candidate_text: str,
    test_evidence_text: str,
    review_text: str,
    artifact_sha256: str = "",
    baseline_commit: str = "",
) -> DeliveryBinding:
    """由边界读到的材料内容构造绑定；不读取文件，也不猜测缺省值。"""

    return DeliveryBinding(
        task_id=task_id,
        plan_version=plan_version,
        candidate_sha256=sha256_of_text(candidate_text),
        test_evidence_sha256=sha256_of_text(test_evidence_text),
        review_sha256=sha256_of_text(review_text),
        artifact_sha256=artifact_sha256,
        baseline_commit=baseline_commit,
    )


_MATERIAL_FIELDS = (
    "candidate_sha256",
    "test_evidence_sha256",
    "review_sha256",
    "artifact_sha256",
    "baseline_commit",
)
_MATERIAL_LABELS = {
    "candidate_sha256": "候选 diff",
    "test_evidence_sha256": "正式测试证据",
    "review_sha256": "独立审查结论",
    "artifact_sha256": "候选产物",
    "baseline_commit": "交付基线",
}


@dataclass(frozen=True)
class BindingDecision:
    """批准材料与实际材料的一致性判定；``changed`` 列出变化的字段。"""

    valid: bool
    reason: str
    changed: tuple[str, ...] = ()


def verify_binding(approved: DeliveryBinding, current: DeliveryBinding) -> BindingDecision:
    """核对当前材料是否仍是批准时的那一份；任何字段变化都判为失效。"""

    if approved.task_id != current.task_id:
        return BindingDecision(False, "批准绑定的任务与当前任务不一致；不能沿用原批准")
    if approved.plan_version != current.plan_version:
        return BindingDecision(
            False,
            f"方案版本已变化（批准 {approved.plan_version} → 当前 {current.plan_version}）；"
            "不能沿用原批准",
        )
    changed = tuple(
        name for name in _MATERIAL_FIELDS if getattr(approved, name) != getattr(current, name)
    )
    if changed:
        labels = "、".join(_MATERIAL_LABELS[name] for name in changed)
        return BindingDecision(False, f"批准后交付材料已变化：{labels}；不能沿用原批准", changed)
    return BindingDecision(True, f"交付材料与批准一致：{approved.fingerprint[:12]}")


@dataclass(frozen=True)
class TaskDelivery:
    """一个任务的交付绑定与验收状态；``accepted`` 表示该任务验收批准已消费。"""

    binding: DeliveryBinding
    accepted: bool = False


@dataclass(frozen=True)
class RequirementDelivery:
    """一条需求下全部任务的交付汇总；用于需求整体验收判定。"""

    requirement_id: str
    deliveries: tuple[TaskDelivery, ...] = ()

    def with_task(self, delivery: TaskDelivery) -> "RequirementDelivery":
        return RequirementDelivery(self.requirement_id, (*self.deliveries, delivery))

    @property
    def task_ids(self) -> tuple[str, ...]:
        return tuple(delivery.binding.task_id for delivery in self.deliveries)

    @property
    def pending_tasks(self) -> tuple[str, ...]:
        return tuple(
            delivery.binding.task_id for delivery in self.deliveries if not delivery.accepted
        )

    @property
    def all_accepted(self) -> bool:
        return bool(self.deliveries) and not self.pending_tasks


@dataclass(frozen=True)
class RequirementDecision:
    """需求整体验收判定：是否允许，以及未满足的任务与原因。"""

    allowed: bool
    reason: str
    pending_tasks: tuple[str, ...] = ()


def assess_requirement_acceptance(
    requirement: RequirementDelivery,
    *,
    current_bindings: Mapping[str, DeliveryBinding] | None = None,
    require_artifacts: bool = False,
) -> RequirementDecision:
    """判定需求整体验收；单个任务通过不自动等于需求整体验收。

    ``current_bindings`` 给出各任务当前材料身份时，还会逐个核对材料是否仍是
    批准时的那一份；任务未验收、缺产物或材料变化一律拒绝整体验收。
    """

    if not requirement.requirement_id:
        return RequirementDecision(False, "需求整体验收缺少需求身份")
    if not requirement.deliveries:
        return RequirementDecision(False, "需求没有任务交付记录；不构成需求整体验收")
    task_ids = requirement.task_ids
    if len(set(task_ids)) != len(task_ids):
        return RequirementDecision(False, "需求交付记录存在重复任务；不能据此整体验收")

    pending = requirement.pending_tasks
    if pending:
        return RequirementDecision(
            False,
            "存在未验收任务：" + "、".join(pending) + "；单个任务通过不自动等于需求整体验收",
            pending,
        )

    if require_artifacts:
        missing = tuple(
            delivery.binding.task_id
            for delivery in requirement.deliveries
            if not delivery.binding.has_artifact
        )
        if missing:
            return RequirementDecision(
                False,
                "存在缺少候选产物身份的任务：" + "、".join(missing) + "；产物未绑定不整体验收",
                missing,
            )

    if current_bindings is not None:
        for delivery in requirement.deliveries:
            current = current_bindings.get(delivery.binding.task_id)
            if current is None:
                return RequirementDecision(
                    False,
                    f"任务 {delivery.binding.task_id} 缺少当前材料身份；不能整体验收",
                    (delivery.binding.task_id,),
                )
            decision = verify_binding(delivery.binding, current)
            if not decision.valid:
                return RequirementDecision(
                    False,
                    f"任务 {delivery.binding.task_id} 的{decision.reason}",
                    (delivery.binding.task_id,),
                )

    return RequirementDecision(
        True, f"需求 {requirement.requirement_id} 的 {len(task_ids)} 个任务全部验收且材料一致"
    )
