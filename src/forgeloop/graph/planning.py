"""需求只读分析与任务规划（A02、A03）：经 PI 产出结构化结果，畸形如实阻塞。

职责边界（DogFood 执行计划 A02、A03 与业务交接约定 §5）：
- 只读分析角色通过 PI 生成目标、业务场景、验收标准和待澄清项；
- 结构化校验由 ``domain.requirement.parse_analysis`` 负责，本模块只编排；
- 待澄清项非空时不推进，状态置 ``awaiting_clarification``，等待所有者回答；
- 回答澄清 = 追加需求版本；再次分析追加新的分析版本，历史不覆盖；
- 分析结果畸形、PI 未 settle、模型报错或中止时置 ``blocked`` 并保留原因，
  不把不可用结果当成“无待澄清”放行。
- 规划阶段从已就绪分析生成任务包（至少两个且有依赖），置 ``plan_proposed``；
  任务包未批准不可执行，任务级授权来源只由记录层的真实批准写入。

**分析与规划阶段不改代码**：PI 在独立目录内运行（``PISpawnOptions.cwd``），
不接收被测项目工作区，也不调用 ``prepare_workspace``；本模块不写任何源码。

人类审阅入口是记录层：``RequirementStore.latest_analysis`` / ``analyses`` /
``requirement_status`` / ``blocked_reason`` / ``latest_task_plan`` /
``plan_authorization``，均可跨进程回查。
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.pi_rpc import PIInvocationResult, PIProcess, PISpawnOptions
from forgeloop.domain.requirement import (
    AWAITING_CLARIFICATION,
    BLOCKED,
    Requirement,
    RequirementAnalysis,
    RequirementError,
    parse_analysis,
    status_for_analysis,
)
from forgeloop.domain.task_plan import (
    PLAN_PROPOSED,
    TaskPlan,
    TaskPlanError,
    parse_task_plan,
    require_actionable_plan,
)
from forgeloop.records.requirements import RequirementStore

# 单次分析调用的默认等待上限；与业务图 PI 调用同量级，测试可显式覆盖。
ANALYSIS_TIMEOUT_CAP_SECONDS = 300.0
# 分析输出契约：真实模型必须给出结构化 JSON，否则按畸形阻塞（fail-closed）。
ANALYSIS_OUTPUT_CONTRACT = (
    "只输出一个 JSON 对象，不要输出解释或 Markdown 代码块："
    '{"goal": "<一句话目标>", "scenarios": ["<业务场景>", "..."],'
    ' "acceptance_criteria": ["<可验收标准>", "..."],'
    ' "clarifications": ["<待澄清问题>", "..."]}。'
    "信息充足时 clarifications 必须是空数组 []；缺少关键信息时把问题放进 clarifications，"
    "scenarios 与 acceptance_criteria 可以为空数组。"
)
# 只读约束写进提示词；真正的边界是进程工作目录与不提供项目工作区。
# 显式声明“无工具”很关键：pi 的系统前言会把自己描述为可读写文件、执行命令的
# 编码助手，真实模型（deepseek-v4.1-flash）因此会输出 DSML 工具调用而不是
# 约定的 JSON；声明无工具后模型才稳定回到纯文本 JSON 输出。
ANALYSIS_READ_ONLY_INSTRUCTION = (
    "本阶段是只读分析：不要修改、创建或删除任何文件，不要运行会改动代码的命令。"
    "你没有文件系统访问权，也无法调用任何工具（包括 bash、read、grep）；不要尝试执行任何命令，"
    "不要输出工具调用或 DSML 标记。请仅依据需求文本与全部修订直接输出一个 JSON 对象。"
)
# A03 任务包输出契约：模型拆分任务，但授权来源不由模型给出。
PLANNING_OUTPUT_CONTRACT = (
    "只输出一个 JSON 对象，不要输出解释或 Markdown 代码块："
    '{"tasks": [{"task_id": "<包内唯一短标识>", "goal": "<任务目标>",'
    ' "files": ["<相对项目根的准许修改文件>"], "acceptance": "<该任务的验收标准>",'
    ' "test_command": ["<argv>", "..."], "depends_on": ["<同包任务 task_id>"],'
    ' "limits": {"limit_seconds": 7200, "max_failure_rounds": 3}}]}。'
    "至少给出两个任务，且至少一个任务的 depends_on 指向同包内另一个任务；"
    "files 只列相对项目根的路径，test_command 必须是可执行的非空 argv 数组；"
    "不要输出 authorization_source——任务级授权来源由所有者的真实批准绑定。"
)
PLANNING_READ_ONLY_INSTRUCTION = (
    "本阶段只生成任务包供人批准：不要修改、创建或删除任何文件，不要运行会改动代码的命令。"
    "你没有文件系统访问权，也无法调用任何工具（包括 bash、read、grep）；不要尝试执行任何命令，"
    "不要输出工具调用或 DSML 标记。请仅依据需求文本、全部修订与已就绪分析推断相对文件路径，"
    "直接输出一个 JSON 对象。"
)


@dataclass(frozen=True)
class PlanningContext:
    """一次需求只读分析的现场：权威记录、需求身份、独立分析目录与 PI 命令。

    ``analysis_dir`` 是 PI 的真实工作目录，与被测项目分离；会话与 stderr 落在
    其下的 ``sessions/``。整个现场不进 LangGraph 检查点。``extra_env`` 用于
    真实运行时的隔离环境（例如隔离 HOME），默认不改动进程环境。
    """

    store: RequirementStore
    req_id: str
    analysis_dir: Path
    pi_command: tuple[str, ...]
    timeout_seconds: float = ANALYSIS_TIMEOUT_CAP_SECONDS
    extra_env: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.pi_command:
            raise ValueError("PI command must not be empty")


@dataclass(frozen=True)
class AnalysisOutcome:
    """一次分析的结果：契约内的需求状态、可审阅分析与阻塞原因。

    ``requirement_status`` 是 DogFood 契约 §4 精简集合中的需求状态，与落库值
    同源；"分析已完成、可进入任务规划" 的推进信号是 ``is_ready``（即分析存在且
    无待澄清项），不是需求状态词——分析阶段不生成任务包，需求仍是 ``draft``。
    """

    requirement_status: str
    analysis: RequirementAnalysis | None = None
    halted_reason: str | None = None

    @property
    def needs_clarification(self) -> bool:
        return self.requirement_status == AWAITING_CLARIFICATION

    @property
    def is_ready(self) -> bool:
        return self.analysis is not None and self.analysis.is_ready


@dataclass(frozen=True)
class PlanningOutcome:
    """一次任务规划的结果：契约内的需求状态、可批准任务包与阻塞原因。

    规划成功时需求状态为 ``plan_proposed``，任务包尚无批准，因此不可执行；
    任务级授权来源保持为空，等所有者的真实批准经记录层写入。
    """

    requirement_status: str
    plan: TaskPlan | None = None
    halted_reason: str | None = None

    @property
    def is_ready(self) -> bool:
        return self.plan is not None


def analyze_requirement(ctx: PlanningContext) -> AnalysisOutcome:
    """运行一次只读分析并落库；不推进到实现，也不改动任何源码。

    需求状态用契约精简集合：有可用分析且无待澄清项时为 ``draft``（``is_ready``
    为真，可进入任务规划）；有待澄清项时为 ``awaiting_clarification``（等待所有者
    回答）；PI 未给出可用结果或结果畸形时为 ``blocked``。返回的
    ``requirement_status`` 与落库值同源。
    """

    requirement = ctx.store.get(ctx.req_id)
    previous = ctx.store.latest_analysis(ctx.req_id)
    analysis_version = ctx.store.next_analysis_version(ctx.req_id)
    outcome = _invoke_analysis(
        ctx,
        _analysis_prompt(requirement, previous),
    )
    halt = _outcome_halt(outcome)
    if halt:
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, halt)
        return AnalysisOutcome(BLOCKED, None, halt)
    try:
        analysis = parse_analysis(
            outcome.result,
            analysis_version=analysis_version,
            requirement_version=requirement.version_count,
            created_at=datetime.now(UTC),
        )
    except RequirementError as error:  # AnalysisMalformedError 是 RequirementError 子类
        reason = f"analysis_malformed: {error}"
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return AnalysisOutcome(BLOCKED, None, reason)
    ctx.store.record_analysis(ctx.req_id, analysis)
    return AnalysisOutcome(status_for_analysis(analysis), analysis, None)


def plan_requirement(ctx: PlanningContext) -> PlanningOutcome:
    """从已就绪的分析生成可批准任务包并落库；不修改任何源码。

    只有最新且与当前需求版本一致、没有待澄清项的分析才能进入规划。规划成功
    时需求置 ``plan_proposed``，任务包可回查但**尚未批准、不可执行**；模型结果
    畸形、缺少可执行形态（至少两个任务且有依赖）或 PI 未 settle 时如实阻塞。
    """

    requirement = ctx.store.get(ctx.req_id)
    analysis = ctx.store.latest_analysis(ctx.req_id)
    if analysis is None:
        reason = "analysis_missing"
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return PlanningOutcome(BLOCKED, None, reason)
    if analysis.requirement_version != requirement.version_count:
        reason = "analysis_stale"
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return PlanningOutcome(BLOCKED, None, reason)
    if not analysis.is_ready:
        reason = "analysis_needs_clarification"
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return PlanningOutcome(BLOCKED, None, reason)

    plan_version = ctx.store.next_plan_version(ctx.req_id)
    task_plan_id = f"plan-{requirement.req_id}-{plan_version}"
    outcome = _invoke_planning(ctx, _planning_prompt(requirement, analysis, plan_version))
    reason = _outcome_halt(outcome, "planning")
    if reason:
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return PlanningOutcome(BLOCKED, None, reason)
    try:
        plan = parse_task_plan(
            outcome.result,
            task_plan_id=task_plan_id,
            requirement_id=requirement.req_id,
            project=requirement.project,
            plan_version=plan_version,
            requirement_version=requirement.version_count,
            created_at=datetime.now(UTC),
        )
        require_actionable_plan(plan)
    except TaskPlanError as error:
        reason = f"plan_malformed: {error}"
        ctx.store.set_requirement_status(ctx.req_id, BLOCKED, reason)
        return PlanningOutcome(BLOCKED, None, reason)
    ctx.store.record_task_plan(ctx.req_id, plan)
    return PlanningOutcome(PLAN_PROPOSED, plan, None)


def _analysis_prompt(requirement: Requirement, previous: RequirementAnalysis | None) -> str:
    """分析提示：原文、全部修订、上一版分析与结构化输出契约（纯函数）。"""

    payload: dict[str, object] = {
        "role": "analysis",
        "read_only": True,
        "instruction": ANALYSIS_READ_ONLY_INSTRUCTION,
        "requirement_id": requirement.req_id,
        "project": requirement.project,
        "original_text": requirement.original_text,
        "revisions": [
            {"version": version.version, "text": version.text} for version in requirement.versions
        ],
        "previous_analysis": (
            {
                "analysis_version": previous.analysis_version,
                "goal": previous.goal,
                "scenarios": list(previous.scenarios),
                "acceptance_criteria": list(previous.acceptance_criteria),
                "clarifications": list(previous.clarifications),
            }
            if previous is not None
            else None
        ),
        "output_contract": ANALYSIS_OUTPUT_CONTRACT,
    }
    return json.dumps(payload, ensure_ascii=False)


def _planning_prompt(
    requirement: Requirement, analysis: RequirementAnalysis, plan_version: int
) -> str:
    """规划提示：原文、全部修订、就绪分析与任务包输出契约（纯函数）。"""

    payload: dict[str, object] = {
        "role": "planning",
        "read_only": True,
        "instruction": PLANNING_READ_ONLY_INSTRUCTION,
        "requirement_id": requirement.req_id,
        "project": requirement.project,
        "plan_version": plan_version,
        "original_text": requirement.original_text,
        "revisions": [
            {"version": version.version, "text": version.text} for version in requirement.versions
        ],
        "analysis": {
            "analysis_version": analysis.analysis_version,
            "goal": analysis.goal,
            "scenarios": list(analysis.scenarios),
            "acceptance_criteria": list(analysis.acceptance_criteria),
        },
        "output_contract": PLANNING_OUTPUT_CONTRACT,
    }
    return json.dumps(payload, ensure_ascii=False)


def _invoke_analysis(ctx: PlanningContext, prompt: str) -> PIInvocationResult:
    return _invoke(ctx, prompt, "analysis")


def _invoke_planning(ctx: PlanningContext, prompt: str) -> PIInvocationResult:
    return _invoke(ctx, prompt, "planning")


def _invoke(ctx: PlanningContext, prompt: str, role: str) -> PIInvocationResult:
    """在独立目录内运行一次只读 PI 会话；结果不明确时如实返回，不重跑。"""

    ctx.analysis_dir.mkdir(parents=True, exist_ok=True)
    process = PIProcess(
        ctx.pi_command,
        ctx.req_id,
        role,
        ctx.analysis_dir / "sessions",
        PISpawnOptions(cwd=ctx.analysis_dir, extra_env=ctx.extra_env),
    )
    process.start()
    try:
        process.send_prompt(prompt)
        return process.wait_until_settled(ctx.timeout_seconds + 1.0)
    finally:
        process.close()


def _outcome_halt(outcome: PIInvocationResult, prefix: str = "analysis") -> str | None:
    """PI 结果的未完成判定：中止、协议错误或 provider 模型错误都据实阻塞。

    与业务图 ``nodes._pi_outcome_halt`` 同口径：``agent_settled`` 只表示不再自动
    推进，provider 重试耗尽后的 ``stopReason=error`` 也算未取得结果。
    """

    if outcome.aborted:
        return f"{prefix}_aborted"
    if outcome.model_error:
        return f"{prefix}_model_error:{outcome.model_error}"
    if not outcome.settled:
        return f"{prefix}_unsettled:{outcome.error or 'unsettled'}"
    return None
