"""状态页的对外契约与跨语言一致性测试（无浏览器）。

页面行为代码已是 TypeScript（``frontend/src``，编译为随包模块
``src/forgeloop/cli/static/*.js``），因此「元素 id 与脚本是否对得上」由前端的
jsdom 组件测试与真实浏览器用例覆盖（``frontend/tests``）。留在 Python 侧的是三条
跨语言与打包契约：

1. ``/api/progress`` 的字段结构——页面表格直接读它，改名即页面空白；
2. 页面 HTML 只引用随包模块，不引用任何外部资源（离线可用）；
3. 前端重试节奏常量与服务端内建默认（``domain.progress.DEFAULT_REFRESH_SECONDS``）
   同值，端点路径与服务端路由同值。
"""

import re
import tomllib
from pathlib import Path

import pytest

from forgeloop.cli.main import _requirement_document, _status_document
from forgeloop.cli.web import (
    ProgressDocuments,
    build_progress_document,
    page_html,
    page_module,
    static_dir,
)
from forgeloop.domain.progress import DEFAULT_REFRESH_SECONDS, RefreshSetting, RefreshSource

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_SRC = ROOT / "frontend" / "src"
# 页面行为代码必须随包分发；这些名字由 frontend/src 的模块决定（漂移门禁核对内容）。
PAGE_MODULES = (
    "actions.js",
    "app.js",
    "dom.js",
    "format.js",
    "link.js",
    "page.js",
    "panel.js",
    "panel_render.js",
    "panel_tools.js",
    "payload.js",
    "progress.js",
    "render.js",
    "tabs.js",
)

TOP_LEVEL_FIELDS = (
    "schema_version",
    "generated_at",
    "records_root",
    "refresh_seconds",
    "refresh_source",
    "projects",
    "counts",
    "requirements",
    "tasks",
    "issues",
)
COUNT_FIELDS = ("projects", "requirements", "tasks", "issues")
# 页面表格直接读取的字段：改名即页面空白，因此在这里固定。
REQUIREMENT_FIELDS = (
    "req_id",
    "project",
    "requirement_status",
    "plan",
    "versions",
    "tasks",
    "next_step",
    "blocked_reason",
    "blocked_reason_text",
)
# 需求任务包条目：页面用它把需求分解出的任务与任务段按身份对上。
REQUIREMENT_TASK_FIELDS = ("task_id", "single_task_id", "state")
# 需求原文版本：页面的需求描述读最新一版的文本。
REQUIREMENT_VERSION_FIELDS = ("version", "text")
# 任务包摘要：页面的任务描述读 goal。
TASK_PLAN_FIELDS = ("goal",)
TASK_FIELDS = (
    "task_id",
    "project",
    "status",
    "plan",
    "next_action",
    "failures",
    "budget",
    "blocked_reason_text",
)
FAILURE_FIELDS = ("cumulative", "remaining_in_current_grant", "awaiting_grant_decision")
BUDGET_FIELDS = ("consumed_seconds", "limit_seconds")
ISSUE_FIELDS = ("kind", "project", "ref_id", "summary", "detail")
ISSUE_KIND_LABELS = {
    "task_blocked",
    "task_interrupted",
    "task_grant_required",
    "task_time_exhausted",
    "task_stop_requested",
    "requirement_blocked",
    "slot_residue",
    "outstanding_action",
}
REFRESH_SOURCE_LABELS = {"cli", "config", "default"}


def frontend_source(name: str) -> str:
    return (FRONTEND_SRC / name).read_text(encoding="utf-8")


@pytest.fixture()
def page() -> str:
    return page_html()


