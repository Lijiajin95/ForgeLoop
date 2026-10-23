"""需求受理的身份与修订规则：原文与追加版本都按身份保留。

规则来源（完整目标 §3 工作对象与修改规则）：
- 一个研发工作项绑定一个项目，不同项目的工作项不混用。
- 首次提交的原文占用版本 1，永久保留；补充或修改只追加新版本，不覆盖历史。
- 同一目标的修订不重新分配身份，版本号从 1 起连续递增。
- 按身份回查未知需求必须明确失败，不能返回空结果。

只读分析（A02，见 docs/dogfood-execution-plan.md）的纯规则也放在本模块：
- 分析结果必须是结构化对象（目标、业务场景、验收标准、待澄清项）。
- 缺关键信息（待澄清项非空）时等待回答，不进入实现。
- 结构畸形（缺字段、类型不对）明确失败，由调用方如实阻塞。
- 每次分析绑定需求版本并保留，回答澄清后重新分析追加新版本。

修订不会自动清零失败记录、已消耗工时或追加授权（见 counting、limits）。
持久化由 records 层负责；本模块只维护不可变事实。
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

# 需求状态（所有者 2026-10-13 决定的精简集合；A02 只用到前三个）。
# 分析阶段只在这些契约状态之间流转，不新增状态词：分析完成后仍是 draft，
# 直到 A03 生成任务包才进入 plan_proposed。
DRAFT = "draft"
AWAITING_CLARIFICATION = "awaiting_clarification"
BLOCKED = "blocked"
# 需求级整体验收通过后的终态；由记录层与 CLI 共用同一词表（不各写一份字面量）。
ACCEPTED = "accepted"
# 取消后的终态（2026-10-19）：结束自动推进并**保留**身份、版本、批准、交付与现场。
# 与"删除"区分：记录只追加，不做物理删除。
CANCELLED = "cancelled"
# 整体验收被拒绝后的终态（与 CLI 的既有词表一致）。
REJECTED = "rejected"
# 终态词表：终态不回退，也不能再排队分析/规划/推进。
TERMINAL_STATUSES: frozenset[str] = frozenset({ACCEPTED, REJECTED, CANCELLED})


class RequirementError(ValueError):
    """违反需求身份或修订版本规则。"""


class RequirementNotFoundError(LookupError):
    """按身份回查不到需求；未知身份必须明确失败。"""


class IdempotencyConflictError(RequirementError):
    """同一个客户端幂等键被用于不同内容：fail-closed 拒绝，不猜用户想改哪一条。"""


class AnalysisMalformedError(RequirementError):
    """PI 分析结果不是可用的结构化对象；不得据此推进，必须如实阻塞。"""


def allocate_requirement_id() -> str:
    """分配一个新的、全局唯一的需求身份。"""

    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    return f"req-{stamp}-{uuid.uuid4().hex[:6]}"


@dataclass(frozen=True)
class RequirementVersion:
    """需求的一个修订版本；版本 1 是首次提交的原始输入。"""

    version: int
    text: str
    created_at: datetime

    def __post_init__(self) -> None:
        if self.version < 1:
            raise RequirementError("需求版本号必须从 1 开始")
        if not self.text.strip():
            raise RequirementError("需求版本原文不能为空")


@dataclass(frozen=True)
class Requirement:
    """一个绑定项目、身份稳定的研发工作项，历史修订全部保留。"""

    req_id: str
    project: str
    versions: tuple[RequirementVersion, ...]

    def __post_init__(self) -> None:
        if not self.req_id:
            raise RequirementError("需求身份不能为空")
        if not self.project:
            raise RequirementError("需求必须绑定一个项目")
        if not self.versions:
            raise RequirementError("需求至少要有原始输入这一版本")
        numbers = [version.version for version in self.versions]
        if numbers != list(range(1, len(self.versions) + 1)):
            raise RequirementError("需求版本号必须从 1 起连续递增，历史版本不得覆盖")

    @property
    def original_text(self) -> str:
        """首次提交的原文，始终是版本 1。"""

        return self.versions[0].text

    @property
    def latest(self) -> RequirementVersion:
        return self.versions[-1]

    @property
    def version_count(self) -> int:
        return len(self.versions)

    def append(self, text: str, created_at: datetime) -> "Requirement":
        """追加一个修订版本；原文与历史版本保持不变。"""

        next_version = RequirementVersion(len(self.versions) + 1, text, created_at)
        return Requirement(self.req_id, self.project, (*self.versions, next_version))


def _string_list(value: object, field: str) -> tuple[str, ...]:
    """校验载荷中的一个字符串数组字段；空项或类型不符按畸形处理。"""

    if not isinstance(value, list):
        raise AnalysisMalformedError(f"分析字段 {field} 必须是字符串数组")
    raw_items = cast("list[object]", value)
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str) or not item.strip():
            raise AnalysisMalformedError(f"分析字段 {field} 只能包含非空字符串")
        items.append(item.strip())
    return tuple(items)


def _analysis_mapping(payload: object) -> Mapping[str, object]:
    """把 PI 载荷归一为字符串键的对象映射；不是对象时按畸形处理。"""

    if not isinstance(payload, Mapping):
        raise AnalysisMalformedError("分析结果必须是 JSON 对象")
    return cast("Mapping[str, object]", payload)


@dataclass(frozen=True)
class RequirementAnalysis:
    """一次需求只读分析的结构化结果；按版本保留，不覆盖历史。

    ``requirement_version`` 记录本次分析所依据的需求修订版本，便于回查审阅。
    没有待澄清项时必须有业务场景与验收标准，否则视为畸形而不是“已完成”。
    """

    analysis_version: int
    requirement_version: int
    goal: str
    scenarios: tuple[str, ...]
    acceptance_criteria: tuple[str, ...]
    clarifications: tuple[str, ...]
    created_at: datetime

    def __post_init__(self) -> None:
        if self.analysis_version < 1:
            raise RequirementError("分析版本号必须从 1 开始")
        if self.requirement_version < 1:
            raise RequirementError("分析必须绑定一个需求版本")
        if not self.goal.strip():
            raise AnalysisMalformedError("分析缺少非空目标")
        if not self.clarifications and (not self.scenarios or not self.acceptance_criteria):
            raise AnalysisMalformedError("没有待澄清项时必须给出业务场景与验收标准")

    @property
    def needs_clarification(self) -> bool:
        """是否存在阻塞推进的待澄清项。"""

        return bool(self.clarifications)

    @property
    def is_ready(self) -> bool:
        """分析是否已可进入任务规划：有可审阅结论且没有待澄清项。

        这是分析推进信号，不是需求生命周期状态词（需求状态仍用契约精简集合）。
        """

        return not self.clarifications


def status_for_analysis(analysis: RequirementAnalysis) -> str:
    """一次分析完成后应落库的需求状态（契约精简集合）。

    有待澄清项时等待回答；否则需求仍是 ``draft``（尚未生成任务包）。
    返回值与调用方报告的 ``AnalysisOutcome.requirement_status`` 同源，避免
    同一分析在返回值与记录层给出两套状态。
    """

    return AWAITING_CLARIFICATION if analysis.needs_clarification else DRAFT


def parse_analysis(
    payload: object,
    *,
    analysis_version: int,
    requirement_version: int,
    created_at: datetime,
) -> RequirementAnalysis:
    """把 PI 载荷校验为结构化分析；任何畸形都抛 ``AnalysisMalformedError``。

    只接受 JSON 对象；四个字段都必须存在且类型正确。不猜测缺省值，也不把
    自然语言文本当成结构——宁可阻塞，也不放行不可审阅的结果。
    """

    data = _analysis_mapping(payload)
    goal = data.get("goal")
    if not isinstance(goal, str):
        raise AnalysisMalformedError("分析字段 goal 必须是字符串")
    return RequirementAnalysis(
        analysis_version=analysis_version,
        requirement_version=requirement_version,
        goal=goal.strip(),
        scenarios=_string_list(data.get("scenarios"), "scenarios"),
        acceptance_criteria=_string_list(data.get("acceptance_criteria"), "acceptance_criteria"),
        clarifications=_string_list(data.get("clarifications"), "clarifications"),
        created_at=created_at,
    )
