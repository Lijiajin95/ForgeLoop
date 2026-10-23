"""组件测试：提交策略命令的审计输出、真实历史审计与未强制/未迁移分支。

本文件覆盖命令边界（``forgeloop.cli.commit_policy`` 的公共入口）：

- 放行/拒绝审计如实带出生效配置路径、机器标签、命中时间窗与客户端边界表述；
- ``--check-now`` / ``--audit`` / ``--validate-config`` 的退出码与 stdout/stderr 归属；
- 没有生效配置时放行但显式标注 ``policy_absent`` 与 NOT enforced，且不虚构命中窗口；
- 旧路径 ``commit-policy.local.toml`` 未迁移、配置损坏、年历重复年份仍然失败关闭；
- 消息头 Conventional Commits 校验与配置无关，始终执行；
- 真实仓库里 ``scripts/check_commit_policy.py`` 可被子进程导入并运行。

测试策略：生效配置一律写在临时仓库里（真实 TOML 与真实年历文件）；``check_now``
读真实时钟，用模块内 ``datetime`` 替身固定到明确时刻，不依赖运行当天；命令入口
通过替换 ``load_policy_context`` 指向临时仓库，避免读到本机 ``~/.config`` 或
``.cache`` 下的配置。
"""

import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

import forgeloop.cli.commit_policy as commit_policy
from forgeloop.cli.commit_policy import (
    CLIENT_SIDE_NOTE,
    INSTALL_PATHS,
    NOT_ENFORCED_NOTE,
    PolicyContext,
    allow_line,
    block_line,
    hit_blocked_window,
    load_policy,
    load_policy_context,
)
from forgeloop.domain.commit_policy import CommitPolicy, check_commit_time

ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = ZoneInfo("Asia/Shanghai")
WINDOWS = (("09:00", "12:00"), ("13:30", "18:00"))
CONFIG_RELATIVE = Path(".cache/forgeloop/commit-policy.toml")
LEGACY_RELATIVE = Path(".cache/forgeloop/commit-policy.local.toml")

pytestmark = pytest.mark.component


def write_policy_config(
    repo: Path,
    *,
    machine_label: str | None = None,
    enforce_work_hours: bool | None = None,
    apply_authorized_window: bool | None = None,
    authorized_date: str | None = None,
) -> Path:
    """按模板形态写一份真实生效配置，返回其路径。"""

    lines = [
        'timezone = "Asia/Shanghai"',
        'calendar_directory = "config/workday-calendars"',
    ]
    if machine_label is not None:
        lines.append(f'machine_label = "{machine_label}"')
    if enforce_work_hours is not None:
        lines.append(f"enforce_work_hours = {str(enforce_work_hours).lower()}")
    if apply_authorized_window is not None:
        lines.append(f"apply_authorized_window = {str(apply_authorized_window).lower()}")
    for start, end in WINDOWS:
        lines += ["", "[[blocked_windows]]", f'start = "{start}"', f'end = "{end}"']
    lines += ["", "[authorized_window]", 'start = "09:00"', 'end = "09:55"']
    if authorized_date is not None:
        lines += [
            "",
            "[[authorized_batches]]",
            f'date = "{authorized_date}"',
            'authorization_source = "component test batch"',
        ]
    path = repo / CONFIG_RELATIVE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    """临时仓库根：携带真实年历文件，但默认没有生效配置。"""

    root = tmp_path / "repo"
    shutil.copytree(ROOT / "config" / "workday-calendars", root / "config" / "workday-calendars")
    return root


@pytest.fixture()
def home(tmp_path: Path) -> Path:
    """模拟用户主目录：不含 ``~/.config/forgeloop`` 配置。"""

    return tmp_path / "home"


def point_at(monkeypatch: pytest.MonkeyPatch, repo: Path, home: Path) -> None:
    """让命令入口从临时仓库加载生效配置（保留真实 IO 与加载期报错）。"""

    real_loader = commit_policy.load_policy_context
    monkeypatch.setattr(commit_policy, "load_policy_context", lambda: real_loader(repo, home=home))


