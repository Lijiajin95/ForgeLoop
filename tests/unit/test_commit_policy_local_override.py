"""本地提交策略覆盖的单元测试：键级合并、继承与生效策略来源。

与集成测试的分工：这里不读写真实文件、不依赖真实时钟，只用纯映射构造仓库默认
与本地覆盖，验证 ``merge_policy_config`` 与 ``effective_commit_policy`` 的公共
行为；文件发现、二选一优先级、真实年历/调休表与真实时钟在
``tests/integration/test_commit_policy_local_override.py`` 验证。

关键不变量：
- 本地覆盖只覆盖显式声明的允许键，其余继承仓库默认；
- 未声明授权项时，09:00（含）-09:55（不含）授权窄口与 10:00 硬上限语义不变；
- 同一时刻在“启用时间窗”的 Mac 与“全时间段允许”的 Debian 上得出不同结果。
"""

import copy
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from forgeloop.domain.commit_policy import (
    AUTHORIZATION_DEADLINE,
    LOCAL_OVERRIDE_KEYS,
    BlockedWindow,
    CommitDecision,
    CommitPolicy,
    CommitPolicySource,
    check_commit_time,
    effective_commit_policy,
    load_authorized_batches,
    merge_policy_config,
)

SHANGHAI = ZoneInfo("Asia/Shanghai")
WINDOWS = (BlockedWindow(time(9, 0), time(12, 0)), BlockedWindow(time(13, 30), time(18, 0)))
GRACE = BlockedWindow(time(9, 0), time(9, 55))
AUTHORIZED_DATES = frozenset({date(2026, 10, 13)})


def repository_default() -> dict[str, Any]:
    """随仓库分发的默认策略形态（与 config/commit-policy.toml 同构）。"""

    return {
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


def calendars() -> dict[int, dict[str, Any]]:
    return {
        2026: {
            "year": 2026,
            "holidays": [
                "2026-10-01",
                "2026-10-02",
                "2026-10-03",
                "2026-10-04",
                "2026-10-05",
                "2026-10-06",
                "2026-10-07",
            ],
            "extra_workdays": ["2026-10-10"],
        }
    }


def on(day: int, hour: int, minute: int = 0) -> datetime:
    """2026-10-`day` 的 Asia/Shanghai 时刻。"""

    return datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI)


def effective(override: dict[str, Any] | None) -> CommitPolicy:
    return effective_commit_policy(repository_default(), override, calendars())


class TestMergePolicyConfig:
    def test_none_override_returns_an_equal_copy_of_default(self) -> None:
        default = repository_default()
        merged = merge_policy_config(default, None)
        assert merged == default
        assert merged is not default

    def test_empty_override_inherits_every_default_key(self) -> None:
        assert merge_policy_config(repository_default(), {}) == repository_default()

    def test_declared_key_wins_and_others_inherit(self) -> None:
        merged = merge_policy_config(repository_default(), {"machine_label": "mac-laptop"})
        assert merged["machine_label"] == "mac-laptop"
        assert merged["timezone"] == "Asia/Shanghai"
        assert merged["blocked_windows"] == repository_default()["blocked_windows"]
        assert merged["authorized_window"] == {"start": "09:00", "end": "09:55"}
        assert merged["authorized_batches"] == repository_default()["authorized_batches"]

    def test_list_value_replaces_whole_default(self) -> None:
        replacement = [{"start": "22:00", "end": "23:00"}]
        merged = merge_policy_config(repository_default(), {"blocked_windows": replacement})
        assert merged["blocked_windows"] == replacement
        # 其余键不受影响，尤其是授权登记。
        assert merged["authorized_batches"] == repository_default()["authorized_batches"]

    def test_unknown_key_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="may not declare"):
            merge_policy_config(repository_default(), {"not_a_policy_key": True})

    @pytest.mark.parametrize(
        "key",
        ["authorized_window", "authorized_batches", "calendar_directory", "timezone"],
    )
    def test_keys_outside_the_narrow_gate_are_rejected(self, key: str) -> None:
        # 本地覆盖不能改动授权窗口、授权登记、年历来源或统一时区。
        with pytest.raises(ValueError, match="may not declare"):
            merge_policy_config(repository_default(), {key: {}})
        assert key not in LOCAL_OVERRIDE_KEYS

    def test_merge_does_not_mutate_its_inputs(self) -> None:
        default = repository_default()
        override = {"machine_label": "mac-laptop", "blocked_windows": []}
        before = copy.deepcopy((default, override))
        merge_policy_config(default, override)
        assert (default, override) == before


class TestEffectivePolicySource:
    def test_without_local_override_source_is_repository_default(self) -> None:
        policy = effective(None)
        assert policy.source is CommitPolicySource.REPOSITORY_DEFAULT
        assert policy.machine_label is None

    def test_with_local_override_source_is_local_and_label_is_kept(self) -> None:
        policy = effective({"machine_label": "debian-server"})
        assert policy.source is CommitPolicySource.LOCAL_OVERRIDE
        assert policy.machine_label == "debian-server"

    def test_blank_machine_label_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="machine_label"):
            effective({"machine_label": "   "})

    def test_default_behaviour_is_unchanged_without_local_override(self) -> None:
        # 无本地覆盖时不改变既有默认行为：判定与来源都保持仓库默认。
        policy = effective(None)
        assert policy.blocked_windows == WINDOWS
        assert policy.authorized_window == GRACE
        assert policy.authorized_dates == AUTHORIZED_DATES
        assert check_commit_time(on(12, 10, 0), policy) == CommitDecision(
            False, "workday_work_hours"
        )
        assert check_commit_time(on(12, 12, 30), policy).reason == "outside_work_hours"
        assert check_commit_time(on(13, 9, 30), policy).reason == "authorized_grace_window"
        assert check_commit_time(on(12, 9, 30), policy).reason == "workday_work_hours"


