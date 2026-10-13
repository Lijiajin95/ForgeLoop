"""S3 方案 B 端到端：候选分支 → 等检查 → 快进 main → 删除候选分支。

真实 git 仓库 + 本地裸仓库当远程（origin 的读取地址是 GitHub URL 供 slug 解析，
推送地址指向本地裸仓库）。检查状态用替身注入：通过、失败、先 pending 后通过、
读取报错重试、超时等路径都覆盖。
"""

import json
import subprocess
from pathlib import Path

from support import run_cli, run_git, status_document, submit_task

from forgeloop.adapter.git_workspace import list_branches
from forgeloop.adapter.github_checks import ChecksError

GITHUB_URL = "https://github.com/owner/repo.git"
PASSING = {"quality": "success", "security": "success", "commit-policy": "success"}


def make_source(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "feature.txt").write_text("old\n", encoding="utf-8")
    run_git(source, "init", "-b", "main")
    run_git(source, "config", "user.name", "t")
    run_git(source, "config", "user.email", "t@example.com")
    run_git(source, "add", "-A")
    run_git(source, "commit", "-m", "chore: baseline")
    return source


def delivered_task(tmp_path: Path, capsys, monkeypatch) -> tuple[str, Path]:
    """交付一个任务（不归并）：假 PI 编辑副本、假测试通过、验收批准。"""

    monkeypatch.setenv("FAKE_PI_MODE", "edit")
    source = make_source(tmp_path)
    task_id = submit_task(tmp_path, capsys, **{"project-path": str(source)})
    run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
    code, out = run_cli(
        ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
    )
    assert code == 0, out
    return task_id, source


def attach_remote(source: Path, tmp_path: Path) -> Path:
    """origin 的读取地址是 GitHub（供 slug 解析），推送地址指向本地裸仓库。"""

    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
    run_git(source, "remote", "add", "origin", GITHUB_URL)
    run_git(source, "remote", "set-url", "--push", "origin", str(bare))
    run_git(source, "push", "origin", "main")
    return bare


