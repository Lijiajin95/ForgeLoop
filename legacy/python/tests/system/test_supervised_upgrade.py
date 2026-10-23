"""受控热升级系统验收：真实启动器进程 + 真实 CLI 子进程 + 真实业务替身。

不调用 systemd 总线、不写真实宿主前缀：unit 与真机接入另见 docs/deployment.md。
这里验证普通升级路径的进程事实：启动器 PID 不变、业务 PID/generation 改变、
失败候选恢复旧版、排空超时延期且旧进程继续。
"""

import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

SCENARIO = Path(__file__).resolve().parents[1] / "scenario"
sys.path.insert(0, str(SCENARIO))

_scene_api: Any = importlib.import_module("test_supervised_upgrade")
SupervisedUpgradeScene: Any = _scene_api.SupervisedUpgradeScene
NEW_DIGEST = str(_scene_api.NEW_DIGEST)
_alive = _scene_api._alive

from forgeloop.domain.upgrade import (  # noqa: E402
    PHASE_COMMITTED,
    PHASE_DEFERRED,
    PHASE_ROLLED_BACK,
)

pytestmark = pytest.mark.system
ROOT = Path(__file__).resolve().parents[2]


def _cli(scene: Any, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _apply(scene: Any) -> subprocess.CompletedProcess[str]:
    return _cli(
        scene,
        "upgrade",
        "apply",
        "--prefix",
        str(scene.prefix),
        "--tag",
        "v0.0.2",
        "--artifact-sha256",
        NEW_DIGEST,
        "--by",
        "owner",
        "--reason",
        "系统验收：受控升级",
        "--json",
    )


class TestRealSupervisedUpgrade:
    def test_status_and_apply_through_real_cli_processes(self) -> None:
        scene = SupervisedUpgradeScene()
        try:
            scene.start()
            before = scene.status()
            child = int(before["child_pid"])

            status = _cli(scene, "upgrade", "status", "--prefix", str(scene.prefix), "--json")
            assert status.returncode == 0, status.stdout + status.stderr
            document = json.loads(status.stdout)
            assert document["state"]["identity"]["version"] == "0.0.1"

            applied = _apply(scene)
            assert applied.returncode == 0, applied.stdout + applied.stderr
            assert "已切换到 0.0.2" in applied.stdout

            after = scene.status()
            assert after["launcher_pid"] == before["launcher_pid"]
            assert int(after["child_pid"]) != child
            assert after["child_alive"] is True
            assert _alive(child) is False
            assert scene.current_version() == "0.0.2"
            state = scene.state()
            assert state is not None and state.phase == PHASE_COMMITTED
            assert state.identity.version == "0.0.2"
        finally:
            scene.cleanup()

    def test_failed_candidate_is_rolled_back_by_real_launcher(self) -> None:
        scene = SupervisedUpgradeScene(candidate_fail_ready=True)
        try:
            scene.start()
            applied = _apply(scene)
            assert applied.returncode == 1, applied.stdout + applied.stderr
            assert "已恢复 0.0.1" in applied.stdout + applied.stderr
            state = scene.state()
            assert state is not None and state.phase == PHASE_ROLLED_BACK
            assert state.identity.version == "0.0.1"
            assert scene.current_version() == "0.0.1"
            assert scene.status()["child_alive"] is True
        finally:
            scene.cleanup()

    def test_drain_timeout_defers_and_old_process_keeps_serving(self) -> None:
        scene = SupervisedUpgradeScene(old_ignore_drain=True, drain_timeout=1.0)
        try:
            scene.start()
            before = scene.status()
            old_child = int(before["child_pid"])
            applied = _apply(scene)
            assert applied.returncode == 1, applied.stdout + applied.stderr
            assert "已延期" in applied.stdout + applied.stderr
            state = scene.state()
            assert state is not None and state.phase == PHASE_DEFERRED
            assert scene.current_version() == "0.0.1"
            assert scene.status()["child_pid"] == old_child
            assert _alive(old_child)
            assert not (scene.root / "systemd").exists()
        finally:
            scene.cleanup()
