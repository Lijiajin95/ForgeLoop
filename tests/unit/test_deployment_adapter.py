"""本机部署 IO 边界的错误与容错路径单元测试。

覆盖：Release 元数据形态异常、uv 缺失时的 venv+pip 回退命令、激活前清理残留临时
链接、冒烟检查超时/缺可执行文件、部署日志损坏行与缺字段的容错。
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from forgeloop.adapter import deployment
from forgeloop.adapter.deployment import (
    DeploymentError,
    activate,
    default_prefix,
    installed_digests,
    installed_versions,
    journal_path,
    previous_version,
    release_assets,
    smoke_check,
)


class TestReleaseAssetsErrors:
    def test_non_dict_payload_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setattr(deployment, "_fetch_json", lambda url: ["not-a-dict"])
        with pytest.raises(DeploymentError, match="元数据格式错误"):
            release_assets("owner/repo", "v0.0.1")

    def test_missing_asset_list_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setattr(deployment, "_fetch_json", lambda url: {"assets": "nope"})
        with pytest.raises(DeploymentError, match="没有资产列表"):
            release_assets("owner/repo", "v0.0.1")

    def test_empty_asset_list_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setattr(deployment, "_fetch_json", lambda url: {"assets": []})
        with pytest.raises(DeploymentError, match="资产为空"):
            release_assets("owner/repo", "v0.0.1")

    def test_non_dict_asset_entries_are_skipped(self, monkeypatch) -> None:
        payload = {"assets": [1, {"name": "a", "browser_download_url": "u"}]}
        monkeypatch.setattr(deployment, "_fetch_json", lambda url: payload)
        assert release_assets("owner/repo", "v0.0.1") == {"a": "u"}


class TestUvResolution:
    def test_default_prefix_points_into_local_share(self) -> None:
        assert default_prefix().parts[-2:] == ("share", "forgeloop")

    def test_find_uv_falls_back_to_path(self, monkeypatch) -> None:
        monkeypatch.setattr(deployment.sys, "executable", "/nonexistent/python")
        monkeypatch.setattr(deployment.shutil, "which", lambda name: "/usr/bin/uv")
        assert deployment._find_uv() == "/usr/bin/uv"

    def test_install_without_uv_uses_venv_and_pip(self, tmp_path: Path, monkeypatch) -> None:
        recorded: list[list[str]] = []

        def fake_run(command, environment=None):
            recorded.append(list(command))

        monkeypatch.setattr(deployment, "_find_uv", lambda: None)
        monkeypatch.setattr(deployment, "_run", fake_run)
        monkeypatch.setattr(deployment, "_write_shim", lambda target: None)
        wheel = tmp_path / "wheel.whl"
        deployment.install_wheel(wheel, tmp_path / "releases" / "0.0.1")
        assert recorded[0][:3] == [sys.executable, "-m", "venv"]
        assert recorded[1][1:] == ["-m", "pip", "install", str(wheel)]


class TestActivationAndSmoke:
    def test_activate_clears_stale_temporary_link(self, tmp_path: Path) -> None:
        version = tmp_path / "releases" / "0.0.1"
        (version / "bin").mkdir(parents=True)
        (version / "bin" / "forgeloop").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        stale = tmp_path / f"current.tmp-{os.getpid()}"
        stale.symlink_to(tmp_path / "gone")
        activate(tmp_path, "0.0.1")
        assert not stale.is_symlink()
        assert (tmp_path / "current").is_symlink()

    def test_smoke_timeout_is_reported(self, tmp_path: Path, monkeypatch) -> None:
        version = tmp_path / "releases" / "0.0.1"
        (version / "bin").mkdir(parents=True)
        (version / "bin" / "forgeloop").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        activate(tmp_path, "0.0.1")

        def boom(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="forgeloop", timeout=1)

        monkeypatch.setattr(deployment.subprocess, "run", boom)
        assert smoke_check(tmp_path) == (124, "冒烟检查超时")

    def test_smoke_missing_executable_is_reported(self, tmp_path: Path) -> None:
        code, detail = smoke_check(tmp_path)
        assert code == 127
        assert "未找到可执行文件" in detail


class TestJournalTolerance:
    def test_corrupt_lines_are_skipped(self, tmp_path: Path) -> None:
        path = journal_path(tmp_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = '{"version": "0.0.1", "artifact_sha256": "' + "a" * 64 + '"}'
        path.write_text(entry + "\nnot json\n", encoding="utf-8")
        assert set(installed_digests(tmp_path)) == {"0.0.1"}

    def test_entries_without_version_or_digest_are_skipped(self, tmp_path: Path) -> None:
        deployment.append_journal(tmp_path, {"version": 1, "artifact_sha256": None})
        assert installed_digests(tmp_path) == {}
        assert previous_version(tmp_path) is None

    def test_installed_versions_skips_files(self, tmp_path: Path) -> None:
        releases = tmp_path / "releases"
        releases.mkdir(parents=True)
        (releases / "0.0.1").mkdir()
        (releases / "stray.txt").write_text("x", encoding="utf-8")
        assert installed_versions(tmp_path) == ("0.0.1",)
