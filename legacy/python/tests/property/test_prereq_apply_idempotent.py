"""前置候选应用的属性测试：重复启动幂等，副本内容与变更集合保持不变。

不变量：
- 对任意一批前置候选，第一次应用后副本文件内容等于候选内容；第二次应用同样
  候选时逐条为 ``already_applied``，副本内容与 ``git status`` 变更集合一字不差；
- 本地已应用标记对任意 ``(task_id, candidate_sha256)`` 集合都满足「登记=集合包含、
  清空=空集」，重复登记不产生重复项；
- 任意现场改动经回退后都回到干净基线。

用例在真实 git 仓库上运行（``git apply`` / ``git status`` / 标记落盘都是真实
外部边界），只对生成数据做约束，不对结果打桩。
"""

import string
import subprocess
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from forgeloop.adapter.git_workspace import (
    applied_prerequisites,
    apply_diff_to_workspace,
    clear_applied_prerequisites,
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

GIT_ENV = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "GIT_AUTHOR_DATE": "2026-10-15T10:00:00+08:00",
    "GIT_COMMITTER_DATE": "2026-10-15T10:00:00+08:00",
}

HEX = st.text(alphabet="0123456789abcdef", min_size=64, max_size=64)
TASK_ID = st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=8)
FILENAME = st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=6).map(
    lambda name: f"{name}.txt"
)
CONTENT = st.text(alphabet=string.ascii_letters + string.digits + " -_", min_size=1, max_size=24)


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
    # Hypothesis 在同一临时目录里跑多个示例：源仓库只建一次，后续示例复用。
    if (source / ".git").is_dir():
        return source
    source.mkdir(exist_ok=True)
    (source / "base.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def _new_file_diff(name: str, content: str) -> str:
    """构造一份添加新文件的真实 diff 文本（内容以换行结尾）。"""

    return (
        f"diff --git a/{name} b/{name}\n"
        "new file mode 100644\n"
        "--- /dev/null\n"
        f"+++ b/{name}\n"
        "@@ -0,0 +1 @@\n"
        f"+{content}\n"
    )


def _candidate(tmp_path: Path, files: dict[str, str], prefix: str) -> list[PrerequisiteCandidate]:
    candidates: list[PrerequisiteCandidate] = []
    for index, (name, content) in enumerate(sorted(files.items())):
        diff = _new_file_diff(name, content)
        diff_path = tmp_path / f"{prefix}-{index}.diff"
        diff_path.write_text(diff, encoding="utf-8")
        candidates.append(
            PrerequisiteCandidate(f"{prefix}{index}", sha256_of_text(diff), diff_path)
        )
    return candidates


def _fresh_workspace(tmp_path: Path, name: str) -> Path:
    source = make_source_repo(tmp_path)
    workspace = tmp_path / name / "workspace"
    prepare_workspace(source, "", workspace)
    baseline = git(workspace, "rev-parse", "HEAD").strip()
    reset_workspace(workspace, baseline)
    clear_applied_prerequisites(workspace)
    return workspace


class TestMarkerSetSemantics:
    @given(st.lists(st.tuples(TASK_ID, HEX), min_size=1, max_size=6))
    @settings(
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
    )
    def test_mark_equals_contains_and_clear_empties(
        self, tmp_path: Path, pairs: list[tuple[str, str]]
    ) -> None:
        workspace = _fresh_workspace(tmp_path, "marker-ws")

        for task_id, digest in pairs:
            mark_prerequisite_applied(workspace, task_id, digest)

        # 幂等登记语义：结果恰好是输入集合，不含重复项、不丢项。
        assert applied_prerequisites(workspace) == frozenset(pairs)

        clear_applied_prerequisites(workspace)

        assert applied_prerequisites(workspace) == frozenset()


class TestRepeatedStartupIsIdempotent:
    @given(st.dictionaries(FILENAME, CONTENT, min_size=1, max_size=4))
    @settings(
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
        max_examples=25,
    )
    def test_second_apply_keeps_content_and_change_set(
        self, tmp_path: Path, files: dict[str, str]
    ) -> None:
        # base.txt 已存在：新文件候选不能与基线文件同名，否则 apply 必然失败。
        files = {name: content for name, content in files.items() if name != "base.txt"}
        if not files:
            return
        workspace = _fresh_workspace(tmp_path, "idempotent-ws")
        record_path = tmp_path / "no-store" / "task-downstream" / PREREQUISITE_RECORD_NAME
        candidates = _candidate(tmp_path, files, "idem")

        first = apply_prerequisite_candidates(workspace, candidates, record_path)
        first_status = git(workspace, "status", "--porcelain")
        first_contents = {name: (workspace / name).read_text(encoding="utf-8") for name in files}

        second = apply_prerequisite_candidates(workspace, candidates, record_path)
        second_contents = {name: (workspace / name).read_text(encoding="utf-8") for name in files}

        assert not first.blocked and not second.blocked
        assert all(item.status is PrerequisiteApplyStatus.APPLIED for item in first.applications)
        assert all(
            item.status is PrerequisiteApplyStatus.ALREADY_APPLIED for item in second.applications
        )
        assert first_contents == {name: content + "\n" for name, content in files.items()}
        assert second_contents == first_contents
        assert git(workspace, "status", "--porcelain") == first_status
        assert first_status.count("??") == len(files)


class TestResetAlwaysReturnsToBaseline:
    @given(st.dictionaries(FILENAME, CONTENT, min_size=1, max_size=4))
    @settings(
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
        max_examples=15,
    )
    def test_reset_discards_arbitrary_changes(self, tmp_path: Path, files: dict[str, str]) -> None:
        workspace = _fresh_workspace(tmp_path, "reset-ws")
        baseline = git(workspace, "rev-parse", "HEAD").strip()
        for name, content in files.items():
            (workspace / name).write_text(content, encoding="utf-8")

        reset_workspace(workspace, baseline)

        assert (workspace / "base.txt").read_text(encoding="utf-8") == "baseline\n"
        assert git(workspace, "status", "--porcelain").strip() == ""
        for name in files:
            assert not (workspace / name).exists()


class TestApplyPrimitiveContent:
    @given(CONTENT)
    @settings(
        suppress_health_check=[HealthCheck.function_scoped_fixture],
        deadline=None,
        max_examples=15,
    )
    def test_applied_diff_content_round_trips(self, tmp_path: Path, content: str) -> None:
        workspace = _fresh_workspace(tmp_path, "content-ws")
        diff = _new_file_diff("property.txt", content)

        apply_diff_to_workspace(workspace, diff)

        assert (workspace / "property.txt").read_text(encoding="utf-8") == f"{content}\n"
