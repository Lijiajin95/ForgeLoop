"""S4 场景：候选产物构建与验证。

覆盖验收要求：真实构建产生产物与校验值；独立安装后冒烟通过；重复构建校验值一致；
未授权提交被拒。测试项目是真实 git 仓库 + 真实可安装 wheel，构建走真实 ``uv build``
（hatchling），安装走真实 venv；不访问外网（构建依赖取 uv 缓存，产物无运行时依赖）。
"""

import hashlib
import json
from dataclasses import replace
from pathlib import Path

from project_support import project_records, record_store, register_project
from support import run_cli, run_git

from forgeloop.cli import candidate as candidate_cli
from forgeloop.domain import artifact as artifact_domain

TASK_ID = "task-cand"

PYPROJECT = """[build-system]
requires = ["hatchling>=1.27,<2"]
build-backend = "hatchling.build"

[project]
name = "forgeloop"
version = "{version}"
description = "candidate artifact test project"
requires-python = ">=3.13"

[project.scripts]
forgeloop = "forgeloop_candidate:main"

[tool.hatch.build.targets.wheel]
packages = ["src/forgeloop_candidate"]
"""

CLI_MODULE = '''"""测试用候选 CLI。"""

import sys


def main() -> int:
    print("candidate forgeloop help" if "--help" in sys.argv else "candidate forgeloop")
    return 0
'''


def make_candidate_project(tmp_path: Path, version: str = "0.0.1") -> Path:
    """真实 git 项目：单提交、pyproject 名称/版本/入口与候选产物身份一致。"""

    project = tmp_path / "project"
    package = project / "src" / "forgeloop_candidate"
    package.mkdir(parents=True)
    (project / "pyproject.toml").write_text(PYPROJECT.format(version=version), encoding="utf-8")
    (package / "__init__.py").write_text(CLI_MODULE, encoding="utf-8")
    run_git(project, "init", "-b", "main")
    run_git(project, "add", "-A")
    run_git(project, "commit", "-m", "chore: candidate baseline")
    return project


def seed_task(records: Path, project: Path, commit: str, merged: bool = True) -> None:
    """写入任务与（可选的）归并记录，作为候选构建的授权来源。"""

    register_project(records, repo_path=str(project))
    store = record_store(records)
    try:
        store.create_task(
            TASK_ID,
            "forgeloop",
            "候选产物任务",
            {"project_path": str(project), "test_command": "[]", "pi_command": "[]"},
            7200.0,
        )
        if merged:
            store.outcomes.record_merge(TASK_ID, commit, True, "pushed")
            store.set_task_status(TASK_ID, "merged")
    finally:
        store.close()


def candidate(records: Path, capsys, **flags) -> tuple[int, str]:
    argv = ["candidate", TASK_ID, "--records-root", str(records)]
    for flag, value in flags.items():
        argv.extend([f"--{flag.replace('_', '-')}", str(value)])
    return run_cli(argv, capsys)


def sha256_of_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_receipt(records: Path) -> dict:
    return json.loads(
        (project_records(records) / TASK_ID / "candidate-artifact.json").read_text(encoding="utf-8")
    )


class TestCandidateBuildScenario:
    def test_real_build_retains_artifact_and_smokes(self, tmp_path: Path, capsys) -> None:
        project = make_candidate_project(tmp_path)
        commit = run_git(project, "rev-parse", "HEAD")
        records = tmp_path / "records"
        seed_task(records, project, commit)

        code, out = candidate(records, capsys)

        assert code == 0, out
        assert "已构建候选产物: forgeloop-0.0.1-py3-none-any.whl" in out
        assert "重复构建: 两次独立构建校验值一致" in out
        assert "独立环境冒烟: 通过" in out
        receipt = read_receipt(records)
        assert receipt["task_id"] == TASK_ID
        assert receipt["commit"] == commit
        assert receipt["version"] == "0.0.1"
        assert receipt["sha256"] == receipt["rebuild_sha256"]
        assert receipt["reproducible"] is True
        assert receipt["smoke_exit_code"] == 0
        wheel = Path(receipt["wheel_path"])
        assert wheel.is_file()
        assert sha256_of_file(wheel) == receipt["sha256"]
        assert wheel.parent == project_records(records) / TASK_ID / "artifacts"

    def test_unauthorized_commit_is_refused(self, tmp_path: Path, capsys) -> None:
        project = make_candidate_project(tmp_path)
        commit = run_git(project, "rev-parse", "HEAD")
        records = tmp_path / "records"
        seed_task(records, project, commit)

        code, out = candidate(records, capsys, commit="b" * 40)

        assert code == 1, out
        assert "未授权提交" in out
        assert not (project_records(records) / TASK_ID / "candidate-artifact.json").exists()

    def test_unmerged_task_is_refused(self, tmp_path: Path, capsys) -> None:
        project = make_candidate_project(tmp_path)
        commit = run_git(project, "rev-parse", "HEAD")
        records = tmp_path / "records"
        seed_task(records, project, commit, merged=False)

        code, out = candidate(records, capsys)

        assert code == 1, out
        assert "归并" in out
        assert not (project_records(records) / TASK_ID / "candidate-artifact.json").exists()

    def test_repeated_build_difference_is_reported(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        project = make_candidate_project(tmp_path)
        commit = run_git(project, "rev-parse", "HEAD")
        records = tmp_path / "records"
        seed_task(records, project, commit)

        real_build = candidate_cli.build_candidate
        calls = {"count": 0}

        def differing_build(project_path: Path, commit_sha: str, output_dir: Path):
            result = real_build(project_path, commit_sha, output_dir)
            calls["count"] += 1
            if calls["count"] == 2:
                return replace(result, sha256="f" * 64)
            return result

        monkeypatch.setattr(candidate_cli, "build_candidate", differing_build)

        code, out = candidate(records, capsys)

        assert code == 1, out
        assert "不一致" in out
        assert "未执行" in out  # 不可复现产物不安装
        receipt = read_receipt(records)
        assert receipt["reproducible"] is False
        assert receipt["sha256"] != receipt["rebuild_sha256"]
        assert receipt["smoke_exit_code"] == -1


class TestArtifactDomainRules:
    def test_commit_authorization(self) -> None:
        assert artifact_domain.check_commit_authorization(TASK_ID, "a" * 40, "a" * 40).allowed
        assert not artifact_domain.check_commit_authorization(TASK_ID, "b" * 40, "a" * 40).allowed
        assert not artifact_domain.check_commit_authorization(TASK_ID, "a" * 40, "").allowed
        assert not artifact_domain.check_commit_authorization(TASK_ID, "bad", "bad").allowed

    def test_identity_requires_matching_version(self) -> None:
        name = "forgeloop-0.0.1-py3-none-any.whl"
        assert artifact_domain.check_artifact_identity("0.0.1", name).allowed
        assert not artifact_domain.check_artifact_identity("0.0.2", name).allowed
        assert not artifact_domain.check_artifact_identity("0.0.1", "other-0.0.1.whl").allowed

    def test_compare_builds(self) -> None:
        digest = "a" * 64
        assert artifact_domain.compare_builds(digest, digest).consistent
        assert not artifact_domain.compare_builds(digest, "b" * 64).consistent
        assert not artifact_domain.compare_builds("bad", digest).consistent
