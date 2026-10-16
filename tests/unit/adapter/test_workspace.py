"""前置候选应用的幂等与回退：基于持久记录的重复启动与失败回退。

对应需求「让下游任务的副本真正带上已完成前置的代码」中的幂等与回退部分：

- 同一需求内同一下游任务重复启动时，已记录为成功应用的前置改动被跳过，
  副本内容与首次启动一致，不重复变更、不留半成品；
- 应用任一步骤失败时工作区回退到与需求基线一致的干净副本，失败状态与原因
  被写入权威记录（``OutcomeStore``）与任务现场，不静默继续；
- 幂等判定同时读取权威记录与工作副本现场：只有记录而副本已被重新克隆/回退时
  仍会重新应用，不据陈旧记录跳过实际缺失的改动。

用例在真实 git 副本与真实 SQLite 记录库上运行：clone、apply、reset、记录读写
都是真实外部边界，不使用内存替身，避免把「传了身份」当成「代码真的到了副本」。
"""

import json
import subprocess
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Protocol

import pytest

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    applied_prerequisites,
    apply_diff_to_workspace,
    clear_applied_prerequisites,
    collect_candidate_change,
    mark_prerequisite_applied,
    prepare_workspace,
    reset_workspace,
)
from forgeloop.domain.delivery import sha256_of_text
from forgeloop.graph.requirements import (
    PREREQUISITE_RECORD_NAME,
    PrerequisiteApplyStatus,
    PrerequisiteCandidate,
    apply_prerequisite_candidates,
)
from forgeloop.records.store import RecordStore

GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}


class RecordsFactory(Protocol):
    """测试用记录库工厂：按下游任务身份创建真实 ``RecordStore`` 与记录路径。"""

    def __call__(self, task_id: str = ...) -> tuple[RecordStore, Path, str]: ...


@pytest.fixture
def records(tmp_path: Path) -> Iterator[RecordsFactory]:
    """真实记录库 + 下游任务现场路径；测试结束统一关闭连接，不泄漏 sqlite。"""

    opened: list[RecordStore] = []

    def make(task_id: str = "task-downstream-v1-alpha") -> tuple[RecordStore, Path, str]:
        records_root = tmp_path / "records"
        store = RecordStore(records_root / "records.sqlite")
        opened.append(store)
        return store, records_root / task_id / PREREQUISITE_RECORD_NAME, task_id

    yield make
    for store in opened:
        store.close()


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={**GIT_ENV, "HOME": str(path.parent)},
    )
    return result.stdout


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def make_workspace(tmp_path: Path, source: Path, name: str = "downstream") -> Path:
    workspace = tmp_path / name / "workspace"
    prepare_workspace(source, "", workspace)
    return workspace


def make_candidate(
    tmp_path: Path, source: Path, task_id: str, filename: str, content: str
) -> PrerequisiteCandidate:
    """在独立副本里造一份真实候选 diff，并返回其任务身份、校验值与现场路径。"""

    work = tmp_path / f"prereq-{task_id}"
    prepare_workspace(source, "", work)
    target = work / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    change = collect_candidate_change(work)
    diff_path = tmp_path / f"{task_id}.diff"
    diff_path.write_text(change.diff, encoding="utf-8")
    return PrerequisiteCandidate(task_id, sha256_of_text(change.diff), diff_path)


def broken_candidate(tmp_path: Path, task_id: str = "broken") -> PrerequisiteCandidate:
    """一份校验值正确但无法应用的候选 diff（上下文与副本不匹配）。"""

    broken_diff = (
        "diff --git a/base.txt b/base.txt\n"
        "--- a/base.txt\n"
        "+++ b/base.txt\n"
        "@@ -1 +1 @@\n"
        "-content-that-does-not-exist\n"
        "+broken\n"
    )
    diff_path = tmp_path / f"{task_id}.diff"
    diff_path.write_text(broken_diff, encoding="utf-8")
    return PrerequisiteCandidate(task_id, sha256_of_text(broken_diff), diff_path)


