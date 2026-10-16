"""集成测试：本地覆盖发现、二选一优先级与生效策略的真实文件系统行为。

与单元/属性测试的分工：这里不注入内存映射，而是把仓库真实的
``config/commit-policy.toml`` 与 ``config/workday-calendars/*.json`` 复制到临时
仓库，用真实 TOML 文件、真实 ``ZoneInfo("Asia/Shanghai")``、真实
``datetime.now`` 与真实 ``git check-ignore`` 验证加载、优先级唯一性、
Mac/Debian 分化、无覆盖时的默认行为与授权窄口不变。
"""

import json
import shutil
import subprocess
from datetime import UTC, date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from forgeloop.adapter.commit_policy import (
    ORIGIN_REPOSITORY_LOCAL,
    ORIGIN_USER_LOCAL,
    REPOSITORY_LOCAL_OVERRIDE_RELATIVE,
    USER_LOCAL_OVERRIDE_RELATIVE,
    PolicyDocuments,
    load_calendars,
    load_policy_documents,
    local_override_candidates,
    select_local_override,
)
from forgeloop.domain.commit_policy import (
    BlockedWindow,
    CommitDecision,
    CommitPolicy,
    CommitPolicySource,
    check_commit_time,
    effective_commit_policy,
)

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = ZoneInfo("Asia/Shanghai")

MAC_OVERRIDE = """
machine_label = "mac-laptop"
blocked_windows = [
  { start = "09:00", end = "12:00" },
  { start = "13:30", end = "18:00" },
]
"""

DEBIAN_OVERRIDE = """
machine_label = "debian-server"
enforce_work_hours = false
"""


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """真实仓库布局：把随仓库发布的 config/ 原样复制到临时仓库根。"""

    shutil.copytree(ROOT / "config", tmp_path / "config")
    return tmp_path


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    directory = tmp_path / "home"
    directory.mkdir()
    return directory


