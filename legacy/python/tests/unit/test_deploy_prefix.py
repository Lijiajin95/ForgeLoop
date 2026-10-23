"""部署前缀必须绝对化：激活指针是符号链接，相对前缀会写出坏链接。

2026-10-20 实测：``forgeloop deploy --prefix .cache/cd-verify/prefix`` 安装与写入日志都成功，
但 ``current -> .cache/cd-verify/prefix/releases/0.0.4`` 被按链接所在目录再解析一次，
冒烟检查报 127「未找到可执行文件」。这里把 ``_prefix`` 的绝对化与 ``activate`` 的绝对
链接目标钉成机器判定。
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pytest

from forgeloop.adapter.deployment import activate, version_binary
from forgeloop.cli.deploy import _prefix


def test_relative_prefix_is_normalised_to_absolute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    prefix = _prefix(argparse.Namespace(prefix="relative/prefix"))
    assert prefix.is_absolute()
    assert prefix == (tmp_path / "relative" / "prefix").resolve()


def test_tilde_prefix_is_expanded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    prefix = _prefix(argparse.Namespace(prefix="~/forgeloop-prefix"))
    assert prefix == (tmp_path / "forgeloop-prefix").resolve()


def test_activate_writes_an_absolute_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """相对前缀也要激活成可用指针：``current/bin/forgeloop`` 必须真的存在。"""

    monkeypatch.chdir(tmp_path)
    relative = Path("relative-prefix")
    (relative / "releases" / "0.0.4" / "bin").mkdir(parents=True)
    binary = relative / "releases" / "0.0.4" / "bin" / "forgeloop"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o755)

    activate(relative, "0.0.4")

    current = relative / "current"
    assert current.is_symlink()
    assert os.path.isabs(str(os.readlink(current))), "链接目标必须是绝对路径"
    assert (current / "bin" / "forgeloop").is_file()
    assert version_binary(relative, "0.0.4").exists()
