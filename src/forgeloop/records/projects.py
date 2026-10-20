"""项目登记与项目记录根解析。

项目是多种记录（需求、任务、检查点、会话、worktree 与 git 镜像）的隔离边界：

- 登记表 ``<records_root>/projects.sqlite`` 只保存项目身份、显示名、仓库路径与
  默认分支；记录根固定为 ``<records_root>/projects/<project_id>/``，不单独存路径，
  因此记录根整体迁移后不会留下失效指针。
- 每个项目的业务记录、检查点与任务现场都在自己的记录根内；跨项目命令必须先
  经本模块定位项目，不能直接打开根目录的 ``records.sqlite``。
- 定位任务/需求时同时检查全部已登记项目：身份全局唯一则由唯一项目命中，
  零命中与多命中都确定性失败，不猜测、不跨项目合并。
- 旧根目录记录（forced migration）只能经 :func:`migrate_legacy` 整体迁入某个
  项目；迁移前核对全部任务与需求都属于同一旧项目，拒绝把多个项目混进一个记录根。
"""

from __future__ import annotations

import shutil
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.project import (
    Project,
    ProjectError,
    ProjectNotFoundError,
    project_data_root,
    validate_default_branch,
    validate_project_id,
    validate_project_name,
    validate_repo_path,
)
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.requirement import RequirementNotFoundError
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT '',
    legacy_project TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
