"""项目镜像与 worktree 的真实 git 集成：隔离、基线与源仓库不可写。

覆盖多项目工作副本的关键不变量：worktree 从项目 bare 镜像派生而不是源仓库；
同一镜像下的多个任务各自记录批准基线、互不覆盖；源仓库不出现 worktree 登记、
main 引用不被工作副本改动；删除 worktree 只清理镜像登记。
"""

import subprocess
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    collect_candidate_change,
    ensure_project_mirror,
    is_git_workspace,
    prepare_workspace,
    recorded_baseline,
    remove_workspace,
)

pytestmark = pytest.mark.integration

GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-19T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-19T10:00:00+08:00",
}


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**GIT_ENV, "HOME": str(path.parent)},
    )
    return result.stdout.strip()


def make_source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    (source / "base.txt").write_text("base\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def test_two_tasks_share_mirror_but_keep_independent_baselines(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    first_commit = git(source, "rev-parse", "HEAD")
    (source / "second.txt").write_text("v2\n", encoding="utf-8")
    git(source, "add", "-A")
    git(source, "commit", "-m", "feat: second")
    second_commit = git(source, "rev-parse", "HEAD")
    source_refs_before = git(source, "for-each-ref", "--format=%(refname)")

    project_root = tmp_path / "projects" / "demo"
    mirror = project_root / "repo.git"
    ensure_project_mirror(source, mirror)

    # 任务 A 停在旧提交；任务 B 用新提交。两者共享同一镜像但基线各自记录。
    workspace_a = project_root / "task-a" / "workspace"
    workspace_b = project_root / "task-b" / "workspace"
    baseline_a = prepare_workspace(source, first_commit, workspace_a, mirror=mirror)
    baseline_b = prepare_workspace(source, second_commit, workspace_b, mirror=mirror)

    assert baseline_a == first_commit
    assert baseline_b == second_commit
    assert recorded_baseline(workspace_a) == first_commit
    assert recorded_baseline(workspace_b) == second_commit
    assert not (workspace_a / "second.txt").exists()
    assert (workspace_b / "second.txt").read_text(encoding="utf-8") == "v2\n"

    # 一个任务里的改动与提交不进入另一个任务的候选 diff。
    (workspace_a / "only-a.txt").write_text("a\n", encoding="utf-8")
    git(workspace_a, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A")
    git(
        workspace_a,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-m",
        "feat: only a",
    )
    change_b = collect_candidate_change(workspace_b)
    assert change_b.diff == ""
    change_a = collect_candidate_change(workspace_a)
    assert "+a" in change_a.diff
    assert "only-a.txt" in change_a.diff

    # 源仓库没有 worktree 登记、引用未变化，工作副本也不指向源仓库。
    assert workspace_a.joinpath(".git").is_file()
    assert git(source, "worktree", "list", "--porcelain").find(str(workspace_a)) == -1
    assert git(source, "for-each-ref", "--format=%(refname)") == source_refs_before
    assert str(source) not in (workspace_a / ".git").read_text(encoding="utf-8")
    assert git(mirror, "remote") == ""


def test_remove_workspace_cleans_mirror_registration(tmp_path: Path) -> None:
    source = make_source(tmp_path)
    project_root = tmp_path / "projects" / "demo"
    mirror = project_root / "repo.git"
    workspace = project_root / "task" / "workspace"
    prepare_workspace(source, "", workspace, mirror=mirror)
    assert is_git_workspace(workspace)

    remove_workspace(workspace, mirror=mirror)

    assert not workspace.exists()
    assert "task/workspace" not in git(mirror, "worktree", "list", "--porcelain")


def test_missing_source_is_rejected_before_creating_mirror(tmp_path: Path) -> None:
    with pytest.raises(WorkspaceError, match="不是 git 仓库"):
        ensure_project_mirror(tmp_path / "missing", tmp_path / "mirror.git")
