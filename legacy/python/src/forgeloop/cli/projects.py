"""项目命令：登记、查看与旧根目录迁移。

``project add`` 是接入一个代码仓的唯一入口：校验身份与仓库，建立项目记录根与
bare 镜像（``repo.git``），再写入登记表。此后该项目的需求、任务、检查点、会话、
worktree 与提交都在它自己的记录根内，互不混用。

``project migrate`` 用于把 forced migration 之前的根目录记录一次性迁入已登记
项目；旧库内出现多个项目身份时拒绝迁移，不把不同项目的记录混进一个记录根。

本模块只做参数装配、校验编排与输出；git 操作在 ``adapter.git_workspace``，
登记与迁移规则在 ``records.projects``。
"""

import argparse
import json
import sys
from pathlib import Path

from forgeloop.adapter.git_workspace import (
    MIRROR_DIRNAME,
    WorkspaceError,
    ensure_project_mirror,
)
from forgeloop.cli.common import base_records_root, fail
from forgeloop.domain.project import (
    ProjectError,
    project_data_root,
    validate_default_branch,
    validate_project_id,
    validate_project_name,
    validate_repo_path,
)
from forgeloop.records.projects import (
    MigrationReport,
    ProjectLocation,
    ProjectStore,
    iter_projects,
    migrate_legacy,
    project_counts,
    project_records_path,
)


def _open_projects(args: argparse.Namespace) -> ProjectStore:
    return ProjectStore(project_records_path(base_records_root(args)))


def _resolve_source(raw: str) -> Path:
    """校验仓库路径并解析为绝对路径；非 git 仓库明确失败。"""

    value = validate_repo_path(raw)
    source = Path(value).expanduser()
    if not source.is_dir():
        raise ProjectError(f"项目仓库路径不存在或不是目录: {source}")
    if not (source / ".git").exists():
        raise ProjectError(f"项目仓库路径不是 git 仓库: {source}")
    return source.resolve()


def project_document(location: ProjectLocation) -> dict:
    requirements, tasks = project_counts(location)
    project = location.project
    return {
        "project_id": project.project_id,
        "name": project.name,
        "repo_path": project.repo_path,
        "default_branch": project.default_branch,
        "created_at": project.created_at.isoformat(),
        "records_root": str(location.root),
        "requirements": requirements,
        "tasks": tasks,
    }


def cmd_project_add(args: argparse.Namespace) -> int:
    """登记一个项目并建立其 bare 镜像；身份重复或仓库非法时拒绝。"""

    try:
        project_id = validate_project_id(args.project_id)
        name = validate_project_name(args.name)
        default_branch = validate_default_branch(args.default_branch)
        source = _resolve_source(args.path)
    except ProjectError as error:
        return fail(str(error))
    store = _open_projects(args)
    try:
        if store.get(project_id) is not None:
            return fail(f"项目已登记: {project_id}")
        root = project_data_root(base_records_root(args), project_id)
        try:
            ensure_project_mirror(source, root / MIRROR_DIRNAME)
        except WorkspaceError as error:
            return fail(f"建立项目镜像失败: {error}")
        try:
            project = store.add(project_id, name, str(source), default_branch)
        except ProjectError as error:
            return fail(str(error))
    finally:
        store.close()
    print(f"已登记项目: {project.project_id}（{project.name}）")
    print(f"仓库: {project.repo_path}")
    print(f"记录根: {root}")
    print(f"镜像: {root / MIRROR_DIRNAME}")
    return 0


def project_list_document(locations: tuple[ProjectLocation, ...]) -> dict:
    """项目清单的稳定 JSON 结构：项目数组与计数。"""

    documents = [project_document(location) for location in locations]
    return {"projects": documents, "count": len(documents)}


def cmd_project_list(args: argparse.Namespace) -> int:
    """列出全部已登记项目及其需求/任务数量。"""

    locations = iter_projects(base_records_root(args))
    document = project_list_document(locations)
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return 0
    if not document["projects"]:
        print(
            "没有已登记项目；先运行 `forgeloop project add <project_id> --name <显示名> "
            "--path <仓库路径>`。"
        )
        return 0
    for entry in document["projects"]:
        print(
            f"{entry['project_id']}（{entry['name']}）"
            f" 需求 {entry['requirements']} 任务 {entry['tasks']}"
        )
        print(f"  仓库: {entry['repo_path']}")
        print(f"  记录根: {entry['records_root']}")
    return 0


def _require_location(args: argparse.Namespace, project_id: str) -> ProjectLocation | None:
    for location in iter_projects(base_records_root(args)):
        if location.project.project_id == project_id:
            return location
    return None


