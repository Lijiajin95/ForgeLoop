"""Reject empty, incomplete, surviving or unaccounted mutation results.

The gates come from ``config/quality-policy.toml`` [mutation]: the current mutmut
scope is the core domain (counting/approval/limits/commit policy), so unreviewed
survivors and every incomplete state (no tests, skipped, suspicious, timeout,
segfault, user interrupt) must be zero, the report must be non-empty, and the
counters must account for the total. Every surviving mutant must carry a
``[[mutation.reviewed_survivors]]`` entry (mutant + reason); entries that no
longer survive make the check fail so the list is re-derived after source
changes instead of silently rotting. ``general_killed_min`` is validated for the
future general-module scope and is not applied to this critical-scope report.

复刻自 EvidHist 的同名门槛脚本并扩展幸存者审阅核对。
"""

import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COUNTERS = (
    "total",
    "killed",
    "survived",
    "no_tests",
    "skipped",
    "suspicious",
    "timeout",
    "segfault",
    "check_was_interrupted_by_user",
)
INCOMPLETE_COUNTERS = COUNTERS[3:]
POLICY_KEYS = (
    "general_killed_min",
    "critical_unreviewed_survivors_max",
    "unresolved_incomplete_states_max",
    "require_nonempty_report",
)


def load_policy(path: Path) -> dict:
    config = tomllib.loads(path.read_text(encoding="utf-8"))
    return config.get("mutation", {})


def read_stats(path: Path) -> dict:
    try:
        stats = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"mutation report is missing or unreadable: {error}") from error
    missing = [key for key in COUNTERS if type(stats.get(key)) is not int or stats[key] < 0]
    if missing:
        raise ValueError(f"mutation report is missing valid counters: {missing}")
    return stats


def mutmut_executable(root: Path) -> str:
    vendored = root / ".venv" / "bin" / "mutmut"
    if vendored.exists():
        return str(vendored)
    found = shutil.which("mutmut")
    if found is None:
        raise ValueError("mutmut executable not found (.venv or PATH)")
    return found


def current_survivors(root: Path) -> list[str]:
    result = subprocess.run(
        [mutmut_executable(root), "results"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(f"mutmut results failed: {result.stderr.strip()[:200]}")
    return [
        line.strip().removesuffix(": survived")
        for line in result.stdout.splitlines()
        if line.strip().endswith(": survived")
    ]


def load_reviewed(mutation_policy: dict, failures: list[str]) -> dict[str, str]:
    reviewed: dict[str, str] = {}
    for entry in mutation_policy.get("reviewed_survivors", []):
        if not isinstance(entry, dict) or not entry.get("mutant") or not entry.get("reason"):
            failures.append("reviewed_survivors entries need mutant and reason")
        else:
            reviewed[str(entry["mutant"])] = str(entry["reason"])
    return reviewed


def review_survivors(
    survivors: list[str], reviewed: dict[str, str], stats: dict, mutation_policy: dict
) -> list[str]:
    failures: list[str] = []
    if len(survivors) != stats["survived"]:
        failures.append(
            f"mutmut results lists {len(survivors)} survivors "
            f"but the report counts {stats['survived']}"
        )
    unreviewed = [name for name in survivors if name not in reviewed]
    if len(unreviewed) > mutation_policy.get("critical_unreviewed_survivors_max", -1):
        failures.append(
            f"{len(unreviewed)} surviving mutants are unreviewed; "
            f"first: {unreviewed[0] if unreviewed else '-'}"
        )
    stale = sorted(name for name in reviewed if stats["survived"] and name not in set(survivors))
    if stale:
        failures.append(
            f"{len(stale)} reviewed entries no longer survive "
            f"(source changed; re-derive the list); first: {stale[0]}"
        )
    return failures


def run_stats_check(stats_path: Path, mutation_policy: dict, root: Path) -> dict:
    failures: list[str] = []
    missing_keys = [key for key in POLICY_KEYS if key not in mutation_policy]
    if missing_keys:
        failures.append(f"mutation policy is missing keys: {missing_keys}")
    reviewed = load_reviewed(mutation_policy, failures)
    try:
        stats = read_stats(stats_path)
    except ValueError as error:
        failures.append(str(error))
        stats = {key: None for key in COUNTERS}
    else:
        if mutation_policy.get("require_nonempty_report") and stats["total"] == 0:
            failures.append("mutation report is empty; no mutants were generated")
        incomplete = sum(stats[key] or 0 for key in INCOMPLETE_COUNTERS)
        if incomplete > mutation_policy.get("unresolved_incomplete_states_max", -1):
            detail = ", ".join(f"{key}={stats[key]}" for key in INCOMPLETE_COUNTERS if stats[key])
            failures.append(f"{incomplete} mutants are in unresolved incomplete states: {detail}")
        accounted = stats["killed"] + stats["survived"] + incomplete
        if accounted != stats["total"]:
            failures.append(f"counters account for {accounted} of {stats['total']} total mutants")
        try:
            survivors = current_survivors(root)
        except ValueError as error:
            failures.append(str(error))
        else:
            failures.extend(review_survivors(survivors, reviewed, stats, mutation_policy))
    return {
        "report": str(stats_path),
        **{key: stats[key] for key in COUNTERS},
        "reviewed_survivors": len(reviewed),
        "general_killed_min": mutation_policy.get("general_killed_min"),
        "summary": {"failures": failures, "passed": not failures},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats", type=Path, default=ROOT / "mutants/mutmut-cicd-stats.json")
    parser.add_argument("--config", type=Path, default=ROOT / "config/quality-policy.toml")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    result = run_stats_check(
        args.stats.resolve(), load_policy(args.config.resolve()), args.root.resolve()
    )
    for failure in result["summary"]["failures"]:
        print(f"FAIL: {failure}")
    status = "passed" if result["summary"]["passed"] else "failed"
    print(
        f"Mutation gate {status}: {result['killed']}/{result['total']} killed, "
        f"{result['survived']} survivors ({result['reviewed_survivors']} reviewed)."
    )
    return 0 if result["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
