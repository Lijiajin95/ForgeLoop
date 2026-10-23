"""集成测试：前置候选应用在真实工作副本、真实 SQLite 与真实图运行上的闭环。

与单元/组件测试的区别：这里让 ``RequirementTaskRunner`` 真的走一遍单任务业务图
（LangGraph 检查点 + 真实 git 工作副本 + 真实 SQLite 记录 + 真实 PI 子进程替身），
验证下游任务副本在实现前确实带上已完成前置的代码；另在真实 SQLite 记录库与真实
工作副本上验证重复启动幂等与失败回退，且失败跨连接可查。
"""

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.types import Command

from forgeloop.adapter.git_workspace import (
    applied_prerequisites,
    collect_candidate_change,
    prepare_workspace,
)
from forgeloop.domain.delivery import sha256_of_text
from forgeloop.domain.task_plan import PlannedTask
from forgeloop.graph.builder import (
    RequirementTaskRunner,
    build_graph,
    requirement_task_id,
)
from forgeloop.graph.nodes import NodeContext
from forgeloop.graph.requirements import (
    PREREQUISITE_RECORD_NAME,
    PrerequisiteApplyStatus,
    PrerequisiteCandidate,
    TaskExecution,
    TaskRunState,
    apply_prerequisite_candidates,
)
from forgeloop.records.requirements import TaskArtifact
from forgeloop.records.store import RecordStore

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = (sys.executable, str(FIXTURES / "fake_pi.py"))
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


def wiring(
    root: Path,
    source: Path,
    task_id: str,
    candidate: PrerequisiteCandidate,
) -> tuple[TaskExecution, RequirementTaskRunner]:
    """把前置候选落到记录现场，并返回下游执行请求与真实运行入口。"""

    req_id = "req-it-prereq"
    plan_version = 1
    upstream = requirement_task_id(req_id, plan_version, candidate.task_id)
    candidate_path = root / upstream / "candidate.diff"
    candidate_path.parent.mkdir(parents=True, exist_ok=True)
    candidate_path.write_text(candidate.diff_path.read_text(encoding="utf-8"), encoding="utf-8")
    artifact = TaskArtifact(
        task_id=candidate.task_id,
        candidate_sha256=candidate.candidate_sha256,
        test_evidence_sha256="t" * 64,
        review_sha256="r" * 64,
        acceptance="accepted",
        authorization_source="plan-approval:v1:owner",
    )
    planned = PlannedTask(
        task_id=task_id,
        goal="实现下游任务",
        files=("alpha.txt",),
        acceptance="下游基于前置产物实现",
        test_command=("true",),
        depends_on=(candidate.task_id,),
    )
    execution = TaskExecution(task=planned, dependencies=(artifact,))
    runner = RequirementTaskRunner(
        records_root=root,
        req_id=req_id,
        plan_version=plan_version,
        project="forgeloop",
        pi_command=FAKE_PI,
        project_path=str(source),
        baseline="",
    )
    return execution, runner


def park_downstream_before_dev(
    root: Path,
    runner: RequirementTaskRunner,
    task: PlannedTask,
) -> str:
    """把下游任务图停到 ``dev`` 之前，等价于进程在实现前被中断的现场。

    用真实业务图与真实 LangGraph 检查点复现可续跑现场：首轮走完 ``plan`` 与方案
    批准门后以 ``interrupt_before=['dev']`` 落下 ``next=('dev',)``；若任务已停在
    验收门，则以显式 ``Command`` 恢复该人工门（等价所有者拒绝本轮验收）、路由回
    ``dev`` 并再次在 ``dev`` 前停下。这样后续每次 ``RequirementTaskRunner`` 调用都
    真正重入 ``dev``/前置应用路径，而不是仅凭 ``resume`` 标志空转。
    """

    task_id = requirement_task_id(runner.req_id, runner.plan_version, task.task_id)
    store = RecordStore(root / "records.sqlite")
    graph = None
    try:
        if store.get_task(task_id) is None:
            store.create_task(
                task_id, runner.project, task.goal, runner._config(task), task.limits.limit_seconds
            )
        context = NodeContext.for_task(store, root, task_id)
        graph = build_graph(context, root / "checkpoints.sqlite")
        config: RunnableConfig = {"configurable": {"thread_id": task_id}}
        snapshot = graph.get_state(config)
        if not snapshot.next:
            graph.invoke({"task_id": task_id}, config)
            snapshot = graph.get_state(config)
        waiting = {str(name) for name in (snapshot.next or ())}
        if "gate_plan_approval" in waiting:
            runner._approve_plan(store, task_id)
            graph.invoke(
                Command(resume={"decision": "approved"}),
                config,
                interrupt_before=["dev"],
            )
        elif "gate_acceptance" in waiting:
            # 验收门是 ``interrupt()``：以显式 Command 恢复（等价所有者拒绝本轮
            # 交付，图按正式候选轮次路由回 dev），再在 dev 前停下。
            graph.invoke(
                Command(resume={"decision": "rejected"}),
                config,
                interrupt_before=["dev"],
            )
        snapshot = graph.get_state(config)
        assert set(snapshot.next) == {"dev"}, snapshot.next
    finally:
        if graph is not None:
            conn = getattr(graph.checkpointer, "conn", None)
            if conn is not None:
                conn.close()
        store.close()
    return task_id


