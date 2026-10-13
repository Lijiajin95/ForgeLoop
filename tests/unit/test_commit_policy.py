"""提交策略领域规则：年历、时间窗与消息头语法的单元测试。"""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from forgeloop.domain.commit_policy import (
    BlockedWindow,
    CommitDecision,
    CommitPolicy,
    WorkdayCalendar,
    check_commit_time,
    validate_commit_message,
)

SHANGHAI = ZoneInfo("Asia/Shanghai")


def calendar() -> WorkdayCalendar:
    return WorkdayCalendar(
        2026,
        frozenset({date(2026, 10, 1), date(2026, 10, 7)}),
        frozenset({date(2026, 10, 10)}),
    )


def windows() -> tuple[BlockedWindow, ...]:
    return (BlockedWindow(time(9, 0), time(12, 0)), BlockedWindow(time(13, 30), time(18, 0)))


def policy(calendars: dict[int, WorkdayCalendar]) -> CommitPolicy:
    return CommitPolicy(SHANGHAI, windows(), calendars)


def at(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=SHANGHAI)


class TestWorkdayCalendar:
    def test_extra_workday_overrides_weekend(self) -> None:
        assert calendar().is_workday(date(2026, 10, 10))  # 周六调休上班

    def test_holiday_is_not_workday(self) -> None:
        assert not calendar().is_workday(date(2026, 10, 1))

    def test_regular_weekend_is_not_workday(self) -> None:
        assert not calendar().is_workday(date(2026, 10, 11))  # 周日
        assert not calendar().is_workday(date(2026, 10, 17))  # 周六（非调休）

    def test_regular_weekday_is_workday(self) -> None:
        assert calendar().is_workday(date(2026, 10, 12))  # 周一

    def test_unknown_year_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="does not cover"):
            calendar().is_workday(date(2027, 1, 1))

    def test_overlapping_dates_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="both a holiday"):
            WorkdayCalendar(2026, frozenset({date(2026, 5, 1)}), frozenset({date(2026, 5, 1)}))

    def test_foreign_year_dates_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="declared year"):
            WorkdayCalendar(2026, frozenset({date(2027, 5, 1)}), frozenset())


