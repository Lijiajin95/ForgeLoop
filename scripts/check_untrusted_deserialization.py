"""Reject unsafe YAML deserialization in ``src`` and ``scripts`` with a local AST scan.

Ruff's ``S506`` bandit rule is part of the configured lint selection and already
flags ``Loader=yaml.Loader``/``UnsafeLoader``, ``yaml.load`` without a ``Loader``,
and a ``Loader`` passed as the second positional argument. The one form ``S506``
does not cover is the ``yaml.unsafe_load`` alias; the removed ``.semgrep.yml`` rule
``forgeloop-no-unsafe-deserialization`` matched that alias (its pickle patterns are
now covered by ``S301``). This check closes the ``yaml.unsafe_load`` gap without a
Semgrep dependency by parsing the Python sources and flagging every YAML call that
can execute arbitrary constructors; the ``S506``-covered forms below are re-flagged
only as defense in depth:

* ``yaml.unsafe_load(...)``;
* ``yaml.load(..., Loader=yaml.UnsafeLoader)``;
* ``yaml.load(..., Loader=yaml.Loader)``;
* ``yaml.load(...)`` with no explicit ``Loader`` (PyYAML defaults to the unsafe loader).

``yaml.safe_load`` and ``yaml.load(..., Loader=yaml.SafeLoader)`` are safe and stay
silent. The failure text mirrors the Semgrep rule so the two gates explain the same
policy. No finding means a silent exit code 0.
"""

import argparse
import ast
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

ROOT = Path(__file__).resolve().parents[1]
SCAN_ROOTS = ("src", "scripts")
SEMGREP_RULE_ID = "forgeloop-no-unsafe-deserialization"
SEMGREP_MESSAGE = (
    "Untrusted records and PI artifacts require a safe, explicitly validated serialization format."
)
UNSAFE_METHODS = frozenset({"unsafe_load"})
LOAD_METHODS = frozenset({"load"})
UNSAFE_LOADERS = frozenset({"UnsafeLoader", "Loader"})


@dataclass(frozen=True)
class Finding:
    """A single unsafe YAML call site."""

    path: str
    line: int
    column: int
    detail: str


def _yaml_method(node: ast.AST) -> str | None:
    """Return the method name for ``yaml.<method>`` calls, else ``None``."""
    if not isinstance(node, ast.Attribute):
        return None
    if not (isinstance(node.value, ast.Name) and node.value.id == "yaml"):
        return None
    return node.attr


def _loader_name(node: ast.AST) -> str | None:
    """Return the loader attribute/name (``yaml.Loader`` -> ``Loader``) when readable."""
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def _explicit_loader(call: ast.Call) -> str | None:
    """Find the loader passed as a ``Loader=`` keyword or second positional argument."""
    for keyword in call.keywords:
        if keyword.arg == "Loader":
            return _loader_name(keyword.value)
    if len(call.args) >= 2:
        return _loader_name(call.args[1])
    return None


def find_unsafe_deserialization(source: str, path: str = "<unknown>") -> list[Finding]:
    """Parse ``source`` and return every unsafe YAML deserialization call site."""
    tree = ast.parse(source, filename=path)
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        method = _yaml_method(node.func)
        if method is None:
            continue
        if method in UNSAFE_METHODS:
            detail = f"yaml.{method} always uses the unsafe loader"
        elif method in LOAD_METHODS:
            loader = _explicit_loader(node)
            if loader is None:
                detail = "yaml.load without an explicit Loader defaults to the unsafe loader"
            elif loader in UNSAFE_LOADERS:
                detail = f"yaml.load with Loader=yaml.{loader} uses the unsafe loader"
            else:
                continue
        else:
            continue
        findings.append(Finding(path, node.lineno, node.col_offset, detail))
    findings.sort(key=lambda finding: (finding.path, finding.line, finding.column))
    return findings


def check_sources(sources: Mapping[str, str]) -> list[Finding]:
    """Run the scan over an in-memory mapping of ``path -> source``."""
    findings: list[Finding] = []
    for path, source in sources.items():
        findings.extend(find_unsafe_deserialization(source, path))
    findings.sort(key=lambda finding: (finding.path, finding.line, finding.column))
    return findings


def collect_sources(roots: Sequence[str] = SCAN_ROOTS, root: Path = ROOT) -> dict[str, str]:
    """Read every ``*.py`` file under ``roots`` keyed by its path relative to ``root``."""
    sources: dict[str, str] = {}
    for relative in roots:
        directory = root / relative
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.py")):
            sources[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
    return sources


def render_finding(finding: Finding) -> str:
    """Render one finding with the Semgrep-equivalent explanation."""
    location = f"{finding.path}:{finding.line}:{finding.column}"
    return f"{SEMGREP_RULE_ID}: {location}: {finding.detail} ({SEMGREP_MESSAGE})"


def run(sources: Mapping[str, str], out: TextIO) -> int:
    """Report findings to ``out``; return the process exit code."""
    findings = check_sources(sources)
    for finding in findings:
        print(f"FAIL: {render_finding(finding)}", file=out)
    return 1 if findings else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    return run(collect_sources(SCAN_ROOTS, root), sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
