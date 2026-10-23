"""状态页纯规则的单元测试（B01 关键判断）。

页面刷新间隔与「问题」口径都由本模块的纯规则决定，不由页面脚本或服务端各自
猜一份：刷新间隔的来源优先级是 CLI 参数 → 配置文件 → 内建默认（60 秒），
非法值明确失败而不是静默取默认；问题分类只依据需求/任务的权威状态词表与未完成
执行槽位，正常流程中的等待门（等待批准、等待验收）不是问题。
"""

import pytest

from forgeloop.domain.progress import (
    DEFAULT_REFRESH_SECONDS,
    ISSUE_STATUSES,
    IssueItem,
    IssueKind,
    ProgressConfigError,
    RefreshSetting,
    RefreshSource,
    requirement_issue,
    resolve_refresh_seconds,
    slot_issue,
    task_issue,
)
from forgeloop.domain.status import next_action


class TestRefreshDefault:
    """默认每 1 分钟刷新一次；配置缺失不改变默认。"""

    def test_no_configuration_uses_one_minute_default(self) -> None:
        setting = resolve_refresh_seconds()
        assert setting.seconds == 60
        assert setting.seconds == DEFAULT_REFRESH_SECONDS
        assert setting.source is RefreshSource.DEFAULT

    def test_config_without_the_key_keeps_the_default(self) -> None:
        setting = resolve_refresh_seconds({"schema_version": 1})
        assert setting.seconds == DEFAULT_REFRESH_SECONDS
        assert setting.source is RefreshSource.DEFAULT

    def test_returns_immutable_setting(self) -> None:
        assert isinstance(resolve_refresh_seconds(), RefreshSetting)


class TestRefreshSources:
    """来源优先级：CLI 参数覆盖配置文件，两者都没有才用默认。"""

    def test_config_value_is_used_and_reported(self) -> None:
        setting = resolve_refresh_seconds({"refresh_seconds": 120})
        assert setting.seconds == 120
        assert setting.source is RefreshSource.CONFIG

    def test_cli_override_wins_over_config(self) -> None:
        setting = resolve_refresh_seconds({"refresh_seconds": 120}, cli_value=5)
        assert setting.seconds == 5
        assert setting.source is RefreshSource.CLI

    def test_cli_override_alone_is_reported_as_cli(self) -> None:
        assert resolve_refresh_seconds(None, cli_value=30).source is RefreshSource.CLI

    @pytest.mark.parametrize("off", [0])
    def test_zero_means_auto_refresh_disabled(self, off: int) -> None:
        assert resolve_refresh_seconds({"refresh_seconds": off}).seconds == 0
        assert resolve_refresh_seconds({"refresh_seconds": 120}, cli_value=off).seconds == 0


class TestRefreshRejections:
    """非法刷新间隔明确失败，不静默回落到默认值。"""

    @pytest.mark.parametrize(
        "value",
        [-1, -60, 1.5, "60", "1m", True, False, None, [60], {"seconds": 60}],
    )
    def test_invalid_config_value_is_rejected(self, value: object) -> None:
        with pytest.raises(ProgressConfigError):
            resolve_refresh_seconds({"refresh_seconds": value})

    @pytest.mark.parametrize("value", [-1, 2.5, "30", True])
    def test_invalid_cli_value_is_rejected(self, value: object) -> None:
        with pytest.raises(ProgressConfigError):
            resolve_refresh_seconds({"refresh_seconds": 60}, cli_value=value)

    def test_error_message_states_the_rule_and_the_value(self) -> None:
        with pytest.raises(ProgressConfigError) as error:
            resolve_refresh_seconds({"refresh_seconds": -5})
        message = str(error.value)
        assert "-5" in message
        assert "0" in message

    def test_cli_error_is_attributed_to_the_cli_source(self) -> None:
        with pytest.raises(ProgressConfigError) as error:
            resolve_refresh_seconds(None, cli_value=-1)
        assert "--refresh-seconds" in str(error.value)


