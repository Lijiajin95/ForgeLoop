"""A03 需求规划场景：分析 → 任务包 → 批准绑定 → 不执行与旧批准失效。

用自带的假 PI（讲 PI JSONL RPC 协议）驱动 ``graph.planning`` 的分析与规划：
- 就绪分析生成可批准任务包：至少两个有意义且有依赖的任务；
- 规划成功只是 ``plan_proposed``，没有批准就不执行；
- 批准绑定需求身份与任务包版本，并写入任务级授权来源；
- 新任务包版本出现后，旧版本批准不能驱动它；
- 需求文本追加或 PI 畸形时如实阻塞，且不生成任务包；
- 规划阶段不接触被测项目源码。

不经过 CLI：A03 的文件范围不含 CLI 入口，入口接线属于 I01。
"""

import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from forgeloop.domain.requirement import BLOCKED, DRAFT, RequirementNotFoundError
from forgeloop.domain.task_plan import (
    APPROVED,
    PLAN_PROPOSED,
    PlanAuthorizationStatus,
    TaskPlanError,
    TaskPlanNotFoundError,
)
from forgeloop.graph.planning import PlanningContext, analyze_requirement, plan_requirement
from forgeloop.records.requirements import RequirementStore

READY_RESULT = {
    "goal": "status 输出下一步动作",
    "scenarios": ["完成任务后查看状态", "阻塞时查看原因"],
    "acceptance_criteria": ["status --json 含 next_action 与 blocker"],
    "clarifications": [],
}

PLAN_RESULT = {
    "tasks": [
        {
            "task_id": "status-field",
            "goal": "为 status 增加 next_action 字段",
            "files": ["src/forgeloop/domain/status.py"],
            "acceptance": "未知状态映射到人工核对",
            "test_command": ["uv", "run", "pytest", "tests/unit/test_status.py", "-q"],
            "depends_on": [],
        },
        {
            "task_id": "status-contract",
            "goal": "把字段接入 status --json 契约",
            "files": ["contracts/cli-contract.json"],
            "acceptance": "契约快照与实现一致",
            "test_command": ["uv", "run", "pytest", "tests/unit/test_status.py", "-q"],
            "depends_on": ["status-field"],
        },
    ]
}

PLANNING_PI = r"""
import json
import os
import sys


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(request, success=True, data=None):
    record = {
        "id": request.get("id"),
        "type": "response",
        "command": request.get("type"),
        "success": success,
    }
    if data is not None:
        record["data"] = data
    emit(record)


cwd_log = os.environ.get("FAKE_PLANNING_CWD_LOG")
mode = os.environ.get("FAKE_PLANNING_MODE", "payload")
result = os.environ.get("FAKE_PLANNING_RESULT", "")
text = ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "prompt":
        if cwd_log:
            with open(cwd_log, "a", encoding="utf-8") as handle:
                handle.write(os.getcwd() + "\n")
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        if mode == "unsettled":
            emit({"type": "agent_end", "messages": [], "willRetry": False})
            sys.exit(0)
        if mode == "aborted":
            emit({"type": "agent_end", "messages": [], "willRetry": False})
            emit({"type": "agent_settled", "aborted": True})
            text = result
            continue
        if mode == "model-error":
            emit(
                {
                    "type": "agent_end",
                    "messages": [
                        {
                            "role": "assistant",
                            "stopReason": "error",
                            "errorMessage": "403 subscription",
                        }
                    ],
                    "willRetry": False,
                }
            )
            emit({"type": "agent_settled", "aborted": False})
            text = ""
            continue
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
        if mode == "plain-text":
            text = "这是自然语言任务拆分，没有 JSON 结构。"
        elif mode == "malformed":
            text = json.dumps({"summary": "缺少 tasks"}, ensure_ascii=False)
        elif mode == "single":
            data = json.loads(result)
            text = json.dumps({"tasks": data["tasks"][:1]}, ensure_ascii=False)
        else:
            text = result
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": "unknown command"})
"""


@dataclass
class Scene:
    store: RequirementStore
    req_id: str
    command: tuple[str, ...]
    analysis_dir: Path
    cwd_log: Path

    def context(self) -> PlanningContext:
        return PlanningContext(self.store, self.req_id, self.analysis_dir, self.command)