class TestCheckCommitTime:
    def test_workday_hours_are_blocked(self) -> None:
        decision = check_commit_time(at(2026, 10, 12, 15, 0), policy({2026: calendar()}))
        assert decision == CommitDecision(False, "workday_work_hours")

    def test_holiday_hours_are_allowed(self) -> None:
        decision = check_commit_time(at(2026, 10, 1, 14, 0), policy({2026: calendar()}))
        assert decision == CommitDecision(True, "non_workday")

    def test_extra_workday_hours_are_blocked(self) -> None:
        decision = check_commit_time(at(2026, 10, 10, 10, 0), policy({2026: calendar()}))
        assert decision == CommitDecision(False, "workday_work_hours")

    def test_evening_outside_window_is_allowed(self) -> None:
        decision = check_commit_time(at(2026, 10, 12, 18, 0), policy({2026: calendar()}))
        assert decision == CommitDecision(True, "outside_work_hours")
        assert decision.hint is None

    def test_window_boundaries(self) -> None:
        rules = policy({2026: calendar()})
        assert not check_commit_time(at(2026, 10, 12, 9, 0), rules).allowed  # 含 09:00
        assert not check_commit_time(at(2026, 10, 12, 17, 59), rules).allowed
        assert check_commit_time(at(2026, 10, 12, 18, 0), rules).allowed  # 不含 18:00

    def test_missing_calendar_blocks_inside_window(self) -> None:
        decision = check_commit_time(at(2026, 10, 12, 14, 0), policy({}))
        assert decision == CommitDecision(False, "calendar_missing")

    def test_missing_calendar_outside_window_allows_with_hint(self) -> None:
        decision = check_commit_time(at(2026, 10, 12, 20, 0), policy({}))
        assert decision == CommitDecision(True, "outside_work_hours", "maintain_annual_calendar")

    def test_naive_datetime_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="timezone"):
            check_commit_time(datetime(2026, 10, 12, 12, 0), policy({}))

    def test_policy_timezone_is_used_not_system_timezone(self) -> None:
        # 决策必须按策略时区计算，而不是宿主系统时区。
        from zoneinfo import ZoneInfo

        new_york = CommitPolicy(ZoneInfo("America/New_York"), windows(), {})
        # 2026-10-12 21:30 上海 = 09:30 纽约：纽约窗口内被阻断。
        instant = datetime(2026, 10, 12, 21, 30, tzinfo=SHANGHAI)
        decision = check_commit_time(instant, new_york)
        assert decision.allowed is False  # 纽约 09:30 在禁止窗口（按年历缺失口径阻断）
        assert decision.reason == "calendar_missing"

    def test_empty_window_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="nonempty"):
            BlockedWindow(time(9, 0), time(9, 0))

    def test_policy_requires_at_least_one_window(self) -> None:
        with pytest.raises(ValueError, match="at least one"):
            CommitPolicy(SHANGHAI, (), {})

    def test_unordered_windows_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="ordered"):
            CommitPolicy(
                SHANGHAI,
                (BlockedWindow(time(13, 30), time(18, 0)), BlockedWindow(time(9, 0), time(12, 0))),
                {},
            )

    def test_touching_windows_are_allowed(self) -> None:
        # 相邻窗口（前一段终点 == 后一段起点）合法，例如 09:00-12:00 与 12:00-13:30。
        touching = (
            BlockedWindow(time(9, 0), time(12, 0)),
            BlockedWindow(time(12, 0), time(13, 30)),
        )
        rules = CommitPolicy(SHANGHAI, touching, {2026: calendar()})
        assert not check_commit_time(at(2026, 10, 12, 11, 59), rules).allowed
        assert not check_commit_time(at(2026, 10, 12, 12, 0), rules).allowed  # 落在第二段
        assert check_commit_time(at(2026, 10, 12, 13, 30), rules).allowed

    def test_overlapping_windows_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="overlap"):
            CommitPolicy(
                SHANGHAI,
                (BlockedWindow(time(9, 0), time(12, 0)), BlockedWindow(time(11, 0), time(18, 0))),
                {},
            )

    def test_midday_gap_allows_commits(self) -> None:
        # 2026-10-12 周一：11:59 阻断 12:00-13:29 允许 13:30 起再次阻断 18:00 允许。
        busy = {2026: calendar()}
        assert not check_commit_time(at(2026, 10, 12, 11, 59), policy(busy)).allowed
        assert check_commit_time(at(2026, 10, 12, 12, 0), policy(busy)).allowed
        assert check_commit_time(at(2026, 10, 12, 13, 29), policy(busy)).allowed
        assert not check_commit_time(at(2026, 10, 12, 13, 30), policy(busy)).allowed
        assert not check_commit_time(at(2026, 10, 12, 17, 59), policy(busy)).allowed
        assert check_commit_time(at(2026, 10, 12, 18, 0), policy(busy)).allowed


class TestValidateCommitMessage:
    @pytest.mark.parametrize(
        "message",
        [
            "chore: 初始化 ForgeLoop 仓库",
            "feat(cli): add status --json output",
            "fix(graph)!: 调整失败回边路由",
            "docs: 记录可靠性方案",
            # 首行恰 100 字符：上界之内合法。
            "feat: " + "x" * 94,
            # 描述内含多段 ": "：按首个 ": " 取描述（尾部空格检测覆盖全段）。
            "fix: a:  b",
        ],
    )
    def test_valid_headers(self, message: str) -> None:
        validate_commit_message(message)

    @pytest.mark.parametrize(
        "message",
        [
            "",
            "random message",
            "feat: 多余尾部空格 ",
            "unknown: unknown type",
            "feat(范围): scope 只允许小写字母数字与斜杠",
            # 首行 101 字符：超出上界。
            "feat: " + "x" * 95,
            # 多段描述尾部空格：首段拆分后仍能发现。
            "chore: a:  ",
            "feat: " + "x" * 96,
        ],
    )
    def test_invalid_headers(self, message: str) -> None:
        with pytest.raises(ValueError):
            validate_commit_message(message)
