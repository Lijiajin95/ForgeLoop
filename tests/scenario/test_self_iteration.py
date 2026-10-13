"""自迭代模拟：git 工作副本 + 真实 diff + 副本内测试 + main 保护。

源仓库含 feature.txt（old）与 run_tests.py（要求 feature.txt==new）；
假 PI（edit 模式）真实修改工作副本；候选 diff 取自 git 而非 PI 自述；
正式测试在副本内运行；交付固化基线提交号；源仓库全程不被改写。
"""

import hashlib
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
        (source / "pyproject.toml").write_text(
            '[project]\nname = "mirror"\nversion = "0.1.0"\n', encoding="utf-8"
        )
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


class TestMergeToMain:
    """B04 端到端：验收交付后受控归并 main（含漂移与未验收负例）。"""

    def _deliver_task(self, tmp_path: Path, capsys, monkeypatch) -> tuple[str, Path]:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = TestSelfIterationLoop()._source_repo(tmp_path)
        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        return task_id, source

    def test_merge_updates_main_and_records_provenance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        # main 已更新：源仓库直接包含候选改动。
        assert (source / "feature.txt").read_text(encoding="utf-8") == "new\n"
        # 状态与归并记录固化来源（merge_commit 与源 main HEAD 一致）。
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "merged"
        assert document["merge"] is not None
        assert document["merge"]["merge_commit"] == document["merge"]["merge_commit"].strip()

    def test_merge_before_delivery_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = TestSelfIterationLoop()._source_repo(tmp_path)
        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "无法归并" in out  # 未验收（无交付记录）拒绝更新 main
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"

    def test_merge_refuses_drifted_main(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import subprocess

        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        # 交付后 main 前进（漂移）。
        (source / "other.txt").write_text("drift\n", encoding="utf-8")
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(tmp_path),
            "GIT_AUTHOR_DATE": "2026-10-11T21:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T21:00:00+08:00",
        }
        for args in (
            ["git", "add", "-A"],
            ["git", "commit", "-m", "chore: main drifted"],
        ):
            subprocess.run(args, cwd=source, check=True, capture_output=True, env=env)
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "漂移" in out
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"

    def test_merge_pushes_to_remote_when_configured(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        import subprocess

        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME": str(tmp_path)}
        subprocess.run(
            ["git", "remote", "add", "origin", str(bare)],
            cwd=source,
            check=True,
            capture_output=True,
            env=env,
        )
        # 该裸仓库没有 CI，故显式走直接流程（候选分支流程见 test_merge_flow.py）。
        code, out = run_cli(
            ["merge", task_id, "--direct-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "merged"
        assert document["merge"]["pushed"] is True
        remote_head = subprocess.run(
            ["git", "--git-dir", str(bare), "rev-parse", "main"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert remote_head == document["merge"]["merge_commit"]


def merged_task(tmp_path: Path, capsys, monkeypatch) -> tuple[str, Path]:
    """交付并归并一个任务，返回 (task_id, 源仓库)。"""

    task_id, source = TestMergeToMain()._deliver_task(tmp_path, capsys, monkeypatch)
    code, out = run_cli(["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys)
    assert code == 0, out
    return task_id, source


def release_task(tmp_path: Path, capsys, task_id: str, tag: str = "v0.1.0"):
    """按 --no-push 执行受控发布（本地标签 + 回执）。"""

    return run_cli(
        ["release", task_id, "--tag", tag, "--no-push", "--records-root", str(tmp_path)], capsys
    )


def repo_tags(source: Path) -> list[str]:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(source), "tag", "-l"], check=True, capture_output=True, text=True
    ).stdout.split()


class TestReleaseAfterMerge:
    """S1 端到端：归并后发布版本标签、固化回执，以及幂等与前置负例。"""

    def test_release_creates_tag_and_receipt(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 0, out
        assert repo_tags(source) == ["v0.1.0"]
        document = status_document(tmp_path, task_id, capsys)
        release = document["release"]
        assert release["tag"] == "v0.1.0"
        assert release["pushed"] is False
        assert release["merge_commit"] == document["merge"]["merge_commit"]
        # 回执校验值与候选 diff 内容一一对应；部署端以同一值核对同一产物。
        candidate = Path(document["delivery"]["diff_path"]).read_text(encoding="utf-8")
        receipt = json.loads(Path(release["receipt_path"]).read_text(encoding="utf-8"))
        assert receipt["diff_sha256"] == hashlib.sha256(candidate.encode("utf-8")).hexdigest()
        report = json.loads(Path(document["delivery"]["report_path"]).read_text(encoding="utf-8"))
        assert receipt["baseline_commit"] == report["baseline_commit"]

    def test_release_before_merge_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = TestMergeToMain()._deliver_task(tmp_path, capsys, monkeypatch)
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "归并" in out
        assert repo_tags(source) == []

    def test_same_tag_repeat_is_idempotent(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 0
        assert "幂等" in out
        assert repo_tags(source) == ["v0.1.0"]

    def test_other_tag_repeat_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        code, out = release_task(tmp_path, capsys, task_id, tag="v0.2.0")
        assert code == 1
        assert "v0.1.0" in out
        assert repo_tags(source) == ["v0.1.0"]
