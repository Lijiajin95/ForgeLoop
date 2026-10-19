"""常驻 worker（R2）：心跳、只读筛选与「自动接续已批准需求」。

职责边界：

- **只读筛选**：:meth:`ServiceWorker.survey` 按权威记录判断一条需求能否由常驻进程
  自动接续（项目已配置、任务包已批准、下一步的主体是 agent、PI HOME 与进程 HOME
  一致），不放行时给出可读原因；筛选本身不写任何记录，也不启动任何动作。
- **执行**：:meth:`ServiceWorker._tick` 在 ``auto_advance`` 打开时把筛选出的需求交给
  既有 :class:`~forgeloop.graph.dispatch.RequirementDispatcher`——并发上限、同需求
  互斥、同项目交付串行、停止请求与失败累计全部复用既有实现，这里不另写一套编排，
  也不新建队列或第二份业务状态。
- **默认关闭**：``auto_advance = false``（``config/service.toml``）时 worker 只打点与
  报告，不自动推进；页面显式推进入口属 R3。
- **PI HOME 前提**：宿主模式下 PI 子进程继承常驻进程的环境（``graph.nodes`` 走
  ``execution_environment`` 的 host 分支），因此只有声明了同一个 ``pi_home`` 的项目
  才会被执行；不一致的项目如实跳过并给出原因，不猜也不改环境（判据见工程可靠性方案
  第 22.2 节）。
- **启动核对与禁止盲目重放（R4）**：进程启动时（以及每次 ``reconcile()`` 调用时）只读扫描
  未核对动作与残留槽位，连同**副作用证据**（候选 diff 身份、工作副本是否存在）一起列成
  「需人工核对」清单；存在未释放动作的任务一律不自动推进，恢复仍走 ``requirement actions
  clear``/``slot clear``/``retry``，本模块不代替人工释放，也不重放结果不明确的动作。
- **一次异常不拖垮常驻进程**：异常记入 ``last_error`` 并继续下一拍；进程级故障由
  systemd 的 ``Restart=on-failure`` 与启动核对处理。

线程模型：主线程负责启动与停止；``stop()`` 只从非 worker 线程调用，worker 不在自身
线程内 join 自己。
"""

import hashlib
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Event, Lock, Thread

from forgeloop.domain.service import ProjectProfile
from forgeloop.domain.status import ActionActor
from forgeloop.domain.task_plan import TaskPlan
from forgeloop.graph.builder import RequirementTaskRunner, requirement_task_id
from forgeloop.graph.dispatch import RequirementDispatcher
from forgeloop.graph.requirements import (
    RequirementAlreadyRunningError,
    RequirementExecutor,
    TaskExecution,
    TaskResult,
)
from forgeloop.records.actions import SLOT_PREFIX
from forgeloop.records.requirements import Requirement, RequirementStore
from forgeloop.records.store import RecordStore

WORKER_THREAD_NAME = "forgeloop-serve-worker"
DEFAULT_STOP_TIMEOUT_SECONDS = 5.0


class WorkerRefused(RuntimeError):
    """显式推进被拒：需求不符合自动接续的筛选条件（原因可直接展示给人工）。"""


@dataclass(frozen=True)
class Eligibility:
    """一条需求能否由常驻进程自动接续；不放行时 ``reason`` 说明原因。"""

    eligible: bool
    reason: str = ""


