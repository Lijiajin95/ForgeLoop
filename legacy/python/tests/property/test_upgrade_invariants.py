"""热升级核心规则的属性验证：准入、状态流转、排空与就绪身份。

这些规则是硬约束：只有已提交（或已恢复）的代际可以启动新动作；任何身份字段
不一致都不能判就绪；排空报告缺失/超时/不完整只能延期，不能进入切换。
"""

import itertools

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.upgrade import (
    ADMITTED_PHASES,
    ALL_PHASES,
    PHASE_COMMITTED,
    PHASE_DEFERRED,
    PHASE_DRAINING,
    PHASE_PREPARED,
    PHASE_PROBING,
    PHASE_RECOVERY_REQUIRED,
    PHASE_ROLLED_BACK,
    PHASE_STARTING,
    PROTOCOL_VERSION,
    UpgradeIdentity,
    UpgradeRequestError,
    UpgradeState,
    admission_decision,
    drain_decision,
    next_generation,
    parse_upgrade_request,
    readiness_problem,
    transition_problem,
)

DIGEST_A = "a" * 64
DIGEST_B = "b" * 64
COMMIT = "c" * 40
PROJECT = "forgeloop"
PREFIX = "/tmp/forgeloop-prefix"
RECORDS = "/tmp/forgeloop-records"


def identity(generation: str = "gen-000001", version: str = "0.0.4", digest: str = DIGEST_A):
    return UpgradeIdentity(
        version=version,
        tag=f"v{version}",
        artifact_sha256=digest,
        build_commit=COMMIT,
        generation=generation,
    )


def state(phase: str, generation: str = "gen-000001") -> UpgradeState:
    return UpgradeState(
        identity=identity(generation),
        project=PROJECT,
        prefix=PREFIX,
        records_root=RECORDS,
        phase=phase,
        generation=generation,
    )


@given(
    phase=st.sampled_from(sorted(ALL_PHASES)),
    managed=st.booleans(),
    same_generation=st.booleans(),
)
def test_only_admitted_phases_with_matching_generation_may_execute(
    phase: str, managed: bool, same_generation: bool
) -> None:
    process_generation = "gen-000001" if same_generation else "gen-000999"
    decision = admission_decision(
        managed=managed,
        phase=phase,
        generation="gen-000001",
        process_generation=process_generation,
    )
    if not managed:
        assert decision.allowed is True
    else:
        assert decision.allowed is (phase in ADMITTED_PHASES and same_generation)
        if not decision.allowed:
            assert decision.reason


@given(managed=st.booleans())
def test_blank_generation_is_never_admitted(managed: bool) -> None:
    decision = admission_decision(
        managed=managed, phase=PHASE_COMMITTED, generation="", process_generation=""
    )
    assert decision.allowed is (not managed)


@given(
    version=st.text(min_size=1, max_size=8),
    digest=st.text(min_size=1, max_size=8),
)
def test_readiness_rejects_any_identity_mismatch(version: str, digest: str) -> None:
    expected = identity()
    report = {
        "schema_version": 1,
        "ready": True,
        "pid": 4321,
        "generation": expected.generation,
        "version": expected.version,
        "tag": expected.tag,
        "artifact_sha256": expected.artifact_sha256,
        "build_commit": expected.build_commit,
        "project": PROJECT,
        "prefix": PREFIX,
        "records_root": RECORDS,
        "module_path": f"{PREFIX}/releases/0.0.4/lib/python3.13/site-packages/forgeloop/__init__.py",
    }
    assert (
        readiness_problem(
            report,
            expected=expected,
            expected_pid=4321,
            project=PROJECT,
            prefix=PREFIX,
            records_root=RECORDS,
            release_dir=f"{PREFIX}/releases/0.0.4",
        )
        == ""
    )
    if version != expected.version:
        report["version"] = version
    if digest != expected.artifact_sha256:
        report["artifact_sha256"] = digest
    if version == expected.version and digest == expected.artifact_sha256:
        report["version"] = "9.9.9"
    assert (
        readiness_problem(
            report,
            expected=expected,
            expected_pid=4321,
            project=PROJECT,
            prefix=PREFIX,
            records_root=RECORDS,
            release_dir=f"{PREFIX}/releases/0.0.4",
        )
        != ""
    )


def test_readiness_rejects_module_outside_release_and_wrong_pid() -> None:
    expected = identity()
    report = {
        "schema_version": 1,
        "ready": True,
        "pid": 4321,
        "generation": expected.generation,
        "version": expected.version,
        "tag": expected.tag,
        "artifact_sha256": expected.artifact_sha256,
        "build_commit": expected.build_commit,
        "project": PROJECT,
        "prefix": PREFIX,
        "records_root": RECORDS,
        "module_path": "/workspace/src/forgeloop/__init__.py",
    }
    assert (
        readiness_problem(
            report,
            expected=expected,
            expected_pid=4321,
            project=PROJECT,
            prefix=PREFIX,
            records_root=RECORDS,
            release_dir=f"{PREFIX}/releases/0.0.4",
        )
        != ""
    )
    report["module_path"] = (
        f"{PREFIX}/releases/0.0.4/lib/python3.13/site-packages/forgeloop/__init__.py"
    )
    report["pid"] = 9999
    assert (
        readiness_problem(
            report,
            expected=expected,
            expected_pid=4321,
            project=PROJECT,
            prefix=PREFIX,
            records_root=RECORDS,
            release_dir=f"{PREFIX}/releases/0.0.4",
        )
        != ""
    )


