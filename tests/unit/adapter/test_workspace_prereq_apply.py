"""工作副本原语的真实 git 行为：应用、反向校验、幂等标记与回退。

这些原语是前置候选应用幂等与回退的底座；一旦原语语义漂移，上层的「重复启动
幂等」「失败回退到干净副本」就不成立。用例全部在真实 git 仓库上运行，不替换
``git apply`` / ``git reset``，以真实文件内容与 ``git status`` 断言。

覆盖：
- 应用候选 diff 后副本真的出现对应文件内容，反向校验随之为真；
- 本地已应用标记可读写、可清空，且损坏数据按未应用处理；
- 回退丢弃已跟踪改动与未跟踪文件，回到干净基线；
- 冗余/嵌套候选的普通 apply 失败后，三方合并补齐其余改动。
"""

import json
import subprocess
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    applied_prerequisites,
    apply_diff_to_workspace,
    apply_diff_to_workspace_three_way,
    clear_applied_prerequisites,
    collect_candidate_change,
    diff_is_applied,
    mark_prerequisite_applied,
    prepare_workspace,
    reset_workspace,
)

GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**GIT_ENV, "HOME": str(path.parent)},
    )
    return result.stdout


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def make_workspace(tmp_path: Path, source: Path, name: str = "downstream") -> Path:
    workspace = tmp_path / name / "workspace"
    prepare_workspace(source, "", workspace)
    return workspace


def make_diff(
    tmp_path: Path,
    source: Path,
    task_id: str,
    files: dict[str, str],
    *,
    on: str = "",
) -> str:
    """在独立副本里造一份真实 diff 文本；``on`` 是已应用的前置 diff 文本。"""

    work = tmp_path / f"prereq-{task_id}"
    prepare_workspace(source, "", work)
    if on:
        apply_diff_to_workspace(work, on)
    for name, content in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return collect_candidate_change(work).diff


class TestMarkerRoundTrip:
    def test_mark_read_and_clear(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)

        assert applied_prerequisites(workspace) == frozenset()
        mark_prerequisite_applied(workspace, "alpha", "a" * 64)
        mark_prerequisite_applied(workspace, "beta", "b" * 64)
        # 重复登记同一身份不产生重复项。
        mark_prerequisite_applied(workspace, "alpha", "a" * 64)
        assert applied_prerequisites(workspace) == {
            ("alpha", "a" * 64),
            ("beta", "b" * 64),
        }

        clear_applied_prerequisites(workspace)
        assert applied_prerequisites(workspace) == frozenset()

    def test_corrupted_marker_is_treated_as_not_applied(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        marker = workspace / ".git" / "forgeloop-applied-prerequisites.json"
        marker.write_text("{not-json", encoding="utf-8")

        assert applied_prerequisites(workspace) == frozenset()

    def test_clear_missing_marker_is_a_noop(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)

        clear_applied_prerequisites(workspace)

        assert applied_prerequisites(workspace) == frozenset()


class TestApplyAndReverseCheck:
    def test_apply_writes_content_and_reverse_check_passes(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        diff = make_diff(tmp_path, source, "alpha", {"alpha.txt": "alpha-content\n"})

        assert not diff_is_applied(workspace, diff)
        apply_diff_to_workspace(workspace, diff)

        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"
        assert diff_is_applied(workspace, diff)

    def test_second_apply_of_same_diff_fails(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        diff = make_diff(tmp_path, source, "alpha", {"alpha.txt": "alpha-content\n"})

        apply_diff_to_workspace(workspace, diff)
        with pytest.raises(WorkspaceError):
            apply_diff_to_workspace(workspace, diff)

    def test_three_way_merges_redundant_candidate(self, tmp_path: Path) -> None:
        """祖先已应用后，后建候选的 diff 带上祖先改动：三方合并补齐其余部分。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        ancestor = make_diff(tmp_path, source, "ancestor", {"shared.txt": "ancestor\n"})
        descendant = make_diff(
            tmp_path, source, "descendant", {"descendant.txt": "descendant\n"}, on=ancestor
        )
        assert "shared.txt" in descendant

        apply_diff_to_workspace(workspace, ancestor)
        with pytest.raises(WorkspaceError):
            apply_diff_to_workspace(workspace, descendant)
        apply_diff_to_workspace_three_way(workspace, descendant)

        assert (workspace / "shared.txt").read_text(encoding="utf-8") == "ancestor\n"
        assert (workspace / "descendant.txt").read_text(encoding="utf-8") == "descendant\n"


class TestResetWorkspace:
    def test_reset_discards_tracked_and_untracked_changes(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        baseline = git(workspace, "rev-parse", "HEAD").strip()
        (workspace / "base.txt").write_text("changed\n", encoding="utf-8")
        (workspace / "untracked.txt").write_text("residue\n", encoding="utf-8")

        reset_workspace(workspace, baseline)

        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert not (workspace / "untracked.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""

    def test_applied_diff_is_gone_after_reset(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        diff = make_diff(tmp_path, source, "alpha", {"alpha.txt": "alpha\n"})
        apply_diff_to_workspace(workspace, diff)
        baseline = git(workspace, "rev-parse", "HEAD").strip()

        reset_workspace(workspace, baseline)

        assert not (workspace / "alpha.txt").exists()
        assert not diff_is_applied(workspace, diff)
        assert applied_prerequisites(workspace) == frozenset()


class TestMarkerIsNotPartOfCandidateDiff:
    """本地标记落在 .git 下，不进工作树、不进候选 diff——否则会污染下游候选。"""

    def test_marker_does_not_appear_in_candidate_diff(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        mark_prerequisite_applied(workspace, "alpha", "a" * 64)

        change = collect_candidate_change(workspace)

        assert change.diff.strip() == ""
        assert "forgeloop-applied-prerequisites" not in change.diff
        assert json.loads(
            (workspace / ".git" / "forgeloop-applied-prerequisites.json").read_text(
                encoding="utf-8"
            )
        ) == [["alpha", "a" * 64]]
