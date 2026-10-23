"""系统测试：真实 CLI 子进程处理交付槽位残留。

以 ``python -m forgeloop`` 子进程运行归并/发布入口，记录层用另一个进程写入权威
记录，覆盖三类行为：已死占用者被自动清理并留档后继续；存活占用者不清理并把
「仍存活」写进失败报告；缺少进程身份的不确定占用者不清理、保持占用并报告原因。
判定只看权威动作记录的进程身份，不看等待时长；``--delivery-timeout 0`` 让「保持
等待」在超时边界确定性可复现。
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from project_support import record_store, register_project

from forgeloop.graph.dispatch import project_delivery_slot
from forgeloop.records.actions import SLOT_PREFIX

pytestmark = pytest.mark.system

SRC = Path(__file__).resolve().parents[2] / "src"
TASK_ID = "task-slot-residue"
PROJECT = "proj-slot-residue"


@pytest.fixture()
def exited_pid() -> int:
    """真实启动一个子进程并等它退出，返回已回收、``os.kill`` 必判死的 pid。"""

    child = subprocess.Popen([sys.executable, "-c", "pass"])
    pid = child.pid
    child.wait(timeout=10)
    return pid


def run_cli(argv: list[str], records_root: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "forgeloop", *argv, "--records-root", str(records_root)],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        check=False,
    )


def seed_task(tmp_path: Path) -> None:
    register_project(tmp_path)
    store = record_store(tmp_path)
    try:
        store.create_task(TASK_ID, PROJECT, "输入", {"project_path": str(tmp_path)}, 7200.0)
    finally:
        store.close()


def seed_delivery_slot(tmp_path: Path, *, pid: int | None = None, legacy: bool = False) -> None:
    store = record_store(tmp_path)
    try:
        slot_key = project_delivery_slot(PROJECT)
        if legacy:
            store.actions.begin(f"{SLOT_PREFIX}{slot_key}", "execution_slot", role=PROJECT)
        else:
            store.actions.claim_slot(slot_key, owner=PROJECT, pid=pid)
    finally:
        store.close()


def read_slot_state(tmp_path: Path) -> tuple[bool, int]:
    store = record_store(tmp_path)
    try:
        slot_key = project_delivery_slot(PROJECT)
        return (
            store.actions.slot_owner(slot_key) is not None,
            len(store.actions.cleanup_history(slot_key)),
        )
    finally:
        store.close()


class TestDeadDeliveryResidue:
    def test_merge_cleans_dead_residue_and_continues(self, tmp_path: Path, exited_pid: int) -> None:
        seed_task(tmp_path)
        seed_delivery_slot(tmp_path, pid=exited_pid)

        result = run_cli(["merge", TASK_ID, "--no-push", "--delivery-timeout", "0"], tmp_path)

        # 无交付记录使归并如实失败，但槽位已被真实子进程自动清理并留档。
        assert result.returncode == 1
        assert "已自动清理已死残留交付槽位" in result.stderr
        assert "任务尚无交付记录" in result.stderr
        occupied, history = read_slot_state(tmp_path)
        assert not occupied
        assert history == 1

        # 另一个新进程核对现场：没有遗留槽位。
        listed = run_cli(["requirement", "slot", "list"], tmp_path)
        assert listed.returncode == 0, listed.stderr
        assert "没有未完成的执行槽位" in listed.stdout


class TestLiveDeliveryResidue:
    def test_release_keeps_slot_and_reports_live_occupant(self, tmp_path: Path) -> None:
        seed_task(tmp_path)
        # 占用者就是本测试进程：在 CLI 子进程运行期间始终存活。
        seed_delivery_slot(tmp_path, pid=os.getpid())

        result = run_cli(
            ["release", TASK_ID, "--tag", "v0.0.1", "--no-push", "--delivery-timeout", "0"],
            tmp_path,
        )

        assert result.returncode == 1
        assert "同项目交付" in result.stderr
        assert "仍存活" in result.stderr
        occupied, history = read_slot_state(tmp_path)
        assert occupied
        assert history == 0


class TestUncertainDeliveryResidue:
    def test_merge_keeps_slot_and_reports_missing_identity(self, tmp_path: Path) -> None:
        seed_task(tmp_path)
        seed_delivery_slot(tmp_path, legacy=True)

        result = run_cli(["merge", TASK_ID, "--no-push", "--delivery-timeout", "0"], tmp_path)

        assert result.returncode == 1
        assert "同项目交付" in result.stderr
        assert "缺少进程身份" in result.stderr
        occupied, history = read_slot_state(tmp_path)
        assert occupied
        assert history == 0
