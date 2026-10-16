"""前置候选应用的核心行为：下游副本里真的出现前置文件内容。

对应需求「让下游任务的副本真正带上已完成前置的代码」的验收前两条：

- 应用后读取下游副本内的**实际文件内容**，确认为前置产物内容，而不是只检查
  传给提示词的身份/摘要；
- 前置产物缺失或校验值不符时整体阻塞，错误信息指出具体是哪一个产物、为什么；
- 无已完成前置依赖时按既有流程启动，行为不变、不写记录、不动副本。

用例在真实 git 副本与真实 SQLite 记录库上运行：clone、apply、记录读写都走真实
外部边界，不使用 fixture 伪装结果，也不写空断言。
"""

import json
import subprocess
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Protocol

import pytest

from forgeloop.adapter.git_workspace import (
    collect_candidate_change,
    prepare_workspace,
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
    """测试用记录库工厂：按下游任务身份创建真实记录库与记录现场路径。"""

    def __call__(self, task_id: str = ...) -> tuple[RecordStore, Path, str]: ...


@pytest.fixture
def records(tmp_path: Path) -> Iterator[RecordsFactory]:
    """真实 SQLite 记录库 + 下游任务现场路径；结束统一关闭连接，不泄漏 sqlite。"""

    opened: list[RecordStore] = []

    def make(task_id: str = "task-downstream-v1-beta") -> tuple[RecordStore, Path, str]:
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
    """在独立副本里造一份真实候选 diff，返回其任务身份、校验值与现场路径。"""

    work = tmp_path / f"prereq-{task_id}"
    prepare_workspace(source, "", work)
    target = work / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    change = collect_candidate_change(work)
    diff_path = tmp_path / f"{task_id}.diff"
    diff_path.write_text(change.diff, encoding="utf-8")
    return PrerequisiteCandidate(task_id, sha256_of_text(change.diff), diff_path)


def record_path(tmp_path: Path, task_id: str = "task-downstream-v1-beta") -> Path:
    return tmp_path / "no-store-records" / task_id / PREREQUISITE_RECORD_NAME


class TestAppliedContentIsReal:
    """应用后用真实文件内容断言，而不是信任传入的身份/摘要。"""

    def test_downstream_copy_contains_prerequisite_file_content(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(
            tmp_path, source, "alpha", "alpha.txt", "alpha-content-from-prerequisite\n"
        )

        report = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert not report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        # 真实读取副本内文件内容，而不是只看报告/身份。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == (
            "alpha-content-from-prerequisite\n"
        )

    def test_nested_prerequisite_files_are_all_present(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        first = make_candidate(tmp_path, source, "first", "pkg/first.txt", "first\n")
        second = make_candidate(tmp_path, source, "second", "pkg/second.txt", "second\n")

        report = apply_prerequisite_candidates(workspace, [first, second], record_path(tmp_path))

        assert [item.status for item in report.applications] == [
            PrerequisiteApplyStatus.APPLIED,
            PrerequisiteApplyStatus.APPLIED,
        ]
        assert (workspace / "pkg" / "first.txt").read_text(encoding="utf-8") == "first\n"
        assert (workspace / "pkg" / "second.txt").read_text(encoding="utf-8") == "second\n"

    def test_modified_file_content_matches_prerequisite_exactly(self, tmp_path: Path) -> None:
        """前置改动已存在文件的正文：副本正文与前置产物完全一致。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "edit", "base.txt", "changed-by-prereq\n")

        apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert (workspace / "base.txt").read_text(encoding="utf-8") == "changed-by-prereq\n"
        assert git(workspace, "status", "--porcelain").count("base.txt") == 1


class TestValidationBlocksWithReason:
    """校验不符或缺失时阻塞，且指出具体产物与原因；不写入任何代码。"""

    def test_checksum_mismatch_blocks_and_names_artifact_and_reason(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        tampered = replace(candidate, candidate_sha256="b" * 64)
        store, path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [tampered], path)
        recorded = store.outcomes.prerequisite_applications(task_id)

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.CHECKSUM_MISMATCH
        # 错误信息点名具体产物，并给出「校验值不符」这一原因。
        assert "alpha" in report.blocked_reason
        assert "校验值不符" in report.applications[0].detail
        assert not (workspace / "alpha.txt").exists()
        assert recorded["alpha"][1] == "checksum_mismatch"

    def test_missing_diff_blocks_and_names_artifact(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        ghost = PrerequisiteCandidate("ghost", "a" * 64, tmp_path / "ghost.diff")
        store, path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [ghost], path)

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.MISSING
        assert "ghost" in report.blocked_reason
        assert "缺失" in report.applications[0].detail
        assert store.outcomes.prerequisite_applications(task_id)["ghost"][1] == "missing"

    def test_empty_diff_blocks_as_missing(self, tmp_path: Path, records: RecordsFactory) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        diff_path = tmp_path / "empty.diff"
        diff_path.write_text("", encoding="utf-8")
        candidate = PrerequisiteCandidate("empty", sha256_of_text(""), diff_path)
        store, path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [candidate], path)

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.MISSING
        assert "empty" in report.blocked_reason
        assert store.outcomes.prerequisite_applications(task_id)["empty"][1] == "missing"

    def test_one_bad_candidate_blocks_all_and_leaves_workspace_clean(
        self, tmp_path: Path, records: RecordsFactory
    ) -> None:
        """一个坏候选阻塞整批：好候选也不得被应用，避免半成品工作树。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        bad = PrerequisiteCandidate("bad", "c" * 64, tmp_path / "missing.diff")
        store, path, task_id = records()

        report = apply_prerequisite_candidates(workspace, [good, bad], path)
        recorded = store.outcomes.prerequisite_applications(task_id)

        assert report.blocked
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""
        assert recorded["good"][1] == "skipped"
        assert recorded["bad"][1] == "missing"
        document = json.loads(path.read_text(encoding="utf-8"))
        assert document["blocked_reason"]


class TestNoPrerequisitesKeepsFlow:
    def test_no_candidates_is_a_noop(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        path = record_path(tmp_path)

        report = apply_prerequisite_candidates(workspace, [], path)

        assert not report.blocked
        assert report.applications == ()
        assert not path.exists()
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(workspace, "status", "--porcelain").strip() == ""


class TestRecordedOutcome:
    """逐条记录：前置产物标识、记录校验值与结果对得上。"""

    def test_report_records_identifier_checksum_and_result(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        path = record_path(tmp_path)

        apply_prerequisite_candidates(workspace, [candidate], path)

        document = json.loads(path.read_text(encoding="utf-8"))
        assert document["blocked_reason"] == ""
        assert document["applications"] == [
            {
                "task_id": "alpha",
                "candidate_sha256": candidate.candidate_sha256,
                "status": "applied",
                "detail": "",
            }
        ]
