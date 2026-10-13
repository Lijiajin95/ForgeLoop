"""架构契约快照的漂移负例测试。

覆盖 `scripts/export_architecture_contract.py` 的五类判定：模块增删换层、跨层
边漂移、越层依赖、import 环，以及架构描述文档与源码模块清单的镜像关系。
最后一组用例直接对真实仓库运行，确保本文与源码在仓库内保持一致。
"""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "export_architecture_contract.py"
ROOT = Path(__file__).resolve().parents[2]

SAMPLE_FILES = {
    "src/forgeloop/__init__.py": '"""包声明。"""\n',
    "src/forgeloop/__main__.py": "from forgeloop.cli import main\n",
    "src/forgeloop/cli/__init__.py": "from forgeloop.cli.main import main\n",
    "src/forgeloop/cli/main.py": "from forgeloop.records.store import RecordStore\n",
    "src/forgeloop/records/__init__.py": '"""记录层。"""\n',
    "src/forgeloop/records/store.py": "from forgeloop.domain.rules import Rule\n",
    "src/forgeloop/domain/__init__.py": '"""领域层。"""\n',
    "src/forgeloop/domain/rules.py": "class Rule:\n    pass\n",
}


def load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_architecture_contract", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


class Fixture:
    """一个最小仓库：源码树、契约快照与架构描述文档。"""

    def __init__(self, tmp_path: Path, files: dict[str, str] | None = None) -> None:
        self.root = tmp_path
        self.files = dict(SAMPLE_FILES if files is None else files)
        self.write_tree(self.files)

    def write_tree(self, files: dict[str, str]) -> None:
        for relative, text in files.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def add(self, relative: str, text: str) -> None:
        self.files[relative] = text
        self.write_tree({relative: text})

    @property
    def snapshot(self) -> Path:
        return self.root / "contracts/architecture.json"

    @property
    def doc(self) -> Path:
        return self.root / "docs/architecture.md"

    def export(self) -> dict:
        contract = gate.build_contract(self.root)
        self.snapshot.parent.mkdir(parents=True, exist_ok=True)
        self.snapshot.write_text(gate.serialize(contract), encoding="utf-8")
        return contract

    def write_doc(self, paths: list[str] | None = None) -> None:
        listed = sorted(paths if paths is not None else self.files)
        body = "\n".join(f"| `{path}` | 职责 |" for path in listed)
        self.doc.parent.mkdir(parents=True, exist_ok=True)
        self.doc.write_text(f"# 架构说明\n\n{body}\n", encoding="utf-8")

    def check(self) -> list[str]:
        return gate.check_contract(self.root, self.snapshot, self.doc)