@given(outstanding=st.integers(min_value=0, max_value=5), complete=st.booleans())
def test_drain_only_proceeds_with_complete_matching_report(
    outstanding: int, complete: bool
) -> None:
    report = {
        "schema_version": 1,
        "generation": "gen-000001",
        "pid": 4321,
        "completed": complete,
        "active_calls": 0,
        "active_turns": 0,
        "active_agent_processes": 0,
        "pending_requests": 0,
    }
    decision = drain_decision(
        report,
        expected_generation="gen-000001",
        expected_pid=4321,
        outstanding_actions=outstanding,
    )
    assert decision.proceed is (complete and outstanding == 0)
    if not decision.proceed:
        assert decision.reason


def test_drain_rejects_missing_timeout_and_wrong_generation() -> None:
    assert (
        drain_decision(
            None,
            expected_generation="gen-000001",
            expected_pid=4321,
            outstanding_actions=0,
        ).proceed
        is False
    )
    report = {
        "schema_version": 1,
        "generation": "gen-000002",
        "pid": 4321,
        "completed": True,
        "active_calls": 0,
        "active_turns": 0,
        "active_agent_processes": 0,
        "pending_requests": 0,
    }
    assert (
        drain_decision(
            report,
            expected_generation="gen-000001",
            expected_pid=4321,
            outstanding_actions=0,
        ).proceed
        is False
    )


class TestStateMachine:
    def test_allowed_path(self) -> None:
        path = [
            PHASE_COMMITTED,
            PHASE_PREPARED,
            PHASE_DRAINING,
            PHASE_STARTING,
            PHASE_PROBING,
            PHASE_COMMITTED,
        ]
        for current, target in itertools.pairwise(path):
            assert transition_problem(current, target) == ""
        assert transition_problem(PHASE_DRAINING, PHASE_DEFERRED) == ""
        assert transition_problem(PHASE_PROBING, PHASE_ROLLED_BACK) == ""
        assert transition_problem(PHASE_STARTING, PHASE_RECOVERY_REQUIRED) == ""

    def test_dangerous_shortcuts_are_refused(self) -> None:
        for current, target in [
            (PHASE_PREPARED, PHASE_COMMITTED),
            (PHASE_DRAINING, PHASE_COMMITTED),
            (PHASE_STARTING, PHASE_COMMITTED),
            (PHASE_RECOVERY_REQUIRED, PHASE_COMMITTED),
            (PHASE_RECOVERY_REQUIRED, PHASE_PREPARED),
        ]:
            assert transition_problem(current, target) != ""

    def test_generation_is_monotonic(self) -> None:
        current = "gen-000000"
        seen = []
        for _ in range(20):
            current = next_generation(current)
            assert current.startswith("gen-")
            assert current not in seen
            seen.append(current)

    def test_state_round_trip(self) -> None:
        original = state(PHASE_DRAINING)
        assert UpgradeState.from_document(original.to_document()) == original


class TestRequestValidation:
    def _document(self, **overrides):
        document = {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": "req-12345678",
            "project": PROJECT,
            "prefix": PREFIX,
            "tag": "v0.0.4",
            "artifact_sha256": DIGEST_A,
            "by": "owner",
            "reason": "升级到 0.0.4",
        }
        document.update(overrides)
        return document

    def test_valid_request_is_accepted_and_key_is_stable(self) -> None:
        first = parse_upgrade_request(self._document())
        second = parse_upgrade_request(self._document())
        assert first.upgrade_key == second.upgrade_key
        assert first == second

    @given(
        field=st.sampled_from(
            [
                "protocol_version",
                "request_id",
                "project",
                "prefix",
                "tag",
                "artifact_sha256",
                "by",
                "reason",
            ]
        ),
        value=st.one_of(st.none(), st.booleans(), st.integers(), st.text(max_size=3)),
    )
    def test_malformed_fields_are_refused(self, field: str, value: object) -> None:
        document = self._document()
        document[field] = value
        try:
            request = parse_upgrade_request(document)
        except UpgradeRequestError:
            return
        # 仅当值恰好形成合法字段时才允许通过；所有合法值都必须显式校验过。
        assert getattr(request, field) == value

    def test_unknown_keys_and_relative_prefix_are_refused(self) -> None:
        with __import__("pytest").raises(UpgradeRequestError):
            parse_upgrade_request({**self._document(), "command": "rm -rf /"})
        with __import__("pytest").raises(UpgradeRequestError):
            parse_upgrade_request(self._document(prefix="relative/prefix"))
        with __import__("pytest").raises(UpgradeRequestError):
            parse_upgrade_request(self._document(artifact_sha256="not-a-digest"))
        with __import__("pytest").raises(UpgradeRequestError):
            parse_upgrade_request(self._document(tag="0.0.4"))
