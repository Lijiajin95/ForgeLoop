"""Report structure metrics from config/quality-policy.toml over the policy scope.

The counting calibers live in :mod:`structure_metrics` (same directory); this script
applies the policy thresholds and emits a machine report. Structure numbers
(function lines, file length, public interfaces, complexity, branches, parameters)
are **review hints**: they surface in the report and on stdout, they do not block
delivery. Only a corrupted policy, an unreadable source file or a source that cannot
be parsed fails the check, so those errors can never be hidden behind the hint
caliber. Pylint's former public-interface and module-length checks are folded into
this report so the same number is not blocked twice.
本报告只统计 Python（.py）结构与口径；TS/TSX 的结构数值自 2026-10-17 起由 ESLint
在 `make frontend-check` 中执行，数值与 calibers 同源于 `config/quality-policy.toml`
的 [frontend] 段（机器核对见 `scripts/check_frontend_policy.py`），报告中的 frontend
一节显式记录该事实，避免同一个数字被两处门禁重复阻断。
"""

import argparse
import json
import sys
import tokenize
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
HINT_KEYS = (
    "return_statements_max",
    "statements_max",
    "local_variables_max",
    "complexity_max",
    "parameters_max",
    "branches_max",
)
SOURCE_ERRORS = (OSError, SyntaxError, ValueError, tokenize.TokenError)


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
    hints = structure.get("review_hints")
    if not isinstance(hints, dict):
        return [*errors, "[structure.review_hints] section is missing"]
    for key in HINT_KEYS:
        if type(hints.get(key)) is not int:
            errors.append(f"structure.review_hints.{key} must be an integer")
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
    source_errors: list[str] = []
    for path in python_files:
        relative = path.relative_to(root).as_posix()
        try:
            source = path.read_text(encoding="utf-8")
            file_functions, file_classes = python_metrics(source, relative)
        except SOURCE_ERRORS as error:  # 读取/解析失败必须显式失败，不进入提示口径
            source_errors.append(f"{relative}: 源码读取或解析失败: {type(error).__name__}: {error}")
            continue
        for metric in file_functions:
            functions.append(_function_report(metric, structure))
            hints.extend(_function_hints(metric, hint_rules))
        for metric in file_classes:
            classes.append(_class_report(metric, structure))
        files.append(_file_report(source, relative, exceptions, structure))
    return {
        "functions": functions,
        "classes": classes,
        "files": files,
        "hints": hints,
        "source_errors": source_errors,
    }


def _function_report(metric: FunctionMetric, structure: dict) -> dict:
    return {
        "file": metric.file,
        "name": metric.name,
        "kind": metric.kind,
        "start_line": metric.start_line,
        "end_line": metric.end_line,
        "effective_lines": metric.effective_lines,
        "complexity": metric.complexity,
        "branches": metric.branches,
        "parameters": metric.parameters,
        "level": _review_level(
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
        "level": _review_level(
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
        else _review_level(
            total, structure["file_physical_lines_warn"], structure["file_physical_lines_max"]
        )
    )
    return {"file": relative, "physical_lines": total, "level": level, "excepted": excepted}


def _function_hints(metric: FunctionMetric, rules: dict) -> list[dict]:
    checks = (
        ("return_statements", metric.return_statements, "return_statements_max"),
        ("statements", metric.statements, "statements_max"),
        ("local_variables", metric.local_variables, "local_variables_max"),
        ("complexity", metric.complexity, "complexity_max"),
        ("parameters", metric.parameters, "parameters_max"),
        ("branches", metric.branches, "branches_max"),
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


def _review_level(value: int, hint: int, review: int) -> str:
    """结构数字的可见程度：超过提示值为 hint，超过复核值为 review；两者都不阻断交付。"""
    if value > review:
        return "review"
    if value > hint:
        return "hint"
    return "ok"


def run_check(root: Path, config_path: Path) -> dict:
    try:
        config = load_policy(config_path)
    except (OSError, tomllib.TOMLDecodeError) as error:
        return _rejected(
            [f"配置读取失败: {config_path}: {type(error).__name__}: {error}"], config_path
        )
    errors = validate_config(config)
    if errors:
        return _rejected(errors, config_path)
    python_files, missing_roots = collect_python_files(root, config["scope"])
    report = {
        "config": str(config_path.relative_to(root)),
        "scope_roots_missing": missing_roots,
        "python": python_file_metrics(root, python_files, config),
        "frontend": {
            "status": "enforced_elsewhere",
            "note": (
                "Python-only report: TS/TSX 结构数值由 ESLint 执行（frontend/eslint.config.js，"
                "数值取自 config/quality-policy.toml 的 [frontend] 段经 "
                "frontend/quality-thresholds.json），本报告不重复统计。"
            ),
        },
    }
    failures, hints = _collect_findings(report, config)
    report["summary"] = {
        "failures": failures,
        "hints": hints,
        "python_files": len(python_files),
        "passed": not failures,
    }
    return report


def _rejected(errors: list[str], config_path: Path) -> dict:
    return {
        "config": str(config_path),
        "config_errors": errors,
        "scope_roots_missing": [],
        "python": {"functions": [], "classes": [], "files": [], "hints": [], "source_errors": []},
        "summary": {"failures": errors, "hints": [], "python_files": 0, "passed": False},
    }


def _collect_findings(report: dict, config: dict) -> tuple[list[str], list[str]]:
    """Return (failures, hints): only config/read/parse errors fail the check."""
    structure = config["structure"]
    ceiling = structure["reviewed_file_exception_ceiling"]
    failures: list[str] = list(report["python"]["source_errors"])
    hints: list[str] = []
    for metric in report["python"]["functions"]:
        _record(
            metric["level"],
            f"{metric['file']}:{metric['start_line']}",
            f"function {metric['name']} has {metric['effective_lines']} effective lines",
            hints,
        )
    for metric in report["python"]["classes"]:
        _record(
            metric["level"],
            f"{metric['file']}:{metric['line']}",
            f"class {metric['name']} exposes {metric['public_interfaces']} public interfaces",
            hints,
        )
    for metric in report["python"]["files"]:
        if metric["excepted"]:
            if metric["physical_lines"] > ceiling:
                hints.append(
                    f"{metric['file']}: excepted file exceeds the reviewed ceiling "
                    f"({metric['physical_lines']} > {ceiling})"
                )
            continue
        _record(
            metric["level"],
            metric["file"],
            f"file has {metric['physical_lines']} physical lines",
            hints,
        )
    for hint in report["python"]["hints"]:
        hints.append(
            f"{hint['file']} {hint['function']}: {hint['metric']} "
            f"{hint['value']} > {hint['limit']} (review)"
        )
    for relative_root in report["scope_roots_missing"]:
        hints.append(f"scope root not found: {relative_root}")
    return failures, hints


def _record(level: str, where: str, message: str, hints: list[str]) -> None:
    if level == "review":
        hints.append(f"{where}: {message} (review)")
    elif level == "hint":
        hints.append(f"{where}: {message} (hint)")


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
    label = "FAIL: config" if report.get("config_errors") else "FAIL"
    for finding in report["summary"]["failures"]:
        print(f"{label}: {finding}", file=sys.stderr)
    for hint in report["summary"]["hints"]:
        print(f"HINT: {hint}")
    print(
        f"Structure metrics: {len(report['summary']['failures'])} failures, "
        f"{len(report['summary']['hints'])} review hints "
        "(numbers are review prompts; only config/read/parse errors fail)."
    )
    return 0 if report["summary"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
