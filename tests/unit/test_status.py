"""任务下一步动作领域规则的单元测试（G01 关键判断）。

`status --json` 的 `next_action` 由本模块的纯规则生成：每个已知任务状态对应
一个明确的下一步动作、动作主体（user/agent）与阻塞或等待原因；未知状态
一律落到人工核对，不猜测、不放行。
"""

import pytest

from forgeloop.domain.status import ActionActor, NextAction, next_action

USER = ActionActor.USER
AGENT = ActionActor.AGENT

# 与 `set_task_status` 实际写入的状态词表一致（created 为建任务初值）。
KNOWN_STATUSES = (
    "created",
    "awaiting_plan_approval",
    "implementing",
    "reviewing",
    "testing",
    "tested",
    "fixing",
    "awaiting_grant",
    "granted",
    "awaiting_acceptance",
    "delivered",
    "merged",
    "rejected",
    "blocked",
    "interrupted",
    "stop_requested",
    "stopped",
    "time_exhausted",
)


class TestNextActionShape:
    def test_returns_immutable_next_action(self) -> None:
        result = next_action("implementing")
        assert isinstance(result, NextAction)
        assert result.action
        assert result.reason

    def test_actor_vocabulary_is_user_and_agent(self) -> None:
        assert {actor.value for actor in ActionActor} == {"user", "agent"}


@pytest.mark.parametrize(
    ("status", "actor"),
    [
        ("created", AGENT),
        ("awaiting_plan_approval", USER),
        ("implementing", AGENT),
        ("reviewing", AGENT),
        ("testing", AGENT),
        ("tested", USER),
        ("fixing", AGENT),
        ("awaiting_grant", USER),
        ("granted", AGENT),
        ("awaiting_acceptance", USER),
        ("delivered", USER),
        ("merged", USER),
        ("rejected", USER),
        ("blocked", USER),
        ("interrupted", USER),
        ("stop_requested", USER),
        ("stopped", USER),
        ("time_exhausted", USER),
    ],
)
def test_known_status_has_action_and_expected_actor(status: str, actor: ActionActor) -> None:
    result = next_action(status)
    assert result.actor is actor
    assert result.action.strip()
    assert result.reason.strip()


def test_all_supported_statuses_are_covered() -> None:
    """已知状态词表必须全部有明确动作，不能悄悄落到人工核对。"""

    for status in KNOWN_STATUSES:
        assert next_action(status).actor in {USER, AGENT}


class TestBlockingReasons:
    @pytest.mark.parametrize(
        ("status", "keyword"),
        [
            ("awaiting_plan_approval", "批准"),
            ("awaiting_acceptance", "验收"),
            ("awaiting_grant", "授权"),
            ("time_exhausted", "限额"),
            ("stop_requested", "停止"),
            ("interrupted", "核对"),
            ("blocked", "核对"),
        ],
    )
    def test_reason_explains_waiting_or_blocking(self, status: str, keyword: str) -> None:
        assert keyword in next_action(status).reason


class TestUnknownStatus:
    def test_unknown_status_falls_to_manual_review(self) -> None:
        result = next_action("mystery_state")
        assert result.actor is USER
        assert "人工核对" in result.action
        assert "mystery_state" in result.reason

    def test_status_matching_is_exact_not_case_insensitive(self) -> None:
        assert next_action("Implementing").actor is USER
        assert "人工核对" in next_action("Implementing").action

    def test_empty_status_falls_to_manual_review(self) -> None:
        assert next_action("").actor is USER
        assert "人工核对" in next_action("").action