class TestMachineDivergence:
    def test_same_instant_diverges_between_mac_and_debian(self) -> None:
        windows = repository_default()["blocked_windows"]
        mac = effective({"machine_label": "mac-laptop", "blocked_windows": windows})
        debian = effective({"machine_label": "debian-server", "enforce_work_hours": False})
        instant = on(12, 10, 0)  # 2026-10-12 周一 10:00，工作日禁止窗口内。

        assert check_commit_time(instant, mac) == CommitDecision(
            False, "workday_work_hours", None, CommitPolicySource.LOCAL_OVERRIDE, "mac-laptop"
        )
        assert check_commit_time(instant, debian) == CommitDecision(
            True,
            "work_hours_not_enforced",
            None,
            CommitPolicySource.LOCAL_OVERRIDE,
            "debian-server",
        )

    def test_debian_allows_every_probed_time(self) -> None:
        debian = effective({"enforce_work_hours": False})
        for hour, minute in ((9, 0), (10, 0), (13, 30), (17, 59), (23, 0), (0, 0)):
            assert check_commit_time(on(12, hour, minute), debian).reason == (
                "work_hours_not_enforced"
            )

    def test_empty_local_windows_without_enforce_switch_allow_all_times(self) -> None:
        # 未显式声明 enforce_work_hours 时，空时间窗列表即“全时间段允许”。
        policy = effective({"blocked_windows": []})
        assert policy.blocked_windows == ()
        assert policy.enforce_work_hours is False
        assert check_commit_time(on(12, 10, 0), policy).reason == "work_hours_not_enforced"

    def test_local_windows_without_enforce_switch_keep_blocking(self) -> None:
        # 显式声明时间窗但未声明开关：非空列表意味着继续启用时间窗。
        policy = effective({"blocked_windows": repository_default()["blocked_windows"]})
        assert policy.enforce_work_hours is True
        assert check_commit_time(on(12, 10, 0), policy).reason == "workday_work_hours"


class TestAuthorizationPreservedByLocalOverride:
    def test_untouched_authorization_keys_inherit_default(self) -> None:
        policy = effective({"machine_label": "mac-laptop"})
        assert policy.authorized_window == GRACE
        assert policy.authorized_dates == AUTHORIZED_DATES

    def test_grace_window_semantics_unchanged_after_local_override(self) -> None:
        policy = effective({"machine_label": "mac-laptop"})
        assert check_commit_time(on(13, 9, 0), policy).reason == "authorized_grace_window"
        assert check_commit_time(on(13, 9, 54), policy).reason == "authorized_grace_window"
        # 09:55（不含）是硬边界：到点即拒绝。
        assert check_commit_time(on(13, 9, 55), policy).reason == "authorized_window_elapsed"
        assert check_commit_time(on(13, 10, 0), policy).reason == "authorized_window_elapsed"
        assert check_commit_time(on(13, 14, 0), policy).reason == "authorized_window_elapsed"
        # 未登记日期即使落在窄口内也按工作时间拒绝。
        assert check_commit_time(on(12, 9, 30), policy).reason == "workday_work_hours"

    def test_hard_deadline_still_bounds_the_authorized_window(self) -> None:
        policy = effective({"machine_label": "mac-laptop"})
        assert policy.authorized_window.end <= AUTHORIZATION_DEADLINE

    def test_disabling_grace_keeps_the_window_bounds(self) -> None:
        # apply_authorized_window 是允许的本地键，但它只能停用、不能移动或加宽窗口。
        policy = effective({"apply_authorized_window": False})
        assert policy.authorized_window == GRACE
        assert policy.apply_authorized_window is False
        assert check_commit_time(on(13, 9, 30), policy).reason == "workday_work_hours"

    def test_local_override_cannot_declare_authorization_entries(self) -> None:
        for key in ("authorized_window", "authorized_batches"):
            with pytest.raises(ValueError, match="may not declare"):
                effective({key: {}})


class TestAuthorizedBatchLoading:
    def test_every_batch_must_be_traceable(self) -> None:
        with pytest.raises(ValueError, match="authorization_source"):
            load_authorized_batches(
                {"authorized_batches": [{"date": "2026-10-13", "authorization_source": "  "}]}
            )

    def test_duplicate_dates_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="unique"):
            load_authorized_batches(
                {
                    "authorized_batches": [
                        {"date": "2026-10-13", "authorization_source": "S1"},
                        {"date": "2026-10-13", "authorization_source": "S2"},
                    ]
                }
            )

    def test_missing_registry_yields_empty_set(self) -> None:
        assert load_authorized_batches({}) == frozenset()
