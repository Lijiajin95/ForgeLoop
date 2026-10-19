"""``forgeloop runtime`` 命令组：查看与热切换 Agent Runtime。

职责边界：

- 只做运行状态的**读写入口**与稳定输出，不在这里实现选择规则：切换校验来自
  ``domain.agent_runtime``，当前状态与切换审计落在 ``records.agent_runtimes``。
- 热切换语义：``runtime set`` 写权威记录后，**下一次动作启动前**的解析就会用新
  运行时；正在跑的会话不被打断（避免半途换执行器）。不需要重启任何常驻进程，
  也不改写任务方案、批准或任务配置快照。
- ``--json`` 输出是稳定契约（``runtime_document``），与 CLI 契约快照同源。
"""

import argparse
import json
import sys
from pathlib import Path

from forgeloop.cli.common import records_root
from forgeloop.domain.agent_runtime import (
    RUNTIMES,
    AgentRuntimeError,
    ResolvedAgentRuntime,
    parse_command,
    resolve_agent_runtime,
)
from forgeloop.graph.agent_execution import environment_runtime_override
from forgeloop.records.agent_runtimes import AgentRuntimeStore

DEFAULT_HISTORY_LIMIT = 20


def _active_document(store: AgentRuntimeStore) -> dict[str, object] | None:
    current = store.current()
    if current is None:
        return None
    return {
        "runtime": current.runtime,
        "command": list(current.command),
        "updated_at": current.updated_at.isoformat() if current.updated_at else "",
        "updated_by": current.updated_by,
        "reason": current.reason,
    }


def _history_document(store: AgentRuntimeStore, limit: int) -> list[dict[str, object]]:
    return [
        {
            "switch_id": item.switch_id,
            "from_runtime": item.from_runtime,
            "to_runtime": item.to_runtime,
            "command": list(item.command),
            "switched_at": item.switched_at.isoformat(),
            "switched_by": item.switched_by,
            "reason": item.reason,
        }
        for item in store.history(limit=limit)
    ]


def _effective_document(
    store: AgentRuntimeStore,
) -> tuple[dict[str, object] | None, str]:
    """按规划阶段的解析规则给出“下一次动作会用什么”；缺命令时如实给错误。"""

    env_runtime, env_command = environment_runtime_override()
    try:
        resolved: ResolvedAgentRuntime = resolve_agent_runtime(
            active=store.current(), runtime_override=env_runtime, dsh_command=env_command
        )
    except AgentRuntimeError as error:
        return None, str(error)
    return (
        {
            "runtime": resolved.runtime,
            "command": list(resolved.command),
            "runtime_source": resolved.runtime_source,
            "command_source": resolved.command_source,
        },
        "",
    )


def runtime_document(store: AgentRuntimeStore, limit: int = DEFAULT_HISTORY_LIMIT) -> dict:
    """``runtime show --json`` 的稳定文档（当前状态、生效解析与环境覆盖、历史）。"""

    env_runtime, env_command = environment_runtime_override()
    effective, effective_error = _effective_document(store)
    return {
        "active": _active_document(store),
        "effective": effective,
        "effective_error": effective_error,
        "environment": {
            "runtime_override": env_runtime,
            "dsh_command": list(env_command),
        },
        "history": _history_document(store, limit),
    }


def _open_runtime_store(root: Path) -> AgentRuntimeStore:
    return AgentRuntimeStore(root / "records.sqlite")


