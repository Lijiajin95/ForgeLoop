"""Reject empty, incomplete, surviving or unaccounted mutation results.

The gates come from ``config/quality-policy.toml`` [mutation]: the current
mutmut scope is the core domain (counting/approval/limits/commit policy), so
unreviewed survivors and every incomplete state (no tests, skipped, suspicious,
timeout, segfault, user interrupt) must be zero, the report must be non-empty,
and the counters must account for the total. Every surviving mutant must carry a
``[[mutation.reviewed_survivors]]`` entry (mutant + reason). Reviewed entries that
no longer survive mean the sources changed and the ledger may be stale: they are
reported as **review hints** (re-derive the list) and do not fail the gate by
themselves; ``general_killed_min`` is validated for the future general-module scope
and is not applied to this critical-scope report.

Ledger disagreement is re-measured once before it fails: mutmut runs only the
tests associated with each mutated function, so a single unrelated flaky test
failure flips one mutant between survived and killed. Observed on the shared CI
runner and locally on unchanged sources (46 survivors once, 45 the next run, and
200 vs 201 killed). Unreviewed survivors are therefore re-checked by re-running
exactly those mutants; the verdict comes from the second measurement and a
confirmed disagreement still fails. Stale reviewed entries are hints, not
failures, so they are not re-measured. Structural problems (unreadable report,
empty report, incomplete states, counter mismatch) are never re-measured because
they do not depend on test flakiness.

复刻自 EvidHist 的同名门槛脚本并扩展幸存者审阅核对与可疑项复测。
"""

import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

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
MUTMUT_TIMEOUT_SECONDS = 900
# 复测器：给定可疑变异体名称，重新测量并返回（计数器报告，当前幸存者列表）。
Remeasure = Callable[[tuple[str, ...]], tuple[dict, list[str]]]


class GateInputs(NamedTuple):
    """一次门槛判定需要的输入：报告路径、仓库根、已审阅清单与策略。"""

    stats_path: Path
    root: Path
    reviewed: dict[str, str]
    mutation_policy: dict


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


