"""提示词构造的单元测试：字段、契约文本与失败回边（纯函数，不涉及图与 PI）。"""

import json

from forgeloop.domain.approval import Plan
from forgeloop.graph.prompts import (
    DEV_SELF_VERIFICATION,
    REVIEW_OUTPUT_CONTRACT,
    dev_prompt,
    review_prompt,
)


def make_plan(**overrides) -> Plan:
    base = {
        "task_id": "task-prompt",
        "version": 1,
        "goal": "目标",
        "scope": "范围",
        "acceptance": "验收",
        "test_command": ("pytest", "-q"),
    }
    base.update(overrides)
    return Plan(**base)


class TestDevPrompt:
    def test_carries_approved_command_attempt_and_workspace(self) -> None:
        prompt = json.loads(dev_prompt(make_plan(), workspace="/tmp/ws", attempt=2))
        assert prompt["goal"] == "目标"
        assert prompt["scope"] == "范围"
        assert prompt["acceptance"] == "验收"
        assert prompt["workspace"] == "/tmp/ws"
        assert prompt["attempt"] == 2
        assert prompt["formal_test_command"] == ["pytest", "-q"]
        assert prompt["self_verification"] == DEV_SELF_VERIFICATION
        assert "previous_failure" not in prompt

    def test_previous_failure_is_attached_only_when_present(self) -> None:
        prompt = json.loads(
            dev_prompt(
                make_plan(test_command=("true",)),
                workspace="/tmp/ws",
                attempt=3,
                previous_failure={"formal_test": {"exit_code": 1}},
            )
        )
        assert prompt["previous_failure"] == {"formal_test": {"exit_code": 1}}

    def test_self_verification_forbids_bending_tests(self) -> None:
        assert "不要" in DEV_SELF_VERIFICATION
        assert "测试" in DEV_SELF_VERIFICATION


class TestReviewPrompt:
    def test_carries_role_diff_and_output_contract(self) -> None:
        prompt = json.loads(review_prompt(make_plan(), candidate_diff="diff --git a/x b/x"))
        assert prompt["role"] == "review"
        assert prompt["candidate_diff"].startswith("diff --git")
        assert prompt["output_contract"] == REVIEW_OUTPUT_CONTRACT
        assert "blocking_issues" in prompt["output_contract"]