class TestContractFacts:
    def test_modules_and_layers_are_derived_from_the_tree(self, tmp_path: Path) -> None:
        contract = Fixture(tmp_path).export()
        assert contract["modules"]["forgeloop.domain.rules"] == "domain"
        assert contract["modules"]["forgeloop"] == "(root)"
        assert contract["modules"]["forgeloop.__main__"] == "__main__"

    def test_layer_edges_only_include_cross_layer_imports(self, tmp_path: Path) -> None:
        contract = Fixture(tmp_path).export()
        assert contract["layer_edges"] == [
            ["__main__", "cli"],
            ["cli", "records"],
            ["records", "domain"],
        ]

    def test_relative_imports_resolve_to_absolute_modules(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.add("src/forgeloop/cli/common.py", "value = 1\n")
        fixture.add(
            "src/forgeloop/cli/deploy.py",
            "from . import common\nfrom ..records import store\n",
        )
        modules = gate.scan_source(fixture.root / "src/forgeloop")
        edges = gate.module_edges(modules)
        assert ("forgeloop.cli.deploy", "forgeloop.cli.common") in edges
        assert ("forgeloop.cli.deploy", "forgeloop.records.store") in edges

    def test_same_layer_relative_import_adds_no_cross_layer_edge(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.add("src/forgeloop/cli/deploy.py", "from .common import helper\n")
        fixture.add("src/forgeloop/cli/common.py", "helper = 1\n")
        contract = fixture.export()
        assert contract["layer_edges"] == [
            ["__main__", "cli"],
            ["cli", "records"],
            ["records", "domain"],
        ]

    def test_third_party_imports_are_not_contract_edges(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.add("src/forgeloop/graph/nodes.py", "import langgraph\nfrom pathlib import Path\n")
        contract = fixture.export()
        assert "forgeloop.graph.nodes" in contract["modules"]
        assert ["graph", "langgraph"] not in contract["layer_edges"]


class TestSnapshotDrift:
    def test_matching_tree_and_document_pass(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        assert fixture.check() == []

    def test_missing_snapshot_fails(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.write_doc()
        assert "snapshot is missing" in fixture.check()[0]

    def test_added_module_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.add("src/forgeloop/domain/extra.py", "value = 1\n")
        findings = fixture.check()
        assert any("module added" in finding and "domain.extra" in finding for finding in findings)

    def test_removed_module_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        (fixture.root / "src/forgeloop/domain/rules.py").unlink()
        findings = fixture.check()
        assert any("module removed" in finding for finding in findings)

    def test_module_moved_to_another_layer_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        moved = (fixture.root / "src/forgeloop/domain/rules.py").read_text(encoding="utf-8")
        (fixture.root / "src/forgeloop/domain/rules.py").unlink()
        fixture.add("src/forgeloop/cli/rules.py", moved)
        findings = fixture.check()
        assert any("module added" in finding for finding in findings)
        assert any("module removed" in finding for finding in findings)

    def test_module_changed_layer_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        contract = fixture.export()
        fixture.write_doc()
        contract["modules"]["forgeloop.domain.rules"] = "cli"
        fixture.snapshot.write_text(gate.serialize(contract), encoding="utf-8")
        findings = fixture.check()
        assert any(
            "module changed layer: forgeloop.domain.rules (cli -> domain)" in finding
            for finding in findings
        )

    def test_added_layer_edge_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.add("src/forgeloop/adapter/runner.py", "value = 1\n")
        fixture.add("src/forgeloop/cli/main.py", "from forgeloop.adapter.runner import value\n")
        findings = fixture.check()
        assert any("layer dependency added: cli -> adapter" in finding for finding in findings)

    def test_recording_a_wrong_direction_edge_is_a_rule_violation(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.add("src/forgeloop/domain/rules.py", "from forgeloop.cli.main import main\n")
        contract = fixture.export()
        fixture.write_doc()
        assert ["domain", "cli"] in contract["layer_edges"]
        findings = fixture.check()
        assert any("violates the declared rules: domain -> cli" in finding for finding in findings)

    def test_import_cycle_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.add("src/forgeloop/cli/alpha.py", "from forgeloop.cli.beta import beta\n")
        fixture.add("src/forgeloop/cli/beta.py", "from forgeloop.cli.alpha import alpha\n")
        findings = fixture.check()
        assert any(finding.startswith("import cycle: ") for finding in findings)

    def test_unreadable_snapshot_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.snapshot.write_text("{not json", encoding="utf-8")
        assert "cannot be read" in fixture.check()[0]

    def test_contract_without_modules_mapping_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.snapshot.write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
        assert "no modules mapping" in fixture.check()[0]


class TestDocumentMirror:
    def test_module_missing_from_the_document_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc([path for path in fixture.files if "domain/rules" not in path])
        findings = fixture.check()
        assert any(
            "does not list module: src/forgeloop/domain/rules.py" in finding for finding in findings
        )

    def test_stale_module_in_the_document_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc([*fixture.files, "src/forgeloop/domain/deleted.py"])
        findings = fixture.check()
        assert any(
            "lists an unknown module: src/forgeloop/domain/deleted.py" in finding
            for finding in findings
        )

    def test_missing_document_is_reported(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        assert "architecture description is missing" in fixture.check()[0]


class TestRealRepository:
    def test_repository_architecture_matches_contract_and_document(self) -> None:
        findings = gate.check_contract(
            ROOT, ROOT / "contracts/architecture.json", ROOT / "docs/architecture.md"
        )
        assert findings == []

    def test_failure_message_asks_for_regeneration_and_document_update(
        self, tmp_path: Path
    ) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        fixture.add("src/forgeloop/domain/extra.py", "value = 1\n")
        ok, message = gate.run_check(fixture.root, fixture.snapshot, fixture.doc)
        assert ok is False
        assert "export_architecture_contract.py" in message
        assert "docs/architecture.md" in message

    def test_success_message_is_reported_as_ok(self, tmp_path: Path) -> None:
        fixture = Fixture(tmp_path)
        fixture.export()
        fixture.write_doc()
        ok, message = gate.run_check(fixture.root, fixture.snapshot, fixture.doc)
        assert ok is True
        assert message.startswith("OK: ")