def write_override(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def effective(docs: PolicyDocuments) -> CommitPolicy:
    return effective_commit_policy(docs.default, docs.override, docs.calendars)


def on(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI)


class TestNoLocalOverride:
    def test_absent_override_files_use_repository_default(self, repo: Path, home: Path) -> None:
        docs = load_policy_documents(repo, home=home)
        assert docs.has_local_override is False
        assert docs.override is None
        assert docs.override_path is None
        assert docs.override_origin is None
        assert docs.default["authorized_window"] == {"start": "09:00", "end": "09:55"}
        assert 2026 in docs.calendars

        policy = effective(docs)
        assert policy.source is CommitPolicySource.REPOSITORY_DEFAULT
        assert policy.machine_label is None
        assert check_commit_time(on(12, 10, 0), policy) == CommitDecision(
            False, "workday_work_hours"
        )
        assert check_commit_time(on(12, 12, 30), policy).reason == "outside_work_hours"

    def test_default_policy_is_reproducible_across_loads(self, repo: Path, home: Path) -> None:
        loaded = effective(load_policy_documents(repo, home=home))
        direct = effective(load_policy_documents(repo, home=home))
        for moment in (on(12, 9, 30), on(12, 12, 0), on(12, 17, 30), on(12, 18, 0), on(13, 9, 30)):
            assert check_commit_time(moment, loaded) == check_commit_time(moment, direct)

    def test_debian_allows_at_the_real_wall_clock(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)
        policy = effective(load_policy_documents(repo, home=home))
        decision = check_commit_time(datetime.now(SHANGHAI), policy)
        assert decision.allowed is True
        assert decision.reason == "work_hours_not_enforced"
        assert decision.machine_label == "debian-server"


class TestOverridePriority:
    def test_candidates_are_ordered_repository_local_then_user_local(
        self, repo: Path, home: Path
    ) -> None:
        candidates = local_override_candidates(repo, home)
        assert [candidate.origin for candidate in candidates] == [
            ORIGIN_REPOSITORY_LOCAL,
            ORIGIN_USER_LOCAL,
        ]
        assert candidates[0].path == repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE
        assert candidates[1].path == home / USER_LOCAL_OVERRIDE_RELATIVE

    def test_select_returns_none_when_no_candidate_exists(self, repo: Path, home: Path) -> None:
        assert select_local_override(local_override_candidates(repo, home)) is None

    def test_repository_local_wins_when_both_sources_exist(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, MAC_OVERRIDE)
        write_override(home / USER_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)

        docs = load_policy_documents(repo, home=home)
        assert docs.override_origin == ORIGIN_REPOSITORY_LOCAL
        assert docs.override_path == repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE
        # 低优先级文件即使存在也不参与合并：不得出现 Debian 的开关。
        assert docs.override is not None
        assert docs.override["machine_label"] == "mac-laptop"
        assert "enforce_work_hours" not in docs.override

    def test_user_local_is_used_when_repository_local_is_absent(
        self, repo: Path, home: Path
    ) -> None:
        write_override(home / USER_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)
        docs = load_policy_documents(repo, home=home)
        assert docs.override_origin == ORIGIN_USER_LOCAL
        assert docs.override_path == home / USER_LOCAL_OVERRIDE_RELATIVE
        assert docs.override is not None
        assert docs.override["machine_label"] == "debian-server"

    def test_resolution_is_unique_and_reproducible(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, MAC_OVERRIDE)
        write_override(home / USER_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)
        first = load_policy_documents(repo, home=home)
        second = load_policy_documents(repo, home=home)
        assert first.override_origin == second.override_origin == ORIGIN_REPOSITORY_LOCAL
        assert first.override == second.override
        assert effective(first) == effective(second)

    def test_repository_local_override_is_ignored_by_git(self) -> None:
        # 本地覆盖的仓库内位置在 .cache/ 下，真实 git 判定为忽略、不进入版本控制。
        result = subprocess.run(
            ["git", "check-ignore", "--quiet", REPOSITORY_LOCAL_OVERRIDE_RELATIVE.as_posix()],
            cwd=ROOT,
            check=False,
        )
        assert result.returncode == 0

    def test_user_local_override_is_resolved_under_home(self, tmp_path: Path) -> None:
        home = tmp_path / "elsewhere"
        candidate = local_override_candidates(ROOT, home)[1]
        assert candidate.path == home / USER_LOCAL_OVERRIDE_RELATIVE
        assert not candidate.path.is_relative_to(ROOT)


class TestMachineDivergenceOnRealFiles:
    def test_same_instant_blocks_on_mac_and_allows_on_debian(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, MAC_OVERRIDE)
        mac = effective(load_policy_documents(repo, home=home))

        (repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE).unlink()
        write_override(home / USER_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)
        debian = effective(load_policy_documents(repo, home=home))

        instant = on(12, 10, 0)
        assert check_commit_time(instant, mac) == CommitDecision(
            False, "workday_work_hours", None, CommitPolicySource.LOCAL_OVERRIDE, "mac-laptop"
        )
        assert check_commit_time(instant, debian) == CommitDecision(
            True,
            "work_hours_not_enforced",
            None,
            CommitPolicySource.LOCAL_OVERRIDE,
            "debian-server",
        )

    def test_timezone_conversion_preserves_the_divergence(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, MAC_OVERRIDE)
        mac = effective(load_policy_documents(repo, home=home))
        (repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE).unlink()
        write_override(home / USER_LOCAL_OVERRIDE_RELATIVE, DEBIAN_OVERRIDE)
        debian = effective(load_policy_documents(repo, home=home))

        # 2026-10-12T02:00Z == 上海 10:00，同一物理时刻按策略时区换算。
        instant = datetime(2026, 10, 12, 2, 0, tzinfo=UTC)
        assert check_commit_time(instant, mac).allowed is False
        assert check_commit_time(instant, debian).allowed is True


class TestRealWorkdayCalendar:
    def test_holiday_extra_workday_and_regular_workday(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, MAC_OVERRIDE)
        policy = effective(load_policy_documents(repo, home=home))

        # 2026-10-01 国庆假日 10:00：真实调休表判为非工作日，放行。
        assert check_commit_time(on(1, 10, 0), policy).reason == "non_workday"
        # 2026-10-10 周六调休上班 10:00：真实调休表判为工作日，禁止。
        assert check_commit_time(on(10, 10, 0), policy).reason == "workday_work_hours"
        # 2026-10-12 周一 10:00：常规工作日，禁止。
        assert check_commit_time(on(12, 10, 0), policy).reason == "workday_work_hours"


class TestAuthorizationUnchangedByLocalOverride:
    def test_grace_window_and_hard_cap_are_unchanged(self, repo: Path, home: Path) -> None:
        write_override(repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE, 'machine_label = "mac-laptop"\n')
        policy = effective(load_policy_documents(repo, home=home))

        assert policy.authorized_window == BlockedWindow(time(9, 0), time(9, 55))
        assert date(2026, 10, 13) in policy.authorized_dates
        assert check_commit_time(on(13, 9, 0), policy).reason == "authorized_grace_window"
        assert check_commit_time(on(13, 9, 54), policy).reason == "authorized_grace_window"
        # 09:55（不含）与 10:00 硬上限在真实授权批次上仍生效。
        assert check_commit_time(on(13, 9, 55), policy).reason == "authorized_window_elapsed"
        assert check_commit_time(on(13, 10, 0), policy).reason == "authorized_window_elapsed"
        assert check_commit_time(on(13, 14, 0), policy).reason == "authorized_window_elapsed"
        assert check_commit_time(on(12, 9, 30), policy).reason == "workday_work_hours"

    def test_local_override_cannot_declare_authorization_entries(
        self, repo: Path, home: Path
    ) -> None:
        write_override(
            repo / REPOSITORY_LOCAL_OVERRIDE_RELATIVE,
            'authorized_window = { start = "09:00", end = "09:55" }\n',
        )
        docs = load_policy_documents(repo, home=home)
        with pytest.raises(ValueError, match="may not declare"):
            effective(docs)


class TestRealCalendarLoading:
    def test_duplicate_calendar_year_is_rejected(self, repo: Path) -> None:
        directory = repo / "config" / "workday-calendars"
        (directory / "duplicate.json").write_text(
            json.dumps(
                {
                    "year": 2026,
                    "source_url": "https://example.test/calendar",
                    "holidays": [],
                    "extra_workdays": [],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="duplicate"):
            load_calendars(directory)

    def test_insecure_calendar_source_is_rejected(self, repo: Path) -> None:
        directory = repo / "config" / "workday-calendars"
        (directory / "insecure.json").write_text(
            json.dumps(
                {
                    "year": 2027,
                    "source_url": "http://example.test/calendar",
                    "holidays": [],
                    "extra_workdays": [],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="source"):
            load_calendars(directory)
