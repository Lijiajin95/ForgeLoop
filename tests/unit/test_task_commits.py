"""任务与 commit 的关联记录（所有者 2026-10-18 决定的累积关联模型）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from forgeloop.records.store import TASK_COMMIT_RELATIONS, RecordStore

TASK_ID = "task-20261018-abcdef"
SHA = "a" * 40
OTHER = "b" * 40


@pytest.fixture
def store(tmp_path: Path):
    record_store = RecordStore(tmp_path / "records.sqlite")
    record_store.create_task(TASK_ID, "ForgeLoop", "任务目标", {"project_path": "/tmp/x"}, 3600.0)
    try:
        yield record_store
    finally:
        record_store.close()


class TestTaskCommitRelation:
    def test_three_relations_are_the_contract(self) -> None:
        assert {"implementation", "acceptance", "merge"} == TASK_COMMIT_RELATIONS

    def test_records_each_relation_once_and_accumulates_many_commits(self, store) -> None:
        """一个任务可关联多个 commit：实现两次 + 验收 + 归并共 4 条，重复调用不翻倍。"""

        store.record_task_commit(TASK_ID, SHA, "implementation", by="agent")
        store.record_task_commit(TASK_ID, OTHER, "implementation", by="agent")
        store.record_task_commit(TASK_ID, SHA, "acceptance", by="owner")
        store.record_task_commit(TASK_ID, "c" * 40, "merge", by="owner")
        store.record_task_commit(TASK_ID, SHA, "implementation", by="agent")  # 重复

        commits = store.task_commits(TASK_ID)
        assert [(item.commit_sha[:1], item.relation) for item in commits] == [
            ("a", "implementation"),
            ("b", "implementation"),
            ("a", "acceptance"),
            ("c", "merge"),
        ]
        assert commits[2].recorded_by == "owner"

    def test_commit_sha_is_normalized_and_validated(self, store) -> None:
        stored = store.record_task_commit(TASK_ID, "  " + "A" * 40 + "  ", "implementation")
        assert stored.commit_sha == "a" * 40
        for bad in ("", "xyz", "a" * 5, "g" * 40):
            with pytest.raises(ValueError, match="十六进制"):
                store.record_task_commit(TASK_ID, bad, "implementation")

    def test_unknown_relation_is_refused(self, store) -> None:
        with pytest.raises(ValueError, match="未知的任务-提交关联关系"):
            store.record_task_commit(TASK_ID, SHA, "unknown")

    def test_other_task_commits_are_not_mixed_in(self, store) -> None:
        store.record_task_commit("task-other", SHA, "implementation")
        store.record_task_commit(TASK_ID, OTHER, "implementation")
        assert [item.commit_sha for item in store.task_commits(TASK_ID)] == [OTHER]


class TestPrerequisiteThreadId:
    """前置单任务身份推导（关联表按单任务身份落库）。"""

    def test_derives_same_prefix_with_prerequisite_name(self) -> None:
        from forgeloop.graph.requirements import _prerequisite_thread_id

        downstream = "task-req-20261016021551-ed498a-v6-mail-smtp-send"
        assert _prerequisite_thread_id(downstream, "mail-ports") == (
            "task-req-20261016021551-ed498a-v6-mail-ports"
        )

    def test_unknown_shape_returns_empty_instead_of_guessing(self) -> None:
        from forgeloop.graph.requirements import _prerequisite_thread_id

        assert _prerequisite_thread_id("task-plain", "mail-ports") == ""
        assert _prerequisite_thread_id("task-x-v-notdigits-y", "mail-ports") == ""


class TestDeployApproval:
    """发布前需确认（所有者 2026-10-18 决定）：批准绑定版本与产物身份。"""

    def test_records_and_reads_back(self, store) -> None:
        assert store.deploy_approval("v1.2.3") is None
        store.record_deploy_approval("v1.2.3", "a" * 64, by="owner", reason="确认安装到本机")
        assert store.deploy_approval("v1.2.3") == ("v1.2.3", "a" * 64)

    def test_later_approval_for_same_tag_replaces_and_binds_new_artifact(self, store) -> None:
        store.record_deploy_approval("v1.2.3", "a" * 64, by="owner", reason="第一次确认")
        store.record_deploy_approval("v1.2.3", "b" * 64, by="owner", reason="换产物后重新确认")
        assert store.deploy_approval("v1.2.3") == ("v1.2.3", "b" * 64)

    def test_missing_by_or_reason_or_bad_digest_is_refused(self, store) -> None:
        for kwargs in (
            {"by": "", "reason": "理由"},
            {"by": "owner", "reason": "   "},
            {"by": "owner", "reason": "理由", "artifact_sha256": "xyz"},
        ):
            digest = kwargs.pop("artifact_sha256", "a" * 64)
            with pytest.raises(ValueError):
                store.record_deploy_approval("v1.2.3", digest, **kwargs)
        assert store.deploy_approval("v1.2.3") is None  # 拒绝时零副作用


class TestLatestRelease:
    """最近一次发布（待部署结论的输入之一）：校验值以发布回执为准。"""

    def test_no_release_returns_none(self, store) -> None:
        assert store.latest_release() is None

    def test_reads_tag_and_digest_from_receipt(self, store, tmp_path) -> None:
        import json

        task_dir = tmp_path / TASK_ID
        task_dir.mkdir(exist_ok=True)
        receipt = task_dir / "release-receipt.json"
        receipt.write_text(json.dumps({"artifact_sha256": "c" * 64}), encoding="utf-8")
        store._db.execute(
            "INSERT INTO releases (task_id, tag, merge_commit, baseline_commit, diff_sha256,"
            " receipt_path, pushed, push_detail, released_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)",
            (
                TASK_ID,
                "v1.2.3",
                "a" * 40,
                "b" * 40,
                "d" * 64,
                receipt.name,
                "2026-10-18T00:00:00+00:00",
            ),
        )
        assert store.latest_release() == ("v1.2.3", "c" * 64)

    def test_broken_receipt_is_reported_as_unknown(self, store, tmp_path) -> None:
        store._db.execute(
            "INSERT INTO releases (task_id, tag, merge_commit, baseline_commit, diff_sha256,"
            " receipt_path, pushed, push_detail, released_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)",
            (
                TASK_ID,
                "v1.2.3",
                "a" * 40,
                "b" * 40,
                "d" * 64,
                "missing.json",
                "2026-10-18T00:00:00+00:00",
            ),
        )
        assert store.latest_release() is None
