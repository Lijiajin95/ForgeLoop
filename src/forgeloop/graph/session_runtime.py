"""会话常驻进程池（graph 层）：一个会话一个 PI 进程，用它保持服务端多轮上下文。

事实依据（206 份真实 PI 轨迹，见 ``docs/status.md`` 的面板批次记录）：

- ``agent_settled`` 的协议语义是「不再有自动重试、压缩或**排队续接**」——协议本身为
  同一进程承接多轮输入而设计；
- 运行期事件里有 ``entry_appended`` 的 ``context_edit``，说明上下文是**进程内**的账本
  （``--no-session`` 只表示不落盘、不从会话文件恢复，不等于每轮清空上下文）。

因此本模块把「一轮一个进程」改成「一个会话一个进程」：

- **暖进程**：进程还活着就直接发新指令，上下文由它自己保持（提示词只带本次输入）；
- **冷启动**：首次或进程已退出、被空闲回收后，新建进程并回放历史（否则上下文真的丢）；
- **有界**：空闲超过 ``idle_seconds`` 回收，空闲进程数不超过 ``max_live``（按最近使用
  淘汰）；正在跑的一轮不回收，也不因上限被踢掉。

**未验证（如实标注）**：本环境没有 ``pi`` 二进制与模型访问，真实模型下「同一进程第二轮
确实看得见第一轮上下文」未经实测；集成与系统层用假 PI 覆盖调度与状态机，真假 PI 的差别
记录在状态文档的未验证清单里。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from forgeloop.adapter.pi_rpc import PIProcess


@dataclass(frozen=True)
class LiveSession:
    """一个常驻会话进程的对外事实（供状态文档与页面「运行时」一栏展示）。"""

    session_id: str
    pid: int | None
    turns: int
    cold_starts: int
    idle_seconds: float
    started_at: str
    busy: bool


class SessionProcess:
    """一个会话的进程槽：进程退出后由下一次取用负责换新（并计一次冷启动）。"""

    def __init__(self, session_id: str, factory: Callable[[], PIProcess]) -> None:
        self._session_id = session_id
        self._factory = factory
        self._process: PIProcess | None = None
        self._turns = 0
        self._cold_starts = 0
        self._last_used = time.monotonic()
        self._started_at = ""
        self._busy = False

    @property
    def session_id(self) -> str:
        return self._session_id

    def is_alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    @property
    def busy(self) -> bool:
        return self._busy

    def mark_busy(self, busy: bool) -> None:
        self._busy = busy
        self._last_used = time.monotonic()

    def touch(self) -> None:
        self._turns += 1
        self._last_used = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_used

    def acquire(self) -> tuple[PIProcess, bool]:
        """返回 ``(进程, 是否冷启动)``；进程已死则换一个新的。

        只有这里会启动进程：暖进程直接复用（多轮上下文就在它手里），冷启动计一次数并
        记下启动时间，供页面说明「这一轮为什么回放了历史」。
        """

        if self.is_alive():
            assert self._process is not None  # is_alive 为真时必然有进程
            return self._process, False
        self.close()
        self._process = self._factory()
        self._process.start()
        self._cold_starts += 1
        self._started_at = datetime.now(UTC).isoformat()
        return self._process, True

    def abort(self) -> bool:
        """请求中止当前一轮；没有活进程时返回 ``False``（不假装中止了什么）。"""

        if not self.is_alive():
            return False
        assert self._process is not None
        try:
            self._process.request_stop()
        except Exception:
            # 子进程在读写之间退出：终止事实由调用方落库，这里不伪装成功。
            return False
        return True

    def close(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            process.close()

    def status(self) -> LiveSession:
        return LiveSession(
            session_id=self._session_id,
            pid=None if self._process is None else self._process.pid,
            turns=self._turns,
            cold_starts=self._cold_starts,
            idle_seconds=self.idle_seconds(),
            started_at=self._started_at,
            busy=self._busy,
        )


class SessionProcessPool:
    """常驻会话进程的有界池：取用、淘汰、停机都在这里，调用方只按会话身份取进程。"""

    def __init__(
        self,
        factory: Callable[[str], PIProcess],
        *,
        idle_seconds: float = 900.0,
        max_live: int = 4,
    ) -> None:
        self._factory = factory
        self._idle_seconds = idle_seconds
        self._max_live = max(1, max_live)
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionProcess] = {}
        self._closed = False

    def acquire(self, session_id: str) -> tuple[SessionProcess, PIProcess, bool]:
        """取该会话的进程槽：``(进程槽, 进程, 是否冷启动)``。

        冷启动前先按上限淘汰最久未用的**空闲**会话（正在跑的一轮不淘汰）。关闭旧进程会
        等它退出（最长数秒），因此放在锁外做，避免一个会话的收尾卡住其他会话。
        """

        with self._lock:
            if self._closed:
                raise RuntimeError("会话进程池已停止")
            slot = self._sessions.get(session_id)
            if slot is None:
                slot = SessionProcess(session_id, lambda: self._factory(session_id))
                self._sessions[session_id] = slot
            doomed = self._evict_locked(keep=session_id)
            process, cold = slot.acquire()
        for dead in doomed:
            dead.close()
        return slot, process, cold

    def get(self, session_id: str) -> SessionProcess | None:
        with self._lock:
            return self._sessions.get(session_id)

    def release(self, session_id: str, *, keep: bool) -> bool:
        """一轮结束后归还槽位；``keep=False`` 表示立刻收起该会话的进程。

        返回是否真的收起了进程（用于终止路径的「有没有中止到活进程」判定）。
        """

        with self._lock:
            slot = self._sessions.get(session_id)
            if slot is None:
                return False
            slot.mark_busy(False)
            if keep:
                return False
            self._sessions.pop(session_id, None)
        slot.close()
        return True

    def reap(self) -> tuple[str, ...]:
        """回收空闲超时的会话进程，返回被回收的会话身份（供状态与日志）。"""

        with self._lock:
            expired = [
                session_id
                for session_id, slot in self._sessions.items()
                if not slot.busy and slot.idle_seconds() >= self._idle_seconds
            ]
            slots = [self._sessions.pop(session_id) for session_id in expired]
        for slot in slots:
            slot.close()
        return tuple(expired)

    def abort(self, session_id: str) -> bool:
        slot = self.get(session_id)
        return False if slot is None else slot.abort()

    def status(self) -> tuple[LiveSession, ...]:
        with self._lock:
            slots = list(self._sessions.values())
        return tuple(slot.status() for slot in slots)

    def shutdown(self) -> None:
        """停机：中止并关闭所有常驻进程，之后不再接受取用。"""

        with self._lock:
            self._closed = True
            slots = list(self._sessions.values())
            self._sessions.clear()
        for slot in slots:
            slot.abort()
            slot.close()

    def _evict_locked(self, *, keep: str) -> list[SessionProcess]:
        """按上限挑出要淘汰的槽位（只挑空闲且不是当前会话的，最久未用的先走）。

        只从登记表里摘除并返回，真正关闭由调用方在锁外完成。
        """

        idle = [
            (slot.idle_seconds(), session_id, slot)
            for session_id, slot in self._sessions.items()
            if session_id != keep and not slot.busy
        ]
        doomed: list[SessionProcess] = []
        while len(self._sessions) - len(doomed) > self._max_live and idle:
            _, session_id, slot = max(idle, key=lambda item: item[0])
            idle = [item for item in idle if item[1] != session_id]
            self._sessions.pop(session_id, None)
            doomed.append(slot)
        return doomed
