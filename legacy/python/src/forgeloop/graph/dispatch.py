"""多个需求并行推进、同项目交付串行（A05）。

职责边界（DogFood 执行计划 A05）：

- **复用既有业务图**：并行推进仍由 ``graph.requirements.RequirementExecutor`` 完成，
  本模块只负责在进程内并发调用它，不重写任何单需求编排。
- **独立现场与记录身份**：每次推进打开自己的记录连接，任务推进记录与前置产物都按
  ``req_id`` 命名空间落库；不同需求互不读写对方记录。
- **限制并发资源**：``advance_all`` 用有上限的线程池并行，``max_concurrent`` 是本次
  运行允许同时执行的需求数上限。
- **同需求不重复运行**：``RequirementExecutor`` 注入记录层执行槽位，同一需求并发启动
  只有一个能拿到槽位，其余抛 :class:`RequirementAlreadyRunningError`。
- **同项目交付串行**：``project_delivery`` 用进程内项目互斥锁排队，再用记录层项目槽位
  跨实例/进程互斥；不同项目可并行。

本模块只做最小进程级执行，不建设通用调度平台：没有队列持久化，没有优先级、抢占或
跨项目编排，资源上限也只是当前进程内的线程池大小。进程被强杀会留下未完成的执行槽位
（与 B03 的未完成动作同口径）：后续推进拒绝重放，需人工核对现场后用
``forgeloop requirement slot list`` 查看、``forgeloop requirement slot clear`` 清理，再重
新推进——届时业务图会把未完成动作标记 ``interrupted``，恢复路径始终可达。
"""

import threading
import time
from collections.abc import Callable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path

from forgeloop.graph.requirements import (
    Clock,
    RequirementExecutor,
    RequirementProgress,
    TaskExecution,
    TaskResult,
)
from forgeloop.records.actions import ActionRecord, ActionStore, ExecutionSlotBusyError
from forgeloop.records.requirements import RequirementStore
from forgeloop.records.store import RecordStore

# 同项目交付槽位的命名空间；同一需求推进的槽位由 RequirementExecutor 统一构造。
PROJECT_DELIVERY_SLOT = "project-delivery"

# 归并/发布默认等待同项目交付互斥的上限；超时拒绝而不是并发更新主干。
DEFAULT_DELIVERY_TIMEOUT_SECONDS = 1800.0


def project_delivery_slot(project: str) -> str:
    """同项目交付槽位名（CLI 查看/清理与调度器共用同一命名）。"""

    return f"{PROJECT_DELIVERY_SLOT}:{project}"


def project_delivery(
    records_root: Path,
    project: str,
    *,
    timeout: float | None = DEFAULT_DELIVERY_TIMEOUT_SECONDS,
) -> AbstractContextManager[None]:
    """归并/发布入口获取同项目交付互斥的便捷入口。

    每次调用新建一个调度器：跨进程互斥靠记录层槽位，不依赖调用方共享实例。
    """

    return RequirementDispatcher(records_root, delivery_timeout=timeout).project_delivery(project)


class DispatchError(RuntimeError):
    """调度层无法满足并发约束。"""


class ProjectDeliveryBusyError(DispatchError):
    """同项目交付槽位在等待上限内始终被占用：拒绝本次交付。"""

    def __init__(self, project: str) -> None:
        super().__init__(
            f"同项目交付槽位仍被占用，等待超时: {project}；"
            "可能是其他归并/发布在进行，或上一进程被中断的残留。"
            "请用 `forgeloop requirement slot list` 核对现场，确认无交付在运行后用"
            f"`forgeloop requirement slot clear --slot {project_delivery_slot(project)}` 清理再重试"
        )
        self.project = project


