"""导出并校验架构契约快照：分层、模块清单与跨层依赖。

ForgeLoop 的架构事实来源是源码本身：包的物理分层（domain/records/adapter/
graph/cli）与跨层 import 边。人工叙述见 ``docs/architecture.md``；本脚本把同一
份事实落成机读快照 ``contracts/architecture.json``，让架构变化必须显式经过一次
快照更新，否则 ``make check`` 失败——以此强制同步架构描述文档。

``--check`` 拒绝以下情况（任一即失败）：

1. 模块新增、删除或换层（``modules`` 与源码不一致）；
2. 跨层依赖变化（``layer_edges`` 与源码不一致）；
3. 越层依赖：观测到的层间边不在 :data:`LAYER_RULES` 允许的方向内；
4. 模块之间出现 import 环；
5. 架构描述文档与源码模块清单不互为镜像（文档漏写新模块或残留已删除模块）。

修改架构后重新导出本快照，并在同一次改动中更新 ``docs/architecture.md``；
执行义务见 AGENTS.md、CONTRIBUTING.md 与 docs/development-discipline.md。
"""

import argparse
import ast
import json
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = "src/forgeloop"
ROOT_LAYER = "(root)"
ARCHITECTURE_DOC = "docs/architecture.md"
DEFAULT_SNAPSHOT = ROOT / "contracts/architecture.json"

# 架构的代码侧声明：每层只能依赖本表列出的层，同层内部依赖不受本表约束
# （由 import 环检查约束）。修改本表即为修改架构规则，必须同时更新架构描述文档。
LAYER_RULES: dict[str, tuple[str, ...]] = {
    ROOT_LAYER: (),
    "__main__": ("cli",),
    "cli": ("graph", "adapter", "records", "domain"),
    "graph": ("adapter", "records", "domain"),
    "adapter": (),
    "records": ("domain",),
    "domain": (),
}

MODULE_PATH_PATTERN = re.compile(r"src/forgeloop/[\w/]+\.py")


@dataclass(frozen=True)
class SourceModule:
    """一个源码模块及其所属层。"""

    name: str
    layer: str
    relative_path: str
    is_package: bool
    source: str


