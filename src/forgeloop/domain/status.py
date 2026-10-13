"""任务状态到下一步动作的映射：纯领域规则。

规则来源（首版需求 V0-08 与 G01 验收）：CLI 查询必须能说明「下一步需要谁做什么，
以及为什么停下」——动作、动作主体（user/agent）与阻塞或等待原因。本模块只根据
任务状态词表给出确定动作，不读取记录、时钟或环境；未知状态一律落到人工核对，
不猜测、不自动放行。

状态词表与 `graph.nodes`/`cli.merge` 实际写入的 ``set_task_status`` 取值一致；
新增状态时必须在 :data:`_STATUS_ACTIONS` 中显式登记。
"""

from dataclasses import dataclass
from enum import StrEnum


class ActionActor(StrEnum):
    """下一步动作的主体：人工（user）或自动执行（agent）。"""

    USER = "user"
    AGENT = "agent"


@dataclass(frozen=True)
class NextAction:
    """一个任务的下一步动作说明。"""

    action: str
    actor: ActionActor
    reason: str


_MANUAL_REVIEW_ACTION = "人工核对状态"
_MANUAL_REVIEW_REASON = "未知状态：{status}，需人工核对"


def _manual_review(status: str) -> NextAction:
    return NextAction(
        _MANUAL_REVIEW_ACTION,
        ActionActor.USER,
        _MANUAL_REVIEW_REASON.format(status=status),
    )


# 状态 → 下一步动作。原因写清「等待什么」或「为何阻塞」，供查询与排障直接展示。
_STATUS_ACTIONS: dict[str, NextAction] = {
    "created": NextAction(
        "生成方案并进入第一次批准",
        ActionActor.AGENT,
        "任务已创建，尚未生成方案",
    ),
    "awaiting_plan_approval": NextAction(
        "批准或拒绝方案",
        ActionActor.USER,
        "等待第一次本地批准（范围、方案、验收标准与测试命令）",
    ),
    "implementing": NextAction(
        "实现候选改动并自验证",
        ActionActor.AGENT,
        "正在实现，等待本动作完成",
    ),
    "reviewing": NextAction(
        "用独立会话审查候选 diff",
        ActionActor.AGENT,
        "正在审查，等待本动作完成",
    ),
    "testing": NextAction(
        "执行批准的正式测试命令",
        ActionActor.AGENT,
        "正在运行正式测试，等待本动作完成",
    ),
    "tested": NextAction(
        "整体验收：核对 diff、审查与测试证据",
        ActionActor.USER,
        "正式测试已通过，等待第二次本地批准",
    ),
    "fixing": NextAction(
        "修复失败轮次并重新自验证",
        ActionActor.AGENT,
        "正式测试失败，正在修复",
    ),
    "awaiting_grant": NextAction(
        "追加授权或停止任务",
        ActionActor.USER,
        "本次失败轮次额度用尽，等待追加授权决定",
    ),
    "granted": NextAction(
        "继续修复并重新提交正式测试",
        ActionActor.AGENT,
        "已明确追加授权，继续执行",
    ),
    "awaiting_acceptance": NextAction(
        "整体验收：核对 diff、审查与测试证据",
        ActionActor.USER,
        "等待第二次本地批准（整体验收）",
    ),
    "delivered": NextAction(
        "人工接回 main 并归档交付物",
        ActionActor.USER,
        "交付已完成，等待人工接回与清理现场",
    ),
    "merged": NextAction(
        "发布版本或结束任务",
        ActionActor.USER,
        "候选已归并到 main，等待发布或收尾",
    ),
    "rejected": NextAction(
        "修改方案后重新提交",
        ActionActor.USER,
        "方案已被拒绝，任务停止推进",
    ),
    "blocked": NextAction(
        "人工核对批准绑定",
        ActionActor.USER,
        "批准绑定校验失败，需人工核对，禁止自动重放",
    ),
    "interrupted": NextAction(
        "人工核对中断现场",
        ActionActor.USER,
        "执行结果不明确，需人工核对，禁止盲目重放",
    ),
    "stop_requested": NextAction(
        "确认停止结果",
        ActionActor.USER,
        "已请求停止，等待当前工具完成后确认",
    ),
    "stopped": NextAction(
        "决定重启或结束任务",
        ActionActor.USER,
        "任务已停止，未验证事项待人工处理",
    ),
    "time_exhausted": NextAction(
        "决定延长限额或拆分任务",
        ActionActor.USER,
        "执行时间限额已耗尽，已停止启动新动作",
    ),
}


def next_action(status: str) -> NextAction:
    """返回任务状态的下一步动作；未知状态落到人工核对。"""

    action = _STATUS_ACTIONS.get(status)
    if action is not None:
        return action
    return _manual_review(status)
