"""S2 拒绝与失败路径：前置不满足时不安装、不激活，失败如实报告。

覆盖：引导路径必须显式标注、同版本不同产物拒绝、控制路径缺回执、缺项目路径、
缺 slug、缺校验清单、缺 wheel 资产、产物被篡改、标签提交不一致、冒烟失败与安装
失败，以及回滚的目标校验与失败路径。
"""

import subprocess
from pathlib import Path

import pytest
from support import (
    ReleaseScene,
    build_wheel,
    make_version_dir,
    prepare_release_env,
    record_release,
    run_cli,
)

from forgeloop.adapter.deployment import activate, append_journal, current_version, journal_entries


def deploy(capsys, tag: str = "v0.0.1", **flags):
    argv = ["deploy", "--tag", tag]
    for flag, value in flags.items():
        name = f"--{flag.replace('_', '-')}"
        if value is True:
            argv.append(name)
        elif value is not None:
            argv.extend([name, str(value)])
    return run_cli(argv, capsys)


def journal_version(prefix: Path, version: str, digest: str = "a" * 64, previous: str = "") -> None:
    append_journal(
        prefix,
        {
            "action": "deploy",
            "version": version,
            "tag": f"v{version}",
            "artifact_name": "",
            "artifact_sha256": digest,
            "artifact_source": "bootstrap",
            "merge_commit": "",
            "previous_version": previous,
            "smoke_exit_code": 0,
            "installed_at": "2026-10-12T00:00:00+00:00",
            "note": "",
        },
    )


def controlled(capsys, env: dict, **flags):
    """受控部署：先按"发布前需确认"记录人工批准，再执行部署。

    批准绑定 `(tag, artifact_sha256)`；本助手用发布回执里的产物校验值批准，因此
    后续被拒的原因必然是**被测的那条规则**（篡改产物、标签提交不符等），
    而不是缺少批准。
    """

    tag = flags.get("tag", "v0.0.1")
    digest = str(env["digest"])  # 真实产物校验值：与部署计划算出的一致
    code, out = run_cli(
        [
            "deploy-approve",
            "--tag",
            tag,
            "--artifact-sha256",
            digest,
            "--by",
            "owner",
            "--reason",
            "场景测试：确认安装该版本",
            "--records-root",
            str(env["records"]),
        ],
        capsys,
    )
    assert code == 0, out
    return deploy(
        capsys,
        prefix=env["prefix"],
        records_root=env["records"],
        **flags,
    )


