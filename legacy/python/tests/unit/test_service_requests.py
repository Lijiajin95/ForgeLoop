"""持久推进请求：受理前落库、重复请求幂等、消费只一次。

方案 §3.4：`_pending` 只是调度提示，跨切换保留的显式推进请求必须先写进项目库，
入口才能返回“已受理”；重建 worker 后仍能看到待处理请求。
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import register_project

from forgeloop.domain.task_plan import PlannedTask, TaskLimits, TaskPlan
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.service_requests import ServiceRequestStore

PROJECT = "forgeloop"
WHEN = datetime(2026, 10, 21, 8, 0, tzinfo=UTC)


def _request_store(root: Path) -> ServiceRequestStore:
    return ServiceRequestStore(root / "records.sqlite")


def _requirement(root: Path) -> str:
    register_project(root)
    store = RequirementStore(root / "projects" / PROJECT / "records.sqlite")
    try:
        requirement = store.submit(PROJECT, "需求：热升级期间持久推进")
        plan = TaskPlan(
            task_plan_id=f"plan-{requirement.req_id}-1",
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=1,
            requirement_version=requirement.version_count,
            tasks=(
                PlannedTask(
                    task_id="first",
                    goal="实现 first",
                    files=("src/forgeloop/first.py",),
                    acceptance="first 的验收标准",
                    test_command=("true",),
                    limits=TaskLimits(limit_seconds=7200.0, max_failure_rounds=3),
                ),
            ),
            created_at=WHEN,
        )
        store.record_task_plan(requirement.req_id, plan)
        store.record_plan_approval(requirement.req_id, 1, "owner", source="test")
        return requirement.req_id
    finally:
        store.close()


class TestPersistAndDeduplicate:
    def test_request_is_persisted_and_readable_after_reopen(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            request = store.record(
                req_id=req_id,
                project=PROJECT,
                plan_version=1,
                requested_by="owner",
                source="web",
            )
            assert request.state == "pending"
            assert request.request_id
        finally:
            store.close()

        reopened = _request_store(tmp_path / "projects" / PROJECT)
        try:
            pending = reopened.pending()
            assert [item.req_id for item in pending] == [req_id]
            assert pending[0].plan_version == 1
            assert pending[0].requested_by == "owner"
        finally:
            reopened.close()

    def test_same_requirement_while_pending_returns_existing_request(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            first = store.record(
                req_id=req_id, project=PROJECT, plan_version=1, requested_by="a", source="web"
            )
            second = store.record(
                req_id=req_id, project=PROJECT, plan_version=1, requested_by="b", source="web"
            )
            assert first.request_id == second.request_id
            assert len(store.pending()) == 1
        finally:
            store.close()

    def test_same_request_id_with_different_payload_is_refused(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            store.record(
                req_id=req_id,
                project=PROJECT,
                plan_version=1,
                requested_by="owner",
                source="web",
                request_id="request-1",
            )
            with pytest.raises(ValueError, match="不同"):
                store.record(
                    req_id=req_id,
                    project=PROJECT,
                    plan_version=2,
                    requested_by="owner",
                    source="web",
                    request_id="request-1",
                )
        finally:
            store.close()


class TestConsumeOnce:
    def test_consume_is_at_most_once(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            request = store.record(
                req_id=req_id, project=PROJECT, plan_version=1, requested_by="owner", source="web"
            )
            assert store.consume(request.request_id, detail="executed") is True
            assert store.consume(request.request_id, detail="again") is False
            assert store.pending() == ()
            consumed = store.get(request.request_id)
            assert consumed is not None
            assert consumed.state == "consumed"
            assert consumed.detail == "executed"
        finally:
            store.close()

    def test_consume_rejects_wrong_state(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            request = store.record(
                req_id=req_id, project=PROJECT, plan_version=1, requested_by="owner", source="web"
            )
            store.dismiss(req_id, reason="需求已取消")
            assert store.consume(request.request_id) is False
        finally:
            store.close()

    def test_dismiss_clears_pending_without_consuming(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            request = store.record(
                req_id=req_id, project=PROJECT, plan_version=1, requested_by="owner", source="web"
            )
            assert store.dismiss(req_id, reason="需求已进入终态") is True
            assert store.pending() == ()
            dismissed = store.get(request.request_id)
            assert dismissed is not None and dismissed.state == "dismissed"
        finally:
            store.close()


class TestValidation:
    @pytest.mark.parametrize(
        ("kwargs", "needle"),
        [
            ({"req_id": ""}, "需求身份"),
            ({"project": ""}, "项目"),
            ({"plan_version": -1}, "任务包版本"),
            ({"requested_by": ""}, "调用方"),
            ({"source": ""}, "来源"),
        ],
    )
    def test_invalid_fields_are_refused(self, tmp_path: Path, kwargs: dict, needle: str) -> None:
        base = {
            "req_id": "req-1",
            "project": PROJECT,
            "plan_version": 1,
            "requested_by": "owner",
            "source": "web",
        }
        base.update(kwargs)
        store = _request_store(tmp_path)
        try:
            with pytest.raises(ValueError, match=needle):
                store.record(**base)
            assert store.pending() == ()
        finally:
            store.close()


class TestWorkerReload:
    def test_worker_accepts_and_reloads_pending_request(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        root = tmp_path / "projects" / PROJECT
        first = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        first.request_advance(req_id, by="owner", source="web")
        assert first.pending_advance() == (req_id,)

        # 模拟换代/重建 worker：内存提示消失，持久请求仍在。
        second = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        assert second.pending_advance() == (req_id,)

    def test_claim_consumes_so_a_second_worker_does_not_replay(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        root = tmp_path / "projects" / PROJECT
        first = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        first.request_advance(req_id, by="owner", source="web")
        assert first.claim_pending_advance() == (req_id,)
        assert first.pending_advance() == ()

        second = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        assert second.pending_advance() == ()
        assert second.claim_pending_advance() == ()

    def test_request_without_task_plan_records_zero_version(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        root = tmp_path / "projects" / PROJECT
        store = RequirementStore(root / "records.sqlite")
        try:
            requirement = store.submit(PROJECT, "需求：还没有任务包")
        finally:
            store.close()
        worker = ServiceWorker(root, poll_seconds=1, auto_advance=False, projects={})
        request = worker.request_advance(requirement.req_id, by="owner", source="web")
        assert request.plan_version == 0
        assert worker.pending_advance() == (requirement.req_id,)


class TestActionField:
    def test_action_is_persisted_and_reloaded(self, tmp_path: Path) -> None:
        req_id = _requirement(tmp_path)
        store = _request_store(tmp_path / "projects" / PROJECT)
        try:
            request = store.record(
                req_id=req_id,
                project=PROJECT,
                plan_version=1,
                requested_by="owner",
                source="web",
                action="plan",
            )
            assert request.action == "plan"
            assert store.pending()[0].action == "plan"
        finally:
            store.close()

    def test_unknown_action_is_refused(self, tmp_path: Path) -> None:
        store = _request_store(tmp_path)
        try:
            with pytest.raises(ValueError, match="动作"):
                store.record(
                    req_id="req-1",
                    project=PROJECT,
                    plan_version=0,
                    requested_by="owner",
                    source="web",
                    action="bogus",
                )
            assert store.pending() == ()
        finally:
            store.close()

    def test_old_database_without_action_column_is_migrated(self, tmp_path: Path) -> None:
        import sqlite3

        db = tmp_path / "records.sqlite"
        connection = sqlite3.connect(db)
        connection.executescript(
            "CREATE TABLE service_requests ("
            " request_id TEXT PRIMARY KEY, req_id TEXT NOT NULL, project TEXT NOT NULL,"
            " plan_version INTEGER NOT NULL, state TEXT NOT NULL,"
            " requested_by TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',"
            " created_at TEXT NOT NULL, resolved_at TEXT, detail TEXT NOT NULL DEFAULT '');"
            "INSERT INTO service_requests"
            " (request_id, req_id, project, plan_version, state, requested_by, source,"
            " created_at, detail) VALUES"
            " ('old-1', 'req-old', 'forgeloop', 0, 'pending', 'owner', 'web',"
            " '2026-10-21T00:00:00+00:00', '');"
        )
        connection.commit()
        connection.close()

        store = ServiceRequestStore(db)
        try:
            pending = store.pending()
            assert [(item.request_id, item.action) for item in pending] == [("old-1", "advance")]
        finally:
            store.close()
