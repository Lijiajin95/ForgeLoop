"""规划路径的仓库布局事实与合规校验。

覆盖验收要求：任务包文件清单仅落在合法源码/测试分层等位置，测试命令仅使用
``uv run``/``python3``（不再产出 ``python``）；包含臆造路径或不可用命令的任务包
在规划阶段被拒绝、给出具体路径/命令与原因且不落库；规划提示词携带固定仓库事实。
"""

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeloop.domain.repo_facts import (
    DEFAULT_REPO_FACTS,
    RepoFactsError,
    command_problem,
    file_location_problem,
    repository_facts_payload,
    require_repo_facts,
    validate_task_plan,
)
from forgeloop.domain.requirement import BLOCKED
from forgeloop.domain.task_plan import PLAN_PROPOSED, PlannedTask, TaskPlan
from forgeloop.graph.planning import PlanningContext, analyze_requirement, plan_requirement
from forgeloop.records.requirements import RequirementStore

WHEN = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
REPO_ROOT = Path(__file__).resolve().parents[2]

# 依赖真实工作树的断言只有在 *本身就是* git 工作树根的目录里才有可信事实：
# mutmut 的 ``mutants/`` 副本位于工作树内部、但不是工作树根，``git ls-files``
# 只会返回空列表；缺 ``.git`` 或 git 命令不可用时同样取不到跟踪路径。这些现场
# 统一以 pytest.skip 明确跳过，而不是让断言失败。
GIT_WORKTREE_SKIP_REASON = "需要在 git 工作树内运行"
# git 现场命令异常挂起时也要能判定为不可用，不把测试拖死。
GIT_PROBE_TIMEOUT_SECONDS = 30


def _run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str] | None:
    """在 *root* 执行 git 子命令；git 不可用、超时或无法启动时返回 ``None``。

    ``git`` 本身返回非零退出码（例如不是工作树）仍返回结果对象，交由调用方按
    ``returncode`` 判定，避免把“git 说不是工作树”与“git 命令不可用”混为一谈。
    """

    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=False,
            capture_output=True,
            text=True,
            shell=False,
            timeout=GIT_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def require_git_worktree(root: Path = REPO_ROOT) -> Path:
    """*root* 必须是可用 git 工作树的根，否则以明确原因跳过该用例。

    返回解析后的工作树根，供调用方继续使用。位于工作树内部但不是其根时同样
    跳过（如 mutmut 的 ``mutants/`` 副本）。
    """

    probe = _run_git(root, "rev-parse", "--show-toplevel")
    if probe is None or probe.returncode != 0:
        pytest.skip(GIT_WORKTREE_SKIP_REASON)
    worktree_root = probe.stdout.strip()
    if not worktree_root:
        pytest.skip(GIT_WORKTREE_SKIP_REASON)
    resolved_root = Path(worktree_root)
    if resolved_root.resolve() != Path(root).resolve():
        # 位于某个工作树内部但不是其根（如 mutmut 的 mutants/ 副本）。
        pytest.skip(GIT_WORKTREE_SKIP_REASON)
    return resolved_root


def tracked_repo_paths_or_skip(root: Path = REPO_ROOT) -> tuple[str, ...]:
    """真实工作树内的跟踪路径；不在工作树内时按明确原因跳过。"""

    require_git_worktree(root)
    listing = _run_git(root, "ls-files")
    if listing is None or listing.returncode != 0:
        pytest.skip(GIT_WORKTREE_SKIP_REASON)
    paths = tuple(line for line in listing.stdout.splitlines() if line.strip())
    assert paths, "git ls-files 未返回任何跟踪文件"
    return paths


