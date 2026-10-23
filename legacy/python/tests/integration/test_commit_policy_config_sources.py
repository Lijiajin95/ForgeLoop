"""生效配置的来源边界：真实文件系统上的候选路径、优先级、缺失与损坏。

规则（所有者决定）：仓库只发布模板 ``config/commit-policy.template.toml``；
实际生效的配置只从本机读取，按固定优先级二选一——仓库内未被版本控制的
``.cache/forgeloop/commit-policy.toml``，其次 ``~/.config/forgeloop/commit-policy.toml``。
两者都不存在时不执行提交时间禁止（放行），但配置存在而损坏、或年历目录缺失
仍按拒绝处理（失败关闭）。
"""

import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from forgeloop.adapter.commit_policy import (
    ORIGIN_REPOSITORY_LOCAL,
    ORIGIN_USER_LOCAL,
    PolicyDocuments,
    load_policy_documents,
    policy_config_candidates,
    select_policy_config,
)
from forgeloop.domain.commit_policy import (
    CommitPolicy,
    check_commit_time,
    effective_commit_policy,
)

ROOT = Path(__file__).resolve().parents[2]

CONFIG_TEMPLATE = """\
timezone = "Asia/Shanghai"
calendar_directory = "{calendars}"

[[blocked_windows]]
start = "{start}"
end = "{end}"

[authorized_window]
start = "09:00"
end = "09:55"
"""


def write_config(path: Path, *, start: str = "09:00", end: str = "12:00", calendars: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        CONFIG_TEMPLATE.format(calendars=calendars, start=start, end=end), encoding="utf-8"
    )
    return path


def shanghai(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 13, hour, minute, tzinfo=ZoneInfo("Asia/Shanghai"))


def effective_from(documents: PolicyDocuments) -> CommitPolicy:
    """从加载结果构造生效策略；没有生效配置直接判失败。"""

    assert documents.config is not None
    return effective_commit_policy(documents.config, documents.calendars)


def selected_path(repo: Path, home: Path) -> Path | None:
    """二选一后的生效配置路径；没有配置时为 ``None``。"""

    selected = select_policy_config(policy_config_candidates(repo, home))
    return None if selected is None else selected.path