def cmd_runtime_show(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_runtime_store(root)
    try:
        try:
            document = runtime_document(store, args.history)
        except AgentRuntimeError as error:
            # 进程环境覆盖非法：fail-closed 报告，不静默回落到别的运行时。
            print(f"FAIL: {error}", file=sys.stderr)
            return 1
    finally:
        store.close()
    if args.json:
        print(json.dumps(document, ensure_ascii=False, sort_keys=True))
        return 0
    active = document["active"]
    if active is None:
        print("当前 Agent Runtime: 未显式设置（默认 pi）")
        print("切换命令: forgeloop runtime set dsh --by <身份> --reason <理由>")
    else:
        assert isinstance(active, dict)
        print(f"当前 Agent Runtime: {active['runtime']}")
        active_command = " ".join(str(part) for part in active["command"])
        print(f"命令: {active_command or '（未设置，用任务配置或命令行参数）'}")
        print(f"更新: {active['updated_at']}（{active['updated_by']}：{active['reason']}）")
    effective = document["effective"]
    if effective is None:
        print(f"下一次动作: 不可解析（{document['effective_error']}）")
    else:
        assert isinstance(effective, dict)
        print(
            f"下一次动作: {effective['runtime']}"
            f"（运行时来源 {effective['runtime_source']}，命令来源 {effective['command_source']}）"
        )
        effective_command = " ".join(str(part) for part in effective["command"])
        print(f"生效命令: {effective_command}")
    environment = document["environment"]
    assert isinstance(environment, dict)
    if environment["runtime_override"] or environment["dsh_command"]:
        print(
            "进程环境覆盖: "
            f"FORGELOOP_AGENT_RUNTIME={environment['runtime_override'] or '（未设置）'}，"
            "FORGELOOP_DSH_COMMAND="
            + (" ".join(str(part) for part in environment["dsh_command"]) or "（未设置）")
        )
    return 0


def cmd_runtime_set(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_runtime_store(root)
    try:
        previous = store.current()
        try:
            state = store.set_runtime(
                args.runtime,
                command=parse_command(args.command, label="--command") if args.command else (),
                by=args.by,
                reason=args.reason,
            )
        except AgentRuntimeError as error:
            print(f"FAIL: {error}", file=sys.stderr)
            return 1
    finally:
        store.close()
    before = previous.runtime if previous is not None else "（未设置，默认 pi）"
    print(f"Agent Runtime 已切换: {before} → {state.runtime}")
    print(f"命令: {' '.join(state.command) or '（未设置，用任务配置或命令行参数）'}")
    updated_at = state.updated_at.isoformat() if state.updated_at else ""
    print(f"更新: {updated_at}（{state.updated_by}：{state.reason}）")
    print("生效范围: 下一次动作启动前解析；正在运行的会话不被打断。")
    return 0


def cmd_runtime_list(args: argparse.Namespace) -> int:
    root = records_root(args)
    store = _open_runtime_store(root)
    try:
        if args.json:
            print(
                json.dumps(
                    {"history": _history_document(store, args.limit)},
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
            return 0
        history = store.history(limit=args.limit)
    finally:
        store.close()
    if not history:
        print("没有 Agent Runtime 切换记录。")
        return 0
    for item in history:
        source = item.from_runtime or "（未设置）"
        print(f"{item.switched_at.isoformat()} {source} → {item.to_runtime}")
        print(f"  调用方: {item.switched_by}")
        print(f"  理由: {item.reason}")
        print(f"  命令: {' '.join(item.command) or '（未设置）'}")
    return 0


def add_runtime_parser(subparsers: argparse._SubParsersAction, default_records_root: str) -> None:
    """把 ``runtime`` 命令组登记到顶层子解析器上。"""

    runtime = subparsers.add_parser(
        "runtime", help="查看与热切换 Agent Runtime（PI / DSH），下次动作生效"
    )
    actions = runtime.add_subparsers(dest="runtime_action", required=True)

    show = actions.add_parser("show", help="查看当前运行时、生效解析与切换历史")
    show.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    show.add_argument("--history", type=int, default=DEFAULT_HISTORY_LIMIT, help="历史条数上限")
    show.add_argument("--records-root", default=default_records_root)
    show.set_defaults(func=cmd_runtime_show)

    switch = actions.add_parser("set", help="切换运行时（写权威记录并留审计）")
    switch.add_argument("runtime", choices=list(RUNTIMES), help="目标运行时")
    switch.add_argument(
        "--command",
        default="",
        help=(
            "该运行时的启动命令（JSON 字符串数组）；DSH 缺省用官方 headless 默认命令。"
            "DSH 命令必须包含 --json，且不要带任务参数（提示词经 stdin 传入）"
        ),
    )
    switch.add_argument("--by", required=True, help="调用方标识（如 owner）")
    switch.add_argument("--reason", required=True, help="切换理由（不能为空白）")
    switch.add_argument("--records-root", default=default_records_root)
    switch.set_defaults(func=cmd_runtime_set)

    listing = actions.add_parser("list", help="查看运行时切换审计（最近若干条）")
    listing.add_argument("--limit", type=int, default=DEFAULT_HISTORY_LIMIT)
    listing.add_argument("--json", action="store_true", help="输出稳定 JSON 文档")
    listing.add_argument("--records-root", default=default_records_root)
    listing.set_defaults(func=cmd_runtime_list)
