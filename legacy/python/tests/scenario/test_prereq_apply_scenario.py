"""场景测试：需求推进把已完成前置的候选改动真实落到下游副本。

与 ``tests/integration`` 的区别：集成用例走单任务业务图与真实 LangGraph 检查点；
本文件的执行器是确定性的 ``WorkspaceRunner`` 替身，直接用真实记录层
（``RequirementStore``）与真实 git 工作副本、真实 ``apply_prerequisite_candidates``
驱动多步业务闭环，验证：

- 需求推进器按依赖把上游交付产物交给下游，下游副本的真实文件内容带上上游代码；
- 下游候选 diff 相对基线采集，已包含由前置带入的改动（不是「重做一遍」）；
- 同一启动路径重复执行时按权威记录 + 现场证据幂等跳过，不重复改动；
- 校验值不符时整体阻塞、点名具体产物，且副本保持干净（fail-closed）；
- 菱形依赖下被其他直接依赖传递包含的祖先标记为跳过，不重复应用其改动。

断言读取副本内真实文件内容，不依赖 fixture 伪装结论。
"""

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.adapter.git_workspace import collect_candidate_change, prepare_workspace
from forgeloop.domain.delivery import sha256_of_text
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.requirements import (
    PREREQUISITE_RECORD_NAME,
    PrerequisiteApplyStatus,
    PrerequisiteCandidate,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
    TaskRunState,
    apply_prerequisite_candidates,
)
from forgeloop.records.requirements import RequirementStore, TaskArtifact

pytestmark = pytest.mark.scenario

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "HOME": "/tmp",
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
    """真实 git 基线仓库：下游副本克隆自它，且不共享可写对象。"""

    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def planned(task_id: str, *, depends_on: tuple[str, ...] = ()) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"实现 {task_id}",
        files=(f"src/forgeloop/{task_id}.py",),
        acceptance=f"{task_id} 的验收标准",
        test_command=("true",),
        depends_on=depends_on,
    )


