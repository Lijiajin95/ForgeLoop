"""组件测试：提交策略的放行/拒绝审计输出如实带出生效来源与命中时间窗。

验收要点：
- 每次放行或拒绝都记录生效策略来源（仓库默认/本地覆盖）与机器标签；
- 拒绝原因包含命中的时间窗，以及该时间窗来自仓库默认还是本地覆盖；
- 文案明确是客户端限制，不用“服务端强制”的表述；
- 轻量钩子/审计入口在无编排依赖的环境里仍可导入。

测试策略：
- 审计渲染用内存映射直接构造（不读真实本机覆盖），断言公共审计文案；
- 命令入口、真实时钟与 git 历史审计通过姿态替身或临时 git 仓库验证外部边界；
- 随仓库发布配置一律用 ``config/`` 的临时副本加载，避免读到本机本地覆盖。
"""

import os
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

import forgeloop.cli.commit_policy as commit_policy
from forgeloop.adapter.commit_policy import PolicyDocuments
from forgeloop.cli.commit_policy import (
    CLIENT_SIDE_NOTE,
    PolicyContext,
    allow_line,
    block_line,
    check_now,
    hit_blocked_window,
    load_policy,
    load_policy_context,
    validate_config,
)
from forgeloop.domain.commit_policy import (
    CommitPolicySource,
    check_commit_time,
    effective_commit_policy,
)

ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = ZoneInfo("Asia/Shanghai")

pytestmark = pytest.mark.component


def repository_default() -> dict[str, Any]:
    return {
        "timezone": "Asia/Shanghai",
        "calendar_directory": "config/workday-calendars",
        "blocked_windows": [
            {"start": "09:00", "end": "12:00"},
            {"start": "13:30", "end": "18:00"},
        ],
        "authorized_window": {"start": "09:00", "end": "09:55"},
        "authorized_batches": [{"date": "2026-10-13", "authorization_source": "S1"}],
    }


def calendars() -> dict[int, Mapping[str, Any]]:
    return {2026: {"year": 2026, "holidays": ["2026-10-01"], "extra_workdays": ["2026-10-10"]}}


def context(override: dict[str, Any] | None = None) -> PolicyContext:
    default = repository_default()
    documents = PolicyDocuments(
        default_path=Path("/repo/config/commit-policy.toml"),
        default=default,
        calendars=calendars(),
        override_path=Path("/repo/.cache/forgeloop/commit-policy.local.toml")
        if override is not None
        else None,
        override=override,
        override_origin="repository_local" if override is not None else None,
    )
    return PolicyContext(effective_commit_policy(default, override, calendars()), documents)


def at(day: int = 12, hour: int = 10, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI)


def freeze(monkeypatch: pytest.MonkeyPatch, moment: datetime) -> None:
    """把模块内 ``datetime.now`` 固定到给定时刻（真实时钟只影响本机放行）。"""

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:
            return moment

    monkeypatch.setattr(commit_policy, "datetime", FrozenDatetime)


class TestRejectionAudit:
    def test_default_window_is_attributed_to_repository_default(self) -> None:
        policy_context = context()
        moment = at(12, 10, 0)
        decision = check_commit_time(moment, policy_context.policy)
        line = block_line(policy_context, decision, moment)

        assert "Commit blocked" in line
        assert "workday_work_hours" in line
        assert "hit window 09:00-12:00 (repository default)" in line
        assert "effective policy repository default" in line
        assert "machine label (none)" in line
        assert CLIENT_SIDE_NOTE in line

    def test_local_window_is_attributed_to_local_override(self) -> None:
        policy_context = context(
            {
                "machine_label": "mac-laptop",
                "blocked_windows": [
                    {"start": "09:00", "end": "12:00"},
                    {"start": "13:30", "end": "18:00"},
                ],
            }
        )
        moment = at(12, 10, 0)
        decision = check_commit_time(moment, policy_context.policy)
        line = block_line(policy_context, decision, moment)

        assert "effective policy local override" in line
        assert "machine label mac-laptop" in line
        assert "hit window 09:00-12:00 (local override)" in line

    def test_label_only_override_keeps_window_default(self) -> None:
        # 本地覆盖只声明机器标签时，时间窗仍来自仓库默认：来源要如实区分。
        policy_context = context({"machine_label": "mac-laptop"})
        moment = at(12, 10, 0)
        decision = check_commit_time(moment, policy_context.policy)
        line = block_line(policy_context, decision, moment)

        assert "effective policy local override" in line
        assert "hit window 09:00-12:00 (repository default)" in line

    def test_authorized_window_elapsed_names_the_blocked_window(self) -> None:
        policy_context = context()
        moment = at(13, 10, 0)  # 授权日 10:00，已超出 09:55 窄口。
        decision = check_commit_time(moment, policy_context.policy)
        line = block_line(policy_context, decision, moment)

        assert "authorized_window_elapsed" in line
        assert "hit window 09:00-12:00 (repository default)" in line


