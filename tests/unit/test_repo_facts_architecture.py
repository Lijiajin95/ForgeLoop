"""合法源码分层改读机读架构事实的单元测试。

覆盖验收要求：``repo_facts`` 不再硬编码源码分层；合法分层来自
``contracts/architecture.json`` 的 ``modules`` 与 ``layer_edges``；契约新增分层
无需改代码即可生效、删除分层立即失效；臆造路径、未登记目录与把文件当目录使用
仍被拒绝；模块保持纯规则层，不依赖 ``cli``/``graph``/``adapter``/``langgraph``。

另覆盖运行期边界：契约缺失或损坏时导入不崩溃（wheel 部署与 mutmut 副本），
默认事实退化为“架构未知”并对所有路径 fail-closed。
"""

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from forgeloop.domain import repo_facts
from forgeloop.domain.repo_facts import (
    DEFAULT_REPO_FACTS,
    RepoFacts,
    RepoFactsError,
    file_location_problem,
    load_architecture_contract,
    parse_architecture_contract,
    repo_facts_from_architecture,
    repository_facts_payload,
    resolve_architecture_contract,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
# 不写死 ``<repo>/contracts``：mutmut 在 ``<repo>/mutants`` 下跑测试，用与生产
# 同源的向上定位找到所属仓库根的契约。
CONTRACT_PATH = resolve_architecture_contract()

BASE_LAYERS = ("domain", "records", "adapter", "graph", "cli")
BASE_EDGES = (
    ("__main__", "cli"),
    ("cli", "adapter"),
    ("cli", "domain"),
    ("cli", "graph"),
    ("cli", "records"),
    ("graph", "adapter"),
    ("graph", "domain"),
    ("graph", "records"),
    ("records", "domain"),
)


def contract(
    *,
    layers: tuple[str, ...],
    edges: tuple[tuple[str, str], ...] = (),
    source_root: str = "src/forgeloop",
) -> dict[str, object]:
    """构造一份最小机读架构契约，供动态分层解析使用。"""

    registered = {f"forgeloop.{layer}": layer for layer in layers}
    registered["forgeloop"] = "(root)"
    registered["forgeloop.__main__"] = "__main__"
    return {
        "source_root": source_root,
        "modules": registered,
        "layer_edges": [list(edge) for edge in edges],
    }


def directory_layers(payload: dict[str, object]) -> set[str]:
    """独立于实现复算目录分层：标识符层值，排除结构哨兵。"""

    modules = payload["modules"]
    assert isinstance(modules, dict)
    return {
        value
        for value in modules.values()
        if isinstance(value, str)
        and value.isidentifier()
        and not (value.startswith("__") and value.endswith("__"))
    }


class TestRealContract:
    def test_default_layers_follow_the_contract_file(self) -> None:
        assert CONTRACT_PATH is not None, "仓库根的 contracts/architecture.json 应可定位"
        payload = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        assert set(DEFAULT_REPO_FACTS.source_layers) == directory_layers(payload)
        # 契约可以登记更多分层（例如 2026-10-16 登记的 mail）；基础五层必须始终在内。
        assert set(BASE_LAYERS) <= set(DEFAULT_REPO_FACTS.source_layers)

    def test_structural_sentinels_are_not_layers(self) -> None:
        assert "(root)" not in DEFAULT_REPO_FACTS.source_layers
        assert "__main__" not in DEFAULT_REPO_FACTS.source_layers

    def test_every_default_layer_accepts_a_source_path(self) -> None:
        for layer in DEFAULT_REPO_FACTS.source_layers:
            assert file_location_problem(f"src/forgeloop/{layer}/module.py") is None

    def test_default_layers_include_all_foundations(self) -> None:
        # 分层顺序由契约给出，不再保证「基础层在前」；只要求基础五层齐备。
        assert set(BASE_LAYERS) <= set(DEFAULT_REPO_FACTS.source_layers)


class TestDynamicLayers:
    def test_new_contract_layer_is_legal_without_code_change(self) -> None:
        facts = repo_facts_from_architecture(
            contract(layers=(*BASE_LAYERS, "mail"), edges=(*BASE_EDGES, ("cli", "mail")))
        )
        assert "mail" in facts.source_layers
        assert file_location_problem("src/forgeloop/mail/__init__.py", facts) is None
        # 默认事实（当前契约未登记 payments）拒绝同一形态的路径，证明判定确实随契约而变。
        assert file_location_problem("src/forgeloop/payments/__init__.py") is not None

    def test_removed_layer_is_rejected(self) -> None:
        facts = repo_facts_from_architecture(
            contract(layers=("domain", "records", "adapter", "graph"))
        )
        assert "cli" not in facts.source_layers
        problem = file_location_problem("src/forgeloop/cli/main.py", facts)
        assert problem is not None and "源码路径不在合法分层" in problem

    def test_same_call_flips_with_the_contract(self) -> None:
        path = "src/forgeloop/mail/send.py"
        without_mail = repo_facts_from_architecture(contract(layers=(*BASE_LAYERS,)))
        with_mail = repo_facts_from_architecture(contract(layers=(*BASE_LAYERS, "mail")))
        assert file_location_problem(path, without_mail) is not None
        assert file_location_problem(path, with_mail) is None

    def test_edges_change_only_order_not_membership(self) -> None:
        without = repo_facts_from_architecture(contract(layers=BASE_LAYERS))
        with_edges = repo_facts_from_architecture(contract(layers=BASE_LAYERS, edges=BASE_EDGES))
        assert set(without.source_layers) == set(with_edges.source_layers)
        assert with_edges.source_layers == BASE_LAYERS

    def test_factory_keeps_unrelated_facts(self) -> None:
        facts = repo_facts_from_architecture(contract(layers=("domain", "mail")))
        assert facts.source_root == "src/forgeloop"
        assert facts.test_layers == DEFAULT_REPO_FACTS.test_layers
        assert facts.interpreters == DEFAULT_REPO_FACTS.interpreters

    def test_payload_reports_derived_layers(self) -> None:
        facts = repo_facts_from_architecture(contract(layers=("domain", "mail")))
        payload = repository_facts_payload(facts)
        assert set(payload["source_layers"]) == {"domain", "mail"}


class TestNegativeProtection:
    def test_unregistered_directory_is_rejected(self) -> None:
        problem = file_location_problem("src/forgeloop/bogus/status.py")
        assert problem is not None and "源码路径不在合法分层" in problem

    def test_fabricated_top_level_module_is_rejected(self) -> None:
        problem = file_location_problem("src/forgeloop/fabricated.py")
        assert problem is not None and "不在已知清单内" in problem

    def test_directory_and_layer_name_are_rejected(self) -> None:
        for relative in ("src/forgeloop/domain", "src/forgeloop/mail"):
            problem = file_location_problem(relative)
            assert problem is not None and "不是文件名" in problem

    def test_file_prefix_is_rejected(self) -> None:
        problem = file_location_problem("src/forgeloop/domain/status.py/extra")
        assert problem is not None and "当作目录" in problem

    def test_out_of_project_paths_are_rejected(self) -> None:
        assert file_location_problem("/etc/passwd") is not None
        assert file_location_problem("../outside.py") is not None


class TestContractLoading:
    def test_load_reads_a_contract_file(self, tmp_path: Path) -> None:
        path = tmp_path / "architecture.json"
        path.write_text(json.dumps(contract(layers=("domain", "mail"))), encoding="utf-8")
        facts = load_architecture_contract(path)
        assert facts.source_root == "src/forgeloop"
        assert set(facts.source_layers) == {"domain", "mail"}

    def test_missing_contract_is_reported(self, tmp_path: Path) -> None:
        with pytest.raises(RepoFactsError):
            load_architecture_contract(tmp_path / "missing.json")

    def test_unreadable_json_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "architecture.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(RepoFactsError):
            load_architecture_contract(path)

    @pytest.mark.parametrize(
        "payload",
        [
            [],
            {},
            {"modules": {"forgeloop": "domain"}},
            {"source_root": "src/forgeloop", "modules": "not-a-mapping"},
            {"source_root": "src/forgeloop", "modules": {"forgeloop": "(root)"}},
        ],
    )
    def test_malformed_contract_is_reported(self, payload: object) -> None:
        with pytest.raises(RepoFactsError):
            parse_architecture_contract(payload)


class TestMissingContractIsFailClosed:
    """契约缺失或损坏时导入不崩溃，且路径校验 fail-closed。"""

    def test_resolve_returns_none_when_no_contract_above(self, tmp_path: Path) -> None:
        isolated = tmp_path / "isolated"
        isolated.mkdir()
        assert resolve_architecture_contract(isolated) is None

    def test_resolve_finds_contract_in_ancestor(self, tmp_path: Path) -> None:
        contracts = tmp_path / "contracts"
        contracts.mkdir()
        (contracts / "architecture.json").write_text(
            json.dumps(contract(layers=("domain",))), encoding="utf-8"
        )
        nested = tmp_path / "mutants" / "src"
        nested.mkdir(parents=True)
        assert resolve_architecture_contract(nested) == contracts / "architecture.json"

    def test_facts_without_architecture_reject_every_path(self) -> None:
        unavailable = RepoFacts(source_root="", source_layers=())
        assert unavailable.source_layers == ()
        for relative in (
            "src/forgeloop/domain/status.py",
            "tests/unit/test_x.py",
            "docs/architecture.md",
        ):
            problem = file_location_problem(relative, unavailable)
            assert problem is not None and "架构契约不可用" in problem

    def test_repo_facts_requires_source_root_and_layers_together(self) -> None:
        with pytest.raises(ValueError):
            RepoFacts(source_root="src/forgeloop", source_layers=())
        with pytest.raises(ValueError):
            RepoFacts(source_root="", source_layers=("domain",))

    def test_import_does_not_require_the_contract(self, tmp_path: Path) -> None:
        # 真实文件系统边界：把包复制到无 contracts/ 的目录，cwd 也在那里，
        # 模拟 wheel 装到 site-packages 后从任意目录导入（含 --help 链路）。
        package_root = tmp_path / "lib"
        shutil.copytree(REPO_ROOT / "src" / "forgeloop", package_root / "forgeloop")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(package_root)
        script = (
            "import forgeloop.domain.repo_facts as repo_facts;"
            "assert repo_facts.DEFAULT_REPO_FACTS.source_layers == (), "
            "repo_facts.DEFAULT_REPO_FACTS.source_layers;"
            "problem = repo_facts.file_location_problem('src/forgeloop/domain/x.py');"
            "assert problem and '架构契约不可用' in problem, problem;"
            "print('imported-without-contract')"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert "imported-without-contract" in result.stdout


class TestPureRuleLayer:
    def test_repo_facts_has_no_orchestration_dependencies(self) -> None:
        source = Path(repo_facts.__file__).read_text(encoding="utf-8")
        imported: set[str] = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        forbidden = {
            name
            for name in imported
            if name == "langgraph"
            or name.startswith(("forgeloop.cli", "forgeloop.graph", "forgeloop.adapter"))
        }
        assert forbidden == set()
        assert all(
            name.split(".")[0] in sys.stdlib_module_names or name.startswith("forgeloop.domain")
            for name in imported
        )
