"""面板会话设置（``[panel]``）的解析与校验。

        extbf{为什么单独成文件}：``resolve_panel_settings`` 是页面会话面板的执行护栏（并发、单轮超时、
常驻进程数、工具审批策略），此前只有端到端用例间接跑过默认值，缺省与非法值两侧都没有行为
测试；2026-10-20 的变异运行在该函数留下 70 个未杀死变异体，正是这个缺口。这里按「默认值、
逐字段边界、未知键、类型」四类把规则钉成机器判定，错误消息按运维能照着改的口径逐字断言。
"""

from __future__ import annotations

import re

import pytest

from forgeloop.domain.service import (
    DEFAULT_MAX_LIVE_SESSIONS,
    DEFAULT_PANEL_CONCURRENCY,
    DEFAULT_SESSION_IDLE_SECONDS,
    DEFAULT_TOOL_APPROVAL,
    DEFAULT_TURN_TIMEOUT_SECONDS,
    MAX_LIVE_SESSIONS,
    MAX_PANEL_CONCURRENCY,
    PanelSettings,
    ServiceConfigError,
    resolve_panel_settings,
    resolve_service_settings,
)

DEFAULTS = PanelSettings(
    concurrency=DEFAULT_PANEL_CONCURRENCY,
    turn_timeout_seconds=DEFAULT_TURN_TIMEOUT_SECONDS,
    session_idle_seconds=DEFAULT_SESSION_IDLE_SECONDS,
    max_live_sessions=DEFAULT_MAX_LIVE_SESSIONS,
    tool_approval=DEFAULT_TOOL_APPROVAL,
)


def test_absent_panel_table_uses_builtin_defaults() -> None:
    settings = resolve_panel_settings(None)
    assert settings == DEFAULTS
    assert (settings.concurrency, settings.turn_timeout_seconds) == (2, 900)
    assert (settings.session_idle_seconds, settings.max_live_sessions) == (900, 4)
    assert settings.tool_approval == "write"


def test_empty_panel_table_uses_builtin_defaults() -> None:
    assert resolve_panel_settings({}) == DEFAULTS


def test_panel_must_be_a_table() -> None:
    for value in ([], "panel", 1, True):
        with pytest.raises(ServiceConfigError, match=re.escape("panel 必须是表")):
            resolve_panel_settings(value)


def test_unknown_panel_key_is_refused() -> None:
    with pytest.raises(ServiceConfigError, match=re.escape("panel 含未知配置项: timeout")):
        resolve_panel_settings({"timeout": 1})


def test_panel_keys_are_lowercase() -> None:
    # 键名大小写写错按未知键失败，而不是静默回落默认值。
    with pytest.raises(ServiceConfigError, match=re.escape("panel 含未知配置项: CONCURRENCY")):
        resolve_panel_settings({"CONCURRENCY": 3})


@pytest.mark.parametrize("value", [1, 2, 3, MAX_PANEL_CONCURRENCY])
def test_concurrency_accepts_the_allowed_range(value: int) -> None:
    assert resolve_panel_settings({"concurrency": value}).concurrency == value


@pytest.mark.parametrize("value", [0, MAX_PANEL_CONCURRENCY + 1, 99])
def test_concurrency_outside_the_range_is_refused(value: int) -> None:
    with pytest.raises(
        ServiceConfigError,
        match=re.escape(
            f"panel.concurrency 必须在 1..{MAX_PANEL_CONCURRENCY} 范围内，实际 {value}"
        ),
    ):
        resolve_panel_settings({"concurrency": value})


def test_concurrency_must_be_an_integer() -> None:
    for value in ("2", 2.0, None, True):
        with pytest.raises(ServiceConfigError, match=re.escape("panel.concurrency 必须是整数")):
            resolve_panel_settings({"concurrency": value})


def test_turn_timeout_accepts_positive_values() -> None:
    assert resolve_panel_settings({"turn_timeout_seconds": 1}).turn_timeout_seconds == 1
    assert resolve_panel_settings({"turn_timeout_seconds": 1800}).turn_timeout_seconds == 1800


@pytest.mark.parametrize("value", [0, -1])
def test_turn_timeout_must_be_positive(value: int) -> None:
    with pytest.raises(
        ServiceConfigError,
        match=re.escape(f"panel.turn_timeout_seconds 必须在 >= 1 范围内，实际 {value}"),
    ):
        resolve_panel_settings({"turn_timeout_seconds": value})


