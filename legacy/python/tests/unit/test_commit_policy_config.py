"""生效提交策略的构造规则：单份配置、授权登记与不可配置掉的硬上限。

生效配置只有一份来源（本机配置文件），因此不再有默认/覆盖合并；本文件验证
该单文档到 ``CommitPolicy`` 的公共行为，文件系统边界见
``tests/integration/test_commit_policy_config_sources.py``。
"""

from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from forgeloop.domain.commit_policy import (
    AUTHORIZATION_DEADLINE,
    check_commit_time,
    effective_commit_policy,
    load_authorized_batches,
)

SHANGHAI = ZoneInfo("Asia/Shanghai")

CALENDARS: dict[int, dict[str, Any]] = {
    2026: {
        "year": 2026,
        "source_url": "https://example.invalid/calendar",
        "holidays": ["2026-10-01"],
        "extra_workdays": ["2026-10-10"],
    },
}


def config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "timezone": "Asia/Shanghai",
        "calendar_directory": "config/workday-calendars",
        "blocked_windows": [
            {"start": "09:00", "end": "12:00"},
            {"start": "13:30", "end": "18:00"},
        ],
        "authorized_window": {"start": "09:00", "end": "09:55"},
    }
    base.update(overrides)
    return base


def at(hour: int, minute: int = 0, day: int = 13) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI)


class TestEffectivePolicyFromOneDocument:
    def test_policy_is_deterministic_for_the_same_document(self) -> None:
        first = effective_commit_policy(config(), CALENDARS)
        second = effective_commit_policy(config(), CALENDARS)
        assert first == second

    def test_machine_label_is_trimmed_and_blank_is_rejected(self) -> None:
        assert (
            effective_commit_policy(config(machine_label=" mac "), CALENDARS).machine_label == "mac"
        )
        with pytest.raises(ValueError):
            effective_commit_policy(config(machine_label="   "), CALENDARS)

    def test_workday_window_blocks_without_authorization(self) -> None:
        rules = effective_commit_policy(config(), CALENDARS)
        assert check_commit_time(at(9, 30), rules).reason == "workday_work_hours"
        assert check_commit_time(at(12, 30), rules).allowed
        assert check_commit_time(at(19, 0), rules).allowed

    def test_missing_calendar_year_blocks_inside_the_window(self) -> None:
        rules = effective_commit_policy(config(), {})
        assert check_commit_time(at(9, 30), rules).reason == "calendar_missing"
        assert check_commit_time(at(19, 0), rules).allowed

    def test_config_may_declare_authorization_entries(self) -> None:
        rules = effective_commit_policy(
            config(
                authorized_batches=[
                    {"date": "2026-10-13", "authorization_source": "所有者按批次授权"}
                ]
            ),
            CALENDARS,
        )
        assert rules.authorized_dates == frozenset({date(2026, 10, 13)})
        assert check_commit_time(at(9, 30), rules).reason == "authorized_grace_window"
        assert check_commit_time(at(9, 55), rules).reason == "authorized_window_elapsed"
        assert check_commit_time(at(10, 35), rules).reason == "authorized_window_elapsed"
        assert check_commit_time(at(15, 0), rules).reason == "authorized_window_elapsed"

    def test_empty_windows_mean_no_enforcement(self) -> None:
        rules = effective_commit_policy(config(blocked_windows=[]), CALENDARS)
        assert rules.enforce_work_hours is False
        assert check_commit_time(at(9, 30), rules).reason == "work_hours_not_enforced"

    def test_empty_windows_with_explicit_enforcement_is_rejected(self) -> None:
        # 声明要强制却没有窗口 = 配置自相矛盾：失败关闭，不静默变成全放行。
        with pytest.raises(ValueError):
            effective_commit_policy(config(blocked_windows=[], enforce_work_hours=True), CALENDARS)

    def test_authorization_deadline_cannot_be_configured_away(self) -> None:
        assert time(10, 0) == AUTHORIZATION_DEADLINE
        with pytest.raises(ValueError):
            effective_commit_policy(
                config(authorized_window={"start": "09:00", "end": "10:05"}), CALENDARS
            )

    def test_authorized_window_must_lie_inside_a_blocked_window(self) -> None:
        with pytest.raises(ValueError):
            effective_commit_policy(
                config(authorized_window={"start": "12:15", "end": "12:30"}), CALENDARS
            )

    def test_windows_must_be_ordered_and_non_overlapping(self) -> None:
        reversed_windows = [
            {"start": "13:30", "end": "18:00"},
            {"start": "09:00", "end": "12:00"},
        ]
        with pytest.raises(ValueError):
            effective_commit_policy(config(blocked_windows=reversed_windows), CALENDARS)
        overlapping = [
            {"start": "09:00", "end": "12:00"},
            {"start": "11:00", "end": "18:00"},
        ]
        with pytest.raises(ValueError):
            effective_commit_policy(config(blocked_windows=overlapping), CALENDARS)


class TestAuthorizedBatchLoading:
    def test_every_batch_must_be_traceable(self) -> None:
        with pytest.raises(ValueError):
            load_authorized_batches(
                {"authorized_batches": [{"date": "2026-10-13", "authorization_source": " "}]}
            )

    def test_duplicate_dates_are_rejected(self) -> None:
        with pytest.raises(ValueError):
            load_authorized_batches(
                {
                    "authorized_batches": [
                        {"date": "2026-10-13", "authorization_source": "a"},
                        {"date": "2026-10-13", "authorization_source": "b"},
                    ]
                }
            )

    def test_missing_registry_yields_empty_set(self) -> None:
        assert load_authorized_batches({}) == frozenset()
