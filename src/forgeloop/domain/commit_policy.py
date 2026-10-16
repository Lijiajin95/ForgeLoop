"""公共提交规则：显式时区、已维护的年历、授权窄口与消息头语法。

复刻自 EvidHist 的同名领域模块；由 scripts/check_commit_policy.py 消费，
pre-commit 与 commit-msg hooks 都经过同一实现。

所有者决定（2026-10-13）：禁止窗口内只有按批次登记授权的日期才可能放行，
且只放行早间窄口；授权窗口终点不得晚于 10:00，超过该上限的授权一律无效。
"""

import itertools
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, time
from enum import StrEnum
from typing import Any, cast
from zoneinfo import ZoneInfo

# 授权的硬上限：任何配置都不得把授权窗口延伸到 10:00 之后。
AUTHORIZATION_DEADLINE = time(10, 0)


class CommitPolicySource(StrEnum):
    """生效策略来源：随仓库分发的默认，或仅作用于本机的本地覆盖。"""

    REPOSITORY_DEFAULT = "repository_default"
    LOCAL_OVERRIDE = "local_override"


# 本地覆盖只允许声明这些顶层键：时间窗、是否适用授权窄口、是否禁止工作时间提交、
# 机器标签。``authorized_window``、``authorized_batches`` 与 ``calendar_directory``
# 不在此列：本地覆盖不能改动所有者授权窗口或授权登记，也不能改变年历来源，
# 因此 09:00-09:55 含头不含尾的授权窄口不会被本机文件加宽或迁移。
LOCAL_OVERRIDE_KEYS = frozenset(
    {
        "blocked_windows",
        "apply_authorized_window",
        "enforce_work_hours",
        "machine_label",
    }
)


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
    authorized_window: BlockedWindow
    authorized_dates: frozenset[date] = frozenset()
    source: CommitPolicySource = CommitPolicySource.REPOSITORY_DEFAULT
    machine_label: str | None = None
    enforce_work_hours: bool = True
    apply_authorized_window: bool = True

    def __post_init__(self) -> None:
        if not self.blocked_windows:
            if self.enforce_work_hours:
                raise ValueError("Commit restriction requires at least one blocked window")
            return
        ordered = tuple(sorted(self.blocked_windows, key=lambda window: (window.start, window.end)))
        if ordered != self.blocked_windows:
            raise ValueError("Blocked windows must be ordered by start time")
        for earlier, later in itertools.pairwise(ordered):
            if later.start < earlier.end:
                raise ValueError("Blocked windows must not overlap")
        if self.authorized_window.end > AUTHORIZATION_DEADLINE:
            raise ValueError("Authorized commit window must end by 10:00")
        if not any(
            window.start <= self.authorized_window.start
            and self.authorized_window.end <= window.end
            for window in self.blocked_windows
        ):
            raise ValueError("Authorized commit window must lie inside a blocked window")


@dataclass(frozen=True)
class CommitDecision:
    allowed: bool
    reason: str
    hint: str | None = None
    source: CommitPolicySource = CommitPolicySource.REPOSITORY_DEFAULT
    machine_label: str | None = None


def check_commit_time(instant: datetime, policy: CommitPolicy) -> CommitDecision:
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("Commit timestamps must include a timezone")

    def decide(allowed: bool, reason: str, hint: str | None = None) -> CommitDecision:
        return CommitDecision(allowed, reason, hint, policy.source, policy.machine_label)

    if not policy.enforce_work_hours:
        return decide(True, "work_hours_not_enforced")
    local = instant.astimezone(policy.timezone)
    if not any(window.contains(local.time()) for window in policy.blocked_windows):
        hint = None if local.year in policy.calendars else "maintain_annual_calendar"
        return decide(True, "outside_work_hours", hint)
    calendar = policy.calendars.get(local.year)
    if calendar is None:
        return decide(False, "calendar_missing")
    if not calendar.is_workday(local.date()):
        return decide(True, "non_workday")
    if policy.apply_authorized_window and local.date() in policy.authorized_dates:
        if policy.authorized_window.contains(local.time()):
            return decide(True, "authorized_grace_window")
        return decide(False, "authorized_window_elapsed")
    return decide(False, "workday_work_hours")