def test_turn_timeout_must_be_an_integer() -> None:
    with pytest.raises(
        ServiceConfigError, match=re.escape("panel.turn_timeout_seconds 必须是整数")
    ):
        resolve_panel_settings({"turn_timeout_seconds": "900"})


def test_session_idle_accepts_positive_values() -> None:
    assert resolve_panel_settings({"session_idle_seconds": 1}).session_idle_seconds == 1
    assert resolve_panel_settings({"session_idle_seconds": 60}).session_idle_seconds == 60


@pytest.mark.parametrize("value", [0, -5])
def test_session_idle_must_be_positive(value: int) -> None:
    with pytest.raises(
        ServiceConfigError,
        match=re.escape(f"panel.session_idle_seconds 必须在 >= 1 范围内，实际 {value}"),
    ):
        resolve_panel_settings({"session_idle_seconds": value})


def test_session_idle_must_be_an_integer() -> None:
    with pytest.raises(
        ServiceConfigError, match=re.escape("panel.session_idle_seconds 必须是整数")
    ):
        resolve_panel_settings({"session_idle_seconds": 1.5})


@pytest.mark.parametrize("value", [1, 4, MAX_LIVE_SESSIONS])
def test_max_live_sessions_accepts_the_allowed_range(value: int) -> None:
    assert resolve_panel_settings({"max_live_sessions": value}).max_live_sessions == value


@pytest.mark.parametrize("value", [0, MAX_LIVE_SESSIONS + 1])
def test_max_live_sessions_outside_the_range_is_refused(value: int) -> None:
    with pytest.raises(
        ServiceConfigError,
        match=re.escape(
            f"panel.max_live_sessions 必须在 1..{MAX_LIVE_SESSIONS} 范围内，实际 {value}"
        ),
    ):
        resolve_panel_settings({"max_live_sessions": value})


def test_max_live_sessions_must_be_an_integer() -> None:
    with pytest.raises(ServiceConfigError, match=re.escape("panel.max_live_sessions 必须是整数")):
        resolve_panel_settings({"max_live_sessions": "4"})


@pytest.mark.parametrize("policy", ["off", "write", "all"])
def test_tool_approval_accepts_the_documented_policies(policy: str) -> None:
    assert resolve_panel_settings({"tool_approval": policy}).tool_approval == policy


def test_tool_approval_must_be_one_of_the_policies() -> None:
    with pytest.raises(
        ServiceConfigError,
        match=re.escape("panel.tool_approval 必须是 off、write、all 之一，实际 'none'"),
    ):
        resolve_panel_settings({"tool_approval": "none"})


def test_tool_approval_must_be_text() -> None:
    # 逐字断言：字段名写进消息，运维才能照着改；名字被改坏也算契约破坏。
    with pytest.raises(
        ServiceConfigError, match="^" + re.escape("panel.tool_approval 必须是非空字符串") + "$"
    ):
        resolve_panel_settings({"tool_approval": 1})


def test_absent_fields_fall_back_individually() -> None:
    settings = resolve_panel_settings({"concurrency": 3})
    assert settings.concurrency == 3
    assert settings.turn_timeout_seconds == DEFAULT_TURN_TIMEOUT_SECONDS
    assert settings.session_idle_seconds == DEFAULT_SESSION_IDLE_SECONDS
    assert settings.max_live_sessions == DEFAULT_MAX_LIVE_SESSIONS
    assert settings.tool_approval == DEFAULT_TOOL_APPROVAL


def test_resolve_service_settings_carries_the_panel_table() -> None:
    settings = resolve_service_settings(
        {
            "schema_version": 1,
            "panel": {"concurrency": 3, "tool_approval": "all", "max_live_sessions": 2},
        }
    )
    assert settings.panel == PanelSettings(
        concurrency=3,
        turn_timeout_seconds=DEFAULT_TURN_TIMEOUT_SECONDS,
        session_idle_seconds=DEFAULT_SESSION_IDLE_SECONDS,
        max_live_sessions=2,
        tool_approval="all",
    )


def test_resolve_service_settings_uses_panel_defaults_when_absent() -> None:
    assert resolve_service_settings({"schema_version": 1}).panel == DEFAULTS


def test_resolve_service_settings_propagates_panel_errors() -> None:
    with pytest.raises(ServiceConfigError, match=re.escape("panel.concurrency 必须在 1..8 范围内")):
        resolve_service_settings({"schema_version": 1, "panel": {"concurrency": 0}})
