"""任务包领域规则：身份、依赖、文件清单、批准绑定与序列化（纯规则）。

覆盖 DogFood 交接约定 §3、§5 的校验清单：依赖存在且无环、包内 task_id 唯一、
测试命令必须可执行、跨项目引用拒绝；以及批准绑定需求身份与任务包版本、
任务级授权来源只来自真实批准。
"""

from datetime import UTC, datetime

import pytest

from forgeloop.domain.task_plan import (
    PlanAuthorizationStatus,
    PlannedTask,
    TaskLimits,
    TaskPlan,
    TaskPlanApproval,
    TaskPlanError,
    TaskPlanNotAuthorizedError,
    TaskPlanNotFoundError,
    authorize_plan,
    bind_authorization,
    parse_task_plan,
    require_actionable_plan,
    task_plan_from_payload,
    task_plan_to_payload,
)

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


def task(
    task_id: str,
    *,
    depends_on: tuple[str, ...] = (),
    files: tuple[str, ...] = ("src/app.py",),
    test_command: tuple[str, ...] = ("uv", "run", "pytest"),
) -> PlannedTask:
    return PlannedTask(
        task_id=task_id,
        goal=f"目标 {task_id}",
        files=files,
        acceptance=f"验收 {task_id}",
        test_command=test_command,
        depends_on=depends_on,
    )


def plan(
    tasks: tuple[PlannedTask, ...] | None = None,
    *,
    plan_version: int = 1,
    requirement_version: int = 1,
    project: str = "ForgeLoop",
) -> TaskPlan:
    return TaskPlan(
        task_plan_id=f"plan-req-1-{plan_version}",
        requirement_id="req-1",
        project=project,
        plan_version=plan_version,
        requirement_version=requirement_version,
        tasks=tasks if tasks is not None else (task("t1"), task("t2", depends_on=("t1",))),
        created_at=WHEN,
    )


def task_payload(task_id: str, *, depends_on: list[str] | None = None) -> dict:
    return {
        "task_id": task_id,
        "goal": f"目标 {task_id}",
        "files": ["src/app.py"],
        "acceptance": f"验收 {task_id}",
        "test_command": ["uv", "run", "pytest"],
        "depends_on": depends_on or [],
    }


class TestPlannedTaskRules:
    def test_required_fields_must_be_non_empty(self) -> None:
        with pytest.raises(TaskPlanError, match="task_id"):
            task("")
        with pytest.raises(TaskPlanError, match="goal"):
            PlannedTask("t1", "  ", ("a.py",), "验收", ("pytest",))
        with pytest.raises(TaskPlanError, match="acceptance"):
            PlannedTask("t1", "目标", ("a.py",), "", ("pytest",))

    def test_files_are_required_and_relative_to_project(self) -> None:
        with pytest.raises(TaskPlanError, match="不能为空"):
            task("t1", files=())
        with pytest.raises(TaskPlanError, match="相对路径"):
            task("t1", files=("/etc/passwd",))
        with pytest.raises(TaskPlanError, match="不得越出项目根"):
            task("t1", files=("../outside.py",))

    def test_test_command_must_be_executable_argv(self) -> None:
        with pytest.raises(TaskPlanError, match="正式测试命令"):
            task("t1", test_command=())
        with pytest.raises(TaskPlanError, match="test_command"):
            task("t1", test_command=("pytest", " "))

    def test_task_cannot_depend_on_itself_or_repeat(self) -> None:
        with pytest.raises(TaskPlanError, match="依赖自身"):
            task("t1", depends_on=("t1",))
        with pytest.raises(TaskPlanError, match="重复"):
            task("t1", depends_on=("t2", "t2"))

    def test_duplicate_files_are_rejected(self) -> None:
        with pytest.raises(TaskPlanError, match="重复"):
            task("t1", files=("a.py", "a.py"))


class TestTaskLimitsRules:
    def test_defaults_follow_the_bounded_execution_limits(self) -> None:
        limits = TaskLimits()
        assert limits.limit_seconds == 7200.0
        assert limits.max_failure_rounds == 3

    def test_non_positive_limit_is_rejected(self) -> None:
        with pytest.raises(TaskPlanError, match="限额"):
            TaskLimits(0.0)
        with pytest.raises(TaskPlanError, match="失败轮次"):
            TaskLimits(100.0, 0)


class TestTaskPlanRules:
    def test_empty_plan_is_rejected(self) -> None:
        with pytest.raises(TaskPlanError, match="至少要有"):  # 至少一个任务
            plan(())

    def test_task_ids_must_be_unique(self) -> None:
        with pytest.raises(TaskPlanError, match="唯一"):
            plan((task("t1"), task("t1")))

    def test_missing_dependency_is_rejected(self) -> None:
        with pytest.raises(TaskPlanError, match="依赖不存在的任务"):
            plan((task("t1", depends_on=("ghost",)), task("t2")))

    def test_dependency_cycle_is_rejected(self) -> None:
        with pytest.raises(TaskPlanError, match="环"):
            plan(
                (
                    task("t1", depends_on=("t2",)),
                    task("t2", depends_on=("t1",)),
                )
            )

    def test_execution_order_respects_dependencies(self) -> None:
        built = plan(
            (
                task("t2", depends_on=("t1",)),
                task("t3", depends_on=("t2",)),
                task("t1"),
            )
        )
        order = built.execution_order()
        assert order == ("t1", "t2", "t3")
        assert built.roots == ("t1",)

    def test_task_lookup_fails_explicitly(self) -> None:
        with pytest.raises(TaskPlanNotFoundError):
            plan().task("missing")

    def test_version_and_identity_must_be_valid(self) -> None:
        with pytest.raises(TaskPlanError, match="版本号"):
            plan(plan_version=0)
        with pytest.raises(TaskPlanError, match="需求版本"):
            plan(requirement_version=0)
        with pytest.raises(TaskPlanError, match="project"):
            TaskPlan("plan-1", "req-1", " ", 1, 1, (task("t1"),), WHEN)