def assert_tracked_paths_are_legal(root: Path = REPO_ROOT) -> tuple[str, ...]:
    """原 ``test_every_tracked_path_is_legal`` 断言体，返回已核对的跟踪路径。

    真实工作树内逐个校验每个跟踪路径都落在合法分层；不在工作树内时整体跳过。
    返回路径元组便于用例断言断言体确实执行且枚举非空。
    """

    paths = tracked_repo_paths_or_skip(root)
    rejected = {
        path: reason for path in paths if (reason := file_location_problem(path)) is not None
    }
    assert rejected == {}, f"真实仓库路径被固定事实误拒：{rejected}"
    return paths


READY_ANALYSIS = {
    "goal": "把规划接到仓库布局事实",
    "scenarios": ["规划拒绝臆造路径", "规划拒绝不可用命令"],
    "acceptance_criteria": ["任务包仅落在合法分层"],
    "clarifications": [],
}

# 合法任务包：文件落在源码层、测试层与契约快照，命令使用 uv run 与 python3。
LEGAL_PLAN = {
    "tasks": [
        {
            "task_id": "repo-facts",
            "goal": "实现仓库事实纯规则",
            "files": ["src/forgeloop/domain/repo_facts.py"],
            "acceptance": "纯规则校验路径与命令",
            "test_command": ["uv", "run", "pytest", "tests/unit/test_planning_repo_facts.py", "-q"],
            "depends_on": [],
        },
        {
            "task_id": "planning-wire",
            "goal": "把事实接进规划并执行校验",
            "files": ["src/forgeloop/graph/planning.py", "tests/unit/test_planning_repo_facts.py"],
            "acceptance": "校验失败即阻塞且给出具体原因",
            "test_command": [
                "python3",
                "-m",
                "pytest",
                "tests/unit/test_planning_repo_facts.py",
                "-q",
            ],
            "depends_on": ["repo-facts"],
        },
    ]
}

# 组合式假 PI：按 prompt 的 role 返回分析/规划结果，并把提示词原文落盘。
FAKE_PI = r"""
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


def role_of(message):
    try:
        parsed = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return "dev"
    return str(parsed.get("role", "dev")) if isinstance(parsed, dict) else "dev"


prompt_log = os.environ.get("FAKE_PLANNING_PROMPT_LOG")
text = ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    kind = request.get("type")
    if kind == "prompt":
        message = request.get("message", "")
        role = role_of(message)
        if prompt_log:
            with open(prompt_log, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"role": role, "prompt": message}, ensure_ascii=False) + "\n")
        respond(request, True, {"disposition": "started"})
        emit({"type": "agent_start"})
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        emit({"type": "agent_settled", "aborted": False})
        env_name = "FAKE_ANALYSIS_RESULT" if role == "analysis" else "FAKE_PLANNING_RESULT"
        text = os.environ.get(env_name, "")
    elif kind == "get_last_assistant_text":
        respond(request, True, {"text": text})
    else:
        respond(request, False, {"error": f"unknown command: {kind}"})
"""


def make_plan(*, files: tuple[str, ...], command: tuple[str, ...]) -> TaskPlan:
    return TaskPlan(
        task_plan_id="plan-req-1-1",
        requirement_id="req-1",
        project="ForgeLoop",
        plan_version=1,
        requirement_version=1,
        tasks=(
            PlannedTask("t1", "目标", files, "验收", command),
            PlannedTask(
                "t2", "目标", ("src/forgeloop/domain/status.py",), "验收", ("uv", "run", "pytest")
            ),
        ),
        created_at=WHEN,
    )


