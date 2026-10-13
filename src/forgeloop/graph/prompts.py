"""提示词构造：把开发/审查提示的拼装从节点里分离出来（纯函数，便于单独验证）。

提示文本是模型行为契约的一部分：常量与字段顺序在这里固定，节点只负责取状态与调用。
"""

import json
from collections.abc import Mapping

from forgeloop.domain.approval import Plan

# 开发提示的自验证要求：模型必须自己先跑正式测试，且不得改测试或验收标准迎合通过。
DEV_SELF_VERIFICATION = (
    "在结束本轮前，先在 workspace 内运行正式测试命令并确认通过；"
    "不要修改测试、验收标准或跳过用例来让测试通过。"
)
# 审查输出契约：真实模型必须给出结构化阻断列表，否则节点中断（fail-closed）。
REVIEW_OUTPUT_CONTRACT = (
    "只输出一个 JSON 对象，不要输出解释或 Markdown 代码块："
    '{"summary": "<一句话审查结论>", "blocking_issues": ["<阻断问题>", "..."]}。'
    "没有阻断问题时 blocking_issues 必须是空数组 []。"
)


def dev_prompt(
    plan: Plan,
    *,
    workspace: str,
    attempt: int,
    previous_failure: Mapping[str, object] | None = None,
) -> str:
    """实现会话提示：目标、范围、验收、工作区、当前尝试、批准测试命令与自验证要求。"""

    payload: dict[str, object] = {
        "goal": plan.goal,
        "scope": plan.scope,
        "acceptance": plan.acceptance,
        "workspace": workspace,
        "attempt": attempt,
        "formal_test_command": list(plan.test_command),
        "self_verification": DEV_SELF_VERIFICATION,
    }
    if previous_failure:
        payload["previous_failure"] = previous_failure
    return json.dumps(payload, ensure_ascii=False)


def review_prompt(plan: Plan | None, *, candidate_diff: str) -> str:
    """审查会话提示：只给目标、验收与候选 diff，并要求结构化输出契约。"""

    return json.dumps(
        {
            "role": "review",
            "goal": plan.goal if plan else "",
            "acceptance": plan.acceptance if plan else "",
            "candidate_diff": candidate_diff,
            "output_contract": REVIEW_OUTPUT_CONTRACT,
        },
        ensure_ascii=False,
    )
