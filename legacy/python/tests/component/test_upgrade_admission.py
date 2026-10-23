"""执行准入：排空期间所有会启动动作的 CLI 入口同步拒绝，只读查询仍可用。

方案 §3.2/§3.4：代际准入是共享规则，不能只拦 worker 而让 CLI、邮件或页面绕过。
被测入口是真实的 `forgeloop` 命令装配（`cli.main.main`），不是私有函数。
"""

from pathlib import Path

import pytest

from forgeloop.cli.main import main
from forgeloop.domain.upgrade import PHASE_COMMITTED, PHASE_DRAINING, UpgradeIdentity, UpgradeState
from forgeloop.records.upgrade_state import UpgradeStateStore

PREFIX = "/tmp/forgeloop-prefix"
DIGEST = "a" * 64
COMMIT = "b" * 40


def _write_state(tmp_path: Path, phase: str, generation: str = "gen-000002") -> Path:
    store = UpgradeStateStore(tmp_path / "control")
    state = UpgradeState(
        identity=UpgradeIdentity(
            version="0.0.4",
            tag="v0.0.4",
            artifact_sha256=DIGEST,
            build_commit=COMMIT,
            generation=generation,
        ),
        project="forgeloop",
        prefix=PREFIX,
        records_root=str(tmp_path / "records"),
        phase=phase,
        generation=generation,
    )
    store.write(state)
    return store.state_path


def _managed(monkeypatch: pytest.MonkeyPatch, path: Path, generation: str = "gen-000002") -> None:
    monkeypatch.setenv("FORGELOOP_UPGRADE_MANAGED", "1")
    monkeypatch.setenv("FORGELOOP_UPGRADE_STATE", str(path))
    monkeypatch.setenv("FORGELOOP_UPGRADE_GENERATION", generation)


def _run(capsys, argv: list[str]) -> tuple[int, str]:
    try:
        code = main(argv)
    except SystemExit as error:  # argparse/定位失败与真实进程一致：非零退出
        captured = capsys.readouterr()
        if isinstance(error.code, int):
            return error.code, captured.out + captured.err
        return 1, captured.out + captured.err + str(error.code or "")
    captured = capsys.readouterr()
    return code, captured.out + captured.err