class TestTaskIssueClassification:
    """只有需要人工介入的异常/耗尽状态才是问题；未知状态不猜测。"""

    @pytest.mark.parametrize(
        ("status", "kind"),
        [
            ("blocked", IssueKind.TASK_BLOCKED),
            ("interrupted", IssueKind.TASK_INTERRUPTED),
            ("awaiting_grant", IssueKind.TASK_GRANT_REQUIRED),
            ("time_exhausted", IssueKind.TASK_TIME_EXHAUSTED),
            ("stop_requested", IssueKind.TASK_STOP_REQUESTED),
        ],
    )
    def test_attention_statuses_are_issues(self, status: str, kind: IssueKind) -> None:
        assert status in ISSUE_STATUSES
        issue = task_issue(status, ref_id="task-1", detail="失败轮次额度用尽")
        assert issue is not None
        assert issue.kind is kind
        assert issue.ref_id == "task-1"
        assert issue.detail == "失败轮次额度用尽"
        assert issue.summary

    @pytest.mark.parametrize(
        "status",
        [
            "created",
            "awaiting_plan_approval",
            "implementing",
            "reviewing",
            "testing",
            "tested",
            "fixing",
            "granted",
            "awaiting_acceptance",
            "delivered",
            "merged",
            "rejected",
            "stopped",
        ],
    )
    def test_normal_flow_and_decided_statuses_are_not_issues(self, status: str) -> None:
        assert task_issue(status, ref_id="task-1") is None

    def test_unknown_status_is_not_guessed(self) -> None:
        assert task_issue("something-new", ref_id="task-1") is None

    def test_detail_defaults_to_empty_string(self) -> None:
        issue = task_issue("blocked", ref_id="task-1")
        assert issue is not None
        assert issue.detail == ""

    def test_issue_item_is_immutable(self) -> None:
        issue = task_issue("blocked", ref_id="task-1")
        assert isinstance(issue, IssueItem)
        field = "ref_id"
        with pytest.raises(AttributeError):
            setattr(issue, field, "task-2")

    def test_issue_vocabulary_matches_known_task_statuses(self) -> None:
        """问题分类的状态词必须是 ``domain.status`` 认识的状态，不新增隐式词表。"""

        unknown = next_action("no-such-status").action
        for status in ISSUE_STATUSES:
            assert next_action(status).action != unknown


class TestRequirementIssueClassification:
    @pytest.mark.parametrize("status", ["blocked"])
    def test_blocked_requirement_is_an_issue(self, status: str) -> None:
        issue = requirement_issue(status, ref_id="req-a-1", detail="任务包校验失败")
        assert issue is not None
        assert issue.kind is IssueKind.REQUIREMENT_BLOCKED
        assert issue.ref_id == "req-a-1"
        assert issue.detail == "任务包校验失败"

    @pytest.mark.parametrize(
        "status",
        [
            "draft",
            "awaiting_clarification",
            "plan_proposed",
            "approved",
            "executing",
            "accepted",
            "unknown-status",
        ],
    )
    def test_other_requirement_statuses_are_not_issues(self, status: str) -> None:
        assert requirement_issue(status, ref_id="req-a-1") is None


class TestSlotIssue:
    """未完成执行槽位是问题：现场未核对前不清理、不重放。"""

    def test_slot_residue_is_an_issue_with_occupant_detail(self) -> None:
        issue = slot_issue(slot="req-a-1", owner="advance", started_at="2026-10-17T10:00:00+08:00")
        assert issue.kind is IssueKind.SLOT_RESIDUE
        assert issue.ref_id == "req-a-1"
        assert "advance" in issue.detail
        assert "2026-10-17T10:00:00+08:00" in issue.detail
        assert issue.summary

    def test_missing_occupant_is_reported_as_unknown(self) -> None:
        issue = slot_issue(slot="req-a-1", owner="", started_at="")
        assert "未知" in issue.detail