def approved_scene(tmp_path: Path, tasks: tuple[PlannedTask, ...]) -> tuple[RequirementStore, str]:
    """真实记录层：提交需求、记录任务包并取得所有者批准。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：前置改动真实进入下游副本")
    plan = TaskPlan(
        task_plan_id=f"plan-{requirement.req_id}-1",
        requirement_id=requirement.req_id,
        project=requirement.project,
        plan_version=1,
        requirement_version=requirement.version_count,
        tasks=tasks,
        created_at=WHEN,
    )
    store.record_task_plan(requirement.req_id, plan)
    store.record_plan_approval(requirement.req_id, 1, "owner", source="batch-prereq")
    return store, requirement.req_id


class WorkspaceRunner:
    """确定性执行器：真实建副本、真实应用前置、真实采集候选 diff。

    每个任务独立一个工作副本；上游交付的候选 diff 出现在 ``<root>/<task>/candidate.diff``，
    下游按 ``TaskExecution.dependencies`` 逐条核对校验值后应用。该替身不经过单任务
    LangGraph，因此能把「需求推进 → 前置应用 → 候选采集」这条业务链单独论证。
    """

    def __init__(
        self,
        source: Path,
        root: Path,
        files: dict[str, str],
        *,
        tamper: dict[str, str] | None = None,
    ) -> None:
        self._source = source
        self._root = root
        self._files = files
        self._tamper = tamper or {}
        self._diff_paths: dict[str, Path] = {}
        self.calls: list[TaskExecution] = []

    def __call__(self, execution: TaskExecution) -> TaskResult:
        self.calls.append(execution)
        task_id = execution.task.task_id
        workspace = self._root / task_id / "workspace"
        prepare_workspace(self._source, "", workspace)
        covered = set(execution.covered_dependencies)
        # tamper 只作用于「作为前置被下游读取」的产物身份，不改写本任务交付的候选身份。
        candidates = tuple(
            PrerequisiteCandidate(
                artifact.task_id,
                self._tamper.get(artifact.task_id, artifact.candidate_sha256),
                self._diff_paths[artifact.task_id],
                covered=artifact.task_id in covered,
            )
            for artifact in execution.dependencies
        )
        report = apply_prerequisite_candidates(
            workspace, candidates, self._root / task_id / PREREQUISITE_RECORD_NAME
        )
        if report.blocked:
            return TaskResult(
                TaskRunState.FAILED, reason=f"prerequisite_blocked: {report.blocked_reason}"
            )
        (workspace / self._files[task_id]).write_text(f"{task_id}-body\n", encoding="utf-8")
        change = collect_candidate_change(workspace)
        candidate_path = self._root / task_id / "candidate.diff"
        candidate_path.write_text(change.diff, encoding="utf-8")
        self._diff_paths[task_id] = candidate_path
        artifact = TaskArtifact(
            task_id=task_id,
            candidate_sha256=sha256_of_text(change.diff),
            test_evidence_sha256="t" * 64,
            review_sha256="r" * 64,
            acceptance="accepted",
            authorization_source="plan-approval:req:v1:owner",
        )
        return TaskResult(TaskRunState.DELIVERED, artifact)


def read_record(root: Path, task_id: str) -> dict:
    return json.loads((root / task_id / PREREQUISITE_RECORD_NAME).read_text(encoding="utf-8"))


def status_of(root: Path, task_id: str, upstream: str) -> str:
    for entry in read_record(root, task_id)["applications"]:
        if entry["task_id"] == upstream:
            return entry["status"]
    raise AssertionError(f"no application record for {upstream}")


class TestPrerequisiteReachesDownstreamCopy:
    def test_downstream_copy_contains_upstream_file_and_own_file(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        store, req_id = approved_scene(
            tmp_path, (planned("alpha"), planned("beta", depends_on=("alpha",)))
        )
        runner = WorkspaceRunner(source, tmp_path, {"alpha": "alpha.txt", "beta": "beta.txt"})
        try:
            progress = RequirementExecutor(store, req_id, runner).advance()
        finally:
            store.close()

        assert progress.completed_tasks == ("alpha", "beta")
        beta_workspace = tmp_path / "beta" / "workspace"
        # 真实读取副本文件：上游代码随前置应用进入下游实现现场。
        assert (beta_workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-body\n"
        assert (beta_workspace / "beta.txt").read_text(encoding="utf-8") == "beta-body\n"
        assert status_of(tmp_path, "beta", "alpha") == PrerequisiteApplyStatus.APPLIED.value

    def test_downstream_candidate_diff_contains_upstream_change(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        store, req_id = approved_scene(
            tmp_path, (planned("alpha"), planned("beta", depends_on=("alpha",)))
        )
        runner = WorkspaceRunner(source, tmp_path, {"alpha": "alpha.txt", "beta": "beta.txt"})
        try:
            RequirementExecutor(store, req_id, runner).advance()
        finally:
            store.close()

        beta_diff = (tmp_path / "beta" / "candidate.diff").read_text(encoding="utf-8")
        assert "alpha.txt" in beta_diff
        assert "+alpha-body" in beta_diff


class TestScenarioIdempotence:
    def test_second_application_skips_and_keeps_copy_unchanged(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        store, req_id = approved_scene(
            tmp_path, (planned("alpha"), planned("beta", depends_on=("alpha",)))
        )
        runner = WorkspaceRunner(source, tmp_path, {"alpha": "alpha.txt", "beta": "beta.txt"})
        try:
            RequirementExecutor(store, req_id, runner).advance()
        finally:
            store.close()

        beta_workspace = tmp_path / "beta" / "workspace"
        first_status = git(beta_workspace, "status", "--porcelain")

        # 同一执行请求再跑一次：权威记录 + 现场证据确认已应用，按幂等跳过。
        downstream = runner.calls[-1]
        result = runner(downstream)

        assert result.state is TaskRunState.DELIVERED
        assert status_of(tmp_path, "beta", "alpha") == PrerequisiteApplyStatus.ALREADY_APPLIED.value
        assert (beta_workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-body\n"
        assert git(beta_workspace, "status", "--porcelain") == first_status


class TestScenarioFailClosed:
    def test_checksum_mismatch_blocks_and_names_artifact(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        store, req_id = approved_scene(
            tmp_path, (planned("alpha"), planned("beta", depends_on=("alpha",)))
        )
        # alpha 正常交付；beta 读取 alpha 产物时记录校验值被篡改，模拟记录与现场不符。
        runner = WorkspaceRunner(
            source,
            tmp_path,
            {"alpha": "alpha.txt", "beta": "beta.txt"},
            tamper={"alpha": "b" * 64},
        )
        try:
            progress = RequirementExecutor(store, req_id, runner).advance()
        finally:
            store.close()

        # 下游在写任何代码前阻塞：先交付了 alpha，beta 未启动成功。
        assert progress.completed_tasks == ("alpha",)
        assert progress.current_task == "beta"
        assert progress.blocked_reason.startswith("prerequisite_blocked")
        # 点名具体产物与原因，人工据此定位。
        assert "alpha" in progress.blocked_reason
        assert "校验值不符" in progress.blocked_reason
        beta_workspace = tmp_path / "beta" / "workspace"
        assert not (beta_workspace / "alpha.txt").exists()
        assert not (beta_workspace / "beta.txt").exists()
        assert (beta_workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(beta_workspace, "status", "--porcelain").strip() == ""

    def test_missing_candidate_blocks_without_writing_code(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "beta" / "workspace"
        prepare_workspace(source, "", workspace)
        ghost = PrerequisiteCandidate("ghost", "a" * 64, tmp_path / "ghost.diff")

        report = apply_prerequisite_candidates(
            workspace, [ghost], tmp_path / "beta" / PREREQUISITE_RECORD_NAME
        )

        assert report.blocked
        assert "ghost" in report.blocked_reason
        assert not (workspace / "alpha.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""


class TestDiamondDependency:
    def test_covered_ancestor_is_skipped_while_other_candidates_apply(self, tmp_path: Path) -> None:
        """菱形依赖的 tip 直接依赖 root/left/right；root 被传递包含，不单独应用。"""

        source = make_source_repo(tmp_path)
        tasks = (
            planned("root"),
            planned("left", depends_on=("root",)),
            planned("right", depends_on=("root",)),
            planned("tip", depends_on=("root", "left", "right")),
        )
        store, req_id = approved_scene(tmp_path, tasks)
        runner = WorkspaceRunner(
            source,
            tmp_path,
            {"root": "root.txt", "left": "left.txt", "right": "right.txt", "tip": "tip.txt"},
        )
        try:
            progress = RequirementExecutor(store, req_id, runner).advance()
        finally:
            store.close()

        assert progress.completed_tasks == ("root", "left", "right", "tip")
        tip_workspace = tmp_path / "tip" / "workspace"
        # 全部祖先与自身改动都在：root 经由 left/right 带入，不需要单独 apply。
        for name in ("root.txt", "left.txt", "right.txt", "tip.txt"):
            assert (tip_workspace / name).exists(), name
        # 被覆盖的祖先如实记录为 skipped，其余候选成功应用（或经三方合并补齐）。
        assert status_of(tmp_path, "tip", "root") == PrerequisiteApplyStatus.SKIPPED.value
        for upstream in ("left", "right"):
            assert status_of(tmp_path, "tip", upstream) in (
                PrerequisiteApplyStatus.APPLIED.value,
                PrerequisiteApplyStatus.ALREADY_APPLIED.value,
            )
        tip_call = runner.calls[-1]
        assert tip_call.covered_dependencies == ("root",)
