"""自迭代模拟：git 工作副本 + 真实 diff + 副本内测试 + main 保护。

源仓库含 feature.txt（old）与 run_tests.py（要求 feature.txt==new）；
假 PI（edit 模式）真实修改工作副本；候选 diff 取自 git 而非 PI 自述；
正式测试在副本内运行；交付固化基线提交号；源仓库全程不被改写。
"""

import json
from pathlib import Path

from support import run_cli, status_document, submit_task


class TestSelfIterationLoop:
    """自迭代模拟：git 工作副本 + 真实 diff + 副本内测试 + main 保护。

    源仓库含 feature.txt（old）与 run_tests.py（要求 feature.txt==new）；
    假 PI（edit 模式）真实修改工作副本；候选 diff 取自 git 而非 PI 自述；
    正式测试在副本内运行；交付固化基线提交号；源仓库全程不被改写。
    """

    def _source_repo(self, tmp_path: Path) -> Path:
        import subprocess

        source = tmp_path / "forgeloop-mirror"
        source.mkdir()
        (source / "feature.txt").write_text("old\n", encoding="utf-8")
        (source / "run_tests.py").write_text(
            "import sys\n"
            "ok = open('feature.txt').read().strip() == 'new'\n"
            "print('feature.txt is', 'new' if ok else 'old')\n"
            "sys.exit(0 if ok else 1)\n",
            encoding="utf-8",
        )
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(tmp_path),
            "GIT_AUTHOR_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T20:00:00+08:00",
        }
        for args in (
            ["git", "init", "-b", "main"],
            ["git", "config", "user.name", "t"],
            ["git", "config", "user.email", "t@example.com"],
            ["git", "add", "-A"],
            ["git", "commit", "-m", "chore: mirror baseline"],
        ):
            subprocess.run(args, cwd=source, check=True, capture_output=True, env=env)
        return source

    def test_clone_edit_diff_test_deliver(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = self._source_repo(tmp_path)

        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_acceptance"

        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"

        # 候选 diff 来自 git 工作树对基线的真实差异（非 PI 文本自述）。
        candidate = Path(document["delivery"]["diff_path"])
        diff_text = candidate.read_text(encoding="utf-8")
        assert "-old" in diff_text and "+new" in diff_text
        assert "feature.txt" in diff_text

        # dev 报告记录 diff 来源与基线提交号。
        dev_reports = [
            json.loads(line)
            for line in (tmp_path / task_id / "dev-reports.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert dev_reports[0]["diff_source"] == "git"
        assert len(dev_reports[0]["baseline_commit"]) == 40

        # 交付报告固化基线提交号（A02：最终交付明确基线与改动）。
        report = json.loads(
            (tmp_path / task_id / "delivery-report.json").read_text(encoding="utf-8")
        )
        assert len(report["baseline_commit"]) == 40

        # 正式测试在副本内真实执行且通过（feature.txt 已被 PI 修改）。
        runs = [
            json.loads(line)
            for line in (tmp_path / task_id / "test-run.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert runs[0]["exit_code"] == 0
        assert "feature.txt is new" in runs[0]["stdout"]

        # main 保护：源仓库未被改写（A02：PI 无法修改真实 main）。
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"
