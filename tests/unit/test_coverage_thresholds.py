"""覆盖门槛脚本的负例回归测试：低覆盖、缺失与畸形报告、基线门。

对应可靠性方案第 11 节负例矩阵：低独立分支覆盖与缺失覆盖报告。
"""

import importlib.util
import json
import subprocess
from pathlib import Path
from types import ModuleType

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "check_coverage_thresholds.py"


def load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_coverage_thresholds", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


def policy(**overrides) -> dict:
    base = {"line_min": 90, "branch_min": 90, "changed_line_min": 90}
    base.update(overrides)
    return base


def write_report(tmp_path: Path, totals: dict) -> Path:
    path = tmp_path / "coverage.json"
    path.write_text(json.dumps({"totals": totals}), encoding="utf-8")
    return path


def totals(**overrides) -> dict:
    base = {
        "covered_lines": 100,
        "num_statements": 100,
        "covered_branches": 100,
        "num_branches": 100,
    }
    base.update(overrides)
    return base


def make_git_baseline(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.com"], cwd=root, check=True, capture_output=True
    )
    (root / "f.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "f.txt"], cwd=root, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "chore: baseline"],
        cwd=root,
        check=True,
        capture_output=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(root.parent),
            "GIT_AUTHOR_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T20:00:00+08:00",
        },
    )
    subprocess.run(
        ["git", "update-ref", "refs/remotes/origin/main", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
    )


class TestPassingReports:
    def test_above_minimums_passes(self, tmp_path: Path) -> None:
        report = write_report(tmp_path, totals())
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert result["summary"]["passed"], result["summary"]["failures"]
        assert result["line"]["percent"] == 100.0
        assert result["branch"]["status"] == "measured"

    def test_zero_branches_is_not_applicable(self, tmp_path: Path) -> None:
        report = write_report(tmp_path, totals(covered_branches=0, num_branches=0))
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert result["summary"]["passed"], result["summary"]["failures"]
        assert result["branch"]["status"] == "not_applicable"


class TestRejectedReports:
    def test_low_line_coverage_fails(self, tmp_path: Path) -> None:
        report = write_report(tmp_path, totals(covered_lines=89))
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("line coverage" in f for f in result["summary"]["failures"])

    def test_low_branch_coverage_fails_independently(self, tmp_path: Path) -> None:
        # 行覆盖满分也不能掩盖分支覆盖不足（独立原始计数）。
        report = write_report(tmp_path, totals(covered_branches=89))
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("branch coverage" in f for f in result["summary"]["failures"])

    def test_missing_report_fails(self, tmp_path: Path) -> None:
        result = gate.run_thresholds(tmp_path / "missing.json", policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("unreadable" in f for f in result["summary"]["failures"])

    def test_report_without_totals_fails(self, tmp_path: Path) -> None:
        report = tmp_path / "coverage.json"
        report.write_text("{}", encoding="utf-8")
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("totals" in f for f in result["summary"]["failures"])

    def test_non_integer_counters_fail(self, tmp_path: Path) -> None:
        report = write_report(
            tmp_path,
            totals(covered_lines="100", num_branches=None),
        )
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("integer counters" in f for f in result["summary"]["failures"])


class TestChangedLineGate:
    def test_no_git_baseline_is_not_applicable(self, tmp_path: Path) -> None:
        report = write_report(tmp_path, totals())
        result = gate.run_thresholds(report, policy(), tmp_path)
        assert result["changed_lines"]["status"] == "not_applicable"

    def test_existing_baseline_fails_until_diff_cover_integrated(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        make_git_baseline(repo)
        report = write_report(tmp_path, totals())
        result = gate.run_thresholds(report, policy(), repo)
        assert not result["summary"]["passed"]
        assert any("diff-cover" in f for f in result["summary"]["failures"])
        assert result["changed_lines"]["status"] == "pending_integration"