class TestActionablePlan:
    def test_two_tasks_with_dependency_pass(self) -> None:
        require_actionable_plan(plan())

    def test_single_task_is_not_actionable(self) -> None:
        with pytest.raises(TaskPlanError, match="两个任务"):
            require_actionable_plan(plan((task("t1"),)))

    def test_independent_tasks_are_not_actionable(self) -> None:
        with pytest.raises(TaskPlanError, match="依赖"):
            require_actionable_plan(plan((task("t1"), task("t2"))))


class TestParseTaskPlan:
    def test_valid_payload_becomes_plan_with_default_limits(self) -> None:
        built = parse_task_plan(
            {"tasks": [task_payload("t1"), task_payload("t2", depends_on=["t1"])]},
            task_plan_id="plan-req-1-1",
            requirement_id="req-1",
            project="ForgeLoop",
            plan_version=1,
            requirement_version=1,
            created_at=WHEN,
        )
        assert built.requirement_id == "req-1"
        assert built.tasks[1].depends_on == ("t1",)
        assert built.tasks[0].limits == TaskLimits()
        assert built.tasks[0].authorization_source == ""

    def test_model_supplied_authorization_source_is_rejected(self) -> None:
        payload = task_payload("t1")
        payload["authorization_source"] = "owner-said-so"
        with pytest.raises(TaskPlanError, match="authorization_source"):
            parse_task_plan(
                {"tasks": [payload, task_payload("t2", depends_on=["t1"])]},
                task_plan_id="plan-req-1-1",
                requirement_id="req-1",
                project="ForgeLoop",
                plan_version=1,
                requirement_version=1,
                created_at=WHEN,
            )

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"tasks": "not-a-list"},
            {"tasks": []},
            {"tasks": [{"task_id": "t1"}]},
            {"tasks": [{**task_payload("t1"), "files": "src/app.py"}]},
            {"tasks": [{**task_payload("t1"), "test_command": []}]},
            {"tasks": [{**task_payload("t1"), "limits": {"limit_seconds": "soon"}}]},
            {"tasks": [{**task_payload("t1"), "limits": {"max_failure_rounds": 1.5}}]},
        ],
    )
    def test_malformed_payloads_fail_explicitly(self, payload: object) -> None:
        with pytest.raises(TaskPlanError):
            parse_task_plan(
                payload,
                task_plan_id="plan-req-1-1",
                requirement_id="req-1",
                project="ForgeLoop",
                plan_version=1,
                requirement_version=1,
                created_at=WHEN,
            )


class TestPayloadRoundTrip:
    def test_round_trip_preserves_every_field(self) -> None:
        built = plan()
        restored = task_plan_from_payload(task_plan_to_payload(built))
        assert restored == built

    def test_round_trip_preserves_authorization_source(self) -> None:
        approval = TaskPlanApproval("req-1", 1, "owner", WHEN)
        authorized = bind_authorization(plan(), approval)
        restored = task_plan_from_payload(task_plan_to_payload(authorized))
        assert restored == authorized
        assert restored.tasks[0].authorization_source == approval.authorization_source


class TestPlanApprovalBinding:
    def test_missing_approval_does_not_execute(self) -> None:
        result = authorize_plan(plan(), None)
        assert result.status is PlanAuthorizationStatus.MISSING
        assert result.can_execute is False

    def test_old_version_approval_cannot_drive_new_plan(self) -> None:
        approval = TaskPlanApproval("req-1", 1, "owner", WHEN)
        result = authorize_plan(plan(plan_version=2), approval)
        assert result.status is PlanAuthorizationStatus.STALE
        assert "旧版本批准" in result.reason

    def test_approval_for_another_requirement_is_rejected(self) -> None:
        approval = TaskPlanApproval("req-2", 1, "owner", WHEN)
        result = authorize_plan(plan(), approval)
        assert result.status is PlanAuthorizationStatus.STALE

    def test_matching_approval_is_approved_and_binds_source(self) -> None:
        approval = TaskPlanApproval("req-1", 1, "owner", WHEN, source="batch-1")
        result = authorize_plan(plan(), approval)
        assert result.status is PlanAuthorizationStatus.APPROVED
        authorized = bind_authorization(plan(), approval)
        sources = {item.authorization_source for item in authorized.tasks}
        assert sources == {approval.authorization_source}
        assert approval.authorization_source == "plan-approval:req-1:v1:owner"

    def test_binding_without_valid_approval_is_rejected(self) -> None:
        approval = TaskPlanApproval("req-1", 2, "owner", WHEN)
        with pytest.raises(TaskPlanNotAuthorizedError):
            bind_authorization(plan(plan_version=1), approval)
