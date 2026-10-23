"""正式测试命令运行器的单元测试：退出码、超时与参数校验负例。"""

from pathlib import Path

import pytest

from forgeloop.adapter.test_runner import run_test_command


class TestRunTestCommand:
    def test_exit_code_and_evidence_are_recorded(self, tmp_path: Path) -> None:
        import sys

        outcome = run_test_command(
            [sys.executable, "-c", "print('ok')"],
            cwd=tmp_path,
            timeout_seconds=10.0,
            evidence_path=tmp_path / "evidence.jsonl",
        )
        assert outcome.exit_code == 0
        assert not outcome.timed_out
        assert "ok" in outcome.stdout
        lines = (tmp_path / "evidence.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        import json

        assert json.loads(lines[0])["exit_code"] == 0

    def test_timeout_is_reported_not_disguised(self, tmp_path: Path) -> None:
        import sys

        outcome = run_test_command(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            cwd=tmp_path,
            timeout_seconds=0.3,
            evidence_path=tmp_path / "evidence.jsonl",
        )
        assert outcome.timed_out
        assert outcome.exit_code is None  # 未明确结果不伪装为通过或失败

    def test_empty_command_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            run_test_command([], cwd=tmp_path, timeout_seconds=1.0, evidence_path=tmp_path / "e")

    def test_non_positive_timeout_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="must be positive"):
            run_test_command(
                ["true"], cwd=tmp_path, timeout_seconds=0.0, evidence_path=tmp_path / "e"
            )
