"""候选分支流程的 git 现场操作单元测试（S3 方案 B）。

覆盖：候选分支创建不触碰 main、失败时清理半成品并切回 main、分支已存在拒绝、
工作树脏拒绝、快进只接受 fast-forward、远程分支删除失败如实报告。
"""

import subprocess
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    create_candidate_branch,
    delete_branch,
    fast_forward_main,
    list_branches,
    read_main_head,
    switch_to_main,
)

VALID_DIFF = (
    "diff --git a/feature.txt b/feature.txt\n"
    "--- a/feature.txt\n"
    "+++ b/feature.txt\n"
    "@@ -1 +1 @@\n"
    "-old\n"
    "+new\n"
)


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(path.parent)},
    )
    return result.stdout.strip()


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "feature.txt").write_text("old\n", encoding="utf-8")
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.name", "t")
    git(repo, "config", "user.email", "t@example.com")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "chore: baseline")
    return repo


class TestCandidateBranch:
    def test_creates_branch_commit_without_touching_main(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        baseline = read_main_head(repo)
        candidate = create_candidate_branch(
            repo, "forgeloop/task-1", baseline, VALID_DIFF, "feat: x"
        )
        assert candidate != baseline
        assert "forgeloop/task-1" in list_branches(repo)
        assert git(repo, "rev-parse", "main") == baseline  # main 指针未动
        assert (repo / "feature.txt").read_text(encoding="utf-8") == "new\n"

    def test_fast_forward_then_delete(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        baseline = read_main_head(repo)
        candidate = create_candidate_branch(
            repo, "forgeloop/task-2", baseline, VALID_DIFF, "feat: y"
        )
        assert fast_forward_main(repo, "forgeloop/task-2") == candidate
        assert read_main_head(repo) == candidate
        deleted, detail = delete_branch(repo, "forgeloop/task-2")
        assert deleted is True and detail == ""
        assert list_branches(repo) == ("main",)

    def test_invalid_diff_cleans_up_and_returns_to_main(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        baseline = read_main_head(repo)
        with pytest.raises(WorkspaceError, match="人工解决冲突"):
            create_candidate_branch(repo, "forgeloop/task-3", baseline, "not a diff\n", "feat: z")
        assert list_branches(repo) == ("main",)  # 半成品分支已删除
        assert git(repo, "rev-parse", "--abbrev-ref", "HEAD") == "main"
        assert read_main_head(repo) == baseline

    def test_existing_branch_is_refused(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        baseline = read_main_head(repo)
        create_candidate_branch(repo, "forgeloop/task-4", baseline, VALID_DIFF, "feat: a")
        switch_to_main(repo)
        with pytest.raises(WorkspaceError, match="已存在"):
            create_candidate_branch(repo, "forgeloop/task-4", baseline, VALID_DIFF, "feat: b")

    def test_dirty_worktree_is_refused(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        baseline = read_main_head(repo)
        (repo / "feature.txt").write_text("dirty\n", encoding="utf-8")
        with pytest.raises(WorkspaceError, match="不干净"):
            create_candidate_branch(repo, "forgeloop/task-5", baseline, VALID_DIFF, "feat: c")

    def test_fast_forward_refuses_non_descendant(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        git(repo, "switch", "--create", "other")
        (repo / "other.txt").write_text("x\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "chore: other")
        git(repo, "switch", "main")
        (repo / "feature.txt").write_text("main-moved\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "chore: main moved")
        with pytest.raises(WorkspaceError, match="无法快进"):
            fast_forward_main(repo, "other")

    def test_delete_missing_remote_branch_reports_failure(self, tmp_path: Path) -> None:
        repo = make_repo(tmp_path)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        git(repo, "remote", "add", "origin", str(bare))
        git(repo, "branch", "tmp-branch")
        deleted, detail = delete_branch(repo, "tmp-branch", remote="origin")
        assert deleted is False  # 远程没有该分支：如实报告失败
        assert detail
        assert "tmp-branch" not in list_branches(repo)  # 本地分支仍已删除
