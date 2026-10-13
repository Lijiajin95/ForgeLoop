"""节点函数的行为级单元测试：方案守卫与状态更新语义。"""

import json
from pathlib import Path

import pytest

from forgeloop.adapter.pi_rpc import PIProcess
from forgeloop.graph.nodes import (
    NodeContext,
    make_dev_node,
    make_gate_plan_approval,
    make_plan_node,
    make_review_node,
    pi_timeout_seconds,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture()
def store(tmp_path):
    from forgeloop.records.store import RecordStore

    store = RecordStore(tmp_path / "records.sqlite")
    yield store
    store.close()


def context(
    store, tmp_path: Path, task_id: str, config: dict[str, str] | None = None
) -> NodeContext:
    base = {
        "pi_command": json.dumps(["unused"]),
        "test_command": json.dumps(["true"]),
        "goal": "g",
        "scope": "s",
        "acceptance": "a",
    }
    base.update(config or {})
    store.create_task(task_id, "p", "input", base, limit_seconds=60.0)
    return NodeContext.for_task(store, tmp_path, task_id)


class TestPlanNode:
    def test_second_invocation_bumps_version(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-plan")
        plan_node = make_plan_node(ctx)
        first = plan_node({"task_id": "task-plan"})
        second = plan_node({"task_id": "task-plan"})
        assert first["plan_version"] == 1
        assert second["plan_version"] == 2
        assert store.latest_plan("task-plan").version == 2

    def test_invalid_test_command_is_rejected(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-bad", {"test_command": '"not-a-list"'})
        with pytest.raises(ValueError, match="non-empty JSON array"):
            make_plan_node(ctx)({"task_id": "task-bad"})


class TestMissingPlanGuards:
    def test_gate_plan_approval_without_plan_halts(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-noplan")
        result = make_gate_plan_approval(ctx)({"task_id": "task-noplan"})
        assert result == {"halted_reason": "plan_missing"}
        assert store.get_task("task-noplan").status == "interrupted"

    def test_dev_without_plan_halts(self, store, tmp_path: Path) -> None:
        ctx = context(store, tmp_path, "task-noplan2")
        result = make_dev_node(ctx)({"task_id": "task-noplan2"})
        assert result == {"halted_reason": "plan_missing"}

    def test_review_without_plan_uses_empty_diff(self, store, tmp_path: Path, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        ctx = context(
            store,
            tmp_path,
            "task-noplan3",
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        result = make_review_node(ctx)({"task_id": "task-noplan3"})
        assert result == {"last_review_blocking": False}


class TestReviewResultShapes:
    """审查结果契约：无结构化阻断列表时不得判为"无阻断"（禁止错误放行）。"""

    def _review(self, store, tmp_path: Path, task_id: str, mode: str, monkeypatch):
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", mode)
        ctx = context(
            store,
            tmp_path,
            task_id,
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": task_id})
        result = make_review_node(ctx)({"task_id": task_id})
        entry = json.loads(
            (tmp_path / task_id / "reviews.jsonl").read_text(encoding="utf-8").splitlines()[0]
        )
        return result, entry, store.get_task(task_id).status

    def test_explicit_empty_blocking_issues_passes(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        result, entry, status = self._review(store, tmp_path, "task-ok", "ok", monkeypatch)
        assert result == {"last_review_blocking": False}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is True
        assert status == "reviewing"

    def test_non_empty_blocking_issues_is_blocking(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-blocking", "blocking", monkeypatch
        )
        assert result == {"last_review_blocking": True}
        assert entry["blocking_issues"]
        assert entry["blocking_issues_valid"] is True
        assert status == "reviewing"

    def test_non_list_blocking_issues_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-bad-issues", "review-bad-issues", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is False
        assert status == "interrupted"

    def test_missing_blocking_issues_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-no-issues", "review-no-issues", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues_valid"] is False
        assert status == "interrupted"

    def test_missing_review_text_halts(self, store, tmp_path: Path, monkeypatch) -> None:
        result, entry, status = self._review(
            store, tmp_path, "task-empty-text", "review-empty-text", monkeypatch
        )
        assert result == {"halted_reason": "review_result_invalid"}
        assert entry["blocking_issues"] == []
        assert entry["blocking_issues_valid"] is False
        assert entry["summary"] == ""
        assert status == "interrupted"


class TestPreamble:
    def test_fake_pi_process_contract_import(self) -> None:
        # 保持适配器可直接构造（会话文件路径派生）。
        process = PIProcess(("echo",), "t", "dev", Path("/tmp/fl-sessions"))
        assert process.events == ()


class TestReviewPromptContract:
    """真实模型需要明确的输出契约：没有它，fail-closed 会把散文式审查判为无效。"""

    def test_review_prompt_states_blocking_issues_contract(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        import sys

        log_path = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(log_path))
        ctx = context(
            store,
            tmp_path,
            "task-prompt",
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": "task-prompt"})
        make_review_node(ctx)({"task_id": "task-prompt"})
        entries = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
        review_prompts = [entry for entry in entries if entry["role"] == "review"]
        assert review_prompts, entries
        prompt = json.loads(review_prompts[0]["message"])
        contract = prompt["output_contract"]
        assert "blocking_issues" in contract
        assert "summary" in contract


class TestDevFailureFeedback:
    """失败回边必须带真实证据：盲重试无法收敛（测试输出与审查阻断问题）。"""

    def _dev_prompt(
        self, store, tmp_path: Path, task_id: str, monkeypatch, evidence: dict[str, str]
    ) -> dict:
        import sys

        log_path = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(log_path))
        ctx = context(
            store,
            tmp_path,
            task_id,
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": task_id})
        ctx.task_dir.mkdir(parents=True, exist_ok=True)
        for name, content in evidence.items():
            (ctx.task_dir / name).write_text(content, encoding="utf-8")
        make_dev_node(ctx)({"task_id": task_id})
        entries = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
        return json.loads(entries[0]["message"])

    def test_first_attempt_has_no_previous_failure(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        prompt = self._dev_prompt(store, tmp_path, "task-ff-none", monkeypatch, {})
        assert "previous_failure" not in prompt

    def test_failed_formal_test_is_fed_back(self, store, tmp_path: Path, monkeypatch) -> None:
        line = json.dumps(
            {"exit_code": 1, "stdout": "FAILED test_x", "stderr": "boom", "timed_out": False}
        )
        prompt = self._dev_prompt(
            store, tmp_path, "task-ff-test", monkeypatch, {"test-run.jsonl": line + "\n"}
        )
        failure = prompt["previous_failure"]
        assert failure["formal_test"]["exit_code"] == 1
        assert "FAILED test_x" in failure["formal_test"]["stdout_tail"]
        assert "boom" in failure["formal_test"]["stderr_tail"]

    def test_blocking_review_is_fed_back(self, store, tmp_path: Path, monkeypatch) -> None:
        line = json.dumps({"attempt": 1, "blocking_issues": ["缺少边界处理"], "summary": "s"})
        prompt = self._dev_prompt(
            store, tmp_path, "task-ff-review", monkeypatch, {"reviews.jsonl": line + "\n"}
        )
        assert prompt["previous_failure"]["review_blocking_issues"] == ["缺少边界处理"]
        assert "formal_test" not in prompt["previous_failure"]

    def test_long_output_is_truncated(self, store, tmp_path: Path, monkeypatch) -> None:
        line = json.dumps({"exit_code": 1, "stdout": "x" * 20000, "stderr": "", "timed_out": False})
        prompt = self._dev_prompt(
            store, tmp_path, "task-ff-long", monkeypatch, {"test-run.jsonl": line + "\n"}
        )
        tail = prompt["previous_failure"]["formal_test"]["stdout_tail"]
        assert 0 < len(tail) <= 2000


class TestPiWorkingDirectory:
    """PI 子进程必须显式在任务工作区内运行：只写在提示里不足以保护真实 main。"""

    def _prompt_entry(self, store, tmp_path: Path, task_id: str, monkeypatch, node: str) -> dict:
        import sys

        log_path = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(log_path))
        ctx = context(
            store,
            tmp_path,
            task_id,
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": task_id})
        if node == "dev":
            make_dev_node(ctx)({"task_id": task_id})
        else:
            make_review_node(ctx)({"task_id": task_id})
        entries = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
        return entries[0]

    def test_dev_runs_inside_the_workspace(self, store, tmp_path: Path, monkeypatch) -> None:
        entry = self._prompt_entry(store, tmp_path, "task-cwd-dev", monkeypatch, "dev")
        ctx = NodeContext.for_task(store, tmp_path, "task-cwd-dev")
        assert Path(entry["cwd"]).resolve() == ctx.workspace.resolve()

    def test_review_runs_in_the_task_records_dir(self, store, tmp_path: Path, monkeypatch) -> None:
        entry = self._prompt_entry(store, tmp_path, "task-cwd-review", monkeypatch, "review")
        ctx = NodeContext.for_task(store, tmp_path, "task-cwd-review")
        assert Path(entry["cwd"]).resolve() == ctx.task_dir.resolve()


class TestDevPromptContract:
    """B02：开发提示必须带批准测试命令、自验证要求与当前尝试序号。"""

    def _dev_prompt(self, store, tmp_path: Path, task_id: str, monkeypatch) -> dict:
        import sys

        log_path = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(log_path))
        ctx = context(
            store,
            tmp_path,
            task_id,
            {
                "pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")]),
                "test_command": json.dumps(["python3", "run_tests.py"]),
            },
        )
        make_plan_node(ctx)({"task_id": task_id})
        make_dev_node(ctx)({"task_id": task_id})
        entries = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
        return json.loads(entries[0]["message"])

    def test_prompt_carries_approved_test_command_and_attempt(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        prompt = self._dev_prompt(store, tmp_path, "task-dev-contract", monkeypatch)
        assert prompt["formal_test_command"] == ["python3", "run_tests.py"]
        assert prompt["attempt"] == 1

    def test_prompt_requires_self_verification(self, store, tmp_path: Path, monkeypatch) -> None:
        prompt = self._dev_prompt(store, tmp_path, "task-dev-selfverify", monkeypatch)
        instruction = prompt["self_verification"]
        assert "run_tests.py" in instruction or "测试命令" in instruction
        assert "不要" in instruction or "不得" in instruction  # 不得改测试/验收标准


class TestInterruptedGate:
    """中断收口：已记录 halted_reason 时，审查/测试节点不得再启动新动作。

    真实运行发现：dev 因 provider 连接错误中断后，图仍进入审查节点，造成一次无效模型
    调用，并把终态覆盖成 reviewing（应为 interrupted）。
    """

    def _interrupted_context(self, store, tmp_path: Path, task_id: str, monkeypatch):
        import sys

        log_path = tmp_path / "prompts.jsonl"
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        monkeypatch.setenv("FAKE_PI_PROMPT_LOG", str(log_path))
        ctx = context(
            store,
            tmp_path,
            task_id,
            {"pi_command": json.dumps([sys.executable, str(FIXTURES / "fake_pi.py")])},
        )
        make_plan_node(ctx)({"task_id": task_id})
        store.set_task_status(task_id, "interrupted")
        return ctx, log_path

    def test_review_node_does_not_start_after_halt(
        self, store, tmp_path: Path, monkeypatch
    ) -> None:
        task_id = "task-halt-review"
        ctx, log_path = self._interrupted_context(store, tmp_path, task_id, monkeypatch)
        update = make_review_node(ctx)({"task_id": task_id, "halted_reason": "pi_dev_unsettled:x"})
        assert update == {"halted_reason": "pi_dev_unsettled:x"}
        assert not log_path.exists()  # 没有启动新的 PI 会话
        assert store.get_task(task_id).status == "interrupted"  # 终态未被覆盖成 reviewing

    def test_test_node_does_not_start_after_halt(self, store, tmp_path: Path, monkeypatch) -> None:
        task_id = "task-halt-test"
        ctx, log_path = self._interrupted_context(store, tmp_path, task_id, monkeypatch)
        from forgeloop.graph.nodes import make_test_node

        update = make_test_node(ctx)({"task_id": task_id, "halted_reason": "pi_review_unsettled:y"})
        assert update == {"halted_reason": "pi_review_unsettled:y"}
        assert not log_path.exists()
        assert store.get_task(task_id).status == "interrupted"


class TestPiTimeout:
    """单次 PI 调用上限：任务配置可覆盖默认值，非法值回落，且不超过剩余预算。"""

    def _ctx(self, tmp_path: Path, name: str, config: dict, limit: float):
        from forgeloop.records.store import RecordStore

        store = RecordStore(tmp_path / f"{name}.sqlite")
        store.create_task(name, "p", "i", {"goal": "g", **config}, limit_seconds=limit)
        return store, NodeContext.for_task(store, tmp_path, name)

    def test_default_cap_when_unconfigured(self, tmp_path: Path) -> None:
        store, ctx = self._ctx(tmp_path, "task-default", {}, 3600.0)
        try:
            assert pi_timeout_seconds(ctx) == 300.0
        finally:
            store.close()

    def test_config_overrides_default(self, tmp_path: Path) -> None:
        store, ctx = self._ctx(tmp_path, "task-configured", {"pi_timeout_seconds": "900"}, 3600.0)
        try:
            assert pi_timeout_seconds(ctx) == 900.0
        finally:
            store.close()

    @pytest.mark.parametrize("value", ["abc", "-5", "0"])
    def test_invalid_or_negative_falls_back(self, tmp_path: Path, value: str) -> None:
        store, ctx = self._ctx(tmp_path, "task-invalid", {"pi_timeout_seconds": value}, 3600.0)
        try:
            assert pi_timeout_seconds(ctx) == 300.0
        finally:
            store.close()

    def test_never_exceeds_remaining_budget(self, tmp_path: Path) -> None:
        store, ctx = self._ctx(tmp_path, "task-small", {"pi_timeout_seconds": "900"}, 120.0)
        try:
            assert pi_timeout_seconds(ctx) <= 120.0
        finally:
            store.close()
