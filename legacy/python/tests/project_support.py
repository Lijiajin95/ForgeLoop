"""分层测试共享的项目现场助手：登记项目并返回其记录根。

多项目模式（forced migration）下 CLI 只从 ``<records-root>/projects/<id>/`` 读取
业务记录；直接往 ``<records-root>/records.sqlite`` 写样本的旧用例必须改为先登记
项目、再写项目记录根。本模块集中这一动作，避免每个用例各写一份注册逻辑。
"""

import subprocess
from pathlib import Path

from forgeloop.domain.project import project_data_root
from forgeloop.records.projects import ProjectStore, project_records_path
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

DEFAULT_PROJECT_ID = "forgeloop"
DEFAULT_PROJECT_NAME = "ForgeLoop"


def ensure_project_repo(path: Path) -> Path:
    """确保路径是一个可用的真实 git 仓库（已存在则原样返回）。"""

    if (path / ".git").exists():
        return path
    path.mkdir(parents=True, exist_ok=True)
    (path / "README.md").write_text("baseline\n", encoding="utf-8")
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        "HOME": str(path.parent),
    }

    def run(*args: str) -> None:
        subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, env=env)

    run("init", "-b", "main")
    run("config", "user.name", "forgeloop-tests")
    run("config", "user.email", "tests@example.com")
    run("add", "-A")
    run("commit", "-m", "chore: baseline")
    return path


def register_project(
    base: Path,
    project_id: str = DEFAULT_PROJECT_ID,
    *,
    name: str = DEFAULT_PROJECT_NAME,
    repo_path: str = "",
    legacy_project: str = "",
) -> Path:
    """登记一个项目并返回其记录根；重复登记同一身份是幂等的。

    项目仓库默认在记录根旁建立真实 git 仓库：dev 节点会从它建立 worktree，
    只有路径没有仓库会让执行阶段以「不是 git 仓库」失败。
    """

    repo = ensure_project_repo(Path(repo_path) if repo_path else base / "repo")
    store = ProjectStore(project_records_path(base))
    try:
        if store.get(project_id) is None:
            store.add(
                project_id,
                name,
                str(repo),
                legacy_project=legacy_project,
            )
    finally:
        store.close()
    root = project_data_root(base, project_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_records(base: Path, project_id: str = DEFAULT_PROJECT_ID) -> Path:
    """项目记录根（不登记，只算路径）。"""

    return project_data_root(base, project_id)


def record_store(
    base: Path, project_id: str = DEFAULT_PROJECT_ID, *, legacy_project: str = ""
) -> RecordStore:
    """打开项目任务记录（自动登记项目）。"""

    return RecordStore(
        register_project(base, project_id, legacy_project=legacy_project) / "records.sqlite"
    )


def requirement_store(
    base: Path, project_id: str = DEFAULT_PROJECT_ID, *, legacy_project: str = ""
) -> RequirementStore:
    """打开项目需求记录（自动登记项目）。"""

    return RequirementStore(
        register_project(base, project_id, legacy_project=legacy_project) / "records.sqlite"
    )
