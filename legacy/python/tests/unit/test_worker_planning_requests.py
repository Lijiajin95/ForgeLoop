"""worker 的分析/规划请求：持久受理、只读前提与心跳执行（替身，不跑模型）。

真实模型调用由 graph.planning 的既有场景用例覆盖；这里核对的是新接线——
页面请求先落库、下一次心跳消费一次、结果写回状态，且不越过终态/未核对动作/
PI HOME 等硬前提。
"""

import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import register_project

from forgeloop.domain.requirement import RequirementAnalysis
from forgeloop.domain.service import ProjectProfile
from forgeloop.graph import worker as worker_module
from forgeloop.graph.planning import PlanningContext
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.service_requests import ServiceRequest, ServiceRequestStore

PROJECT = "forgeloop"


def _profile(tmp_path: Path) -> ProjectProfile:
    return ProjectProfile(
        name=PROJECT,
        path=str(tmp_path / "repo"),
        pi_command=("fake-pi",),
        test_command=(),
        baseline="",
        pi_home=os.environ.get("HOME", ""),
    )


def _draft(tmp_path: Path) -> str:
    register_project(tmp_path)
    store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
    try:
        return store.submit(PROJECT, "需求：从 Web 触发分析").req_id
    finally:
        store.close()


class TestPlanningRequestQueue:
    def test_analyze_request_is_persisted_and_consumed_once(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = _draft(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        request = worker.request_action(req_id, "analyze", by="owner", source="web")
        assert request.action == "analyze"
        assert worker.pending_advance() == ()
        assert worker.status()["pending_actions"] == [{"req_id": req_id, "action": "analyze"}]

        # 重建 worker：请求仍在项目库里，不依赖内存。
        reopened = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        assert [(item.req_id, item.action) for item in reopened.pending_requests()] == [
            (req_id, "analyze")
        ]

        calls: list[tuple[str, str]] = []

        def fake_analyze(context: PlanningContext) -> object:
            calls.append((context.req_id, "analyze"))
            return type("Outcome", (), {"analysis": object(), "halted_reason": None})()

        monkeypatch.setattr(worker_module, "analyze_requirement", fake_analyze)
        worker.poll_once()

        assert calls == [(req_id, "analyze")]
        assert worker.pending_requests() == ()
        assert worker.status()["last_tick"]["results"] == [
            {
                "req_id": req_id,
                "action": "analyze",
                "status": "ok",
                "detail": "分析已完成",
            }
        ]
        # 已消费的请求不会因第二次心跳重放。
        worker.poll_once()
        assert calls == [(req_id, "analyze")]

    def test_different_action_while_one_is_pending_is_refused(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        store = ServiceRequestStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            store.record(
                req_id=req_id,
                project=PROJECT,
                plan_version=0,
                requested_by="owner",
                source="web",
                action="analyze",
            )
        finally:
            store.close()
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        with pytest.raises(ValueError, match="已有待处理的操作"):
            worker.request_action(req_id, "plan", by="owner", source="web")

    def test_terminal_requirement_cannot_queue_analysis(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            store.record_requirement_cancellation(req_id, by="owner", reason="测试终态")
        finally:
            store.close()
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        assert worker.planning_eligibility(req_id, "analyze").eligible is False
        assert "终态" in worker.planning_eligibility(req_id, "analyze").reason


class TestPlanningEligibility:
    def test_plan_requires_a_current_ready_analysis(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            missing = store.latest_analysis(req_id)
            assert missing is None
            store.record_analysis(
                req_id,
                RequirementAnalysis(
                    analysis_version=1,
                    requirement_version=1,
                    goal="目标",
                    scenarios=("场景",),
                    acceptance_criteria=("验收",),
                    clarifications=(),
                    created_at=datetime.now(UTC),
                ),
            )
        finally:
            store.close()
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        assert worker.planning_eligibility(req_id, "plan").eligible is True

    def test_plan_without_analysis_is_refused(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        decision = worker.planning_eligibility(req_id, "plan")
        assert decision.eligible is False
        assert "分析" in decision.reason


def _request(req_id: str, action: str = "analyze") -> ServiceRequest:
    return ServiceRequest(
        request_id=f"{action}-1",
        req_id=req_id,
        project=PROJECT,
        plan_version=0,
        state="pending",
        requested_by="owner",
        source="web",
        action=action,
    )


def _approved(tmp_path: Path) -> str:
    from forgeloop.domain.task_plan import PlannedTask, TaskPlan

    store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：已批准任务包")
        store.record_task_plan(
            requirement.req_id,
            TaskPlan(
                task_plan_id=f"plan-{requirement.req_id}-1",
                requirement_id=requirement.req_id,
                project=PROJECT,
                plan_version=1,
                requirement_version=1,
                tasks=(
                    PlannedTask(
                        task_id="first",
                        goal="实现 first",
                        files=("src/forgeloop/first.py",),
                        acceptance="验收",
                        test_command=("true",),
                    ),
                ),
                created_at=datetime.now(UTC),
            ),
        )
        store.record_plan_approval(requirement.req_id, 1, "owner", source="test")
        return requirement.req_id
    finally:
        store.close()


def _planned(tmp_path: Path) -> str:
    from forgeloop.domain.task_plan import PlannedTask, TaskPlan

    store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：有待核对动作")
        store.record_task_plan(
            requirement.req_id,
            TaskPlan(
                task_plan_id=f"plan-{requirement.req_id}-1",
                requirement_id=requirement.req_id,
                project=PROJECT,
                plan_version=1,
                requirement_version=1,
                tasks=(
                    PlannedTask(
                        task_id="first",
                        goal="实现 first",
                        files=("src/forgeloop/first.py",),
                        acceptance="验收",
                        test_command=("true",),
                    ),
                ),
                created_at=datetime.now(UTC),
            ),
        )
        return requirement.req_id
    finally:
        store.close()


class TestPlanningEligibilityBranches:
    def test_invalid_action_is_refused(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        with pytest.raises(ValueError, match="analyze/plan"):
            worker.planning_eligibility(req_id, "advance")
        with pytest.raises(ValueError, match="操作动作"):
            worker.request_action(req_id, "bogus", by="owner", source="web")

    def test_missing_profile_home_and_mismatch_are_refused(self, tmp_path: Path) -> None:
        req_id = _draft(tmp_path)
        root = tmp_path / "projects" / PROJECT
        no_profile = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        assert no_profile.planning_eligibility(req_id, "analyze").eligible is False
        assert "项目未" in no_profile.planning_eligibility(req_id, "analyze").reason

        no_home = ServiceWorker(
            root,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
            process_home="",
        )
        assert "HOME" in no_home.planning_eligibility(req_id, "analyze").reason

        mismatch = ServiceWorker(
            root,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
            process_home="/tmp/other-home",
        )
        assert "不一致" in mismatch.planning_eligibility(req_id, "analyze").reason

    def test_admission_denied_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = _draft(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        monkeypatch.setattr(
            worker_module,
            "read_managed_admission",
            lambda: type("Admission", (), {"allowed": False, "reason": "draining"})(),
        )
        assert worker.planning_eligibility(req_id, "analyze").reason == "draining"

    def test_authorized_plan_and_outstanding_action_are_refused(self, tmp_path: Path) -> None:
        approved = _approved(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        assert "已批准" in worker.planning_eligibility(approved, "analyze").reason

        outstanding = _planned(tmp_path)
        from forgeloop.records.store import RecordStore

        store = RecordStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            task_id = f"task-{outstanding}-v1-first"
            store.create_task(
                task_id,
                PROJECT,
                "待核对动作",
                {"pi_command": '["pi"]', "test_command": '["true"]'},
                7200.0,
            )
            store.actions.begin(task_id, "dev")
        finally:
            store.close()
        assert "未核对" in worker.planning_eligibility(outstanding, "analyze").reason

    def test_stale_and_unready_analysis_are_refused(self, tmp_path: Path) -> None:
        from forgeloop.domain.requirement import RequirementAnalysis

        stale = _draft(tmp_path)
        store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            store.append(stale, "第二个版本")
            store.record_analysis(
                stale,
                RequirementAnalysis(
                    analysis_version=1,
                    requirement_version=1,
                    goal="旧目标",
                    scenarios=("场景",),
                    acceptance_criteria=("验收",),
                    clarifications=(),
                    created_at=datetime.now(UTC),
                ),
            )
        finally:
            store.close()
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        assert "旧需求版本" in worker.planning_eligibility(stale, "plan").reason

        unready = _draft(tmp_path)
        store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            store.record_analysis(
                unready,
                RequirementAnalysis(
                    analysis_version=1,
                    requirement_version=1,
                    goal="目标",
                    scenarios=(),
                    acceptance_criteria=(),
                    clarifications=("还缺什么?",),
                    created_at=datetime.now(UTC),
                ),
            )
        finally:
            store.close()
        assert "澄清" in worker.planning_eligibility(unready, "plan").reason

    def test_pending_requests_fall_back_to_memory_on_read_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = _draft(tmp_path)
        worker = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )
        worker._pending[req_id] = None
        monkeypatch.setattr(
            "forgeloop.records.service_requests.ServiceRequestStore.pending",
            lambda self: (_ for _ in ()).throw(OSError("库不可读")),
        )
        pending = worker.pending_requests()
        assert [(item.req_id, item.action) for item in pending] == [(req_id, "advance")]


class TestPlanningExecutionBranches:
    def _worker(self, tmp_path: Path) -> ServiceWorker:
        return ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={PROJECT: _profile(tmp_path)},
        )

    def test_missing_terminal_authorized_and_unconfigured_are_skipped(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = _draft(tmp_path)
        worker = self._worker(tmp_path)
        monkeypatch.setattr(
            worker_module.RequirementStore,
            "get",
            lambda self, value: (_ for _ in ()).throw(LookupError("missing")),
        )
        assert worker._run_planning_request(_request(req_id))["status"] == "missing"

    def test_terminal_and_authorized_are_skipped(self, tmp_path: Path) -> None:
        terminal = _draft(tmp_path)
        store = RequirementStore(tmp_path / "projects" / PROJECT / "records.sqlite")
        try:
            store.record_requirement_cancellation(terminal, by="owner", reason="终态")
        finally:
            store.close()
        worker = self._worker(tmp_path)
        assert worker._run_planning_request(_request(terminal))["status"] == "skipped"

        approved = _approved(tmp_path)
        result = worker._run_planning_request(_request(approved))
        assert result["status"] == "skipped"
        assert "已批准" in result["detail"]

        unconfigured = ServiceWorker(
            tmp_path / "projects" / PROJECT,
            poll_seconds=1,
            auto_advance=False,
            projects={},
        )
        result = unconfigured._run_planning_request(_request(terminal))
        assert result["status"] == "skipped"

    def test_analysis_and_planning_outcomes_are_reported(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        req_id = _draft(tmp_path)
        worker = self._worker(tmp_path)

        monkeypatch.setattr(
            worker_module,
            "analyze_requirement",
            lambda ctx: type("Outcome", (), {"analysis": None, "halted_reason": "缺少信息"})(),
        )
        result = worker._run_planning_request(_request(req_id, "analyze"))
        assert result["status"] == "blocked"
        assert result["detail"] == "缺少信息"

        monkeypatch.setattr(
            worker_module,
            "analyze_requirement",
            lambda ctx: (_ for _ in ()).throw(RuntimeError("模型失败")),
        )
        result = worker._run_planning_request(_request(req_id, "analyze"))
        assert result["status"] == "error"
        assert "模型失败" in result["detail"]

        monkeypatch.setattr(
            worker_module,
            "plan_requirement",
            lambda ctx: type(
                "Outcome",
                (),
                {"plan": type("Plan", (), {"plan_version": 2})(), "halted_reason": None},
            )(),
        )
        result = worker._run_planning_request(_request(req_id, "plan"))
        assert result["status"] == "ok"
        assert "v2" in result["detail"]

        monkeypatch.setattr(
            worker_module,
            "plan_requirement",
            lambda ctx: type("Outcome", (), {"plan": None, "halted_reason": "规划畸形"})(),
        )
        result = worker._run_planning_request(_request(req_id, "plan"))
        assert result["status"] == "blocked"

        monkeypatch.setattr(
            worker_module,
            "plan_requirement",
            lambda ctx: (_ for _ in ()).throw(RuntimeError("规划失败")),
        )
        result = worker._run_planning_request(_request(req_id, "plan"))
        assert result["status"] == "error"
