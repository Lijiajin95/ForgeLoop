"""阻断原因推导（``blocked_reason_text``）的单元测试（status-reason-domain）。

覆盖验收要求：全部 10 个场景（三类人工决定、依赖未满足、失败轮次用尽、运行中、
已终态、多条件并存的优先级与补充句、依据缺失输出 unknown、正常推进不留空）、
多条同时成立时的优先级/补充规则，以及只读事实、不改既有字段语义。
"""

from dataclasses import FrozenInstanceError

import pytest

from forgeloop.domain.dependency_facts import TerminalState
from forgeloop.domain.status_reason import (
    ReasonCondition,
    StatusReason,
    StatusReasonError,
    TaskFacts,
    active_conditions,
    blocked_reason_text,
    derive_status_reason,
)

# 期望的固定优先级：越靠前越优先。
PRIORITY = (
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


def facts(task_id: str = "t1", **overrides: object) -> TaskFacts:
    return TaskFacts(task_id=task_id, **overrides)  # type: ignore[arg-type]


class TestScenario1AwaitingPlanApproval:
    """① 等待人工决定：方案批准。"""

    def test_plan_without_approval_waits_for_plan_approval(self) -> None:
        result = derive_status_reason(facts(plan_version=1, plan_approval_version=None))
        assert result.main_condition is ReasonCondition.AWAITING_PLAN_APPROVAL
        assert result.blocked_reason_text == "等待人工批准方案（范围、方案、验收标准与测试命令）"

    def test_stale_approval_version_waits_for_new_plan(self) -> None:
        result = derive_status_reason(facts(plan_version=2, plan_approval_version=1))
        assert result.main_condition is ReasonCondition.AWAITING_PLAN_APPROVAL

    def test_status_word_is_fallback_when_plan_record_absent(self) -> None:
        result = derive_status_reason(facts(status="awaiting_plan_approval"))
        assert result.main_condition is ReasonCondition.AWAITING_PLAN_APPROVAL

    def test_authoritative_approval_beats_stale_status(self) -> None:
        """方案已按当前版本批准时，不因状态词滞后而误报等待批准。"""

        result = derive_status_reason(
            facts(status="awaiting_plan_approval", plan_version=1, plan_approval_version=1)
        )
        assert ReasonCondition.AWAITING_PLAN_APPROVAL not in result.active_conditions


class TestScenario2AwaitingGrant:
    """① 等待人工决定：追加授权（显式记录）。"""

    def test_awaiting_grant_status_waits_for_grant_decision(self) -> None:
        result = derive_status_reason(
            facts(status="awaiting_grant", failure_rounds=3, grant_count=1)
        )
        assert result.main_condition is ReasonCondition.AWAITING_GRANT
        assert result.blocked_reason_text == (
            "等待人工决定是否追加失败轮次授权；另外还有失败轮次用尽（已用 3 轮，上限 3 轮）"
        )

    def test_priority_1_outranks_grant_exhausted(self) -> None:
        """① 优先于 ③：同时成立时主句取等待人工决定。"""

        result = derive_status_reason(
            facts(status="awaiting_grant", failure_rounds=3, grant_count=1)
        )
        assert result.supplements == (ReasonCondition.GRANT_EXHAUSTED,)


class TestScenario3AwaitingAcceptance:
    """① 等待人工决定：整体验收。"""

    def test_tested_waits_for_acceptance(self) -> None:
        result = derive_status_reason(
            facts(
                status="tested",
                plan_version=1,
                plan_approval_version=1,
                acceptance_approval_version=None,
            )
        )
        assert result.main_condition is ReasonCondition.AWAITING_ACCEPTANCE
        assert result.blocked_reason_text == "等待人工整体验收（核对 diff、审查与测试证据）"

    def test_recorded_acceptance_approval_is_not_waiting(self) -> None:
        result = derive_status_reason(
            facts(
                status="tested",
                plan_version=1,
                plan_approval_version=1,
                acceptance_approval_version=1,
            )
        )
        assert ReasonCondition.AWAITING_ACCEPTANCE not in result.active_conditions

    def test_terminal_beats_stale_acceptance_status(self) -> None:
        result = derive_status_reason(
            facts(status="awaiting_acceptance", terminal=TerminalState.ACCEPTED)
        )
        assert result.main_condition is ReasonCondition.TERMINAL
        assert "accepted" in result.blocked_reason_text


class TestScenario4DependencyUnmet:
    """② 依赖未满足。"""

    def test_unmet_prerequisites_give_main_clause_with_ids(self) -> None:
        result = derive_status_reason(facts(unmet_prerequisites=("a", "b")))
        assert result.main_condition is ReasonCondition.DEPENDENCY_UNMET
        assert result.blocked_reason_text == "前置任务未满足，等待依赖完成：a、b"


class TestScenario5GrantExhausted:
    """③ 失败轮次用尽等待追加授权（由记录推导，不依赖状态词）。"""

    def test_exhausted_quota_is_main_even_when_status_is_stale(self) -> None:
        result = derive_status_reason(facts(status="fixing", failure_rounds=3, grant_count=1))
        assert result.main_condition is ReasonCondition.GRANT_EXHAUSTED
        assert result.blocked_reason_text == (
            "失败轮次额度已用尽（已用 3 轮，上限 3 轮），等待人工追加授权"
        )

    def test_exhausted_clause_reports_used_and_limit(self) -> None:
        """验收标准 6：同时给出已用失败轮次与轮次上限。"""

        result = derive_status_reason(facts(failure_rounds=6, grant_count=2))
        assert result.main_condition is ReasonCondition.GRANT_EXHAUSTED
        assert "已用 6 轮" in result.blocked_reason_text
        assert "上限 6 轮" in result.blocked_reason_text

    def test_limit_is_grant_count_times_max_rounds_per_grant(self) -> None:
        result = derive_status_reason(facts(failure_rounds=9, grant_count=3))
        assert result.blocked_reason_text == (
            "失败轮次额度已用尽（已用 9 轮，上限 9 轮），等待人工追加授权"
        )

    def test_appended_grant_restores_capacity(self) -> None:
        result = derive_status_reason(facts(status="fixing", failure_rounds=3, grant_count=2))
        assert ReasonCondition.GRANT_EXHAUSTED not in result.active_conditions


class TestScenario6Running:
    """④ 运行中：当前动作只来自 actions 表 started 未完成动作。"""

    def test_started_action_is_running(self) -> None:
        result = derive_status_reason(facts(status="implementing", outstanding_action="act-1"))
        assert result.main_condition is ReasonCondition.RUNNING
        assert result.blocked_reason_text == ("任务正在执行中，当前动作：act-1，等待其完成")

    def test_running_clause_names_current_action(self) -> None:
        """验收标准 7：主句给出 actions 表中 started 未完成动作的身份。"""

        result = derive_status_reason(facts(outstanding_action="act-42"))
        assert "act-42" in result.blocked_reason_text
        assert result.evidence == ("actions:act-42",)

    @pytest.mark.parametrize(
        "status",
        ["implementing", "reviewing", "testing", "fixing", "granted"],
    )
    def test_status_words_alone_are_not_running(self, status: str) -> None:
        """状态词不是运行中的依据；没有 actions 记录就不能判为运行中。"""

        assert ReasonCondition.RUNNING not in active_conditions(facts(status=status))

    def test_status_word_with_started_action_is_running(self) -> None:
        result = derive_status_reason(facts(status="reviewing", outstanding_action="act-9"))
        assert result.main_condition is ReasonCondition.RUNNING
        assert "act-9" in result.blocked_reason_text


class TestScenario7Terminal:
    """⑤ 已终态。"""

    def test_terminal_record_is_main_clause(self) -> None:
        result = derive_status_reason(facts(status="delivered", terminal=TerminalState.DELIVERED))
        assert result.main_condition is ReasonCondition.TERMINAL
        assert result.blocked_reason_text == "任务已到达终态（delivered），本轮已结束"

    @pytest.mark.parametrize(
        ("status", "label"),
        [
            ("delivered", "delivered"),
            ("merged", "merged"),
            ("rejected", "rejected"),
            ("stopped", "stopped"),
        ],
    )
    def test_terminal_status_words(self, status: str, label: str) -> None:
        result = derive_status_reason(facts(status=status))
        assert result.main_condition is ReasonCondition.TERMINAL
        assert result.blocked_reason_text == f"任务已到达终态（{label}），本轮已结束"


class TestScenario8MultipleConditions:
    """多条件并存：主句按优先级，补充句最多两条且按优先级排序。"""

    def test_priority_and_two_supplements(self) -> None:
        result = derive_status_reason(
            facts(
                status="awaiting_grant",
                failure_rounds=3,
                grant_count=1,
                unmet_prerequisites=("dep",),
                budget_limit_seconds=100.0,
                budget_consumed_seconds=100.0,
            )
        )
        assert result.main_condition is ReasonCondition.AWAITING_GRANT
        assert result.supplements == (
            ReasonCondition.DEPENDENCY_UNMET,
            ReasonCondition.GRANT_EXHAUSTED,
        )
        assert result.blocked_reason_text == (
            "等待人工决定是否追加失败轮次授权"
            "；另外还有依赖未满足、失败轮次用尽（已用 3 轮，上限 3 轮）"
        )

    def test_dependency_outranks_running_and_budget(self) -> None:
        result = derive_status_reason(
            facts(
                status="implementing",
                outstanding_action="act-2",
                unmet_prerequisites=("dep",),
                budget_limit_seconds=100.0,
                budget_consumed_seconds=150.0,
            )
        )
        assert result.main_condition is ReasonCondition.DEPENDENCY_UNMET
        assert result.supplements == (
            ReasonCondition.RUNNING,
            ReasonCondition.BUDGET_EXHAUSTED,
        )
        assert result.blocked_reason_text == (
            "前置任务未满足，等待依赖完成：dep；另外还有正在执行（当前动作：act-2）、工时限额耗尽"
        )

    def test_supplements_are_capped_at_two(self) -> None:
        result = derive_status_reason(
            facts(
                status="awaiting_grant",
                failure_rounds=3,
                grant_count=1,
                unmet_prerequisites=("dep",),
                budget_limit_seconds=1.0,
                budget_consumed_seconds=1.0,
            )
        )
        assert len(result.supplements) == 2
        assert ReasonCondition.BUDGET_EXHAUSTED not in result.supplements
        assert ReasonCondition.BUDGET_EXHAUSTED in result.active_conditions

    def test_active_conditions_follow_fixed_priority(self) -> None:
        result = derive_status_reason(
            facts(
                status="time_exhausted",
                plan_version=1,
                plan_approval_version=None,
                unmet_prerequisites=("dep",),
                failure_rounds=3,
                grant_count=1,
                outstanding_action="act-1",
                terminal=TerminalState.DELIVERED,
            )
        )
        assert result.active_conditions == (
            ReasonCondition.AWAITING_PLAN_APPROVAL,
            ReasonCondition.DEPENDENCY_UNMET,
            ReasonCondition.GRANT_EXHAUSTED,
            ReasonCondition.RUNNING,
            ReasonCondition.TERMINAL,
            ReasonCondition.BUDGET_EXHAUSTED,
        )
        assert result.active_conditions == tuple(
            condition for condition in PRIORITY if condition in result.active_conditions
        )


class TestScenario9MissingEvidence:
    """依据缺失：输出 unknown 并说明缺哪条依据，不猜测、不退化。"""

    def test_missing_task_record_is_unknown(self) -> None:
        result = derive_status_reason(facts("ghost", missing=("tasks:ghost",)))
        assert result.is_unknown
        assert result.blocked_reason_text == "unknown：依据缺失（tasks:ghost）"
        assert result.main_condition is None
        assert result.supplements == ()
        assert result.missing == ("tasks:ghost",)

    def test_missing_evidence_takes_precedence_over_active_conditions(self) -> None:
        result = derive_status_reason(
            facts(
                status="awaiting_grant",
                failure_rounds=3,
                grant_count=1,
                missing=("approvals:t1:v1:plan", "plans:t1:v1"),
            )
        )
        assert result.is_unknown
        assert "approvals:t1:v1:plan" in result.blocked_reason_text
        assert "plans:t1:v1" in result.blocked_reason_text

    def test_missing_is_deduped_stably(self) -> None:
        result = derive_status_reason(facts(missing=("tasks:a", "tasks:a", "tasks:b")))
        assert result.missing == ("tasks:a", "tasks:b")
        assert result.blocked_reason_text == "unknown：依据缺失（tasks:a、tasks:b）"


class TestScenario10NormalProgress:
    """正常推进：没有阻断条件时仍给出非空结论。"""

    def test_fresh_created_task_is_not_empty(self) -> None:
        result = derive_status_reason(facts(status="created"))
        assert result.main_condition is None
        assert result.active_conditions == ()
        assert result.supplements == ()
        assert result.blocked_reason_text == "任务正常推进，暂无阻断条件"
        assert result.blocked_reason_text

    def test_manual_review_status_is_reported_not_treated_as_normal(self) -> None:
        result = derive_status_reason(facts(status="blocked"))
        assert result.main_condition is ReasonCondition.MANUAL_REVIEW
        assert "blocked" in result.blocked_reason_text

    def test_budget_exhaustion_is_a_main_clause_when_alone(self) -> None:
        result = derive_status_reason(
            facts(budget_limit_seconds=100.0, budget_consumed_seconds=100.0)
        )
        assert result.main_condition is ReasonCondition.BUDGET_EXHAUSTED
        assert result.blocked_reason_text == ("执行工时限额已耗尽，等待人工延长限额或拆分任务")


class TestResultShapeAndHelpers:
    """结果结构、依据透传与便捷入口。"""

    def test_result_is_frozen_dataclass(self) -> None:
        result = derive_status_reason(facts(status="created"))
        assert isinstance(result, StatusReason)
        assert result.task_id == "t1"
        with pytest.raises(FrozenInstanceError):
            result.task_id = "other"  # type: ignore[misc]

    def test_evidence_is_deduped_and_passed_through(self) -> None:
        result = derive_status_reason(
            facts(
                evidence=("tasks:t1", "plans:t1:v1", "tasks:t1"),
                plan_version=1,
                plan_approval_version=1,
            )
        )
        assert result.evidence == ("tasks:t1", "plans:t1:v1")

    def test_blocked_reason_text_helper_matches(self) -> None:
        case = facts(status="tested", plan_version=1, plan_approval_version=1)
        assert blocked_reason_text(case) == derive_status_reason(case).blocked_reason_text

    @pytest.mark.parametrize(
        "case",
        [
            facts(status="created"),
            facts(plan_version=1),
            facts(status="awaiting_grant"),
            facts(unmet_prerequisites=("dep",)),
            facts(status="implementing"),
            facts(status="delivered"),
            facts(missing=("tasks:x",)),
        ],
    )
    def test_text_is_never_empty(self, case: TaskFacts) -> None:
        assert blocked_reason_text(case).strip()


class TestValidation:
    """输入事实违反身份、配额或限额规则时明确失败。"""

    def test_blank_task_id_is_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="   ")

    def test_non_positive_plan_version_is_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="t1", plan_version=0)

    def test_negative_failure_rounds_are_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="t1", failure_rounds=-1)

    def test_zero_grants_are_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="t1", grant_count=0)

    def test_non_positive_budget_limit_is_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="t1", budget_limit_seconds=0.0)

    def test_negative_consumed_budget_is_rejected(self) -> None:
        with pytest.raises(StatusReasonError):
            TaskFacts(task_id="t1", budget_consumed_seconds=-1.0)
