"""项目登记、记录根与跨项目定位的单元测试。

覆盖多项目隔离的确定性规则：身份/显示名/路径校验、登记表读写、项目记录根的
路径形状、跨项目唯一定位（零命中与重复都失败），以及旧根目录迁移的混合项目拒绝。
"""

from pathlib import Path

import pytest
from project_support import ensure_project_repo

from forgeloop.domain.project import (
    ProjectError,
    ProjectNotFoundError,
    project_data_root,
    validate_default_branch,
    validate_project_id,
    validate_project_name,
    validate_repo_path,
)
from forgeloop.records.projects import (
    ProjectStore,
    RecordLocationError,
    iter_projects,
    locate_requirement,
    locate_task,
    migrate_legacy,
    project_by_name,
    project_counts,
    project_location,
    project_records_path,
)
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore


class TestProjectIdentity:
    def test_valid_identity_is_returned(self) -> None:
        assert validate_project_id("forgeloop") == "forgeloop"
        assert validate_project_id("proj-2") == "proj-2"

    @pytest.mark.parametrize(
        "value",
        ["", "a", "ForgeLoop", "-lead", "trail-", "double--dash", "with/slash", "../escape", "点"],
    )
    def test_invalid_identity_is_rejected(self, value: str) -> None:
        with pytest.raises(ProjectError):
            validate_project_id(value)

    def test_name_and_path_and_branch_shapes(self) -> None:
        assert validate_project_name("  ForgeLoop  ") == "ForgeLoop"
        assert validate_repo_path("  /tmp/repo  ") == "/tmp/repo"
        assert validate_default_branch("") == ""
        assert validate_default_branch("main") == "main"
        for bad_name in ("", "   ", "line\nbreak"):
            with pytest.raises(ProjectError):
                validate_project_name(bad_name)
        for bad_path in ("", "   ", "with\x00nul"):
            with pytest.raises(ProjectError):
                validate_repo_path(bad_path)
        for bad_branch in ("-dash", "a..b", "with\nnewline"):
            with pytest.raises(ProjectError):
                validate_default_branch(bad_branch)

    def test_data_root_is_fixed_below_projects(self, tmp_path: Path) -> None:
        assert project_data_root(tmp_path, "forgeloop") == tmp_path / "projects" / "forgeloop"
        with pytest.raises(ProjectError):
            project_data_root(tmp_path, "../escape")


class TestProjectStore:
    def test_add_get_list_update_remove(self, tmp_path: Path) -> None:
        store = ProjectStore(project_records_path(tmp_path))
        try:
            added = store.add("forgeloop", "ForgeLoop", "/tmp/repo")
            assert store.get("forgeloop") == added
            assert [project.project_id for project in store.list()] == ["forgeloop"]
            updated = store.update("forgeloop", name="ForgeLoop 2", default_branch="main")
            assert updated.name == "ForgeLoop 2"
            assert updated.default_branch == "main"
            assert store.get("forgeloop") == updated
            store.remove("forgeloop")
            assert store.list() == ()
        finally:
            store.close()

    def test_duplicate_identity_and_unknown_lookup(self, tmp_path: Path) -> None:
        store = ProjectStore(project_records_path(tmp_path))
        try:
            store.add("forgeloop", "ForgeLoop", "/tmp/repo")
            with pytest.raises(ProjectError, match="已登记"):
                store.add("forgeloop", "Other", "/tmp/other")
            with pytest.raises(ProjectNotFoundError):
                store.require("missing")
            with pytest.raises(ProjectNotFoundError):
                store.remove("missing")
        finally:
            store.close()

    def test_legacy_name_resolution(self, tmp_path: Path) -> None:
        store = ProjectStore(project_records_path(tmp_path))
        try:
            store.add("forgeloop", "ForgeLoop", "/tmp/repo", legacy_project="旧项目")
            assert store.get_by_name("旧项目") is not None
            assert store.get_by_name("forgeloop") is not None
            assert store.get_by_name("other") is None
        finally:
            store.close()
        assert project_by_name(tmp_path, "旧项目") is not None
        assert project_by_name(tmp_path, "missing") is None


