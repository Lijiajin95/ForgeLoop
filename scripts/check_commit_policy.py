"""Enforce commit headers and workday hours; audit Git timestamps without creating commits."""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from datetime import UTC, date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from forgeloop.domain.commit_policy import (
    CommitPolicy,
    WorkdayCalendar,
    check_commit_time,
    validate_commit_message,
)

ROOT = Path(__file__).resolve().parents[1]


def load_policy() -> CommitPolicy:
    config = tomllib.loads((ROOT / "config/commit-policy.toml").read_text())
    calendars: dict[int, WorkdayCalendar] = {}
    for path in (ROOT / config["calendar_directory"]).glob("*.json"):
        data = json.loads(path.read_text())
        year = data["year"]
        if (
            type(year) is not int
            or year in calendars
            or not data["source_url"].startswith("https://")
        ):
            raise ValueError("Invalid or duplicate calendar year/source")
        calendars[year] = WorkdayCalendar(
            year,
            frozenset(date.fromisoformat(value) for value in data["holidays"]),
            frozenset(date.fromisoformat(value) for value in data["extra_workdays"]),
        )
    return CommitPolicy(
        ZoneInfo(config["timezone"]),
        time.fromisoformat(config["blocked_start"]),
        time.fromisoformat(config["blocked_end"]),
        calendars,
    )


def resolve_revision(revision: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", result) is None:
        raise ValueError("Git returned an invalid commit ID")
    return result


def audit(base: str, head: str, policy: CommitPolicy) -> bool:
    head_id = resolve_revision(head)
    target = head_id if not base or set(base) == {"0"} else f"{resolve_revision(base)}..{head_id}"
    log = subprocess.run(
        ["git", "log", "--format=%H%x00%aI%x00%cI%x00%s", target],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    valid = True
    for line in log.splitlines():
        sha, author_time, committer_time, subject = line.split("\0")
        try:
            validate_commit_message(subject)
            for value in [author_time, committer_time]:
                decision = check_commit_time(datetime.fromisoformat(value), policy)
                if not decision.allowed:
                    raise ValueError(f"timestamp rejected: {decision.reason}")
        except ValueError as error:
            print(f"Rejected commit {sha[:12]}: {error}", file=sys.stderr)
            valid = False
    return valid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-now", action="store_true")
    mode.add_argument("--message", type=Path)
    mode.add_argument("--audit", nargs=2, metavar=("BASE", "HEAD"))
    mode.add_argument("--validate-config", action="store_true")
    args = parser.parse_args()
    try:
        policy = load_policy()
        if args.check_now:
            decision = check_commit_time(datetime.now(UTC), policy)
            if not decision.allowed:
                print(
                    f"Commit blocked ({decision.reason}): Asia/Shanghai workdays 09:00-18:00.",
                    file=sys.stderr,
                )
                return 1
            if decision.hint:
                year = datetime.now(UTC).astimezone(policy.timezone).year
                print(
                    f"Commit allowed, but maintain the workday calendar for {year}.",
                    file=sys.stderr,
                )
        elif args.message is not None:
            validate_commit_message(args.message.read_text(encoding="utf-8"))
        elif args.audit is not None:
            base, head = args.audit
            return 0 if audit(base, head, policy) else 1
        else:
            print(f"Commit policy valid; maintained years: {sorted(policy.calendars)}")
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f"Commit policy check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
