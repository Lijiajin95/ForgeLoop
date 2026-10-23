"""需求编排中的前置候选应用：下游启动前把已完成前置的候选改动作为代码输入。

对应需求「让下游任务的副本真正带上已完成前置的代码」的核心行为：

- 下游副本在启动时确实包含前置候选对应的文件内容（真实文件断言，不是身份/摘要）；
- 启动记录逐条给出前置产物标识、校验值与成功/失败结果；
- 任一前置缺失或校验值不符时整体阻塞并指明缺哪一条，不静默继续；
- 无已完成前置依赖时行为不变（不写记录、不动副本）。

用例在真实 git 副本上运行：clone、apply、回退都是真实 git 操作，不使用伪装的
文件系统替身，避免把「传了身份」当成「代码真的到了副本」。
"""

import json
import subprocess
from dataclasses import replace
from pathlib import Path

from forgeloop.adapter.git_workspace import (
    apply_diff_to_workspace,
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

GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}


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


def make_workspace(tmp_path: Path, source: Path) -> Path:
    workspace = tmp_path / "downstream" / "workspace"
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


def make_candidate_on(
    tmp_path: Path,
    source: Path,
    task_id: str,
    files: dict[str, str],
    *,
    on: tuple[PrerequisiteCandidate, ...] = (),
) -> PrerequisiteCandidate:
    """造一份建立在已完成前置之上的候选：其 diff 相对基线已包含前置改动。

    这模拟菱形/冗余依赖：后建任务在已应用前置的副本里采集候选，因此它的
    ``candidate.diff`` 本就带有祖先的全部改动。
    """

    work = tmp_path / f"prereq-{task_id}"
    prepare_workspace(source, "", work)
    for prerequisite in on:
        apply_diff_to_workspace(work, prerequisite.diff_path.read_text(encoding="utf-8"))
    for name, content in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    change = collect_candidate_change(work)
    diff_path = tmp_path / f"{task_id}.diff"
    diff_path.write_text(change.diff, encoding="utf-8")
    return PrerequisiteCandidate(task_id, sha256_of_text(change.diff), diff_path)


def record_path(tmp_path: Path) -> Path:
    return tmp_path / PREREQUISITE_RECORD_NAME


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