def run_mutmut(root: Path, args: tuple[str, ...]) -> None:
    result = subprocess.run(
        [mutmut_executable(root), *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
        timeout=MUTMUT_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise ValueError(f"mutmut {' '.join(args)} failed: {result.stderr.strip()[:200]}")


def current_survivors(root: Path) -> list[str]:
    result = subprocess.run(
        [mutmut_executable(root), "results"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
        timeout=MUTMUT_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise ValueError(f"mutmut results failed: {result.stderr.strip()[:200]}")
    return [
        line.strip().removesuffix(": survived")
        for line in result.stdout.splitlines()
        if line.strip().endswith(": survived")
    ]


def make_remeasure(root: Path, stats_path: Path) -> Remeasure:
    """Build the re-measurer: re-run the named mutants in place, re-read counters and survivors."""

    def remeasure(names: tuple[str, ...]) -> tuple[dict, list[str]]:
        run_mutmut(root, ("run", *names))
        run_mutmut(root, ("export-cicd-stats",))
        return read_stats(stats_path), current_survivors(root)

    return remeasure


def load_reviewed(mutation_policy: dict, failures: list[str]) -> dict[str, str]:
    reviewed: dict[str, str] = {}
    for entry in mutation_policy.get("reviewed_survivors", []):
        if not isinstance(entry, dict) or not entry.get("mutant") or not entry.get("reason"):
            failures.append("reviewed_survivors entries need mutant and reason")
        else:
            reviewed[str(entry["mutant"])] = str(entry["reason"])
    return reviewed


def counter_failures(stats: dict, mutation_policy: dict) -> list[str]:
    """Structural report checks: no flakiness can change their outcome."""
    failures: list[str] = []
    if mutation_policy.get("require_nonempty_report") and stats["total"] == 0:
        failures.append("mutation report is empty; no mutants were generated")
    incomplete = sum(stats[key] or 0 for key in INCOMPLETE_COUNTERS)
    if incomplete > mutation_policy.get("unresolved_incomplete_states_max", -1):
        detail = ", ".join(f"{key}={stats[key]}" for key in INCOMPLETE_COUNTERS if stats[key])
        failures.append(f"{incomplete} mutants are in unresolved incomplete states: {detail}")
    accounted = stats["killed"] + stats["survived"] + incomplete
    if accounted != stats["total"]:
        failures.append(f"counters account for {accounted} of {stats['total']} total mutants")
    return failures


def review_survivors(
    survivors: list[str], reviewed: dict[str, str], stats: dict, mutation_policy: dict
) -> tuple[list[str], list[str], list[str]]:
    """Compare measurement with the reviewed ledger; return failures, stale hints, suspicious."""
    failures: list[str] = []
    hints: list[str] = []
    suspicious: list[str] = []
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
        suspicious.extend(unreviewed)
    stale = sorted(name for name in reviewed if stats["survived"] and name not in set(survivors))
    if stale:
        hints.append(
            f"{len(stale)} reviewed entries no longer survive "
            f"(source changed; re-derive the ledger): {', '.join(stale)}"
        )
    return failures, hints, suspicious


def collect_measurement(inputs: GateInputs, measured: tuple[dict, list[str]] | None = None) -> dict:
    """Read one measurement: counters, survivors, and its structural/ledger verdict."""
    structural: list[str] = []
    stats: dict = {key: None for key in COUNTERS}
    survivors: list[str] = []
    if measured is None:
        try:
            stats = read_stats(inputs.stats_path)
        except ValueError as error:
            structural.append(str(error))
        else:
            structural.extend(counter_failures(stats, inputs.mutation_policy))
            if not structural:
                try:
                    survivors = current_survivors(inputs.root)
                except ValueError as error:
                    structural.append(str(error))
    else:
        stats, survivors = measured
        structural.extend(counter_failures(stats, inputs.mutation_policy))
    ledger: list[str] = []
    hints: list[str] = []
    suspicious: list[str] = []
    if not structural:
        ledger, hints, suspicious = review_survivors(
            survivors, inputs.reviewed, stats, inputs.mutation_policy
        )
    return {
        "stats": stats,
        "survivors": survivors,
        "structural": structural,
        "ledger": ledger,
        "hints": hints,
        "failures": structural + ledger,
        "suspicious": suspicious,
    }


def recheck_measurement(
    inputs: GateInputs, first: dict, remeasure: Remeasure
) -> tuple[dict, dict | None, str | None]:
    """Re-measure suspicious mutants; return the verdict measurement, recheck log, failure."""
    names = tuple(dict.fromkeys(first["suspicious"]))
    try:
        second = collect_measurement(inputs, measured=remeasure(names))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return first, None, f"suspicious mutants could not be re-measured: {error}"
    recheck = {
        "mutants": names,
        "first_failures": first["failures"],
        "second_failures": second["failures"],
    }
    return second, recheck, None


def run_stats_check(
    stats_path: Path, mutation_policy: dict, root: Path, remeasure: Remeasure | None = None
) -> dict:
    policy_failures: list[str] = []
    missing_keys = [key for key in POLICY_KEYS if key not in mutation_policy]
    if missing_keys:
        policy_failures.append(f"mutation policy is missing keys: {missing_keys}")
    reviewed = load_reviewed(mutation_policy, policy_failures)
    inputs = GateInputs(stats_path, root, reviewed, mutation_policy)
    measurement = collect_measurement(inputs)
    recheck: dict | None = None
    recheck_failures: list[str] = []
    suspicious = bool(measurement["ledger"] and measurement["suspicious"])
    if remeasure is not None and suspicious:
        measurement, recheck, recheck_failure = recheck_measurement(inputs, measurement, remeasure)
        if recheck_failure is not None:
            recheck_failures.append(recheck_failure)
    return {
        "report": str(stats_path),
        **{key: measurement["stats"][key] for key in COUNTERS},
        "reviewed_survivors": len(reviewed),
        "general_killed_min": mutation_policy.get("general_killed_min"),
        "recheck": recheck,
        "summary": {
            "failures": [*policy_failures, *recheck_failures, *measurement["failures"]],
            "hints": measurement["hints"],
            "passed": not (policy_failures or recheck_failures or measurement["failures"]),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats", type=Path, default=ROOT / "mutants/mutmut-cicd-stats.json")
    parser.add_argument("--config", type=Path, default=ROOT / "config/quality-policy.toml")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--no-recheck",
        action="store_true",
        help="use the first measurement only (skip re-running suspicious mutants)",
    )
    args = parser.parse_args()
    stats_path = args.stats.resolve()
    root = args.root.resolve()
    remeasure = None if args.no_recheck else make_remeasure(root, stats_path)
    result = run_stats_check(stats_path, load_policy(args.config.resolve()), root, remeasure)
    recheck = result["recheck"]
    if recheck is not None:
        names = recheck["mutants"]
        shown = ", ".join(names[:3]) + (f", ... ({len(names)} total)" if len(names) > 3 else "")
        print(f"Re-measured {len(names)} suspicious mutants: {shown}")
        for failure in recheck["first_failures"]:
            print(f"First measurement only: {failure}")
    for failure in result["summary"]["failures"]:
        print(f"FAIL: {failure}")
    for hint in result["summary"]["hints"]:
        print(f"HINT: {hint}")
    status = "passed" if result["summary"]["passed"] else "failed"
    print(
        f"Mutation gate {status}: {result['killed']}/{result['total']} killed, "
        f"{result['survived']} survivors ({result['reviewed_survivors']} reviewed)."
    )
    return 0 if result["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