class TestAdmissionRefusesExecution:
    def test_draining_generation_blocks_requirement_advance(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_state(tmp_path, PHASE_DRAINING)
        _managed(monkeypatch, path)

        code, out = _run(
            capsys, ["requirement", "advance", "req-missing", "--records-root", str(tmp_path)]
        )

        assert code == 1
        assert "排空" in out or "升级" in out
        assert "需求不存在" not in out

    def test_committed_wrong_generation_is_blocked(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_state(tmp_path, PHASE_COMMITTED, generation="gen-000002")
        _managed(monkeypatch, path, generation="gen-000001")

        code, out = _run(
            capsys, ["requirement", "advance", "req-missing", "--records-root", str(tmp_path)]
        )

        assert code == 1
        assert "排空" in out or "升级" in out

    def test_committed_matching_generation_reaches_the_command(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_state(tmp_path, PHASE_COMMITTED, generation="gen-000002")
        _managed(monkeypatch, path, generation="gen-000002")

        code, out = _run(
            capsys, ["requirement", "advance", "req-missing", "--records-root", str(tmp_path)]
        )

        assert code == 1
        assert "需求不存在" in out or "未登记" in out

    def test_unmanaged_environment_is_unchanged(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_UPGRADE_MANAGED", raising=False)
        monkeypatch.delenv("FORGELOOP_UPGRADE_STATE", raising=False)
        monkeypatch.delenv("FORGELOOP_UPGRADE_GENERATION", raising=False)

        code, out = _run(
            capsys, ["requirement", "advance", "req-missing", "--records-root", str(tmp_path)]
        )

        assert code == 1
        assert "需求不存在" in out or "未登记" in out
        assert "排空" not in out


class TestReadOnlyStaysAvailable:
    def test_status_query_is_not_blocked_while_draining(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_state(tmp_path, PHASE_DRAINING)
        _managed(monkeypatch, path)

        code, out = _run(capsys, ["status", "task-missing", "--records-root", str(tmp_path)])

        assert code == 1
        assert "排空" not in out
        assert "任务" in out


class TestUpgradeCli:
    def _server(self, tmp_path: Path):
        import tempfile

        from forgeloop.adapter.upgrade_control import ControlServer, write_owner
        from forgeloop.domain.upgrade import PROTOCOL_VERSION, OwnerBinding

        prefix = Path(tempfile.mkdtemp(prefix="flup-cli-", dir="/tmp"))
        root = tmp_path / "records"
        project_root = root / "projects" / "forgeloop"
        project_root.mkdir(parents=True)
        binding = OwnerBinding(
            project="forgeloop",
            prefix=str(prefix),
            registration_root=str(root),
            records_root=str(project_root),
            service_config=str(tmp_path / "service.toml"),
            web_config=str(tmp_path / "web.toml"),
            projects_file=str(tmp_path / "projects.toml"),
        )
        write_owner(prefix, binding.to_document())
        state = {
            "schema_version": 1,
            "phase": "committed",
            "generation": "gen-000001",
            "identity": {"version": "0.0.1"},
        }

        def handler(operation, request):
            if operation == "status":
                return {
                    "ok": True,
                    "protocol_version": PROTOCOL_VERSION,
                    "state": state,
                    "launcher_pid": 1,
                    "child_pid": 2,
                    "prefix": {
                        "current_version": "0.0.1",
                        "installed_versions": ["0.0.1"],
                    },
                }
            if operation == "switch":
                return {
                    "ok": True,
                    "protocol_version": PROTOCOL_VERSION,
                    "message": "已切换",
                    "state": state,
                }
            return {"ok": False, "code": "unsupported_operation"}

        server = ControlServer(prefix, handler, protocol_version=PROTOCOL_VERSION)
        server.start()
        return server, prefix

    def test_status_prints_document(self, tmp_path: Path, capsys) -> None:
        server, prefix = self._server(tmp_path)
        try:
            code = main(["upgrade", "status", "--prefix", str(prefix), "--json"])
            captured = capsys.readouterr()
            assert code == 0, captured.out + captured.err
            assert '"phase": "committed"' in captured.out
        finally:
            server.stop()

    def test_apply_sends_validated_request(self, tmp_path: Path, capsys) -> None:
        server, prefix = self._server(tmp_path)
        try:
            code = main(
                [
                    "upgrade",
                    "apply",
                    "--prefix",
                    str(prefix),
                    "--tag",
                    "v0.0.2",
                    "--artifact-sha256",
                    "b" * 64,
                    "--by",
                    "owner",
                    "--reason",
                    "测试",
                ]
            )
            captured = capsys.readouterr()
            assert code == 0, captured.out + captured.err
            assert "已切换" in captured.out
        finally:
            server.stop()

    def test_status_text_and_state_without_identity(self, tmp_path: Path, capsys) -> None:
        server, prefix = self._server(tmp_path)
        try:
            code = main(["upgrade", "status", "--prefix", str(prefix)])
            captured = capsys.readouterr()
            assert code == 0, captured.out + captured.err
            assert "升级现场" in captured.out
            assert "已安装版本" in captured.out
        finally:
            server.stop()

    def test_apply_refusals_and_missing_approval(self, tmp_path: Path, capsys) -> None:
        server, prefix = self._server(tmp_path)
        try:
            missing = main(
                [
                    "upgrade",
                    "apply",
                    "--prefix",
                    str(prefix),
                    "--tag",
                    "v0.0.2",
                    "--by",
                    "owner",
                    "--reason",
                    "x",
                ]
            )
            captured = capsys.readouterr()
            assert missing == 1
            assert "部署批准" in captured.out + captured.err

            bad_tag = main(
                [
                    "upgrade",
                    "apply",
                    "--prefix",
                    str(prefix),
                    "--tag",
                    "0.0.2",
                    "--artifact-sha256",
                    "b" * 64,
                    "--by",
                    "owner",
                    "--reason",
                    "x",
                ]
            )
            assert bad_tag == 1

            wrong_project = main(
                [
                    "upgrade",
                    "apply",
                    "--prefix",
                    str(prefix),
                    "--tag",
                    "v0.0.2",
                    "--artifact-sha256",
                    "b" * 64,
                    "--by",
                    "owner",
                    "--reason",
                    "x",
                    "--project",
                    "other",
                ]
            )
            assert wrong_project == 1
        finally:
            server.stop()

    def test_apply_control_failure(self, tmp_path: Path, capsys, monkeypatch) -> None:
        from forgeloop.cli import upgrade as module

        server, prefix = self._server(tmp_path)
        try:
            monkeypatch.setattr(
                module,
                "control_request",
                lambda *a, **k: {
                    "ok": False,
                    "protocol_version": 1,
                    "code": "refused",
                    "message": "拒绝",
                },
            )
            code = main(
                [
                    "upgrade",
                    "apply",
                    "--prefix",
                    str(prefix),
                    "--tag",
                    "v0.0.2",
                    "--artifact-sha256",
                    "b" * 64,
                    "--by",
                    "owner",
                    "--reason",
                    "x",
                ]
            )
            captured = capsys.readouterr()
            assert code == 1
            assert "拒绝" in captured.out + captured.err
        finally:
            server.stop()

    def test_unknown_owner_fails_closed(self, tmp_path: Path, capsys) -> None:
        code = main(["upgrade", "status", "--prefix", str(tmp_path / "missing")])
        captured = capsys.readouterr()
        assert code == 1
        assert "未接入" in captured.out + captured.err


class TestNoSideEffects:
    def test_blocked_execution_does_not_create_records(
        self, tmp_path: Path, capsys, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_state(tmp_path, PHASE_DRAINING)
        _managed(monkeypatch, path)

        _run(capsys, ["requirement", "advance", "req-missing", "--records-root", str(tmp_path)])

        assert not (tmp_path / "records.sqlite").exists()
        assert list(tmp_path.glob("projects/*/records.sqlite")) == []
