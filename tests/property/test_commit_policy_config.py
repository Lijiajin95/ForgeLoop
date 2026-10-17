"""生效提交策略配置构造的属性测试：窗口合法性、授权硬上限、确定性与判定一致。

生效配置只有一份来源（本机配置文件），因此不再有默认/本地覆盖的键级合并。
本文件用属性覆盖单份配置文档仍然成立的领域不变量；每条期望值都在测试内按输入
独立计算，不调用被测判定函数推导。

不变量：
- 非空窗口列表“有序且互不重叠” ⟺ ``effective_commit_policy`` 接受；否则必然抛
  ``ValueError``（空列表走“未强制”分支，另行覆盖）。
- 授权窗口终点晚于 10:00 的配置一律抛 ``ValueError``：硬上限改不掉。
- 同一配置文档两次构造出的策略相等：来源唯一、结果确定。
- 时刻不在任何禁止窗口内 ⇒ 放行且原因为 ``outside_work_hours``；工作日窗口内且
  当天未登记授权 ⇒ 拒绝；非工作日窗口内 ⇒ 放行。
- 空窗口列表（未声明开关）与显式 ``enforce_work_hours = false`` 都是“未强制”：
  任何时刻放行，原因为 ``work_hours_not_enforced``。
"""

import itertools
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.commit_policy import check_commit_time, effective_commit_policy

SHANGHAI = ZoneInfo("Asia/Shanghai")
MINUTES_PER_DAY = 24 * 60
# 09:00-10:00：容纳 09:00-09:55 授权窄口，同时不越过 10:00 硬上限。
ANCHOR: tuple[int, int] = (9 * 60, 10 * 60)
AUTHORIZED_WINDOW = {"start": "09:00", "end": "09:55"}

HOLIDAYS = ("2026-10-01", "2026-10-02", "2026-10-07")
EXTRA_WORKDAYS = ("2026-10-10",)
CALENDARS: dict[int, dict[str, Any]] = {
    2026: {
        "year": 2026,
        "source_url": "https://example.invalid/calendar",
        "holidays": list(HOLIDAYS),
        "extra_workdays": list(EXTRA_WORKDAYS),
    }
}