def worker_eligibility(
    *,
    project_configured: bool,
    plan_approved: bool,
    next_actor: str,
    process_home: str,
    project_home: str,
    has_outstanding_action: bool = False,
) -> Eligibility:
    """纯规则：常驻进程是否可以代替人工推进这条需求。

    五条同时成立才放行——项目在 ``config/service.toml`` 有档案、任务包已批准、**没有未核对
    的未完成动作**、下一步的主体是 agent、且 PI HOME 与常驻进程 HOME 一致（宿主模式下 PI
    继承进程环境）。任一不成立都给出可读原因，调用方据此跳过而不是猜测。

    「未核对动作」是独立红线（B03）：动作结果不明确时禁止盲目重放，必须先由人工核对并
    释放，因此这里与执行器内的判定是同一口径的第二道闸门。
    """

    if not project_configured:
        return Eligibility(False, "项目未在 config/service.toml 配置")
    if not plan_approved:
        return Eligibility(False, "没有已批准任务包（等待人工批准）")
    if has_outstanding_action:
        return Eligibility(False, "存在未核对的未完成动作，需人工核对并释放后再推进")
    if next_actor != ActionActor.AGENT.value:
        return Eligibility(False, f"下一步由 {next_actor or 'unknown'} 处理，常驻进程不代劳")
    if not process_home.strip():
        return Eligibility(False, "常驻进程没有 HOME，无法确认 PI 配置可用")
    if Path(process_home).expanduser() != Path(project_home).expanduser():
        return Eligibility(False, "PI HOME 与常驻进程 HOME 不一致（见 docs/deployment.md）")
    return Eligibility(True)


@dataclass
class WorkerState:
    """worker 的可变运行状态；读写都持锁，状态文档只做快照。"""

    running: bool = False
    polls: int = 0
    last_poll_at: datetime | None = None
    last_error: str = ""
    candidates: tuple[str, ...] = ()
    executed: tuple[str, ...] = ()
    startup_review: tuple[dict[str, str], ...] = ()
    startup_checked_at: datetime | None = None
    pending_advance: tuple[str, ...] = ()
    # 跳过与结果都用「对象数组」而不是映射：数组元素类型能被 CLI 契约快照完整记录，
    # 映射在快照里只能记成没有值类型的空对象。
    skipped: tuple[dict[str, str], ...] = ()
    results: tuple[dict[str, str], ...] = ()