def loaded_policy(repo: Path, home: Path) -> tuple[CommitPolicy, PolicyContext]:
    """读取临时仓库的生效策略与审计上下文；配置缺失直接判失败。"""

    context = load_policy_context(repo, home=home)
    assert context.policy is not None
    return context.policy, context


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI)


def freeze(monkeypatch: pytest.MonkeyPatch, moment: datetime) -> None:
    """把模块内 ``datetime.now`` 固定到给定时刻（真实时钟只影响本机放行）。"""

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:
            return moment

    monkeypatch.setattr(commit_policy, "datetime", FrozenDatetime)


class TestAuditText:
    def test_block_line_names_the_effective_config_and_hit_window(
        self, repo: Path, home: Path
    ) -> None:
        path = write_policy_config(repo)
        policy, context = loaded_policy(repo, home)
        moment = at(12, 10)  # 2026-10-12 周一 10:00，工作日禁止窗口内。
        decision = check_commit_time(moment, policy)
        line = block_line(context, decision, moment)

        assert decision.allowed is False
        assert decision.reason == "workday_work_hours"
        assert "Commit blocked" in line
        assert "hit window 09:00-12:00" in line
        assert str(path) in line
        assert "repository_local" in line
        assert "machine label (none)" in line
        assert CLIENT_SIDE_NOTE in line
        # 单份生效配置：不再出现“仓库默认/本地覆盖”的来源标注。
        assert "(repository default)" not in line
        assert "(local override)" not in line

    def test_machine_label_is_rendered(self, repo: Path, home: Path) -> None:
        write_policy_config(repo, machine_label="mac-laptop")
        policy, context = loaded_policy(repo, home)
        moment = at(12, 10)
        line = block_line(context, check_commit_time(moment, policy), moment)

        assert "machine label mac-laptop" in line

    def test_authorized_window_elapsed_names_the_blocked_window(
        self, repo: Path, home: Path
    ) -> None:
        write_policy_config(repo, authorized_date="2026-10-12")
        policy, context = loaded_policy(repo, home)
        moment = at(12, 10)  # 授权日已过 09:55 窄口，按工作时间窗口拒绝。
        decision = check_commit_time(moment, policy)
        line = block_line(context, decision, moment)

        assert decision.allowed is False
        assert decision.reason == "authorized_window_elapsed"
        assert "hit window 09:00-12:00" in line

    def test_grace_window_is_allowed_and_reported(self, repo: Path, home: Path) -> None:
        write_policy_config(repo, authorized_date="2026-10-12")
        policy, context = loaded_policy(repo, home)
        moment = at(12, 9, 30)
        decision = check_commit_time(moment, policy)
        line = allow_line(context, decision, moment)

        assert decision.allowed is True
        assert decision.reason == "authorized_grace_window"
        assert "Commit allowed" in line
        assert "decision authorized_grace_window" in line

    def test_outside_window_is_allowed(self, repo: Path, home: Path) -> None:
        write_policy_config(repo)
        policy, context = loaded_policy(repo, home)
        moment = at(12, 12, 30)  # 午间可提交时段。
        decision = check_commit_time(moment, policy)
        line = allow_line(context, decision, moment)

        assert decision.allowed is True
        assert decision.reason == "outside_work_hours"
        assert CLIENT_SIDE_NOTE in line

    def test_switching_work_hours_off_allows_and_labels_the_machine(
        self, repo: Path, home: Path
    ) -> None:
        # 显式声明 enforce_work_hours = false 的机器（如 Debian）全时间段允许。
        write_policy_config(repo, machine_label="debian-server", enforce_work_hours=False)
        policy, context = loaded_policy(repo, home)
        moment = at(12, 10)
        decision = check_commit_time(moment, policy)
        line = allow_line(context, decision, moment)

        assert decision.allowed is True
        assert decision.reason == "work_hours_not_enforced"
        assert "machine label debian-server" in line

    def test_disabling_the_grace_window_keeps_blocking_authorized_dates(
        self, repo: Path, home: Path
    ) -> None:
        # 关掉授权窄口只停用放行，不移动、也不加宽 09:00-12:00 禁止窗口。
        write_policy_config(repo, authorized_date="2026-10-12", apply_authorized_window=False)
        policy, context = loaded_policy(repo, home)
        moment = at(12, 9, 30)
        decision = check_commit_time(moment, policy)
        line = block_line(context, decision, moment)

        assert decision.allowed is False
        assert decision.reason == "workday_work_hours"
        assert "hit window 09:00-12:00" in line

    def test_shipped_calendar_marks_holidays_and_extra_workdays(
        self, repo: Path, home: Path
    ) -> None:
        write_policy_config(repo)
        policy, _ = loaded_policy(repo, home)

        # 2026-10-01 国庆假日：窗口内也放行。
        holiday = at(1, 10, 0)
        assert check_commit_time(holiday, policy).reason == "non_workday"
        # 2026-10-10 周六调休上班：窗口内拒绝。
        extra_workday = at(10, 10, 0)
        assert check_commit_time(extra_workday, policy).reason == "workday_work_hours"