class TestApplyPrerequisites:
    def test_applies_prerequisite_candidate_as_code(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")

        report = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert not report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"

    def test_applies_multiple_prerequisites_in_dependency_order(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        first = make_candidate(tmp_path, source, "first", "first.txt", "first\n")
        second = make_candidate(tmp_path, source, "second", "second.txt", "second\n")

        report = apply_prerequisite_candidates(workspace, [first, second], record_path(tmp_path))

        assert not report.blocked
        assert [item.task_id for item in report.applications] == ["first", "second"]
        assert (workspace / "first.txt").is_file()
        assert (workspace / "second.txt").is_file()

    def test_record_contains_identifier_checksum_and_result(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")

        apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        document = json.loads(record_path(tmp_path).read_text(encoding="utf-8"))
        assert document["blocked_reason"] == ""
        assert document["applications"] == [
            {
                "task_id": "alpha",
                "candidate_sha256": candidate.candidate_sha256,
                "status": "applied",
                "detail": "",
            }
        ]

    def test_no_prerequisites_keeps_existing_flow(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)

        report = apply_prerequisite_candidates(workspace, [], record_path(tmp_path))

        assert not report.blocked
        assert report.applications == ()
        assert not record_path(tmp_path).exists()
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"


class TestPrerequisiteValidationBlocksStartup:
    def test_missing_candidate_blocks_and_changes_nothing(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = PrerequisiteCandidate("ghost", "a" * 64, tmp_path / "ghost.diff")

        report = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.MISSING
        assert "ghost" in report.blocked_reason
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"

    def test_checksum_mismatch_blocks_and_names_the_candidate(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")
        tampered = replace(candidate, candidate_sha256="b" * 64)

        report = apply_prerequisite_candidates(workspace, [tampered], record_path(tmp_path))

        assert report.blocked
        assert report.applications[0].status is PrerequisiteApplyStatus.CHECKSUM_MISMATCH
        assert "alpha" in report.blocked_reason
        assert not (workspace / "alpha.txt").exists()

    def test_one_bad_candidate_blocks_the_whole_startup(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        bad = PrerequisiteCandidate("bad", "c" * 64, tmp_path / "missing.diff")

        report = apply_prerequisite_candidates(workspace, [good, bad], record_path(tmp_path))

        assert report.blocked
        # 校验阶段整体阻塞：好的候选也不得被应用，避免半成品工作树。
        assert not (workspace / "good.txt").exists()

    def test_blocked_report_is_recorded(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = PrerequisiteCandidate("ghost", "a" * 64, tmp_path / "ghost.diff")

        apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        document = json.loads(record_path(tmp_path).read_text(encoding="utf-8"))
        assert "ghost" in document["blocked_reason"]
        assert document["applications"][0]["status"] == "missing"


class TestRedundantAndDiamondPrerequisites:
    """菱形/冗余依赖：后建前置的 diff 已含祖先改动，不得误阻塞也不得丢代码。"""

    def test_nested_candidate_is_not_applied_twice(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        alpha = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        beta = make_candidate_on(tmp_path, source, "beta", {"beta.txt": "beta\n"}, on=(alpha,))
        # beta 的候选 diff 相对基线确实带着 alpha 的改动（菱形/冗余的来源）。
        assert "alpha.txt" in beta.diff_path.read_text(encoding="utf-8")

        report = apply_prerequisite_candidates(workspace, [alpha, beta], record_path(tmp_path))

        assert not report.blocked
        assert [item.status for item in report.applications] == [
            PrerequisiteApplyStatus.APPLIED,
            PrerequisiteApplyStatus.APPLIED,
        ]
        # 下游副本真正带上全部前置代码，而不是只记录身份。
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha\n"
        assert (workspace / "beta.txt").read_text(encoding="utf-8") == "beta\n"
        document = json.loads(record_path(tmp_path).read_text(encoding="utf-8"))
        assert document["blocked_reason"] == ""
        assert [entry["task_id"] for entry in document["applications"]] == ["alpha", "beta"]
        assert all(entry["status"] == "applied" for entry in document["applications"])

    def test_diamond_shared_ancestor_keeps_all_sibling_changes(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        root = make_candidate(tmp_path, source, "root", "root.txt", "root\n")
        left = make_candidate_on(tmp_path, source, "left", {"left.txt": "left\n"}, on=(root,))
        right = make_candidate_on(tmp_path, source, "right", {"right.txt": "right\n"}, on=(root,))

        report = apply_prerequisite_candidates(
            workspace, [root, left, right], record_path(tmp_path)
        )

        assert not report.blocked
        assert report.applied_count == 3
        for name in ("root.txt", "left.txt", "right.txt"):
            assert (workspace / name).is_file(), name
            assert git(workspace, "status", "--porcelain").count(name) == 1

    def test_descendant_applied_before_ancestor_is_idempotent(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        alpha = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha\n")
        beta = make_candidate_on(tmp_path, source, "beta", {"beta.txt": "beta\n"}, on=(alpha,))

        report = apply_prerequisite_candidates(workspace, [beta, alpha], record_path(tmp_path))

        assert not report.blocked
        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses == {
            "beta": PrerequisiteApplyStatus.APPLIED,
            "alpha": PrerequisiteApplyStatus.ALREADY_APPLIED,
        }
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha\n"
        assert (workspace / "beta.txt").read_text(encoding="utf-8") == "beta\n"

    def test_covered_ancestor_is_skipped_not_reapplied(self, tmp_path: Path) -> None:
        """被传递包含的祖先不单独应用：后代把祖先新建的文件改成自己的新内容。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        ancestor = make_candidate(tmp_path, source, "ancestor", "f.txt", "old\n")
        descendant = make_candidate_on(
            tmp_path, source, "descendant", {"f.txt": "new\n"}, on=(ancestor,)
        )
        # 需求层按依赖拓扑算出的「被传递包含」标记：祖先不再单独应用。
        covered_ancestor = replace(ancestor, covered=True)

        report = apply_prerequisite_candidates(
            workspace, [covered_ancestor, descendant], record_path(tmp_path)
        )

        assert not report.blocked
        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses == {
            "ancestor": PrerequisiteApplyStatus.SKIPPED,
            "descendant": PrerequisiteApplyStatus.APPLIED,
        }
        # 后代对祖先新建文件的改动生效，而不是被祖先旧内容覆盖或因 add/add 冲突。
        assert (workspace / "f.txt").read_text(encoding="utf-8") == "new\n"
        document = json.loads(record_path(tmp_path).read_text(encoding="utf-8"))
        assert document["applications"][0]["status"] == "skipped"
        assert document["applications"][1]["status"] == "applied"

    def test_real_conflict_still_blocks_and_rolls_back(self, tmp_path: Path) -> None:
        """同文件同处的真实冲突不是冗余：仍阻塞并回退，不把冲突静默当成功。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        left = make_candidate(tmp_path, source, "left", "base.txt", "left-change\n")
        right = make_candidate(tmp_path, source, "right", "base.txt", "right-change\n")

        report = apply_prerequisite_candidates(workspace, [left, right], record_path(tmp_path))

        assert report.blocked
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(workspace, "status", "--porcelain").strip() == ""


class TestIdempotenceAndRollback:
    def test_repeated_startup_does_not_reapply_or_leave_residue(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")

        first = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))
        second = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == "alpha-content\n"
        assert git(workspace, "status", "--porcelain").count("alpha.txt") == 1

    def test_failed_apply_rolls_back_to_clean_workspace(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path)

        report = apply_prerequisite_candidates(workspace, [good, broken], record_path(tmp_path))

        assert report.blocked
        assert report.applications[1].status is PrerequisiteApplyStatus.FAILED
        # 回退到干净副本：先前应用的文件与新文件都不残留。
        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""

    def test_middle_candidate_failure_records_every_candidate(self, tmp_path: Path) -> None:
        """中段候选失败：不能因缺少 outcomes 条目抛 KeyError，且逐条都有结果。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")
        broken = broken_candidate(tmp_path)
        later = make_candidate(tmp_path, source, "later", "later.txt", "later\n")

        report = apply_prerequisite_candidates(
            workspace, [good, broken, later], record_path(tmp_path)
        )

        assert report.blocked
        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses == {
            "good": PrerequisiteApplyStatus.FAILED,
            "broken": PrerequisiteApplyStatus.FAILED,
            "later": PrerequisiteApplyStatus.SKIPPED,
        }
        assert "broken" in report.blocked_reason
        document = json.loads(record_path(tmp_path).read_text(encoding="utf-8"))
        assert {entry["task_id"] for entry in document["applications"]} == {
            "good",
            "broken",
            "later",
        }
        # 回退到干净副本：中段失败后前面已应用的文件、后面未应用的文件都不残留。
        assert not (workspace / "good.txt").exists()
        assert not (workspace / "later.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""

    def test_first_candidate_failure_records_every_candidate(self, tmp_path: Path) -> None:
        """首个候选失败：后续候选记为未应用，启动被阻塞且报告不缺条。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        broken = broken_candidate(tmp_path)
        good = make_candidate(tmp_path, source, "good", "good.txt", "good\n")

        report = apply_prerequisite_candidates(workspace, [broken, good], record_path(tmp_path))

        assert report.blocked
        statuses = {item.task_id: item.status for item in report.applications}
        assert statuses == {
            "broken": PrerequisiteApplyStatus.FAILED,
            "good": PrerequisiteApplyStatus.SKIPPED,
        }
        assert not (workspace / "good.txt").exists()
        assert git(workspace, "status", "--porcelain").strip() == ""

    def test_retry_after_downstream_modifies_prerequisite_keeps_changes(
        self, tmp_path: Path
    ) -> None:
        """下游改过前置文件后重入：不得重复 apply，也不得回退丢弃下游改动。"""

        source = make_source_repo(tmp_path)
        workspace = make_workspace(tmp_path, source)
        candidate = make_candidate(tmp_path, source, "alpha", "alpha.txt", "alpha-content\n")

        first = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))
        assert first.applications[0].status is PrerequisiteApplyStatus.APPLIED
        # 模拟 review 阻断 / 测试失败后回到 dev：下游在首轮基础上继续改了前置文件。
        (workspace / "alpha.txt").write_text("alpha-content\ndownstream-change\n", encoding="utf-8")

        second = apply_prerequisite_candidates(workspace, [candidate], record_path(tmp_path))

        assert not second.blocked
        assert second.applications[0].status is PrerequisiteApplyStatus.ALREADY_APPLIED
        assert (workspace / "alpha.txt").read_text(encoding="utf-8") == (
            "alpha-content\ndownstream-change\n"
        )