"""


class RecordLocationError(RuntimeError):
    """按身份定位任务/需求失败：未找到或跨项目歧义。"""


@dataclass(frozen=True)
class ProjectLocation:
    """一个项目的登记信息与其记录根。"""

    project: Project
    root: Path


@dataclass(frozen=True)
class RecordLocation:
    """一个任务/需求的归属项目与记录根。"""

    project: Project
    root: Path
    identity: str


@dataclass(frozen=True)
class MigrationReport:
    """一次旧根目录迁移的实际结果；未移动的目录如实列出。"""

    project: Project
    target_root: Path
    moved_records: bool
    moved_checkpoints: bool
    moved_task_dirs: tuple[str, ...]
    left_behind: tuple[str, ...]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _project_from_row(row: Sequence[object]) -> Project:
    return Project(
        project_id=str(row[0]),
        name=str(row[1]),
        repo_path=str(row[2]),
        default_branch=str(row[3]),
        created_at=_parse(str(row[5])),
        legacy_project=str(row[4]),
    )


def project_records_path(root: Path) -> Path:
    """项目登记库路径。"""

    return root / "projects.sqlite"


class ProjectStore:
    """项目登记表的 SQLite 实现；每个实例管理自己的连接。"""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def add(
        self,
        project_id: str,
        name: str,
        repo_path: str,
        default_branch: str = "",
        *,
        created_at: datetime | None = None,
        legacy_project: str = "",
    ) -> Project:
        """登记一个项目；身份已存在时明确失败，不覆盖既有登记。"""

        project = Project(
            project_id=validate_project_id(project_id),
            name=validate_project_name(name),
            repo_path=validate_repo_path(repo_path),
            default_branch=validate_default_branch(default_branch),
            created_at=_now() if created_at is None else created_at,
            legacy_project=legacy_project.strip(),
        )
        try:
            self._db.execute(
                "INSERT INTO projects"
                " (project_id, name, repo_path, default_branch, legacy_project, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    project.project_id,
                    project.name,
                    project.repo_path,
                    project.default_branch,
                    project.legacy_project,
                    _iso(project.created_at),
                ),
            )
        except sqlite3.IntegrityError as error:
            raise ProjectError(f"项目已登记: {project.project_id}") from error
        return project

    def get(self, project_id: str) -> Project | None:
        row = self._db.execute(
            "SELECT project_id, name, repo_path, default_branch, legacy_project, created_at"
            " FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        return None if row is None else _project_from_row(row)

    def get_by_name(self, name: str) -> Project | None:
        """按身份或旧项目名解析项目；两处都未登记时返回 ``None``。

        记录里的 ``project`` 字段可能是迁移前的旧名，因此命令按记录值解析项目时
        要同时匹配 ``project_id`` 与 ``legacy_project``。
        """

        project = self.get(name)
        if project is not None:
            return project
        row = self._db.execute(
            "SELECT project_id, name, repo_path, default_branch, legacy_project, created_at"
            " FROM projects WHERE legacy_project = ? AND legacy_project <> ''",
            (name,),
        ).fetchone()
        return None if row is None else _project_from_row(row)

    def set_legacy_project(self, project_id: str, legacy_project: str) -> Project:
        """记录一次性迁移使用的旧项目名；身份不存在时明确失败。"""

        current = self.require(project_id)
        value = legacy_project.strip()
        self._db.execute(
            "UPDATE projects SET legacy_project = ? WHERE project_id = ?",
            (value, current.project_id),
        )
        return Project(
            project_id=current.project_id,
            name=current.name,
            repo_path=current.repo_path,
            default_branch=current.default_branch,
            created_at=current.created_at,
            legacy_project=value,
        )

    def require(self, project_id: str) -> Project:
        """按身份取项目；未登记时抛 :class:`ProjectNotFoundError`。"""

        project = self.get(project_id)
        if project is None:
            raise ProjectNotFoundError(
                f"项目未登记: {project_id}（先运行 `forgeloop project add {project_id} "
                "--name <显示名> --path <仓库路径>`）"
            )
        return project

    def list(self) -> tuple[Project, ...]:
        rows = self._db.execute(
            "SELECT project_id, name, repo_path, default_branch, legacy_project, created_at"
            " FROM projects ORDER BY created_at, project_id"
        ).fetchall()
        return tuple(_project_from_row(row) for row in rows)

    def update(
        self,
        project_id: str,
        *,
        name: str | None = None,
        repo_path: str | None = None,
        default_branch: str | None = None,
    ) -> Project:
        """更新显示信息；身份不可改，未登记项目明确失败。"""

        current = self.require(project_id)
        updated = Project(
            project_id=current.project_id,
            name=current.name if name is None else validate_project_name(name),
            repo_path=(current.repo_path if repo_path is None else validate_repo_path(repo_path)),
            default_branch=(
                current.default_branch
                if default_branch is None
                else validate_default_branch(default_branch)
            ),
            created_at=current.created_at,
            legacy_project=current.legacy_project,
        )
        self._db.execute(
            "UPDATE projects SET name = ?, repo_path = ?, default_branch = ? WHERE project_id = ?",
            (
                updated.name,
                updated.repo_path,
                updated.default_branch,
                updated.project_id,
            ),
        )
        return updated

    def remove(self, project_id: str) -> None:
        """删除登记；不删除记录根，避免误删现场（现场由人工清理）。"""

        changed = self._db.execute(
            "DELETE FROM projects WHERE project_id = ?", (project_id,)
        ).rowcount
        if changed == 0:
            raise ProjectNotFoundError(f"项目未登记: {project_id}")


def project_location(project: Project, records_root: Path) -> ProjectLocation:
    """项目 → 记录根（不检查目录是否存在）。"""

    return ProjectLocation(project, project_data_root(records_root, project.project_id))


def iter_projects(records_root: Path) -> tuple[ProjectLocation, ...]:
    """只读列出全部已登记项目及其记录根；登记库缺失时返回空元组。"""

    path = project_records_path(records_root)
    if not path.is_file():
        return ()
    store = ProjectStore(path)
    try:
        return tuple(project_location(project, records_root) for project in store.list())
    finally:
        store.close()


def project_by_name(records_root: Path, name: str) -> Project | None:
    """按项目身份或迁移前旧名解析项目；未登记时返回 ``None``。

    记录里的 ``project`` 字段可能是迁移前的旧名；调用方拿不到项目时自行决定
    回退（例如任务配置快照里的 ``project_path``），而不是在此抛错。
    """

    if not name:
        return None
    path = project_records_path(records_root)
    if not path.is_file():
        return None
    store = ProjectStore(path)
    try:
        return store.get_by_name(name)
    finally:
        store.close()


def locate_task(records_root: Path, task_id: str) -> RecordLocation:
    """按任务身份定位项目记录根；未找到或跨项目重复都明确失败。"""

    matches: list[RecordLocation] = []
    for location in iter_projects(records_root):
        db = location.root / "records.sqlite"
        if not db.is_file():
            continue
        store = RecordStore(db)
        try:
            record = store.get_task(task_id)
        finally:
            store.close()
        if record is not None:
            matches.append(RecordLocation(location.project, location.root, task_id))
    return _unique_match("任务", task_id, matches)


def locate_requirement(records_root: Path, req_id: str) -> RecordLocation:
    """按需求身份定位项目记录根；未找到或跨项目重复都明确失败。"""

    matches: list[RecordLocation] = []
    for location in iter_projects(records_root):
        db = location.root / "records.sqlite"
        if not db.is_file():
            continue
        store = RequirementStore(db)
        try:
            try:
                store.get(req_id)
            except RequirementNotFoundError:
                continue
            matches.append(RecordLocation(location.project, location.root, req_id))
        finally:
            store.close()
    return _unique_match("需求", req_id, matches)


def _unique_match(kind: str, identity: str, matches: list[RecordLocation]) -> RecordLocation:
    if not matches:
        raise RecordLocationError(f"{kind}不存在: {identity}")
    if len(matches) > 1:
        projects = "、".join(sorted(match.project.project_id for match in matches))
        raise RecordLocationError(f"{kind}身份跨项目重复: {identity}（项目: {projects}）")
    return matches[0]


def releases_by_tag(
    records_root: Path, tag: str
) -> tuple[tuple[ProjectLocation, ReleaseRecord], ...]:
    """跨项目只读查找标签的发布回执；同名标签在多个项目出现时由调用方拒绝。"""

    found: list[tuple[ProjectLocation, ReleaseRecord]] = []
    for location in iter_projects(records_root):
        db = location.root / "records.sqlite"
        if not db.is_file():
            continue
        store = RecordStore(db)
        try:
            release = store.outcomes.release_by_tag(tag)
        finally:
            store.close()
        if release is not None:
            found.append((location, release))
    return tuple(found)


def project_counts(location: ProjectLocation) -> tuple[int, int]:
    """项目的需求/任务数量（只读）；记录库不存在时为 0。"""

    db = location.root / "records.sqlite"
    if not db.is_file():
        return 0, 0
    requirement_store = RequirementStore(db)
    record_store = RecordStore(db)
    try:
        return len(requirement_store.all_requirements()), len(record_store.all_tasks())
    finally:
        record_store.close()
        requirement_store.close()


def migrate_legacy(
    records_root: Path,
    project_id: str,
    legacy_root: Path,
    legacy_project: str,
) -> MigrationReport:
    """把旧根目录记录整体迁入已登记项目；混合项目或目标冲突时拒绝。

    迁移前在只读事务语义下核对旧库中的全部任务与需求都属于 ``legacy_project``。
    任何一条属于其他项目即拒绝，避免把多项目数据混入同一记录根。迁移只移动
    ``records.sqlite``、``checkpoints.sqlite`` 与旧库任务身份对应的任务目录；
    无法归属的目录留在原处并在报告里列出，不静默删除。
    """

    location = _require_project_location(records_root, project_id)
    legacy = legacy_root
    legacy_records = legacy / "records.sqlite"
    if not legacy_records.is_file():
        raise ProjectError(f"旧记录根缺少 records.sqlite: {legacy}")
    target_records = location.root / "records.sqlite"
    if target_records.exists():
        raise ProjectError(f"项目记录根已有 records.sqlite，拒绝覆盖: {target_records}")

    requirement_store = RequirementStore(legacy_records)
    record_store = RecordStore(legacy_records)
    try:
        requirements = requirement_store.all_requirements()
        tasks = record_store.all_tasks()
        foreign = sorted(
            {item.project for item in (*requirements, *tasks) if item.project != legacy_project}
        )
        if foreign:
            raise ProjectError(
                "旧记录根包含不属于 "
                f"{legacy_project!r} 的项目: {'、'.join(foreign)}；"
                "拒绝把多项目数据迁入同一项目"
            )
        task_ids = tuple(task.id for task in tasks)
    finally:
        record_store.close()
        requirement_store.close()

    if location.root.exists():
        conflict = [
            name for name in (*task_ids, "checkpoints.sqlite") if (location.root / name).exists()
        ]
        if conflict:
            raise ProjectError(f"项目记录根已存在同名现场，拒绝覆盖: {'、'.join(conflict)}")

    location.root.mkdir(parents=True, exist_ok=True)
    moved_dirs: list[str] = []
    for task_id in task_ids:
        source_dir = legacy / task_id
        if not source_dir.is_dir():
            continue
        shutil.move(str(source_dir), str(location.root / task_id))
        moved_dirs.append(task_id)

    moved_checkpoints = False
    source_checkpoints = legacy / "checkpoints.sqlite"
    if source_checkpoints.is_file():
        shutil.move(str(source_checkpoints), str(location.root / "checkpoints.sqlite"))
        moved_checkpoints = True

    shutil.move(str(legacy_records), str(target_records))

    known = set(task_ids)
    leftovers = tuple(
        sorted(
            child.name
            for child in legacy.iterdir()
            if child.is_dir() and child.name not in known and not child.name.startswith(".")
        )
    )
    store = ProjectStore(project_records_path(records_root))
    try:
        project = store.set_legacy_project(project_id, legacy_project)
    finally:
        store.close()
    return MigrationReport(
        project=project,
        target_root=location.root,
        moved_records=True,
        moved_checkpoints=moved_checkpoints,
        moved_task_dirs=tuple(moved_dirs),
        left_behind=leftovers,
    )


def _require_project_location(records_root: Path, project_id: str) -> ProjectLocation:
    store = ProjectStore(project_records_path(records_root))
    try:
        project = store.require(validate_project_id(project_id))
    finally:
        store.close()
    return project_location(project, records_root)
