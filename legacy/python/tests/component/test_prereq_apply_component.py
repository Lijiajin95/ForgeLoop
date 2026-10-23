"""组件测试：dev 节点在进入实现前把前置候选真正落到下游副本。

这里不直接调用 ``apply_prerequisite_candidates``，而是走 ``make_dev_node`` 的
真实接线：任务记录库（真实 SQLite）、真实 git 工作副本、真实 PI 子进程替身。
验证「克隆副本后、进入实现前」这一步确实发生，且阻塞时不放行实现。

覆盖：
- 应用成功后，下游副本的**实际文件内容**是前置产物内容，且现场记录逐条给出
  标识/校验值/结果；
- 校验值不符或产物缺失时，dev 节点返回 ``prerequisite_blocked`` 并置任务为
  ``blocked``，不写任何前置代码、不启动 PI 实现会话。
"""

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import collect_candidate_change, prepare_workspace
from forgeloop.domain.delivery import sha256_of_text
from forgeloop.graph.nodes import NodeContext, make_dev_node, make_plan_node
from forgeloop.graph.requirements import (
    PREREQUISITE_RECORD_NAME,
    PrerequisiteApplyStatus,
    PrerequisiteCandidate,
)
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.component

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**GIT_ENV, "HOME": str(path.parent)},
    )
    return result.stdout


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def make_candidate(
    tmp_path: Path, source: Path, task_id: str, filename: str, content: str
) -> PrerequisiteCandidate:
    work = tmp_path / f"prereq-{task_id}"
    prepare_workspace(source, "", work)
    (work / filename).write_text(content, encoding="utf-8")
    change = collect_candidate_change(work)
    diff_path = tmp_path / f"{task_id}.diff"
    diff_path.write_text(change.diff, encoding="utf-8")
    return PrerequisiteCandidate(task_id, sha256_of_text(change.diff), diff_path)


def records_root(tmp_path: Path) -> Path:
    root = tmp_path / "records"
    root.mkdir(parents=True, exist_ok=True)
    return root


def task_context(
    root: Path, source: Path, task_id: str, candidates: tuple[PrerequisiteCandidate, ...]
) -> tuple[RecordStore, NodeContext]:
    store = RecordStore(root / "records.sqlite")
    config = {
        "pi_command": json.dumps(FAKE_PI),
        "test_command": json.dumps(["true"]),
        "goal": "实现下游任务",
        "scope": "src/forgeloop/downstream.py",
        "acceptance": "下游实现基于前置产物",
        "project_path": str(source),
        "baseline": "",
    }
    store.create_task(task_id, "forgeloop", "原始输入", config, limit_seconds=120.0)
    ctx = NodeContext.for_task(store, root, task_id)
    make_plan_node(ctx)({"task_id": task_id})
    return store, replace(ctx, prerequisites=candidates)


class TestDevNodeAppliesPrerequisites:
    def test_downstream_workspace_contains_prerequisite_content(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = records_root(tmp_path)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        store, ctx = task_context(root, source, "task-downstream", (candidate,))

        try:
            result = make_dev_node(ctx)({"task_id": "task-downstream"})
        finally:
            store.close()

        assert "halted_reason" not in result
        # 真实读取副本内文件内容：前置代码确实进入了实现现场。
        assert (ctx.workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"
        record = json.loads((ctx.task_dir / PREREQUISITE_RECORD_NAME).read_text(encoding="utf-8"))
        assert record["blocked_reason"] == ""
        assert record["applications"][0]["task_id"] == "alpha"
        assert record["applications"][0]["candidate_sha256"] == candidate.candidate_sha256
        assert record["applications"][0]["status"] == PrerequisiteApplyStatus.APPLIED.value

    def test_prerequisite_is_in_downstream_candidate_diff(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """下游候选 diff 相对基线采集，已带上前置改动——不再是「重做一遍」。"""

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = records_root(tmp_path)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        store, ctx = task_context(root, source, "task-downstream-diff", (candidate,))

        try:
            make_dev_node(ctx)({"task_id": "task-downstream-diff"})
        finally:
            store.close()

        candidate_diff = (ctx.task_dir / "candidate.diff").read_text(encoding="utf-8")
        assert "alpha.txt" in candidate_diff
        assert "+alpha-content" in candidate_diff


class TestDevNodeBlocksOnBadPrerequisite:
    def test_checksum_mismatch_blocks_before_pi_and_names_artifact(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = records_root(tmp_path)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        tampered = replace(candidate, candidate_sha256="b" * 64)
        store, ctx = task_context(root, source, "task-blocked", (tampered,))

        try:
            result = make_dev_node(ctx)({"task_id": "task-blocked"})
            task = store.get_task("task-blocked")
        finally:
            store.close()

        assert task is not None
        assert str(result["halted_reason"]).startswith("prerequisite_blocked:")
        # 区域信息同时点名具体产物与原因，不能只给出笼统的「被阻塞」。
        assert "alpha" in str(result["halted_reason"])
        assert "校验值不符" in str(result["halted_reason"])
        assert task.status == "blocked"
        # 不写任何前置代码，也不因 PI 会话而改动副本。
        assert not (ctx.workspace / "alpha.txt").exists()
        assert (ctx.workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(ctx.workspace, "status", "--porcelain").strip() == ""

    def test_missing_candidate_blocks_before_pi(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        root = records_root(tmp_path)
        ghost = PrerequisiteCandidate("ghost", "a" * 64, tmp_path / "ghost.diff")
        store, ctx = task_context(root, source, "task-missing", (ghost,))

        try:
            result = make_dev_node(ctx)({"task_id": "task-missing"})
            task = store.get_task("task-missing")
        finally:
            store.close()

        assert task is not None
        assert "prerequisite_blocked" in str(result["halted_reason"])
        assert "ghost" in str(result["halted_reason"])
        assert task.status == "blocked"
        assert not (ctx.task_dir / "candidate.diff").exists()
