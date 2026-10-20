"""CLI 命令共享的小助手：记录根/项目根解析、任务定位与统一失败输出。

多项目模式下 ``--records-root`` 指向**登记根**，``--project <project_id>``
才是业务数据边界。业务记录根固定为 ``<records-root>/projects/<project_id>``：

- 带 ``--project`` 的命令（submit、requirement submit、mail …）经
  :func:`records_root` 直接得到项目根；
- 只带任务/需求身份的命令（status、approve、merge …）经
  :func:`open_task`/:func:`locate_requirement_root` 在全部已登记项目中唯一定位，
  零命中与跨项目重复都确定性失败；
- 旧根目录记录不再被读取，必须用 ``forgeloop project migrate`` 迁入项目。

拆出原因：命令模块共享同一套定位与失败语义，避免每个入口各写一份扫描逻辑。
"""

import argparse
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from forgeloop.domain.project import Project, ProjectError, project_data_root
from forgeloop.records.projects import (
    ProjectStore,
    RecordLocation,
    RecordLocationError,
    locate_requirement,
    locate_task,
    project_by_name,
    project_records_path,
)
from forgeloop.records.store import RecordStore


def base_records_root(args: argparse.Namespace) -> Path:
    """登记根：``--records-root`` 解析为**绝对路径**，不做项目解析。

    绝对化不是洁癖：任务现场是从相对记录根派生的 ``git worktree`` 路径，PI 与测试命令
    又在各自的 cwd 里执行，相对记录根会让两处解析到不同目录——2026-10-20 实测：常驻
    服务用相对记录根时任务停在 ``implementing``（动作未释放），改成绝对路径即恢复到
    验收门。因此所有命令统一在这里绝对化，避免每个入口各写一次。
    """

    return Path(args.records_root).expanduser().resolve()


def project_for(base: Path, project_id: str) -> Project:
    """按身份取已登记项目；未登记或身份非法时以确定的 ``SystemExit`` 失败。"""

    store = ProjectStore(project_records_path(base))
    try:
        return store.require(project_id)
    except ProjectError as error:
        raise SystemExit(str(error)) from error
    finally:
        store.close()


def project_for_name(base: Path, name: str) -> Project:
    """按身份或迁移前旧名解析项目；两处都没有时以确定的 ``SystemExit`` 失败。"""

    store = ProjectStore(project_records_path(base))
    try:
        project = store.get_by_name(name)
    finally:
        store.close()
    if project is None:
        raise SystemExit(
            f"记录绑定的项目未登记: {name}；请先用 `forgeloop project add` 登记，"
            "或在迁移后用 `forgeloop project update` 核对"
        )
    return project


def project_root_for(base: Path, project_id: str) -> Path:
    """已登记项目的记录根；未登记或身份非法时以确定的 ``SystemExit`` 失败。"""

    project = project_for(base, project_id)
    return project_data_root(base, project.project_id)


def records_root(args: argparse.Namespace) -> Path:
    """解析业务记录根：有 ``--project`` 时返回该项目根，否则返回登记根。"""

    base = base_records_root(args)
    project_id = getattr(args, "project", "") or ""
    if project_id:
        return project_root_for(base, project_id)
    return base


@dataclass(frozen=True)
class TaskLocation:
    """一个任务的身份、归属项目、记录根与已打开的任务存储。"""

    store: RecordStore
    root: Path
    project: Project
    task_id: str

    def close(self) -> None:
        self.store.close()


def locate_task_root(root: Path, task_id: str) -> RecordLocation:
    """在全部已登记项目中唯一定位任务，返回其项目根（不打开记录）。"""

    return _require_location(locate_task, root, task_id, "任务")


def project_repository(base: Path, project_name: str, fallback: str = "") -> str:
    """解析记录所属项目的仓库路径；项目未登记时回退到任务配置快照。

    迁移前的记录可能带着旧项目名或已移除的登记：此时仍以任务创建时的
    ``project_path`` 快照为准，避免把「登记缺失」误当成「不能交付」。
    """

    project = project_by_name(base, project_name)
    if project is not None and project.repo_path:
        return project.repo_path
    return fallback


def open_task(root: Path, task_id: str) -> TaskLocation:
    """在全部已登记项目中唯一定位任务并打开其记录存储。"""

    location = locate_task_root(root, task_id)
    store = RecordStore(location.root / "records.sqlite")
    if store.get_task(task_id) is None:  # 定位后记录被移除：确定性失败，不返回半对象
        store.close()
        raise SystemExit(f"任务不存在: {task_id}")
    return TaskLocation(store, location.root, location.project, task_id)


def locate_requirement_root(root: Path, req_id: str) -> RecordLocation:
    """在全部已登记项目中唯一定位需求，返回其项目根。"""

    return _require_location(locate_requirement, root, req_id, "需求")


def _require_location(
    locator: Callable[[Path, str], RecordLocation],
    root: Path,
    identity: str,
    kind: str,
) -> RecordLocation:
    try:
        return locator(root, identity)
    except RecordLocationError as error:
        raise SystemExit(str(error)) from error


def open_store(root: Path, task_id: str) -> RecordStore:
    """兼容旧调用：只返回任务存储；需要记录根的新代码用 :func:`open_task`。"""

    return open_task(root, task_id).store


def fail(message: str) -> int:
    """统一失败输出：写 stderr 并返回非零退出码。"""

    print(f"FAIL: {message}", file=sys.stderr)
    return 1
