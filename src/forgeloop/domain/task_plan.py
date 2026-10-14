"""任务包领域规则：把已澄清的分析变成可批准、可执行的任务包。

规则来源（DogFood 交接约定 §3、§5 与执行计划 A03）：

- 一条需求可以有多个任务包版本，身份形如 ``plan-<requirement_id>-<seq>``，
  版本号从 1 起连续递增；新版本不覆盖旧版本，也不清空旧批准。
- 每个任务有目标、允许修改的文件清单、验收标准、正式测试命令、依赖与限额。
- 依赖必须存在且无环，包内 ``task_id`` 唯一，测试命令必须是非空 argv 数组。
- 跨项目引用拒绝：任务包项目必须与需求项目一致，文件清单不得越出项目根。
- 批准绑定需求身份与任务包版本；未批准不执行，旧版本批准不能驱动新任务包。
- 任务级授权来源只绑定真实批准，不从模型输出或调用方自由填写。

本模块只维护不可变事实与纯判定；持久化由 ``records.requirements`` 负责。
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum
from typing import cast

# 需求状态（精简集合的 A03 段）：有任务包待批准 / 任务包已批准。
PLAN_PROPOSED = "plan_proposed"
APPROVED = "approved"

# 首版默认限额：与执行时间领域保持一致（两小时、三失败轮次）。
DEFAULT_TASK_LIMIT_SECONDS = 7200.0
DEFAULT_MAX_FAILURE_ROUNDS = 3


class TaskPlanError(ValueError):
    """违反任务包身份、依赖、文件清单或批准绑定规则。"""


class TaskPlanNotFoundError(LookupError):
    """按需求身份或版本回查不到任务包；未知身份必须明确失败。"""


class TaskPlanNotAuthorizedError(TaskPlanError):
    """任务包未获有效批准，或批准与任务包不匹配。"""


def _require_non_empty(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskPlanError(f"任务包字段 {field_name} 必须是非空字符串")
    return value.strip()


def _require_str_list(value: object, field_name: str, *, allow_empty: bool) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise TaskPlanError(f"任务包字段 {field_name} 必须是字符串数组")
    raw_items = cast("list[object]", value)
    items: list[str] = []
    for item in raw_items:
        if not isinstance(item, str) or not item.strip():
            raise TaskPlanError(f"任务包字段 {field_name} 只能包含非空字符串")
        items.append(item.strip())
    if not allow_empty and not items:
        raise TaskPlanError(f"任务包字段 {field_name} 不能为空")
    if len(set(items)) != len(items):
        raise TaskPlanError(f"任务包字段 {field_name} 不能包含重复项")
    return tuple(items)


def _validate_files(files: tuple[str, ...]) -> None:
    """文件清单必须是项目根下的相对路径；拒绝绝对路径与 ``..`` 越界。"""

    if not files:
        raise TaskPlanError("任务的准许修改文件清单不能为空")
    for relative in files:
        if len(relative) == 0 or relative.startswith(("/", "\\")):
            raise TaskPlanError(f"文件清单必须是项目内相对路径: {relative!r}")
        parts = re.split(r"[\\/]+", relative)
        if any(part in ("", "..") for part in parts):
            raise TaskPlanError(f"文件清单不得越出项目根: {relative!r}")


@dataclass(frozen=True)
class TaskLimits:
    """单个任务的执行限额：实际执行工时与失败轮次上限。"""

    limit_seconds: float = DEFAULT_TASK_LIMIT_SECONDS
    max_failure_rounds: int = DEFAULT_MAX_FAILURE_ROUNDS

    def __post_init__(self) -> None:
        if self.limit_seconds <= 0:
            raise TaskPlanError("任务执行限额必须为正数")
        if self.max_failure_rounds < 1:
            raise TaskPlanError("任务失败轮次上限必须为正整数")


@dataclass(frozen=True)
class PlannedTask:
    """任务包内的一个可实现、可验证工作单元。

    ``authorization_source`` 在任务包被真实批准前为空串；只有
    :func:`bind_authorization` 能依据批准记录写入，调用方与模型都不得自行填写。
    """

    task_id: str
    goal: str
    files: tuple[str, ...]
    acceptance: str
    test_command: tuple[str, ...]
    depends_on: tuple[str, ...] = ()
    limits: TaskLimits = field(default_factory=TaskLimits)
    authorization_source: str = ""

    def __post_init__(self) -> None:
        _require_non_empty(self.task_id, "task_id")
        _require_non_empty(self.goal, "goal")
        _require_non_empty(self.acceptance, "acceptance")
        _validate_files(self.files)
        if not self.test_command:
            raise TaskPlanError("任务必须给出可执行的正式测试命令")
        for argument in self.test_command:
            _require_non_empty(argument, "test_command")
        if self.task_id in self.depends_on:
            raise TaskPlanError(f"任务不能依赖自身: {self.task_id}")
        if len(set(self.files)) != len(self.files):
            raise TaskPlanError("任务的准许修改文件清单不能包含重复项")
        if len(set(self.depends_on)) != len(self.depends_on):
            raise TaskPlanError("任务依赖不能包含重复项")
        for dependency in self.depends_on:
            _require_non_empty(dependency, "depends_on")


@dataclass(frozen=True)
class TaskPlan:
    """一条需求在某个版本下的任务包；任务身份与依赖在构造时校验。

    ``requirement_version`` 记录任务包所依据的需求修订版本：需求文本一旦追加，
    任务包即对当前版本过期，其批准也随失效（由记录层判定）。
    """

    task_plan_id: str
    requirement_id: str
    project: str
    plan_version: int
    requirement_version: int
    tasks: tuple[PlannedTask, ...]
    created_at: datetime

    def __post_init__(self) -> None:
        _require_non_empty(self.task_plan_id, "task_plan_id")
        _require_non_empty(self.requirement_id, "requirement_id")
        _require_non_empty(self.project, "project")
        if self.plan_version < 1:
            raise TaskPlanError("任务包版本号必须从 1 开始")
        if self.requirement_version < 1:
            raise TaskPlanError("任务包必须绑定一个需求版本")
        if not self.tasks:
            raise TaskPlanError("任务包至少要有一个任务")
        task_ids = [task.task_id for task in self.tasks]
        if len(set(task_ids)) != len(task_ids):
            raise TaskPlanError("同一任务包内 task_id 必须唯一")
        known = set(task_ids)
        for task in self.tasks:
            for dependency in task.depends_on:
                if dependency not in known:
                    raise TaskPlanError(f"任务 {task.task_id} 依赖不存在的任务: {dependency}")
        # 构造时即拒绝环，后续拓扑推进才可信。
        self.execution_order()

    def task(self, task_id: str) -> PlannedTask:
        for task in self.tasks:
            if task.task_id == task_id:
                return task
        raise TaskPlanNotFoundError(f"任务包内没有任务: {task_id}")

    @property
    def roots(self) -> tuple[str, ...]:
        return tuple(task.task_id for task in self.tasks if not task.depends_on)

    def execution_order(self) -> tuple[str, ...]:
        """按依赖的拓扑序返回任务身份；声明顺序作为同层稳定顺序。

        构造时已保证依赖存在且无环，因此这里必然成功；仍保留环判定以便
        任何后续改动都不会把不可执行的任务包静默放行。
        """

        order: list[str] = []
        remaining = {task.task_id: set(task.depends_on) for task in self.tasks}
        while remaining:
            ready = [
                task.task_id
                for task in self.tasks
                if task.task_id in remaining and not remaining[task.task_id]
            ]
            if not ready:
                raise TaskPlanError("任务包依赖存在环，无法形成执行顺序")
            for task_id in ready:
                order.append(task_id)
                del remaining[task_id]
            for dependencies in remaining.values():
                dependencies.difference_update(ready)
        return tuple(order)


def require_actionable_plan(plan: TaskPlan) -> None:
    """A03 退出条件：至少两个任务，且任务包内至少有一条依赖关系。

    这是“可批准”的形态要求，不放进 :class:`TaskPlan` 的通用构造校验，
    以免单独描述一个任务包时被迫凑数。
    """

    if len(plan.tasks) < 2:
        raise TaskPlanError("可批准的任务包至少要包含两个任务")
    if not any(task.depends_on for task in plan.tasks):
        raise TaskPlanError("可批准的任务包至少要有一条任务依赖")


@dataclass(frozen=True)
class TaskPlanApproval:
    """所有者对某个任务包版本的实际批准；授权来源由本记录派生。"""

    requirement_id: str
    plan_version: int
    approved_by: str
    approved_at: datetime
    source: str = ""

    def __post_init__(self) -> None:
        _require_non_empty(self.requirement_id, "requirement_id")
        if self.plan_version < 1:
            raise TaskPlanError("批准绑定的任务包版本必须从 1 开始")
        _require_non_empty(self.approved_by, "approved_by")

    @property
    def authorization_source(self) -> str:
        """任务级授权来源：由真实批准身份与版本派生，稳定可回查。"""

        return f"plan-approval:{self.requirement_id}:v{self.plan_version}:{self.approved_by}"


class PlanAuthorizationStatus(StrEnum):
    """任务包执行就绪判定的三种结果。"""

    MISSING = "missing"
    STALE = "stale"
    APPROVED = "approved"


@dataclass(frozen=True)
class PlanAuthorization:
    status: PlanAuthorizationStatus
    approval: TaskPlanApproval | None = None
    reason: str = ""

    @property
    def can_execute(self) -> bool:
        return self.status is PlanAuthorizationStatus.APPROVED


def authorize_plan(plan: TaskPlan, approval: TaskPlanApproval | None) -> PlanAuthorization:
    """判定任务包能否据此批准开始执行（纯函数）。

    - 没有批准：``missing``，未批准不执行；
    - 批准不绑定该需求，或绑定的是旧任务包版本：``stale``；
    - 需求身份与任务包版本都匹配：``approved``。
    """

    if approval is None:
        return PlanAuthorization(
            PlanAuthorizationStatus.MISSING, None, "未找到该需求的任务包批准；未批准不执行"
        )
    if approval.requirement_id != plan.requirement_id:
        return PlanAuthorization(
            PlanAuthorizationStatus.STALE, approval, "批准不绑定该需求；不能驱动本任务包"
        )
    if approval.plan_version != plan.plan_version:
        return PlanAuthorization(
            PlanAuthorizationStatus.STALE,
            approval,
            f"批准绑定任务包 v{approval.plan_version}，当前任务包 v{plan.plan_version}；"
            "旧版本批准不能驱动新任务包",
        )
    return PlanAuthorization(PlanAuthorizationStatus.APPROVED, approval)


def bind_authorization(plan: TaskPlan, approval: TaskPlanApproval) -> TaskPlan:
    """把真实批准的授权来源写入任务包内每个任务；不匹配时明确拒绝。"""

    authorization = authorize_plan(plan, approval)
    if not authorization.can_execute:
        raise TaskPlanNotAuthorizedError(authorization.reason)
    source = approval.authorization_source
    return replace(
        plan,
        tasks=tuple(replace(task, authorization_source=source) for task in plan.tasks),
    )


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TaskPlanError(f"任务包字段 {field_name} 必须是对象")
    return cast("Mapping[str, object]", value)


def _limits_from_value(value: object) -> TaskLimits:
    if value is None:
        return TaskLimits()
    data = _mapping(value, "limits")
    limit_seconds = data.get("limit_seconds", DEFAULT_TASK_LIMIT_SECONDS)
    if not isinstance(limit_seconds, (int, float)) or isinstance(limit_seconds, bool):
        raise TaskPlanError("任务包字段 limits.limit_seconds 必须是数字")
    max_failure_rounds = data.get("max_failure_rounds", DEFAULT_MAX_FAILURE_ROUNDS)
    if not isinstance(max_failure_rounds, int) or isinstance(max_failure_rounds, bool):
        raise TaskPlanError("任务包字段 limits.max_failure_rounds 必须是整数")
    return TaskLimits(float(limit_seconds), max_failure_rounds)


def _task_from_mapping(mapping: Mapping[str, object], *, allow_authorization: bool) -> PlannedTask:
    if "authorization_source" in mapping and not allow_authorization:
        raise TaskPlanError("任务包不得自带 authorization_source；授权来源由真实批准绑定")
    authorization = mapping.get("authorization_source", "")
    if not isinstance(authorization, str):
        raise TaskPlanError("任务包字段 authorization_source 必须是字符串")
    return PlannedTask(
        task_id=_require_non_empty(mapping.get("task_id"), "task_id"),
        goal=_require_non_empty(mapping.get("goal"), "goal"),
        files=_require_str_list(mapping.get("files"), "files", allow_empty=False),
        acceptance=_require_non_empty(mapping.get("acceptance"), "acceptance"),
        test_command=_require_str_list(
            mapping.get("test_command"), "test_command", allow_empty=False
        ),
        depends_on=_require_str_list(mapping.get("depends_on"), "depends_on", allow_empty=True),
        limits=_limits_from_value(mapping.get("limits")),
        authorization_source=authorization.strip() if allow_authorization else "",
    )


def _tasks_from_payload(payload: object, *, allow_authorization: bool) -> tuple[PlannedTask, ...]:
    data = _mapping(payload, "payload")
    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list):
        raise TaskPlanError("任务包必须给出 tasks 数组")
    task_items = cast("list[object]", raw_tasks)
    if not task_items:
        raise TaskPlanError("任务包至少要有一个任务")
    return tuple(
        _task_from_mapping(_mapping(item, "tasks[]"), allow_authorization=allow_authorization)
        for item in task_items
    )


def parse_task_plan(
    payload: object,
    *,
    task_plan_id: str,
    requirement_id: str,
    project: str,
    plan_version: int,
    requirement_version: int,
    created_at: datetime,
) -> TaskPlan:
    """把 PI 载荷校验为任务包；任务不得自带授权来源。

    只接受含 ``tasks`` 数组的 JSON 对象；任务字段缺类型不符即明确失败，
    由调用方如实阻塞，不猜测缺省任务。
    """

    return TaskPlan(
        task_plan_id=task_plan_id,
        requirement_id=requirement_id,
        project=project,
        plan_version=plan_version,
        requirement_version=requirement_version,
        tasks=_tasks_from_payload(payload, allow_authorization=False),
        created_at=created_at,
    )


def task_plan_to_payload(plan: TaskPlan) -> dict[str, object]:
    """把任务包序列化为可落库的 JSON 结构（含任务级授权来源）。"""

    return {
        "task_plan_id": plan.task_plan_id,
        "requirement_id": plan.requirement_id,
        "project": plan.project,
        "plan_version": plan.plan_version,
        "requirement_version": plan.requirement_version,
        "created_at": plan.created_at.isoformat(),
        "tasks": [
            {
                "task_id": task.task_id,
                "goal": task.goal,
                "files": list(task.files),
                "acceptance": task.acceptance,
                "test_command": list(task.test_command),
                "depends_on": list(task.depends_on),
                "limits": {
                    "limit_seconds": task.limits.limit_seconds,
                    "max_failure_rounds": task.limits.max_failure_rounds,
                },
                "authorization_source": task.authorization_source,
            }
            for task in plan.tasks
        ],
    }


def task_plan_from_payload(payload: object) -> TaskPlan:
    """从落库结构还原任务包；授权来源随记录一并读回。"""

    data = _mapping(payload, "payload")
    created_at = data.get("created_at")
    if not isinstance(created_at, str):
        raise TaskPlanError("任务包字段 created_at 必须是 ISO 时间字符串")
    plan_version = data.get("plan_version")
    requirement_version = data.get("requirement_version")
    if not isinstance(plan_version, int) or isinstance(plan_version, bool):
        raise TaskPlanError("任务包字段 plan_version 必须是整数")
    if not isinstance(requirement_version, int) or isinstance(requirement_version, bool):
        raise TaskPlanError("任务包字段 requirement_version 必须是整数")
    return TaskPlan(
        task_plan_id=_require_non_empty(data.get("task_plan_id"), "task_plan_id"),
        requirement_id=_require_non_empty(data.get("requirement_id"), "requirement_id"),
        project=_require_non_empty(data.get("project"), "project"),
        plan_version=plan_version,
        requirement_version=requirement_version,
        tasks=_tasks_from_payload(data, allow_authorization=True),
        created_at=datetime.fromisoformat(created_at),
    )