def remote_head(bare: Path) -> str:
    return subprocess.run(
        ["git", "--git-dir", str(bare), "rev-parse", "main"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def fake_checks(monkeypatch, outcomes: list[dict[str, str]]) -> dict:
    """注入检查状态替身：按调用次序返回，最后一次重复使用。"""

    calls = {"n": 0}

    def fake(slug: str, sha: str) -> dict[str, str]:
        index = min(calls["n"], len(outcomes) - 1)
        calls["n"] += 1
        return outcomes[index]

    monkeypatch.setattr("forgeloop.cli.merge.check_runs", fake)
    monkeypatch.setattr("forgeloop.cli.merge.CHECK_POLL_SECONDS", 0.0)
    return calls


def evidence(task_id: str, tmp_path: Path) -> dict:
    return json.loads((tmp_path / task_id / "merge-evidence.json").read_text(encoding="utf-8"))


class TestCandidateBranchFlow:
    def test_checks_pass_then_main_fast_forwards_and_branch_is_deleted(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        bare = attach_remote(source, tmp_path)
        fake_checks(monkeypatch, [PASSING])

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        local_head = run_git(source, "rev-parse", "HEAD")
        assert local_head == remote_head(bare)  # main 已快进并推送
        assert list_branches(source) == ("main",)  # 候选分支已删除（本地）
        remote_branches = subprocess.run(
            ["git", "--git-dir", str(bare), "branch", "--format=%(refname:short)"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        assert remote_branches == ["main"]  # 候选分支已删除（远程）
        record = evidence(task_id, tmp_path)
        assert record["flow"] == "candidate-branch"
        assert record["result"] == "merged"
        assert record["checks"]["passed"] is True
        assert record["branch_deleted"] is True
        assert record["main_commit"] == local_head
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "merged"
        assert document["merge"]["pushed"] is True

    def test_failing_check_keeps_main_and_branch(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        bare = attach_remote(source, tmp_path)
        baseline = run_git(source, "rev-parse", "HEAD")
        fake_checks(monkeypatch, [{"quality": "success", "security": "failure"}])

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 1
        assert "必需检查未通过" in out and "security" in out
        assert run_git(source, "rev-parse", "HEAD") == baseline  # main 未更新
        assert remote_head(bare) == baseline
        assert run_git(source, "rev-parse", "--abbrev-ref", "HEAD") == "main"  # 已切回 main
        assert f"forgeloop/{task_id}" in list_branches(source)  # 候选分支保留
        record = evidence(task_id, tmp_path)
        assert record["result"] == "checks_not_passed"
        assert status_document(tmp_path, task_id, capsys)["status"] == "delivered"

    def test_pending_then_success_waits_for_checks(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        attach_remote(source, tmp_path)
        calls = fake_checks(monkeypatch, [{"quality": "pending"}, PASSING])

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        assert calls["n"] == 2
        record = evidence(task_id, tmp_path)
        assert record["checks"]["polls"] == 2
        assert record["checks"]["passed"] is True

    def test_timeout_reports_without_touching_main(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        bare = attach_remote(source, tmp_path)
        baseline = run_git(source, "rev-parse", "HEAD")
        fake_checks(monkeypatch, [{"quality": "pending"}])

        code, out = run_cli(
            [
                "merge",
                task_id,
                "--records-root",
                str(tmp_path),
                "--checks-timeout",
                "0",
            ],
            capsys,
        )
        assert code == 1
        assert "等待检查超时" in out
        assert run_git(source, "rev-parse", "HEAD") == baseline
        assert remote_head(bare) == baseline

    def test_direct_push_still_available(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        bare = attach_remote(source, tmp_path)

        code, out = run_cli(
            ["merge", task_id, "--direct-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        local_head = run_git(source, "rev-parse", "HEAD")
        assert local_head == remote_head(bare)
        assert list_branches(source) == ("main",)  # 不产生候选分支
        assert not (tmp_path / task_id / "merge-evidence.json").exists()

    def test_checks_can_be_disabled_for_repos_without_ci(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        attach_remote(source, tmp_path)
        # 不注入替身：--require-checks none 时不应读取检查状态（也不应访问网络）。
        code, out = run_cli(
            [
                "merge",
                task_id,
                "--records-root",
                str(tmp_path),
                "--require-checks",
                "none",
            ],
            capsys,
        )
        assert code == 0, out
        record = evidence(task_id, tmp_path)
        assert record["checks"]["polls"] == 0
        assert record["checks"]["passed"] is True


class TestCandidateFlowRefusals:
    def test_non_github_origin_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        run_git(source, "remote", "add", "origin", "https://gitlab.com/owner/repo.git")
        run_git(source, "remote", "set-url", "--push", "origin", str(bare))

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 1
        assert "owner/name" in out

    def test_candidate_push_failure_keeps_main(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        run_git(source, "remote", "add", "origin", GITHUB_URL)
        run_git(source, "remote", "set-url", "--push", "origin", str(tmp_path / "missing.git"))
        fake_checks(monkeypatch, [PASSING])
        baseline = run_git(source, "rev-parse", "HEAD")

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 1
        assert "候选分支推送失败" in out
        assert run_git(source, "rev-parse", "HEAD") == baseline
        assert evidence(task_id, tmp_path)["result"] == "candidate_push_failed"

    def test_checks_read_error_is_retried(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        attach_remote(source, tmp_path)
        calls = {"n": 0}

        def flaky(slug: str, sha: str) -> dict[str, str]:
            calls["n"] += 1
            if calls["n"] == 1:
                raise ChecksError("疑似限流")
            return PASSING

        monkeypatch.setattr("forgeloop.cli.merge.check_runs", flaky)
        monkeypatch.setattr("forgeloop.cli.merge.CHECK_POLL_SECONDS", 0.0)
        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        assert evidence(task_id, tmp_path)["checks"]["polls"] == 2

    def test_direct_push_refuses_dirty_worktree(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch)
        attach_remote(source, tmp_path)
        (source / "feature.txt").write_text("dirty\n", encoding="utf-8")

        code, out = run_cli(
            ["merge", task_id, "--direct-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "不干净" in out

    def test_merge_without_delivery_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = make_source(tmp_path)
        task_id = submit_task(tmp_path, capsys, **{"project-path": str(source)})

        code, out = run_cli(["merge", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 1
        assert "尚无交付记录" in out
