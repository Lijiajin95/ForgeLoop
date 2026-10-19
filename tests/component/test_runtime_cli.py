"""``forgeloop runtime`` 命令组件测试：按项目隔离的热切换入口、审计与稳定 JSON 文档。

运行状态与需求、任务、会话一样落在**项目记录根**（`<records-root>/projects/<id>/`）：
命令必填 `--project`，切换只影响该项目后续启动的动作。
"""

import json
from pathlib import Path

import pytest
from project_support import project_records, register_project

from forgeloop.cli.main import main as cli_main
from forgeloop.records.agent_runtimes import AgentRuntimeStore

PROJECT = "forgeloop"
FAKE_DSH_COMMAND = ["/usr/local/bin/dsh", "--profile", "headless", "--json"]


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def runtime_argv(base: Path, *args: str, project: str = PROJECT) -> list[str]:
    return ["runtime", *args, "--project", project, "--records-root", str(base)]


def open_runtime(base: Path, project: str = PROJECT) -> AgentRuntimeStore:
    return AgentRuntimeStore(project_records(base, project) / "records.sqlite")


class TestRuntimeShow:
    def test_fresh_project_reports_default_and_no_selection(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(runtime_argv(tmp_path, "show"), capsys)
        assert code == 0
        assert f"项目: {PROJECT}" in out
        assert "未显式设置（默认 pi）" in out
        assert "不可解析" in out  # 没有 pi 命令，也没有运行状态：如实报告

    def test_json_document_shape(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(runtime_argv(tmp_path, "show", "--json"), capsys)
        assert code == 0
        document = json.loads(out)
        assert document["project"] == PROJECT
        assert document["active"] is None
        assert document["effective"] is None
        assert document["effective_error"]
        assert document["environment"] == {"runtime_override": "", "dsh_command": []}
        assert document["history"] == []

    def test_missing_project_is_rejected_by_parser(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit):
            run_cli(["runtime", "show", "--records-root", str(tmp_path)], capsys)


class TestRuntimeSet:
    def test_switch_to_dsh_uses_documented_default_command(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(
            runtime_argv(tmp_path, "set", "dsh", "--by", "owner", "--reason", "对比 DSH"),
            capsys,
        )
        assert code == 0, out
        assert "已切换" in out
        store = open_runtime(tmp_path)
        try:
            current = store.current()
            assert current is not None
            assert current.runtime == "dsh"
            assert current.command == ("dsh", "--profile", "headless", "--json")
        finally:
            store.close()

    def test_explicit_command_is_persisted(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(
            runtime_argv(
                tmp_path,
                "set",
                "dsh",
                "--command",
                json.dumps(FAKE_DSH_COMMAND),
                "--by",
                "owner",
                "--reason",
                "使用本机安装路径",
            ),
            capsys,
        )
        assert code == 0, out
        store = open_runtime(tmp_path)
        try:
            current = store.current()
            assert current is not None and current.command == tuple(FAKE_DSH_COMMAND)
        finally:
            store.close()

    def test_switch_back_to_pi_keeps_command_empty(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        run_cli(runtime_argv(tmp_path, "set", "pi", "--by", "owner", "--reason", "回到 PI"), capsys)
        store = open_runtime(tmp_path)
        try:
            current = store.current()
            assert current is not None and current.runtime == "pi" and current.command == ()
        finally:
            store.close()

    def test_invalid_command_json_fails_without_side_effect(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(
            runtime_argv(
                tmp_path, "set", "dsh", "--command", "not-json", "--by", "owner", "--reason", "x"
            ),
            capsys,
        )
        assert code == 1
        assert "FAIL" in out
        store = open_runtime(tmp_path)
        try:
            assert store.current() is None
            assert store.history() == ()
        finally:
            store.close()

    def test_unknown_runtime_is_rejected_by_parser(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        with pytest.raises(SystemExit):
            run_cli(
                runtime_argv(tmp_path, "set", "codex", "--by", "owner", "--reason", "x"), capsys
            )

    def test_missing_operator_is_rejected_by_parser(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        with pytest.raises(SystemExit):
            run_cli(runtime_argv(tmp_path, "set", "dsh", "--reason", "x"), capsys)


class TestProjectIsolation:
    def test_switch_in_one_project_does_not_affect_another(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path, "alpha", name="Alpha")
        register_project(tmp_path, "beta", name="Beta")
        code, out = run_cli(
            runtime_argv(
                tmp_path, "set", "dsh", "--by", "owner", "--reason", "只切 alpha", project="alpha"
            ),
            capsys,
        )
        assert code == 0, out
        alpha = open_runtime(tmp_path, "alpha")
        beta = open_runtime(tmp_path, "beta")
        try:
            current = alpha.current()
            assert current is not None and current.runtime == "dsh"
            assert beta.current() is None
        finally:
            alpha.close()
            beta.close()


class TestRuntimeShowAfterSwitch:
    def test_effective_runtime_follows_state_and_keeps_history(
        self, tmp_path: Path, capsys
    ) -> None:
        register_project(tmp_path)
        run_cli(runtime_argv(tmp_path, "set", "pi", "--by", "owner", "--reason", "初始"), capsys)
        run_cli(
            runtime_argv(
                tmp_path,
                "set",
                "dsh",
                "--command",
                json.dumps(FAKE_DSH_COMMAND),
                "--by",
                "owner",
                "--reason",
                "切到 DSH",
            ),
            capsys,
        )
        code, out = run_cli(runtime_argv(tmp_path, "show", "--json"), capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"]["runtime"] == "dsh"
        assert document["effective"]["runtime"] == "dsh"
        assert document["effective"]["command"] == FAKE_DSH_COMMAND
        assert document["effective"]["runtime_source"] == "state"
        assert [item["to_runtime"] for item in document["history"]] == ["dsh", "pi"]
        assert document["history"][0]["switched_by"] == "owner"

    def test_list_prints_history(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        run_cli(runtime_argv(tmp_path, "set", "pi", "--by", "owner", "--reason", "初始"), capsys)
        code, out = run_cli(runtime_argv(tmp_path, "list"), capsys)
        assert code == 0
        assert "（未设置） → pi" in out
        assert "初始" in out

    def test_list_on_fresh_project_is_empty(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        code, out = run_cli(runtime_argv(tmp_path, "list"), capsys)
        assert code == 0
        assert "没有 Agent Runtime 切换记录" in out


class TestEnvironmentOverride:
    def test_environment_override_is_reported_in_effective(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        register_project(tmp_path)
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "dsh")
        monkeypatch.setenv("FORGELOOP_DSH_COMMAND", json.dumps(FAKE_DSH_COMMAND))
        code, out = run_cli(runtime_argv(tmp_path, "show", "--json"), capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"] is None
        assert document["effective"]["runtime"] == "dsh"
        assert document["effective"]["runtime_source"] == "environment"
        assert document["effective"]["command"] == FAKE_DSH_COMMAND

    def test_invalid_environment_override_fails_closed(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        register_project(tmp_path)
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "codex")
        code, out = run_cli(runtime_argv(tmp_path, "show"), capsys)
        assert code == 1
        assert "FAIL" in out


def test_runtime_subcommands_are_registered() -> None:
    from forgeloop.cli.main import build_parser
    from forgeloop.cli.runtime import cmd_runtime_list, cmd_runtime_set, cmd_runtime_show

    parser = build_parser()
    assert parser.parse_args(["runtime", "show", "--project", "p"]).func is cmd_runtime_show
    assert (
        parser.parse_args(
            ["runtime", "set", "dsh", "--project", "p", "--by", "o", "--reason", "r"]
        ).func
        is cmd_runtime_set
    )
    assert parser.parse_args(["runtime", "list", "--project", "p"]).func is cmd_runtime_list


class TestRuntimeTextOutput:
    """文本输出（非 --json）的三个分支：有状态、生效解析、进程环境覆盖。"""

    def test_show_text_after_switch_prints_command_and_environment(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        register_project(tmp_path)
        run_cli(
            runtime_argv(
                tmp_path,
                "set",
                "dsh",
                "--command",
                json.dumps(FAKE_DSH_COMMAND),
                "--by",
                "owner",
                "--reason",
                "切到 DSH",
            ),
            capsys,
        )
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "dsh")
        monkeypatch.setenv("FORGELOOP_DSH_COMMAND", json.dumps(FAKE_DSH_COMMAND))

        code, out = run_cli(runtime_argv(tmp_path, "show"), capsys)

        assert code == 0
        assert "当前 Agent Runtime: dsh" in out
        assert "生效命令:" in out
        assert "进程环境覆盖:" in out
        assert "runtime_override" not in out  # 文本输出不是 JSON

    def test_list_json_document_contains_history(self, tmp_path: Path, capsys) -> None:
        register_project(tmp_path)
        run_cli(runtime_argv(tmp_path, "set", "pi", "--by", "owner", "--reason", "初始"), capsys)

        code, out = run_cli(runtime_argv(tmp_path, "list", "--json"), capsys)

        assert code == 0
        history = json.loads(out)["history"]
        assert history and history[0]["to_runtime"] == "pi"
