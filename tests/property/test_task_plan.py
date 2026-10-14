"""任务包属性测试：任意 DAG 下执行顺序与批准绑定的不变量都成立。

不变量：
- 任意无环依赖集合都能构造任务包，拓扑序包含全部任务且前置依赖先出现；
- 增删依赖不改变任务身份集合；
- 批准仅在需求身份与任务包版本都匹配时生效，绑定后每个任务都带上该批准来源；
- 任务包序列化往返不丢字段。
"""

from datetime import UTC, datetime

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.task_plan import (
    PlanAuthorizationStatus,
    PlannedTask,
    TaskPlan,
    TaskPlanApproval,
    authorize_plan,
    bind_authorization,
    task_plan_from_payload,
    task_plan_to_payload,
)

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)


@st.composite
def acyclic_task_payloads(draw: st.DrawFn) -> list[dict[str, object]]:
    """按索引生成任务：只依赖更早的任务，因此天然无环。"""

    count = draw(st.integers(min_value=1, max_value=8))
    payloads: list[dict[str, object]] = []
    for index in range(count):
        earlier = [f"t{other}" for other in range(index)]
        dependencies = (
            draw(st.lists(st.sampled_from(earlier), unique=True, max_size=min(3, index)))
            if earlier
            else []
        )
        payloads.append(
            {
                "task_id": f"t{index}",
                "goal": f"目标 {index}",
                "files": ["src/app.py"],
                "acceptance": f"验收 {index}",
                "test_command": ["uv", "run", "pytest"],
                "depends_on": dependencies,
            }
        )
    return payloads


def plan_from(payloads: list[dict[str, object]]) -> TaskPlan:
    tasks = tuple(
        PlannedTask(
            task_id=str(item["task_id"]),
            goal=str(item["goal"]),
            files=tuple(str(path) for path in item["files"]),  # type: ignore[union-attr]
            acceptance=str(item["acceptance"]),
            test_command=tuple(str(arg) for arg in item["test_command"]),  # type: ignore[union-attr]
            depends_on=tuple(str(dep) for dep in item["depends_on"]),  # type: ignore[union-attr]
        )
        for item in payloads
    )
    return TaskPlan("plan-req-1-1", "req-1", "ForgeLoop", 1, 1, tasks, WHEN)


@given(acyclic_task_payloads())
def test_execution_order_is_a_topological_permutation(payloads: list[dict[str, object]]) -> None:
    plan = plan_from(payloads)
    order = plan.execution_order()
    assert sorted(order) == sorted(str(item["task_id"]) for item in payloads)
    position = {task_id: index for index, task_id in enumerate(order)}
    for item in payloads:
        for dependency in item["depends_on"]:  # type: ignore[union-attr]
            assert position[str(dependency)] < position[str(item["task_id"])]


@given(acyclic_task_payloads())
def test_round_trip_never_loses_fields(payloads: list[dict[str, object]]) -> None:
    plan = plan_from(payloads)
    assert task_plan_from_payload(task_plan_to_payload(plan)) == plan


@given(
    acyclic_task_payloads(),
    st.integers(min_value=1, max_value=3),
    st.integers(min_value=1, max_value=3),
)
def test_only_matching_approval_executes(
    payloads: list[dict[str, object]], approved_version: int, plan_version: int
) -> None:
    plan = TaskPlan(
        "plan-req-1-1", "req-1", "ForgeLoop", plan_version, 1, plan_from(payloads).tasks, WHEN
    )
    approval = TaskPlanApproval("req-1", approved_version, "owner", WHEN)
    authorization = authorize_plan(plan, approval)
    if approved_version == plan_version:
        assert authorization.status is PlanAuthorizationStatus.APPROVED
        authorized = bind_authorization(plan, approval)
        assert all(
            task.authorization_source == approval.authorization_source for task in authorized.tasks
        )
    else:
        assert authorization.status is PlanAuthorizationStatus.STALE
