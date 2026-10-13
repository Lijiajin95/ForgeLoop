"""bootstrap 恢复工具的核心函数：从副本 git 取完整改动（含未跟踪新文件）。"""

import importlib.util
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "recover_candidate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("recover_candidate", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    work = tmp_path / "repo"
    work.mkdir()
    git(work, "init", "-q", "-b", "main")
    git(work, "config", "user.name", "t")
    git(work, "config", "user.email", "t@example.com")
    (work / "tracked.py").write_text("old\n", encoding="utf-8")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "base")
    return work


class TestCaptureCandidateDiff:
    def test_includes_untracked_new_files_and_modifications(self, repo: Path) -> None:
        module = load_module()
        (repo / "tracked.py").write_text("new\n", encoding="utf-8")
        (repo / "added.py").write_text("print('hi')\n", encoding="utf-8")

        diff = module.capture_candidate_diff(repo)

        assert "added.py" in diff and "tracked.py" in diff
        assert "+print('hi')" in diff
        assert "+new" in diff

    def test_leaves_no_staged_entries_behind(self, repo: Path) -> None:
        module = load_module()
        (repo / "added.py").write_text("print('hi')\n", encoding="utf-8")

        module.capture_candidate_diff(repo)

        status = git(repo, "status", "--porcelain")
        assert "?? added.py" in status  # 仍是未跟踪，没有被暂存
        assert not any(line.startswith("A ") for line in status.splitlines())

    def test_dirty_worktree_is_not_committed(self, repo: Path) -> None:
        module = load_module()
        before = git(repo, "rev-parse", "HEAD").strip()
        (repo / "added.py").write_text("print('hi')\n", encoding="utf-8")

        module.capture_candidate_diff(repo)

        assert git(repo, "rev-parse", "HEAD").strip() == before
