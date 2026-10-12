"""git 工作副本的单元测试：独立 clone、基线检出与候选 diff。

对应架构 §5：副本不得与源仓库共享可写引用；候选 diff 来自工作树对基线的
真实差异（覆盖新增/修改/删除/已提交），不依赖 PI 文本自述。
"""

import subprocess
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import (
    CandidateChange,
    WorkspaceError,
    collect_candidate_change,
    is_git_workspace,
    prepare_workspace,
)


def git(path: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(path.parent),
            "GIT_AUTHOR_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T20:00:00+08:00",
        },
    )


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "feature.txt").write_text("old\n", encoding="utf-8")
    (source / "removed.txt").write_text("baseline-file\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


class TestPrepareWorkspace:
    def test_clones_independently_and_records_baseline(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        assert is_git_workspace(workspace)
        assert len(baseline) == 40  # 实际基线提交号
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "old\n"
        # 独立副本：有自己的 .git，不共享源仓库引用。
        assert (workspace / ".git").is_dir()

    def test_explicit_baseline_is_checked_out_detached(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        (source / "second.txt").write_text("v2\n", encoding="utf-8")
        git(source, "add", "-A")
        git(source, "commit", "-m", "feat: second")
        tag = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "HEAD~1"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, tag, workspace)
        assert baseline == tag
        assert not (workspace / "second.txt").exists()  # 检出的是基线状态

    def test_prepare_is_idempotent_for_fix_rounds(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        first = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("wip\n", encoding="utf-8")
        second = prepare_workspace(source, "", workspace)
        assert first == second  # 修复轮复用同一副本，不重新 clone
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "wip\n"

    def test_missing_source_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(WorkspaceError, match="不是 git 仓库"):
            prepare_workspace(tmp_path / "missing", "", tmp_path / "w")

    def test_clone_failure_is_wrapped_as_workspace_error(self, tmp_path: Path) -> None:
        fake_repo = tmp_path / "fake-repo"
        fake_repo.mkdir()
        (fake_repo / ".git").write_text("broken gitfile pointer", encoding="utf-8")
        with pytest.raises(WorkspaceError, match="clone failed"):
            prepare_workspace(fake_repo, "", tmp_path / "w")

    def test_non_git_source_is_rejected(self, tmp_path: Path) -> None:
        plain = tmp_path / "plain"
        plain.mkdir()
        with pytest.raises(WorkspaceError, match="不是 git 仓库"):
            prepare_workspace(plain, "", tmp_path / "w")

    def test_invalid_baseline_is_rejected(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        with pytest.raises(WorkspaceError, match="git checkout"):
            prepare_workspace(source, "no-such-revision", tmp_path / "w")


class TestCollectCandidateChange:
    def test_diff_covers_modified_new_and_deleted(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("new\n", encoding="utf-8")
        (workspace / "added.txt").write_text("added\n", encoding="utf-8")
        (workspace / "removed.txt").unlink()  # 基线文件被删除
        change = collect_candidate_change(workspace)
        assert isinstance(change, CandidateChange)
        assert change.baseline_commit == baseline
        assert "+new" in change.diff
        assert "+added" in change.diff  # 新增文件纳入候选
        assert "-baseline-file" in change.diff  # 基线文件删除也纳入
        assert "feature.txt" in change.diff

    def test_empty_workspace_has_empty_diff(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        change = collect_candidate_change(workspace)
        assert change.diff == ""

    def test_non_git_workspace_is_rejected(self, tmp_path: Path) -> None:
        plain = tmp_path / "plain"
        plain.mkdir()
        with pytest.raises(WorkspaceError, match="不是 git 仓库"):
            collect_candidate_change(plain)

    def test_is_git_workspace_detection(self, tmp_path: Path) -> None:
        assert not is_git_workspace(tmp_path)
        source = make_source_repo(tmp_path)
        assert is_git_workspace(source)