class ServiceWorker:
    """常驻 worker：心跳 + 只读筛选 + （开关打开时）复用既有编排自动接续。"""

    def __init__(
        self,
        records_root: Path,
        *,
        poll_seconds: int,
        auto_advance: bool,
        projects: Mapping[str, ProjectProfile] | None = None,
        max_concurrent: int = 1,
        process_home: str | None = None,
    ) -> None:
        if poll_seconds < 1:
            raise ValueError("poll_seconds 必须 >= 1")
        self._records_root = records_root
        self._poll_seconds = poll_seconds
        self._auto_advance = auto_advance
        self._projects: dict[str, ProjectProfile] = dict(projects or {})
        self._max_concurrent = max(1, max_concurrent)
        self._process_home = os.environ.get("HOME", "") if process_home is None else process_home
        # 执行接线在 R2 生效：开关关闭时不自动接续（页面显式推进入口属 R3）。
        self._execution_enabled = auto_advance
        self._started_at = datetime.now(UTC)
        self._stop = Event()
        self._lock = Lock()
        self._thread: Thread | None = None
        self._state = WorkerState()
        # 显式推进请求（页面按钮）：进程内调度提示，重启即消失，不进业务记录。
        self._pending: dict[str, None] = {}

    @property
    def records_root(self) -> Path:
        return self._records_root

    @property
    def started_at(self) -> datetime:
        return self._started_at

    @property
    def execution_enabled(self) -> bool:
        """当前是否会自动接续执行（即 ``auto_advance`` 是否打开）。"""

        return self._execution_enabled

    def start(self) -> None:
        """先做一次启动核对，再启动心跳线程；重复调用不产生第二个线程。"""

        self.reconcile()
        with self._lock:
            if self._thread is not None:
                return
            self._stop.clear()
            self._state.running = True
            thread = Thread(target=self._run, name=WORKER_THREAD_NAME, daemon=True)
            self._thread = thread
        thread.start()

    def stop(self, *, timeout: float = DEFAULT_STOP_TIMEOUT_SECONDS) -> None:
        """请求停止并等待线程退出；超时不阻塞进程关闭（daemon 线程不阻止退出）。"""

        with self._lock:
            thread = self._thread
        self._stop.set()
        if thread is not None:
            thread.join(timeout=timeout)
        with self._lock:
            self._thread = None
            self._state.running = False

    def status(self) -> dict:
        """运行状态快照（进 ``GET /api/service`` 与 ``serve --once --json``）。"""

        with self._lock:
            self._state.pending_advance = tuple(self._pending)
            state = self._state
            return {
                "running": state.running,
                "execution_enabled": self._execution_enabled,
                "auto_advance": self._auto_advance,
                "poll_seconds": self._poll_seconds,
                "polls": state.polls,
                "last_poll_at": state.last_poll_at.isoformat() if state.last_poll_at else "",
                "last_error": state.last_error,
                "projects": sorted(self._projects),
                "executable_projects": sorted(self._executable_projects()),
                "startup_checked_at": (
                    state.startup_checked_at.isoformat() if state.startup_checked_at else ""
                ),
                "startup_review": [dict(item) for item in state.startup_review],
                "pending_advance": list(state.pending_advance),
                "last_tick": {
                    "candidates": list(state.candidates),
                    "executed": list(state.executed),
                    "skipped": [dict(item) for item in state.skipped],
                    "results": [dict(item) for item in state.results],
                },
            }

    def reconcile(self) -> tuple[dict[str, str], ...]:
        """启动核对（R4，只读）：未核对动作 + 残留槽位 + 副作用证据，永不自动重放。

        返回的每一项都是「需要人工核对」的事实：``kind`` 为 ``outstanding_action`` 或
        ``slot_residue``，``ref_id`` 是任务或槽位身份，``detail`` 里带可核对依据（动作
        身份与启动时刻、候选 diff 身份、工作副本是否存在）。结果同时记入状态快照，
        ``GET /api/service`` 会把它并进「需人工核对」清单。
        """

        record_store = RecordStore(self._records_root / "records.sqlite")
        try:
            items = [
                self._outstanding_item(task.id, action)
                for task in record_store.all_tasks()
                if (action := record_store.actions.outstanding(task.id)) is not None
            ]
            items.extend(
                _slot_item(occupant) for occupant in record_store.actions.outstanding_slots()
            )
        finally:
            record_store.close()
        with self._lock:
            self._state.startup_review = tuple(items)
            self._state.startup_checked_at = datetime.now(UTC)
        return tuple(items)

    def _outstanding_item(self, task_id: str, action: object) -> dict[str, str]:
        """一条未核对动作：动作身份 + 启动时刻 + 该任务的副作用证据。"""

        node = str(getattr(action, "node", ""))
        action_id = str(getattr(action, "action_id", ""))
        started_at = getattr(action, "started_at", None)
        moment = started_at.isoformat() if isinstance(started_at, datetime) else ""
        return {
            "kind": "outstanding_action",
            "ref_id": task_id,
            "summary": f"未核对动作：{node}（结果不明确，禁止重放）",
            "detail": (
                f"动作 {action_id} 于 {moment} 启动且未完成；"
                f"{_side_effect_evidence(self._records_root, task_id)}；"
                "请用 `forgeloop requirement actions list|clear` 核对现场并释放后再推进。"
            ),
        }

    def _outstanding_tasks(self, record_store: RecordStore) -> frozenset[str]:
        """当前存在未释放 ``started`` 动作的任务身份集合（一次扫描，供筛选共用）。"""

        return frozenset(
            task.id
            for task in record_store.all_tasks()
            if record_store.actions.outstanding(task.id) is not None
        )

    def survey(self) -> tuple[dict[str, RequirementTaskRunner], dict[str, str]]:
        """只读筛选本轮可自动接续的需求，并把结果记入状态（不执行、不写记录）。

        返回值是「可推进的 req_id → 已装配的执行器」与「被跳过的 req_id → 原因」；
        ``--once`` 与状态文档据此也能看到「现在会不会被执行、为什么不会」。
        """

        runners, skipped = self._select()
        with self._lock:
            self._state.candidates = tuple(sorted(runners))
            self._state.skipped = tuple(
                {"req_id": req_id, "reason": reason} for req_id, reason in sorted(skipped.items())
            )
            if not runners:
                self._state.executed = ()
                self._state.results = ()
        return runners, skipped

    def _executable_projects(self) -> tuple[str, ...]:
        return tuple(
            name
            for name, profile in self._projects.items()
            if worker_eligibility(
                project_configured=True,
                plan_approved=True,
                next_actor=ActionActor.AGENT.value,
                process_home=self._process_home,
                project_home=profile.pi_home,
            ).eligible
        )

    def _select(self) -> tuple[dict[str, RequirementTaskRunner], dict[str, str]]:
        if not self._projects:
            return {}, {}
        store = RequirementStore(self._records_root / "records.sqlite")
        record_store = RecordStore(self._records_root / "records.sqlite")
        try:
            outstanding = self._outstanding_tasks(record_store)
            runners: dict[str, RequirementTaskRunner] = {}
            skipped: dict[str, str] = {}
            for requirement in store.all_requirements():
                decision, runner = self._classify(store, record_store, requirement, outstanding)
                if runner is None:
                    skipped[requirement.req_id] = decision.reason
                else:
                    runners[requirement.req_id] = runner
            return runners, skipped
        finally:
            record_store.close()
            store.close()

    def _classify(
        self,
        store: RequirementStore,
        record_store: RecordStore,
        requirement: Requirement,
        outstanding: frozenset[str] = frozenset(),
    ) -> tuple[Eligibility, RequirementTaskRunner | None]:
        """单条需求的只读判定；``runner`` 非空表示可以自动接续。"""

        profile = self._projects.get(requirement.project)
        plan = store.authorized_task_plan(requirement.req_id) if profile is not None else None
        runner = (
            self._runner(requirement, plan, profile)
            if profile is not None and plan is not None
            else None
        )
        next_actor = ""
        if runner is not None:
            executor = RequirementExecutor(
                store, requirement.req_id, runner, slots=record_store.actions
            )
            next_actor = executor.progress().next_step.actor.value
        blocked = bool(
            plan is not None
            and any(
                requirement_task_id(requirement.req_id, plan.plan_version, task.task_id)
                in outstanding
                for task in plan.tasks
            )
        )
        decision = worker_eligibility(
            project_configured=profile is not None,
            plan_approved=plan is not None,
            next_actor=next_actor,
            process_home=self._process_home,
            project_home=profile.pi_home if profile is not None else "",
            has_outstanding_action=blocked,
        )
        return decision, (runner if decision.eligible else None)

    def _runner(
        self, requirement: Requirement, plan: TaskPlan, profile: ProjectProfile
    ) -> RequirementTaskRunner:
        """装配与 CLI 同一套执行器：命令、项目路径与基线都来自项目档案。"""

        return RequirementTaskRunner(
            records_root=self._records_root,
            req_id=requirement.req_id,
            plan_version=plan.plan_version,
            project=requirement.project,
            pi_command=profile.pi_command,
            project_path=profile.path,
            baseline=profile.baseline,
        )

    def _run(self) -> None:
        while not self._stop.wait(self._poll_seconds):
            try:
                self._tick()
            except Exception as error:  # 单次心跳失败不能终止常驻进程
                with self._lock:
                    self._state.last_error = str(error)
            finally:
                with self._lock:
                    self._state.polls += 1
                    self._state.last_poll_at = datetime.now(UTC)

    def advance_requirement(self, req_id: str) -> dict:
        """显式推进**一条**需求（页面「推进本次」）；不符合筛选条件时抛 :class:`WorkerRefused`。

        与自动接续使用同一套筛选与同一套编排：批准绑定、停止、失败累计、槽位互斥
        一条不放宽，也不越过人工验收。
        """

        store = RequirementStore(self._records_root / "records.sqlite")
        record_store = RecordStore(self._records_root / "records.sqlite")
        try:
            requirement = store.get(req_id)
            decision, runner = self._classify(
                store, record_store, requirement, self._outstanding_tasks(record_store)
            )
            if runner is None:
                raise WorkerRefused(decision.reason or "该需求当前不可自动推进")
            dispatcher = RequirementDispatcher(
                self._records_root, max_concurrent=self._max_concurrent
            )
            try:
                progress = dispatcher.advance(req_id, runner)
            except RequirementAlreadyRunningError as error:
                with self._lock:
                    self._state.last_error = str(error)
                raise WorkerRefused(str(error)) from error
            summary = _progress_summary(progress)
            with self._lock:
                self._state.executed = (req_id,)
                self._state.results = ({"req_id": req_id, **summary},)
            return summary
        finally:
            record_store.close()
            store.close()

    def current_task_thread_id(self, req_id: str) -> str:
        """需求当前任务的单任务身份（供停止入口定位）；没有可定位任务时抛 :class:`WorkerRefused`。"""

        store = RequirementStore(self._records_root / "records.sqlite")
        try:
            requirement = store.get(req_id)
            if self._projects.get(requirement.project) is None:
                raise WorkerRefused("项目未在 config/service.toml 配置，无法定位执行现场")
        finally:
            store.close()
        # 解析本身与项目档案无关：与页面/邮件共用同一只读实现（见模块级函数）。
        return current_task_thread_id(self._records_root, req_id)

    def request_advance(self, req_id: str) -> None:
        """排队一次**显式**推进请求（页面「推进本次」按钮）。

        这是调度提示而不是业务状态：只存在进程内存里，重启即消失（业务事实仍在记录
        里，人工可以再点一次）。之所以排队而不是就地执行，是因为一次推进要跑完当前
        任务的 dev/review/test（分钟级），HTTP 请求不该陪着一起等——接口按方案 §4.2
        返回 202 受理，实际执行落在下一次心跳。
        """

        with self._lock:
            self._pending[req_id] = None

    def pending_advance(self) -> tuple[str, ...]:
        """当前排队等待执行的显式推进请求（进状态文档，让人工看得见）。"""

        with self._lock:
            return tuple(self._pending)

    def advance_eligibility(self, req_id: str) -> Eligibility:
        """只读判定某需求此刻能否推进（页面点击时立刻给拒绝原因，不排队）。

        找不到需求时抛 ``RequirementNotFoundError``（与状态查询同一口径）。
        """

        store = RequirementStore(self._records_root / "records.sqlite")
        record_store = RecordStore(self._records_root / "records.sqlite")
        try:
            requirement = store.get(req_id)
            decision, _ = self._classify(
                store, record_store, requirement, self._outstanding_tasks(record_store)
            )
            return decision
        finally:
            record_store.close()
            store.close()

    def poll_once(self) -> None:
        """执行一次心跳；**显式推进请求不受 ``auto_advance`` 限制**。

        关闭开关只意味着「不自动接续」，人工点下的推进仍要执行——否则默认关闭的部署
        里，页面按钮会永远没有反应。
        """

        self._tick()

    def advance_once(self, *, only: set[str] | None = None) -> dict[str, dict]:
        """推进一次（不受 ``auto_advance`` 限制）；返回 req_id → 结果摘要。

        ``only`` 给定时只执行集合内的需求（页面排队请求用），但**筛选规则完全一致**：
        不越过批准、停止、未核对动作、槽位与 PI HOME 前提；集合外的需求不会被顺手推进。
        ``only`` 里的需求若此刻不再满足前提，就如实记进 ``last_tick.skipped``。
        """

        runners, skipped = self.survey()
        if only is not None:
            runners = {req_id: runner for req_id, runner in runners.items() if req_id in only}
            for req_id in sorted(only - set(runners)):
                skipped.setdefault(req_id, "该需求当前不可推进（前提不再成立或已在运行）")
        if not runners:
            with self._lock:
                self._state.executed = ()
                self._state.results = ()
                self._state.skipped = tuple(
                    {"req_id": req_id, "reason": reason}
                    for req_id, reason in sorted(skipped.items())
                )
            return {}
        dispatcher = RequirementDispatcher(self._records_root, max_concurrent=self._max_concurrent)
        try:
            outcomes = dispatcher.advance_all(runners)
        except RequirementAlreadyRunningError as error:
            # 同一需求已被别的推进占用：跳过本轮，不重复启动，也不清掉既有结果。
            with self._lock:
                self._state.last_error = str(error)
            return {}
        summaries = {req_id: _progress_summary(progress) for req_id, progress in outcomes.items()}
        with self._lock:
            self._state.executed = tuple(sorted(outcomes))
            self._state.results = tuple(
                {"req_id": req_id, **summary} for req_id, summary in sorted(summaries.items())
            )
        return summaries

    def _tick(self) -> None:
        """一次心跳：先执行排队的显式推进，再按开关自动接续本轮筛选出的需求。"""

        explicit = self._take_pending()
        if explicit:
            self.advance_once(only=set(explicit))
        if self._auto_advance:
            self.advance_once()

    def _take_pending(self) -> tuple[str, ...]:
        """取走排队的显式请求（取走即消费；执行失败不自动重排，由人工决定）。"""

        with self._lock:
            pending = tuple(self._pending)
            self._pending.clear()
        return pending


