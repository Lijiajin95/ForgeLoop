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
    create_annotated_tag,
    has_remote,
    is_git_workspace,
    list_tags,
    merge_candidate_to_main,
    prepare_workspace,
    push_main,
    push_tag,
    read_main_head,
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
    def test_worktree_is_created_from_project_mirror_and_records_baseline(
        self, tmp_path: Path
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        mirror = tmp_path / "project" / "repo.git"
        baseline = prepare_workspace(source, "", workspace, mirror=mirror)
        assert is_git_workspace(workspace)
        assert len(baseline) == 40  # 实际基线提交号
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "old\n"
        # worktree 的 .git 是指向项目镜像的 gitfile，而不是源仓库的 .git。
        assert (workspace / ".git").is_file()
        common = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "--git-common-dir"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert Path(common).resolve() == mirror.resolve()
        assert str(source) not in (workspace / ".git").read_text(encoding="utf-8")
        # 源仓库没有被登记成 worktree，main 现场保持不变。
        source_worktrees = subprocess.run(
            ["git", "-C", str(source), "worktree", "list", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert str(workspace) not in source_worktrees

    def test_mirror_does_not_keep_source_as_origin(self, tmp_path: Path) -> None:
        """镜像删除 origin：副本内 ``git push`` 不能回写源 main。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        mirror = tmp_path / "project" / "repo.git"
        prepare_workspace(source, "", workspace, mirror=mirror)
        remotes = subprocess.run(
            ["git", "-C", str(mirror), "remote"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert remotes.strip() == ""
        # 源仓库路径不再出现在镜像配置里。
        config = (mirror / "config").read_text(encoding="utf-8")
        assert str(source) not in config

    def test_reused_workspace_drops_a_pre_existing_source_remote(self, tmp_path: Path) -> None:
        """旧副本（带 origin）在修复轮复用时也会被切断回写源 main 的路径。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        git(workspace, "remote", "add", "origin", str(source))
        prepare_workspace(source, "", workspace)
        remotes = subprocess.run(
            ["git", "-C", str(workspace), "remote"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert remotes.strip() == ""

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

    def test_prepare_reports_recorded_baseline_after_pi_commit(self, tmp_path: Path) -> None:
        """PI 在副本内 commit 后，prepare 仍返回原始批准基线（不是新 HEAD）。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("committed\n", encoding="utf-8")
        git(workspace, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A")
        git(
            workspace,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "feat: pi committed inside the copy",
        )
        head = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert head != baseline
        assert prepare_workspace(source, "", workspace) == baseline

    def test_legacy_workspace_baseline_is_backfilled_from_explicit_baseline(
        self, tmp_path: Path
    ) -> None:
        """旧副本没有基线引用：复用轮用显式批准基线回填，不把新 HEAD 当基线。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        # 模拟 B01 之前建立的旧副本：基线引用不存在。
        git(workspace, "update-ref", "-d", "refs/forgeloop/baseline")
        (workspace / "feature.txt").write_text("committed\n", encoding="utf-8")
        git(workspace, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A")
        git(
            workspace,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "feat: pi committed inside a legacy copy",
        )
        head = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert head != baseline
        assert prepare_workspace(source, baseline, workspace) == baseline
        # 回填后的基线已写入副本，后续采集对原批准基线计算。
        assert collect_candidate_change(workspace).baseline_commit == baseline

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
        with pytest.raises(WorkspaceError, match="基线不存在"):
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

    def test_committed_change_is_still_collected_against_baseline(self, tmp_path: Path) -> None:
        """副本内 commit/HEAD 前移不会丢失改动：diff 仍对批准基线计算。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("committed\n", encoding="utf-8")
        git(workspace, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A")
        git(
            workspace,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "feat: pi committed inside the copy",
        )
        change = collect_candidate_change(workspace)
        assert change.baseline_commit == baseline
        assert "+committed" in change.diff
        assert "feature.txt" in change.diff

    def test_explicit_baseline_overrides_recorded_one(self, tmp_path: Path) -> None:
        """调用方显式给出的基线优先，便于把 diff 固定到交付基线。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("new\n", encoding="utf-8")
        change = collect_candidate_change(workspace, baseline)
        assert change.baseline_commit == baseline
        assert "+new" in change.diff

    def test_non_git_workspace_is_rejected(self, tmp_path: Path) -> None:
        plain = tmp_path / "plain"
        plain.mkdir()
        with pytest.raises(WorkspaceError, match="不是 git 仓库"):
            collect_candidate_change(plain)

    def test_is_git_workspace_detection(self, tmp_path: Path) -> None:
        assert not is_git_workspace(tmp_path)
        source = make_source_repo(tmp_path)
        assert is_git_workspace(source)


class TestMergeToMain:
    def _repo_with_baseline(self, tmp_path: Path) -> tuple[Path, str]:
        source = make_source_repo(tmp_path)
        head = read_main_head(source)
        return source, head

    def test_applies_diff_and_commits_on_main(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("new\n", encoding="utf-8")
        change = collect_candidate_change(workspace)
        merge_commit = merge_candidate_to_main(
            source, baseline, change.diff, "feat: applied candidate"
        )
        assert merge_commit != baseline
        assert (source / "feature.txt").read_text(encoding="utf-8") == "new\n"
        assert read_main_head(source) == merge_commit

    def test_non_main_branch_is_rejected(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        git(source, "checkout", "-b", "feature-branch")
        with pytest.raises(WorkspaceError, match="不是 main"):
            merge_candidate_to_main(source, baseline, "+diff\n", "feat: x")

    def test_dirty_tree_is_rejected(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        (source / "feature.txt").write_text("dirty\n", encoding="utf-8")
        with pytest.raises(WorkspaceError, match="不干净"):
            merge_candidate_to_main(source, baseline, "+diff\n", "feat: x")

    def test_drifted_main_is_rejected(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        (source / "feature.txt").write_text("moved\n", encoding="utf-8")
        git(source, "add", "-A")
        git(source, "commit", "-m", "chore: main moved on")
        with pytest.raises(WorkspaceError, match="漂移"):
            merge_candidate_to_main(source, baseline, "+diff\n", "feat: x")

    def test_invalid_diff_is_rejected_without_touching_main(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        with pytest.raises(WorkspaceError, match="git apply"):
            merge_candidate_to_main(source, baseline, "not a diff\n", "feat: x")
        assert read_main_head(source) == baseline  # main 未被改动

    def test_push_to_local_bare_remote(self, tmp_path: Path) -> None:
        source, baseline = self._repo_with_baseline(tmp_path)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        git(source, "remote", "add", "origin", str(bare))
        assert has_remote(source)
        valid_diff = (
            "diff --git a/feature.txt b/feature.txt\n"
            "--- a/feature.txt\n+++ b/feature.txt\n"
            "@@ -1 +1 @@\n-old\n+new\n"
        )
        merge_commit = merge_candidate_to_main(source, baseline, valid_diff, "feat: x")
        pushed, detail = push_main(source)
        assert pushed, detail
        remote_head = subprocess.run(
            ["git", "--git-dir", str(bare), "rev-parse", "main"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert remote_head == merge_commit

    def test_push_without_remote_reports_failure(self, tmp_path: Path) -> None:
        source, _baseline = self._repo_with_baseline(tmp_path)
        assert not has_remote(source)
        pushed, _detail = push_main(source)
        assert not pushed


class TestReleaseTags:
    """S1：发布标签的创建、列举与推送。"""

    def _source_with_remote(self, tmp_path: Path) -> tuple[Path, Path]:
        source = make_source_repo(tmp_path)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        git(source, "remote", "add", "origin", str(bare))
        return source, bare

    def test_create_annotated_tag_and_push(self, tmp_path: Path) -> None:
        source, bare = self._source_with_remote(tmp_path)
        commit = read_main_head(source)
        assert list_tags(source) == ()
        create_annotated_tag(source, "v0.1.0", commit, "chore(release): v0.1.0")
        assert list_tags(source) == ("v0.1.0",)
        # annotated tag：真实 tag 对象，便于回查发布者与注释。
        tag_type = subprocess.run(
            ["git", "-C", str(source), "cat-file", "-t", "v0.1.0"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert tag_type == "tag"
        pushed, detail = push_tag(source, "v0.1.0")
        assert pushed, detail
        remote_tags = subprocess.run(
            ["git", "--git-dir", str(bare), "tag", "-l"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        assert remote_tags == ["v0.1.0"]

    def test_push_missing_tag_reports_failure(self, tmp_path: Path) -> None:
        source, _bare = self._source_with_remote(tmp_path)
        pushed, detail = push_tag(source, "v9.9.9")
        assert not pushed
        assert detail
