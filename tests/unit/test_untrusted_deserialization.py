"""Local AST check for unsafe YAML deserialization (Ruff S506 gap).

Every case is an in-memory source string, so the suite never reads the repository
sources or writes files. The nine-line dangerous sample mirrors the ``.semgrep.yml``
scope: ``yaml.unsafe_load``, the unsafe ``Loader``/``UnsafeLoader`` variants, and a
plain ``yaml.load`` without a loader must all be caught, while the safe calls stay
silent with exit code 0.
"""

import importlib.util
import io
from pathlib import Path
from types import ModuleType

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load_module(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = load_module("check_untrusted_deserialization")

# 9 lines: import + assignment + 7 deserialization calls (5 unsafe, 2 safe).
NINE_LINE_DANGEROUS_SAMPLE = """\
import yaml
stream = "a: 1"
data1 = yaml.unsafe_load(stream)
data2 = yaml.load(stream, Loader=yaml.UnsafeLoader)
data3 = yaml.load(stream, Loader=yaml.Loader)
data4 = yaml.load(stream)
data5 = yaml.load(stream, yaml.Loader)
data6 = yaml.safe_load(stream)
data7 = yaml.load(stream, Loader=yaml.SafeLoader)
"""

SAFE_SAMPLE = """\
import yaml
stream = "a: 1"
data = yaml.safe_load(stream)
also = yaml.load(stream, Loader=yaml.SafeLoader)
csafe = yaml.load(stream, Loader=yaml.CSafeLoader)
csafe_load = yaml.CSafeLoader(stream)
"""


def details(findings: list) -> list[str]:
    return [finding.detail for finding in findings]


def test_nine_line_dangerous_sample_hits_every_unsafe_call() -> None:
    findings = checker.find_unsafe_deserialization(NINE_LINE_DANGEROUS_SAMPLE, "sample.py")
    assert len(findings) == 5
    assert [finding.line for finding in findings] == [3, 4, 5, 6, 7]
    assert all(finding.path == "sample.py" for finding in findings)


def test_unsafe_load_is_reported() -> None:
    findings = checker.find_unsafe_deserialization("x = yaml.unsafe_load(stream)\n")
    assert details(findings) == ["yaml.unsafe_load always uses the unsafe loader"]


def test_unsafe_loader_is_reported() -> None:
    findings = checker.find_unsafe_deserialization(
        "x = yaml.load(stream, Loader=yaml.UnsafeLoader)\n"
    )
    assert details(findings) == ["yaml.load with Loader=yaml.UnsafeLoader uses the unsafe loader"]


def test_loader_is_reported() -> None:
    findings = checker.find_unsafe_deserialization("x = yaml.load(stream, Loader=yaml.Loader)\n")
    assert details(findings) == ["yaml.load with Loader=yaml.Loader uses the unsafe loader"]


def test_load_without_loader_is_reported() -> None:
    findings = checker.find_unsafe_deserialization("x = yaml.load(stream)\n")
    assert details(findings) == [
        "yaml.load without an explicit Loader defaults to the unsafe loader"
    ]


def test_positional_loader_is_reported() -> None:
    findings = checker.find_unsafe_deserialization("x = yaml.load(stream, yaml.Loader)\n")
    assert details(findings) == ["yaml.load with Loader=yaml.Loader uses the unsafe loader"]


def test_safe_calls_produce_no_findings() -> None:
    assert checker.find_unsafe_deserialization(SAFE_SAMPLE, "safe.py") == []


def test_unrelated_yaml_calls_are_ignored() -> None:
    assert checker.find_unsafe_deserialization("x = yaml.dump(payload)\n") == []


def test_run_is_silent_and_returns_zero_without_findings() -> None:
    out = io.StringIO()
    assert checker.run({"safe.py": SAFE_SAMPLE}, out) == 0
    assert out.getvalue() == ""


def test_run_prints_semgrep_equivalent_text_and_returns_one() -> None:
    out = io.StringIO()
    assert checker.run({"sample.py": NINE_LINE_DANGEROUS_SAMPLE}, out) == 1
    output = out.getvalue()
    assert checker.SEMGREP_RULE_ID in output
    assert checker.SEMGREP_MESSAGE in output
    assert "yaml.unsafe_load" in output
    assert output.count("FAIL:") == 5