class TestFileLocationFacts:
    @pytest.mark.parametrize(
        "relative",
        [
            "src/forgeloop/__init__.py",
            "src/forgeloop/domain/status.py",
            "src/forgeloop/graph/planning.py",
            "tests/conftest.py",
            "tests/unit/test_x.py",
            "tests/unit/adapter/test_github_checks.py",
            "tests/fixtures/fake_pi.py",
            "contracts/cli-contract.json",
            "contracts/architecture.json",
            ".github/workflows/quality.yml",
            "docs/architecture.md",
            "config/quality-policy.toml",
            "scripts/export_cli_contract.py",
            "runtime/Dockerfile",
            # 回归（2026-10-18）：frontend 是 B01 引入的真实跟踪树，其工具链点文件
            # （带扩展名的 .prettierrc.json/.dependency-cruiser.cjs 与无扩展名的
            # .prettierignore）都是真实文件，不得被"末段不是文件名"规则误拒。
            "frontend/package.json",
            "frontend/playwright.config.ts",
            "frontend/.prettierrc.json",
            "frontend/.dependency-cruiser.cjs",
            "frontend/.prettierignore",
            "pyproject.toml",
            "Makefile",
        ],
    )
    def test_known_locations_are_legal(self, relative: str) -> None:
        assert file_location_problem(relative) is None

    @pytest.mark.parametrize(
        ("relative", "needle"),
        [
            ("src/forgeloop/bogus/status.py", "源码路径不在合法分层"),
            ("src/a.py", "不在仓库合法路径清单内"),
            ("tests/unknown/test_x.py", "测试路径不在合法分层"),
            ("contracts/madeup.json", "不在仓库合法路径清单内"),
            ("random/thing.py", "不在仓库合法路径清单内"),
            ("/etc/passwd", "不是项目内相对路径"),
            ("../outside.py", "包含空段或越出项目根"),
            ("docs", "必须是文件"),
            # 回归：目录不得被当成文件。
            ("src/forgeloop/domain", "不是文件名"),
            ("src/forgeloop", "必须是文件"),
            ("tests/unit", "不是文件名"),
            ("tests/unit/adapter", "不是文件名"),
            ("docs/adr", "不是文件名"),
            (".github", "必须是文件"),
            (".github/workflows", "不是文件名"),
            # 回归（2026-10-18）：点目录仍必须被拒——只为真实点文件放行，
            # 不能因为放行 .prettierrc.json 就把 .cache 之类点目录当成文件。
            ("frontend/.cache", "不是文件名"),
            ("frontend", "必须是文件"),
            # 回归：以文件为前缀的路径（把文件当目录）必须拒绝。
            ("src/forgeloop/domain/status.py/extra", "当作目录"),
            ("src/forgeloop/domain/status.py/extra.py", "当作目录"),
            ("docs/architecture.md/extra", "当作目录"),
            # 回归：源码根/测试根顶层的臆造文件必须拒绝（顶层真实文件用精确清单）。
            ("src/forgeloop/fabricated.py", "不在已知清单内"),
            ("tests/fake.py", "不在已知清单内"),
        ],
    )
    def test_fabricated_locations_are_rejected(self, relative: str, needle: str) -> None:
        problem = file_location_problem(relative)
        assert problem is not None and needle in problem


class TestFactsMatchRealRepository:
    """固定事实必须覆盖真实仓库布局，避免对可修改文件误拒。"""

    def test_every_tracked_path_is_legal(self) -> None:
        assert_tracked_paths_are_legal()

    def test_review_regressions_from_previous_attempt(self) -> None:
        # 真实存在的测试根顶层共享文件与 CI 配置树必须合法。
        assert file_location_problem("tests/conftest.py") is None
        assert file_location_problem(".github/workflows/quality.yml") is None
        # 臆造的源码根/测试根顶层文件必须拒绝（不能无条件放行顶层文件）。
        assert "不在已知清单内" in (file_location_problem("src/forgeloop/fabricated.py") or "")
        assert "不在已知清单内" in (file_location_problem("tests/fake.py") or "")
        # 目录与文件前缀必须被拒绝。
        assert "不是文件名" in (file_location_problem("src/forgeloop/domain") or "")
        prefix = file_location_problem("src/forgeloop/domain/status.py/extra")
        assert prefix is not None and "当作目录" in prefix