class TestRecordLocation:
    def _seed(self, base: Path, project_id: str, task_id: str, req_text: str) -> str:
        project_store = ProjectStore(project_records_path(base))
        try:
            project = project_store.add(
                project_id, project_id, str(ensure_project_repo(base / project_id))
            )
        finally:
            project_store.close()
        location = project_location(project, base)
        location.root.mkdir(parents=True, exist_ok=True)
        store = RecordStore(location.root / "records.sqlite")
        try:
            store.create_task(task_id, project_id, "输入", {}, 60.0)
        finally:
            store.close()
        requirements = RequirementStore(location.root / "records.sqlite")
        try:
            return requirements.submit(project_id, req_text).req_id
        finally:
            requirements.close()

    def test_unique_locations_and_counts(self, tmp_path: Path, monkeypatch) -> None:
        # 两个项目各自建立需求与任务；同名任务在第二个项目中重复，定位必须失败。
        self._seed(tmp_path, "alpha", "task-a", "需求 A")
        req_b = self._seed(tmp_path, "beta", "task-b", "需求 B")
        assert locate_task(tmp_path, "task-a").project.project_id == "alpha"
        assert locate_requirement(tmp_path, req_b).project.project_id == "beta"
        with pytest.raises(RecordLocationError, match="任务不存在"):
            locate_task(tmp_path, "task-missing")
        with pytest.raises(RecordLocationError, match="需求不存在"):
            locate_requirement(tmp_path, "需求缺失")

    def test_duplicate_identity_across_projects_is_rejected(self, tmp_path: Path) -> None:
        req_a = self._seed(tmp_path, "alpha", "task-dup", "需求 A")
        self._seed(tmp_path, "beta", "task-dup", "需求 B")
        with pytest.raises(RecordLocationError, match="跨项目重复"):
            locate_task(tmp_path, "task-dup")
        # 需求身份全局唯一：这里用同一身份在两个项目各写一条（模拟数据复制）验证歧义拒绝。
        requirements = RequirementStore(project_data_root(tmp_path, "beta") / "records.sqlite")
        try:
            duplicate = requirements.submit("beta", "需求 C")
            requirements._db.execute(
                "UPDATE requirements SET req_id = ? WHERE req_id = ?",
                (req_a, duplicate.req_id),
            )
            requirements._db.execute(
                "UPDATE requirement_versions SET req_id = ? WHERE req_id = ?",
                (req_a, duplicate.req_id),
            )
        finally:
            requirements.close()
        with pytest.raises(RecordLocationError, match="跨项目重复"):
            locate_requirement(tmp_path, req_a)

    def test_counts_are_per_project(self, tmp_path: Path) -> None:
        self._seed(tmp_path, "alpha", "task-a", "需求 A")
        self._seed(tmp_path, "beta", "task-b", "需求 B")
        counts = {
            location.project.project_id: project_counts(location)
            for location in iter_projects(tmp_path)
        }
        assert counts == {"alpha": (1, 1), "beta": (1, 1)}


class TestLegacyMigration:
    def _legacy(self, legacy: Path, project: str = "forgeloop") -> str:
        store = RecordStore(legacy / "records.sqlite")
        try:
            store.create_task("task-legacy", project, "输入", {}, 60.0)
        finally:
            store.close()
        (legacy / "task-legacy").mkdir(parents=True, exist_ok=True)
        (legacy / "task-legacy" / "candidate.diff").write_text("diff\n", encoding="utf-8")
        (legacy / "checkpoints.sqlite").write_bytes(b"checkpoint")
        requirements = RequirementStore(legacy / "records.sqlite")
        try:
            return requirements.submit(project, "旧需求").req_id
        finally:
            requirements.close()

    def test_migrates_same_project_records(self, tmp_path: Path) -> None:
        legacy = tmp_path / "legacy"
        legacy.mkdir()
        self._legacy(legacy)
        base = tmp_path / "records"
        added = ProjectStore(project_records_path(base))
        try:
            added.add("forgeloop", "ForgeLoop", str(ensure_project_repo(tmp_path / "repo")))
        finally:
            added.close()

        report = migrate_legacy(base, "forgeloop", legacy, "forgeloop")

        assert report.moved_records is True
        assert report.moved_checkpoints is True
        assert report.moved_task_dirs == ("task-legacy",)
        root = project_data_root(base, "forgeloop")
        assert (root / "records.sqlite").is_file()
        assert (root / "checkpoints.sqlite").is_file()
        assert (root / "task-legacy" / "candidate.diff").read_text(encoding="utf-8") == "diff\n"
        assert not (legacy / "records.sqlite").exists()
        # 定位在新布局下成立。
        assert locate_task(base, "task-legacy").root == root

    def test_mixed_projects_are_refused_without_moving(self, tmp_path: Path) -> None:
        legacy = tmp_path / "legacy"
        legacy.mkdir()
        self._legacy(legacy, "forgeloop")
        # 追加一条属于另一个项目的记录：迁移整体拒绝。
        store = RecordStore(legacy / "records.sqlite")
        try:
            store.create_task("task-other", "other-project", "输入", {}, 60.0)
        finally:
            store.close()
        base = tmp_path / "records"
        added = ProjectStore(project_records_path(base))
        try:
            added.add("forgeloop", "ForgeLoop", str(ensure_project_repo(tmp_path / "repo")))
        finally:
            added.close()

        with pytest.raises(ProjectError, match=r"其他项目|不属于"):
            migrate_legacy(base, "forgeloop", legacy, "forgeloop")

        assert (legacy / "records.sqlite").is_file()
        assert not (project_data_root(base, "forgeloop") / "records.sqlite").exists()

    def test_existing_target_records_are_refused(self, tmp_path: Path) -> None:
        legacy = tmp_path / "legacy"
        legacy.mkdir()
        self._legacy(legacy)
        base = tmp_path / "records"
        root = project_data_root(base, "forgeloop")
        root.mkdir(parents=True, exist_ok=True)
        (root / "records.sqlite").write_bytes(b"existing")
        added = ProjectStore(project_records_path(base))
        try:
            added.add("forgeloop", "ForgeLoop", str(ensure_project_repo(tmp_path / "repo")))
        finally:
            added.close()

        with pytest.raises(ProjectError, match="拒绝覆盖"):
            migrate_legacy(base, "forgeloop", legacy, "forgeloop")
        assert (root / "records.sqlite").read_bytes() == b"existing"
