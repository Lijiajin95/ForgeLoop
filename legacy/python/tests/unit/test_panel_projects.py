"""面板项目档案与注册表的单元测试：字段校验、合并、序列化与增删改判定。

钉住的是「项目身份只有一个来源」这条硬规则的两个方向：同名必须失败（不静默覆盖），
手写档案页面不可改（不由页面代笔改所有者的文件）。
"""

from pathlib import Path

import pytest

from forgeloop.cli.panel import PanelRegistry, PanelRejected
from forgeloop.domain.projects import (
    SOURCE_PANEL,
    SOURCE_SERVICE,
    PanelProject,
    PanelProjectError,
    ProjectEntry,
    merge_projects,
    project_from_fields,
    resolve_panel_projects,
    serialize_panel_projects,
)
from forgeloop.domain.service import ProjectProfile


def service_profile(name: str = "svc") -> ProjectProfile:
    return ProjectProfile(
        name=name,
        path=f"/srv/{name}",
        pi_command=("pi", "--mode", "rpc"),
        test_command=("pytest",),
        baseline="",
        pi_home=f"/home/{name}/pi-home",
    )


def panel_project(name: str = "demo") -> PanelProject:
    return PanelProject(
        name=name,
        path=f"/srv/{name}",
        description="演示项目",
        pi_command=("pi", "--mode", "rpc", "--no-session"),
        pi_home=f"/home/{name}/pi-home",
    )


class TestProjectFields:
    def test_valid_fields(self) -> None:
        project = project_from_fields(
            "demo",
            {
                "path": "/srv/demo",
                "description": "演示",
                "pi_command": ["pi", "--mode", "rpc"],
                "pi_home": "/home/demo/pi-home",
            },
        )
        assert project.pi_command == ("pi", "--mode", "rpc")
        assert project.description == "演示"

    def test_description_is_optional(self) -> None:
        project = project_from_fields(
            "demo",
            {"path": "/srv/demo", "pi_command": ["pi"], "pi_home": "/home/demo"},
        )
        assert project.description == ""

    @pytest.mark.parametrize(
        ("name", "fields"),
        [
            ("bad name", {"path": "/srv/d", "pi_command": ["pi"], "pi_home": "/h"}),
            ("a/b", {"path": "/srv/d", "pi_command": ["pi"], "pi_home": "/h"}),
            ("demo", {"pi_command": ["pi"], "pi_home": "/h"}),
            ("demo", {"path": "/srv/d", "pi_home": "/h"}),
            ("demo", {"path": "/srv/d", "pi_command": ["pi"]}),
            ("demo", {"path": "/srv/d", "pi_command": "pi", "pi_home": "/h"}),
            ("demo", {"path": "/srv/d", "pi_command": [], "pi_home": "/h"}),
            ("demo", {"path": "/srv/d", "pi_command": ["pi"], "pi_home": "/h", "extra": 1}),
            ("demo", {"path": "", "pi_command": ["pi"], "pi_home": "/h"}),
        ],
    )
    def test_invalid_fields_are_rejected(self, name: str, fields: dict) -> None:
        with pytest.raises(PanelProjectError):
            project_from_fields(name, fields)


class TestResolveDocument:
    def test_missing_document_is_empty(self) -> None:
        assert dict(resolve_panel_projects(None)) == {}

    def test_document_without_projects_is_empty(self) -> None:
        assert dict(resolve_panel_projects({"schema_version": 1})) == {}

    def test_projects_are_read(self) -> None:
        document = {
            "schema_version": 1,
            "projects": {
                "demo": {
                    "path": "/srv/demo",
                    "pi_command": ["pi"],
                    "pi_home": "/home/demo",
                }
            },
        }
        projects = resolve_panel_projects(document)
        assert projects["demo"].path == "/srv/demo"

    @pytest.mark.parametrize(
        "document",
        [
            {"schema_version": 2},
            {"schema_version": 1, "unknown": 1},
            {"schema_version": 1, "projects": []},
            {"schema_version": 1, "projects": {"demo": []}},
            {"schema_version": 1, "projects": {"demo": {"path": "/srv/demo"}}},
        ],
    )
    def test_invalid_documents_are_rejected(self, document: dict) -> None:
        with pytest.raises(PanelProjectError):
            resolve_panel_projects(document)


