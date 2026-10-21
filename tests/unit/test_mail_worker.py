"""常驻邮件网关的调度与配置测试：线程生命周期、单轮失败隔离、构建边界。"""

import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from forgeloop.cli.mail_interaction import InteractionReport
from forgeloop.cli.mail_worker import MailWorker, MailWorkerConfigError, build_mail_worker
from forgeloop.mail.ports import MailConfigurationError


def empty_report(*, fetched: int = 1) -> InteractionReport:
    return InteractionReport(fetched=fetched, outcomes=(), errors=())


@dataclass(frozen=True)
class FakeProject:
    project_id: str
    repo_path: str


class FakeProcessor:
    def __init__(self, *, failures: int = 0) -> None:
        self.calls = 0
        self.resets = 0
        self.failures = failures

    def process_once(self) -> InteractionReport:
        self.calls += 1
        if self.calls <= self.failures:
            raise RuntimeError("imap down")
        return empty_report()

    def reset(self) -> None:
        self.resets += 1


def wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class TestMailWorker:
    def test_start_runs_repeatedly_and_stop_joins(self) -> None:
        processor = FakeProcessor()
        worker = MailWorker(processor, interval_seconds=0.01)

        worker.start()

        assert wait_until(lambda: processor.calls >= 3)
        worker.stop()
        assert not worker.running
        calls_at_stop = processor.calls
        time.sleep(0.05)
        assert processor.calls == calls_at_stop
        runs = worker.status()["runs"]
        assert isinstance(runs, int)
        assert runs >= 3

    def test_single_round_failure_is_isolated_and_counted(self) -> None:
        processor = FakeProcessor(failures=1)
        worker = MailWorker(processor, interval_seconds=0.01)

        first = worker.tick_once()
        second = worker.tick_once()

        assert first is None
        assert second is not None
        status = worker.status()
        assert status["runs"] == 2
        assert status["failures"] == 1
        assert "RuntimeError" in str(status["last_error"])
        assert processor.resets == 1
        assert status["last_report"] == {
            "fetched": 1,
            "processed": 0,
            "replied": 0,
            "skipped": 0,
            "errors": 0,
        }

    def test_invalid_interval_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="大于 0"):
            MailWorker(FakeProcessor(), interval_seconds=0)


class TestBuildMailWorker:
    def _config(self, root: Path, whitelist: list[str]) -> Path:
        whitelist_text = ", ".join(f'"{item}"' for item in whitelist)
        path = root / "mail.toml"
        path.write_text(
            "\n".join(
                [
                    'provider = "qq"',
                    'sender = "owner@example.com"',
                    'recipient = "notify@example.com"',
                    'folder = "INBOX"',
                    f"whitelist = [{whitelist_text}]",
                ]
            ),
            encoding="utf-8",
        )
        return path

    def test_empty_whitelist_is_fail_closed(self, tmp_path: Path) -> None:
        config = self._config(tmp_path, [])
        with pytest.raises(MailWorkerConfigError, match="白名单"):
            build_mail_worker(
                project=FakeProject(project_id="forgeloop", repo_path=str(tmp_path)),
                records_root=tmp_path,
                config_path=config,
            )

    def test_missing_secret_fails_closed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = self._config(tmp_path, ["owner@example.com"])
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        monkeypatch.delenv("FORGELOOP_MAIL_SECRET", raising=False)
        (tmp_path / "home").mkdir()
        with pytest.raises(MailConfigurationError, match="口令"):
            build_mail_worker(
                project=FakeProject(project_id="forgeloop", repo_path=str(tmp_path)),
                records_root=tmp_path,
                config_path=config,
            )

    def test_builds_gateway_with_config_and_secret(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = self._config(tmp_path, ["owner@example.com", "peer@example.com"])
        home = tmp_path / "home"
        secret = home / ".config" / "forgeloop" / "mail-secret"
        secret.parent.mkdir(parents=True)
        secret.write_text("owner@example.com\nsecret-code\n", encoding="utf-8")
        secret.chmod(0o600)
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("FORGELOOP_MAIL_SECRET", raising=False)

        worker = build_mail_worker(
            project=FakeProject(project_id="forgeloop", repo_path=str(tmp_path / "repo")),
            records_root=tmp_path / "records",
            config_path=config,
            interval_seconds=30,
        )

        status = worker.status()
        assert status["interval_seconds"] == 30
        assert status["config"] == str(config)
        assert status["folder"] == "INBOX"
        assert status["allowed_senders"] == 2
        assert status["running"] is False
