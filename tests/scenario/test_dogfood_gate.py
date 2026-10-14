"""DogFood 来源门禁的端到端场景（C04）。

真实 git 仓库 + 真实 ``forgeloop merge``：受控执行端在合并提交里附签名回执；
可信校验端脚本在启用策略下接受受控提交，并拒绝普通直接提交、补挂任务 ID、
内容漂移与伪造签名。禁用策略只报告“待启用”，不阻断。
"""

import os
import subprocess
import sys
from pathlib import Path

from support import run_cli, run_git, submit_task

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "check_dogfood_provenance.py"
KEY_ENV = "FORGELOOP_DOGFOOD_SIGNING_KEY"
KEY = "scenario-signing-key"


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


def delivered_task(tmp_path: Path, capsys, monkeypatch, *, sign: bool) -> tuple[str, Path]:
    monkeypatch.setenv("FAKE_PI_MODE", "edit")
    if sign:
        monkeypatch.setenv(KEY_ENV, KEY)
    else:
        monkeypatch.delenv(KEY_ENV, raising=False)
    source = make_source(tmp_path)
    task_id = submit_task(tmp_path, capsys, **{"project-path": str(source)})
    run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
    code, out = run_cli(
        ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)], capsys
    )
    assert code == 0, out
    return task_id, source


def enabled_policy(tmp_path: Path) -> Path:
    policy = tmp_path / "dogfood-policy.toml"
    policy.write_text('enabled = true\nsigning_key_env = "FORGELOOP_DOGFOOD_SIGNING_KEY"\n')
    return policy


def run_gate(repo: Path, policy: Path, base: str, head: str, key: str | None) -> tuple[int, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "src")
    if key is None:
        env.pop(KEY_ENV, None)
    else:
        env[KEY_ENV] = key
    result = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--policy",
            str(policy),
            "--repo",
            str(repo),
            "--audit",
            base,
            head,
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode, result.stdout + result.stderr


def merge_controlled(source: Path, task_id: str, tmp_path: Path, capsys) -> None:
    code, out = run_cli(["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys)
    assert code == 0, out


def direct_commit(source: Path, message: str) -> str:
    run_git(source, "add", "-A")
    run_git(source, "commit", "--allow-empty", "-m", message)
    return run_git(source, "rev-parse", "HEAD")


class TestControlledMergeAccepted:
    def test_signed_merge_passes_enabled_gate(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD~1")
        head = run_git(source, "rev-parse", "HEAD")
        message = run_git(source, "show", "-s", "--format=%B", "HEAD")
        assert "ForgeLoop-Provenance:" in message

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, head, KEY)
        assert code == 0, out
        assert "通过" in out

    def test_gate_checks_every_new_commit(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD~1")
        direct_commit(source, "feat: second commit without receipt")

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, "HEAD", KEY)
        assert code == 1
        assert "缺少来源回执" in out


class TestGateRejections:
    def test_ordinary_direct_commit_is_rejected(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD")
        head = direct_commit(source, "feat: ordinary direct commit")

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, head, KEY)
        assert code == 1
        assert "缺少来源回执" in out

    def test_retroactively_attached_task_id_is_rejected(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD")
        head = direct_commit(source, f"feat: {task_id} 补挂")

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, head, KEY)
        assert code == 1
        assert "缺少来源回执" in out

    def test_content_drift_with_reused_receipt_is_rejected(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD~1")
        message = run_git(source, "show", "-s", "--format=%B", "HEAD")
        (source / "unrecorded.txt").write_text("drift\n", encoding="utf-8")
        head = direct_commit(source, message)

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, head, KEY)
        assert code == 1
        assert "内容漂移" in out

    def test_forged_signature_is_rejected(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=True)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD~1")
        head = run_git(source, "rev-parse", "HEAD")

        code, out = run_gate(source, enabled_policy(tmp_path), baseline, head, "attacker-key")
        assert code == 1
        assert "签名无效" in out


class TestPendingAndRefusals:
    def test_disabled_policy_marks_pending_and_allows(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=False)
        merge_controlled(source, task_id, tmp_path, capsys)
        baseline = run_git(source, "rev-parse", "HEAD~1")
        head = run_git(source, "rev-parse", "HEAD")
        # 禁用策略且未提供密钥时，merge 不附回执（历史与既有流程兼容）。
        assert "ForgeLoop-Provenance:" not in run_git(source, "show", "-s", "--format=%B", "HEAD")

        disabled = ROOT / "config" / "dogfood-policy.toml"
        code, out = run_gate(source, disabled, baseline, head, key=None)
        assert code == 0, out
        assert "未启用" in out

    def test_enabled_policy_without_key_refuses_merge(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = delivered_task(tmp_path, capsys, monkeypatch, sign=False)
        baseline = run_git(source, "rev-parse", "HEAD")
        monkeypatch.setattr("forgeloop.cli.merge.POLICY_PATH", enabled_policy(tmp_path))
        monkeypatch.delenv(KEY_ENV, raising=False)

        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "缺少签名密钥" in out
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"
        assert run_git(source, "rev-parse", "HEAD") == baseline
