"""本地覆盖键级合并的属性测试：任意合法覆盖下合并都确定、幂等且不丢默认项。

不变量：
- ``merge_policy_config`` 与递归逐键合并的参考实现结果完全一致；
- 合并幂等：对同一覆盖重复合并得到相同结果；
- 结果唯一确定：只由两份输入文档决定，与覆盖键的枚举顺序无关；
- 未显式声明的顶层键一律继承仓库默认；
- 未出现在 ``LOCAL_OVERRIDE_KEYS`` 的顶层键一律拒绝；
- ``effective_commit_policy`` 对同一输入可复现，且本地覆盖不能移动授权窗口或
  授权登记，09:00（含）-09:55（不含）窄口保持不变。
"""

import copy
from collections.abc import Mapping
from datetime import date, time
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.commit_policy import (
    LOCAL_OVERRIDE_KEYS,
    BlockedWindow,
    CommitPolicySource,
    effective_commit_policy,
    merge_policy_config,
)

_json = st.recursive(
    st.none() | st.booleans() | st.integers() | st.text(max_size=8),
    lambda children: (
        st.lists(children, max_size=3) | st.dictionaries(st.text(max_size=6), children, max_size=3)
    ),
    max_leaves=8,
)

_allowed_keys = sorted(LOCAL_OVERRIDE_KEYS)
_overrides = st.dictionaries(st.sampled_from(_allowed_keys), _json, max_size=len(_allowed_keys))
_defaults = st.dictionaries(st.text(max_size=6), _json, max_size=6)
_forbidden_keys = st.sampled_from(
    ["authorized_window", "authorized_batches", "calendar_directory", "timezone", "unknown_key"]
)


def reference_merge(default: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    """逐键递归合并的参考实现：映射递归、其余整体替换。"""

    merged: dict[str, Any] = copy.deepcopy(dict(default))
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = reference_merge(current, value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


@given(_defaults, _overrides)
def test_merge_matches_recursive_reference(
    default: dict[str, Any], override: dict[str, Any]
) -> None:
    assert merge_policy_config(default, override) == reference_merge(default, override)


@given(_defaults, _overrides)
def test_merge_is_idempotent(default: dict[str, Any], override: dict[str, Any]) -> None:
    once = merge_policy_config(default, override)
    assert merge_policy_config(once, override) == once


@given(_defaults, _overrides)
def test_merge_result_is_unique_regardless_of_key_order(
    default: dict[str, Any], override: dict[str, Any]
) -> None:
    reordered = dict(reversed(list(override.items())))
    assert merge_policy_config(default, override) == merge_policy_config(default, reordered)


@given(_defaults)
def test_none_override_is_identity(default: dict[str, Any]) -> None:
    assert merge_policy_config(default, None) == default


@given(_defaults, _overrides)
def test_undeclared_top_level_keys_inherit_default(
    default: dict[str, Any], override: dict[str, Any]
) -> None:
    merged = merge_policy_config(default, override)
    for key, value in default.items():
        if key not in override:
            assert merged[key] == value


@given(_defaults, _overrides)
def test_merge_does_not_mutate_its_inputs(
    default: dict[str, Any], override: dict[str, Any]
) -> None:
    before = copy.deepcopy((default, override))
    merge_policy_config(default, override)
    assert (default, override) == before


@given(_defaults, _forbidden_keys, _json)
def test_keys_outside_the_narrow_gate_are_always_rejected(
    default: dict[str, Any], key: str, value: Any
) -> None:
    with pytest.raises(ValueError, match="may not declare"):
        merge_policy_config(default, {key: value})


_DEFAULT_CONFIG: dict[str, Any] = {
    "timezone": "Asia/Shanghai",
    "calendar_directory": "config/workday-calendars",
    "blocked_windows": [
        {"start": "09:00", "end": "12:00"},
        {"start": "13:30", "end": "18:00"},
    ],
    "authorized_window": {"start": "09:00", "end": "09:55"},
    "authorized_batches": [
        {"date": "2026-10-13", "authorization_source": "所有者授权 S1 批次"},
    ],
}
_CALENDARS: dict[int, dict[str, Any]] = {
    2026: {"year": 2026, "holidays": ["2026-10-01"], "extra_workdays": ["2026-10-10"]}
}
_LABELS = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
    min_size=1,
    max_size=10,
)
_WINDOWS = st.just([{"start": "09:00", "end": "12:00"}, {"start": "13:30", "end": "18:00"}])
_effective_overrides = st.one_of(
    st.just({}),
    st.fixed_dictionaries({"machine_label": _LABELS}),
    st.fixed_dictionaries({"enforce_work_hours": st.booleans()}),
    st.fixed_dictionaries({"apply_authorized_window": st.booleans()}),
    st.fixed_dictionaries({"blocked_windows": _WINDOWS}),
    st.fixed_dictionaries({"machine_label": _LABELS, "enforce_work_hours": st.booleans()}),
)


@given(_effective_overrides)
def test_effective_policy_is_deterministic(override: dict[str, Any]) -> None:
    first = effective_commit_policy(_DEFAULT_CONFIG, override, _CALENDARS)
    second = effective_commit_policy(_DEFAULT_CONFIG, override, _CALENDARS)
    assert first == second
    assert first.source is CommitPolicySource.LOCAL_OVERRIDE


@given(_effective_overrides)
def test_effective_policy_never_moves_authorization(override: dict[str, Any]) -> None:
    policy = effective_commit_policy(_DEFAULT_CONFIG, override, _CALENDARS)
    assert policy.authorized_window == BlockedWindow(time(9, 0), time(9, 55))
    assert policy.authorized_dates == frozenset({date(2026, 10, 13)})


def test_no_override_keeps_repository_default_source_and_authorization() -> None:
    policy = effective_commit_policy(_DEFAULT_CONFIG, None, _CALENDARS)
    assert policy.source is CommitPolicySource.REPOSITORY_DEFAULT
    assert policy.authorized_window == BlockedWindow(time(9, 0), time(9, 55))
    assert policy.authorized_dates == frozenset({date(2026, 10, 13)})
