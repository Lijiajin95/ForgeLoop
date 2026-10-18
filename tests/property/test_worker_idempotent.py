"""常驻 worker 筛选规则的属性检查（R2）。

这里只钉**不依赖具体实现措辞**的不变量，避免写成同义反复：

- **不放行必有原因**：任何一条前提不成立都必须给出非空原因，不能静默跳过；
- **放行的可靠性（无假放行）**：判定为可自动接续时，四条前提必须真的都成立；
- **HOME 敏感性**：两个不同的 HOME 之间永远不放行（宿主模式下 PI 会继承进程环境）；
- **确定性**：同一组输入两次判定结果一致。
"""

from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.graph.worker import worker_eligibility

ACTORS = st.sampled_from(["agent", "user", "", "unknown"])
HOMES = st.sampled_from(["", "/home/a", "/home/b", "/srv/pi-home"])
FLAGS = st.booleans()


@given(
    project_configured=FLAGS,
    plan_approved=FLAGS,
    next_actor=ACTORS,
    process_home=HOMES,
    project_home=HOMES,
)
def test_refusal_always_explains(
    project_configured: bool,
    plan_approved: bool,
    next_actor: str,
    process_home: str,
    project_home: str,
) -> None:
    decision = worker_eligibility(
        project_configured=project_configured,
        plan_approved=plan_approved,
        next_actor=next_actor,
        process_home=process_home,
        project_home=project_home,
    )
    if not decision.eligible:
        assert decision.reason.strip(), "不放行必须给出可操作原因"


@given(
    project_configured=FLAGS,
    plan_approved=FLAGS,
    next_actor=ACTORS,
    process_home=HOMES,
    project_home=HOMES,
)
def test_eligible_implies_every_condition(
    project_configured: bool,
    plan_approved: bool,
    next_actor: str,
    process_home: str,
    project_home: str,
) -> None:
    decision = worker_eligibility(
        project_configured=project_configured,
        plan_approved=plan_approved,
        next_actor=next_actor,
        process_home=process_home,
        project_home=project_home,
    )
    if decision.eligible:
        assert project_configured
        assert plan_approved
        assert next_actor == "agent"
        assert process_home.strip()
        assert Path(process_home).expanduser() == Path(project_home).expanduser()


@given(
    process_home=st.sampled_from(["/home/a", "/home/b", "/srv/pi-home"]),
    project_home=st.sampled_from(["/home/a", "/home/b", "/srv/pi-home"]),
)
def test_different_homes_are_never_eligible(process_home: str, project_home: str) -> None:
    if process_home == project_home:
        return
    decision = worker_eligibility(
        project_configured=True,
        plan_approved=True,
        next_actor="agent",
        process_home=process_home,
        project_home=project_home,
    )
    assert decision.eligible is False
    assert "HOME" in decision.reason


@given(
    project_configured=FLAGS,
    plan_approved=FLAGS,
    next_actor=ACTORS,
    process_home=HOMES,
    project_home=HOMES,
)
def test_decision_is_deterministic(
    project_configured: bool,
    plan_approved: bool,
    next_actor: str,
    process_home: str,
    project_home: str,
) -> None:
    arguments = {
        "project_configured": project_configured,
        "plan_approved": plan_approved,
        "next_actor": next_actor,
        "process_home": process_home,
        "project_home": project_home,
    }
    assert worker_eligibility(**arguments) == worker_eligibility(**arguments)
