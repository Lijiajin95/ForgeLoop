"""失败证据与部分候选落盘：边界分支（非 git、git 现场不可用、无改动）。"""

import subprocess
from pathlib import Path

from forgeloop.graph.evidence import capture_partial_candidate


class TestCapturePartialCandidate:
    def test_non_git_workspace_is_ignored(self, tmp_path: Path) -> None:
        plain = tmp_path / "plain"
        plain.mkdir()
        (plain / "feature.txt").write_text("new", encoding="utf-8")

        assert capture_partial_candidate(tmp_path, plain, "halt") is False
        assert not (tmp_path / "partial-candidate.diff").exists()

    def test_broken_git_workspace_is_ignored(self, tmp_path: Path) -> None:
        # git 仓库但没有任何提交：rev-parse HEAD 失败 → WorkspaceError，不落盘也不抛错。
        broken = tmp_path / "broken"
        broken.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=broken, check=True)

        assert capture_partial_candidate(tmp_path, broken, "halt") is False
        assert not (tmp_path / "partial-candidate.diff").exists()