def cmd_project_show(args: argparse.Namespace) -> int:
    """查看一个项目的登记信息、记录根与数量。"""

    try:
        project_id = validate_project_id(args.project_id)
    except ProjectError as error:
        return fail(str(error))
    location = _require_location(args, project_id)
    if location is None:
        return fail(f"项目未登记: {project_id}")
    document = project_document(location)
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return 0
    print(f"项目: {document['project_id']}（{document['name']}）")
    print(f"仓库: {document['repo_path']}")
    print(f"默认分支: {document['default_branch'] or '（由仓库 HEAD 决定）'}")
    print(f"记录根: {document['records_root']}")
    print(f"需求 {document['requirements']} 条；任务 {document['tasks']} 个")
    return 0


def cmd_project_update(args: argparse.Namespace) -> int:
    """更新项目显示名、仓库路径或默认分支；身份不可改。"""

    try:
        project_id = validate_project_id(args.project_id)
        repo_path = str(_resolve_source(args.path)) if args.path else None
    except ProjectError as error:
        return fail(str(error))
    store = _open_projects(args)
    try:
        try:
            project = store.update(
                project_id,
                name=args.name or None,
                repo_path=repo_path,
                default_branch=args.default_branch if args.default_branch else None,
            )
        except ProjectError as error:
            return fail(str(error))
    finally:
        store.close()
    print(f"已更新项目: {project.project_id}（{project.name}）")
    print(f"仓库: {project.repo_path}")
    return 0


def _print_migration(report: MigrationReport) -> None:
    print(f"已迁移项目: {report.project.project_id}（{report.project.name}）")
    print(f"记录根: {report.target_root}")
    print(f"任务现场: {len(report.moved_task_dirs)} 个")
    print(f"检查点: {'已迁移' if report.moved_checkpoints else '无'}")
    if report.left_behind:
        print("未迁移的目录（不属于旧库任务身份，需人工核对）:", file=sys.stderr)
        for name in report.left_behind:
            print(f"- {name}", file=sys.stderr)


def cmd_project_migrate(args: argparse.Namespace) -> int:
    """把旧根目录记录迁入已登记项目；混合项目或目标冲突时拒绝。"""

    try:
        project_id = validate_project_id(args.project_id)
        report = migrate_legacy(
            base_records_root(args),
            project_id,
            Path(args.from_root).expanduser(),
            args.legacy_project,
        )
    except (ProjectError, OSError) as error:
        return fail(str(error))
    _print_migration(report)
    return 0


def add_project_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    """注册 ``project`` 子命令组；解析器装配留在命令模块内。"""

    project = subparsers.add_parser("project", help="项目登记与隔离：接入多个代码仓")
    actions = project.add_subparsers(dest="project_command", required=True)

    add = actions.add_parser("add", help="登记一个项目并建立独立记录根与仓库镜像")
    add.add_argument("project_id", help="项目身份（小写字母开头，2-63 位字母/数字/连字符）")
    add.add_argument("--name", required=True, help="项目显示名")
    add.add_argument("--path", required=True, help="项目 git 仓库路径")
    add.add_argument("--default-branch", default="", help="默认分支（缺省由仓库 HEAD 决定）")
    add.add_argument("--records-root", default=default_records_root)
    add.set_defaults(func=cmd_project_add)

    listing = actions.add_parser("list", help="列出全部已登记项目")
    listing.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    listing.add_argument("--records-root", default=default_records_root)
    listing.set_defaults(func=cmd_project_list)

    show = actions.add_parser("show", help="查看一个项目的登记信息与数量")
    show.add_argument("project_id", help="项目身份")
    show.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    show.add_argument("--records-root", default=default_records_root)
    show.set_defaults(func=cmd_project_show)

    update = actions.add_parser("update", help="更新项目显示名、仓库路径或默认分支")
    update.add_argument("project_id", help="项目身份")
    update.add_argument("--name", default="", help="新的显示名")
    update.add_argument("--path", default="", help="新的 git 仓库路径")
    update.add_argument("--default-branch", default="", help="新的默认分支")
    update.add_argument("--records-root", default=default_records_root)
    update.set_defaults(func=cmd_project_update)

    migrate = actions.add_parser("migrate", help="把旧根目录记录迁入已登记项目（一次性）")
    migrate.add_argument("project_id", help="接收记录的项目身份")
    migrate.add_argument("--from", dest="from_root", required=True, help="旧记录根目录")
    migrate.add_argument(
        "--legacy-project",
        required=True,
        help="旧记录中的项目名（全部任务与需求必须都属于它）",
    )
    migrate.add_argument("--records-root", default=default_records_root)
    migrate.set_defaults(func=cmd_project_migrate)