class TestAllowedAudit:
    def test_outside_window_records_source_and_label(self) -> None:
        policy_context = context()
        moment = at(12, 20, 0)
        decision = check_commit_time(moment, policy_context.policy)
        line = allow_line(policy_context, decision, moment)

        assert "Commit allowed" in line
        assert "outside_work_hours" in line
        assert "effective policy repository default" in line
        assert CLIENT_SIDE_NOTE in line

    def test_debian_override_allows_and_records_the_label(self) -> None:
        policy_context = context({"machine_label": "debian-server", "enforce_work_hours": False})
        moment = at(12, 10, 0)
        decision = check_commit_time(moment, policy_context.policy)
        line = allow_line(policy_context, decision, moment)

        assert decision.allowed is True
        assert "work_hours_not_enforced" in line
        assert "effective policy local override" in line
        assert "machine label debian-server" in line


class TestWindowLookup:
    def test_outside_all_windows_returns_none(self) -> None:
        assert hit_blocked_window(context().policy, at(12, 20, 0)) is None


class TestCheckNow:
    def test_blocks_inside_window_and_names_the_source(self, monkeypatch, capsys) -> None:
        freeze(monkeypatch, at(12, 10, 0))
        assert check_now(context()) == 1
        captured = capsys.readouterr()
        assert "Commit blocked" in captured.err
        assert "hit window 09:00-12:00 (repository default)" in captured.err
        assert CLIENT_SIDE_NOTE in captured.err

    def test_allows_and_reminds_of_missing_calendar(self, monkeypatch, capsys) -> None:
        freeze(monkeypatch, datetime(2027, 1, 1, 20, 0, tzinfo=SHANGHAI))
        assert check_now(context()) == 0
        captured = capsys.readouterr()
        assert "Commit allowed" in captured.out
        assert "Maintain the workday calendar for 2027." in captured.err

    def test_allows_without_hint_when_hours_not_enforced(self, monkeypatch, capsys) -> None:
        freeze(monkeypatch, at(12, 10, 0))
        assert (
            check_now(context({"machine_label": "debian-server", "enforce_work_hours": False})) == 0
        )
        captured = capsys.readouterr()
        assert "Commit allowed" in captured.out
        assert "machine label debian-server" in captured.out
        assert "Maintain the workday calendar" not in captured.err


class TestValidateConfig:
    def test_reports_effective_source_and_label(self, capsys) -> None:
        assert validate_config(context({"machine_label": "mac-laptop"})) == 0
        out = capsys.readouterr().out
        assert "Commit policy valid" in out
        assert "effective policy local override" in out
        assert "machine label mac-laptop" in out
        assert "authorized batches" in out


class TestLoadPolicyContext:
    def test_load_policy_returns_the_effective_policy(self, tmp_path: Path) -> None:
        shutil.copytree(ROOT / "config", tmp_path / "config")
        policy = load_policy(tmp_path, home=tmp_path / "home")

        assert policy.source is CommitPolicySource.REPOSITORY_DEFAULT
        assert policy.machine_label is None


def run_git(repo: Path, *args: str, env: dict[str, str] | None = None) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=env)


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