class TestWorkspaceAppliedMarker:
    """工作副本本地标记的读写：幂等判定的现场证明，回退后必须失效。"""

    def test_marker_round_trip_and_clear(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)

        assert applied_prerequisites(workspace) == frozenset()
        mark_prerequisite_applied(workspace, "alpha", "a" * 64)
        mark_prerequisite_applied(workspace, "beta", "b" * 64)
        assert applied_prerequisites(workspace) == {
            ("alpha", "a" * 64),
            ("beta", "b" * 64),
        }

        clear_applied_prerequisites(workspace)
        assert applied_prerequisites(workspace) == frozenset()

    def test_reset_workspace_discards_changes_and_untracked_files(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        baseline = git(workspace, "rev-parse", "HEAD").strip()
        (workspace / "base.txt").write_text("changed\n", encoding="utf-8")
        (workspace / "residue.txt").write_text("residue\n", encoding="utf-8")

        reset_workspace(workspace, baseline)

        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert not (workspace / "residue.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""


class TestRecordBasedIdempotence:
    """重复启动幂等：以权威记录 + 工作副本现场为判据，不重复应用、不留残留。"""

    def test_repeat_startup_skips_and_records_applied(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        store, record_path, task_id = records()

        first = apply_prerequisite_candidates(workspace, [candidate], record_path)
        recorded_first = store.outcomes.prerequisite_applications(task_id)
        second = apply_prerequisite_candidates(workspace, [candidate], record_path)
        recorded_second = store.outcomes.prerequisite_applications(task_id)

        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert recorded_first == {"alpha": (candidate.candidate_sha256, "applied", "")}
        assert recorded_second["alpha"][1] == "already_applied"
        # 副本内容与首次启动一致，且只产生一次改动，不留重复/半成品。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"
        assert git(workspace, "status", "--porcelain").count("alpha.txt") == 1

    def test_record_alone_does_not_skip_a_fresh_clone(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """只有记录、副本已被重新克隆时仍重新应用，不据陈旧记录跳过。"""

        source = make_source_repo(tmp_path)
        first_workspace = make_workspace(tmp_path, source, "downstream-first")
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        store, record_path, task_id = records()

        apply_prerequisite_candidates(first_workspace, [candidate], record_path)
        assert store.outcomes.prerequisite_applications(task_id)["alpha"][1] == "applied"

        fresh_workspace = make_workspace(tmp_path, source, "downstream-second")
        assert applied_prerequisites(fresh_workspace) == frozenset()
        report = apply_prerequisite_candidates(fresh_workspace, [candidate], record_path)

        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (fresh_workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"

    def test_explicit_outcome_store_is_used(self, tmp_path: Path, records: RecordsFactory) -> None:
        """显式注入记录库时使用同一连接写入，不额外创建记录文件。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        store, record_path, task_id = records()

        report = apply_prerequisite_candidates(
            workspace, [candidate], record_path, outcomes=store.outcomes
        )

        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (
            store.outcomes.prerequisite_applications(task_id)["alpha"][0]
            == candidate.candidate_sha256
        )

    def test_no_store_falls_back_to_workspace_marker(self, tmp_path: Path) -> None:
        """记录库不存在时退回现场标记，行为与既有流程一致且仍幂等。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        record_path = tmp_path / "task" / PREREQUISITE_RECORD_NAME

        first = apply_prerequisite_candidates(workspace, [candidate], record_path)
        second = apply_prerequisite_candidates(workspace, [candidate], record_path)

        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert not (tmp_path / "records.sqlite").exists()

    def test_downstream_edit_is_not_reapplied(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """下游改过前置文件后重入：记录确认已应用，不重复 apply、不丢下游改动。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        _store, record_path, _task_id = records()

        first = apply_prerequisite_candidates(workspace, [candidate], record_path)
        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        (workspace / "alpha.txt").write_text("alpha-content\ndownstream-change\n", encoding="utf-8")

        second = apply_prerequisite_candidates(workspace, [candidate], record_path)

        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == (
            "alpha-content\ndownstream-change\n"
        )

    def test_stale_marker_with_failed_record_reapplies(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """记录为 failed、工作区干净但有残留标记时，不得据标记跳过已回退的改动。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        store, record_path, task_id = records()
        # 模拟回退已完成（文件已消失）但本地标记未被清掉的现场：权威记录明确为 failed。
        store.outcomes.record_prerequisite_applications(
            task_id,
            [("good", candidate.candidate_sha256, "failed", "上一轮已回退到干净副本")],
        )
        mark_prerequisite_applied(workspace, "good", candidate.candidate_sha256)
        assert not (workspace / "good.txt").exists()

        report = apply_prerequisite_candidates(workspace, [candidate], record_path)

        # 记录未确认已应用，必须按现场重新应用，而不是凭残留标记报 ALREADY_APPLIED。
        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (workspace / "good.txt").read_text(encoding="utf-8") == "good\n"
        assert store.outcomes.prerequisite_applications(task_id)["good"][1] == "applied"


class TestRollbackOnFailure:
    """失败回退：回到与需求基线一致的干净副本，并把真实状态写入记录。"""

    def test_failed_apply_rolls_back_and_records_failure(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path)
        store, record_path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [good, broken], record_path)
        recorded = store.outcomes.prerequisite_applications(task_id)

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.FAILED
        assert report.applications[1].status is PrerequisiteApplyStatus.FAILED
        # 回退到干净副本：已应用与未应用的文件都不残留。
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""
        assert applied_prerequisites(workspace) == frozenset()
        # 失败状态与原因如实写入权威记录，且先前 applied 被覆盖，避免下次误跳过。
        assert recorded["good"][1] == "failed"
        assert recorded["broken"][1] == "failed"
        assert "回退到干净副本" in recorded["good"][2]
        document = json.loads(record_path.read_text(encoding="utf-8"))
        assert document["blocked_reason"]
        assert all(entry["status"] == "failed" for entry in document["applications"])

    def test_retry_after_rollback_reapplies_cleanly(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """回退后重试：先前 applied 已被覆盖为 failed，重试会真正重新应用。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path, "broken")
        store, record_path, task_id = records()

        apply_prerequisite_candidates(workspace, [good, broken], record_path)
        report = apply_prerequisite_candidates(workspace, [good], record_path)

        assert not report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (workspace / "good.txt").read_text(encoding="utf-8") == "good\n"
        assert store.outcomes.prerequisite_applications(task_id)["good"][1] == "applied"

    def test_real_conflict_rolls_back_without_residue(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        left = make_candidate(tmp_path, source, "left", "base.txt", "left-change\n")
        right = make_candidate(tmp_path, source, "right", "base.txt", "right-change\n")
        store, record_path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [left, right], record_path)

        assert report.blocked
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(workspace, "status", "--porcelain").strip() == ""
        assert store.outcomes.prerequisite_applications(task_id)["left"][1] == "failed"

    def test_rollback_marks_previous_already_applied_as_failed(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """回退丢弃了上一轮已应用的前置时，其记录必须一并改为 failed，不能声称成功。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path)
        store, record_path, task_id = records()

        first = apply_prerequisite_candidates(workspace, [good], record_path)
        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert store.outcomes.prerequisite_applications(task_id)["good"][1] == "applied"

        report = apply_prerequisite_candidates(workspace, [good, broken], record_path)
        recorded = store.outcomes.prerequisite_applications(task_id)

        assert report.blocked
        # good 本轮是 ALREADY_APPLIED，但随回退一起从工作区消失，记录不得仍称已应用。
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""
        assert recorded["good"][1] == "failed"
        assert "回退" in recorded["good"][2]
        assert recorded["broken"][1] == "failed"
        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses["good"] is PrerequisiteApplyStatus.FAILED
        assert statuses["broken"] is PrerequisiteApplyStatus.FAILED

    def test_failure_is_recorded_even_if_rollback_fails(
        self, tmp_path: Path, records: RecordsFactory, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """回退本身失败时，失败状态与原因仍先落入权威记录，不静默保留成功记录。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path)
        store, record_path, task_id = records()

        def boom(*_args: object, **_kwargs: object) -> None:
            raise WorkspaceError("模拟回退失败")

        monkeypatch.setattr("forgeloop.graph.requirements.reset_workspace", boom)
        report = apply_prerequisite_candidates(workspace, [good, broken], record_path)
        recorded = store.outcomes.prerequisite_applications(task_id)

        assert report.blocked
        assert "回退失败" in report.blocked_reason
        assert recorded["good"][1] == "failed"
        assert recorded["broken"][1] == "failed"

    def test_checksum_mismatch_blocks_without_touching_workspace(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        tampered = replace(candidate, candidate_sha256="b" * 64)
        store, record_path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [tampered], record_path)

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.CHECKSUM_MISMATCH
        assert not (workspace / "alpha.txt").exists()
        assert store.outcomes.prerequisite_applications(task_id)["alpha"][1] == "checksum_mismatch"


class TestCoveredAndDiamondIdempotence:
    """菱形/冗余依赖下的幂等：被传递包含的前置不单独应用，也不重复应用。"""

    def test_covered_ancestor_skipped_descendant_applied_once(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        ancestor = make_candidate(tmp_path, source, "ancestor", "f.txt", "old\n")
        descendant_work = tmp_path / "prereq-descendant"
        prepare_workspace(source, "", descendant_work)
        apply_diff_to_workspace(descendant_work, ancestor.diff_path.read_text(encoding="utf-8"))
        (descendant_work / "f.txt").write_text("new\n", encoding="utf-8")
        change = collect_candidate_change(descendant_work)
        diff_path = tmp_path / "descendant.diff"
        diff_path.write_text(change.diff, encoding="utf-8")
        descendant = PrerequisiteCandidate("descendant", sha256_of_text(change.diff), diff_path)
        _store, record_path, _task_id = records()

        report = apply_prerequisite_candidates(
            workspace, [replace(ancestor, covered=True), descendant], record_path
        )
        repeat = apply_prerequisite_candidates(
            workspace, [replace(ancestor, covered=True), descendant], record_path
        )

        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses == {
            "ancestor": PrerequisiteApplyStatus.SKIPPED,
            "descendant": PrerequisiteApplyStatus.APPLIED,
        }
        assert repeat.applications[1].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert (workspace / "f.txt").read_text(encoding="utf-8") == "new\n"
        assert git(workspace, "status", "--porcelain").count("f.txt") == 1
