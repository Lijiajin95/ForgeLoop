"""前端三道 Python 侧门禁的负例回归测试（可靠性方案第 11 节负例矩阵）。

- ``scripts/check_frontend_policy.py``：门槛数值必须与 ``config/quality-policy.toml``
  的 [frontend] 段一致；数值漂移、缺段、缺键都必须失败。
- ``scripts/check_frontend_build.py``：随包页面模块必须与 TypeScript 源一致；
  产物缺失、多出、内容不同都必须被逐文件指出，写入路径还必须被守卫拦住。
- ``scripts/check_frontend_mutation.py``：报告缺失/为空、击杀率不足、未审阅幸存者
  都必须失败；已登记但消失的条目只作提示。
"""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"


def load_module(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy_gate = load_module("check_frontend_policy")
build_gate = load_module("check_frontend_build")
mutation_gate = load_module("check_frontend_mutation")


def policy_document() -> dict:
    return {
        "frontend": {
            "function_lines_max": 50,
            "file_lines_max": 500,
            "complexity_max": 10,
            "depth_max": 4,
            "params_max": 5,
            "statements_max": 50,
            "exclude_blank_lines": True,
            "exclude_comment_only_lines": True,
            "coverage_line_min": 90,
            "coverage_branch_min": 90,
            "coverage_function_min": 90,
            "coverage_statement_min": 90,
            "mutation_killed_min": 90,
        }
    }


def thresholds_document() -> dict:
    return {
        "structure": {
            "functionLinesMax": 50,
            "functionLinesSkipBlankLines": True,
            "functionLinesSkipComments": True,
            "fileLinesMax": 500,
            "complexityMax": 10,
            "depthMax": 4,
            "paramsMax": 5,
            "statementsMax": 50,
        },
        "coverage": {"lines": 90, "branches": 90, "functions": 90, "statements": 90},
        "mutation": {"killedMin": 90, "high": 95, "low": 90},
    }


class TestFrontendPolicyGate:
    def test_shipped_policy_and_thresholds_match(self) -> None:
        assert (
            policy_gate.compare(
                policy_gate.tomllib.loads(
                    (ROOT / "config/quality-policy.toml").read_text(encoding="utf-8")
                ),
                json.loads((ROOT / "frontend/quality-thresholds.json").read_text(encoding="utf-8")),
            )
            == []
        )

    def test_drifted_threshold_fails_with_both_values(self) -> None:
        thresholds = thresholds_document()
        thresholds["coverage"]["branches"] = 80

        problems = policy_gate.compare(policy_document(), thresholds)

        assert len(problems) == 1
        assert "coverage_branch_min" in problems[0]
        assert "90" in problems[0] and "80" in problems[0]

    def test_missing_section_is_rejected(self) -> None:
        assert policy_gate.compare({}, thresholds_document()) == [
            "配置缺少 [frontend] 段：前端门槛数值必须与本文件同源"
        ]

    def test_missing_policy_key_is_reported(self) -> None:
        policy = policy_document()
        del policy["frontend"]["complexity_max"]

        problems = policy_gate.compare(policy, thresholds_document())

        assert problems == ["[frontend] 缺少 complexity_max"]

    def test_missing_threshold_key_is_reported(self) -> None:
        thresholds = thresholds_document()
        del thresholds["structure"]["depthMax"]

        problems = policy_gate.compare(policy_document(), thresholds)

        assert problems == ["frontend/quality-thresholds.json 缺少 structure/depthMax"]

    def test_unreadable_inputs_fail_the_run(self, tmp_path: Path, capsys) -> None:
        code = policy_gate.run(
            [
                "--policy",
                str(tmp_path / "missing.toml"),
                "--thresholds",
                str(ROOT / "frontend/quality-thresholds.json"),
            ]
        )

        assert code == 1
        assert "FAIL" in capsys.readouterr().out

    def test_real_files_pass_the_run(self, capsys) -> None:
        assert policy_gate.run([]) == 0
        assert "OK" in capsys.readouterr().out


def write_module(directory: Path, name: str, content: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(content, encoding="utf-8")


class TestFrontendBuildGate:
    def test_identical_directories_have_no_differences(self, tmp_path: Path) -> None:
        built = tmp_path / "built"
        committed = tmp_path / "committed"
        write_module(built, "app.js", "export {};\n")
        write_module(committed, "app.js", "export {};\n")

        assert build_gate.differences(built, committed) == []

    def test_changed_content_is_reported(self, tmp_path: Path) -> None:
        built = tmp_path / "built"
        committed = tmp_path / "committed"
        write_module(built, "format.js", "export const A = 1;\n")
        write_module(committed, "format.js", "export const A = 2;\n")

        problems = build_gate.differences(built, committed)

        assert problems == [
            "产物与源不一致: src/forgeloop/cli/static/format.js（重新运行 make frontend-build）"
        ]

    def test_missing_artifact_is_reported(self, tmp_path: Path) -> None:
        built = tmp_path / "built"
        committed = tmp_path / "committed"
        write_module(built, "page.js", "export {};\n")
        committed.mkdir()

        problems = build_gate.differences(built, committed)

        assert problems == ["产物缺失: src/forgeloop/cli/static/page.js（源已产出但未提交）"]

    def test_stale_artifact_is_reported(self, tmp_path: Path) -> None:
        built = tmp_path / "built"
        committed = tmp_path / "committed"
        built.mkdir()
        write_module(committed, "old.js", "export {};\n")

        problems = build_gate.differences(built, committed)

        assert problems == ["产物多余: src/forgeloop/cli/static/old.js（源已无此模块，应删除）"]

    def test_missing_tsc_fails_with_install_hint(self, monkeypatch, tmp_path: Path) -> None:
        repository = tmp_path / "repo"
        frontend = repository / "frontend"
        frontend.mkdir(parents=True)
        monkeypatch.setattr(build_gate, "ROOT", repository)
        monkeypatch.setattr(build_gate, "FRONTEND", frontend)
        monkeypatch.setattr(build_gate, "TSC", frontend / "node_modules/.bin/tsc")
        monkeypatch.setattr(build_gate, "TSCONFIG", frontend / "tsconfig.build.json")

        ok, message = build_gate.compile_to(tmp_path / "out")

        assert ok is False
        assert "make frontend-setup" in message

    def test_missing_tsconfig_is_reported(self, monkeypatch, tmp_path: Path) -> None:
        repository = tmp_path / "repo"
        frontend = repository / "frontend"
        tsc = frontend / "node_modules/.bin/tsc"
        tsc.parent.mkdir(parents=True)
        tsc.write_text("#!/bin/sh\n", encoding="utf-8")
        monkeypatch.setattr(build_gate, "ROOT", repository)
        monkeypatch.setattr(build_gate, "FRONTEND", frontend)
        monkeypatch.setattr(build_gate, "TSC", tsc)
        monkeypatch.setattr(build_gate, "TSCONFIG", frontend / "tsconfig.build.json")

        ok, message = build_gate.compile_to(tmp_path / "out")

        assert ok is False
        assert "tsconfig.build.json" in message

    def test_update_path_is_guarded(self, monkeypatch, tmp_path: Path) -> None:
        """写入路径守卫：目标不是本仓库的静态产物目录时拒绝。"""

        monkeypatch.setattr(build_gate, "ROOT", tmp_path / "not-the-repo")

        with pytest.raises(SystemExit, match="拒绝写入非预期目录"):
            build_gate._guarded_target()

    def test_update_writes_artifacts_and_removes_stale_files(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        repository = tmp_path / "repo"
        target = repository / "src/forgeloop/cli/static"
        write_module(target, "stale.js", "// 旧产物\n")
        (repository / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        built = tmp_path / "built"
        write_module(built, "app.js", "export {};\n")
        monkeypatch.setattr(build_gate, "ROOT", repository)

        code = build_gate.update_from(built)

        assert code == 0
        assert (target / "app.js").is_file()
        assert not (target / "stale.js").exists()


def mutant(
    status: str, *, line: int = 10, column: int = 4, name: str = "ConditionalExpression"
) -> dict:
    return {
        "status": status,
        "mutatorName": name,
        "replacement": "true",
        "location": {"start": {"line": line, "column": column}},
    }


def report(*mutants: dict) -> dict:
    """与 read_report 的输出同形：文件名 → 变异体列表。"""
    return {"src/format.ts": list(mutants)}


def frontend_policy(minimum: int = 90, reviewed: tuple[str, ...] = ()) -> dict:
    return {
        "frontend": {
            "mutation_killed_min": minimum,
            "reviewed_survivors": [{"mutant": key} for key in reviewed],
        }
    }


class TestFrontendMutationGate:
    def test_score_uses_detected_over_detected_plus_undetected(self) -> None:
        """口径与 Stryker 一致：timeout 计入检出，no coverage 计入未检出。"""

        detected, undetected, score = mutation_gate.score_of(
            report(
                mutant("Killed"),
                mutant("Timeout"),
                mutant("Survived"),
                mutant("NoCoverage"),
            )
        )

        assert (detected, undetected) == (2, 2)
        assert score == 50.0

    def test_low_score_fails(self) -> None:
        failures, _ = mutation_gate.evaluate(
            frontend_policy(minimum=90), report(mutant("Killed"), mutant("Survived"))
        )

        assert any("击杀率 50.00% 低于门槛 90%" in failure for failure in failures)

    def test_unreviewed_survivor_fails_with_its_key(self) -> None:
        # 门槛设为 0，单独检验「幸存者必须登记」这一条（击杀率另有用例）。
        failures, _ = mutation_gate.evaluate(
            frontend_policy(minimum=0), report(mutant("Killed"), mutant("Survived"))
        )

        assert failures == ["未审阅的幸存者: src/format.ts:10:4:ConditionalExpression:true"]

    def test_reviewed_survivor_passes_and_missing_entry_only_hints(self) -> None:
        key = "src/format.ts:10:4:ConditionalExpression:true"

        failures, hints = mutation_gate.evaluate(
            frontend_policy(minimum=0, reviewed=(key,)),
            report(mutant("Killed"), mutant("Survived")),
        )
        assert failures == []
        assert hints == []

        failures, hints = mutation_gate.evaluate(
            frontend_policy(reviewed=(key,)), report(mutant("Killed"))
        )
        assert failures == []
        assert hints == [f"已登记的幸存者本次未出现，可清理: {key}"]

    def test_empty_report_fails(self) -> None:
        failures, _ = mutation_gate.evaluate(frontend_policy(), report())

        assert failures == ["变异报告为空：没有任何变异体被评估"]

    def test_missing_threshold_config_fails(self) -> None:
        failures, _ = mutation_gate.evaluate({}, report(mutant("Killed")))

        assert failures == ["配置缺少 [frontend] mutation_killed_min"]

    def test_missing_report_file_fails_the_run(self, tmp_path: Path, capsys) -> None:
        code = mutation_gate.run(["--report", str(tmp_path / "missing.json")])

        assert code == 1
        assert "变异报告不存在" in capsys.readouterr().out

    def test_corrupted_report_fails_the_run(self, tmp_path: Path, capsys) -> None:
        broken = tmp_path / "report.json"
        broken.write_text("{not json", encoding="utf-8")

        assert mutation_gate.run(["--report", str(broken)]) == 1
        assert "无法解析" in capsys.readouterr().out

    def test_shipped_report_and_policy_pass(self, capsys) -> None:
        """本地真实报告与登记条目必须自洽（含 9 个幸存者全部已审阅）。

        ``reports/`` 不入库（.gitignore），报告只由 ``make frontend-mutation`` 产出，
        干净克隆与 CI 上必然不存在：此时跳过而不是断言一个并不随仓库发布的文件。
        「报告缺失必须失败」由 ``test_missing_report_file_fails_the_run`` 与夜间
        frontend-mutation 作业里的 ``scripts/check_frontend_mutation.py`` 保证。
        """

        if not mutation_gate.REPORT.is_file():
            pytest.skip(
                "reports/frontend-mutation.json 不存在（reports/ 不入库，先运行 make frontend-mutation）"
            )

        assert mutation_gate.run([]) == 0
        assert "OK" in capsys.readouterr().out