class TestBootstrapRefusals:
    def test_artifact_without_bootstrap_flag_is_refused(self, tmp_path: Path, capsys) -> None:
        wheel = build_wheel(tmp_path / "dist", "0.0.1")
        code, out = deploy(capsys, artifact=wheel, prefix=tmp_path / "prefix")
        assert code == 1
        assert "--bootstrap" in out

    def test_missing_artifact_is_refused(self, tmp_path: Path, capsys) -> None:
        code, out = deploy(
            capsys, artifact=tmp_path / "nope.whl", bootstrap=True, prefix=tmp_path / "prefix"
        )
        assert code == 1
        assert "本地产物不存在" in out

    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_same_version_other_artifact_is_refused(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        dist = tmp_path / "dist"
        first = build_wheel(dist, "0.0.1")
        assert deploy(capsys, artifact=first, bootstrap=True, prefix=prefix)[0] == 0
        tampered = build_wheel(dist, "0.0.1", marker="不同内容")
        code, out = deploy(capsys, artifact=tampered, bootstrap=True, prefix=prefix)
        assert code == 1
        assert "已激活" in out
        assert current_version(prefix) == "0.0.1"

    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_install_failure_is_reported(self, tmp_path: Path, capsys) -> None:
        bogus = tmp_path / "forgeloop-0.0.1-py3-none-any.whl"
        bogus.write_text("not a wheel\n", encoding="utf-8")
        prefix = tmp_path / "prefix"
        code, out = deploy(capsys, artifact=bogus, bootstrap=True, prefix=prefix)
        assert code == 1
        assert "命令失败" in out
        assert current_version(prefix) is None
        assert not (prefix / "releases" / "0.0.1").exists()  # 半成品已清理

    @pytest.mark.install
    @pytest.mark.timeout(180)
    def test_smoke_failure_is_reported_without_auto_revert(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        wheel = build_wheel(tmp_path / "dist", "0.0.1", failing=True)
        code, out = deploy(capsys, artifact=wheel, bootstrap=True, prefix=prefix)
        assert code == 1
        assert "冒烟检查失败" in out
        assert "未自动回退" in out
        entry = journal_entries(prefix)[-1]
        assert entry["smoke_exit_code"] == 3

    def test_smoke_failure_reports_recovery_without_broken_version(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        """坏版本激活后，恢复入口必须独立于坏版本（直接指向上一稳定版本）。"""

        prefix = tmp_path / "prefix"
        make_version_dir(prefix, "0.0.1")
        journal_version(prefix, "0.0.1")
        activate(prefix, "0.0.1")
        broken = build_wheel(tmp_path / "dist", "0.0.2", failing=True)

        def fake_install(artifact: Path, target: Path, python_version: str = "3.13") -> None:
            make_version_dir(prefix, "0.0.2", exit_code=3)

        monkeypatch.setattr("forgeloop.cli.deploy.install_wheel", fake_install)
        code, out = deploy(capsys, tag="v0.0.2", artifact=broken, bootstrap=True, prefix=prefix)
        assert code == 1
        assert "冒烟检查失败" in out
        recovery = prefix / "releases" / "0.0.1" / "bin" / "forgeloop"
        assert str(recovery) in out
        assert "无需调用新版本" in out
        # 恢复入口不经过坏版本的 current，直接执行旧版本 shim 仍可用。
        result = subprocess.run([str(recovery), "--help"], capture_output=True, text=True)
        assert result.returncode == 0


class TestControlledRefusals:
    def test_without_release_record_is_refused(self, tmp_path: Path, capsys) -> None:
        code, out = deploy(capsys, prefix=tmp_path / "prefix", records_root=tmp_path / "records")
        assert code == 1
        assert "发布回执" in out

    def test_release_project_without_remote_is_refused(self, tmp_path: Path, capsys) -> None:
        # 项目仓库由登记表提供；没有可解析的 GitHub owner/name 时在下载前拒绝。
        records = tmp_path / "records"
        record_release(records, None, merge_commit="a" * 40)
        code, out = deploy(capsys, prefix=tmp_path / "prefix", records_root=records)
        assert code == 1
        assert "无法从项目仓库确定" in out

    def test_without_remote_slug_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        env = prepare_release_env(tmp_path, monkeypatch, ReleaseScene(remote=""))
        try:
            code, out = controlled(capsys, env)
        finally:
            env["server"].stop()
        assert code == 1
        assert "owner/name" in out

    def test_missing_checksum_asset_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        env = prepare_release_env(tmp_path, monkeypatch)
        wheel = env["wheel"]
        env["server"].assets.clear()
        env["server"].assets[wheel.name] = wheel.read_bytes()
        try:
            code, out = controlled(capsys, env)
        finally:
            env["server"].stop()
        assert code == 1
        assert "SHA256SUMS" in out

    def test_missing_wheel_asset_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        scene = ReleaseScene(assets={"SHA256SUMS": f"{'a' * 64}  other.whl\n".encode()})
        env = prepare_release_env(tmp_path, monkeypatch, scene)
        try:
            code, out = controlled(capsys, env)
        finally:
            env["server"].stop()
        assert code == 1
        assert "wheel 资产" in out

    def test_tampered_release_artifact_is_refused(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        env = prepare_release_env(tmp_path, monkeypatch, ReleaseScene(checksum_digest="e" * 64))
        try:
            code, out = controlled(capsys, env)
        finally:
            env["server"].stop()
        assert code == 1
        assert "校验值" in out
        assert current_version(env["prefix"]) is None

    def test_tag_commit_mismatch_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        env = prepare_release_env(tmp_path, monkeypatch, ReleaseScene(release_commit="a" * 40))
        try:
            code, out = controlled(capsys, env)
        finally:
            env["server"].stop()
        assert code == 1
        assert "标签提交" in out
        assert current_version(env["prefix"]) is None


class TestRollbackFailures:
    def test_without_target_is_refused(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(["rollback", "--prefix", str(tmp_path / "prefix")], capsys)
        assert code == 1
        assert "上一版本" in out

    def test_uninstalled_target_is_refused(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        journal_version(prefix, "0.0.9")
        code, out = run_cli(["rollback", "--to", "0.0.9", "--prefix", str(prefix)], capsys)
        assert code == 1
        assert "未安装" in out

    def test_activate_failure_is_reported(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        journal_version(prefix, "0.0.9")  # 有校验记录但没有版本目录
        code, out = run_cli(["rollback", "--to", "0.0.9", "--prefix", str(prefix)], capsys)
        assert code == 1
        assert "未安装或不完整" in out

    def test_smoke_failure_after_rollback_is_reported(self, tmp_path: Path, capsys) -> None:
        prefix = tmp_path / "prefix"
        make_version_dir(prefix, "0.0.1", exit_code=3)
        make_version_dir(prefix, "0.0.2")
        journal_version(prefix, "0.0.1", digest="a" * 64)
        journal_version(prefix, "0.0.2", digest="b" * 64, previous="0.0.1")
        activate(prefix, "0.0.2")
        code, out = run_cli(["rollback", "--to", "0.0.1", "--prefix", str(prefix)], capsys)
        assert code == 1
        assert "回滚后冒烟检查失败" in out
        assert current_version(prefix) == "0.0.1"
