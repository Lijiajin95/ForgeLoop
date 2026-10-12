"""Enforce structure thresholds from config/quality-policy.toml over the policy scope.

The counting calibers live in :mod:`structure_metrics` (same directory); this script
applies the warn/fail thresholds, records reviewed file exceptions, emits a machine
report separating failures from warnings, and reports review hints without failing.
ForgeLoop 首版为纯 Python 工程范围（[scope] extensions 仅 .py）；出现 TS/JS
范围时按 EvidHist 同值 ESLint 门槛接入，报告中显式记录该事实。
"""

import argparse
import json
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from structure_metrics import (
    ClassMetric,
    FunctionMetric,
    physical_lines,
    python_metrics,
)

ROOT = Path(__file__).resolve().parents[1]
EXCEPTION_KEYS = ("path", "rule", "reason", "owner", "review", "recheck")
CALIBER_FLAGS = {
    "exclude_blank_lines": True,
    "exclude_comment_only_lines": True,
    "exclude_python_docstrings": True,
    "include_signature": True,
    "include_nested_function_ranges": True,
}
INTEGER_KEYS = (
    "function_effective_lines_warn",
    "function_effective_lines_max",
    "public_interfaces_warn",
    "public_interfaces_max",
    "file_physical_lines_warn",
    "file_physical_lines_max",
    "reviewed_file_exception_ceiling",
)


