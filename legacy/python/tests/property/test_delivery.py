"""交付绑定领域规则的属性测试（B04）。

不变量：
- 内容寻址：同一材料文本产生同一校验值与同一绑定指纹；替换任一材料或基线后
  原批准失效，并明确指出变化的字段。
- 需求整体验收：全部任务已验收且当前材料与批准一致才允许；任一任务未验收、
  缺当前材料或材料已变化一律拒绝。
"""

from hypothesis import assume, given
from hypothesis import strategies as st

from forgeloop.domain.delivery import (
    RequirementDelivery,
    TaskDelivery,
    assess_requirement_acceptance,
    build_binding,
    sha256_of_text,
    verify_binding,
)

texts = st.text(max_size=200)
digests = st.text(alphabet="0123456789abcdef", min_size=64, max_size=64)
baselines = st.text(alphabet="0123456789abcdef", min_size=0, max_size=40)


def make_binding(
    task_id: str,
    *,
    candidate: str = "diff",
    evidence: str = "evidence",
    review: str = "review",
    artifact: str = "",
    baseline: str = "",
):
    return build_binding(
        task_id,
        1,
        candidate_text=candidate,
        test_evidence_text=evidence,
        review_text=review,
        artifact_sha256=artifact,
        baseline_commit=baseline,
    )


@given(texts)
def test_sha256_is_deterministic(text: str) -> None:
    assert sha256_of_text(text) == sha256_of_text(text)


@given(candidate=texts, evidence=texts, review=texts)
def test_identical_material_gives_identical_binding(
    candidate: str, evidence: str, review: str
) -> None:
    first = make_binding("task-1", candidate=candidate, evidence=evidence, review=review)
    second = make_binding("task-1", candidate=candidate, evidence=evidence, review=review)
    assert first == second
    assert first.fingerprint == second.fingerprint
    assert verify_binding(first, second).valid


@given(candidate=texts, evidence=texts, review=texts)
def test_replaced_candidate_invalidates_binding(candidate: str, evidence: str, review: str) -> None:
    approved = make_binding("task-1", candidate=candidate, evidence=evidence, review=review)
    current = make_binding("task-1", candidate=candidate + "x", evidence=evidence, review=review)
    decision = verify_binding(approved, current)
    assert not decision.valid
    assert "candidate_sha256" in decision.changed


@given(candidate=texts, evidence=texts, review=texts)
def test_replaced_evidence_invalidates_binding(candidate: str, evidence: str, review: str) -> None:
    approved = make_binding("task-1", candidate=candidate, evidence=evidence, review=review)
    current = make_binding("task-1", candidate=candidate, evidence=evidence + "x", review=review)
    decision = verify_binding(approved, current)
    assert not decision.valid
    assert "test_evidence_sha256" in decision.changed


@given(candidate=texts, evidence=texts, review=texts, artifact=digests, other=digests)
def test_replaced_artifact_invalidates_binding(
    candidate: str, evidence: str, review: str, artifact: str, other: str
) -> None:
    assume(artifact != other)
    approved = make_binding(
        "task-1", candidate=candidate, evidence=evidence, review=review, artifact=artifact
    )
    current = make_binding(
        "task-1", candidate=candidate, evidence=evidence, review=review, artifact=other
    )
    decision = verify_binding(approved, current)
    assert not decision.valid
    assert "artifact_sha256" in decision.changed


@given(candidate=texts, evidence=texts, review=texts, baseline=baselines, other=baselines)
def test_replaced_baseline_invalidates_binding(
    candidate: str, evidence: str, review: str, baseline: str, other: str
) -> None:
    assume(baseline != other)
    approved = make_binding(
        "task-1", candidate=candidate, evidence=evidence, review=review, baseline=baseline
    )
    current = make_binding(
        "task-1", candidate=candidate, evidence=evidence, review=review, baseline=other
    )
    decision = verify_binding(approved, current)
    assert not decision.valid
    assert "baseline_commit" in decision.changed


@given(st.lists(st.integers(min_value=0, max_value=10**6), min_size=1, max_size=5, unique=True))
def test_overall_acceptance_requires_every_task(task_numbers: list[int]) -> None:
    deliveries = tuple(
        TaskDelivery(
            make_binding(
                f"task-{number}",
                candidate=f"diff-{number}",
                evidence=f"evidence-{number}",
                review=f"review-{number}",
            ),
            accepted=True,
        )
        for number in task_numbers
    )
    requirement = RequirementDelivery("req-1", deliveries)
    current = {delivery.binding.task_id: delivery.binding for delivery in deliveries}
    assert assess_requirement_acceptance(requirement, current_bindings=current).allowed

    # 任何一个任务未验收：整体验收被拒绝，且该任务出现在未满足清单。
    for index in range(len(deliveries)):
        pending = tuple(
            TaskDelivery(delivery.binding, accepted=False) if position == index else delivery
            for position, delivery in enumerate(deliveries)
        )
        decision = assess_requirement_acceptance(RequirementDelivery("req-1", pending))
        assert not decision.allowed
        assert decision.pending_tasks == (deliveries[index].binding.task_id,)


@given(st.lists(st.integers(min_value=0, max_value=10**6), min_size=1, max_size=5, unique=True))
def test_overall_acceptance_rejects_drifted_material(task_numbers: list[int]) -> None:
    deliveries = tuple(
        TaskDelivery(
            make_binding(
                f"task-{number}",
                candidate=f"diff-{number}",
                evidence=f"evidence-{number}",
                review=f"review-{number}",
            ),
            accepted=True,
        )
        for number in task_numbers
    )
    requirement = RequirementDelivery("req-1", deliveries)
    drifted = {
        delivery.binding.task_id: make_binding(
            delivery.binding.task_id, candidate="drifted-candidate"
        )
        for delivery in deliveries
    }
    decision = assess_requirement_acceptance(requirement, current_bindings=drifted)
    assert not decision.allowed
