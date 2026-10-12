"""Fail when independent line or branch coverage falls below the quality policy minimums.

coverage.py's ``percent_covered`` total mixes statements and branches once branch
coverage is enabled; the policy in ``config/quality-policy.toml`` requires line and
branch coverage to each reach their own minimum, computed from the raw counters in
``coverage json`` output. A missing or malformed report is a failed check. Without a
Git baseline the changed-line gate is explicitly "not applicable"; once a baseline
exists diff-cover measures changed-line coverage against ``origin/main`` and its
failure fails this check, so the gate cannot silently pass by omission.

复刻自 EvidHist 的同名门槛脚本（其验证记录见原项目）；基线出现后按设计
接入 diff-cover（2026-10-12 远程仓库建立触发）。
"""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOTAL_KEYS = ("covered_lines", "num_statements", "covered_branches", "num_branches")


def load_policy(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))["coverage"]


def read_totals(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"coverage report is unreadable: {error}") from error
    totals = data.get("totals") if isinstance(data, dict) else None
    if not isinstance(totals, dict):
        raise ValueError("coverage report is missing a totals object")
    missing = [key for key in TOTAL_KEYS if type(totals.get(key)) is not int]
    if missing:
        raise ValueError(f"coverage totals are missing integer counters: {missing}")
    return totals


def line_coverage(totals: dict) -> float:
    return totals["covered_lines"] / totals["num_statements"] * 100


def branch_coverage(totals: dict) -> float | None:
    if totals["num_branches"] == 0:
        return None
    return totals["covered_branches"] / totals["num_branches"] * 100


def git_base_revision(root: Path, base: str = "origin/main") -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    revision = result.stdout.strip() if result.returncode == 0 else ""
    return revision if re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", revision) else None


def changed_line_gate(root: Path, minimum: float, coverage_xml: Path) -> dict:
    base = git_base_revision(root)
    if base is None:
        return {
            "status": "not_applicable",
            "minimum": minimum,
            "reason": "no Git baseline; changed-line coverage cannot be measured yet",
        }
    diff_cover = root / ".venv" / "bin" / "diff-cover"
    if not diff_cover.exists():
        return {
            "status": "integration_error",
            "minimum": minimum,
            "base": base,
            "reason": "diff-cover is not installed in .venv (dev dependency group)",
        }
    result = subprocess.run(
        [
            str(diff_cover),
            str(coverage_xml),
            "--compare-branch",
            "origin/main",
            "--fail-under",
            str(int(minimum)),
        ],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return {
            "status": "passed",
            "minimum": minimum,
            "base": base,
            "reason": "diff-cover reported changed-line coverage at or above the minimum",
        }
    return {
        "status": "failed",
        "minimum": minimum,
        "base": base,
        "reason": (result.stdout or result.stderr).strip()[-500:],
    }


def run_thresholds(report_path: Path, coverage_policy: dict, root: Path) -> dict:
    failures: list[str] = []
    try:
        totals = read_totals(report_path)
        line_percent = line_coverage(totals)
        branch_percent = branch_coverage(totals)
        if line_percent < coverage_policy["line_min"]:
            failures.append(
                f"line coverage {line_percent:.1f}% is below {coverage_policy['line_min']}%"
            )
        branch = {
            "percent": branch_percent,
            "status": "measured",
            "minimum": coverage_policy["branch_min"],
        }
        if branch_percent is None:
            branch["status"] = "not_applicable"
        elif branch_percent < coverage_policy["branch_min"]:
            failures.append(
                f"branch coverage {branch_percent:.1f}% is below {coverage_policy['branch_min']}%"
            )
    except ValueError as error:
        failures.append(str(error))
        line_percent, branch = None, {"percent": None, "status": "missing", "minimum": None}
    coverage_xml = report_path.with_suffix(".xml")
    changed = changed_line_gate(root, coverage_policy["changed_line_min"], coverage_xml)
    if changed["status"] in ("failed", "integration_error"):
        failures.append("changed-line coverage: " + changed["reason"])
    return {
        "report": str(report_path),
        "line": {"percent": line_percent, "minimum": coverage_policy["line_min"]},
        "branch": branch,
        "changed_lines": changed,
        "summary": {"failures": failures, "passed": not failures},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / "reports/coverage.json")
    parser.add_argument("--config", type=Path, default=ROOT / "config/quality-policy.toml")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--json-output", type=Path, default=ROOT / "reports/coverage-thresholds.json"
    )
    args = parser.parse_args()
    result = run_thresholds(
        args.report.resolve(), load_policy(args.config.resolve()), args.root.resolve()
    )
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for failure in result["summary"]["failures"]:
        print(f"FAIL: {failure}")
    status = "passed" if result["summary"]["passed"] else "failed"
    print(
        f"Coverage thresholds: {status} "
        f"(line {result['line']['percent']}, branch {result['branch']['percent']}, "
        f"changed-lines {result['changed_lines']['status']})."
    )
    return 0 if result["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