def load_policy(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def collect_python_files(root: Path, scope: dict) -> tuple[list[Path], list[str]]:
    files: list[Path] = []
    missing: list[str] = []
    for relative_root in scope["handwritten_roots"]:
        base = root / relative_root
        if not base.exists():
            missing.append(relative_root)
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix != ".py":
                continue
            relative = path.relative_to(root).as_posix()
            if _is_generated(relative, scope):
                continue
            files.append(path)
    return sorted(files), missing


def _is_generated(relative: str, scope: dict) -> bool:
    for generated_root in scope["generated_roots"]:
        if relative == generated_root or relative.startswith(generated_root + "/"):
            return True
    return False


def validate_config(config: dict) -> list[str]:
    errors: list[str] = []
    if config.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    structure = config.get("structure")
    scope = config.get("scope")
    if not isinstance(structure, dict):
        return [*errors, "[structure] section is missing"]
    if not isinstance(scope, dict) or not isinstance(scope.get("handwritten_roots"), list):
        return [*errors, "[scope] section with handwritten_roots is missing"]
    for key in INTEGER_KEYS:
        if type(structure.get(key)) is not int:
            errors.append(f"structure.{key} must be an integer")
    for flag, expected in CALIBER_FLAGS.items():
        if structure.get(flag) is not expected:
            errors.append(f"structure.{flag} must be {expected}; the counter fixes this caliber")
    for entry in structure.get("reviewed_exceptions", []):
        missing = [key for key in EXCEPTION_KEYS if not entry.get(key)]
        if missing:
            errors.append(f"reviewed exception is missing keys: {missing}")
    return errors


def python_file_metrics(root: Path, python_files: list[Path], config: dict) -> dict:
    structure = config["structure"]
    exceptions = structure.get("reviewed_exceptions", [])
    hint_rules = structure.get("review_hints", {})
    functions: list[dict] = []
    classes: list[dict] = []
    files: list[dict] = []
    hints: list[dict] = []
    for path in python_files:
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(root).as_posix()
        file_functions, file_classes = python_metrics(source, relative)
        for metric in file_functions:
            functions.append(_function_report(metric, structure))
            hints.extend(_function_hints(metric, hint_rules))
        for metric in file_classes:
            classes.append(_class_report(metric, structure))
        files.append(_file_report(source, relative, exceptions, structure))
    return {"functions": functions, "classes": classes, "files": files, "hints": hints}


def _function_report(metric: FunctionMetric, structure: dict) -> dict:
    return {
        "file": metric.file,
        "name": metric.name,
        "kind": metric.kind,
        "start_line": metric.start_line,
        "end_line": metric.end_line,
        "effective_lines": metric.effective_lines,
        "level": _level(
            metric.effective_lines,
            structure["function_effective_lines_warn"],
            structure["function_effective_lines_max"],
        ),
    }


def _class_report(metric: ClassMetric, structure: dict) -> dict:
    return {
        "file": metric.file,
        "name": metric.name,
        "line": metric.line,
        "public_interfaces": metric.public_interfaces,
        "interfaces": [list(pair) for pair in metric.interfaces],
        "level": _level(
            metric.public_interfaces,
            structure["public_interfaces_warn"],
            structure["public_interfaces_max"],
        ),
    }


def _file_report(source: str, relative: str, exceptions: list[dict], structure: dict) -> dict:
    total = physical_lines(source)
    excepted = any(
        entry["path"] == relative and entry["rule"] == "file_physical_lines" for entry in exceptions
    )
    level = (
        "excepted"
        if excepted
        else _level(
            total, structure["file_physical_lines_warn"], structure["file_physical_lines_max"]
        )
    )
    return {"file": relative, "physical_lines": total, "level": level, "excepted": excepted}


def _function_hints(metric: FunctionMetric, rules: dict) -> list[dict]:
    checks = (
        ("return_statements", metric.return_statements, "return_statements_max"),
        ("statements", metric.statements, "statements_max"),
        ("local_variables", metric.local_variables, "local_variables_max"),
    )
    return [
        {
            "file": metric.file,
            "function": metric.name,
            "metric": name,
            "value": value,
            "limit": rules[rule],
        }
        for name, value, rule in checks
        if rule in rules and value > rules[rule]
    ]


def _level(value: int, warn: int, fail: int) -> str:
    if value > fail:
        return "fail"
    if value > warn:
        return "warn"
    return "ok"


def run_check(root: Path, config_path: Path) -> dict:
    config = load_policy(config_path)
    errors = validate_config(config)
    if errors:
        return {
            "config_errors": errors,
            "summary": {"failures": errors, "warnings": [], "passed": False},
        }
    python_files, missing_roots = collect_python_files(root, config["scope"])
    report = {
        "config": str(config_path.relative_to(root)),
        "scope_roots_missing": missing_roots,
        "python": python_file_metrics(root, python_files, config),
        "frontend": {
            "status": "not_in_scope",
            "note": "Python-only scope per config [scope]; TS/JS thresholds will be added "
            "with the first frontend surface.",
        },
    }
    failures, warnings = _collect_findings(report, config)
    report["summary"] = {
        "failures": failures,
        "warnings": warnings,
        "python_files": len(python_files),
        "passed": not failures,
    }
    return report


def _collect_findings(report: dict, config: dict) -> tuple[list[str], list[str]]:
    structure = config["structure"]
    ceiling = structure["reviewed_file_exception_ceiling"]
    failures: list[str] = []
    warnings: list[str] = []
    for metric in report["python"]["functions"]:
        _record(
            metric["level"],
            f"{metric['file']}:{metric['start_line']}",
            f"function {metric['name']} has {metric['effective_lines']} effective lines",
            failures,
            warnings,
        )
    for metric in report["python"]["classes"]:
        _record(
            metric["level"],
            f"{metric['file']}:{metric['line']}",
            f"class {metric['name']} exposes {metric['public_interfaces']} public interfaces",
            failures,
            warnings,
        )
    for metric in report["python"]["files"]:
        if metric["excepted"]:
            if metric["physical_lines"] > ceiling:
                failures.append(
                    f"{metric['file']}: excepted file exceeds the reviewed ceiling "
                    f"({metric['physical_lines']} > {ceiling})"
                )
            continue
        _record(
            metric["level"],
            metric["file"],
            f"file has {metric['physical_lines']} physical lines",
            failures,
            warnings,
        )
    for relative_root in report["scope_roots_missing"]:
        warnings.append(f"scope root not found: {relative_root}")
    return failures, warnings


def _record(level: str, where: str, message: str, failures: list[str], warnings: list[str]) -> None:
    if level == "fail":
        failures.append(f"{where}: {message}")
    elif level == "warn":
        warnings.append(f"{where}: {message}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config/quality-policy.toml")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--report", type=Path, default=ROOT / "reports/structure-metrics.json")
    parser.add_argument("--no-report", action="store_true")
    args = parser.parse_args()
    report = run_check(args.root.resolve(), args.config.resolve())
    if not args.no_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    for error in report.get("config_errors", []):
        print(f"FAIL: config: {error}", file=sys.stderr)
    for finding in report["summary"]["failures"]:
        print(f"FAIL: {finding}")
    for warning in report["summary"]["warnings"]:
        print(f"WARN: {warning}")
    for hint in report.get("python", {}).get("hints", []):
        print(
            f"HINT: {hint['file']} {hint['function']}: {hint['metric']} "
            f"{hint['value']} > {hint['limit']} (review)"
        )
    print(
        f"Structure metrics: {len(report['summary']['failures'])} failures, "
        f"{len(report['summary']['warnings'])} warnings."
    )
    return 0 if report["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
