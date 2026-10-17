"""校验前端门槛数值与策略一致：``config/quality-policy.toml`` 是唯一来源。

ESLint / Vitest / Stryker 只能读 JS/JSON，因此数值另有一份
``frontend/quality-thresholds.json``。两份数值一旦漂移，「策略改了、工具没改」就会
静默发生——与 Python 侧结构数字和覆盖阈值必须同源同理，本脚本机器核对：

- ``[frontend]`` 的结构数值与口径 → ``structure.*``
- ``[frontend]`` 的覆盖阈值 → ``coverage.*``
- ``[frontend]`` 的变异门槛 → ``mutation.killedMin``

``mutation.high`` / ``mutation.low`` 只决定 Stryker 报告的着色，不是门槛，不参与核对。
"""

import argparse
import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "config/quality-policy.toml"
THRESHOLDS = ROOT / "frontend/quality-thresholds.json"

# 策略键 → quality-thresholds.json 的取值路径。
MAPPING: dict[str, tuple[str, ...]] = {
    "function_lines_max": ("structure", "functionLinesMax"),
    "file_lines_max": ("structure", "fileLinesMax"),
    "complexity_max": ("structure", "complexityMax"),
    "depth_max": ("structure", "depthMax"),
    "params_max": ("structure", "paramsMax"),
    "statements_max": ("structure", "statementsMax"),
    "exclude_blank_lines": ("structure", "functionLinesSkipBlankLines"),
    "exclude_comment_only_lines": ("structure", "functionLinesSkipComments"),
    "coverage_line_min": ("coverage", "lines"),
    "coverage_branch_min": ("coverage", "branches"),
    "coverage_function_min": ("coverage", "functions"),
    "coverage_statement_min": ("coverage", "statements"),
    "mutation_killed_min": ("mutation", "killedMin"),
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def nested(document: dict, keys: tuple[str, ...]) -> object:
    current: object = document
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            raise KeyError(".".join(keys))
        current = current[key]
    return current


def compare(policy: dict, thresholds: dict) -> list[str]:
    problems: list[str] = []
    frontend = policy.get("frontend")
    if not isinstance(frontend, dict):
        return ["配置缺少 [frontend] 段：前端门槛数值必须与本文件同源"]
    for policy_key, path in MAPPING.items():
        if policy_key not in frontend:
            problems.append(f"[frontend] 缺少 {policy_key}")
            continue
        try:
            recorded = nested(thresholds, path)
        except KeyError:
            problems.append(f"frontend/quality-thresholds.json 缺少 {'/'.join(path)}")
            continue
        if recorded != frontend[policy_key]:
            problems.append(
                f"{policy_key} 不一致: 策略={frontend[policy_key]!r} 工具={recorded!r}"
                f"（{'/'.join(path)}）"
            )
    return problems


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY)
    parser.add_argument("--thresholds", type=Path, default=THRESHOLDS)
    args = parser.parse_args(argv)
    try:
        policy = tomllib.loads(args.policy.read_text(encoding="utf-8"))
        thresholds = load_json(args.thresholds)
    except (OSError, tomllib.TOMLDecodeError, json.JSONDecodeError) as error:
        print(f"FAIL: 读取门槛配置失败: {type(error).__name__}: {error}")
        return 1
    problems = compare(policy, thresholds)
    if problems:
        for problem in problems:
            print(f"FAIL: {problem}")
        return 1
    print(f"OK: 前端门槛与 {args.policy.name} [frontend] 一致（{len(MAPPING)} 项）。")
    return 0


if __name__ == "__main__":
    sys.exit(run())