class TestRealWorktreeGuard:
    """真实工作树守卫：无 .git / git 不可用时必须明确跳过。"""

    def test_skips_outside_git_worktree(self, tmp_path: Path) -> None:
        # 临时目录不在任何 git 工作树内：断言/校验入口必须触发跳过而非失败。
        with pytest.raises(pytest.skip.Exception) as error:
            assert_tracked_paths_are_legal(tmp_path)
        assert GIT_WORKTREE_SKIP_REASON in str(error.value)

    def test_skips_when_git_unavailable(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 清空 PATH 模拟 git 命令不可用；即使路径本身是工作树根也必须跳过。
        empty_bin = tmp_path / "empty-bin"
        empty_bin.mkdir()
        monkeypatch.setenv("PATH", str(empty_bin))
        with pytest.raises(pytest.skip.Exception) as error:
            assert_tracked_paths_are_legal(REPO_ROOT)
        assert GIT_WORKTREE_SKIP_REASON in str(error.value)

    def test_real_worktree_assertion_still_executes(self) -> None:
        # 真实工作树内不发生跳过：原断言体实际执行并枚举出非空跟踪路径。
        paths = assert_tracked_paths_are_legal(REPO_ROOT)
        assert paths and "src/forgeloop/domain/repo_facts.py" in paths


class TestTestCommandFacts:
    @pytest.mark.parametrize(
        "command",
        [
            ("uv", "run", "pytest", "tests/unit/test_x.py", "-q"),
            ("python3", "-m", "pytest", "tests/unit/test_x.py", "-q"),
            ("python3", "-c", "print('passed')"),
            ("make", "check"),
            ("make", "coverage"),
            ("make", "test-system"),
        ],
    )
    def test_available_commands_are_legal(self, command: tuple[str, ...]) -> None:
        assert command_problem(command) is None

    def test_spaced_first_element_matches_canonical_argv(self) -> None:
        """含空格首元素（"uv run"）是逐词 argv 的等价写法，三种可用命令都通过。"""

        spaced = ("uv run", "pytest", "tests/unit/test_x.py", "-q")
        canonical = ("uv", "run", "pytest", "tests/unit/test_x.py", "-q")
        python_module = ("python3", "-m", "pytest", "tests/unit/test_x.py", "-q")
        assert command_problem(spaced) is None
        assert command_problem(canonical) is None
        assert command_problem(python_module) is None

    @pytest.mark.parametrize(
        ("command", "needle"),
        [
            ((), "测试命令为空"),
            (("python", "-m", "pytest"), "'python' 不可用"),
            (("node", "tests/unit/test_x.py", "-q"), "'node' 不可用"),
            (("pytest", "-q"), "'pytest' 不可用"),
            (("uv", "run"), "缺少要执行的内容"),
            (("make", "deploy"), "'make' 不可用"),
        ],
    )
    def test_unavailable_commands_are_rejected(self, command: tuple[str, ...], needle: str) -> None:
        problem = command_problem(command)
        assert problem is not None and needle in problem

    def test_error_message_lists_every_allowed_prefix(self) -> None:
        problem = command_problem(("python", "-m", "pytest"))
        assert problem is not None
        for label in (*DEFAULT_REPO_FACTS.interpreter_labels, *DEFAULT_REPO_FACTS.gate_labels):
            assert label in problem

    def test_unavailable_interpreter_rejection_is_actionable(self) -> None:
        """真正不可用的解释器被拒：信息给出逐词拆分提示与可用前缀，且不自相矛盾。"""

        problem = command_problem(("node", "tests/unit/test_x.py", "-q"))
        assert problem is not None
        # 可操作提示：要求把 "uv run" 拆成两个 argv 元素。
        assert "逐词拆分" in problem
        assert '["uv","run"]' in problem
        for label in (*DEFAULT_REPO_FACTS.interpreter_labels, *DEFAULT_REPO_FACTS.gate_labels):
            assert label in problem
        _head, separator, allowed = problem.partition("可用前缀：")
        assert separator and allowed
        # 被拒解释器只出现在“不可用”说明里，不得同时被列为允许前缀。
        assert "node" not in allowed
        assert "不可用；仅允许" not in problem


class TestPlanValidation:
    def test_legal_plan_has_no_violations(self) -> None:
        plan = make_plan(
            files=("src/forgeloop/domain/status.py", "tests/unit/test_x.py"),
            command=("uv", "run", "pytest", "tests/unit/test_x.py", "-q"),
        )
        assert validate_task_plan(plan) == ()
        require_repo_facts(plan)

    def test_require_repo_facts_reports_path_and_command(self) -> None:
        plan = make_plan(
            files=("src/forgeloop/bogus/status.py",),
            command=("python", "-m", "pytest"),
        )
        violations = validate_task_plan(plan)
        assert {violation.kind for violation in violations} == {"file", "command"}
        with pytest.raises(RepoFactsError) as error:
            require_repo_facts(plan)
        message = str(error.value)
        assert "src/forgeloop/bogus/status.py" in message
        assert "python -m pytest" in message

    def test_every_task_is_checked(self) -> None:
        plan = TaskPlan(
            task_plan_id="plan-req-1-1",
            requirement_id="req-1",
            project="ForgeLoop",
            plan_version=1,
            requirement_version=1,
            tasks=(
                PlannedTask(
                    "t1",
                    "目标",
                    ("src/forgeloop/domain/status.py",),
                    "验收",
                    ("uv", "run", "pytest"),
                ),
                PlannedTask("t2", "目标", ("src/forgeloop/nope/x.py",), "验收", ("pytest",)),
            ),
            created_at=WHEN,
        )
        violations = validate_task_plan(plan)
        assert [(item.task_id, item.kind) for item in violations] == [
            ("t2", "file"),
            ("t2", "command"),
        ]


class TestFactsPayload:
    def test_payload_describes_the_fixed_layout(self) -> None:
        payload = repository_facts_payload()
        assert payload["source_root"] == "src/forgeloop"
        # 分层顺序由机读架构契约给出（不再固定），此处校验成员集合：基础五层 + 2026-10-16 登记的 mail。
        assert set(payload["source_layers"]) == {
            "domain",
            "records",
            "adapter",
            "graph",
            "cli",
            "mail",
        }
        assert payload["test_layers"] == [
            "unit",
            "property",
            "component",
            "scenario",
            "integration",
            "system",
            "fixtures",
        ]
        assert payload["contract_snapshots"] == [
            "contracts/cli-contract.json",
            "contracts/architecture.json",
        ]
        assert payload["architecture_doc"] == "docs/architecture.md"
        assert payload["source_root_files"] == ["__init__.py", "__main__.py"]
        assert payload["test_root_files"] == ["conftest.py", "project_support.py"]
        assert ".github" in payload["auxiliary_roots"]
        assert "pyproject.toml" in payload["top_level_files"]
        assert payload["interpreters"] == ["uv run", "python3"]
        assert payload["gate_commands"] == [
            "make check",
            "make coverage",
            "make test-system",
            "make test",
        ]


def plan_scene(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, result: dict
) -> tuple[RequirementStore, PlanningContext, Path]:
    """提交需求、跑一次就绪分析，返回可规划现场与提示词日志。"""

    store = RequirementStore(tmp_path / "records.sqlite")
    requirement = store.submit("ForgeLoop", "需求：规划路径接入仓库布局事实与校验")
    script = tmp_path / "planning_pi.py"
    script.write_text(FAKE_PI, encoding="utf-8")
    prompt_log = tmp_path / "prompts.jsonl"
    monkeypatch.setenv("FAKE_ANALYSIS_RESULT", json.dumps(READY_ANALYSIS, ensure_ascii=False))
    monkeypatch.setenv("FAKE_PLANNING_RESULT", json.dumps(result, ensure_ascii=False))
    monkeypatch.setenv("FAKE_PLANNING_PROMPT_LOG", str(prompt_log))
    context = PlanningContext(
        store,
        requirement.req_id,
        tmp_path / "planning",
        (sys.executable, str(script)),
    )
    outcome = analyze_requirement(context)
    assert outcome.is_ready, outcome.halted_reason
    return store, context, prompt_log


def planning_prompts(prompt_log: Path) -> list[dict]:
    entries = []
    for line in prompt_log.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record["role"] == "planning":
            entries.append(json.loads(record["prompt"]))
    return entries


class TestPlanningIntegration:
    def test_legal_plan_is_recorded(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        store, context, _prompt_log = plan_scene(tmp_path, monkeypatch, LEGAL_PLAN)
        try:
            outcome = plan_requirement(context)
            stored = store.latest_task_plan(context.req_id)
            status = store.requirement_status(context.req_id)
        finally:
            store.close()

        assert outcome.requirement_status == PLAN_PROPOSED
        assert status == PLAN_PROPOSED
        assert outcome.plan is not None and stored == outcome.plan
        assert outcome.plan.tasks[0].test_command[0] == "uv"

    def test_planning_prompt_carries_repository_facts(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store, context, prompt_log = plan_scene(tmp_path, monkeypatch, LEGAL_PLAN)
        try:
            plan_requirement(context)
        finally:
            store.close()

        prompts = planning_prompts(prompt_log)
        assert len(prompts) == 1
        facts = prompts[0]["repository_facts"]
        assert facts["source_root"] == "src/forgeloop"
        assert "domain" in facts["source_layers"]
        assert "unit" in facts["test_layers"]
        assert "contracts/cli-contract.json" in facts["contract_snapshots"]
        assert facts["interpreters"] == ["uv run", "python3"]
        assert "make check" in facts["gate_commands"]
        assert "repository_facts" in prompts[0]["output_contract"]

    @pytest.mark.parametrize(
        ("result", "needle"),
        [
            (
                {
                    "tasks": [
                        {**LEGAL_PLAN["tasks"][0], "files": ["src/forgeloop/bogus/status.py"]},
                        LEGAL_PLAN["tasks"][1],
                    ]
                },
                "src/forgeloop/bogus/status.py",
            ),
            (
                {
                    "tasks": [
                        {**LEGAL_PLAN["tasks"][0], "files": ["src/a.py"]},
                        LEGAL_PLAN["tasks"][1],
                    ]
                },
                "src/a.py",
            ),
            (
                {
                    "tasks": [
                        {
                            **LEGAL_PLAN["tasks"][0],
                            "test_command": ["python", "-m", "pytest", "tests/unit/test_x.py"],
                        },
                        LEGAL_PLAN["tasks"][1],
                    ]
                },
                "python -m pytest",
            ),
            (
                {
                    "tasks": [
                        {
                            **LEGAL_PLAN["tasks"][0],
                            "test_command": [sys.executable, "-c", "print(1)"],
                        },
                        LEGAL_PLAN["tasks"][1],
                    ]
                },
                "不可用",
            ),
        ],
    )
    def test_fabricated_paths_and_commands_are_blocked(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, result: dict, needle: str
    ) -> None:
        store, context, _prompt_log = plan_scene(tmp_path, monkeypatch, result)
        try:
            outcome = plan_requirement(context)
            status = store.requirement_status(context.req_id)
            reason = store.blocked_reason(context.req_id)
            stored = store.latest_task_plan(context.req_id)
        finally:
            store.close()

        assert outcome.requirement_status == BLOCKED
        assert outcome.plan is None
        assert "plan_repo_facts" in (outcome.halted_reason or "")
        assert needle in (outcome.halted_reason or "")
        assert status == BLOCKED and "plan_repo_facts" in reason and needle in reason
        # 被拒绝的任务包不得落库，需重规划后才能批准。
        assert stored is None