class TestCandidateLayout:
    def test_candidates_are_ordered_repository_then_user(self, tmp_path: Path) -> None:
        candidates = policy_config_candidates(ROOT, tmp_path / "home")
        assert [candidate.origin for candidate in candidates] == [
            ORIGIN_REPOSITORY_LOCAL,
            ORIGIN_USER_LOCAL,
        ]
        assert candidates[0].path == ROOT / ".cache" / "forgeloop" / "commit-policy.toml"
        assert (
            candidates[1].path == tmp_path / "home" / ".config" / "forgeloop" / "commit-policy.toml"
        )

    def test_repository_local_config_is_ignored_by_git(self) -> None:
        result = subprocess.run(
            ["git", "check-ignore", "-v", ".cache/forgeloop/commit-policy.toml"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr

    def test_selection_picks_the_first_existing_candidate(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        home = tmp_path / "home"
        assert select_policy_config(policy_config_candidates(repo, home)) is None
        user = home / ".config" / "forgeloop" / "commit-policy.toml"
        user.parent.mkdir(parents=True, exist_ok=True)
        user.write_text('timezone = "Asia/Shanghai"\n', encoding="utf-8")
        assert selected_path(repo, home) == user
        local = write_config(
            repo / ".cache" / "forgeloop" / "commit-policy.toml",
            calendars=ROOT / "config" / "workday-calendars",
        )
        assert selected_path(repo, home) == local


class TestAbsentConfig:
    def test_no_config_anywhere_means_no_enforcement(self, tmp_path: Path) -> None:
        documents = load_policy_documents(tmp_path / "repo", home=tmp_path / "home")
        assert documents.has_policy is False
        assert documents.config is None
        assert documents.config_path is None
        assert documents.calendars == {}


class TestPriorityWithoutMerging:
    def test_repository_local_config_wins_and_is_not_merged_with_user_config(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "repo"
        home = tmp_path / "home"
        calendars = ROOT / "config" / "workday-calendars"
        write_config(
            home / ".config" / "forgeloop" / "commit-policy.toml",
            start="07:00",
            end="08:00",
            calendars=calendars,
        )
        local = write_config(
            repo / ".cache" / "forgeloop" / "commit-policy.toml", calendars=calendars
        )

        documents = load_policy_documents(repo, home=home)
        assert documents.config_path == local
        assert documents.origin == ORIGIN_REPOSITORY_LOCAL
        policy = effective_from(documents)
        assert not check_commit_time(shanghai(9, 30), policy).allowed
        assert check_commit_time(shanghai(7, 30), policy).allowed

    def test_user_config_is_used_when_repository_local_is_absent(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        home = tmp_path / "home"
        user = write_config(
            home / ".config" / "forgeloop" / "commit-policy.toml",
            calendars=ROOT / "config" / "workday-calendars",
        )
        documents = load_policy_documents(repo, home=home)
        assert documents.config_path == user
        assert documents.origin == ORIGIN_USER_LOCAL
        policy = effective_from(documents)
        assert not check_commit_time(shanghai(9, 30), policy).allowed


class TestFailClosedBoundaries:
    def test_corrupt_config_is_rejected(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        broken = repo / ".cache" / "forgeloop" / "commit-policy.toml"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("timezone = \n", encoding="utf-8")
        with pytest.raises(ValueError):
            load_policy_documents(repo, home=tmp_path / "home")

    def test_legacy_override_path_is_rejected_instead_of_silently_ignored(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "repo"
        legacy = repo / ".cache" / "forgeloop" / "commit-policy.local.toml"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('timezone = "Asia/Shanghai"\n', encoding="utf-8")
        with pytest.raises(ValueError, match="Legacy commit policy override"):
            load_policy_documents(repo, home=tmp_path / "home")

    def test_stale_legacy_file_is_tolerated_once_a_current_config_exists(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "repo"
        calendars = ROOT / "config" / "workday-calendars"
        write_config(repo / ".cache" / "forgeloop" / "commit-policy.toml", calendars=calendars)
        legacy = repo / ".cache" / "forgeloop" / "commit-policy.local.toml"
        legacy.write_text('timezone = "Asia/Shanghai"\n', encoding="utf-8")
        documents = load_policy_documents(repo, home=tmp_path / "home")
        assert documents.has_policy is True

    def test_missing_calendar_directory_blocks_inside_and_allows_outside(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "repo"
        write_config(
            repo / ".cache" / "forgeloop" / "commit-policy.toml",
            calendars=tmp_path / "no-such-calendars",
        )
        documents = load_policy_documents(repo, home=tmp_path / "home")
        assert documents.calendars == {}
        policy = effective_from(documents)
        assert check_commit_time(shanghai(9, 30), policy).reason == "calendar_missing"
        assert check_commit_time(shanghai(19, 0), policy).allowed

    def test_malformed_calendar_is_rejected(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        calendars = repo / "calendars"
        calendars.mkdir(parents=True)
        (calendars / "2026.json").write_text(
            '{"year": 2026, "source_url": "http://example.invalid", "holidays": [], "extra_workdays": []}',
            encoding="utf-8",
        )
        write_config(repo / ".cache" / "forgeloop" / "commit-policy.toml", calendars=calendars)
        with pytest.raises(ValueError):
            load_policy_documents(repo, home=tmp_path / "home")

    def test_relative_calendar_directory_resolves_against_the_repository_root(
        self, tmp_path: Path
    ) -> None:
        repo = tmp_path / "repo"
        (repo / "my-calendars").mkdir(parents=True)
        (repo / "my-calendars" / "2026.json").write_text(
            '{"year": 2026, "source_url": "https://example.invalid",'
            ' "holidays": ["2026-10-13"], "extra_workdays": []}',
            encoding="utf-8",
        )
        write_config(
            repo / ".cache" / "forgeloop" / "commit-policy.toml",
            calendars=Path("my-calendars"),
        )
        documents = load_policy_documents(repo, home=tmp_path / "home")
        assert 2026 in documents.calendars
        policy = effective_from(documents)
        # 2026-10-13 在该年历中是假日：窗口内也放行。
        assert check_commit_time(shanghai(9, 30), policy).reason == "non_workday"
