"""A02 需求只读分析场景：结构化输出、等待澄清、畸形阻塞、版本保留、源码零变化。

用自带的假 PI（讲 PI JSONL RPC 协议）驱动 ``graph.planning.analyze_requirement``：
分析角色在独立分析目录内运行，结果经真实 SQLite 记录回查，覆盖：
- 信息充分时产出可审阅的目标/场景/验收标准；
- 缺关键信息（待澄清项非空）时等待回答，状态 ``awaiting_clarification``；
- 畸形、自然语言、未 settle、模型错误都如实置 ``blocked`` 并保留原因；
- 回答澄清后重新分析，分析版本与需求版本都只追加；
- 分析阶段不接触被测项目，源码零变化。

不经过 CLI：A02 的文件范围不含 CLI 入口，入口接线属于 I01。
"""

import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.requirement import (
    AWAITING_CLARIFICATION,
    BLOCKED,
    DRAFT,
    RequirementAnalysis,
    RequirementError,
    RequirementNotFoundError,
)
from forgeloop.graph.planning import PlanningContext, analyze_requirement
from forgeloop.records.requirements import RequirementStore

WHEN = datetime(2026, 10, 13, 10, 0, tzinfo=UTC)

READY_RESULT = {
    "goal": "status 输出下一步动作",
    "scenarios": ["完成任务后查看状态", "阻塞时查看原因"],
    "acceptance_criteria": ["status --json 含 next_action 与 blocker"],
    "clarifications": [],
}

PLANNING_PI = r"""
import json
import os
import sys


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(request, success=True, data=None):
    record = {
        "id": request.get("id"),
        "type": "response",
        "command": request.get("type"),
        "success": success,
    }
    if data is not None:
        record["data"] = data
    emit(record)


cwd_log = os.environ.get("FAKE_PLANNING_CWD_LOG")
if cwd_log:
    with open(cwd_log, "a", encoding="utf-8") as handle:
        handle.write(os.getcwd() + "\n")

mode = os.environ.get("FAKE_PLANNING_MODE", "payload")
result = os.environ.get("FAKE_PLANNING_RESULT", "")
text = ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "prompt":
        if mode == "reject":
            respond(request, False, {"error": "prompt rejected"})
            continue
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        if mode == "unsettled":
            emit({"type": "agent_end", "messages": [], "willRetry": False})
            sys.exit(0)
        if mode == "aborted":
            emit({"type": "agent_end", "messages": [], "willRetry": False})
            emit({"type": "agent_settled", "aborted": True})
            text = result
            continue
        if mode == "model-error":
            emit({
                "type": "agent_end",
                "messages": [
                    {"role": "assistant", "stopReason": "error", "errorMessage": "403 subscription"}
                ],
                "willRetry": False,
            })
            emit({"type": "agent_settled", "aborted": False})
            text = ""
            continue
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
        if mode == "plain-text":
            text = "这是自然语言分析，没有 JSON 结构。"
        elif mode == "malformed":
            text = json.dumps({"summary": "缺少 goal 等字段"}, ensure_ascii=False)
        else:
            text = result
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": "unknown command"})
"""


@dataclass
class Scene:
    """一个分析现场：真实记录库、假 PI、独立分析目录与 PI cwd 记录。"""

    store: RequirementStore
    req_id: str
    command: tuple[str, ...]
    analysis_dir: Path
    cwd_log: Path

    def context(self) -> PlanningContext:
        return PlanningContext(self.store, self.req_id, self.analysis_dir, self.command)


def make_scene(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: dict | None = None,
    mode: str = "payload",
    text: str = "原始需求：给 status 增加下一步动作",
) -> Scene:
    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", text)
    script = tmp_path / "planning_pi.py"
    script.write_text(PLANNING_PI, encoding="utf-8")
    cwd_log = tmp_path / "pi-cwd.log"
    monkeypatch.setenv("FAKE_PLANNING_MODE", mode)
    monkeypatch.setenv(
        "FAKE_PLANNING_RESULT", json.dumps(result if result is not None else {}, ensure_ascii=False)
    )
    monkeypatch.setenv("FAKE_PLANNING_CWD_LOG", str(cwd_log))
    analysis_dir = tmp_path / "requirements" / requirement.req_id / "planning"
    return Scene(
        store=store,
        req_id=requirement.req_id,
        command=(sys.executable, str(script)),
        analysis_dir=analysis_dir,
        cwd_log=cwd_log,
    )


