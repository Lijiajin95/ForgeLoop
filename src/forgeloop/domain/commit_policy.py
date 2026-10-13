"""公共提交规则：显式时区、已维护的年历与消息头语法。

复刻自 EvidHist 的同名领域模块；由 scripts/check_commit_policy.py 消费，
pre-commit 与 commit-msg hooks 都经过同一实现。
"""

import itertools
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, time
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class WorkdayCalendar:
    year: int
    holidays: frozenset[date]
    extra_workdays: frozenset[date]

    def __post_init__(self) -> None:
        if self.holidays & self.extra_workdays:
            raise ValueError("A date cannot be both a holiday and an extra workday")
        if any(day.year != self.year for day in self.holidays | self.extra_workdays):
            raise ValueError("Calendar dates must belong to its declared year")

    def is_workday(self, day: date) -> bool:
        if day.year != self.year:
            raise ValueError("Calendar year does not cover this date")
        if day in self.extra_workdays:
            return True
        return day.weekday() < 5 and day not in self.holidays


@dataclass(frozen=True)
class BlockedWindow:
    """一段禁止提交的当日时间窗（起点含、终点不含）。"""

    start: time
    end: time

    def __post_init__(self) -> None:
        if not self.start < self.end:
            raise ValueError("Commit restriction requires a same-day nonempty time window")

    def contains(self, moment: time) -> bool:
        return self.start <= moment < self.end


@dataclass(frozen=True)
class CommitPolicy:
    timezone: ZoneInfo
    blocked_windows: tuple[BlockedWindow, ...]
    calendars: Mapping[int, WorkdayCalendar]

    def __post_init__(self) -> None:
        if not self.blocked_windows:
            raise ValueError("Commit restriction requires at least one blocked window")
        ordered = tuple(sorted(self.blocked_windows, key=lambda window: (window.start, window.end)))
        if ordered != self.blocked_windows:
            raise ValueError("Blocked windows must be ordered by start time")
        for earlier, later in itertools.pairwise(ordered):
            if later.start < earlier.end:
                raise ValueError("Blocked windows must not overlap")


@dataclass(frozen=True)
class CommitDecision:
    allowed: bool
    reason: str
    hint: str | None = None


def check_commit_time(instant: datetime, policy: CommitPolicy) -> CommitDecision:
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("Commit timestamps must include a timezone")
    local = instant.astimezone(policy.timezone)
    if not any(window.contains(local.time()) for window in policy.blocked_windows):
        hint = None if local.year in policy.calendars else "maintain_annual_calendar"
        return CommitDecision(True, "outside_work_hours", hint)
    calendar = policy.calendars.get(local.year)
    if calendar is None:
        return CommitDecision(False, "calendar_missing")
    if calendar.is_workday(local.date()):
        return CommitDecision(False, "workday_work_hours")
    return CommitDecision(True, "non_workday")


HEADER = re.compile(
    r"(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)"
    r"(?:\([a-z0-9][a-z0-9/-]*\))?!?: [^\r\n]+"
)


def validate_commit_message(message: str) -> None:
    lines = message.splitlines()
    if not lines:
        raise ValueError("Commit message is empty")
    header = lines[0]
    if len(header) > 100 or HEADER.fullmatch(header) is None:
        raise ValueError(
            "Use type(scope): description; the first line must be at most 100 characters"
        )
    description = header.split(": ", 1)[1]
    if description != description.strip():
        raise ValueError("Commit description must not have leading or trailing whitespace")
