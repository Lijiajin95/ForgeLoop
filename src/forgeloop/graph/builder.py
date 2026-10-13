"""业务图构建器：LangGraph 状态图与持久 checkpointer 装配。

图拓扑（架构 §4 研发闭环业务图）：
START → plan → gate_plan_approval →(批准) dev → review →(阻断) dev
                                      ↘(拒绝/绑定失败) END        ↘(通过) test
test →(通过) gate_acceptance →(接受) deliver → END
      →(失败·额度未尽) dev
      →(额度用尽) gate_grant →(明确追加) dev
                            ↘(停止) END
gate_acceptance →(拒绝) 按测试失败同规则路由
"""

import sqlite3
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from forgeloop.graph.nodes import (
    NodeContext,
    make_deliver_node,
    make_dev_node,
    make_gate_acceptance,
    make_gate_grant,
    make_gate_plan_approval,
    make_plan_node,
    make_review_node,
    make_test_node,
)
from forgeloop.graph.state import TaskState


def route_after_plan_gate(state: TaskState) -> str:
    if state.get("halted_reason"):
        return END
    return "dev"


def route_after_review(state: TaskState) -> str:
    if state.get("halted_reason"):
        return END
    if state.get("last_review_blocking"):
        return "dev"
    return "test"


def route_after_test(state: TaskState) -> str:
    if state.get("halted_reason"):
        return END
    if state.get("last_test_passed"):
        return "gate_acceptance"
    if state.get("needs_grant"):
        return "gate_grant"
    return "dev"


def route_after_grant(state: TaskState) -> str:
    if state.get("halted_reason"):
        return END
    return "dev"


def route_after_acceptance(state: TaskState) -> str:
    if state.get("halted_reason"):
        return END
    if state.get("acceptance_passed"):
        return "deliver"
    if state.get("needs_grant"):
        return "gate_grant"
    return "dev"


def build_graph(ctx: NodeContext, checkpoint_db: Path) -> CompiledStateGraph[TaskState]:
    """构建任务业务图并挂 SQLite 持久 checkpointer（thread_id = task_id）。"""

    graph = StateGraph(TaskState)
    graph.add_node("plan", make_plan_node(ctx))
    graph.add_node("gate_plan_approval", make_gate_plan_approval(ctx))
    graph.add_node("dev", make_dev_node(ctx))
    graph.add_node("review", make_review_node(ctx))
    graph.add_node("test", make_test_node(ctx))
    graph.add_node("gate_grant", make_gate_grant(ctx))
    graph.add_node("gate_acceptance", make_gate_acceptance(ctx))
    graph.add_node("deliver", make_deliver_node(ctx))

    graph.add_edge(START, "plan")
    graph.add_edge("plan", "gate_plan_approval")
    graph.add_conditional_edges(
        "gate_plan_approval",
        route_after_plan_gate,
        {"dev": "dev", END: END},
    )
    graph.add_edge("dev", "review")
    graph.add_conditional_edges(
        "review",
        route_after_review,
        {"dev": "dev", "test": "test", END: END},
    )
    graph.add_conditional_edges(
        "test",
        route_after_test,
        {"gate_acceptance": "gate_acceptance", "gate_grant": "gate_grant", "dev": "dev", END: END},
    )
    graph.add_conditional_edges(
        "gate_grant",
        route_after_grant,
        {"dev": "dev", END: END},
    )
    graph.add_conditional_edges(
        "gate_acceptance",
        route_after_acceptance,
        {"deliver": "deliver", "gate_grant": "gate_grant", "dev": "dev", END: END},
    )
    graph.add_edge("deliver", END)

    checkpoint_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(checkpoint_db, check_same_thread=False)
    checkpointer = SqliteSaver(conn)
    checkpointer.setup()
    return graph.compile(checkpointer=checkpointer)