class TestSerialization:
    def test_round_trip(self) -> None:
        projects = {"demo": panel_project("demo"), "a.b": panel_project("a.b")}
        text = serialize_panel_projects(projects)
        import tomllib

        restored = resolve_panel_projects(tomllib.loads(text))
        assert dict(restored) == projects

    def test_dotted_names_are_quoted(self) -> None:
        text = serialize_panel_projects({"a.b": panel_project("a.b")})
        assert '[projects."a.b"]' in text

    def test_special_characters_are_escaped(self) -> None:
        project = PanelProject(
            name="demo",
            path='/srv/de"mo\\x',
            description="第一行\n第二行\t制表",
            pi_command=("pi",),
            pi_home="/home/demo",
        )
        text = serialize_panel_projects({"demo": project})
        import tomllib

        assert resolve_panel_projects(tomllib.loads(text))["demo"] == project

    def test_output_is_sorted_and_therefore_deterministic(self) -> None:
        left = serialize_panel_projects({"b": panel_project("b"), "a": panel_project("a")})
        right = serialize_panel_projects({"a": panel_project("a"), "b": panel_project("b")})
        assert left == right
        assert left.index('[projects."a"]') < left.index('[projects."b"]')


class TestMerge:
    def test_sources_are_labelled_and_sorted(self) -> None:
        entries = merge_projects({"svc": service_profile()}, {"demo": panel_project()})
        assert [entry.name for entry in entries] == ["demo", "svc"]
        assert entries[0].source == SOURCE_PANEL
        assert entries[0].editable is True
        assert entries[1].source == SOURCE_SERVICE
        assert entries[1].editable is False

    def test_same_name_in_both_sources_is_a_conflict(self) -> None:
        with pytest.raises(PanelProjectError) as error:
            merge_projects({"demo": service_profile("demo")}, {"demo": panel_project()})
        assert "重复" in str(error.value)


class TestRegistry:
    def registry(self, path: Path, service: dict | None = None) -> PanelRegistry:
        return PanelRegistry(service or {}, path)

    def test_missing_file_is_an_empty_registry(self, tmp_path: Path) -> None:
        assert self.registry(tmp_path / "projects.toml").entries() == ()

    def test_create_update_and_remove(self, tmp_path: Path) -> None:
        path = tmp_path / "projects.toml"
        registry = self.registry(path)
        registry.create(panel_project("demo"))
        assert [entry.name for entry in registry.entries()] == ["demo"]
        assert path.is_file()

        renamed = PanelProject(
            name="demo2",
            path="/srv/demo",
            description="改名",
            pi_command=("pi",),
            pi_home="/home/demo",
        )
        registry.update("demo", renamed)
        assert [entry.name for entry in registry.entries()] == ["demo2"]

        registry.remove("demo2")
        assert registry.entries() == ()

    def test_duplicate_name_is_refused(self, tmp_path: Path) -> None:
        registry = self.registry(tmp_path / "projects.toml")
        registry.create(panel_project("demo"))
        with pytest.raises(PanelRejected) as error:
            registry.create(panel_project("demo"))
        assert error.value.status == 409
        assert error.value.code == "name_conflict"

    def test_service_managed_names_are_refused(self, tmp_path: Path) -> None:
        registry = self.registry(tmp_path / "projects.toml", {"svc": service_profile()})
        with pytest.raises(PanelRejected) as error:
            registry.create(panel_project("svc"))
        assert error.value.code == "name_conflict"
        with pytest.raises(PanelRejected) as update_error:
            registry.update("svc", panel_project("svc"))
        assert update_error.value.code == "service_managed"
        with pytest.raises(PanelRejected) as remove_error:
            registry.remove("svc")
        assert remove_error.value.code == "service_managed"

    def test_unknown_project_is_404(self, tmp_path: Path) -> None:
        registry = self.registry(tmp_path / "projects.toml")
        with pytest.raises(PanelRejected) as error:
            registry.remove("ghost")
        assert error.value.status == 404

    def test_corrupt_file_is_reported(self, tmp_path: Path) -> None:
        path = tmp_path / "projects.toml"
        path.write_text("这不是 TOML =", encoding="utf-8")
        with pytest.raises(PanelProjectError) as error:
            self.registry(path).entries()
        assert "解析失败" in str(error.value)

    def test_entries_are_read_from_disk_each_time(self, tmp_path: Path) -> None:
        """页面写完之后立刻可见：注册表不缓存（改配置文件同样即时生效）。"""

        path = tmp_path / "projects.toml"
        registry = self.registry(path)
        path.write_text(serialize_panel_projects({"late": panel_project("late")}), encoding="utf-8")
        assert [entry.name for entry in registry.entries()] == ["late"]

    def test_by_name_indexes_entries(self, tmp_path: Path) -> None:
        path = tmp_path / "projects.toml"
        registry = self.registry(path, {"svc": service_profile()})
        registry.create(panel_project("demo"))
        assert sorted(registry.by_name()) == ["demo", "svc"]
        entry: ProjectEntry = registry.by_name()["demo"]
        assert entry.pi_home == "/home/demo/pi-home"
