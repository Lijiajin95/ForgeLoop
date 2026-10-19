"""``forgeloop runtime`` 命令组件测试：热切换入口、审计与稳定 JSON 文档。

这些用例从真实命令入口驱动（argparse → cmd_* → records.sqlite），不经过内部函数，
以便钉住对外行为：谁切、切到哪、命令是什么、失败时是否零副作用。
"""

import json
from pathlib import Path

import pytest

from forgeloop.cli.main import main as cli_main
from forgeloop.records.agent_runtimes import AgentRuntimeStore

FAKE_DSH_COMMAND = ["/usr/local/bin/dsh", "--profile", "headless", "--json"]


def run_cli(argv: list[str], capsys) -> tuple[int, str]:
    code = cli_main(argv)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


class TestRuntimeShow:
    def test_fresh_root_reports_default_and_no_selection(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(["runtime", "show", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "未显式设置（默认 pi）" in out
        assert "不可解析" in out  # 没有 pi 命令，也没有运行状态：如实报告

    def test_json_document_shape(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(["runtime", "show", "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"] is None
        assert document["effective"] is None
        assert document["effective_error"]
        assert document["environment"] == {"runtime_override": "", "dsh_command": []}
        assert document["history"] == []


class TestRuntimeSet:
    def test_switch_to_dsh_uses_documented_default_command(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            [
                "runtime",
                "set",
                "dsh",
                "--by",
                "owner",
                "--reason",
                "对比 DSH 执行质量",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        assert "已切换" in out
        store = AgentRuntimeStore(tmp_path / "records.sqlite")
        try:
            current = store.current()
            assert current is not None
            assert current.runtime == "dsh"
            assert current.command == ("dsh", "--profile", "headless", "--json")
        finally:
            store.close()

    def test_explicit_command_is_persisted(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            [
                "runtime",
                "set",
                "dsh",
                "--command",
                json.dumps(FAKE_DSH_COMMAND),
                "--by",
                "owner",
                "--reason",
                "使用本机安装路径",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        store = AgentRuntimeStore(tmp_path / "records.sqlite")
        try:
            current = store.current()
            assert current is not None and current.command == tuple(FAKE_DSH_COMMAND)
        finally:
            store.close()

    def test_switch_back_to_pi_keeps_command_empty(self, tmp_path: Path, capsys) -> None:
        run_cli(
            [
                "runtime",
                "set",
                "pi",
                "--by",
                "owner",
                "--reason",
                "回到 PI",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        store = AgentRuntimeStore(tmp_path / "records.sqlite")
        try:
            current = store.current()
            assert current is not None and current.runtime == "pi" and current.command == ()
        finally:
            store.close()

    def test_invalid_command_json_fails_without_side_effect(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            [
                "runtime",
                "set",
                "dsh",
                "--command",
                "not-json",
                "--by",
                "owner",
                "--reason",
                "x",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1
        assert "FAIL" in out
        store = AgentRuntimeStore(tmp_path / "records.sqlite")
        try:
            assert store.current() is None
            assert store.history() == ()
        finally:
            store.close()

    def test_unknown_runtime_is_rejected_by_parser(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit):
            run_cli(
                [
                    "runtime",
                    "set",
                    "codex",
                    "--by",
                    "owner",
                    "--reason",
                    "x",
                    "--records-root",
                    str(tmp_path),
                ],
                capsys,
            )

    def test_missing_operator_is_rejected_by_parser(self, tmp_path: Path, capsys) -> None:
        with pytest.raises(SystemExit):
            run_cli(
                ["runtime", "set", "dsh", "--reason", "x", "--records-root", str(tmp_path)],
                capsys,
            )


class TestRuntimeShowAfterSwitch:
    def test_effective_runtime_follows_state_and_keeps_history(
        self, tmp_path: Path, capsys
    ) -> None:
        run_cli(
            [
                "runtime",
                "set",
                "pi",
                "--by",
                "owner",
                "--reason",
                "初始",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        run_cli(
            [
                "runtime",
                "set",
                "dsh",
                "--command",
                json.dumps(FAKE_DSH_COMMAND),
                "--by",
                "owner",
                "--reason",
                "切到 DSH",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        code, out = run_cli(["runtime", "show", "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"]["runtime"] == "dsh"
        assert document["effective"]["runtime"] == "dsh"
        assert document["effective"]["command"] == FAKE_DSH_COMMAND
        assert document["effective"]["runtime_source"] == "state"
        assert [item["to_runtime"] for item in document["history"]] == ["dsh", "pi"]
        assert document["history"][0]["switched_by"] == "owner"
        assert document["history"][0]["reason"] == "切到 DSH"

    def test_list_prints_history(self, tmp_path: Path, capsys) -> None:
        run_cli(
            [
                "runtime",
                "set",
                "pi",
                "--by",
                "owner",
                "--reason",
                "初始",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        code, out = run_cli(["runtime", "list", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "（未设置） → pi" in out
        assert "初始" in out

    def test_list_on_fresh_root_is_empty(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(["runtime", "list", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        assert "没有 Agent Runtime 切换记录" in out


class TestEnvironmentOverride:
    def test_environment_override_is_reported_in_effective(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "dsh")
        monkeypatch.setenv("FORGELOOP_DSH_COMMAND", json.dumps(FAKE_DSH_COMMAND))
        code, out = run_cli(["runtime", "show", "--json", "--records-root", str(tmp_path)], capsys)
        assert code == 0
        document = json.loads(out)
        assert document["active"] is None
        assert document["effective"]["runtime"] == "dsh"
        assert document["effective"]["runtime_source"] == "environment"
        assert document["effective"]["command"] == FAKE_DSH_COMMAND

    def test_invalid_environment_override_fails_closed(
        self, tmp_path: Path, capsys, monkeypatch
    ) -> None:
        monkeypatch.setenv("FORGELOOP_AGENT_RUNTIME", "codex")
        code, out = run_cli(["runtime", "show", "--records-root", str(tmp_path)], capsys)
        assert code == 1
        assert "FAIL" in out


def test_runtime_subcommands_are_registered() -> None:
    from forgeloop.cli.main import build_parser
    from forgeloop.cli.runtime import cmd_runtime_list, cmd_runtime_set, cmd_runtime_show

    parser = build_parser()
    assert parser.parse_args(["runtime", "show"]).func is cmd_runtime_show
    assert parser.parse_args(["runtime", "set", "dsh", "--by", "o", "--reason", "r"]).func is (
        cmd_runtime_set
    )
    assert parser.parse_args(["runtime", "list"]).func is cmd_runtime_list
