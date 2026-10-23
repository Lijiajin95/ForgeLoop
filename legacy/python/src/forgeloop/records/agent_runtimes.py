"""Agent Runtime 运行状态记录：当前选择与切换审计（权威记录）。

规则（与 ``domain.agent_runtime`` 同源，本层只负责落库与回查）：

- 当前状态按 ``scope`` 单行保存（当前只用 ``default``）；每次 ``set`` 都写一条切换
  审计（谁、何时、从哪个运行时切到哪个、命令、理由），历史只追加不覆盖。
- 切换是显式人工动作：``by`` 与 ``reason`` 必须非空白，未知运行时或非法命令
  fail-closed 且零副作用，不留下“看起来切过”的半状态。
"""

import json
import sqlite3
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.domain.agent_runtime import (
    AgentRuntimeError,
    AgentRuntimeState,
    parse_command,
    parse_runtime,
    switch_command,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_runtime_state (
    scope TEXT PRIMARY KEY,
    runtime TEXT NOT NULL,
    command_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_runtime_switches (
    switch_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    from_runtime TEXT NOT NULL,
    to_runtime TEXT NOT NULL,
    command_json TEXT NOT NULL,
    switched_at TEXT NOT NULL,
    switched_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agent_runtime_switches_by_scope
    ON agent_runtime_switches (scope, switched_at);
"""

DEFAULT_SCOPE = "default"
_EMPTY_RUNTIME = ""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _parse(text: str) -> datetime:
    return datetime.fromisoformat(text)


def _encode_command(command: Sequence[str]) -> str:
    return json.dumps(list(command), ensure_ascii=False)


def _decode_command(raw: str) -> tuple[str, ...]:
    return parse_command(raw, label="command_json")


@dataclass(frozen=True)
class AgentRuntimeSwitch:
    """一次运行时切换的审计事实。"""

    switch_id: str
    scope: str
    from_runtime: str
    to_runtime: str
    command: tuple[str, ...]
    switched_at: datetime
    switched_by: str
    reason: str


class AgentRuntimeStore:
    """``records.sqlite`` 里的 Agent Runtime 运行状态与切换审计。"""

    def __init__(self, db_path: Path) -> None:
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        self._conn.close()

    def current(self, scope: str = DEFAULT_SCOPE) -> AgentRuntimeState | None:
        """当前生效的运行时选择；从未设置过返回 ``None``（由领域规则回落到默认）。"""

        row = self._conn.execute(
            "SELECT runtime, command_json, updated_at, updated_by, reason"
            " FROM agent_runtime_state WHERE scope = ?",
            (scope,),
        ).fetchone()
        if row is None:
            return None
        return AgentRuntimeState(
            runtime=str(row[0]),
            command=_decode_command(str(row[1])),
            updated_at=_parse(str(row[2])),
            updated_by=str(row[3]),
            reason=str(row[4]),
        )

    def set_runtime(
        self,
        runtime: str,
        *,
        command: Sequence[str] = (),
        by: str,
        reason: str,
        scope: str = DEFAULT_SCOPE,
        at: datetime | None = None,
    ) -> AgentRuntimeState:
        """切换（或确认）当前运行时并追加审计；非法输入零副作用。"""

        parsed = parse_runtime(runtime)
        resolved_command = switch_command(parsed, command)
        operator = by.strip()
        if not operator:
            raise AgentRuntimeError("切换 Agent Runtime 必须提供调用方标识（--by）")
        detail = reason.strip()
        if not detail:
            raise AgentRuntimeError("切换 Agent Runtime 必须提供理由（--reason）")
        moment = at or _now()
        previous = self.current(scope)
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute(
                "INSERT INTO agent_runtime_state"
                " (scope, runtime, command_json, updated_at, updated_by, reason)"
                " VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(scope) DO UPDATE SET"
                " runtime = excluded.runtime, command_json = excluded.command_json,"
                " updated_at = excluded.updated_at, updated_by = excluded.updated_by,"
                " reason = excluded.reason",
                (
                    scope,
                    parsed,
                    _encode_command(resolved_command),
                    _iso(moment),
                    operator,
                    detail,
                ),
            )
            self._conn.execute(
                "INSERT INTO agent_runtime_switches"
                " (switch_id, scope, from_runtime, to_runtime, command_json,"
                "  switched_at, switched_by, reason)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"rt-{moment.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}",
                    scope,
                    previous.runtime if previous is not None else _EMPTY_RUNTIME,
                    parsed,
                    _encode_command(resolved_command),
                    _iso(moment),
                    operator,
                    detail,
                ),
            )
            self._conn.execute("COMMIT")
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        return AgentRuntimeState(parsed, resolved_command, moment, operator, detail)

    def history(
        self, scope: str = DEFAULT_SCOPE, limit: int = 20
    ) -> tuple[AgentRuntimeSwitch, ...]:
        """按时间倒序返回切换审计；``limit`` 非正时返回空元组。"""

        if limit <= 0:
            return ()
        rows = self._conn.execute(
            "SELECT switch_id, scope, from_runtime, to_runtime, command_json,"
            " switched_at, switched_by, reason"
            " FROM agent_runtime_switches WHERE scope = ?"
            " ORDER BY switched_at DESC, rowid DESC LIMIT ?",
            (scope, limit),
        ).fetchall()
        return tuple(
            AgentRuntimeSwitch(
                switch_id=str(row[0]),
                scope=str(row[1]),
                from_runtime=str(row[2]),
                to_runtime=str(row[3]),
                command=_decode_command(str(row[4])),
                switched_at=_parse(str(row[5])),
                switched_by=str(row[6]),
                reason=str(row[7]),
            )
            for row in rows
        )