def clock(minutes: int) -> time:
    """当日分钟数 → 时间；用于把输入同构地还原成期望值。"""

    return time(hour=minutes // 60, minute=minutes % 60)


def clock_text(minutes: int) -> str:
    return clock(minutes).isoformat(timespec="minutes")


def document(windows: list[tuple[int, int]], **overrides: Any) -> dict[str, Any]:
    config: dict[str, Any] = {
        "timezone": "Asia/Shanghai",
        "calendar_directory": "config/workday-calendars",
        "blocked_windows": [
            {"start": clock_text(start), "end": clock_text(end)} for start, end in windows
        ],
        "authorized_window": dict(AUTHORIZED_WINDOW),
    }
    config.update(overrides)
    return config


def windows_are_valid(windows: list[tuple[int, int]]) -> bool:
    """独立判据：按书写顺序有序，且每段起点不早于前一段终点（相等即相邻）。"""

    if not windows:
        return False
    if list(windows) != sorted(windows):
        return False
    return all(later[0] >= earlier[1] for earlier, later in itertools.pairwise(windows))


def expected_workday(day: date) -> bool:
    """独立判据：调休上班优先，其余按“工作日且非假日”。"""

    if day.isoformat() in EXTRA_WORKDAYS:
        return True
    return day.weekday() < 5 and day.isoformat() not in HOLIDAYS


@st.composite
def _shuffled(draw: st.DrawFn, items: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """按抽取的排序键重排：用于生成乱序的窗口列表（乱序按契约应被拒绝）。"""

    keys = draw(
        st.lists(st.integers(min_value=0, max_value=100), min_size=len(items), max_size=len(items))
    )
    order = sorted(range(len(items)), key=lambda index: (keys[index], index))
    return [items[index] for index in order]


@st.composite
def _any_window(draw: st.DrawFn) -> tuple[int, int]:
    start = draw(st.integers(min_value=0, max_value=MINUTES_PER_DAY - 2))
    return start, draw(st.integers(min_value=start + 1, max_value=MINUTES_PER_DAY - 1))


@st.composite
def _window_lists(draw: st.DrawFn) -> list[tuple[int, int]]:
    """锚点窗口 + 若干任意窗口：既有合法列表，也有乱序或重叠列表。"""

    extras = draw(st.lists(_any_window(), max_size=3))
    return draw(_shuffled([ANCHOR, *extras]))


@st.composite
def _valid_windows(draw: st.DrawFn) -> list[tuple[int, int]]:
    """按构造必然合法的窗口列表：锚点前后各可选一段，按起点有序书写。"""

    windows: list[tuple[int, int]] = [ANCHOR]
    if draw(st.booleans()):
        start = draw(st.integers(min_value=0, max_value=ANCHOR[0] - 2))
        end = draw(st.integers(min_value=start + 1, max_value=ANCHOR[0] - 1))
        windows.insert(0, (start, end))
    if draw(st.booleans()):
        start = draw(st.integers(min_value=ANCHOR[1] + 1, max_value=MINUTES_PER_DAY - 2))
        windows.append(
            (start, draw(st.integers(min_value=start + 1, max_value=MINUTES_PER_DAY - 1)))
        )
    return windows


@st.composite
def _late_authorized_windows(draw: st.DrawFn) -> tuple[int, int]:
    """终点严格晚于 10:00 的授权窗口（起点仍在同日之内）。"""

    end = draw(st.integers(min_value=10 * 60 + 1, max_value=MINUTES_PER_DAY - 1))
    return draw(st.integers(min_value=0, max_value=end - 1)), end


@st.composite
def _documents(draw: st.DrawFn) -> dict[str, Any]:
    config = document(draw(_valid_windows()))
    label = draw(st.one_of(st.none(), st.text(alphabet="abcde-_", min_size=1, max_size=6)))
    if label is not None:
        config["machine_label"] = label
    if draw(st.booleans()):
        config["enforce_work_hours"] = draw(st.booleans())
    if draw(st.booleans()):
        config["apply_authorized_window"] = draw(st.booleans())
    days = draw(
        st.lists(
            st.dates(min_value=date(2026, 1, 1), max_value=date(2026, 12, 31)),
            max_size=2,
            unique=True,
        )
    )
    if days:
        config["authorized_batches"] = [
            {"date": day.isoformat(), "authorization_source": "property batch"} for day in days
        ]
    return config


@st.composite
def _moment(draw: st.DrawFn) -> tuple[date, int, datetime]:
    day = draw(st.dates(min_value=date(2026, 1, 1), max_value=date(2026, 12, 31)))
    minute = draw(st.integers(min_value=0, max_value=MINUTES_PER_DAY - 1))
    return (
        day,
        minute,
        datetime(day.year, day.month, day.day, minute // 60, minute % 60, tzinfo=SHANGHAI),
    )


@given(_window_lists())
def test_windows_are_accepted_exactly_when_ordered_and_disjoint(
    windows: list[tuple[int, int]],
) -> None:
    config = document(windows)
    if not windows_are_valid(windows):
        with pytest.raises(ValueError):
            effective_commit_policy(config, CALENDARS)
        return

    policy = effective_commit_policy(config, CALENDARS)
    assert [(window.start, window.end) for window in policy.blocked_windows] == [
        (clock(start), clock(end)) for start, end in sorted(windows)
    ]


def test_touching_windows_are_adjacent_not_overlapping() -> None:
    # 前一段终点 == 后一段起点：独立判据视为合法，构造策略不得拒绝。
    windows = [(9 * 60, 12 * 60), (12 * 60, 13 * 60 + 30)]
    assert windows_are_valid(windows)
    policy = effective_commit_policy(document(windows), CALENDARS)
    assert [window.start for window in policy.blocked_windows] == [time(9, 0), time(12, 0)]


@given(_late_authorized_windows())
def test_authorized_window_cannot_end_later_than_ten(
    authorized: tuple[int, int],
) -> None:
    start, end = authorized
    config = document(
        [ANCHOR], authorized_window={"start": clock_text(start), "end": clock_text(end)}
    )
    with pytest.raises(ValueError):
        effective_commit_policy(config, CALENDARS)


@given(_documents())
def test_same_document_always_builds_an_equal_policy(config: dict[str, Any]) -> None:
    assert effective_commit_policy(config, CALENDARS) == effective_commit_policy(config, CALENDARS)


@given(_valid_windows(), _moment())
def test_decisions_follow_the_declared_windows(
    windows: list[tuple[int, int]], moment: tuple[date, int, datetime]
) -> None:
    day, minute, instant = moment
    policy = effective_commit_policy(document(windows), CALENDARS)
    decision = check_commit_time(instant, policy)

    in_window = any(start <= minute < end for start, end in windows)
    if not in_window:
        assert decision.allowed is True
        assert decision.reason == "outside_work_hours"
    elif expected_workday(day):
        assert decision.allowed is False
        assert decision.reason == "workday_work_hours"
    else:
        assert decision.allowed is True
        assert decision.reason == "non_workday"


@given(_moment())
def test_explicit_switch_off_allows_every_moment(moment: tuple[date, int, datetime]) -> None:
    _, _, instant = moment
    policy = effective_commit_policy(document([ANCHOR], enforce_work_hours=False), CALENDARS)
    decision = check_commit_time(instant, policy)
    assert decision.allowed is True
    assert decision.reason == "work_hours_not_enforced"


@given(_moment())
def test_empty_window_list_without_the_switch_disables_enforcement(
    moment: tuple[date, int, datetime],
) -> None:
    _, _, instant = moment
    policy = effective_commit_policy(document([]), CALENDARS)
    assert policy.enforce_work_hours is False
    decision = check_commit_time(instant, policy)
    assert decision.allowed is True
    assert decision.reason == "work_hours_not_enforced"


@given(_moment())
def test_switching_the_grace_window_off_cannot_bypass_the_blocked_window(
    moment: tuple[date, int, datetime],
) -> None:
    day, minute, instant = moment
    config = document(
        [ANCHOR],
        authorized_batches=[{"date": day.isoformat(), "authorization_source": "property batch"}],
        apply_authorized_window=False,
    )
    policy = effective_commit_policy(config, CALENDARS)
    decision = check_commit_time(instant, policy)

    in_window = ANCHOR[0] <= minute < ANCHOR[1]
    if not in_window:
        assert decision.allowed is True
        assert decision.reason == "outside_work_hours"
    elif expected_workday(day):
        # 当天虽已登记授权，关掉窄口后早间时段仍按工作时间窗口拒绝。
        assert decision.allowed is False
        assert decision.reason == "workday_work_hours"
    else:
        assert decision.allowed is True
        assert decision.reason == "non_workday"