class TestPageAssets:
    def test_page_loads_the_module_entry(self, page: str) -> None:
        assert '<script type="module" src="/app.js"></script>' in page

    def test_page_has_no_external_resource(self, page: str) -> None:
        """离线可用：不引用任何外部脚本、样式或字体。"""

        assert "http://" not in page and "https://" not in page
        assert "<link" not in page

    def test_page_carries_no_inline_behaviour(self, page: str) -> None:
        """行为代码只在 TypeScript 源里：HTML 不再内联脚本（避免绕过类型与 lint 门禁）。"""

        assert "<script>" not in page

    def test_page_carries_the_token_placeholder_and_operation_panel(self, page: str) -> None:
        """写入口的页面契约：令牌 meta（占位形式）与操作面板的元素 id 必须存在。"""

        assert 'name="forgeloop-token"' in page
        assert "__FORGELOOP_TOKEN__" in page
        for element_id in (
            "operations",
            "submit-form",
            "submit-project",
            "submit-text",
            "operations-by",
            "submit-reason",
            "submit-button",
            "action-req",
            "action-reason",
            "action-approve",
            "action-advance",
            "action-accept",
            "action-stop",
            "operations-status",
        ):
            assert f'id="{element_id}"' in page, element_id

    @pytest.mark.parametrize("name", PAGE_MODULES)
    def test_module_is_shipped_in_the_package(self, name: str) -> None:
        assert page_module(name) is not None
        assert (static_dir() / name).is_file()

    @pytest.mark.parametrize(
        "name",
        ["../web.py", "web.py", "static/app.js", "app.js/../format.js", "APP.JS", "app.jsx"],
    )
    def test_module_name_outside_the_pattern_is_refused(self, name: str) -> None:
        assert page_module(name) is None

    def test_unknown_module_is_refused(self, name: str = "nope.js") -> None:
        assert page_module(name) is None


class TestCrossLanguageContracts:
    def test_progress_url_matches_the_server_route(self) -> None:
        source = frontend_source("payload.ts")
        match = re.search(r'PROGRESS_URL = "([^"]+)"', source)
        assert match is not None, "payload.ts 里找不到端点常量"
        assert match.group(1) == "/api/progress"

    def test_frontend_retry_fallback_matches_the_builtin_default(self) -> None:
        """前端读不到配置时的重试节奏必须与服务端内建默认同值，不能各写一个数。"""

        source = frontend_source("progress.ts")
        match = re.search(r"FALLBACK_REFRESH_SECONDS = (\d+)", source)
        assert match is not None, "progress.ts 里找不到重试节奏常量"
        assert int(match.group(1)) == DEFAULT_REFRESH_SECONDS


