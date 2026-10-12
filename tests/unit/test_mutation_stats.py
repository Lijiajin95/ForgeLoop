"""变异门槛脚本的负例回归测试：每个拒绝路径都要可发现。

对应可靠性方案第 11 节负例矩阵：空/幸存/超时/中断变异与缺失报告。
"""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "check_mutation_stats.py"


def load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_mutation_stats", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


def policy(**overrides) -> dict:
    base = {
        "general_killed_min": 90,
        "critical_unreviewed_survivors_max": 0,
        "unresolved_incomplete_states_max": 0,
        "require_nonempty_report": True,
    }
    base.update(overrides)
    return base


def write_stats(tmp_path: Path, counters: dict) -> Path:
    path = tmp_path / "stats.json"
    path.write_text(json.dumps(counters), encoding="utf-8")
    return path


def base_counters(**overrides) -> dict:
    counters = {
        "total": 10,
        "killed": 10,
        "survived": 0,
        "no_tests": 0,
        "skipped": 0,
        "suspicious": 0,
        "timeout": 0,
        "segfault": 0,
        "check_was_interrupted_by_user": 0,
    }
    counters.update(overrides)
    return counters


@pytest.fixture()
def no_survivors(monkeypatch):
    monkeypatch.setattr(gate, "current_survivors", lambda root: [])


class TestPassingReports:
    def test_clean_report_passes(self, tmp_path: Path, no_survivors) -> None:
        stats = write_stats(tmp_path, base_counters())
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert result["summary"]["passed"], result["summary"]["failures"]

    def test_reviewed_survivor_passes(self, tmp_path: Path, monkeypatch) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, survived=1))
        config = policy(
            reviewed_survivors=[{"mutant": "m1", "reason": "消息文本等价"}],
        )
        monkeypatch.setattr(gate, "current_survivors", lambda root: ["m1"])
        result = gate.run_stats_check(stats, config, tmp_path)
        assert result["summary"]["passed"], result["summary"]["failures"]
        assert result["reviewed_survivors"] == 1


class TestRejectedReports:
    def test_unreviewed_survivor_fails(self, tmp_path: Path, monkeypatch) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, survived=1))
        monkeypatch.setattr(gate, "current_survivors", lambda root: ["m-unreviewed"])
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("unreviewed" in f for f in result["summary"]["failures"])

    def test_empty_report_fails(self, tmp_path: Path, no_survivors) -> None:
        stats = write_stats(tmp_path, base_counters(total=0, killed=0))
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("empty" in f for f in result["summary"]["failures"])

    def test_incomplete_states_fail(self, tmp_path: Path, no_survivors) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, timeout=1))
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("incomplete states" in f for f in result["summary"]["failures"])

    def test_counter_mismatch_fails(self, tmp_path: Path, no_survivors) -> None:
        stats = write_stats(tmp_path, base_counters(total=12, killed=10))
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("account for" in f for f in result["summary"]["failures"])

    def test_missing_report_fails(self, tmp_path: Path, no_survivors) -> None:
        result = gate.run_stats_check(tmp_path / "missing.json", policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("unreadable" in f for f in result["summary"]["failures"])

    def test_survivor_count_mismatch_fails(self, tmp_path: Path, monkeypatch) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, survived=1))
        monkeypatch.setattr(gate, "current_survivors", lambda root: ["a", "b"])
        result = gate.run_stats_check(stats, policy(), tmp_path)
        assert not result["summary"]["passed"]
        assert any("lists 2 survivors" in f for f in result["summary"]["failures"])

    def test_stale_reviewed_entry_fails(self, tmp_path: Path, monkeypatch) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, survived=1))
        config = policy(
            reviewed_survivors=[
                {"mutant": "m1", "reason": "ok"},
                {"mutant": "m2-stale", "reason": "源码已变更"},
            ],
        )
        monkeypatch.setattr(gate, "current_survivors", lambda root: ["m1"])
        result = gate.run_stats_check(stats, config, tmp_path)
        assert not result["summary"]["passed"]
        assert any("no longer survive" in f for f in result["summary"]["failures"])

    def test_missing_policy_keys_fail(self, tmp_path: Path, no_survivors) -> None:
        stats = write_stats(tmp_path, base_counters())
        result = gate.run_stats_check(stats, {}, tmp_path)
        assert not result["summary"]["passed"]
        assert any("missing keys" in f for f in result["summary"]["failures"])

    def test_reviewed_entry_without_reason_fails(self, tmp_path: Path, monkeypatch) -> None:
        stats = write_stats(tmp_path, base_counters(total=11, killed=10, survived=1))
        config = policy(reviewed_survivors=[{"mutant": "m1"}])
        monkeypatch.setattr(gate, "current_survivors", lambda root: ["m1"])
        result = gate.run_stats_check(stats, config, tmp_path)
        assert not result["summary"]["passed"]
        assert any("mutant and reason" in f for f in result["summary"]["failures"])