class TestWindowLookup:
    def test_outside_all_windows_returns_none(self, repo: Path, home: Path) -> None:
        write_policy_config(repo)
        policy, _ = loaded_policy(repo, home)

        assert hit_blocked_window(policy, at(12, 12, 30)) is None
        window = hit_blocked_window(policy, at(12, 9, 30))
        assert window is not None
        assert (window.start.hour, window.start.minute) == (9, 0)
        assert (window.end.hour, window.end.minute) == (12, 0)


class TestCheckNow:
    def test_blocks_inside_window_and_names_the_effective_config(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        path = write_policy_config(repo)
        point_at(monkeypatch, repo, home)
        freeze(monkeypatch, at(12, 10))

        assert commit_policy.main(["--check-now"]) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert "Commit blocked" in captured.err
        assert "hit window 09:00-12:00" in captured.err
        assert f"effective policy {path} repository_local" in captured.err
        assert CLIENT_SIDE_NOTE in captured.err

    def test_allows_outside_the_window(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        write_policy_config(repo)
        point_at(monkeypatch, repo, home)
        freeze(monkeypatch, at(12, 12, 30))

        assert commit_policy.main(["--check-now"]) == 0
        captured = capsys.readouterr()
        assert "Commit allowed" in captured.out
        assert "outside_work_hours" in captured.out
        assert captured.err == ""

    def test_reminds_to_maintain_a_missing_calendar_year(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        write_policy_config(repo)
        point_at(monkeypatch, repo, home)
        freeze(monkeypatch, datetime(2027, 1, 1, 20, 0, tzinfo=SHANGHAI))

        assert commit_policy.main(["--check-now"]) == 0
        captured = capsys.readouterr()
        assert "Commit allowed" in captured.out
        assert "Maintain the workday calendar for 2027." in captured.err

    def test_absent_config_allows_without_a_hit_window(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        point_at(monkeypatch, repo, home)

        # 无配置分支不读时钟，这里无需固定时刻。
        assert commit_policy.main(["--check-now"]) == 0
        captured = capsys.readouterr()
        assert "policy_absent" in captured.out
        assert NOT_ENFORCED_NOTE in captured.out
        assert "hit window" not in captured.out + captured.err
        assert captured.err == ""

    def test_legacy_override_path_blocks_until_migrated(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        legacy = repo / LEGACY_RELATIVE
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('timezone = "Asia/Shanghai"\n', encoding="utf-8")
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--check-now"]) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert "Commit policy check failed" in captured.err
        assert "Legacy commit policy override" in captured.err
        assert str(legacy) in captured.err
        assert "migrate" in captured.err

    def test_corrupt_config_fails_closed(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        broken = repo / CONFIG_RELATIVE
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("timezone = \n", encoding="utf-8")
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--check-now"]) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert "Commit policy check failed" in captured.err

    def test_missing_calendar_year_blocks_inside_the_window(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # 年历目录缺失不是“没有配置”：窗口内仍按 calendar_missing 失败关闭。
        path = write_policy_config(repo)
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace("config/workday-calendars", "missing-calendars"), encoding="utf-8"
        )
        point_at(monkeypatch, repo, home)
        freeze(monkeypatch, at(12, 10))

        assert commit_policy.main(["--check-now"]) == 1
        captured = capsys.readouterr()
        assert "calendar_missing" in captured.err
        assert "hit window 09:00-12:00" in captured.err


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def init_repository(repo: Path) -> None:
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "tester@example.test")
    run_git(repo, "config", "user.name", "Tester")


def commit(repo: Path, message: str, when: str) -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Tester",
        "GIT_AUTHOR_EMAIL": "tester@example.test",
        "GIT_COMMITTER_NAME": "Tester",
        "GIT_COMMITTER_EMAIL": "tester@example.test",
        "GIT_AUTHOR_DATE": when,
        "GIT_COMMITTER_DATE": when,
    }
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )


@pytest.fixture()
def history(repo: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """真实 git 历史：放行提交、窗口内提交、非法消息头各一条。"""

    init_repository(repo)
    commit(repo, "feat: allowed commit", "2026-10-12T12:30:00+08:00")
    commit(repo, "feat: blocked commit", "2026-10-12T10:00:00+08:00")
    commit(repo, "not a conventional header", "2026-10-12T12:30:00+08:00")
    monkeypatch.setattr(commit_policy, "ROOT", repo)
    return repo


@pytest.fixture()
def clean_history(repo: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """真实 git 历史：只有一条落在禁止窗口内的合法提交。"""

    init_repository(repo)
    commit(repo, "feat: inside the window", "2026-10-12T09:30:00+08:00")
    monkeypatch.setattr(commit_policy, "ROOT", repo)
    return repo


class TestAuditCommand:
    def test_reports_every_commit_and_rejects(
        self,
        history: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        write_policy_config(history)
        point_at(monkeypatch, history, home)

        assert commit_policy.main(["--audit", "0", "HEAD"]) == 1
        captured = capsys.readouterr()
        assert "Allowed commit" in captured.out
        assert "outside_work_hours" in captured.out
        assert "Rejected commit" in captured.err
        assert "hit window 09:00-12:00" in captured.err
        assert "message" in captured.err
        assert CLIENT_SIDE_NOTE in captured.out

    def test_clean_history_passes(
        self,
        clean_history: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        write_policy_config(clean_history, authorized_date="2026-10-12")
        point_at(monkeypatch, clean_history, home)

        assert commit_policy.main(["--audit", "0", "HEAD"]) == 0
        captured = capsys.readouterr()
        assert "Allowed commit" in captured.out
        assert "authorized_grace_window" in captured.out
        assert captured.err == ""

    def test_absent_config_allows_timestamps_but_rejects_bad_headers(
        self,
        history: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        point_at(monkeypatch, history, home)  # 不写任何生效配置。

        assert commit_policy.main(["--audit", "0", "HEAD"]) == 1
        captured = capsys.readouterr()
        # 两条合法消息各自核对作者与提交者时间，均按 policy_absent 放行。
        assert captured.out.count("Allowed commit") == 4
        assert "policy_absent" in captured.out
        assert NOT_ENFORCED_NOTE in captured.out
        assert captured.err.count("Rejected commit") == 1
        assert "message" in captured.err
        assert "hit window" not in captured.out + captured.err

    def test_absent_config_passes_a_clean_history_inside_the_window(
        self,
        clean_history: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        point_at(monkeypatch, clean_history, home)

        assert commit_policy.main(["--audit", "0", "HEAD"]) == 0
        captured = capsys.readouterr()
        assert "policy_absent" in captured.out
        assert NOT_ENFORCED_NOTE in captured.out
        assert captured.err == ""

    def test_legacy_override_path_fails_closed(
        self,
        history: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        legacy = history / LEGACY_RELATIVE
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('timezone = "Asia/Shanghai"\n', encoding="utf-8")
        point_at(monkeypatch, history, home)

        assert commit_policy.main(["--audit", "0", "HEAD"]) == 1
        captured = capsys.readouterr()
        assert "Allowed commit" not in captured.out
        assert "Commit policy check failed" in captured.err
        assert "Legacy commit policy override" in captured.err


class TestMessageMode:
    def test_valid_header_passes_without_any_config(
        self,
        tmp_path: Path,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        message = tmp_path / "message.txt"
        message.write_text("feat: valid header\n", encoding="utf-8")
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--message", str(message)]) == 0
        assert capsys.readouterr().err == ""

    def test_invalid_header_fails_without_any_config(
        self,
        tmp_path: Path,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # 消息头校验与配置无关：没有生效配置也必须拒绝。
        message = tmp_path / "message.txt"
        message.write_text("random message\n", encoding="utf-8")
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--message", str(message)]) == 1
        assert "Commit policy check failed" in capsys.readouterr().err


class TestValidateConfig:
    def test_absent_config_prints_the_install_paths(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--validate-config"]) == 0
        captured = capsys.readouterr()
        assert "No commit policy configured" in captured.out
        assert "NOT enforced" in captured.out
        assert INSTALL_PATHS in captured.out
        assert CLIENT_SIDE_NOTE in captured.out
        assert captured.err == ""

    def test_present_config_prints_path_label_years_and_batches(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        path = write_policy_config(repo, machine_label="mac-laptop", authorized_date="2026-10-12")
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--validate-config"]) == 0
        out = capsys.readouterr().out
        years = sorted(
            int(entry.stem) for entry in (repo / "config" / "workday-calendars").glob("*.json")
        )
        assert "Commit policy valid" in out
        assert f"effective policy {path} repository_local" in out
        assert "machine label mac-laptop" in out
        assert f"maintained years: {years}" in out
        assert "authorized batches: [datetime.date(2026, 10, 12)]" in out

    def test_duplicate_calendar_year_fails_closed(
        self,
        repo: Path,
        home: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        write_policy_config(repo)
        calendars = repo / "config" / "workday-calendars"
        (calendars / "2026-copy.json").write_text(
            (calendars / "2026.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
        point_at(monkeypatch, repo, home)

        assert commit_policy.main(["--validate-config"]) == 1
        captured = capsys.readouterr()
        assert "Commit policy check failed" in captured.err
        assert "duplicate" in captured.err


class TestLoadPolicy:
    def test_returns_none_without_config(self, repo: Path, home: Path) -> None:
        assert load_policy(repo, home=home) is None

    def test_returns_the_effective_policy(self, repo: Path, home: Path) -> None:
        write_policy_config(repo, machine_label="mac-laptop")
        policy = load_policy(repo, home=home)

        assert policy is not None
        assert policy.machine_label == "mac-laptop"
        assert policy.authorized_dates == frozenset()


class TestResolveRevision:
    def test_invalid_git_output_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        class Result:
            stdout = "not-a-commit\n"

        monkeypatch.setattr(commit_policy.subprocess, "run", lambda *args, **kwargs: Result())

        with pytest.raises(ValueError, match="invalid commit"):
            commit_policy.resolve_revision("HEAD")


class TestSubprocessEntryPoint:
    def test_script_imports_without_orchestration_dependencies(self) -> None:
        # 复现 CI commit-policy 作业：`-S` 关闭 site-packages 后，转发脚本仍可导入。
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-c",
                "import runpy; module = runpy.run_path('scripts/check_commit_policy.py', "
                "run_name='not_main'); "
                "print(callable(module['main']), callable(module['load_policy']))",
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(ROOT / "src")},
        )
        assert result.stdout.strip() == "True True"

    def test_script_runs_validate_config_as_a_process(self, tmp_path: Path) -> None:
        # 真实仓库直接运行转发脚本：本机无配置时也必须成功并如实报告未强制。
        home = tmp_path / "home"
        home.mkdir()
        result = subprocess.run(
            [sys.executable, "scripts/check_commit_policy.py", "--validate-config"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(ROOT / "src"), "HOME": str(home)},
        )
        assert result.returncode == 0, result.stderr
        assert result.stderr == ""
        assert result.stdout.startswith(("Commit policy valid", "No commit policy configured"))