def make_scene(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: dict | None = None,
    mode: str = "payload",
    text: str = "原始需求：给 status 增加下一步动作",
) -> Scene:
    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", text)
    script = tmp_path / "planning_pi.py"
    script.write_text(PLANNING_PI, encoding="utf-8")
    cwd_log = tmp_path / "pi-cwd.log"
    monkeypatch.setenv("FAKE_PLANNING_MODE", mode)
    monkeypatch.setenv("FAKE_PLANNING_CWD_LOG", str(cwd_log))
    monkeypatch.setenv(
        "FAKE_PLANNING_RESULT", json.dumps(result if result is not None else {}, ensure_ascii=False)
    )
    analysis_dir = tmp_path / "requirements" / requirement.req_id / "planning"
    return Scene(
        store=store,
        req_id=requirement.req_id,
        command=(sys.executable, str(script)),
        analysis_dir=analysis_dir,
        cwd_log=cwd_log,
    )


def ready_scene(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Scene:
    """先跑一次就绪分析，返回可供规划使用的现场。"""

    scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
    analyze_requirement(scene.context())
    return scene


def plan_scene(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: dict | None = None,
    mode: str = "payload",
) -> Scene:
    scene = ready_scene(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_PLANNING_MODE", mode)
    monkeypatch.setenv(
        "FAKE_PLANNING_RESULT",
        json.dumps(result if result is not None else PLAN_RESULT, ensure_ascii=False),
    )
    return scene


class TestGenerateActionablePlan:
    def test_ready_analysis_yields_two_dependent_tasks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            outcome = plan_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            stored = scene.store.latest_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == PLAN_PROPOSED
        assert status == PLAN_PROPOSED
        assert outcome.is_ready is True
        assert outcome.plan is not None
        assert [task.task_id for task in outcome.plan.tasks] == ["status-field", "status-contract"]
        assert outcome.plan.tasks[1].depends_on == ("status-field",)
        assert outcome.plan.execution_order() == ("status-field", "status-contract")
        assert outcome.plan.task_plan_id == f"plan-{scene.req_id}-1"
        assert all(task.authorization_source == "" for task in outcome.plan.tasks)
        assert stored == outcome.plan

    def test_plan_survives_reopen(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        outcome = plan_requirement(scene.context())
        scene.store.close()

        reopened = RequirementStore(tmp_path / "records.sqlite")
        try:
            stored = reopened.latest_task_plan(scene.req_id)
        finally:
            reopened.close()

        assert stored is not None and stored == outcome.plan


class TestUnapprovedDoesNotExecute:
    def test_plan_without_approval_cannot_run(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            authorization = scene.store.plan_authorization(scene.req_id)
            assert scene.store.authorized_task_plan(scene.req_id) is None
            with pytest.raises(TaskPlanError, match="未获有效授权"):
                scene.store.task_authorization(scene.req_id, "status-field")
        finally:
            scene.store.close()

        assert authorization.status is PlanAuthorizationStatus.MISSING
        assert authorization.can_execute is False
        assert authorization.reason


class TestApprovalBinding:
    def test_approval_binds_requirement_version_and_task_source(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            approval = scene.store.record_plan_approval(
                scene.req_id, 1, "owner", source="batch-A03"
            )
            status = scene.store.requirement_status(scene.req_id)
            authorized = scene.store.authorized_task_plan(scene.req_id)
            source = scene.store.task_authorization(scene.req_id, "status-contract")
            stored_approval = scene.store.plan_approval(scene.req_id, 1)
        finally:
            scene.store.close()

        assert status == APPROVED
        assert approval.authorization_source == f"plan-approval:{scene.req_id}:v1:owner"
        assert source == approval.authorization_source
        assert authorized is not None
        assert all(task.authorization_source == source for task in authorized.tasks)
        assert stored_approval == approval

    def test_approval_requires_an_existing_plan_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            with pytest.raises(TaskPlanNotFoundError):
                scene.store.record_plan_approval(scene.req_id, 2, "owner")
        finally:
            scene.store.close()


class TestOldApprovalCannotDriveNewPlan:
    def test_new_plan_version_invalidates_previous_approval(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            first = plan_requirement(scene.context())
            assert first.plan is not None
            scene.store.record_plan_approval(scene.req_id, 1, "owner")

            second = plan_requirement(scene.context())
            assert second.plan is not None and second.plan.plan_version == 2
            authorization = scene.store.plan_authorization(scene.req_id)
            assert scene.store.authorized_task_plan(scene.req_id) is None
            with pytest.raises(TaskPlanError):
                scene.store.task_authorization(scene.req_id, "status-field")

            # 重新对当前版本取得批准后才恢复可执行。
            scene.store.record_plan_approval(scene.req_id, 2, "owner")
            refreshed = scene.store.authorized_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert authorization.status is PlanAuthorizationStatus.STALE
        assert authorization.approval is not None and authorization.approval.plan_version == 1
        assert refreshed is not None and refreshed.plan_version == 2

    def test_older_plan_version_cannot_be_approved_when_newer_exists(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """新版本存在时再批准旧版本必须被拒绝，不能留下“已批准”假象。

        复现审查阻断：先生成 v1、v2（同一需求版本），再对 v1 调用
        ``record_plan_approval`` 曾会成功，把逐步授权写入 v1 并把需求置
        ``approved``，而 ``plan_authorization`` / ``authorized_task_plan``
        只读最新 v2，返回 STALE/None（状态机与可执行授权不一致）。
        """

        scene = plan_scene(tmp_path, monkeypatch)
        try:
            first = plan_requirement(scene.context())
            second = plan_requirement(scene.context())
            assert first.plan is not None and first.plan.plan_version == 1
            assert second.plan is not None and second.plan.plan_version == 2

            with pytest.raises(TaskPlanError, match="最新"):
                scene.store.record_plan_approval(scene.req_id, 1, "owner")

            status = scene.store.requirement_status(scene.req_id)
            stale_approval = scene.store.plan_approval(scene.req_id, 1)
            authorization = scene.store.plan_authorization(scene.req_id)
            authorized = scene.store.authorized_task_plan(scene.req_id)
            stored_v1 = scene.store.task_plan(scene.req_id, 1)
            stored_v2 = scene.store.task_plan(scene.req_id, 2)
        finally:
            scene.store.close()

        assert status != APPROVED
        assert stale_approval is None
        assert authorization.status is PlanAuthorizationStatus.MISSING
        assert authorized is None
        # 关键：被拒绝的批准不得把授权来源写进旧任务包。
        assert all(task.authorization_source == "" for task in stored_v1.tasks)
        assert all(task.authorization_source == "" for task in stored_v2.tasks)

    def test_requirement_revision_invalidates_plan_and_approval(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            scene.store.record_plan_approval(scene.req_id, 1, "owner")
            assert scene.store.authorized_task_plan(scene.req_id) is not None

            scene.store.append(scene.req_id, "补充：next_action 还要给出责任人")
            authorization = scene.store.plan_authorization(scene.req_id)
            authorized = scene.store.authorized_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert authorization.status is PlanAuthorizationStatus.STALE
        assert "需求已修订" in authorization.reason
        assert authorized is None

    def test_stale_plan_cannot_be_approved_after_revision(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """需求修订后，旧任务包不能取得批准，也不能留下“已批准”假象。

        复现审查阻断：append 使任务包作废后仍可 record_plan_approval 并置
        ``approved``，但 authorized_task_plan 为 None（状态机与执行授权不一致）。
        """

        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            scene.store.append(scene.req_id, "补充：next_action 还要给出责任人")

            with pytest.raises(TaskPlanError, match="需求已修订"):
                scene.store.record_plan_approval(scene.req_id, 1, "owner")

            status = scene.store.requirement_status(scene.req_id)
            approval = scene.store.plan_approval(scene.req_id, 1)
            authorized = scene.store.authorized_task_plan(scene.req_id)
            stored = scene.store.latest_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert status != APPROVED
        assert approval is None
        assert authorized is None
        assert stored is not None
        assert all(task.authorization_source == "" for task in stored.tasks)


class TestPlanningRefusals:
    def test_planning_without_analysis_blocks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=PLAN_RESULT)
        try:
            outcome = plan_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            plan = scene.store.latest_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.plan is None and outcome.halted_reason == "analysis_missing"
        assert status == BLOCKED and plan is None

    @pytest.mark.parametrize(
        ("mode", "needle"),
        [
            ("malformed", "plan_malformed"),
            ("plain-text", "plan_malformed"),
            ("single", "两个任务"),
            ("unsettled", "planning_unsettled"),
            ("model-error", "planning_model_error"),
            ("aborted", "planning_aborted"),
        ],
    )
    def test_bad_planning_results_block_without_creating_plan(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, needle: str
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch, mode=mode)
        try:
            outcome = plan_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            reason = scene.store.blocked_reason(scene.req_id)
            plan = scene.store.latest_task_plan(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.plan is None
        assert needle in (outcome.halted_reason or "")
        assert status == BLOCKED and needle in reason
        assert plan is None

    def test_plan_without_dependency_is_blocked(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        independent = {
            "tasks": [
                {**PLAN_RESULT["tasks"][0], "depends_on": []},
                {**PLAN_RESULT["tasks"][1], "depends_on": []},
            ]
        }
        scene = plan_scene(tmp_path, monkeypatch, result=independent)
        try:
            outcome = plan_requirement(scene.context())
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert "依赖" in (outcome.halted_reason or "")

    def test_planning_stale_analysis_blocks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = ready_scene(tmp_path, monkeypatch)
        try:
            scene.store.append(scene.req_id, "补充材料让分析过期")
            outcome = plan_requirement(scene.context())
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.halted_reason == "analysis_stale"

    def test_planning_with_open_clarifications_blocks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result={
                "goal": "增加注释能力",
                "scenarios": [],
                "acceptance_criteria": [],
                "clarifications": ["注释保存到哪里?"],
            },
        )
        try:
            analyze_requirement(scene.context())
            outcome = plan_requirement(scene.context())
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.halted_reason == "analysis_needs_clarification"

    def test_cross_project_plan_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            plan_requirement(scene.context())
            plan = scene.store.latest_task_plan(scene.req_id)
            assert plan is not None
            with pytest.raises(TaskPlanError):
                scene.store.record_task_plan(
                    scene.req_id,
                    type(plan)(
                        plan.task_plan_id,
                        plan.requirement_id,
                        "AnotherProject",
                        plan.plan_version,
                        plan.requirement_version,
                        plan.tasks,
                        plan.created_at,
                    ),
                )
            # 另一个项目的身份也没有任何任务包可授权。
            other = scene.store.submit("AnotherProject", "另一个项目的需求")
            with pytest.raises(TaskPlanError):
                scene.store.task_authorization(other.req_id, "status-field")
        finally:
            scene.store.close()

    def test_duplicate_plan_version_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = plan_scene(tmp_path, monkeypatch)
        try:
            outcome = plan_requirement(scene.context())
            assert outcome.plan is not None
            with pytest.raises(TaskPlanError, match="已存在"):
                scene.store.record_task_plan(scene.req_id, outcome.plan)
        finally:
            scene.store.close()


class TestReadOnlyPlanning:
    def test_planning_does_not_touch_the_project_sources(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        project = tmp_path / "project"
        project.mkdir()
        (project / "app.py").write_text("print('baseline')\n", encoding="utf-8")
        before = {
            path.relative_to(project).as_posix(): path.read_bytes()
            for path in project.rglob("*")
            if path.is_file()
        }

        scene = plan_scene(tmp_path, monkeypatch)
        try:
            outcome = plan_requirement(scene.context())
        finally:
            scene.store.close()

        after = {
            path.relative_to(project).as_posix(): path.read_bytes()
            for path in project.rglob("*")
            if path.is_file()
        }
        assert outcome.requirement_status == PLAN_PROPOSED
        assert after == before
        assert (scene.analysis_dir / "sessions" / f"{scene.req_id}-analysis.events.jsonl").exists()
        assert (scene.analysis_dir / "sessions" / f"{scene.req_id}-planning.events.jsonl").exists()


class TestPlanningGuards:
    def test_unknown_requirement_fails_explicitly(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        script = tmp_path / "planning_pi.py"
        script.write_text(PLANNING_PI, encoding="utf-8")
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            context = PlanningContext(
                store, "req-unknown", tmp_path / "analysis", (sys.executable, str(script))
            )
            with pytest.raises(RequirementNotFoundError):
                plan_requirement(context)
        finally:
            store.close()

    def test_plan_scene_analysis_stays_draft_until_planned(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = ready_scene(tmp_path, monkeypatch)
        try:
            assert scene.store.requirement_status(scene.req_id) == DRAFT
        finally:
            scene.store.close()


# ---- 真实 PI 边界（显式加入：FORGELOOP_PI_LIVE=1，真实模型有成本）----
PI_LIVE = os.environ.get("FORGELOOP_PI_LIVE") == "1"
PI_BINARY = shutil.which("pi")
PI_PROVIDER = os.environ.get("FORGELOOP_PI_PROVIDER", "cc-switch-open-code-go")
PI_MODEL = os.environ.get("FORGELOOP_PI_MODEL", "deepseek-v4.1-flash")
REAL_PI_COMMAND = (
    "pi",
    "--mode",
    "rpc",
    "--no-session",
    "--no-tools",
    "--provider",
    PI_PROVIDER,
    "--model",
    PI_MODEL,
)
LIVE_REQUIRED = pytest.mark.skipif(
    PI_BINARY is None or not PI_LIVE,
    reason="requires the pi binary and FORGELOOP_PI_LIVE=1 (real model cost)",
)
PI_CONFIG_FILES = ("models.json", "models-store.json", "auth.json", "settings.json")
# 规格完全确定的真实需求：避免真实模型因信息不足而合理地只提出澄清问题，
# 从而让 live 用例真正走到规划阶段（信息不足的诚实阻塞分支另由假 PI 覆盖）。
LIVE_PLAN_TEXT = (
    "需求：在 ForgeLoop 的 `status --json` 输出中新增两个字段，规格已完全确定，请不要再提问。"
    "（1）`next_action`：字符串，始终存在，表示当前状态下建议的下一步动作描述；"
    '（2）`blocker`：字符串，当前有阻塞时给出阻塞原因描述，无阻塞时为 `""` 空字符串，'
    "不使用 null，也不省略该键。字段名使用 snake_case；人类可读的 `status` 文本输出保持不变。"
    "请给出目标、业务场景、验收标准与待澄清项（信息已充足，clarifications 必须为空数组 []）。"
)


def isolate_pi_home(tmp_path: Path) -> dict[str, str]:
    """隔离 HOME：只拷 pi 配置必需文件（与 A02 同口径，判据：models.json 存在）。"""

    source = Path.home() / ".pi" / "agent"
    target = tmp_path / "pi-home" / ".pi" / "agent"
    target.mkdir(parents=True, exist_ok=True)
    for name in PI_CONFIG_FILES:
        candidate = source / name
        if candidate.exists():
            shutil.copy2(candidate, target / name)
    return {"HOME": str(tmp_path / "pi-home")}


class TestRealPiPlanning:
    @LIVE_REQUIRED
    @pytest.mark.pi_live
    @pytest.mark.timeout(240)
    def test_real_pi_plan_is_actionable_or_honestly_blocked(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result=READY_RESULT,
            text=LIVE_PLAN_TEXT,
        )
        context = PlanningContext(
            scene.store,
            scene.req_id,
            scene.analysis_dir,
            REAL_PI_COMMAND,
            timeout_seconds=180.0,
            extra_env=isolate_pi_home(tmp_path),
        )
        try:
            analysis = analyze_requirement(context)
            outcome = plan_requirement(context)
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        # 真实边界只容许两种诚实结果：可批准任务包，或带原因的阻塞。
        assert outcome.requirement_status == status
        assert status in {PLAN_PROPOSED, BLOCKED}
        if outcome.plan is None:
            assert status == BLOCKED and outcome.halted_reason
        else:
            assert len(outcome.plan.tasks) >= 2
            assert any(task.depends_on for task in outcome.plan.tasks)
            assert all(task.authorization_source == "" for task in outcome.plan.tasks)
        # 分析会话总在独立分析目录内落盘；只有分析就绪并进入规划时，
        # 规划会话才存在（信息不足时规划在调用 PI 前就如实阻塞，不建会话）。
        sessions = scene.analysis_dir / "sessions"
        assert (sessions / f"{scene.req_id}-analysis.events.jsonl").exists()
        if analysis.is_ready:
            assert (sessions / f"{scene.req_id}-planning.events.jsonl").exists()