def _slot_item(occupant: object) -> dict[str, str]:
    """一条残留执行槽位：占用者与开始时刻；清理入口是 ``requirement slot clear``。"""

    slot = str(getattr(occupant, "task_id", "")).removeprefix(SLOT_PREFIX)
    owner = str(getattr(occupant, "role", ""))
    started_at = getattr(occupant, "started_at", None)
    moment = started_at.isoformat() if isinstance(started_at, datetime) else ""
    return {
        "kind": "slot_residue",
        "ref_id": slot,
        "summary": "存在未完成的执行槽位，需人工核对现场后再清理",
        "detail": (
            f"占用者 {owner or 'unknown'}，开始 {moment}；"
            "确认没有推进在运行后用 `forgeloop requirement slot clear --slot "
            f"{slot}` 清理。"
        ),
    }


def _side_effect_evidence(records_root: Path, task_id: str) -> str:
    """副作用证据：候选 diff 的内容身份与工作副本是否存在，供人工核对现场。"""

    task_dir = records_root / task_id
    candidate = task_dir / "candidate.diff"
    if candidate.is_file():
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()[:12]
        candidate_text = f"候选 diff sha256:{digest}"
    else:
        candidate_text = "无候选 diff"
    workspace_text = "工作副本存在" if (task_dir / "workspace").is_dir() else "无工作副本"
    return f"{candidate_text}，{workspace_text}"


