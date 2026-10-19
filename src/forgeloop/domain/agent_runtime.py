"""Agent Runtime 领域规则：PI 与 DSH 同属可插拔执行器（纯规则）。

术语与语义（本模块只回答“该用哪个运行时、用哪条命令”）：

- **Agent Runtime** 是真正执行一次 Agent 会话的外部执行器；当前有 PI（``pi --mode rpc``）
  与 DSH（``dsh --profile headless --json``）两个实现，两者都只经由 ``adapter`` 层接入。
- **热切换**：解析发生在**每次动作启动前**，不写回任务方案或批准。切换本身是记录层
  的操作事实（``records.agent_runtimes``），不改任务配置快照、不使批准失效。
- **选择优先级**：进程环境覆盖（``FORGELOOP_AGENT_RUNTIME``）> 运行状态记录 > 内建默认
  （PI）。PI 没有内建启动命令：缺命令时 fail-closed，不静默猜一条命令把配置错误伪装成
  可用执行器；DSH 的默认命令就是官方 headless 一次性调用契约。
- **命令优先级**：显式命令行参数（``--pi-command``/``--dsh-command``）> PI 任务配置快照
  （只有 PI 有 ``pi_command`` 快照）> 运行状态记录里的同名运行时命令 > DSH 内建默认。
  运行状态里的 PI 命令用于没有任务快照的规划阶段；已有任务仍用提交时的快照，保证可复现。
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import cast

# 运行时名字是跨层契约：记录层落库、图节点解析、会话文件与证据里都出现。
PI = "pi"
DSH = "dsh"
RUNTIMES: tuple[str, ...] = (PI, DSH)
DEFAULT_RUNTIME = PI
# DSH 官方 headless 一次性运行契约：一个进程回答一个任务，stdout 是 JSONL 事件流。
DEFAULT_DSH_COMMAND: tuple[str, ...] = ("dsh", "--profile", "headless", "--json")

# 选择来源标签随证据落盘，供回查“这一动作为什么用了这个执行器”。
SOURCE_ENVIRONMENT = "environment"
SOURCE_STATE = "state"
SOURCE_DEFAULT = "default"
SOURCE_PI_COMMAND = "pi-command"
SOURCE_DSH_COMMAND = "dsh-command"


class AgentRuntimeError(ValueError):
    """运行时名称、启动命令或选择来源非法：调用方必须 fail-closed。"""


@dataclass(frozen=True)
class AgentRuntimeState:
    """记录层里当前生效的运行时选择（命令可为空：表示用任务配置或命令行参数）。"""

    runtime: str
    command: tuple[str, ...] = ()
    updated_at: datetime | None = None
    updated_by: str = ""
    reason: str = ""


@dataclass(frozen=True)
class ResolvedAgentRuntime:
    """一次动作实际使用的运行时与命令，以及两个来源标签（证据用）。"""

    runtime: str
    command: tuple[str, ...]
    runtime_source: str
    command_source: str


def parse_runtime(raw: str) -> str:
    """把外部输入解析为已知运行时名；未知或空白一律拒绝。"""

    candidate = raw.strip()
    if candidate not in RUNTIMES:
        known = "、".join(RUNTIMES)
        raise AgentRuntimeError(f"未知 Agent Runtime: {raw!r}；已知运行时: {known}")
    return candidate


def parse_command(raw: object, *, label: str = "command") -> tuple[str, ...]:
    """解析启动命令：JSON 字符串数组文本或字符串序列；允许空（表示缺省）。"""

    parsed: object = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return ()
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            raise AgentRuntimeError(f"{label} 必须是 JSON 字符串数组: {error}") from error
    if isinstance(parsed, Sequence) and not isinstance(parsed, (str, bytes)):
        parts = cast("Sequence[object]", parsed)
        command: list[str] = []
        for part in parts:
            if not isinstance(part, str) or not part:
                raise AgentRuntimeError(f"{label} 必须是非空字符串数组（JSON）")
            command.append(part)
        return tuple(command)
    raise AgentRuntimeError(f"{label} 必须是非空字符串数组（JSON）")


def default_command(runtime: str) -> tuple[str, ...]:
    """运行时的内建默认命令；PI 没有默认（返回空元组）。"""

    return DEFAULT_DSH_COMMAND if parse_runtime(runtime) == DSH else ()


def switch_command(runtime: str, command: Sequence[str] = ()) -> tuple[str, ...]:
    """一次 ``runtime set`` 实际落库的命令：显式命令优先，DSH 缺省用官方默认。"""

    parsed = parse_runtime(runtime)
    raw: object = command if isinstance(command, str) else list(command)
    explicit = parse_command(raw, label="--command")
    if explicit:
        return explicit
    return default_command(parsed)


def resolve_agent_runtime(
    *,
    active: AgentRuntimeState | None = None,
    runtime_override: str = "",
    pi_command: Sequence[str] = (),
    dsh_command: Sequence[str] = (),
) -> ResolvedAgentRuntime:
    """解析一次动作使用的运行时与命令；任一必需项缺失即 fail-closed。"""

    if runtime_override.strip():
        runtime = parse_runtime(runtime_override)
        runtime_source = SOURCE_ENVIRONMENT
    elif active is not None:
        runtime = parse_runtime(active.runtime)
        runtime_source = SOURCE_STATE
    else:
        runtime = DEFAULT_RUNTIME
        runtime_source = SOURCE_DEFAULT
    if runtime == DSH:
        if dsh_command:
            return ResolvedAgentRuntime(
                runtime, tuple(dsh_command), runtime_source, SOURCE_DSH_COMMAND
            )
        if active is not None and active.runtime == DSH and active.command:
            return ResolvedAgentRuntime(runtime, active.command, runtime_source, SOURCE_STATE)
        return ResolvedAgentRuntime(runtime, DEFAULT_DSH_COMMAND, runtime_source, SOURCE_DEFAULT)
    if pi_command:
        return ResolvedAgentRuntime(runtime, tuple(pi_command), runtime_source, SOURCE_PI_COMMAND)
    if active is not None and active.runtime == PI and active.command:
        return ResolvedAgentRuntime(runtime, active.command, runtime_source, SOURCE_STATE)
    raise AgentRuntimeError(
        "Agent Runtime pi 缺少启动命令：请用 --pi-command 提供，"
        "或在运行状态里为该运行时记录命令（forgeloop runtime set pi --command ...）"
    )
