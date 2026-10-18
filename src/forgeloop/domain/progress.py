"""状态页的纯规则：刷新间隔解析与「问题」分类。

两件事都是只读派生，因此放在无 IO、无时钟的纯规则层，由页面服务端调用：

**刷新间隔**：来源优先级为 CLI 参数 → 配置文件 → 内建默认（60 秒，即「默认每
1 分钟刷新一次」）。非法值（负数、非整数、布尔）一律明确失败，不静默回落到默认，
因为「配置写错了却看起来生效」比启动失败更难发现。``0`` 是唯一允许的关闭值，
表示不自动刷新。

**问题分类**：只把已有权威状态词表里「需要人工介入才能继续」的状态判为问题
（阻断、中断、失败轮次用尽、工时耗尽、已请求停止未确认），以及未完成的执行
槽位残留。正常流程中的等待门（等待批准、等待验收、等待澄清）与被人工决定终止
的状态（``rejected``/``stopped``）不是问题。未知状态不猜测、不判为问题：任务
与需求列表仍如实显示原状态，且 ``domain.status.next_action`` 对未知状态已经
落到「人工核对」，不在这里重复第二份词表。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

from forgeloop.domain.requirement import BLOCKED as REQUIREMENT_BLOCKED_STATUS

DEFAULT_REFRESH_SECONDS = 60
"""内建默认刷新间隔（秒）：每 1 分钟刷新一次。"""

AUTO_REFRESH_OFF = 0
"""``refresh_seconds = 0`` 表示关闭自动刷新，页面只保留手动刷新。"""

REFRESH_SECONDS_KEY = "refresh_seconds"


class ProgressConfigError(ValueError):
    """刷新配置非法：明确失败，不静默回落到默认值。"""


class RefreshSource(StrEnum):
    """生效刷新间隔的来源，供页面如实标注「这个值是谁定的」。"""

    CLI = "cli"
    CONFIG = "config"
    DEFAULT = "default"


@dataclass(frozen=True)
class RefreshSetting:
    """生效的刷新间隔及其来源。"""

    seconds: int
    source: RefreshSource


_CLI_ORIGIN = "--refresh-seconds"
_CONFIG_ORIGIN = f"配置项 {REFRESH_SECONDS_KEY}"


def _refresh_seconds(value: object, origin: str) -> int:
    """校验一个刷新间隔：非负整数秒；布尔与非整数都拒绝。"""

    if isinstance(value, bool) or not isinstance(value, int):
        raise ProgressConfigError(
            f"{origin} 必须是不小于 0 的整数秒（0 表示关闭自动刷新），实际为 {value!r}"
        )
    if value < 0:
        raise ProgressConfigError(
            f"{origin} 必须是不小于 0 的整数秒（0 表示关闭自动刷新），实际为 {value}"
        )
    return value


def resolve_refresh_seconds(
    config: Mapping[str, object] | None = None,
    cli_value: object | None = None,
) -> RefreshSetting:
    """解析生效刷新间隔：CLI 参数 → 配置文件 → 内建默认。

    ``config`` 为配置文件原始文档（``None`` 表示没有配置文件）；``cli_value`` 为
    命令行显式传入的值（``None`` 表示未传，而不是传了 0——0 是合法的关闭值）。
    """

    if cli_value is not None:
        return RefreshSetting(_refresh_seconds(cli_value, _CLI_ORIGIN), RefreshSource.CLI)
    if config is not None and REFRESH_SECONDS_KEY in config:
        return RefreshSetting(
            _refresh_seconds(config[REFRESH_SECONDS_KEY], _CONFIG_ORIGIN),
            RefreshSource.CONFIG,
        )
    return RefreshSetting(DEFAULT_REFRESH_SECONDS, RefreshSource.DEFAULT)


class IssueKind(StrEnum):
    """问题种类：稳定的机器标签，页面按它分组与着色。"""

    TASK_BLOCKED = "task_blocked"
    TASK_INTERRUPTED = "task_interrupted"
    TASK_GRANT_REQUIRED = "task_grant_required"
    TASK_TIME_EXHAUSTED = "task_time_exhausted"
    TASK_STOP_REQUESTED = "task_stop_requested"
    REQUIREMENT_BLOCKED = "requirement_blocked"
    SLOT_RESIDUE = "slot_residue"
    OUTSTANDING_ACTION = "outstanding_action"


@dataclass(frozen=True)
class IssueItem:
    """一个需要人工处理的问题：对象身份、种类、摘要与权威依据文本。"""

    kind: IssueKind
    ref_id: str
    summary: str
    detail: str


# 任务状态 → 问题种类与摘要。摘要写清「需要谁做什么」，直接来自状态语义。
_TASK_ISSUES: dict[str, tuple[IssueKind, str]] = {
    "blocked": (IssueKind.TASK_BLOCKED, "任务执行被阻断，需人工核对后才能继续"),
    "interrupted": (
        IssueKind.TASK_INTERRUPTED,
        "任务中断，执行结果不明确，禁止盲目重放，需人工核对现场",
    ),
    "awaiting_grant": (
        IssueKind.TASK_GRANT_REQUIRED,
        "失败轮次额度用尽，等待追加授权或停止",
    ),
    "time_exhausted": (
        IssueKind.TASK_TIME_EXHAUSTED,
        "执行时间限额已耗尽，需决定延长限额或拆分任务",
    ),
    "stop_requested": (
        IssueKind.TASK_STOP_REQUESTED,
        "已请求停止，等待当前工具完成后确认停止结果",
    ),
}

# 需求状态 → 问题种类与摘要。
_REQUIREMENT_ISSUES: dict[str, tuple[IssueKind, str]] = {
    REQUIREMENT_BLOCKED_STATUS: (
        IssueKind.REQUIREMENT_BLOCKED,
        "需求推进被阻断，需人工核对后才能继续",
    ),
}

ISSUE_STATUSES: tuple[str, ...] = tuple(_TASK_ISSUES)
"""被判为问题的任务状态词表，供测试与页面文案核对。"""


def task_issue(status: str, *, ref_id: str, detail: str = "") -> IssueItem | None:
    """按任务状态判定问题；不需要人工介入的状态返回 ``None``。"""

    entry = _TASK_ISSUES.get(status)
    if entry is None:
        return None
    kind, summary = entry
    return IssueItem(kind, ref_id, summary, detail)


def requirement_issue(status: str, *, ref_id: str, detail: str = "") -> IssueItem | None:
    """按需求状态判定问题；不需要人工介入的状态返回 ``None``。"""

    entry = _REQUIREMENT_ISSUES.get(status)
    if entry is None:
        return None
    kind, summary = entry
    return IssueItem(kind, ref_id, summary, detail)


def outstanding_action_issue(
    *, ref_id: str, node: str, action_id: str, started_at: str
) -> IssueItem:
    """未核对的未完成动作：结果不明确，禁止盲目重放，必须先人工核对后释放。

    这一项与任务状态无关（动作可能停在任意节点、任务状态看起来仍在推进），因此由
    ``actions`` 记录直接判定，而不是从任务状态推导——否则「崩在 dev 中途」在页面上
    会显示成正常进行中。
    """

    detail = (
        f"节点: {node or '未知'}；动作: {action_id or '未知'}；开始: {started_at or '未知'}；"
        "确认现场后用 `forgeloop requirement actions list|clear` 释放"
    )
    return IssueItem(
        IssueKind.OUTSTANDING_ACTION,
        ref_id,
        "存在未核对的未完成动作，禁止盲目重放",
        detail,
    )


def slot_issue(*, slot: str, owner: str = "", started_at: str = "") -> IssueItem:
    """未完成的执行槽位：清理前必须先核对现场，不自动重放。"""

    detail = f"占用者: {owner or '未知'}；开始: {started_at or '未知'}"
    return IssueItem(
        IssueKind.SLOT_RESIDUE,
        slot,
        "存在未完成的执行槽位，需人工核对现场后再清理",
        detail,
    )