def load_authorized_batches(config: Mapping[str, Any]) -> frozenset[date]:
    """读取按批次登记的授权日期；每条授权必须可溯源且日期唯一。"""
    dates: list[date] = []
    for entry in config.get("authorized_batches", ()):
        if not str(entry.get("authorization_source", "")).strip():
            raise ValueError("Authorized batches must record a non-empty authorization_source")
        dates.append(date.fromisoformat(entry["date"]))
    if len(set(dates)) != len(dates):
        raise ValueError("Authorized batch dates must be unique")
    return frozenset(dates)


def merge_policy_config(
    repository_default: Mapping[str, Any],
    local_override: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """仓库默认与本地覆盖的键级合并：只覆盖显式声明的键，其余继承默认。

    本地覆盖只允许声明 ``LOCAL_OVERRIDE_KEYS``，因此不能改动 ``authorized_window``
    授权窄口、``authorized_batches`` 授权登记或 ``calendar_directory`` 年历来源。
    映射值递归按键合并，列表等非映射值整体替换；结果只由输入文档决定，与读取
    顺序无关。
    """
    if local_override is None:
        return dict(repository_default)
    unknown = sorted(set(local_override) - LOCAL_OVERRIDE_KEYS)
    if unknown:
        raise ValueError(f"Local override may not declare: {', '.join(unknown)}")
    merged = dict(repository_default)
    for key, value in local_override.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = _merge_mapping(
                cast("Mapping[str, Any]", current), cast("Mapping[str, Any]", value)
            )
        else:
            merged[key] = value
    return merged


def _merge_mapping(default: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(default)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = _merge_mapping(
                cast("Mapping[str, Any]", current), cast("Mapping[str, Any]", value)
            )
        else:
            merged[key] = value
    return merged


def effective_commit_policy(
    repository_default: Mapping[str, Any],
    local_override: Mapping[str, Any] | None,
    calendars: Mapping[int, Mapping[str, Any]],
) -> CommitPolicy:
    """把仓库默认与（可选）本地覆盖合并为唯一、确定、可复现的生效策略。"""
    config = merge_policy_config(repository_default, local_override)
    source = (
        CommitPolicySource.LOCAL_OVERRIDE
        if local_override is not None
        else CommitPolicySource.REPOSITORY_DEFAULT
    )
    machine_label = config.get("machine_label")
    if machine_label is not None and (
        not isinstance(machine_label, str) or not machine_label.strip()
    ):
        raise ValueError("machine_label must be a non-empty string when declared")
    authorized = config["authorized_window"]
    blocked_entries = config["blocked_windows"]
    return CommitPolicy(
        timezone=ZoneInfo(config["timezone"]),
        blocked_windows=tuple(
            BlockedWindow(time.fromisoformat(entry["start"]), time.fromisoformat(entry["end"]))
            for entry in blocked_entries
        ),
        calendars={year: _workday_calendar(data) for year, data in calendars.items()},
        authorized_window=BlockedWindow(
            time.fromisoformat(authorized["start"]), time.fromisoformat(authorized["end"])
        ),
        authorized_dates=load_authorized_batches(config),
        source=source,
        machine_label=machine_label.strip() if isinstance(machine_label, str) else None,
        # 未显式声明开关时，空时间窗列表即“全时间段允许”。
        enforce_work_hours=bool(config.get("enforce_work_hours", bool(blocked_entries))),
        apply_authorized_window=bool(config.get("apply_authorized_window", True)),
    )


def _workday_calendar(data: Mapping[str, Any]) -> WorkdayCalendar:
    year = data["year"]
    if type(year) is not int:
        raise ValueError("Calendar year must be an integer")
    return WorkdayCalendar(
        year,
        frozenset(date.fromisoformat(value) for value in data["holidays"]),
        frozenset(date.fromisoformat(value) for value in data["extra_workdays"]),
    )


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
