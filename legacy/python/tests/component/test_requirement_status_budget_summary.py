"""CLI 组件测试：需求 ``status`` 的任务对象追加 domain 工时摘要 ``budget_summary``。

覆盖 G03 cli-integration 的查询输出契约：

- ``requirement status --json`` 每个任务对象新增 ``budget_summary``（追加字段），
  由 ``domain.budget_summary`` 纯规则按任务状态与权威 ``budget`` 行只读派生；
- 未开始任务明确标记 ``not_started``，读数未知而非伪装为 0 秒；
- 有 ``budget`` 行时输出 ``consumed_seconds``/``limit_seconds``/``exhausted``；
  状态与存在性冲突时以存在 ``budget`` 行为准输出 ``unknown`` 并说明冲突；
- 人类可读输出每任务附一行工时说明（如「已用 1770/7200 秒，未耗尽」）；
- 既有任务与证据字段名称、含义、取值不变；只读派生不写入预算状态。
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from project_support import record_store, requirement_store

from forgeloop.cli.main import main as cli_main
from forgeloop.domain.task_plan import PlannedTask, TaskPlan
from forgeloop.graph.builder import requirement_task_id

pytestmark = pytest.mark.component

WHEN = datetime(2026, 10, 14, 10, 0, tzinfo=UTC)

# 既有任务对象字段（G02 cli-contract）；budget_summary 只追加、不改写其中任何一项。
EXISTING_TASK_FIELDS = frozenset(
    {
        "task_id",
        "state",
        "reason",
        "executed_seconds",
        "artifact",
        "single_task_id",
        "single_task",
        "dependency",
        "evidence",
    }
)
BUDGET_SUMMARY_FIELDS = frozenset(
    {
        "state",
        "consumed_seconds",
        "limit_seconds",
        "exhausted",
        "dimensions",
        "note",
    }
)


def approved_requirement(tmp_path: Path) -> str:
    """登记一条已批准需求，包内 alpha 是 beta 的前置；返回需求身份。"""

    store = requirement_store(tmp_path)
    try:
        requirement = store.submit("proj", "需求：把工时摘要接入 CLI 查询")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-1",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask("alpha", "实现上游", ("src/a.py",), "验收", ("cmd",)),
                PlannedTask(
                    "beta",
                    "实现下游",
                    ("src/b.py",),
                    "验收",
                    ("cmd",),
                    depends_on=("alpha",),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, 1, "owner")
    finally:
        store.close()
    return requirement.req_id


def seed_single_task(
    tmp_path: Path,
    task_id: str,
    *,
    status: str = "delivered",
    consumed_seconds: float = 0.0,
    limit_seconds: float = 7200.0,
) -> None:
    """在权威记录里登记映射单任务（含 budget 行）并设置状态。"""

    store = record_store(tmp_path)
    try:
        store.create_task(task_id, "proj", "input", {}, limit_seconds)
        if consumed_seconds:
            store.charge_budget(task_id, consumed_seconds)
        store.set_task_status(task_id, status)
    finally:
        store.close()


def record_requirement_run(
    tmp_path: Path,
    req_id: str,
    task_id: str,
    state: str,
    *,
    executed_seconds: float = 0.0,
) -> None:
    store = requirement_store(tmp_path)
    try:
        store.record_task_run(req_id, 1, task_id, state, executed_seconds=executed_seconds)
    finally:
        store.close()


def requirement_status_json(tmp_path: Path, req_id: str, capsys: Any) -> dict:
    code = cli_main(["requirement", "status", req_id, "--json", "--records-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0, captured.out
    return json.loads(captured.out)


def requirement_status_text(tmp_path: Path, req_id: str, capsys: Any) -> str:
    code = cli_main(["requirement", "status", req_id, "--records-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 0, captured.out
    return captured.out


def by_task(document: dict) -> dict[str, dict]:
    return {entry["task_id"]: entry for entry in document["tasks"]}


def assert_lower_snake_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            assert key == key.lower()
            assert key[0].isalpha() and key[0].islower()
            assert all(part.isalnum() for part in key.split("_") if part)
            assert_lower_snake_keys(item)
    elif isinstance(value, list):
        for item in value:
            assert_lower_snake_keys(item)


class TestRequirementBudgetSummaryJson:
    """``requirement status --json`` 的任务对象追加只读工时摘要。"""

    def test_every_task_object_has_added_budget_summary(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)

        document = requirement_status_json(tmp_path, req_id, capsys)
        entries = by_task(document)
        assert set(entries) == {"alpha", "beta"}
        for entry in entries.values():
            assert set(entry) >= EXISTING_TASK_FIELDS  # 既有字段一个不少
            assert "budget_summary" in entry
            assert set(entry["budget_summary"]) == BUDGET_SUMMARY_FIELDS
        assert_lower_snake_keys(document)

    def test_not_started_task_is_explicitly_marked(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)

        entries = by_task(requirement_status_json(tmp_path, req_id, capsys))
        summary = entries["alpha"]["budget_summary"]
        assert entries["alpha"]["state"] == "pending"  # 既有任务状态词不变
        assert summary["state"] == "not_started"
        # 无记录不伪装成 0 秒：读数未知。
        assert summary["consumed_seconds"] is None
        assert summary["limit_seconds"] is None
        assert summary["exhausted"] is None
        assert summary["dimensions"] == ["seconds"]
        assert "未开始" in summary["note"]

    def test_started_task_reports_consumed_and_limit(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="delivered", consumed_seconds=1770.0)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered", executed_seconds=1770.0)

        entries = by_task(requirement_status_json(tmp_path, req_id, capsys))
        summary = entries["alpha"]["budget_summary"]
        assert summary["state"] == "in_progress"
        assert summary["consumed_seconds"] == 1770.0
        assert summary["limit_seconds"] == 7200.0
        assert summary["exhausted"] is False
        # beta 仍无单任务记录：未开始。
        assert entries["beta"]["budget_summary"]["state"] == "not_started"

    def test_executing_without_progress_run_uses_single_task_status(
        self, tmp_path: Path, capsys: Any
    ) -> None:
        """任务执行中且需求侧尚无推进会记录：以单任务权威状态派生，不误报冲突。

        需求侧推进会记录仅在任务返回后写入；此时单任务已有 budget 行、状态为
        implementing，若用 run 缺失时的 pending 会误报 unknown 并丢掉消耗/限额。
        """

        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="implementing", consumed_seconds=749.0)
        # 不写需求侧推进会记录：任务仍在执行中。

        entries = by_task(requirement_status_json(tmp_path, req_id, capsys))
        assert entries["alpha"]["state"] == "pending"  # 既有需求侧任务状态词不变
        assert entries["alpha"]["single_task"]["status"] == "implementing"
        summary = entries["alpha"]["budget_summary"]
        assert summary["state"] == "in_progress"
        assert summary["consumed_seconds"] == 749.0
        assert summary["limit_seconds"] == 7200.0
        assert summary["exhausted"] is False

        out = requirement_status_text(tmp_path, req_id, capsys)
        assert "已用 749/7200 秒，未耗尽" in out
        # 只约束工时摘要那一行：另一并行需求为同一输出追加了“阻断原因”行，
        # 该行在缺少权威依据时会合法地输出 unknown，与本用例的意图无关。
        budget_line = next(line for line in out.splitlines() if "已用 749/7200 秒" in line)
        assert "unknown" not in budget_line

    def test_exhausted_task_reports_exhausted(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="time_exhausted", consumed_seconds=7200.0)
        record_requirement_run(tmp_path, req_id, "alpha", "failed")

        summary = by_task(requirement_status_json(tmp_path, req_id, capsys))["alpha"][
            "budget_summary"
        ]
        assert summary["state"] == "exhausted"
        assert summary["exhausted"] is True
        assert summary["consumed_seconds"] == 7200.0

    def test_started_status_without_budget_row_is_unknown(
        self, tmp_path: Path, capsys: Any
    ) -> None:
        """记录称任务已推进，却没有任何 budget 行：存在性冲突，输出 unknown。"""

        req_id = approved_requirement(tmp_path)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered")

        summary = by_task(requirement_status_json(tmp_path, req_id, capsys))["alpha"][
            "budget_summary"
        ]
        assert summary["state"] == "unknown"
        assert summary["consumed_seconds"] is None
        assert summary["limit_seconds"] is None
        assert summary["exhausted"] is None
        assert "冲突" in summary["note"]

    def test_unstarted_status_with_budget_row_is_unknown(self, tmp_path: Path, capsys: Any) -> None:
        """有 budget 行却仍标未开始：以存在 budget 行为准，标记 unknown 但给出读数。"""

        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="created", consumed_seconds=10.0)
        record_requirement_run(tmp_path, req_id, "alpha", "pending")

        summary = by_task(requirement_status_json(tmp_path, req_id, capsys))["alpha"][
            "budget_summary"
        ]
        assert summary["state"] == "unknown"
        assert summary["consumed_seconds"] == 10.0
        assert summary["limit_seconds"] == 7200.0
        assert "冲突" in summary["note"]

    def test_existing_evidence_fields_keep_semantics(self, tmp_path: Path, capsys: Any) -> None:
        """追加字段不改变既有任务与证据字段的名称、含义与取值。"""

        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="delivered", consumed_seconds=5.0)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered", executed_seconds=5.0)

        entries = by_task(requirement_status_json(tmp_path, req_id, capsys))
        assert entries["alpha"]["task_id"] == "alpha"
        assert entries["alpha"]["state"] == "delivered"
        assert entries["alpha"]["executed_seconds"] == 5.0
        assert entries["alpha"]["single_task_id"] == alpha
        assert set(entries["alpha"]["dependency"]) == {
            "task_id",
            "verdict",
            "is_waiting",
            "is_running",
            "is_unknown",
            "unmet_prerequisites",
            "outstanding_action",
            "recorded_status",
            "failure_rounds",
            "evidence",
            "missing",
        }
        assert set(entries["alpha"]["evidence"]) == {
            "task_id",
            "candidate",
            "review",
            "test",
            "artifact",
            "baseline_commit",
            "acceptance",
            "missing",
        }


class TestRequirementBudgetSummaryText:
    """人类可读输出每任务附一行简短工时说明。"""

    def test_used_seconds_line_is_present(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="delivered", consumed_seconds=1770.0)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered", executed_seconds=1770.0)

        out = requirement_status_text(tmp_path, req_id, capsys)
        assert "已用 1770/7200 秒，未耗尽" in out
        assert "未开始" in out  # beta 尚未开始

    def test_exhausted_line_is_present(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="time_exhausted", consumed_seconds=7200.0)
        record_requirement_run(tmp_path, req_id, "alpha", "failed")

        out = requirement_status_text(tmp_path, req_id, capsys)
        assert "已用 7200/7200 秒，已耗尽" in out

    def test_conflict_line_marks_unknown(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered")

        out = requirement_status_text(tmp_path, req_id, capsys)
        assert "unknown" in out


class TestBudgetSummaryIsReadOnly:
    """查询只读派生，不写入预算状态。"""

    def test_status_does_not_change_budget_or_runs(self, tmp_path: Path, capsys: Any) -> None:
        req_id = approved_requirement(tmp_path)
        alpha = requirement_task_id(req_id, 1, "alpha")
        seed_single_task(tmp_path, alpha, status="delivered", consumed_seconds=1770.0)
        record_requirement_run(tmp_path, req_id, "alpha", "delivered", executed_seconds=1770.0)

        store = record_store(tmp_path)
        try:
            before = store.budget(alpha)
        finally:
            store.close()

        requirement_status_json(tmp_path, req_id, capsys)
        requirement_status_text(tmp_path, req_id, capsys)

        store = record_store(tmp_path)
        try:
            after = store.budget(alpha)
        finally:
            store.close()
        assert (after.limit_seconds, after.consumed_seconds) == (
            before.limit_seconds,
            before.consumed_seconds,
        )
        assert (before.limit_seconds, before.consumed_seconds) == (7200.0, 1770.0)

        requirement_records = requirement_store(tmp_path)
        try:
            runs = requirement_records.task_runs(req_id, 1)
        finally:
            requirement_records.close()
        assert [run.task_id for run in runs] == ["alpha"]  # 查询未新增推进记录
