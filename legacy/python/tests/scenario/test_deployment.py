"""S2 端到端（正常路径）：本机部署、原子激活、冒烟检查与回滚。

测试用 wheel 是真实可安装的，走真实 uv/pip 安装路径；控制路径用本地假 Release
服务器（假 GitHub API + HTTP 资产），不访问外网。拒绝与失败路径见
``test_deployment_refusals.py``。
"""

import hashlib
from pathlib import Path

import pytest
from support import (
    FakeRelease,
    build_wheel,
    make_project,
    prepare_release_env,
    run_cli,
)

from forgeloop.adapter import deployment
from forgeloop.adapter.deployment import (
    DeploymentError,
    activate,
    current_version,
    installed_digests,
    installed_versions,
    journal_entries,
    previous_version,
    release_assets,
    remote_slug,
    sha256_of_file,
    smoke_check,
)


def deploy(prefix: Path, wheel: Path, tag: str, capsys, **extra):
    argv = [
        "deploy",
        "--tag",
        tag,
        "--artifact",
        str(wheel),
        "--bootstrap",
        "--prefix",
        str(prefix),
    ]
    for flag, value in extra.items():
        argv.extend([f"--{flag.replace('_', '-')}", str(value)])
    return run_cli(argv, capsys)


class TestBootstrapDeployAndRollback:
    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_deploy_activate_and_rollback(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        dist = tmp_path / "dist"
        first = build_wheel(dist, "0.0.1")

        code, out = deploy(prefix, first, "v0.0.1", capsys, bootstrap_note="首次安装")
        assert code == 0, out
        # 回归：bootstrap 成功后必须走到部署结果通知那一步（此前 health_detail 未初始化，
        # 命令在最后一步抛 UnboundLocalError——真实试验发现）。
        assert "邮件通知" in out
        assert current_version(prefix) == "0.0.1"
        assert (prefix / "current" / "bin" / "forgeloop").exists()

        # 幂等：同版本同产物再次部署不重复安装、不追加日志。
        code, out = deploy(prefix, first, "v0.0.1", capsys)
        assert code == 0, out
        assert "不重复安装" in out
        assert len(journal_entries(prefix)) == 1

        second = build_wheel(dist, "0.0.2")
        code, out = deploy(prefix, second, "v0.0.2", capsys)
        assert code == 0, out
        assert current_version(prefix) == "0.0.2"
        assert previous_version(prefix) == "0.0.1"

        # 真实回滚：切换激活指针 + 冒烟检查 + 记录。
        code, out = run_cli(["rollback", "--prefix", str(prefix), "--note", "演练"], capsys)
        assert code == 0, out
        assert current_version(prefix) == "0.0.1"
        actions = [entry["action"] for entry in journal_entries(prefix)]
        assert actions == ["deploy", "deploy", "rollback"]
        assert set(installed_digests(prefix)) == {"0.0.1", "0.0.2"}
        assert len(set(installed_digests(prefix).values())) == 2


class TestAutomaticRollbackOnUnhealthyRelease:
    """健康检查不通过时自动回滚到上一版本（所有者 2026-10-18 决定）。"""

    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_unhealthy_release_is_rolled_back_to_previous_version(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        prefix = tmp_path / "prefix"
        # 先用引导部署装上"上一稳定版本"，作为回滚目标。
        old_wheel = build_wheel(tmp_path / "dist-old", "0.0.0")
        code, out = deploy(prefix, old_wheel, "v0.0.0", capsys)
        assert code == 0, out
        assert current_version(prefix) == "0.0.0"

        env = prepare_release_env(tmp_path, monkeypatch)
        approve = run_cli(
            [
                "deploy-approve",
                "--tag",
                "v0.0.1",
                "--artifact-sha256",
                str(env["digest"]),
                "--by",
                "owner",
                "--reason",
                "场景测试：确认安装该版本",
                "--records-root",
                str(env["records"]),
            ],
            capsys,
        )
        assert approve[0] == 0, approve[1]
        # 让健康检查必然失败：模拟"新版本装上了但跑不起来"。
        monkeypatch.setattr(
            "forgeloop.cli.deploy.health_check", lambda prefix, **kw: (2, "模拟不健康")
        )
        try:
            code, out = run_cli(
                [
                    "deploy",
                    "--tag",
                    "v0.0.1",
                    "--prefix",
                    str(prefix),
                    "--records-root",
                    str(env["records"]),
                ],
                capsys,
            )
        finally:
            env["server"].stop()

        assert code == 1
        assert "自动回滚" in out
        assert current_version(prefix) == "0.0.0"  # 服务仍在可用版本上
        actions = [entry["action"] for entry in journal_entries(prefix)]
        assert "auto-rollback" in actions


class TestControlledDeploy:
    """控制路径：只部署 Release 上发布的同一份产物并绑定标签提交。"""

    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_deploy_from_fake_release_binds_provenance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        env = prepare_release_env(tmp_path, monkeypatch)
        # 发布前需确认（所有者 2026-10-18 决定）：先记录人工部署批准。
        approve_code, approve_out = run_cli(
            [
                "deploy-approve",
                "--tag",
                "v0.0.1",
                "--artifact-sha256",
                str(env["digest"]),
                "--by",
                "owner",
                "--reason",
                "场景测试：确认安装该版本",
                "--records-root",
                str(env["records"]),
            ],
            capsys,
        )
        assert approve_code == 0, approve_out
        # 该用例验的是"产物来源绑定"，健康检查另有用例覆盖（测试环境里的 wheel 是
        # 最小构建、不带真实服务输出），因此这里让健康检查返回通过。
        monkeypatch.setattr(
            "forgeloop.cli.deploy.health_check", lambda prefix, **kw: (0, "测试：模拟健康")
        )
        try:
            code, out = run_cli(
                [
                    "deploy",
                    "--tag",
                    "v0.0.1",
                    "--prefix",
                    str(env["prefix"]),
                    "--records-root",
                    str(env["records"]),
                ],
                capsys,
            )
        finally:
            env["server"].stop()
        assert code == 0, out
        assert current_version(env["prefix"]) == "0.0.1"
        entry = journal_entries(env["prefix"])[-1]
        assert entry["artifact_source"] == "release"
        assert entry["artifact_sha256"] == env["digest"]
        assert entry["merge_commit"] == env["commit"]
        assert (env["prefix"] / "artifacts" / env["wheel"].name).is_file()


class TestAdapterPrimitives:
    def test_sha256_of_file_matches_hashlib(self, tmp_path: Path) -> None:
        target = tmp_path / "artifact.bin"
        target.write_bytes(b"payload")
        assert sha256_of_file(target) == hashlib.sha256(b"payload").hexdigest()

    def test_release_assets_lists_and_downloads(self, tmp_path: Path, monkeypatch) -> None:
        server = FakeRelease("owner/repo", "v0.0.1", {"SHA256SUMS": b"abc  x\n"}).start()
        monkeypatch.setattr(deployment, "GITHUB_API", server.api_template)
        try:
            assets = release_assets("owner/repo", "v0.0.1")
            assert "SHA256SUMS" in assets
            downloaded = deployment.download_asset(assets["SHA256SUMS"], tmp_path / "out" / "sums")
            assert downloaded.read_bytes() == b"abc  x\n"
        finally:
            server.stop()

    def test_remote_slug_parsing(self, tmp_path: Path) -> None:
        assert remote_slug(make_project(tmp_path)) == "owner/repo"
        plain = tmp_path / "plain"
        plain.mkdir()
        assert remote_slug(plain) is None

    def test_activate_refuses_incomplete_version(self, tmp_path: Path) -> None:
        with pytest.raises(DeploymentError, match="未安装或不完整"):
            activate(tmp_path, "0.0.9")

    def test_installed_versions_lists_release_dirs(self, tmp_path: Path) -> None:
        assert installed_versions(tmp_path) == ()
        (tmp_path / "releases" / "0.0.1").mkdir(parents=True)
        (tmp_path / "releases" / "0.0.2").mkdir()
        assert installed_versions(tmp_path) == ("0.0.1", "0.0.2")

    def test_smoke_check_reports_failure_exit_code(self, tmp_path: Path) -> None:
        version = tmp_path / "releases" / "0.0.1"
        (version / "bin").mkdir(parents=True)
        script = version / "bin" / "forgeloop"
        script.write_text("#!/bin/sh\necho boom >&2\nexit 3\n", encoding="utf-8")
        script.chmod(0o755)
        activate(tmp_path, "0.0.1")
        code, detail = smoke_check(tmp_path)
        assert code == 3
        assert "boom" in detail
