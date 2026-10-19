"""Agent Runtime 领域规则：运行时名称、命令解析与选择优先级（纯规则）。

“热切换”的可判定语义：每次动作启动前重新解析；进程环境覆盖 > 运行状态 > 任务配置 >
内建默认，任一来源缺失或不合法都 fail-closed，不静默换一个执行器或命令。
"""

import json
from datetime import UTC, datetime

import pytest

from forgeloop.domain.agent_runtime import (
    DSH,
    PI,
    RUNTIMES,
    AgentRuntimeError,
    AgentRuntimeState,
    default_command,
    parse_command,
    parse_runtime,
    resolve_agent_runtime,
    switch_command,
)


def state(runtime: str, command: tuple[str, ...] = ()) -> AgentRuntimeState:
    return AgentRuntimeState(
        runtime=runtime,
        command=command,
        updated_at=datetime(2026, 10, 19, tzinfo=UTC),
        updated_by="owner",
        reason="测试",
    )


class TestParseRuntime:
    def test_known_runtimes_are_accepted(self) -> None:
        assert parse_runtime("pi") == PI
        assert parse_runtime("dsh") == DSH

    def test_surrounding_space_is_tolerated(self) -> None:
        assert parse_runtime(" dsh ") == DSH

    def test_unknown_runtime_is_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError, match="未知 Agent Runtime"):
            parse_runtime("codex")

    def test_blank_runtime_is_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError, match="未知 Agent Runtime"):
            parse_runtime("   ")

    def test_runtime_registry_is_exactly_two(self) -> None:
        assert RUNTIMES == (PI, DSH)


class TestParseCommand:
    def test_json_array_text_is_parsed(self) -> None:
        assert parse_command('["pi", "--mode", "rpc"]') == ("pi", "--mode", "rpc")

    def test_sequence_is_accepted(self) -> None:
        assert parse_command(["dsh", "--profile", "headless"]) == (
            "dsh",
            "--profile",
            "headless",
        )

    def test_empty_command_is_allowed_for_optional_command(self) -> None:
        assert parse_command("") == ()
        assert parse_command([]) == ()

    def test_non_empty_command_rejects_blank_parts(self) -> None:
        with pytest.raises(AgentRuntimeError, match="非空字符串数组"):
            parse_command(["dsh", ""])

    def test_invalid_json_is_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError, match="JSON"):
            parse_command("not-json")

    def test_non_string_parts_are_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError, match="非空字符串数组"):
            parse_command(json.dumps(["dsh", 3]))

    def test_json_string_payload_is_rejected_not_iterated(self) -> None:
        # `"dsh"` 解出来是字符串：绝不能按字符拆成 ("d", "s", "h")。
        with pytest.raises(AgentRuntimeError, match="非空字符串数组"):
            parse_command(json.dumps("dsh"))

    def test_non_sequence_value_is_rejected_with_reason(self) -> None:
        with pytest.raises(AgentRuntimeError, match="必须是非空字符串数组"):
            parse_command(42)


class TestSwitchCommand:
    def test_dsh_without_command_uses_documented_default(self) -> None:
        assert switch_command(DSH, ()) == ("dsh", "--profile", "headless", "--json")

    def test_explicit_command_wins(self) -> None:
        assert switch_command(DSH, ("/opt/dsh",)) == ("/opt/dsh",)

    def test_pi_without_command_stays_empty(self) -> None:
        # PI 没有内建默认：缺命令时由任务配置或 --pi-command 提供，不静默猜。
        assert switch_command(PI, ()) == ()

    def test_json_string_command_is_parsed_as_a_command(self) -> None:
        # 字符串输入按 JSON 解析，而不是按字符拆成 ("[", '"', "/", ...)。
        assert switch_command(DSH, '["/opt/dsh", "--json"]') == ("/opt/dsh", "--json")

    def test_unknown_runtime_is_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError):
            switch_command("other", ())

    def test_default_command_is_documented_for_dsh_only(self) -> None:
        assert default_command(DSH) == ("dsh", "--profile", "headless", "--json")
        assert default_command(PI) == ()


class TestResolve:
    def test_no_state_defaults_to_pi_with_task_command(self) -> None:
        resolved = resolve_agent_runtime(active=None, pi_command=("pi", "--mode", "rpc"))
        assert resolved.runtime == PI
        assert resolved.command == ("pi", "--mode", "rpc")
        assert resolved.runtime_source == "default"
        assert resolved.command_source == "pi-command"

    def test_pi_without_any_command_fails_closed(self) -> None:
        with pytest.raises(AgentRuntimeError, match="缺少启动命令"):
            resolve_agent_runtime(active=None)

    def test_state_runtime_dsh_selects_dsh(self) -> None:
        resolved = resolve_agent_runtime(
            active=state(DSH, ("dsh", "--profile", "headless", "--json")),
            pi_command=("pi", "--mode", "rpc"),
        )
        assert resolved.runtime == DSH
        assert resolved.command == ("dsh", "--profile", "headless", "--json")
        assert resolved.runtime_source == "state"
        assert resolved.command_source == "state"

    def test_pi_task_command_wins_over_state_command_for_pi(self) -> None:
        # PI 任务配置快照优先：切回 PI 不应悄悄改用运行状态里的另一条命令，
        # 该状态命令用于没有任务配置快照的规划阶段。
        resolved = resolve_agent_runtime(
            active=state(PI, ("pi", "--from-state")),
            pi_command=("pi", "--from-task"),
        )
        assert resolved.command == ("pi", "--from-task")
        assert resolved.command_source == "pi-command"

    def test_state_command_fills_missing_pi_task_command(self) -> None:
        resolved = resolve_agent_runtime(active=state(PI, ("pi", "--from-state")))
        assert resolved.runtime == PI
        assert resolved.runtime_source == "state"
        assert resolved.command == ("pi", "--from-state")
        assert resolved.command_source == "state"

    def test_environment_override_wins_over_state(self) -> None:
        resolved = resolve_agent_runtime(
            active=state(PI, ("pi", "--from-state")),
            runtime_override="dsh",
        )
        assert resolved.runtime == DSH
        assert resolved.runtime_source == "environment"
        assert resolved.command == ("dsh", "--profile", "headless", "--json")
        assert resolved.command_source == "default"

    def test_dsh_command_option_wins_over_state(self) -> None:
        resolved = resolve_agent_runtime(
            active=state(DSH, ("dsh", "--from-state")),
            runtime_override="dsh",
            dsh_command=("dsh", "--from-option"),
        )
        assert resolved.runtime == DSH
        assert resolved.runtime_source == "environment"
        assert resolved.command == ("dsh", "--from-option")
        assert resolved.command_source == "dsh-command"

    def test_environment_override_to_dsh_ignores_pi_task_command(self) -> None:
        # PI 任务快照里的 pi_command 不能当成 DSH 命令使用。
        resolved = resolve_agent_runtime(
            active=state(DSH),
            runtime_override="dsh",
            pi_command=("pi", "--from-task"),
        )
        assert resolved.command == ("dsh", "--profile", "headless", "--json")

    def test_environment_override_unknown_runtime_is_rejected(self) -> None:
        with pytest.raises(AgentRuntimeError):
            resolve_agent_runtime(active=None, runtime_override="codex")