class TestRunnerRealGraphAppliesPrerequisite:
    def test_downstream_workspace_has_prerequisite_after_real_graph_run(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = tmp_path / "records"
        root.mkdir()
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-real\n")
        execution, runner = wiring(root, source, "beta", candidate)

        result = runner(execution)

        task_id = requirement_task_id("req-it-prereq", 1, "beta")
        workspace = root / task_id / "workspace"
        # 真实读取下游副本内容：前置代码确实在实现现场，而不是只在提示词里。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-real\n"
        record = json.loads((root / task_id / PREREQUISITE_RECORD_NAME).read_text(encoding="utf-8"))
        assert record["applications"][0]["status"] == PrerequisiteApplyStatus.APPLIED.value
        # 图停在整体验收门，等待所有者决定。
        assert result.state is TaskRunState.AWAITING_USER

    def test_repeated_requirement_startup_reenters_dev_and_keeps_copy_unchanged(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """同一需求内重复启动：每次真的重入 dev，第二次不再改动副本与变更集合。

        第二次启动前把真实图重新停到 ``dev`` 之前，保证 ``RequirementTaskRunner``
        第二次调用会 ``graph.invoke(None)`` 真正执行 dev 节点、再次走前置应用路径；
        对副本内容与 ``git status`` 变更集合的相等断言因此不是空转。
        """

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = tmp_path / "records"
        root.mkdir()
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-real\n")
        execution, runner = wiring(root, source, "beta-repeat", candidate)
        task = execution.task
        resume_first = replace(execution, resume=True)

        park_downstream_before_dev(root, runner, task)
        first = runner(resume_first)
        task_id = requirement_task_id("req-it-prereq", 1, "beta-repeat")
        workspace = root / task_id / "workspace"
        record_path = root / task_id / PREREQUISITE_RECORD_NAME
        assert first.state is TaskRunState.AWAITING_USER
        # 首次确实进入 dev：前置文件真的落到副本，记录为 applied。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-real\n"
        first_status = git(workspace, "status", "--porcelain")
        first_record = json.loads(record_path.read_text(encoding="utf-8"))
        assert first_record["applications"][0]["status"] == PrerequisiteApplyStatus.APPLIED.value

        # 第二次启动前重新停到 dev，确保第二次调用真的重入 dev/应用路径。
        park_downstream_before_dev(root, runner, task)
        second = runner(resume_first)

        assert second.state is TaskRunState.AWAITING_USER
        # 第二次真的重入 dev：动作历史里 dev 完成两次（而非直接进 _pending）。
        store = RecordStore(root / "records.sqlite")
        try:
            dev_runs = [
                action
                for action in store.actions.history(task_id)
                if action.node == "dev" and action.state.value == "completed"
            ]
        finally:
            store.close()
        assert len(dev_runs) == 2
        second_record = json.loads(record_path.read_text(encoding="utf-8"))
        # 第二次真的再次应用了同一前置，但按记录+现场证据幂等跳过（already_applied）。
        assert (
            second_record["applications"][0]["status"]
            == PrerequisiteApplyStatus.ALREADY_APPLIED.value
        )
        # 副本内容与变更集合一字不差：不重复应用、不回退、不留下新的半成品。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-real\n"
        assert git(workspace, "status", "--porcelain") == first_status

    def test_checksum_mismatch_blocks_real_graph_and_keeps_workspace_clean(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        source = make_source_repo(tmp_path)
        root = tmp_path / "records"
        root.mkdir()
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-real\n")
        execution, runner = wiring(root, source, "beta", candidate)
        tampered = replace(execution.dependencies[0], candidate_sha256="b" * 64)
        execution = replace(execution, dependencies=(tampered,))

        result = runner(execution)

        task_id = requirement_task_id("req-it-prereq", 1, "beta")
        workspace = root / task_id / "workspace"
        assert result.state is TaskRunState.FAILED
        assert "prerequisite_blocked" in result.reason
        # 原因里同时点名具体产物与原因，事后的错误信息足够定位。
        assert "alpha" in result.reason
        assert "校验值不符" in result.reason
        assert not (workspace / "alpha.txt").exists()
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(workspace, "status", "--porcelain").strip() == ""


class TestRecordBackedIdempotenceOnRealBoundaries:
    def test_repeat_startup_is_idempotent_and_content_stable(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "downstream" / "workspace"
        prepare_workspace(source, "", workspace)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        root = tmp_path / "records"
        root.mkdir()
        store = RecordStore(root / "records.sqlite")
        record_path = root / "task-downstream" / PREREQUISITE_RECORD_NAME
        try:
            first = apply_prerequisite_candidates(workspace, [candidate], record_path)
            first_status = git(workspace, "status", "--porcelain")
            second = apply_prerequisite_candidates(workspace, [candidate], record_path)
            recorded = store.outcomes.prerequisite_applications("task-downstream")
        finally:
            store.close()

        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha\n"
        assert git(workspace, "status", "--porcelain") == first_status
        assert recorded["alpha"][1] == "already_applied"

    def test_record_alone_does_not_skip_a_fresh_clone(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        root = tmp_path / "records"
        root.mkdir()
        store = RecordStore(root / "records.sqlite")
        record_path = root / "task-downstream" / PREREQUISITE_RECORD_NAME
        try:
            first_workspace = tmp_path / "first" / "workspace"
            prepare_workspace(source, "", first_workspace)
            apply_prerequisite_candidates(first_workspace, [candidate], record_path)

            # 副本被重新克隆 / 回退后只有记录、没有现场证据：必须真正重新应用。
            fresh_workspace = tmp_path / "fresh" / "workspace"
            prepare_workspace(source, "", fresh_workspace)
            assert applied_prerequisites(fresh_workspace) == frozenset()
            report = apply_prerequisite_candidates(fresh_workspace, [candidate], record_path)
        finally:
            store.close()

        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (fresh_workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha\n"


class TestFailureRollsBackToCleanCopyWithRecord:
    def test_failed_apply_rolls_back_and_failure_is_recorded(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "downstream" / "workspace"
        prepare_workspace(source, "", workspace)
        baseline = git(workspace, "rev-parse", "HEAD").strip()
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken_diff = (
            "diff --git a/base.txt b/base.txt\n"
            "--- a/base.txt\n"
            "+++ b/base.txt\n"
            "@@ -1 +1 @@\n"
            "-content-that-does-not-exist\n"
            "+broken\n"
        )
        broken_path = tmp_path / "broken.diff"
        broken_path.write_text(broken_diff, encoding="utf-8")
        broken = PrerequisiteCandidate("broken", sha256_of_text(broken_diff), broken_path)
        root = tmp_path / "records"
        root.mkdir()
        store = RecordStore(root / "records.sqlite")
        record_path = root / "task-downstream" / PREREQUISITE_RECORD_NAME
        try:
            report = apply_prerequisite_candidates(workspace, [good, broken], record_path)
            recorded = store.outcomes.prerequisite_applications("task-downstream")
        finally:
            store.close()

        assert report.blocked
        # 回退到干净副本：与需求基线一致，不留半成品。
        assert git(workspace, "rev-parse", "HEAD").strip() == baseline
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""
        assert applied_prerequisites(workspace) == frozenset()
        assert recorded["good"][1] == "failed"
        assert recorded["broken"][1] == "failed"
        document = json.loads(record_path.read_text(encoding="utf-8"))
        assert document["blocked_reason"]