class RequirementDispatcher:
    """进程内并行推进多个需求，并串行同项目交付的最小调度器。

    ``clock`` 默认 ``time.monotonic``，只用于交付槽位的等待时限，不参与业务工时；
    业务工时由注入的 ``run_task`` 与 ``RequirementExecutor`` 的 ``clock`` 度量。
    """

    def __init__(
        self,
        records_root: Path,
        *,
        max_concurrent: int = 2,
        clock: Clock = time.monotonic,
        delivery_timeout: float | None = 30.0,
        poll_seconds: float = 0.01,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent 必须是正整数")
        if delivery_timeout is not None and delivery_timeout < 0:
            raise ValueError("delivery_timeout 不能为负")
        if poll_seconds <= 0:
            raise ValueError("poll_seconds 必须为正数")
        self._root = Path(records_root)
        self._max_concurrent = max_concurrent
        self._clock = clock
        self._delivery_timeout = delivery_timeout
        self._poll_seconds = poll_seconds
        self._sleep = sleep
        self._locks_guard = threading.Lock()
        self._project_locks: dict[str, threading.Lock] = {}

    @property
    def max_concurrent(self) -> int:
        return self._max_concurrent

    def advance(
        self,
        req_id: str,
        run_task: Callable[[TaskExecution], TaskResult],
    ) -> RequirementProgress:
        """在独立记录连接上推进一条需求；同一需求已被占用时明确拒绝。"""

        store = RequirementStore(self._root / "records.sqlite")
        record_store = RecordStore(self._root / "records.sqlite")
        try:
            executor = RequirementExecutor(
                store,
                req_id,
                run_task,
                clock=self._clock,
                slots=record_store.actions,
            )
            return executor.advance()
        finally:
            record_store.close()
            store.close()

    def advance_all(
        self,
        requests: Mapping[str, Callable[[TaskExecution], TaskResult]],
    ) -> dict[str, RequirementProgress]:
        """并行推进多条需求，返回值按 ``req_id`` 索引。

        线程数不超过 ``max_concurrent``；某个需求已在别处推进时该分支抛出
        :class:`RequirementAlreadyRunningError`。其余需求仍完成推进并落库，函数在全部
        分支结束后再抛出该错误，避免半途取消留下难以解释的假失败。
        """

        outcomes: dict[str, RequirementProgress] = {}
        errors: dict[str, Exception] = {}
        with ThreadPoolExecutor(max_workers=self._max_concurrent) as pool:
            futures = {
                req_id: pool.submit(self.advance, req_id, run_task)
                for req_id, run_task in requests.items()
            }
            for req_id, future in futures.items():
                try:
                    outcomes[req_id] = future.result()
                except Exception as error:
                    errors[req_id] = error
        if errors:
            first = next(iter(errors))
            raise errors[first]
        return outcomes

    @contextmanager
    def project_delivery(self, project: str) -> Iterator[None]:
        """同项目交付互斥：进程内排队 + 记录层槽位跨实例互斥。

        进程内先按项目取互斥锁，保证同进程调用排队而不是忙等；再用记录层槽位在
        多个 dispatcher（模拟多个进程）之间互斥。等待超过 ``delivery_timeout`` 时抛
        :class:`ProjectDeliveryBusyError`，不无限占用。
        """

        with self._project_lock(project):
            record_store = RecordStore(self._root / "records.sqlite")
            try:
                slot = self._claim_project_slot(record_store.actions, project)
                try:
                    yield
                finally:
                    record_store.actions.release_slot(slot.action_id)
            finally:
                record_store.close()

    def _project_lock(self, project: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._project_locks.get(project)
            if lock is None:
                lock = threading.Lock()
                self._project_locks[project] = lock
            return lock

    def _claim_project_slot(self, actions: ActionStore, project: str) -> ActionRecord:
        slot_key = project_delivery_slot(project)
        deadline = (
            None if self._delivery_timeout is None else self._clock() + self._delivery_timeout
        )
        while True:
            try:
                return actions.claim_slot(slot_key, owner=project)
            except ExecutionSlotBusyError:
                if deadline is not None and self._clock() >= deadline:
                    raise ProjectDeliveryBusyError(project) from None
                self._sleep(self._poll_seconds)
