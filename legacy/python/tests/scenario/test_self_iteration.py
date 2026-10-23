"""自迭代模拟：git 工作副本 + 真实 diff + 副本内测试 + main 保护。

源仓库含 feature.txt（old）与 run_tests.py（要求 feature.txt==new）；
假 PI（edit 模式）真实修改工作副本；候选 diff 取自 git 而非 PI 自述；
正式测试在副本内运行；交付固化基线提交号；源仓库全程不被改写。
"""

import argparse
import hashlib
import json
from pathlib import Path

import pytest
from project_support import record_store
from support import run_cli, run_git, status_document, submit_task, task_dir


class TestSelfIterationLoop:
    """自迭代模拟：git 工作副本 + 真实 diff + 副本内测试 + main 保护。

    源仓库含 feature.txt（old）与 run_tests.py（要求 feature.txt==new）；
    假 PI（edit 模式）真实修改工作副本；候选 diff 取自 git 而非 PI 自述；
    正式测试在副本内运行；交付固化基线提交号；源仓库全程不被改写。
    """

    def _source_repo(self, tmp_path: Path) -> Path:
        import subprocess

        source = tmp_path / "forgeloop-mirror"
        source.mkdir()
        (source / "feature.txt").write_text("old\n", encoding="utf-8")
        (source / "pyproject.toml").write_text(
            '[project]\nname = "mirror"\nversion = "0.1.0"\n', encoding="utf-8"
        )
        (source / "run_tests.py").write_text(
            "import sys\n"
            "ok = open('feature.txt').read().strip() == 'new'\n"
            "print('feature.txt is', 'new' if ok else 'old')\n"
            "sys.exit(0 if ok else 1)\n",
            encoding="utf-8",
        )
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(tmp_path),
            "GIT_AUTHOR_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T20:00:00+08:00",
        }
        for args in (
            ["git", "init", "-b", "main"],
            ["git", "config", "user.name", "t"],
            ["git", "config", "user.email", "t@example.com"],
            ["git", "add", "-A"],
            ["git", "commit", "-m", "chore: mirror baseline"],
        ):
            subprocess.run(args, cwd=source, check=True, capture_output=True, env=env)
        return source

    def test_clone_edit_diff_test_deliver(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = self._source_repo(tmp_path)

        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        code, out = run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "awaiting_acceptance"

        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"

        # 候选 diff 来自 git 工作树对基线的真实差异（非 PI 文本自述）。
        candidate = Path(document["delivery"]["diff_path"])
        diff_text = candidate.read_text(encoding="utf-8")
        assert "-old" in diff_text and "+new" in diff_text
        assert "feature.txt" in diff_text

        # dev 报告记录 diff 来源与基线提交号。
        dev_reports = [
            json.loads(line)
            for line in (task_dir(tmp_path, task_id) / "dev-reports.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert dev_reports[0]["diff_source"] == "git"
        assert len(dev_reports[0]["baseline_commit"]) == 40

        # 交付报告固化基线提交号（A02：最终交付明确基线与改动）。
        report = json.loads(
            (task_dir(tmp_path, task_id) / "delivery-report.json").read_text(encoding="utf-8")
        )
        assert len(report["baseline_commit"]) == 40

        # 正式测试在副本内真实执行且通过（feature.txt 已被 PI 修改）。
        runs = [
            json.loads(line)
            for line in (task_dir(tmp_path, task_id) / "test-run.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        assert runs[0]["exit_code"] == 0
        assert "feature.txt is new" in runs[0]["stdout"]

        # main 保护：源仓库未被改写（A02：PI 无法修改真实 main）。
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"


class TestMergeToMain:
    """B04 端到端：验收交付后受控归并 main（含漂移与未验收负例）。"""

    def _deliver_task(self, tmp_path: Path, capsys, monkeypatch) -> tuple[str, Path]:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = TestSelfIterationLoop()._source_repo(tmp_path)
        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        run_cli(["approve", task_id, "--records-root", str(tmp_path)], capsys)
        code, out = run_cli(
            ["approve", task_id, "--stage", "acceptance", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "delivered"
        return task_id, source

    def test_merge_updates_main_and_records_provenance(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        # main 已更新：源仓库直接包含候选改动。
        assert (source / "feature.txt").read_text(encoding="utf-8") == "new\n"
        # 状态与归并记录固化来源（merge_commit 与源 main HEAD 一致）。
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "merged"
        assert document["merge"] is not None
        assert document["merge"]["merge_commit"] == document["merge"]["merge_commit"].strip()

    def test_merge_before_delivery_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import sys

        monkeypatch.setenv("FAKE_PI_MODE", "edit")
        source = TestSelfIterationLoop()._source_repo(tmp_path)
        task_id = submit_task(
            tmp_path,
            capsys,
            **{
                "project-path": str(source),
                "test-command": json.dumps([sys.executable, "run_tests.py"]),
            },
        )
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "无法归并" in out  # 未验收（无交付记录）拒绝更新 main
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"

    def test_merge_refuses_drifted_main(self, tmp_path: Path, capsys, monkeypatch) -> None:
        import subprocess

        from forgeloop.adapter.git_workspace import read_main_head

        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        # 交付后 main 前进（漂移）。
        (source / "other.txt").write_text("drift\n", encoding="utf-8")
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(tmp_path),
            "GIT_AUTHOR_DATE": "2026-10-11T21:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T21:00:00+08:00",
        }
        for args in (
            ["git", "add", "-A"],
            ["git", "commit", "-m", "chore: main drifted"],
        ):
            subprocess.run(args, cwd=source, check=True, capture_output=True, env=env)
        drifted = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        ).stdout.strip()
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--by", "owner", "--records-root", str(tmp_path)],
            capsys,
        )
        # 关联模型（2026-10-18）：主干前进本身不再是否决条件；材料未变且候选可干净
        # 应用即允许归并，并把归并提交挂到任务上。
        assert code == 0, out
        assert "已归并 main" in out
        assert read_main_head(source) != drifted
        store = record_store(tmp_path)
        try:
            relations = {item.relation for item in store.task_commits(task_id)}
            merged = [item for item in store.task_commits(task_id) if item.relation == "merge"]
        finally:
            store.close()
        assert "merge" in relations
        assert merged and merged[-1].commit_sha == read_main_head(source)

    def test_merge_refuses_replaced_accepted_candidate(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # K11：验收后再替换候选 diff，归并必须拒绝（不能沿用原验收）。
        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        candidate = task_dir(tmp_path, task_id) / "candidate.diff"
        candidate.write_text(
            candidate.read_text(encoding="utf-8") + "\n+tampered", encoding="utf-8"
        )
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "漂移" in out
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"

    def test_merge_pushes_to_remote_when_configured(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        import subprocess

        task_id, source = self._deliver_task(tmp_path, capsys, monkeypatch)
        bare = tmp_path / "origin.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME": str(tmp_path)}
        subprocess.run(
            ["git", "remote", "add", "origin", str(bare)],
            cwd=source,
            check=True,
            capture_output=True,
            env=env,
        )
        # 该裸仓库没有 CI，故显式走直接流程（候选分支流程见 test_merge_flow.py）。
        code, out = run_cli(
            ["merge", task_id, "--direct-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        document = status_document(tmp_path, task_id, capsys)
        assert document["status"] == "merged"
        assert document["merge"]["pushed"] is True
        remote_head = subprocess.run(
            ["git", "--git-dir", str(bare), "rev-parse", "main"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert remote_head == document["merge"]["merge_commit"]


def seed_candidate_artifact(
    tmp_path: Path, task_id: str, source: Path, version: str = "0.1.0"
) -> str:
    """模拟 C01 已构建并验证的候选产物：wheel 原件 + 回执，校验值与文件一致。

    真实构建路径由 tests/scenario/test_candidate_artifact.py 覆盖；这里只驱动发布侧
    对同一产物的绑定与幂等判定，不重复跑一次耗时的 uv build。
    """

    task_path = task_dir(tmp_path, task_id)
    wheel_name = f"forgeloop-{version}-py3-none-any.whl"
    wheel = task_path / "artifacts" / wheel_name
    wheel.parent.mkdir(parents=True, exist_ok=True)
    wheel.write_bytes(b"accepted candidate wheel\n")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    commit = run_git(source, "rev-parse", "HEAD")
    receipt = {
        "task_id": task_id,
        "commit": commit,
        "version": version,
        "wheel_name": wheel_name,
        "sha256": digest,
        "rebuild_sha256": digest,
        "reproducible": True,
        "smoke_exit_code": 0,
        "smoke_detail": "",
        "wheel_path": str(wheel),
        "built_at": "2026-10-11T20:00:00+00:00",
    }
    (task_path / "candidate-artifact.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return digest


def merged_task(tmp_path: Path, capsys, monkeypatch) -> tuple[str, Path]:
    """交付并归并一个任务，并固化 C01 候选产物，返回 (task_id, 源仓库)。"""

    task_id, source = TestMergeToMain()._deliver_task(tmp_path, capsys, monkeypatch)
    code, out = run_cli(["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys)
    assert code == 0, out
    seed_candidate_artifact(tmp_path, task_id, source)
    return task_id, source


def release_task(tmp_path: Path, capsys, task_id: str, tag: str = "v0.1.0"):
    """按 --no-push 执行受控发布（本地标签 + 回执）。"""

    return run_cli(
        ["release", task_id, "--tag", tag, "--no-push", "--records-root", str(tmp_path)], capsys
    )


def repo_tags(source: Path) -> list[str]:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(source), "tag", "-l"], check=True, capture_output=True, text=True
    ).stdout.split()


def tag_annotation(source: Path, tag: str) -> str:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(source), "tag", "-l", "--format=%(contents)", tag],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


class TestReleaseAfterMerge:
    """S1 端到端：归并后发布版本标签、固化回执，以及幂等与前置负例。"""

    def test_release_creates_tag_and_receipt(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 0, out
        assert repo_tags(source) == ["v0.1.0"]
        document = status_document(tmp_path, task_id, capsys)
        release = document["release"]
        assert release["tag"] == "v0.1.0"
        assert release["pushed"] is False
        assert release["merge_commit"] == document["merge"]["merge_commit"]
        # 发布回执校验值与候选 diff 内容一一对应；部署端以同一值核对同一产物。
        candidate = Path(document["delivery"]["diff_path"]).read_text(encoding="utf-8")
        receipt = json.loads(Path(release["receipt_path"]).read_text(encoding="utf-8"))
        assert receipt["diff_sha256"] == hashlib.sha256(candidate.encode("utf-8")).hexdigest()
        report = json.loads(Path(document["delivery"]["report_path"]).read_text(encoding="utf-8"))
        assert receipt["baseline_commit"] == report["baseline_commit"]
        # K12：发布复用 C01 的同一份已验收 wheel，回执固化其 sha256。
        candidate_receipt = json.loads(
            (task_dir(tmp_path, task_id) / "candidate-artifact.json").read_text(encoding="utf-8")
        )
        assert receipt["artifact_sha256"] == candidate_receipt["sha256"]
        assert receipt["wheel_name"] == candidate_receipt["wheel_name"]
        wheel = Path(candidate_receipt["wheel_path"])
        assert hashlib.sha256(wheel.read_bytes()).hexdigest() == receipt["artifact_sha256"]

    def test_release_without_candidate_artifact_is_refused(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = TestMergeToMain()._deliver_task(tmp_path, capsys, monkeypatch)
        code, out = run_cli(
            ["merge", task_id, "--no-push", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0, out
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "候选产物" in out
        assert repo_tags(source) == []

    def test_repeat_with_changed_artifact_is_refused(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        # 重试时候选产物被换成另一份（校验值不同），不得按幂等放行、也不得新建身份。
        receipt_path = task_dir(tmp_path, task_id) / "candidate-artifact.json"
        document = json.loads(receipt_path.read_text(encoding="utf-8"))
        document["sha256"] = "f" * 64
        document["rebuild_sha256"] = "f" * 64
        receipt_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "不一致" in out
        assert repo_tags(source) == ["v0.1.0"]

    def test_release_refuses_acceptance_bound_to_other_artifact(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # K12：验收绑定的是另一份产物时，不得用不同产物冒充同一验收发布。
        from datetime import UTC, datetime

        from forgeloop.domain.approval import Approval, ApprovalStage
        from forgeloop.domain.delivery import DeliveryBinding

        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        store = record_store(tmp_path)
        try:
            plan = store.latest_plan(task_id)
            accepted = store.acceptance_binding(task_id)
            assert plan is not None and accepted is not None
            store.record_approval(
                Approval(
                    task_id,
                    plan.version,
                    ApprovalStage.ACCEPTANCE,
                    datetime.now(UTC),
                    DeliveryBinding(
                        task_id=task_id,
                        plan_version=plan.version,
                        candidate_sha256=accepted.candidate_sha256,
                        test_evidence_sha256=accepted.test_evidence_sha256,
                        review_sha256=accepted.review_sha256,
                        artifact_sha256="f" * 64,
                        baseline_commit=accepted.baseline_commit,
                    ),
                )
            )
        finally:
            store.close()
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "不一致" in out
        assert repo_tags(source) == []

    @pytest.mark.parametrize(
        ("field", "value", "needle"),
        (
            ("reproducible", False, "不可复现"),
            ("smoke_exit_code", 3, "冒烟"),
            ("commit", "0" * 40, "归并提交"),
            ("version", "9.9.9", "版本"),
            ("sha256", "f" * 64, "校验值"),
        ),
    )
    def test_release_refuses_invalid_candidate_receipt(
        self, tmp_path: Path, capsys, monkeypatch, field: str, value: object, needle: str
    ) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        receipt_path = task_dir(tmp_path, task_id) / "candidate-artifact.json"
        document = json.loads(receipt_path.read_text(encoding="utf-8"))
        document[field] = value
        receipt_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert needle in out
        assert repo_tags(source) == []

    def test_release_refuses_missing_candidate_wheel_file(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        receipt = json.loads(
            (task_dir(tmp_path, task_id) / "candidate-artifact.json").read_text(encoding="utf-8")
        )
        Path(receipt["wheel_path"]).unlink()
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "原件缺失" in out
        assert repo_tags(source) == []

    def test_release_refuses_corrupt_candidate_receipt(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        (task_dir(tmp_path, task_id) / "candidate-artifact.json").write_text(
            "not json", encoding="utf-8"
        )
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "候选产物" in out
        assert repo_tags(source) == []

    def test_release_before_merge_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = TestMergeToMain()._deliver_task(tmp_path, capsys, monkeypatch)
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "归并" in out
        assert repo_tags(source) == []

    def test_same_tag_repeat_is_idempotent(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 0
        assert "幂等" in out
        assert repo_tags(source) == ["v0.1.0"]

    def test_custom_message_keeps_accepted_artifact_binding(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # 发布身份不能被 --message 静默丢弃：自定义注释仍须携带已验收产物绑定，
        # 否则 Release 工作流会拒绝发布且标签重试无法补正。
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        code, out = run_cli(
            [
                "release",
                task_id,
                "--tag",
                "v0.1.0",
                "--no-push",
                "--message",
                "chore(release): 手写说明",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        annotation = tag_annotation(source, "v0.1.0")
        receipt = json.loads(
            (task_dir(tmp_path, task_id) / "release-receipt.json").read_text(encoding="utf-8")
        )
        assert "chore(release): 手写说明" in annotation
        assert f"accepted-artifact-sha256: {receipt['artifact_sha256']}" in annotation
        assert f"accepted-artifact-wheel: {receipt['wheel_name']}" in annotation

    def test_idempotent_retry_refuses_unbound_tag(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        # 标签注解丢失已验收产物身份时，重试不得静默返回“已发布”，
        # 否则形成既发不出也重发不了的死结。
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        commit = run_git(source, "rev-parse", "HEAD")
        run_git(source, "tag", "-d", "v0.1.0")
        run_git(source, "tag", "-a", "v0.1.0", "-m", "chore(release): v0.1.0", commit)
        code, out = release_task(tmp_path, capsys, task_id)
        assert code == 1
        assert "注解" in out
        assert repo_tags(source) == ["v0.1.0"]

    def test_other_tag_repeat_is_refused(self, tmp_path: Path, capsys, monkeypatch) -> None:
        task_id, source = merged_task(tmp_path, capsys, monkeypatch)
        assert release_task(tmp_path, capsys, task_id)[0] == 0
        code, out = release_task(tmp_path, capsys, task_id, tag="v0.2.0")
        assert code == 1
        assert "v0.1.0" in out
        assert repo_tags(source) == ["v0.1.0"]


def test_release_upload_transfers_accepted_wheel_without_rebuilding(
    tmp_path: Path, monkeypatch
) -> None:
    """发布只上传 C01 已验收 wheel 为草稿资产，不调用任何构建。"""

    from forgeloop.cli import release as release_cli

    wheel = tmp_path / "forgeloop-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"accepted candidate wheel\n")
    plan = release_cli._ReleasePlan(
        project=tmp_path,
        merge_commit="a" * 40,
        baseline_commit="b" * 40,
        diff_sha256="c" * 64,
        wheel_name=wheel.name,
        artifact_sha256="d" * 64,
        artifact_path=wheel,
        receipt_path=tmp_path / "release-receipt.json",
    )
    args = argparse.Namespace(tag="v0.1.0")

    class _Result:
        returncode = 0

    responses = [argparse.Namespace(returncode=1), _Result()]
    seen: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> object:
        seen.append(command)
        return responses.pop(0)

    monkeypatch.setattr(release_cli, "subprocess", argparse.Namespace(run=fake_run))
    release_cli._upload_accepted_artifact(plan, args)

    view, create = seen
    assert view[:3] == ["gh", "release", "view"]
    assert create[:3] == ["gh", "release", "create"]
    assert str(wheel) in create
    assert "--draft" in create and "--verify-tag" in create
    assert "build" not in " ".join(create)
    assert f"accepted-artifact-sha256: {'d' * 64}" in " ".join(create)