class TestAudit:
    @pytest.fixture()
    def repo(self, tmp_path: Path) -> Path:
        path = tmp_path / "repo"
        path.mkdir()
        run_git(path, "init", "-q")
        run_git(path, "config", "user.email", "tester@example.test")
        run_git(path, "config", "user.name", "Tester")
        commit(path, "feat: allowed commit", "2026-10-12T12:30:00+08:00")
        commit(path, "feat: blocked commit", "2026-10-12T10:00:00+08:00")
        commit(path, "not a conventional header", "2026-10-12T12:30:00+08:00")
        return path

    def test_reports_every_commit_with_source_and_window(
        self, repo: Path, monkeypatch, capsys
    ) -> None:
        monkeypatch.setattr(commit_policy, "ROOT", repo)

        assert commit_policy.audit("", "HEAD", context()) is False

        captured = capsys.readouterr()
        assert "Allowed commit" in captured.out
        assert "Rejected commit" in captured.err
        assert "hit window 09:00-12:00 (repository default)" in captured.err
        assert "message" in captured.err
        assert CLIENT_SIDE_NOTE in captured.out

    def test_valid_range_returns_true(self, repo: Path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(commit_policy, "ROOT", repo)

        # base=0 时审计全部可达提交；换成只覆盖放行提交的范围返还 True。
        head = commit_policy.resolve_revision("HEAD")
        assert commit_policy.audit(head, head, context()) is True
        assert capsys.readouterr().err == ""


class TestResolveRevision:
    def test_invalid_git_output_is_rejected(self, monkeypatch) -> None:
        class Result:
            stdout = "not-a-commit\n"

        monkeypatch.setattr(commit_policy.subprocess, "run", lambda *args, **kwargs: Result())

        with pytest.raises(ValueError, match="invalid commit"):
            commit_policy.resolve_revision("HEAD")


class TestMain:
    def test_validate_config_mode(self, monkeypatch, capsys) -> None:
        monkeypatch.setattr(commit_policy, "load_policy_context", lambda: context())
        assert commit_policy.main(["--validate-config"]) == 0
        assert "Commit policy valid" in capsys.readouterr().out

    def test_check_now_mode(self, monkeypatch) -> None:
        monkeypatch.setattr(commit_policy, "load_policy_context", lambda: context())
        monkeypatch.setattr(commit_policy, "check_now", lambda ctx: 0)
        assert commit_policy.main(["--check-now"]) == 0

    def test_message_mode_accepts_a_valid_header(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setattr(commit_policy, "load_policy_context", lambda: context())
        message = tmp_path / "message.txt"
        message.write_text("feat: valid header\n", encoding="utf-8")

        assert commit_policy.main(["--message", str(message)]) == 0

    def test_message_mode_reports_a_missing_file(self, tmp_path: Path, monkeypatch, capsys) -> None:
        monkeypatch.setattr(commit_policy, "load_policy_context", lambda: context())

        assert commit_policy.main(["--message", str(tmp_path / "missing.txt")]) == 1
        assert "Commit policy check failed" in capsys.readouterr().err

    def test_audit_mode_returns_the_audit_status(self, monkeypatch) -> None:
        monkeypatch.setattr(commit_policy, "load_policy_context", lambda: context())
        monkeypatch.setattr(commit_policy, "audit", lambda base, head, ctx: True)
        assert commit_policy.main(["--audit", "a", "b"]) == 0
        monkeypatch.setattr(commit_policy, "audit", lambda base, head, ctx: False)
        assert commit_policy.main(["--audit", "a", "b"]) == 1


class TestShippedDefaultConfig:
    def test_repository_default_has_no_active_machine_label(self, tmp_path: Path) -> None:
        # 用发布配置的临时副本加载，避免读到本机 .cache 下要求各机器写入的本地覆盖。
        shutil.copytree(ROOT / "config", tmp_path / "config")
        policy_context = load_policy_context(tmp_path, home=tmp_path / "home")

        assert policy_context.policy.source is CommitPolicySource.REPOSITORY_DEFAULT
        assert policy_context.policy.machine_label is None

    def test_machine_label_is_documented_but_inert_in_the_repository_default(self) -> None:
        # 仓库默认登记可选 machine_label 字段但保持缺省，既有语义零迁移。
        config = tomllib.loads((ROOT / "config" / "commit-policy.toml").read_text(encoding="utf-8"))
        assert "machine_label" not in config
        assert config["authorized_window"] == {"start": "09:00", "end": "09:55"}
        assert config["authorized_batches"]


class TestLazyCliEntryPoint:
    def test_lightweight_module_imports_without_orchestration_dependencies(self) -> None:
        # 复现 CI commit-policy 作业：`-S` 关闭 site-packages 后，轻量审计入口仍可导入。
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-c",
                "from forgeloop.cli.commit_policy import load_policy; "
                "print(type(load_policy()).__name__)",
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(ROOT / "src")},
        )
        assert result.stdout.strip() == "CommitPolicy"

    def test_module_entry_point_exposes_main(self) -> None:
        import forgeloop.__main__ as entry

        assert callable(entry.main)
