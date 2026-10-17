"""判定前端变异结果：击杀率门槛与幸存者逐项审阅（对应 Python 的 check_mutation_stats.py）。

读 Stryker 的 JSON 报告（`make frontend-mutation` 产出），三条判定：

1. **报告缺失或为空即失败**——不能把「没跑」当成「通过」（与 Python 侧
   ``require_nonempty_report`` 同理）；
2. **击杀率低于 ``[frontend] mutation_killed_min`` 即失败**；口径与 Stryker 一致：
   ``(killed + timeout) / (killed + timeout + survived + no_coverage)``；
3. **未登记的幸存者即失败**——每个幸存者必须在 ``[[frontend.reviewed_survivors]]``
   里给出等价性或非行为契约的理由（同 Python 的 ``critical_unreviewed_survivors_max = 0``）。
   已登记但本次不再出现的条目只作提示，供人工清理（同 Python 的过期条目提示）。

幸存者键：``文件:行:列:变异算子:替换内容``。同一位置可能产生多个等价变异（例如把
条件与子表达式分别替换为 ``true``），键相同时一条登记覆盖它们。
"""

import argparse
import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "config/quality-policy.toml"
REPORT = ROOT / "reports/frontend-mutation.json"

DETECTED = {"Killed", "Timeout"}
UNDETECTED = {"Survived", "NoCoverage"}


def survivor_key(file: str, mutant: dict) -> str:
    start = mutant["location"]["start"]
    return f"{file}:{start['line']}:{start['column']}:{mutant['mutatorName']}:{mutant.get('replacement', '')}"


def read_report(path: Path) -> tuple[dict[str, list[dict]] | None, str]:
    """返回 (按文件分组的变异体, 失败原因)；读取失败时变异体为空。"""

    if not path.is_file():
        return None, f"变异报告不存在: {path}（先运行 make frontend-mutation）"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, f"变异报告无法解析: {type(error).__name__}: {error}"
    files = document.get("files")
    if not isinstance(files, dict):
        return None, "变异报告缺少 files 段"
    mutants: dict[str, list[dict]] = {}
    for name, info in files.items():
        entries = info.get("mutants") if isinstance(info, dict) else None
        if not isinstance(entries, list):
            return None, f"变异报告条目损坏: {name}"
        mutants[str(name)] = list(entries)
    return mutants, ""


def score_of(mutants: dict[str, list[dict]]) -> tuple[int, int, float]:
    """返回 (检出数, 未检出数, 击杀率百分比)。"""

    detected = sum(
        1 for entries in mutants.values() for m in entries if m.get("status") in DETECTED
    )
    undetected = sum(
        1 for entries in mutants.values() for m in entries if m.get("status") in UNDETECTED
    )
    total = detected + undetected
    return detected, undetected, (100.0 * detected / total if total else 0.0)


def survivors_of(mutants: dict[str, list[dict]]) -> list[str]:
    return sorted(
        survivor_key(file, m)
        for file, entries in mutants.items()
        for m in entries
        if m.get("status") == "Survived"
    )


def reviewed_keys(policy: dict) -> list[str]:
    frontend = policy.get("frontend")
    entries = frontend.get("reviewed_survivors") if isinstance(frontend, dict) else None
    return [str(entry["mutant"]) for entry in entries or []]


def evaluate(policy: dict, mutants: dict[str, list[dict]]) -> tuple[list[str], list[str]]:
    """返回 (失败项, 提示项)。"""

    frontend = policy.get("frontend")
    minimum = frontend.get("mutation_killed_min") if isinstance(frontend, dict) else None
    if not isinstance(minimum, (int, float)):
        return ["配置缺少 [frontend] mutation_killed_min"], []
    detected, undetected, score = score_of(mutants)
    failures: list[str] = []
    if detected + undetected == 0:
        failures.append("变异报告为空：没有任何变异体被评估")
    elif score < minimum:
        failures.append(
            f"击杀率 {score:.2f}% 低于门槛 {minimum}%（检出 {detected}，未检出 {undetected}）"
        )
    reviewed = set(reviewed_keys(policy))
    survivors = survivors_of(mutants)
    for key in survivors:
        if key not in reviewed:
            failures.append(f"未审阅的幸存者: {key}")
    hints = [
        f"已登记的幸存者本次未出现，可清理: {key}" for key in sorted(reviewed - set(survivors))
    ]
    return failures, hints


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args(argv)
    try:
        policy = tomllib.loads(args.policy.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        print(f"FAIL: 读取门槛配置失败: {type(error).__name__}: {error}")
        return 1
    mutants, problem = read_report(args.report)
    if mutants is None:
        print(f"FAIL: {problem}")
        return 1
    failures, hints = evaluate(policy, mutants)
    for hint in hints:
        print(f"HINT: {hint}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    detected, undetected, score = score_of(mutants)
    print(
        f"OK: 前端变异击杀率 {score:.2f}%（检出 {detected}，未检出 {undetected}，"
        f"登记幸存者 {len(reviewed_keys(policy))} 条）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(run())
