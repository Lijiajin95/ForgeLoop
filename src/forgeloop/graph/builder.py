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

import json
import sqlite3
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from forgeloop.domain.approval import Approval, ApprovalStage
from forgeloop.domain.task_plan import PlannedTask
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
from forgeloop.graph.requirements import (
    PrerequisiteCandidate,
    TaskExecution,
    TaskResult,
    TaskRunState,
)
from forgeloop.graph.state import TaskState
from forgeloop.records.requirements import TaskArtifact
from forgeloop.records.store import RecordStore


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


def requirement_task_id(req_id: str, plan_version: int, task_id: str) -> str:
    """需求内任务映射到单任务记录的稳定身份（同一任务重开仍指向同一条）。

    身份必须保留前缀 ``task-``：该前缀是既有单任务记录格式的一部分，需求线任务与
    单任务流程创建的任务靠它保持同样的记录形态，便于按前缀检索与区分。
    """

    return f"task-{req_id}-v{plan_version}-{task_id}"


def _run_config(task_id: str) -> RunnableConfig:
    return {"configurable": {"thread_id": task_id}}


def _close_runtime(graph: CompiledStateGraph[TaskState]) -> None:
    conn = getattr(graph.checkpointer, "conn", None)
    if conn is not None:
        conn.close()


def _interrupted_kinds(snapshot: object) -> set[str]:
    """检查点当前等待的节点名集合（``snapshot.next``）。"""

    return {str(name) for name in (getattr(snapshot, "next", None) or ())}


@dataclass
class RequirementTaskRunner:
    """把需求内一个已批准任务接到单任务业务图（I01 的真实运行入口）。

    需求任务包已经由所有者批准；映射出的单任务方案批准由此派生并自动记录，
    因此任务一启动就进入实现——但仍必须由所有者对实际候选做验收。执行器是
    ``graph.requirements.RequirementExecutor`` 注入的 ``run_task`` 接缝。
    """

    records_root: Path
    req_id: str
    plan_version: int
    project: str
    pi_command: tuple[str, ...]
    project_path: str = ""
    baseline: str = ""
    pi_timeout_seconds: float | None = None

    def __call__(self, execution: TaskExecution) -> TaskResult:
        task = execution.task
        task_id = requirement_task_id(self.req_id, self.plan_version, task.task_id)
        store = RecordStore(self.records_root / "records.sqlite")
        graph: CompiledStateGraph[TaskState] | None = None
        try:
            if store.get_task(task_id) is None:
                store.create_task(
                    task_id, self.project, task.goal, self._config(task), task.limits.limit_seconds
                )
            # 前置候选随每次启动重建：按已完成前置任务的候选 diff 现场路径与记录校验值
            # 交给 dev 节点，在克隆副本后、进入实现前应用。
            context = replace(
                NodeContext.for_task(store, self.records_root, task_id),
                prerequisites=self._prerequisite_candidates(
                    execution.dependencies, execution.covered_dependencies
                ),
            )
            graph = build_graph(
                context,
                self.records_root / "checkpoints.sqlite",
            )
            record = store.get_task(task_id)
            if record is not None and record.status == "delivered":
                return TaskResult(TaskRunState.DELIVERED, self._artifact(store, task_id, task))
            snapshot = graph.get_state(_run_config(task_id))
            if not snapshot.next:
                graph.invoke({"task_id": task_id}, _run_config(task_id))
                snapshot = graph.get_state(_run_config(task_id))
            if "gate_plan_approval" in _interrupted_kinds(snapshot):
                self._approve_plan(store, task_id)
                graph.invoke(Command(resume={"decision": "approved"}), _run_config(task_id))
                snapshot = graph.get_state(_run_config(task_id))
            return self._pending(task_id, snapshot)
        finally:
            if graph is not None:
                _close_runtime(graph)
            store.close()

    def _prerequisite_candidates(
        self,
        dependencies: tuple[TaskArtifact, ...],
        covered_dependencies: tuple[str, ...] = (),
    ) -> tuple[PrerequisiteCandidate, ...]:
        """把需求层前置产物身份落到单任务记录现场：候选 diff 路径 + 记录校验值。

        ``covered_dependencies`` 中的任务被其他依赖传递包含：照常带上身份供校验与
        记录，但标记为不单独应用，交由极大依赖带入其改动。
        """

        covered = set(covered_dependencies)
        return tuple(
            PrerequisiteCandidate(
                task_id=artifact.task_id,
                candidate_sha256=artifact.candidate_sha256,
                diff_path=self.records_root
                / requirement_task_id(self.req_id, self.plan_version, artifact.task_id)
                / "candidate.diff",
                covered=artifact.task_id in covered,
            )
            for artifact in dependencies
        )

    def _config(self, task: PlannedTask) -> dict[str, str]:
        config = {
            "requirement_id": self.req_id,
            "goal": task.goal,
            "scope": "\n".join(task.files),
            "acceptance": task.acceptance,
            "test_command": json.dumps(list(task.test_command), ensure_ascii=False),
            "pi_command": json.dumps(list(self.pi_command), ensure_ascii=False),
            "project_path": self.project_path,
            "baseline": self.baseline,
        }
        if self.pi_timeout_seconds is not None:
            config["pi_timeout_seconds"] = str(self.pi_timeout_seconds)
        return config

    def _approve_plan(self, store: RecordStore, task_id: str) -> None:
        """记录派生的方案批准（绑定实际任务与方案版本），随后恢复图执行。"""

        plan = store.latest_plan(task_id)
        if plan is None:  # pragma: no cover - 图在批准门前必然已保存方案
            return
        if store.effective_approval(task_id, ApprovalStage.PLAN) is None:
            store.record_approval(
                Approval(task_id, plan.version, ApprovalStage.PLAN, datetime.now(UTC))
            )

    def _artifact(self, store: RecordStore, task_id: str, task: PlannedTask) -> TaskArtifact:
        """由单任务交付材料构造需求前置产物身份；材料缺失时按空身份如实交付。"""

        binding = store.acceptance_binding(task_id)
        return TaskArtifact(
            task_id=task.task_id,
            candidate_sha256=binding.candidate_sha256 if binding else "",
            test_evidence_sha256=binding.test_evidence_sha256 if binding else "",
            review_sha256=binding.review_sha256 if binding else "",
            acceptance="accepted",
            authorization_source=task.authorization_source,
        )

    def _pending(self, task_id: str, snapshot: object) -> TaskResult:
        """图停下的位置：等待所有者验收/授权，或已交付，或如实失败。"""

        waiting = _interrupted_kinds(snapshot)
        if waiting:
            return TaskResult(TaskRunState.AWAITING_USER, reason=f"等待决定: {task_id}")
        values = getattr(snapshot, "values", {}) or {}
        reason = str(values.get("halted_reason", "")) or f"任务未交付: {task_id}"
        return TaskResult(TaskRunState.FAILED, reason=reason)
