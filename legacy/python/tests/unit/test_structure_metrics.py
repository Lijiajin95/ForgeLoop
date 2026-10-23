"""结构度量与门槛的负例回归测试（可靠性方案第 11 节负例矩阵）。

复刻 EvidHist 已验证的负例：51 行函数、21 接口、501 文件行；
同时固定统计口径（docstring/空行/注释排除、嵌套函数、字符串内 #）。
2026-10-13 起结构数字是**审阅提示**而非交付阻断（可靠性方案第 25 节）：
超限产生提示、配置损坏与源码解析失败仍须拒绝。
"""

import importlib.util
import textwrap
from pathlib import Path
from types import ModuleType

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load_module(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metrics = load_module("structure_metrics")
checker = load_module("check_structure_metrics")

POLICY_TOML = """
schema_version = 1

[scope]
handwritten_roots = ["src"]
extensions = [".py"]
generated_roots = []

[structure]
function_effective_lines_warn = 40
function_effective_lines_max = 50
exclude_blank_lines = true
exclude_comment_only_lines = true
exclude_python_docstrings = true
include_signature = true
include_nested_function_ranges = true
public_interfaces_warn = 10
public_interfaces_max = 20
public_interface_mode = "own-methods-and-properties"
file_physical_lines_warn = 300
file_physical_lines_max = 500
reviewed_file_exception_ceiling = 1000
reviewed_exceptions = []

[structure.review_hints]
return_statements_max = 6
statements_max = 50
local_variables_max = 15
complexity_max = 10
parameters_max = 5
branches_max = 12

[coverage]
line_min = 90
branch_min = 90
changed_line_min = 90

[mutation]
general_killed_min = 90
critical_unreviewed_survivors_max = 0
unresolved_incomplete_states_max = 0
require_nonempty_report = true

[property_tests]
local_examples = 100
ci_examples = 300
extended_examples = 1000
"""


def run_on_source(root: Path, source: str, name: str = "mod.py") -> dict:
    (root / "src").mkdir(parents=True, exist_ok=True)
    (root / "src" / name).write_text(source, encoding="utf-8")
    config = root / "policy.toml"
    config.write_text(POLICY_TOML, encoding="utf-8")
    return checker.run_check(root, config)


class TestCountingCalibers:
    def test_docstrings_blank_and_comments_are_excluded(self) -> None:
        source = textwrap.dedent(
            '''\
            def measured():
                """docstring
                more docstring
                """
                # comment only
                value = 1  # trailing comment still counts
                return value
            '''
        )
        functions, _classes = metrics.python_metrics(source, "m.py")
        assert functions[0].effective_lines == 3  # def 行 + 赋值 + return

    def test_hash_inside_string_counts_as_code(self) -> None:
        source = 'def measured():\n    text = "not # a comment"\n    return text\n'
        functions, _classes = metrics.python_metrics(source, "m.py")
        assert functions[0].effective_lines == 3

    def test_nested_function_counted_separately_and_kept_in_outer_range(self) -> None:
        source = textwrap.dedent(
            """\
            def outer():
                def inner():
                    return 1
                return inner()
            """
        )
        functions, _classes = metrics.python_metrics(source, "m.py")
        by_name = {f.name: f for f in functions}
        assert by_name["outer"].effective_lines == 4  # 嵌套内容保留在外层范围
        assert by_name["inner"].effective_lines == 2

    def test_public_interface_dedup_and_privates_excluded(self) -> None:
        source = textwrap.dedent(
            """\
            class Klass:
                def public(self): ...
                def _private(self): ...
                def __repr__(self): ...
            """
        )
        _functions, classes = metrics.python_metrics(source, "m.py")
        assert classes[0].public_interfaces == 1
        assert classes[0].interfaces == (("instance", "public"),)


class TestStructureNumbersAreReviewHints:
    """超限只产生提示，不阻断交付；统计与报告仍然保留。"""

    def test_fifty_one_line_function_is_a_review_hint(self, tmp_path: Path) -> None:
        body = "\n".join(f"    v{i} = {i}" for i in range(50))
        source = f"def too_long():\n{body}\n"
        report = run_on_source(tmp_path, source)
        assert report["summary"]["passed"]
        assert report["summary"]["failures"] == []
        assert any("effective lines" in hint for hint in report["summary"]["hints"])
        assert report["python"]["functions"][0]["effective_lines"] == 51  # 统计保留

    def test_twenty_one_interfaces_is_a_review_hint(self, tmp_path: Path) -> None:
        methods = "\n".join(f"    def method_{i}(self): ..." for i in range(21))
        source = f"class Wide:\n{methods}\n"
        report = run_on_source(tmp_path, source)
        assert report["summary"]["passed"]
        assert any("public interfaces" in hint for hint in report["summary"]["hints"])
        assert report["python"]["classes"][0]["public_interfaces"] == 21

    def test_five_hundred_one_file_lines_is_a_review_hint(self, tmp_path: Path) -> None:
        source = "\n".join(f"x{i} = {i}" for i in range(501)) + "\n"
        report = run_on_source(tmp_path, source)
        assert report["summary"]["passed"]
        assert any("physical lines" in hint for hint in report["summary"]["hints"])
        assert report["python"]["files"][0]["physical_lines"] == 501

    def test_reviewed_exception_beyond_ceiling_is_a_review_hint(self, tmp_path: Path) -> None:
        source = "\n".join(f"x{i} = {i}" for i in range(1200)) + "\n"
        (tmp_path / "src").mkdir(parents=True, exist_ok=True)
        (tmp_path / "src" / "big.py").write_text(source, encoding="utf-8")
        policy = POLICY_TOML.replace(
            "reviewed_exceptions = []",
            "[[structure.reviewed_exceptions]]\n"
            'path = "src/big.py"\n'
            'rule = "file_physical_lines"\n'
            'reason = "受控生成"\n'
            'owner = "owner"\n'
            'review = "review"\n'
            'recheck = "2027-01-01"',
        )
        config = tmp_path / "policy.toml"
        config.write_text(policy, encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert report["summary"]["passed"]
        assert any("ceiling" in hint for hint in report["summary"]["hints"])

    def test_reviewed_exception_within_ceiling_reports_no_hint(self, tmp_path: Path) -> None:
        source = "\n".join(f"x{i} = {i}" for i in range(600)) + "\n"
        (tmp_path / "src").mkdir(parents=True, exist_ok=True)
        (tmp_path / "src" / "big.py").write_text(source, encoding="utf-8")
        policy = POLICY_TOML.replace(
            "reviewed_exceptions = []",
            "[[structure.reviewed_exceptions]]\n"
            'path = "src/big.py"\n'
            'rule = "file_physical_lines"\n'
            'reason = "受控生成"\n'
            'owner = "owner"\n'
            'review = "review"\n'
            'recheck = "2027-01-01"',
        )
        config = tmp_path / "policy.toml"
        config.write_text(policy, encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert report["summary"]["passed"]
        assert report["summary"]["hints"] == []


class TestComplexityBranchAndParameterHints:
    """圈复杂度、分支数与参数数由结构报告统一给出提示（不再由 Ruff 阻断）。"""

    def test_complexity_branches_and_parameters_are_counted(self) -> None:
        source = textwrap.dedent(
            """\
            def shaped(a, b, c, d, *args, flag=False, **kwargs):
                if a and b:
                    return 1
                elif c:
                    return 2
                else:
                    return 3
            """
        )
        functions, _classes = metrics.python_metrics(source, "m.py")
        metric = functions[0]
        assert metric.parameters == 5  # a b c d flag；*args/**kwargs 不计
        assert metric.branches == 3  # if、elif（并列 ast.If）与 else
        assert metric.complexity == 4  # 1 + 两个 if 节点 + 一个布尔运算

    def test_nested_scopes_are_counted_separately(self) -> None:
        source = textwrap.dedent(
            """\
            def outer():
                def inner(value):
                    if value:
                        return 1
                    return 0
                return inner(1)
            """
        )
        functions, _classes = metrics.python_metrics(source, "m.py")
        by_name = {f.name: f for f in functions}
        assert by_name["outer"].complexity == 1
        assert by_name["inner"].complexity == 2

    def test_over_limit_function_reports_hint_for_each_metric(self, tmp_path: Path) -> None:
        conditions = "\n".join(f"    if x == {i}:\n        x += 1" for i in range(13))
        source = f"def busy(x, a, b, c, d, e):\n{conditions}\n    return x\n"
        report = run_on_source(tmp_path, source)
        assert report["summary"]["passed"]
        hints = report["summary"]["hints"]
        assert any("complexity" in hint for hint in hints)
        assert any("branches" in hint for hint in hints)
        assert any("parameters" in hint for hint in hints)

    def test_review_hint_limits_must_be_integers(self, tmp_path: Path) -> None:
        policy = POLICY_TOML.replace("complexity_max = 10", 'complexity_max = "high"')
        config = tmp_path / "policy.toml"
        config.write_text(policy, encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert any("complexity_max" in failure for failure in report["summary"]["failures"])


class TestConfigAndParseFailures:
    """配置损坏、源码解析失败与工具执行异常仍须失败，不能被提示口径吞掉。"""

    def test_reviewed_exception_requires_all_keys(self, tmp_path: Path) -> None:
        policy = POLICY_TOML.replace(
            "reviewed_exceptions = []",
            '[[structure.reviewed_exceptions]]\npath = "src/x.py"\nrule = "r"',
        )
        config = tmp_path / "policy.toml"
        config.write_text(policy, encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert any("missing keys" in f for f in report["summary"]["failures"])

    def test_missing_config_file_fails(self, tmp_path: Path) -> None:
        report = checker.run_check(tmp_path, tmp_path / "absent.toml")
        assert not report["summary"]["passed"]
        assert any(
            "配置" in failure or "config" in failure for failure in report["summary"]["failures"]
        )

    def test_malformed_config_fails(self, tmp_path: Path) -> None:
        config = tmp_path / "policy.toml"
        config.write_text("schema_version = = 1\n", encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert report["summary"]["failures"]

    def test_missing_structure_section_fails(self, tmp_path: Path) -> None:
        config = tmp_path / "policy.toml"
        config.write_text('schema_version = 1\n[scope]\nhandwritten_roots = ["src"]\n')
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert any("[structure]" in failure for failure in report["summary"]["failures"])

    def test_caliber_drift_fails(self, tmp_path: Path) -> None:
        policy = POLICY_TOML.replace("exclude_blank_lines = true", "exclude_blank_lines = false")
        config = tmp_path / "policy.toml"
        config.write_text(policy, encoding="utf-8")
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert any("exclude_blank_lines" in failure for failure in report["summary"]["failures"])

    def test_source_parse_failure_fails(self, tmp_path: Path) -> None:
        report = run_on_source(tmp_path, "def broken(:\n    pass\n", name="broken.py")
        assert not report["summary"]["passed"]
        failures = report["summary"]["failures"]
        assert any("src/broken.py" in failure and "SyntaxError" in failure for failure in failures)

    def test_unreadable_source_fails(self, tmp_path: Path, monkeypatch) -> None:
        source = "def fine():\n    return 1\n"
        (tmp_path / "src").mkdir(parents=True, exist_ok=True)
        (tmp_path / "src" / "mod.py").write_text(source, encoding="utf-8")
        config = tmp_path / "policy.toml"
        config.write_text(POLICY_TOML, encoding="utf-8")
        original_read_text = Path.read_text

        def broken_read(self, encoding=None):
            if self.name == "mod.py":
                raise OSError("permission denied")
            return original_read_text(self, encoding=encoding)

        monkeypatch.setattr(Path, "read_text", broken_read)
        report = checker.run_check(tmp_path, config)
        assert not report["summary"]["passed"]
        assert any("permission denied" in failure for failure in report["summary"]["failures"])
