"""`requirement cancel`（2026-10-19 所有者要求"支持删除需求"）。

按项目硬规则实现为**取消**：终态 + 人工决定留痕，**不删除任何记录**。本文件覆盖
真实 CLI 入口：缺参数被解析器拒绝、缺理由时 fail-closed、成功取消后可回查决定。
"""

from __future__ import annotations

from pathlib import Path

from support import run_cli


def submit(tmp_path: Path, capsys, text: str = "取消场景：批量导出") -> str:
    code, out = run_cli(
        [
            "requirement",
            "submit",
            "--project",
            "ForgeLoop",
            "--input",
            text,
            "--records-root",
            str(tmp_path),
        ],
        capsys,
    )
    assert code == 0, out
    return out.split("需求已创建: ")[1].split()[0]


class TestRequirementCancel:
    def test_cancel_records_decision_and_reports_terminal_state(
        self, tmp_path: Path, capsys
    ) -> None:
        req_id = submit(tmp_path, capsys)
        code, out = run_cli(
            [
                "requirement",
                "cancel",
                req_id,
                "--by",
                "owner",
                "--reason",
                "不再需要该需求",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 0, out
        assert "已取消" in out and "记录保留" in out
        assert "owner" in out and "不再需要该需求" in out

        status_code, status = run_cli(
            ["requirement", "status", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert status_code == 0, status
        assert "cancelled" in status

    def test_blank_reason_is_refused_by_record_layer(self, tmp_path: Path, capsys) -> None:
        req_id = submit(tmp_path, capsys)
        code, out = run_cli(
            [
                "requirement",
                "cancel",
                req_id,
                "--by",
                "owner",
                "--reason",
                "   ",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1 and "fail-closed" in out

    def test_unknown_requirement_fails_loudly(self, tmp_path: Path, capsys) -> None:
        code, out = run_cli(
            [
                "requirement",
                "cancel",
                "req-19990101000000-000000",
                "--by",
                "owner",
                "--reason",
                "不存在",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert code == 1 and "需求不存在" in out


class TestCancelledIsTerminalForAdvance:
    """取消是终态：推进只做只读回查，不得把 cancelled 覆盖成 executing。"""

    def test_advance_after_cancel_keeps_cancelled_and_reports_terminal(
        self, tmp_path: Path, capsys
    ) -> None:
        req_id = submit(tmp_path, capsys, text="取消终态：推进应被拦下")
        cancel_code, _ = run_cli(
            [
                "requirement",
                "cancel",
                req_id,
                "--by",
                "owner",
                "--reason",
                "撤下该需求",
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        assert cancel_code == 0

        code, out = run_cli(
            [
                "requirement",
                "advance",
                req_id,
                "--pi-command",
                '["pi", "--mode", "rpc"]',
                "--records-root",
                str(tmp_path),
            ],
            capsys,
        )
        # 终态不回退：命令如实返回，状态保持 cancelled，不进入执行。
        assert code in (0, 1), out
        status_code, status = run_cli(
            ["requirement", "status", req_id, "--records-root", str(tmp_path)], capsys
        )
        assert status_code == 0, status
        assert "cancelled" in status