def _progress_summary(progress: object) -> dict:
    """推进结果的最小摘要（只放对外可读字段，不放内部对象）。"""

    return {
        "status": str(getattr(progress, "requirement_status", "")),
        "current_task": str(getattr(progress, "current_task", "") or ""),
        "next_step": str(getattr(getattr(progress, "next_step", None), "action", "")),
        "blocked_reason": str(getattr(progress, "blocked_reason", "")),
    }


def current_task_thread_id(records_root: Path, req_id: str) -> str:
    """需求当前任务的单任务身份；**只读记录**，不依赖项目档案（三入口共用）。

    页面与邮件都要"把需求解析成可停止的当前任务"。此前该解析只在常驻 worker 的方法里、
    依赖服务配置的项目档案，致使邮件入口必须先起服务。这里下沉为纯记录解析：最新任务包
    + 执行进度；`RequirementExecutor.progress()` 本身是只读汇总，不启动任何动作。
    """

    store = RequirementStore(records_root / "records.sqlite")
    record_store = RecordStore(records_root / "records.sqlite")
    try:
        plan = store.latest_task_plan(req_id)
        if plan is None:
            raise WorkerRefused("需求还没有任务包，无法定位要停止的任务")
        executor = RequirementExecutor(store, req_id, _read_only_runner, slots=record_store.actions)
        current = executor.progress().current_task
        if not current:
            raise WorkerRefused("需求当前没有可停止的任务")
        return requirement_task_id(req_id, plan.plan_version, current)
    finally:
        record_store.close()
        store.close()


def _read_only_runner(_task: TaskExecution) -> TaskResult:
    """占位运行器：只读解析永不调用它；真被调用说明用法错了，直接拒绝。"""

    raise WorkerRefused("只读解析不应启动执行")