class TestApiFieldContract:
    @pytest.fixture()
    def document(self, tmp_path: Path) -> dict:
        from datetime import UTC, datetime

        from forgeloop.domain.project import project_data_root
        from forgeloop.domain.task_plan import PlannedTask, TaskPlan
        from forgeloop.records.projects import ProjectStore, project_records_path
        from forgeloop.records.requirements import RequirementStore
        from forgeloop.records.store import RecordStore

        base = tmp_path / ".forgeloop"
        base.mkdir()
        projects = ProjectStore(project_records_path(base))
        try:
            projects.add("forgeloop", "ForgeLoop", str(tmp_path / "repo"))
        finally:
            projects.close()
        root = project_data_root(base, "forgeloop")
        root.mkdir(parents=True)
        store = RecordStore(root / "records.sqlite")
        try:
            store.create_task(
                "task-1",
                "forgeloop",
                "原始需求文本",
                {"pi_command": '["pi"]', "test_command": '["pytest"]'},
                limit_seconds=100.0,
            )
            store.set_task_status("task-1", "blocked")
        finally:
            store.close()
        requirement_store = RequirementStore(root / "records.sqlite")
        try:
            requirement = requirement_store.submit("forgeloop", "页面要显示需求进展")
            # 页面按身份把需求分解出的任务与任务段串起来，因此这里必须真有任务包条目。
            requirement_store.record_task_plan(
                requirement.req_id,
                TaskPlan(
                    task_plan_id="plan-page",
                    requirement_id=requirement.req_id,
                    project="forgeloop",
                    plan_version=1,
                    requirement_version=1,
                    tasks=(
                        PlannedTask(
                            task_id="first",
                            goal="把状态页分成需求、任务、问题三段",
                            files=("frontend/src/render.ts",),
                            acceptance="三个页签按身份串起来",
                            test_command=("pytest", "-q"),
                        ),
                    ),
                    created_at=datetime.now(UTC),
                ),
            )
        finally:
            requirement_store.close()
        documents = ProgressDocuments(_requirement_document, _status_document)
        return build_progress_document(base, RefreshSetting(60, RefreshSource.DEFAULT), documents)

    def test_top_level_fields_and_counts(self, document: dict) -> None:
        for field in TOP_LEVEL_FIELDS:
            assert field in document, field
        for field in COUNT_FIELDS:
            assert field in document["counts"], field

    def test_requirement_and_task_fields(self, document: dict) -> None:
        requirement = document["requirements"][0]
        task = document["tasks"][0]
        for field in REQUIREMENT_FIELDS:
            assert field in requirement, field
        assert requirement["versions"], "需求必须带原文版本，否则卡片没有描述可显示"
        for version in requirement["versions"]:
            for field in REQUIREMENT_VERSION_FIELDS:
                assert field in version, field
        for entry in requirement["tasks"]:
            for field in REQUIREMENT_TASK_FIELDS:
                assert field in entry, field
        for field in TASK_FIELDS:
            assert field in task, field
        # 单任务流程创建的任务可能没有任务包（plan 为 null）；有任务包时必须带目标。
        plan = task["plan"]
        if plan is not None:
            for field in TASK_PLAN_FIELDS:
                assert field in plan, field
        for field in FAILURE_FIELDS:
            assert field in task["failures"], field
        for field in BUDGET_FIELDS:
            assert field in task["budget"], field

    def test_issue_fields_and_known_labels(self, document: dict) -> None:
        assert document["issues"], "阻断任务必须产生问题项"
        for issue in document["issues"]:
            for field in ISSUE_FIELDS:
                assert field in issue, field
            assert issue["kind"] in ISSUE_KIND_LABELS

    def test_unreleased_action_becomes_its_own_issue(self, tmp_path: Path) -> None:
        """未核对动作独立成项：任务状态仍是进行中，但必须出现在页面「问题」段。"""

        from forgeloop.cli.web import ProgressDocuments
        from forgeloop.domain.project import project_data_root
        from forgeloop.records.projects import ProjectStore, project_records_path
        from forgeloop.records.store import RecordStore

        # 多项目模式：业务记录在项目的记录根下（页面按项目聚合），登记根不再有业务库。
        base = tmp_path / ".forgeloop"
        base.mkdir()
        projects = ProjectStore(project_records_path(base))
        try:
            projects.add("forgeloop", "ForgeLoop", str(tmp_path / "repo"))
        finally:
            projects.close()
        root = project_data_root(base, "forgeloop")
        root.mkdir(parents=True)
        store = RecordStore(root / "records.sqlite")
        try:
            store.create_task(
                "task-1",
                "forgeloop",
                "原始需求文本",
                {"pi_command": '["pi"]', "test_command": '["pytest"]'},
                limit_seconds=100.0,
            )
            store.set_task_status("task-1", "implementing")
            store.actions.begin("task-1", "dev")
        finally:
            store.close()
        documents = ProgressDocuments(_requirement_document, _status_document)

        document = build_progress_document(
            base, RefreshSetting(60, RefreshSource.DEFAULT), documents
        )

        kinds = [issue["kind"] for issue in document["issues"]]
        assert "outstanding_action" in kinds
        issue = next(item for item in document["issues"] if item["kind"] == "outstanding_action")
        assert issue["ref_id"] == "task-1"
        assert "禁止盲目重放" in issue["summary"]
        assert "dev" in issue["detail"]
        assert "actions list" in issue["detail"]

    def test_refresh_source_is_a_label_the_page_knows(self, document: dict) -> None:
        assert document["refresh_source"] in REFRESH_SOURCE_LABELS

    def test_frontend_defines_a_label_for_every_issue_kind(self) -> None:
        """问题种类是跨语言词表：服务端新增种类必须同时给出前端标签。"""

        source = frontend_source("format.ts")
        for kind in ISSUE_KIND_LABELS:
            assert f"{kind}:" in source, kind


class TestShippedConfig:
    def test_refresh_defaults_of_the_shipped_config(self) -> None:
        """随仓库分发的配置项默认每 1 分钟刷新一次，与文档一致。"""

        config = tomllib.loads((ROOT / "config" / "web.toml").read_text(encoding="utf-8"))
        assert config["refresh_seconds"] == DEFAULT_REFRESH_SECONDS
