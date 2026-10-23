"""依赖事实纯规则的属性测试：判定只由权威事实决定，状态词永不参与。

不变量：
- 判定优先级固定：缺少依据 → unknown，未完成动作 → running，
  有未满足前置 → waiting，前置齐备 → ready；
- ``recorded_status`` 无论取何值都不改变判定与未满足前置清单；
- ``waiting`` 必有未满足前置且无未完成动作；``unknown`` 当且仅当缺记录；
- ``running`` 必有未完成动作且依据齐全；
- 未满足前置恰好是未达终态的前置，顺序与输入一致。
"""

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.dependency_facts import (
    DependencyFacts,
    DependencyVerdict,
    PrerequisiteFact,
    TerminalState,
    assess_dependency,
)

terminal_states = st.one_of(st.none(), st.sampled_from(list(TerminalState)))


def _build(
    terminals: list[TerminalState | None],
    statuses: list[str],
    *,
    has_action: bool,
    has_missing: bool,
) -> tuple[list[PrerequisiteFact], DependencyFacts]:
    prerequisites = [
        PrerequisiteFact(
            f"t{index}",
            terminal=terminal,
            recorded_status=statuses[index],
            missing=("tasks:t0",) if (has_missing and index == 0) else (),
        )
        for index, terminal in enumerate(terminals)
    ]
    facts = assess_dependency(
        "subject",
        prerequisites,
        outstanding_action="act" if has_action else None,
    )
    return prerequisites, facts


@given(
    st.lists(terminal_states, min_size=1, max_size=6),
    st.lists(st.text(max_size=12), min_size=6, max_size=6),
    st.booleans(),
    st.booleans(),
)
def test_verdict_follows_the_declared_priority(
    terminals: list[TerminalState | None],
    statuses: list[str],
    has_action: bool,
    has_missing: bool,
) -> None:
    expected_unmet = tuple(
        f"t{index}" for index, terminal in enumerate(terminals) if terminal is None
    )
    if has_missing:
        expected = DependencyVerdict.UNKNOWN
    elif has_action:
        expected = DependencyVerdict.RUNNING
    elif expected_unmet:
        expected = DependencyVerdict.WAITING
    else:
        expected = DependencyVerdict.READY

    prerequisites, facts = _build(
        terminals, statuses, has_action=has_action, has_missing=has_missing
    )
    assert facts.verdict is expected
    assert facts.unmet_prerequisites == expected_unmet
    assert facts.has_outstanding_action is has_action
    assert facts.is_unknown is has_missing
    assert bool(facts.missing_evidence) is has_missing
    # 未满足前置恰好是未达终态的前置，顺序稳定。
    assert tuple(item.task_id for item in prerequisites if item.terminal is None) == expected_unmet


@given(
    st.lists(terminal_states, min_size=1, max_size=6),
    st.lists(st.text(max_size=12), min_size=6, max_size=6),
    st.booleans(),
    st.booleans(),
)
def test_status_never_changes_the_verdict(
    terminals: list[TerminalState | None],
    statuses: list[str],
    has_action: bool,
    has_missing: bool,
) -> None:
    _, first = _build(terminals, statuses, has_action=has_action, has_missing=has_missing)
    _, second = _build(
        terminals,
        list(reversed(statuses)),
        has_action=has_action,
        has_missing=has_missing,
    )
    assert first.verdict is second.verdict
    assert first.unmet_prerequisites == second.unmet_prerequisites
    assert first.missing_evidence == second.missing_evidence


@given(
    st.lists(terminal_states, min_size=1, max_size=6),
    st.lists(st.text(max_size=12), min_size=6, max_size=6),
    st.booleans(),
    st.booleans(),
)
def test_waiting_and_running_invariants(
    terminals: list[TerminalState | None],
    statuses: list[str],
    has_action: bool,
    has_missing: bool,
) -> None:
    _, facts = _build(terminals, statuses, has_action=has_action, has_missing=has_missing)
    if facts.is_waiting:
        assert facts.unmet_prerequisites
        assert not facts.has_outstanding_action
        assert not facts.missing_evidence
    if facts.is_running:
        assert facts.has_outstanding_action
        assert not facts.missing_evidence
    if facts.is_ready:
        assert not facts.unmet_prerequisites
        assert not facts.has_outstanding_action
        assert not facts.missing_evidence
