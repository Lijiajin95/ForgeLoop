"""常驻服务与部署批准的项目口径（多项目模式）：一个服务进程服务一个项目。

覆盖三处直接决定 CD/服务行为的判定：``_served_project``（显式/唯一/多项目/旧名/未登记）、
``ServeSettings.records_root``（项目记录根 vs 登记根）、``deploy_section``（无发布/待批准/
已批准）与 ``cli.deploy._approval_root``（部署批准归属项目的 fail-closed 解析）。
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from project_support import project_records, register_project, requirement_store

from forgeloop.cli.deploy import DeployRefused, _approval_root
from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.serve import (
    ServeConfigError,
    ServeOperations,
    ServeSettings,
    _resolve_settings,
    _served_project,
    build_service_document,
    deploy_section,
)
from forgeloop.cli.web import ProgressDocuments, WebSettings
from forgeloop.domain.progress import RefreshSetting, RefreshSource
from forgeloop.domain.release import ReleaseRecord
from forgeloop.domain.service import resolve_service_settings
from forgeloop.graph.worker import ServiceWorker
from forgeloop.records.store import RecordStore

ROOT = Path(__file__).resolve().parents[2]
SERVICE_CONFIG = ROOT / "config" / "service.toml"
WEB_CONFIG = ROOT / "config" / "web.toml"
PROJECTS_FILE = ROOT / "config" / "projects.toml"
DOCUMENTS = ProgressDocuments(_requirement_document, _status_document)
WHEN = datetime(2026, 10, 20, tzinfo=UTC)
DIGEST = "a" * 64


def _stub(_args: argparse.Namespace) -> int:
    return 0


OPERATIONS = ServeOperations(_stub, _stub, _stub)


def _settings(root: Path, project: object | None = None) -> ServeSettings:
    # 测试不依赖本机配置文件：显式给空文档，走内建默认（与无配置机器同一口径）。
    service = resolve_service_settings(None, host=None, port=None)
    web = WebSettings(
        records_root=root,
        host=service.host,
        port=0,
        refresh=RefreshSetting(60, RefreshSource.DEFAULT),
        config_path=WEB_CONFIG,
        documents=DOCUMENTS,
        project_id="" if project is None else getattr(project, "project_id", ""),
    )
    return ServeSettings(
        web=web,
        service=service,
        config_path=SERVICE_CONFIG,
        operations=OPERATIONS,
        projects_path=PROJECTS_FILE,
        project=project,  # type: ignore[arg-type]
    )


def _args(root: Path, **overrides: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "host": None,
        "port": None,
        "refresh_seconds": None,
        "service_config": str(SERVICE_CONFIG),
        "web_config": str(WEB_CONFIG),
        "projects_file": str(PROJECTS_FILE),
        "operations": OPERATIONS,
        "progress_documents": DOCUMENTS,
        "project": "",
        "records_root": str(root),
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class TestServedProject:
    def test_no_registered_project_falls_back_to_none(self, tmp_path: Path) -> None:
        assert _served_project(tmp_path, "") is None

    def test_single_registered_project_is_selected(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        project = _served_project(tmp_path, "")
        assert project is not None and project.project_id == "forgeloop"

    def test_multiple_registered_projects_are_refused(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        with pytest.raises(ServeConfigError, match="多个已登记项目"):
            _served_project(tmp_path, "")

    def test_explicit_project_id_is_used(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        project = _served_project(tmp_path, "forgeloop")
        assert project is not None and project.project_id == "forgeloop"

    def test_explicit_legacy_name_is_resolved(self, tmp_path: Path) -> None:
        register_project(tmp_path, legacy_project="ForgeLoop")
        project = _served_project(tmp_path, "ForgeLoop")
        assert project is not None and project.project_id == "forgeloop"

    def test_unknown_project_is_refused(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        with pytest.raises(ServeConfigError, match="项目未登记"):
            _served_project(tmp_path, "missing")


class TestServeSettingsRoots:
    def test_records_root_follows_the_served_project(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        project = _served_project(tmp_path, "")
        settings = _settings(tmp_path, project)
        assert settings.project_id == "forgeloop"
        assert settings.records_root == project_records(tmp_path)
        assert settings.records_root != settings.web.records_root

    def test_records_root_falls_back_to_registration_root(self, tmp_path: Path) -> None:
        settings = _settings(tmp_path, None)
        assert settings.project_id == ""
        assert settings.records_root == tmp_path
        assert settings.records_root == settings.web.records_root


class TestResolveSettings:
    def test_single_project_wires_records_root_and_web_filter(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        settings = _resolve_settings(_args(tmp_path), tmp_path, SERVICE_CONFIG, WEB_CONFIG)
        assert settings.project is not None and settings.project.project_id == "forgeloop"
        assert settings.web.project_id == "forgeloop"
        assert settings.records_root == project_records(tmp_path)

    def test_explicit_project_selects_that_project(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        args = _args(tmp_path, project="second")
        settings = _resolve_settings(args, tmp_path, SERVICE_CONFIG, WEB_CONFIG)
        assert settings.project is not None and settings.project.project_id == "second"
        assert settings.records_root == project_records(tmp_path, "second")

    def test_multiple_projects_require_an_explicit_choice(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        with pytest.raises(ServeConfigError, match="--project"):
            _resolve_settings(_args(tmp_path), tmp_path, SERVICE_CONFIG, WEB_CONFIG)


def _record_release(project_root: Path, tag: str, digest: str = DIGEST) -> None:
    receipt = project_root / "task-1" / "release-receipt.json"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text('{"artifact_sha256": "' + digest + '"}', encoding="utf-8")
    store = RecordStore(project_root / "records.sqlite")
    try:
        store.outcomes.record_release(
            ReleaseRecord(
                task_id="task-1",
                tag=tag,
                merge_commit="b" * 40,
                baseline_commit="c" * 40,
                diff_sha256="d" * 64,
                receipt_path=str(receipt),
                pushed=True,
                push_detail="pushed",
                released_at=WHEN,
            )
        )
    finally:
        store.close()


class TestDeploySection:
    @pytest.fixture(autouse=True)
    def _no_active_version(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 部署结论只比较「已发布」与「本机激活版本」；测试不依赖本机真实安装。
        monkeypatch.setattr("forgeloop.adapter.deployment.current_version", lambda *a, **k: "")

    def test_without_release_reports_nothing_pending(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        settings = _settings(tmp_path, _served_project(tmp_path, ""))
        section = deploy_section(settings)
        assert section["pending"] is False and section["approved"] is False
        assert "没有已发布版本" in str(section["reason"])

    def test_release_without_approval_is_pending_only(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        _record_release(project_records(tmp_path), "v0.1.0")
        section = deploy_section(_settings(tmp_path, _served_project(tmp_path, "")))
        assert section["pending"] is True and section["approved"] is False
        assert section["released_tag"] == "v0.1.0"

    def test_matching_approval_marks_the_release_approved(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        root = project_records(tmp_path)
        _record_release(root, "v0.1.0")
        store = RecordStore(root / "records.sqlite")
        try:
            store.record_deploy_approval(
                "v0.1.0", DIGEST, by="owner", source="cli:deploy-approve", reason="本机安装"
            )
        finally:
            store.close()
        section = deploy_section(_settings(tmp_path, _served_project(tmp_path, "")))
        assert section["pending"] is True and section["approved"] is True


class TestServiceDocumentProjectScope:
    def test_document_reports_project_and_filters_progress(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("forgeloop.adapter.deployment.current_version", lambda *a, **k: "")
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        store = requirement_store(tmp_path)
        try:
            store.submit("forgeloop", "只属于第一个项目的需求")
        finally:
            store.close()
        project = _served_project(tmp_path, "forgeloop")
        settings = _settings(tmp_path, project)
        worker = ServiceWorker(settings.records_root, poll_seconds=1, auto_advance=False)
        document = build_service_document(settings, worker)
        assert document["project"] == "forgeloop"
        assert document["project_records_root"] == str(project_records(tmp_path))
        assert document["counts"]["projects"] == 1
        assert document["counts"]["requirements"] == 1


class TestDeployApprovalRoot:
    def _args(self, root: Path, project: str = "") -> argparse.Namespace:
        return argparse.Namespace(records_root=str(root), project=project)

    def test_without_registered_project_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(DeployRefused, match="没有已登记项目"):
            _approval_root(self._args(tmp_path))

    def test_single_project_is_used(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        assert _approval_root(self._args(tmp_path)) == project_records(tmp_path)

    def test_explicit_project_is_used(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        assert _approval_root(self._args(tmp_path, "second")) == project_records(tmp_path, "second")

    def test_multiple_projects_require_an_explicit_choice(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        register_project(tmp_path, "second", name="Second")
        with pytest.raises(DeployRefused, match="多个已登记项目"):
            _approval_root(self._args(tmp_path))

    def test_unknown_explicit_project_is_refused(self, tmp_path: Path) -> None:
        register_project(tmp_path)
        with pytest.raises(DeployRefused, match="项目未登记"):
            _approval_root(self._args(tmp_path, "missing"))


class TestTextRenderingAndStopHandlers:
    """人读输出与停止钩子的两条分支（--once 文本与信号安装/跳过）。"""

    def test_service_text_handles_missing_and_present_sections(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        from forgeloop.cli.serve import _emit, service_text

        # 缺字段：项目档案与可执行项目回落到明确的“无”，不猜。
        minimal = {"records_root": "/tmp/x", "config_path": "/tmp/c.toml"}
        lines = service_text(minimal)
        assert any("项目档案: 无（只提供只读页面）" in line for line in lines)
        assert any("可执行项目: 无（PI HOME 与进程 HOME 不一致或未配置）" in line for line in lines)
        assert any("本轮候选: 0 条，跳过 0 条" in line for line in lines)

        # 全字段：项目档案、可执行项目与上一拍的候选都要如实呈现。
        full = {
            "records_root": "/tmp/x",
            "config_path": "/tmp/c.toml",
            "projects": ["forgeloop", "second"],
            "counts": {"requirements": 2, "tasks": 3},
            "review_required": [{"kind": "task_blocked", "ref_id": "task-1"}],
            "worker": {
                "poll_seconds": 2,
                "auto_advance": True,
                "executable_projects": ["forgeloop"],
                "last_tick": {"candidates": ["req-1"], "skipped": {"req-2": "未批准"}},
            },
        }
        lines = service_text(full)
        assert any("项目档案: forgeloop、second" in line for line in lines)
        assert any("可执行项目: forgeloop" in line for line in lines)
        assert any("本轮候选: 1 条，跳过 1 条" in line for line in lines)

        # --once 的两种输出形态：JSON 独占 stdout，人读按行打印。
        _emit({"a": 1}, True)
        assert json.loads(capsys.readouterr().out) == {"a": 1}
        _emit(minimal, False)
        assert "常驻服务自检" in capsys.readouterr().out

    def test_stop_handlers_skip_outside_main_thread(self) -> None:
        import threading

        from forgeloop.cli.serve import _install_stop_handlers

        captured: dict[str, object] = {}

        def run() -> None:
            captured["previous"] = _install_stop_handlers(threading.Event())

        thread = threading.Thread(target=run)
        thread.start()
        thread.join()
        assert captured["previous"] == {}

    def test_stop_handlers_install_and_restore_in_main_thread(self) -> None:
        import threading

        from forgeloop.cli.serve import _install_stop_handlers, _restore_stop_handlers

        stop = threading.Event()
        previous = _install_stop_handlers(stop)
        try:
            assert previous, "主线程应安装停止钩子并返回原处理器"
        finally:
            _restore_stop_handlers(previous)


class TestRecordsRootIsAbsolute:
    """``--records-root`` 一律绝对化：相对值会让 worktree 与子进程解析到不同目录。

    2026-10-20 实测：常驻服务用相对记录根时任务停在 implementing（动作未释放），
    绝对路径下正常到验收门；e2e 现场用的正是相对路径。
    """

    def test_relative_records_root_becomes_absolute(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from forgeloop.cli.common import base_records_root, records_root

        monkeypatch.chdir(tmp_path)
        args = argparse.Namespace(records_root="relative-root")
        assert base_records_root(args) == (tmp_path / "relative-root").resolve()
        register_project(tmp_path)
        args = argparse.Namespace(records_root=".", project="forgeloop")
        resolved = records_root(args)
        assert resolved.is_absolute()
        assert resolved == project_records(tmp_path)