class TestStructuredAnalysis:
    def test_clear_requirement_yields_reviewable_analysis(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
        try:
            outcome = analyze_requirement(scene.context())
            stored = scene.store.latest_analysis(scene.req_id)
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == DRAFT
        assert status == outcome.requirement_status  # 返回值与落库状态同源
        assert outcome.is_ready is True
        assert outcome.needs_clarification is False
        assert outcome.analysis is not None
        assert outcome.analysis.goal == "status 输出下一步动作"
        assert outcome.analysis.scenarios == ("完成任务后查看状态", "阻塞时查看原因")
        assert outcome.analysis.acceptance_criteria == ("status --json 含 next_action 与 blocker",)
        assert outcome.analysis.clarifications == ()
        assert outcome.analysis.analysis_version == 1
        assert outcome.analysis.requirement_version == 1
        assert stored == outcome.analysis  # 结构化结果落库、可回查

    def test_missing_key_information_waits_for_answers(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result={
                "goal": "增加注释能力",
                "scenarios": [],
                "acceptance_criteria": [],
                "clarifications": ["注释保存到哪里?", "需要支持哪些格式?"],
            },
        )
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            latest = scene.store.latest_analysis(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == AWAITING_CLARIFICATION
        assert outcome.needs_clarification is True
        assert outcome.is_ready is False
        assert outcome.analysis is not None
        assert outcome.analysis.clarifications == ("注释保存到哪里?", "需要支持哪些格式?")
        assert status == AWAITING_CLARIFICATION
        assert latest is not None and latest.needs_clarification
        assert latest is not None and latest.is_ready is False

    def test_analysis_survives_reopen(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
        outcome = analyze_requirement(scene.context())
        scene.store.close()

        reopened = RequirementStore(tmp_path / "records.sqlite")
        try:
            stored = reopened.latest_analysis(scene.req_id)
            status = reopened.requirement_status(scene.req_id)
        finally:
            reopened.close()

        assert outcome.analysis is not None
        assert stored is not None and stored == outcome.analysis
        assert status == DRAFT
        assert stored.is_ready is True

    def test_unknown_requirement_fails_explicitly(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        script = tmp_path / "planning_pi.py"
        script.write_text(PLANNING_PI, encoding="utf-8")
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            context = PlanningContext(
                store, "req-unknown", tmp_path / "analysis", (sys.executable, str(script))
            )
            with pytest.raises(RequirementNotFoundError):
                analyze_requirement(context)
        finally:
            store.close()


class TestMalformedResultsBlock:
    @pytest.mark.parametrize(
        ("mode", "needle"),
        [
            ("malformed", "analysis_malformed"),
            ("plain-text", "analysis_malformed"),
        ],
    )
    def test_non_structured_results_block(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, needle: str
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, mode=mode)
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            reason = scene.store.blocked_reason(scene.req_id)
            latest = scene.store.latest_analysis(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.analysis is None
        assert outcome.halted_reason is not None and needle in outcome.halted_reason
        assert status == BLOCKED
        assert needle in reason
        assert latest is None  # 畸形结果不产生分析版本

    def test_wrong_field_types_block(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result={
                "goal": "目标",
                "scenarios": "不是数组",
                "acceptance_criteria": [],
                "clarifications": [],
            },
        )
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert "analysis_malformed" in (outcome.halted_reason or "")
        assert status == BLOCKED

    def test_incomplete_analysis_without_clarifications_blocks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result={
                "goal": "目标",
                "scenarios": [],
                "acceptance_criteria": ["通过"],
                "clarifications": [],
            },
        )
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert status == BLOCKED

    @pytest.mark.parametrize(
        ("mode", "needle"),
        [
            ("unsettled", "analysis_unsettled"),
            ("model-error", "analysis_model_error"),
            ("reject", "analysis_unsettled"),
        ],
    )
    def test_unfinished_pi_results_block(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, needle: str
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, mode=mode)
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
            reason = scene.store.blocked_reason(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.analysis is None
        assert outcome.halted_reason is not None and needle in outcome.halted_reason
        assert status == BLOCKED
        assert needle in reason


class TestClarificationVersions:
    def test_answer_triggers_new_analysis_and_keeps_versions(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(
            tmp_path,
            monkeypatch,
            result={
                "goal": "增加注释能力",
                "scenarios": [],
                "acceptance_criteria": [],
                "clarifications": ["注释保存到哪里?"],
            },
        )
        try:
            first = analyze_requirement(scene.context())
            assert first.requirement_status == AWAITING_CLARIFICATION
            assert first.is_ready is False
            # 回答澄清 = 追加需求版本；旧分析过期，状态回到 draft 等待重新分析。
            scene.store.append(scene.req_id, "回答：注释保存到本地 records 目录")
            assert scene.store.requirement_status(scene.req_id) == DRAFT

            monkeypatch.setenv(
                "FAKE_PLANNING_RESULT",
                json.dumps(
                    {
                        "goal": "增加注释能力",
                        "scenarios": ["创建注释并回查"],
                        "acceptance_criteria": ["注释可从记录回查"],
                        "clarifications": [],
                    },
                    ensure_ascii=False,
                ),
            )
            second = analyze_requirement(scene.context())
            versions = scene.store.analyses(scene.req_id)
            requirement = scene.store.get(scene.req_id)
        finally:
            scene.store.close()

        assert second.requirement_status == DRAFT
        assert second.is_ready is True
        assert [item.analysis_version for item in versions] == [1, 2]
        assert [item.requirement_version for item in versions] == [1, 2]
        assert versions[0].needs_clarification is True
        assert versions[1].needs_clarification is False
        assert requirement.version_count == 2
        assert requirement.original_text == "原始需求：给 status 增加下一步动作"


class TestReadOnlyAnalysis:
    def test_analysis_does_not_touch_the_project_sources(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        project = tmp_path / "project"
        project.mkdir()
        (project / "app.py").write_text("print('baseline')\n", encoding="utf-8")
        (project / "notes.txt").write_text("keep\n", encoding="utf-8")
        before = {
            path.relative_to(project).as_posix(): path.read_bytes()
            for path in project.rglob("*")
            if path.is_file()
        }

        scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
        try:
            outcome = analyze_requirement(scene.context())
        finally:
            scene.store.close()

        after = {
            path.relative_to(project).as_posix(): path.read_bytes()
            for path in project.rglob("*")
            if path.is_file()
        }
        assert outcome.requirement_status == DRAFT
        assert outcome.is_ready is True
        assert after == before  # 分析阶段源码零变化

        recorded = [
            Path(line).resolve() for line in scene.cwd_log.read_text(encoding="utf-8").splitlines()
        ]
        assert recorded == [scene.analysis_dir.resolve()]
        assert scene.analysis_dir.resolve() != project.resolve()
        assert not (scene.analysis_dir / "app.py").exists()


class TestAnalysisGuards:
    """A02 防御分支：畸形字段、版本越界、旧库迁移、未知身份与空命令都明确失败。"""

    def test_empty_pi_command_is_rejected(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            with pytest.raises(ValueError, match="PI command"):
                PlanningContext(store, "req-x", tmp_path / "analysis", ())
        finally:
            store.close()

    def test_aborted_pi_blocks(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        scene = make_scene(tmp_path, monkeypatch, mode="aborted")
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.halted_reason == "analysis_aborted"
        assert status == BLOCKED

    @pytest.mark.parametrize(
        "payload",
        [
            {
                "goal": "目标",
                "scenarios": [123],
                "acceptance_criteria": ["通过"],
                "clarifications": [],
            },
            {
                "goal": "目标",
                "scenarios": ["  "],
                "acceptance_criteria": ["通过"],
                "clarifications": [],
            },
            {
                "goal": "   ",
                "scenarios": ["场景"],
                "acceptance_criteria": ["通过"],
                "clarifications": [],
            },
        ],
    )
    def test_invalid_analysis_fields_block(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, payload: dict
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=payload)
        try:
            outcome = analyze_requirement(scene.context())
            status = scene.store.requirement_status(scene.req_id)
        finally:
            scene.store.close()

        assert outcome.requirement_status == BLOCKED
        assert "analysis_malformed" in (outcome.halted_reason or "")
        assert status == BLOCKED

    def test_analysis_version_must_start_at_one(self) -> None:
        with pytest.raises(RequirementError, match="分析版本号"):
            RequirementAnalysis(0, 1, "目标", ("场景",), ("验收",), (), WHEN)

    def test_analysis_requirement_version_must_be_positive(self) -> None:
        with pytest.raises(RequirementError, match="需求版本"):
            RequirementAnalysis(1, 0, "目标", ("场景",), ("验收",), (), WHEN)

    def test_record_analysis_rejects_missing_requirement_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
        try:
            with pytest.raises(RequirementError, match="需求版本不存在"):
                scene.store.record_analysis(
                    scene.req_id,
                    RequirementAnalysis(1, 99, "目标", ("场景",), ("验收",), (), WHEN),
                )
        finally:
            scene.store.close()

    def test_unknown_identity_lookups_fail_explicitly(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            calls = (
                lambda: store.get("req-missing"),
                lambda: store.analyses("req-missing"),
                lambda: store.latest_analysis("req-missing"),
                lambda: store.next_analysis_version("req-missing"),
                lambda: store.requirement_status("req-missing"),
                lambda: store.blocked_reason("req-missing"),
                lambda: store.set_requirement_status("req-missing", BLOCKED),
            )
            for call in calls:
                with pytest.raises(RequirementNotFoundError):
                    call()
        finally:
            store.close()

    @pytest.mark.parametrize("corrupt", ['{"not": "a list"}', "[1, 2]"])
    def test_corrupt_analysis_rows_fail_explicitly(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corrupt: str
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, result=READY_RESULT)
        try:
            analyze_requirement(scene.context())
        finally:
            scene.store.close()

        db = sqlite3.connect(tmp_path / "records.sqlite")
        try:
            db.execute("UPDATE requirement_analyses SET scenarios = ?", (corrupt,))
            db.commit()
        finally:
            db.close()

        reopened = RequirementStore(tmp_path / "records.sqlite")
        try:
            with pytest.raises(RequirementError, match="损坏"):
                reopened.analyses(scene.req_id)
        finally:
            reopened.close()

    def test_old_database_is_migrated_with_status_columns(self, tmp_path: Path) -> None:
        db_path = tmp_path / "records.sqlite"
        db = sqlite3.connect(db_path)
        try:
            db.executescript(
                "CREATE TABLE requirements ("
                " req_id TEXT PRIMARY KEY, project TEXT NOT NULL, created_at TEXT NOT NULL);"
                "CREATE TABLE requirement_versions ("
                " req_id TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,"
                " created_at TEXT NOT NULL, PRIMARY KEY (req_id, version));"
            )
            db.execute(
                "INSERT INTO requirements (req_id, project, created_at) VALUES (?, ?, ?)",
                ("req-old", "ForgeLoop", WHEN.isoformat()),
            )
            db.execute(
                "INSERT INTO requirement_versions (req_id, version, text, created_at)"
                " VALUES (?, 1, ?, ?)",
                ("req-old", "旧库原文", WHEN.isoformat()),
            )
            db.commit()
        finally:
            db.close()

        store = RequirementStore(db_path)
        try:
            assert store.requirement_status("req-old") == DRAFT
            assert store.blocked_reason("req-old") == ""
        finally:
            store.close()


# ---- A02 真实 PI 边界（显式加入：FORGELOOP_PI_LIVE=1，真实模型有成本）----
# 假 PI 用例确定性覆盖“结构化/等待/畸形”三条分支；本组在真实 PI/模型上验证
# 同一适配器、结构化校验与落库边界只有两种诚实结果：得到可审阅分析，或如实阻塞。

PI_LIVE = os.environ.get("FORGELOOP_PI_LIVE") == "1"
PI_BINARY = shutil.which("pi")
PI_PROVIDER = os.environ.get("FORGELOOP_PI_PROVIDER", "cc-switch-open-code-go")
PI_MODEL = os.environ.get("FORGELOOP_PI_MODEL", "deepseek-v4.1-flash")
# 只读分析：禁用工具，PI 只能给出最终文本，不在分析目录里探索或改动文件。
REAL_PI_COMMAND = (
    "pi",
    "--mode",
    "rpc",
    "--no-session",
    "--no-tools",
    "--provider",
    PI_PROVIDER,
    "--model",
    PI_MODEL,
)
LIVE_REQUIRED = pytest.mark.skipif(
    PI_BINARY is None or not PI_LIVE,
    reason="requires the pi binary and FORGELOOP_PI_LIVE=1 (real model cost)",
)
PI_CONFIG_FILES = ("models.json", "models-store.json", "auth.json", "settings.json")

# 信息充分但留有余量的需求：模型可给出场景/验收，也可提出合理的澄清问题。
CLEAR_LIVE_TEXT = (
    "需求：CLI 的 status --json 输出需要包含明确的下一步动作字段 next_action，"
    "方便使用者知道当前该做什么；请给出目标、业务场景、验收标准与待澄清项。"
)
# 信息明显不足的需求：必须等待回答，不能猜测出可推进的分析。
VAGUE_LIVE_TEXT = (
    "需求：优化一下系统的整体体验，让它更好用。"
    "这个描述故意很模糊，请只提出需要澄清的关键问题，信息不足时不要猜测场景和验收标准。"
)


def isolate_pi_home(tmp_path: Path) -> dict[str, str]:
    """隔离 HOME：只拷 pi 配置必需文件（判据：models.json 存在且非空）。"""

    source = Path.home() / ".pi" / "agent"
    target = tmp_path / "pi-home" / ".pi" / "agent"
    target.mkdir(parents=True, exist_ok=True)
    for name in PI_CONFIG_FILES:
        candidate = source / name
        if candidate.exists():
            shutil.copy2(candidate, target / name)
    return {"HOME": str(tmp_path / "pi-home")}


def live_context(scene: Scene, extra_env: dict[str, str]) -> PlanningContext:
    return PlanningContext(
        scene.store,
        scene.req_id,
        scene.analysis_dir,
        REAL_PI_COMMAND,
        timeout_seconds=180.0,
        extra_env=extra_env,
    )


class TestRealPiAnalysis:
    @LIVE_REQUIRED
    @pytest.mark.pi_live
    @pytest.mark.timeout(240)
    def test_real_pi_output_is_structured_or_honestly_blocked(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, text=CLEAR_LIVE_TEXT)
        try:
            outcome = analyze_requirement(live_context(scene, isolate_pi_home(tmp_path)))
            status = scene.store.requirement_status(scene.req_id)
            stored = scene.store.latest_analysis(scene.req_id)
        finally:
            scene.store.close()

        # 真实边界只容许两种诚实结果：可审阅的结构化分析，或带原因的阻塞。
        assert outcome.requirement_status == status  # 返回值与落库状态同源
        assert status in {DRAFT, AWAITING_CLARIFICATION, BLOCKED}
        if outcome.analysis is None:
            assert status == BLOCKED
            assert outcome.halted_reason
            assert stored is None
        else:
            assert stored == outcome.analysis
            assert outcome.analysis.goal.strip()
            assert outcome.analysis.is_ready == (not outcome.analysis.needs_clarification)
            if outcome.analysis.needs_clarification:
                assert status == AWAITING_CLARIFICATION
            else:
                assert status == DRAFT
                assert outcome.analysis.scenarios and outcome.analysis.acceptance_criteria
        # 原生会话落盘在独立分析目录内，可回查。
        assert (scene.analysis_dir / "sessions" / f"{scene.req_id}-analysis.events.jsonl").exists()

    @LIVE_REQUIRED
    @pytest.mark.pi_live
    @pytest.mark.timeout(240)
    def test_real_pi_waits_for_clarification_when_information_is_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scene = make_scene(tmp_path, monkeypatch, text=VAGUE_LIVE_TEXT)
        try:
            outcome = analyze_requirement(live_context(scene, isolate_pi_home(tmp_path)))
        finally:
            scene.store.close()

        # 信息不足：要么提出待澄清项等待回答，要么输出畸形被如实阻塞；
        # 绝不允许在没有澄清的情况下直接产出“可推进”的分析。
        if outcome.analysis is None:
            assert outcome.requirement_status == BLOCKED
            assert outcome.halted_reason
        else:
            assert outcome.analysis.needs_clarification is True
            assert outcome.requirement_status == AWAITING_CLARIFICATION
            assert outcome.is_ready is False
