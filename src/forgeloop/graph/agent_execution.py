"""Agent Runtime 会话执行接缝：解析运行时、构造 PI/DSH 会话并跑完一次调用。

这是业务图与执行器之间的唯一入口（架构 §7 的“执行器命令”接缝）：

- **热切换**：``resolve_task_runtime``/``resolve_planning_runtime`` 在**每次动作
  启动前**重新读取记录层的运行状态与进程环境，因此 ``forgeloop runtime set`` 之后
  已经启动的推进进程在下一个动作就会用新运行时，不需要重启进程；正在跑的会话不被
  打断（切换只影响之后启动的动作，避免半途换执行器）。
- **进程环境覆盖**：``FORGELOOP_AGENT_RUNTIME``（``pi``/``dsh``）与
  ``FORGELOOP_DSH_COMMAND``（JSON 字符串数组）只影响当前进程，不写记录；
  非法值 fail-closed，不静默回落。
- **命令与运行时匹配**：PI 用任务配置快照里的 ``pi_command``（或命令行覆盖），
  DSH 用运行状态里的命令（或 DSH 官方默认）；把 PI 的命令当成 DSH 命令使用这种
  错配由 ``domain.agent_runtime`` 的解析规则排除。
"""

import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path

from forgeloop.adapter.agent_runtime import (
    AgentInvocationResult,
    AgentSpawnOptions,
)
from forgeloop.adapter.dsh_headless import DSHProcess
from forgeloop.adapter.pi_rpc import PIProcess
from forgeloop.domain.agent_runtime import (
    DSH,
    PI,
    AgentRuntimeError,
    AgentRuntimeState,
    ResolvedAgentRuntime,
    parse_command,
    parse_runtime,
    resolve_agent_runtime,
)
from forgeloop.records.agent_runtimes import AgentRuntimeStore

ENV_AGENT_RUNTIME = "FORGELOOP_AGENT_RUNTIME"
ENV_DSH_COMMAND = "FORGELOOP_DSH_COMMAND"


def environment_runtime_override() -> tuple[str, tuple[str, ...]]:
    """进程环境里的运行时覆盖（运行时名、DSH 命令）；非法值 fail-closed。"""

    runtime = os.environ.get(ENV_AGENT_RUNTIME, "")
    if runtime.strip():
        parse_runtime(runtime)
    raw_command = os.environ.get(ENV_DSH_COMMAND, "")
    command = parse_command(raw_command, label=ENV_DSH_COMMAND) if raw_command.strip() else ()
    return runtime, command


def active_runtime(records_root: Path) -> AgentRuntimeState | None:
    """只读当前运行状态；记录库不存在时按需建空库（查询本身的代价）。"""

    store = AgentRuntimeStore(Path(records_root) / "records.sqlite")
    try:
        return store.current()
    finally:
        store.close()


def resolve_task_runtime(
    records_root: Path, pi_command: Sequence[str] = ()
) -> ResolvedAgentRuntime:
    """单任务动作的运行时解析：任务配置（PI）优先，运行状态决定选哪个运行时。"""

    runtime_override, dsh_command = environment_runtime_override()
    return resolve_agent_runtime(
        active=active_runtime(records_root),
        runtime_override=runtime_override,
        pi_command=pi_command,
        dsh_command=dsh_command,
    )


def resolve_planning_runtime(
    records_root: Path | None,
    pi_command: Sequence[str] = (),
    dsh_command: Sequence[str] = (),
) -> ResolvedAgentRuntime:
    """规划阶段（无任务配置快照）的运行时解析：命令行参数优先于运行状态。

    ``records_root`` 为 ``None`` 表示调用方没有记录现场（单元测试直接构造
    ``PlanningContext``）：不读运行状态，只按进程环境与显式参数解析。
    """

    runtime_override, env_dsh_command = environment_runtime_override()
    return resolve_agent_runtime(
        active=active_runtime(records_root) if records_root is not None else None,
        runtime_override=runtime_override,
        pi_command=pi_command,
        dsh_command=dsh_command or env_dsh_command,
    )


def open_agent_session(
    runtime: str,
    command: Sequence[str],
    task_id: str,
    role: str,
    session_dir: Path,
    options: AgentSpawnOptions,
):
    """按运行时名字构造会话对象；两个实现提供同一 ``start``/``send_prompt``/
    ``wait_until_settled``/``close`` 接口。"""

    if runtime == PI:
        return PIProcess(command, task_id, role, session_dir, options)
    if runtime == DSH:
        return DSHProcess(command, task_id, role, session_dir, options)
    raise AgentRuntimeError(f"未知 Agent Runtime: {runtime}")


def run_agent_session(
    resolved: ResolvedAgentRuntime,
    *,
    task_id: str,
    role: str,
    session_dir: Path,
    options: AgentSpawnOptions,
    prompt: str,
    timeout_seconds: float,
) -> AgentInvocationResult:
    """启动一次 Agent 会话并等待终态；结果不明确时如实返回，不重跑。"""

    session = open_agent_session(
        resolved.runtime, resolved.command, task_id, role, session_dir, options
    )
    session.start()
    try:
        session.send_prompt(prompt)
        return session.wait_until_settled(timeout_seconds)
    finally:
        session.close()


def runtime_evidence(resolved: ResolvedAgentRuntime) -> Mapping[str, object]:
    """一次动作的运行时身份（写进报告行，供人工回查这次到底用了哪个执行器）。"""

    return {
        "agent_runtime": resolved.runtime,
        "agent_runtime_source": resolved.runtime_source,
        "agent_command_source": resolved.command_source,
        "agent_command": json.dumps(list(resolved.command), ensure_ascii=False),
    }
