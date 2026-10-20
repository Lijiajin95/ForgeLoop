"""``project`` 命令组与跨项目隔离的组件测试。

真实登记库、真实 git 仓库与真实 CLI 入口：验证 ``project add|list|show|update``
的稳定 JSON 结构、未知项目拒绝，以及两个项目下需求/任务记录与状态查询互不混用。
"""

import json
import sys
from pathlib import Path

import pytest
from project_support import ensure_project_repo, project_records, record_store, requirement_store

from forgeloop.cli.main import main as cli_main

pytestmark = pytest.mark.component

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = (sys.executable, str(FIXTURES / "fake_pi.py"))
PASSING_TEST = (sys.executable, "-c", "print('ok')")


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def add_project(tmp_path: Path, capsys, project_id: str, name: str = "Demo") -> Path:
    repo = ensure_project_repo(tmp_path / f"{project_id}-repo")
    code, out = run_cli(
        [
            "project",
            "add",
            project_id,
            "--name",
            name,
            "--path",
            str(repo),
            "--records-root",
            str(tmp_path),
        ],
        capsys,
    )
    assert code == 0, out
    return repo


class TestProjectCommands:
    def test_add_creates_project_root_and_mirror(self, tmp_path: Path, capsys) -> None:
        repo = add_project(tmp_path, capsys, "demo")

        root = project_records(tmp_path, "demo")
        assert (root / "repo.git").is_dir()
        assert (root / "repo.git" / "HEAD").is_file()

        code, out = run_cli(
            ["project", "show", "demo", "--json", "--records-root", str(tmp_path)], capsys
        )
        assert code == 0
        document = json.loads(out)
        assert document["project_id"] == "demo"
        assert document["name"] == "Demo"
        assert document["repo_path"] == str(repo)
        assert document["records_root"] == str(root)
        assert document["requirements"] == 0
        assert document["tasks"] == 0

    def test_list_reports_counts_and_unknown_project_is_refused(
        self, tmp_path: Path, capsys
    ) -> None:
        add_project(tmp_path, capsys, "demo")
        store = record_store(tmp_path, "demo")
        try:
            store.create_task("task-1", "demo", "输入", {}, 60.0)
        finally:
            store.close()

        code, out = run_cli(["project", "list", "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["count"] == 1
        assert document["projects"][0]["project_id"] == "demo"
        assert document["projects"][0]["tasks"] == 1

        code, out = run_cli(
            ["project", "show", "missing", "--json", "--records-root", str(tmp_path)], capsys
        )
        assert code == 1
        assert "项目未登记" in out

    def test_duplicate_identity_and_invalid_path_are_refused(self, tmp_path: Path, capsys) -> None:
        add_project(tmp_path, capsys, "demo")
        code, out = run_cli(
            [
                "project",
                "add",
                "demo",
                "--name",
                "Again",
                "--path",
                str(tmp_path / "demo-repo"),
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "已登记" in out

        plain = tmp_path / "plain"
        plain.mkdir()
        code, out = run_cli(
            [
                "project",
                "add",
                "other",
                "--name",
                "Other",
                "--path",
                str(plain),
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "不是 git 仓库" in out

    def test_update_changes_display_fields_only(self, tmp_path: Path, capsys) -> None:
        add_project(tmp_path, capsys, "demo")
        code, out = run_cli(
            [
                "project",
                "update",
                "demo",
                "--name",
                "Demo 2",
                "--default-branch",
                "main",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        code, out = run_cli(
            ["project", "show", "demo", "--json", "--records-root", str(tmp_path)], capsys
        )
        document = json.loads(out)
        assert document["name"] == "Demo 2"
        assert document["default_branch"] == "main"


class TestCrossProjectIsolation:
    def test_records_and_status_are_isolated_between_projects(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FAKE_PI_MODE", "ok")
        add_project(tmp_path, capsys, "alpha", name="Alpha")
        add_project(tmp_path, capsys, "beta", name="Beta")

        def submit(project_id: str, text: str) -> str:
            code, out = run_cli(
                [
                    "submit",
                    "--project",
                    project_id,
                    "--input",
                    text,
                    "--test-command",
                    json.dumps(list(PASSING_TEST)),
                    "--pi-command",
                    json.dumps(list(FAKE_PI)),
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )
            assert code == 0, out
            return out.split("任务已创建: ")[1].splitlines()[0].strip()

        alpha_task = submit("alpha", "alpha 任务")
        beta_task = submit("beta", "beta 任务")

        # 每个项目的记录库只包含自己的任务与需求。
        alpha_records = record_store(tmp_path, "alpha")
        beta_records = record_store(tmp_path, "beta")
        try:
            assert alpha_records.get_task(alpha_task) is not None
            assert alpha_records.get_task(beta_task) is None
            assert beta_records.get_task(beta_task) is not None
            assert beta_records.get_task(alpha_task) is None
        finally:
            alpha_records.close()
            beta_records.close()

        # 任务身份全局唯一定位：状态查询按各自项目返回。
        for task_id, project_id in ((alpha_task, "alpha"), (beta_task, "beta")):
            code, out = run_cli(
                ["status", task_id, "--json", "--records-root", str(tmp_path)], capsys
            )
            assert code == 0, out
            assert json.loads(out)["project"] == project_id

    def test_requirement_records_do_not_mix_between_projects(self, tmp_path: Path, capsys) -> None:
        add_project(tmp_path, capsys, "alpha", name="Alpha")
        add_project(tmp_path, capsys, "beta", name="Beta")
        alpha_store = requirement_store(tmp_path, "alpha")
        beta_store = requirement_store(tmp_path, "beta")
        try:
            alpha_req = alpha_store.submit("alpha", "alpha 需求").req_id
            beta_req = beta_store.submit("beta", "beta 需求").req_id
            assert [item.req_id for item in alpha_store.all_requirements()] == [alpha_req]
            assert [item.req_id for item in beta_store.all_requirements()] == [beta_req]
        finally:
            alpha_store.close()
            beta_store.close()

        code, out = run_cli(
            ["requirement", "status", alpha_req, "--json", "--records-root", str(tmp_path)],
            capsys,
        )
        assert code == 0, out
        assert json.loads(out)["project"] == "alpha"

    def test_submit_requires_registered_project(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit, match="项目未登记"):
            cli_main(
                [
                    "submit",
                    "--project",
                    "ghost",
                    "--input",
                    "x",
                    "--test-command",
                    json.dumps(list(PASSING_TEST)),
                    "--pi-command",
                    json.dumps(list(FAKE_PI)),
                    "--records-root",
                    str(tmp_path),
                ]
            )