def module_name(path: Path, source_root: Path) -> str:
    parts = list(path.relative_to(source_root.parent).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def layer_of(name: str) -> str:
    """取包内第一段为层名；顶层包自身归入 ``(root)``。"""

    parts = name.split(".")
    return parts[1] if len(parts) > 1 else ROOT_LAYER


def scan_source(source_root: Path) -> list[SourceModule]:
    """读取源码树，返回按模块名排序的模块清单。"""

    modules: list[SourceModule] = []
    for path in sorted(source_root.rglob("*.py")):
        name = module_name(path, source_root)
        modules.append(
            SourceModule(
                name=name,
                layer=layer_of(name),
                relative_path=path.relative_to(source_root.parent.parent).as_posix(),
                is_package=path.name == "__init__.py",
                source=path.read_text(encoding="utf-8"),
            )
        )
    return sorted(modules, key=lambda module: module.name)


def _relative_base(module: SourceModule, node: ast.ImportFrom) -> str:
    """相对导入的基准包：导入者是包时为自身，否则为其父包。"""

    parts = module.name.split(".")
    package = parts if module.is_package else parts[:-1]
    prefix = package[: len(package) - (node.level - 1)] if node.level > 1 else package
    base = ".".join(prefix)
    return f"{base}.{node.module}" if node.module else base


def _node_targets(module: SourceModule, node: ast.AST) -> set[str]:
    if isinstance(node, ast.Import):
        return {alias.name for alias in node.names}
    if not isinstance(node, ast.ImportFrom):
        return set()
    base = _relative_base(module, node) if node.level else (node.module or "")
    if not base:
        return set()
    return {base} | {f"{base}.{alias.name}" for alias in node.names}


def import_targets(module: SourceModule) -> set[str]:
    """模块内所有 import 语句的目标（含包内与第三方，相对导入已解析）。"""

    targets: set[str] = set()
    for node in ast.walk(ast.parse(module.source)):
        targets.update(_node_targets(module, node))
    return {target for target in targets if target}


def resolve_module(target: str, known: Mapping[str, SourceModule]) -> str | None:
    """把 import 目标归一到包内已知模块（最长前缀匹配）；包外目标返回 None。"""

    candidate = target
    while candidate:
        if candidate in known:
            return candidate
        candidate = candidate.rsplit(".", 1)[0] if "." in candidate else ""
    return None


def module_edges(modules: list[SourceModule]) -> set[tuple[str, str]]:
    """模块级 import 边（去自环）。"""

    known = {module.name: module for module in modules}
    edges: set[tuple[str, str]] = set()
    for module in modules:
        for target in import_targets(module):
            resolved = resolve_module(target, known)
            if resolved is not None and resolved != module.name:
                edges.add((module.name, resolved))
    return edges


def layer_edges(modules: list[SourceModule]) -> set[tuple[str, str]]:
    """跨层依赖边（同层内部依赖不计）。"""

    layers = {module.name: module.layer for module in modules}
    return {
        (layers[source], layers[target])
        for source, target in module_edges(modules)
        if layers[source] != layers[target]
    }


def _walk_cycles(
    node: str,
    adjacency: Mapping[str, list[str]],
    state: dict[str, int],
    stack: list[str],
    cycles: list[tuple[str, ...]],
) -> None:
    state[node] = 1
    stack.append(node)
    for neighbour in adjacency[node]:
        if state[neighbour] == 1:
            cycles.append(tuple(stack[stack.index(neighbour) :]))
        elif state[neighbour] == 0:
            _walk_cycles(neighbour, adjacency, state, stack, cycles)
    stack.pop()
    state[node] = 2


def find_cycles(modules: list[SourceModule]) -> list[tuple[str, ...]]:
    """模块依赖图中的环；按模块名字典序确定性遍历。"""

    adjacency: dict[str, list[str]] = {module.name: [] for module in modules}
    for source, target in sorted(module_edges(modules)):
        adjacency[source].append(target)
    state: dict[str, int] = dict.fromkeys(adjacency, 0)
    cycles: list[tuple[str, ...]] = []
    for name in adjacency:
        if state[name] == 0:
            _walk_cycles(name, adjacency, state, [], cycles)
    return cycles


def build_contract(root: Path) -> dict:
    """从源码树构建架构契约（确定性输出）。"""

    modules = scan_source(root / SOURCE_ROOT)
    return {
        "schema_version": 1,
        "doc": ARCHITECTURE_DOC,
        "source_root": SOURCE_ROOT,
        "modules": {module.name: module.layer for module in modules},
        "layer_edges": [list(edge) for edge in sorted(layer_edges(modules))],
    }


def serialize(contract: dict) -> str:
    return json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def _recorded_edges(recorded: Mapping[str, object]) -> set[tuple[str, str]] | None:
    """快照中的跨层边；形状不合法时返回 None（避免把坏快照当成一致）。"""

    raw = recorded.get("layer_edges")
    if not isinstance(raw, list):
        return None
    pairs: set[tuple[str, str]] = set()
    for edge in raw:
        if isinstance(edge, list) and len(edge) == 2:
            pairs.add((str(edge[0]), str(edge[1])))
    return pairs


def _snapshot_findings(modules: list[SourceModule], recorded: Mapping[str, object]) -> list[str]:
    observed = {module.name: module.layer for module in modules}
    expected = recorded.get("modules")
    if not isinstance(expected, Mapping):
        return ["architecture contract has no modules mapping"]
    findings: list[str] = []
    for name in sorted(set(observed) - set(expected)):
        findings.append(f"module added since the snapshot: {name} (layer {observed[name]})")
    for name in sorted(set(expected) - set(observed)):
        findings.append(f"module removed since the snapshot: {name}")
    for name in sorted(set(observed) & set(expected)):
        if observed[name] != expected[name]:
            findings.append(f"module changed layer: {name} ({expected[name]} -> {observed[name]})")
    recorded_edges = _recorded_edges(recorded)
    if recorded_edges is None:
        return [*findings, "architecture contract has no layer_edges list"]
    for edge in sorted(layer_edges(modules) - recorded_edges):
        findings.append(f"layer dependency added: {edge[0]} -> {edge[1]}")
    for edge in sorted(recorded_edges - layer_edges(modules)):
        findings.append(f"layer dependency removed: {edge[0]} -> {edge[1]}")
    return findings


def _rule_findings(modules: list[SourceModule]) -> list[str]:
    findings = [
        f"layer has no declared rules: {layer}"
        for layer in sorted({module.layer for module in modules} - set(LAYER_RULES))
    ]
    for source, target in sorted(layer_edges(modules)):
        if source in LAYER_RULES and target not in LAYER_RULES[source]:
            allowed = ", ".join(LAYER_RULES[source]) or "none"
            findings.append(
                f"layer dependency violates the declared rules: "
                f"{source} -> {target} (allowed from {source}: {allowed})"
            )
    return findings


def _cycle_findings(modules: list[SourceModule]) -> list[str]:
    return [f"import cycle: {' -> '.join([*cycle, cycle[0]])}" for cycle in find_cycles(modules)]


def _doc_findings(modules: list[SourceModule], doc_path: Path) -> list[str]:
    if not doc_path.is_file():
        return [f"architecture description is missing: {doc_path}"]
    documented = set(MODULE_PATH_PATTERN.findall(doc_path.read_text(encoding="utf-8")))
    expected = {module.relative_path for module in modules}
    findings = [
        f"architecture description does not list module: {path}"
        for path in sorted(expected - documented)
    ]
    findings.extend(
        f"architecture description lists an unknown module: {path}"
        for path in sorted(documented - expected)
    )
    return findings


def check_contract(root: Path, snapshot_path: Path, doc_path: Path) -> list[str]:
    """返回全部发现项；空列表表示架构、快照与描述文档三者一致。"""

    if not snapshot_path.is_file():
        return [f"architecture contract snapshot is missing: {snapshot_path}"]
    try:
        recorded = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f"architecture contract cannot be read: {error}"]
    if not isinstance(recorded, Mapping):
        return [f"architecture contract is not a JSON object: {snapshot_path}"]
    modules = scan_source(root / SOURCE_ROOT)
    return [
        *_snapshot_findings(modules, recorded),
        *_rule_findings(modules),
        *_cycle_findings(modules),
        *_doc_findings(modules, doc_path),
    ]


def run_check(root: Path, snapshot_path: Path, doc_path: Path) -> tuple[bool, str]:
    findings = check_contract(root, snapshot_path, doc_path)
    if not findings:
        return True, "OK: architecture matches the contract snapshot and the description document."
    lines = [f"FAIL: {finding}" for finding in findings]
    lines.append(
        "FAIL: architecture changed; run scripts/export_architecture_contract.py and update "
        f"{ARCHITECTURE_DOC} in the same change."
    )
    return False, "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--doc", type=Path, default=ROOT / ARCHITECTURE_DOC)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.check:
        ok, message = run_check(args.root.resolve(), args.snapshot.resolve(), args.doc.resolve())
        print(message)
        return 0 if ok else 1
    contract = build_contract(args.root.resolve())
    args.snapshot.resolve().parent.mkdir(parents=True, exist_ok=True)
    args.snapshot.resolve().write_text(serialize(contract), encoding="utf-8")
    print(f"Architecture contract snapshot written: {args.snapshot}")
    print(f"modules: {len(contract['modules'])}, layer edges: {len(contract['layer_edges'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
