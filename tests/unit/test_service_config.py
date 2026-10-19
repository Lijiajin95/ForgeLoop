"""常驻服务配置的纯规则与读取边界（R1）。

覆盖三块：``domain.service`` 的数值判定（非法即失败，不静默回落）、``cli.serve``
的服务化前提（配置文件解析与 PI HOME 判据）、``graph.worker`` 的心跳状态。这些都是
确定性逻辑，因此用单元测试钉住行为，而不是只看「进程起得来」。
"""

import time
from pathlib import Path

import pytest

from forgeloop.cli.serve import (
    ServeConfigError,
    check_projects,
    load_service_config,
    pi_home_problems,
    service_text,
)
from forgeloop.domain.service import (
    DEFAULT_MAX_CONCURRENT,
    DEFAULT_POLL_SECONDS,
    DEFAULT_SERVICE_HOST,
    DEFAULT_SERVICE_PORT,
    LOOPBACK_HOSTS,
    ServiceConfigError,
    resolve_service_settings,
)
from forgeloop.graph.worker import ServiceWorker

PROJECT_KEYS = {
    "path": "/tmp/demo",
    "pi_command": ["pi", "--mode", "rpc"],
    "test_command": ["pytest", "-q"],
    "baseline": "",
    "pi_home": "/tmp/demo-home",
}


def config(**overrides: object) -> dict:
    document: dict = {"schema_version": 1}
    document.update(overrides)
    return document


class TestDefaultsAndOverrides:
    def test_no_config_file_uses_builtin_defaults(self) -> None:
        settings = resolve_service_settings(None)
        assert settings.host == DEFAULT_SERVICE_HOST
        assert settings.port == DEFAULT_SERVICE_PORT
        assert settings.poll_seconds == DEFAULT_POLL_SECONDS
        assert settings.max_concurrent == DEFAULT_MAX_CONCURRENT
        assert settings.auto_advance is False
        assert dict(settings.projects) == {}

    def test_config_values_apply_and_cli_overrides_them(self) -> None:
        document = config(host="localhost", port=9000, poll_seconds=5, max_concurrent=3)
        from_config = resolve_service_settings(document)
        assert (from_config.host, from_config.port) == ("localhost", 9000)
        assert from_config.poll_seconds == 5
        assert from_config.max_concurrent == 3
        overridden = resolve_service_settings(document, host="127.0.0.1", port=9001)
        assert (overridden.host, overridden.port) == ("127.0.0.1", 9001)

    def test_port_zero_is_accepted_for_system_assigned_port(self) -> None:
        assert resolve_service_settings(config(port=0)).port == 0

    def test_minimum_positive_values_are_accepted(self) -> None:
        """下限本身是合法的：`poll_seconds = 1` 与 `max_concurrent = 1` 必须被接受。"""

        settings = resolve_service_settings(config(poll_seconds=1, max_concurrent=1))
        assert settings.poll_seconds == 1
        assert settings.max_concurrent == 1

    def test_upper_port_boundary_is_accepted(self) -> None:
        assert resolve_service_settings(config(port=65535)).port == 65535


class TestRejectedValues:
    def test_non_loopback_host_is_refused(self) -> None:
        with pytest.raises(ServiceConfigError, match="只允许回环地址"):
            resolve_service_settings(config(host="0.0.0.0"))

    def test_schema_version_must_match(self) -> None:
        with pytest.raises(ServiceConfigError, match="schema_version"):
            resolve_service_settings({"schema_version": 2})
        with pytest.raises(ServiceConfigError, match="schema_version"):
            resolve_service_settings({})

    @pytest.mark.parametrize("value", [0, -1, "2", True, 2.5])
    def test_poll_seconds_must_be_positive_integer(self, value: object) -> None:
        with pytest.raises(ServiceConfigError, match="poll_seconds"):
            resolve_service_settings(config(poll_seconds=value))

    @pytest.mark.parametrize("value", [0, -3, True, "3"])
    def test_max_concurrent_must_be_positive_integer(self, value: object) -> None:
        with pytest.raises(ServiceConfigError, match="max_concurrent"):
            resolve_service_settings(config(max_concurrent=value))

    @pytest.mark.parametrize("value", [65536, -1, "8712"])
    def test_port_range_is_enforced(self, value: object) -> None:
        with pytest.raises(ServiceConfigError, match="port"):
            resolve_service_settings(config(port=value))

    def test_auto_advance_must_be_boolean(self) -> None:
        with pytest.raises(ServiceConfigError, match="auto_advance"):
            resolve_service_settings(config(auto_advance="true"))

    def test_unknown_top_level_key_is_refused(self) -> None:
        with pytest.raises(ServiceConfigError, match="未知配置项"):
            resolve_service_settings(config(poll_second=3))


class TestProjectProfiles:
    def test_profile_is_parsed(self) -> None:
        settings = resolve_service_settings(config(projects={"demo": dict(PROJECT_KEYS)}))
        profile = settings.projects["demo"]
        assert profile.name == "demo"
        assert profile.path == "/tmp/demo"
        assert profile.pi_command == ("pi", "--mode", "rpc")
        assert profile.test_command == ("pytest", "-q")
        assert profile.baseline == ""
        assert profile.pi_home == "/tmp/demo-home"

    def test_baseline_is_optional_but_preserved_when_given(self) -> None:
        """可选字段的两种形态都要成立：缺省为空串，给了值就原样保留。"""

        # 缺省（键完全缺失）走 None 分支；显式空串走字符串分支——两种都要成立。
        without_key = {key: value for key, value in PROJECT_KEYS.items() if key != "baseline"}
        absent = resolve_service_settings(config(projects={"demo": without_key}))
        assert absent.projects["demo"].baseline == ""

        empty = resolve_service_settings(config(projects={"demo": dict(PROJECT_KEYS)}))
        assert empty.projects["demo"].baseline == ""

        given = resolve_service_settings(
            config(projects={"demo": dict(PROJECT_KEYS, baseline="v1.2.3")})
        )
        assert given.projects["demo"].baseline == "v1.2.3"

    def test_unknown_project_key_is_refused(self) -> None:
        broken = dict(PROJECT_KEYS, pi_commandline=["pi"])
        with pytest.raises(ServiceConfigError, match="未知配置项"):
            resolve_service_settings(config(projects={"demo": broken}))

    def test_missing_field_is_refused(self) -> None:
        broken = dict(PROJECT_KEYS)
        del broken["pi_home"]
        with pytest.raises(ServiceConfigError, match=r"projects\.demo\.pi_home"):
            resolve_service_settings(config(projects={"demo": broken}))

    def test_command_must_be_non_empty_string_array(self) -> None:
        for value in ("pi --mode rpc", [], ["pi", ""], [1, 2]):
            broken = dict(PROJECT_KEYS, pi_command=value)
            with pytest.raises(ServiceConfigError, match=r"projects\.demo\.pi_command"):
                resolve_service_settings(config(projects={"demo": broken}))

    def test_string_command_is_refused_as_a_string_array(self) -> None:
        """命令是字符串（而不是数组）时按「字符串数组」拒绝，不能按字符拆开照收。"""

        broken = dict(PROJECT_KEYS, pi_command="pi --mode rpc")
        with pytest.raises(ServiceConfigError, match="必须是字符串数组"):
            resolve_service_settings(config(projects={"demo": broken}))

    def test_project_name_cannot_contain_whitespace(self) -> None:
        with pytest.raises(ServiceConfigError, match="空白"):
            resolve_service_settings(config(projects={"bad name": dict(PROJECT_KEYS)}))


class TestServiceConfigFile:
    def test_missing_file_is_none(self, tmp_path: Path) -> None:
        assert load_service_config(tmp_path / "absent.toml") is None

    def test_broken_toml_is_refused(self, tmp_path: Path) -> None:
        path = tmp_path / "service.toml"
        path.write_text("schema_version = ", encoding="utf-8")
        with pytest.raises(ServeConfigError, match="解析失败"):
            load_service_config(path)

    def test_repository_default_config_is_valid(self) -> None:
        root = Path(__file__).resolve().parents[2]
        document = load_service_config(root / "config" / "service.toml")
        settings = resolve_service_settings(document)
        assert settings.host == "127.0.0.1"
        assert settings.port == 8712
        assert settings.auto_advance is False
        assert dict(settings.projects) == {}


class TestPiHome:
    def test_missing_models_file_is_reported(self, tmp_path: Path) -> None:
        problems = pi_home_problems(str(tmp_path))
        assert len(problems) == 1
        assert "models.json" in problems[0]

    def test_empty_models_file_is_reported(self, tmp_path: Path) -> None:
        models = tmp_path / ".pi" / "agent" / "models.json"
        models.parent.mkdir(parents=True)
        models.write_text("   \n", encoding="utf-8")
        problems = pi_home_problems(str(tmp_path))
        assert problems and "为空" in problems[0]

    def test_usable_home_has_no_problems(self, tmp_path: Path) -> None:
        models = tmp_path / ".pi" / "agent" / "models.json"
        models.parent.mkdir(parents=True)
        models.write_text('{"providers": []}', encoding="utf-8")
        assert pi_home_problems(str(tmp_path)) == ()

    def test_check_projects_reports_each_profile(self, tmp_path: Path) -> None:
        settings = resolve_service_settings(
            config(projects={"demo": dict(PROJECT_KEYS, pi_home=str(tmp_path))})
        )
        with pytest.raises(ServeConfigError, match=r"projects\.demo"):
            check_projects(settings)


class TestServiceText:
    def test_text_reports_effective_switches(self) -> None:
        document = {
            "records_root": ".forgeloop",
            "config_path": "config/service.toml",
            "worker": {
                "poll_seconds": 2,
                "auto_advance": False,
                "execution_enabled": False,
                "executable_projects": [],
                "last_tick": {"candidates": [], "skipped": {"req-1": "没有已批准任务包"}},
            },
            "projects": [],
            "counts": {"requirements": 1, "tasks": 2, "issues": 3},
            "review_required": [{"kind": "task_blocked"}, {"kind": "slot_residue"}],
        }
        text = "\n".join(service_text(document))
        assert "自动接续: 关闭（只报告，不推进）" in text
        assert "可执行项目: 无" in text
        assert "跳过 1 条" in text
        assert "1/2/2" in text


class TestWorkerStatus:
    def test_status_follows_auto_advance_and_stop_returns_to_idle(self, tmp_path: Path) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=True)
        idle = worker.status()
        assert idle["running"] is False
        assert idle["auto_advance"] is True
        assert idle["execution_enabled"] is True
        assert idle["polls"] == 0
        assert idle["projects"] == []
        assert idle["last_tick"] == {
            "candidates": [],
            "executed": [],
            "skipped": [],
            "results": [],
        }
        worker.start()
        assert worker.status()["running"] is True
        worker.stop()
        assert worker.status()["running"] is False

    def test_auto_advance_off_means_no_execution(self, tmp_path: Path) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False)
        assert worker.status()["execution_enabled"] is False

    def test_heartbeat_counts_without_executing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False)
        ticks: list[int] = []
        monkeypatch.setattr(worker, "_tick", lambda: ticks.append(1))
        worker.start()
        try:
            deadline = time.monotonic() + 5.0
            while not ticks and time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            worker.stop()
        assert ticks, "心跳应在 poll_seconds 内至少触发一次"
        status = worker.status()
        assert status["polls"] >= 1
        assert status["last_poll_at"]

    def test_heartbeat_errors_are_recorded_not_raised(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        worker = ServiceWorker(tmp_path, poll_seconds=1, auto_advance=False)

        def boom() -> None:
            raise RuntimeError("心跳失败")

        monkeypatch.setattr(worker, "_tick", boom)
        worker.start()
        try:
            deadline = time.monotonic() + 5.0
            while not worker.status()["last_error"] and time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            worker.stop()
        assert worker.status()["last_error"] == "心跳失败"

    def test_poll_seconds_must_be_positive(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="poll_seconds"):
            ServiceWorker(tmp_path, poll_seconds=0, auto_advance=False)


class TestMessagesAreTheContract:
    """`domain/service.py` 的**消息即契约**（2026-10-18 所有者决定把它纳入变异范围）。

    与 `config/quality-policy.toml` 里其他模块「消息文本非行为契约」的登记不同：这是
    **配置校验**模块——运维就是照着这句消息改 `config/service.toml`，缺了字段名、范围写法
    或未知键清单，人就得去翻源码。因此这里逐字断言文案，把「改字面量」的变异体钉死；
    例外口径同时写在策略表的本模块登记说明与 `pyproject.toml` 的 `[tool.mutmut]` 注释里。
    """

    def message_of(self, **overrides: object) -> str:
        with pytest.raises(ServiceConfigError) as error:
            resolve_service_settings(config(**overrides))
        return str(error.value)

    def document_message_of(self, document: dict) -> str:
        with pytest.raises(ServiceConfigError) as error:
            resolve_service_settings(document)
        return str(error.value)

    def test_unknown_top_level_keys_are_listed_with_separator(self) -> None:
        message = self.message_of(poll_second=5, extra=1)
        assert message == "常驻服务配置 含未知配置项: extra、poll_second"

    def test_integer_messages_name_field_and_bound(self) -> None:
        assert self.message_of(poll_seconds=0) == "poll_seconds 必须在 >= 1 范围内，实际 0"
        assert self.message_of(poll_seconds="2") == "poll_seconds 必须是整数"
        assert self.message_of(max_concurrent=0) == "max_concurrent 必须在 >= 1 范围内，实际 0"
        assert self.message_of(port=70000) == "port 必须在 0..65535 范围内，实际 70000"
        assert self.message_of(port="80") == "port 必须是整数"

    def test_flag_message_names_field(self) -> None:
        assert self.message_of(auto_advance="yes") == "auto_advance 必须是布尔值"

    def test_host_messages(self) -> None:
        assert self.message_of(host="") == "host 必须是非空字符串"
        allowed = "、".join(sorted(LOOPBACK_HOSTS))
        assert self.message_of(host="0.0.0.0") == (
            f"host 只允许回环地址（{allowed}），实际 0.0.0.0；常驻服务不对外暴露"
        )

    def test_projects_container_messages(self) -> None:
        assert self.document_message_of(config(projects=[])) == (
            "projects 必须是表（形如 [projects.<名字>]）"
        )
        assert self.document_message_of(config(projects={"demo": []})) == "projects.demo 必须是表"
        # 文案由共享校验原语 `domain.toml_fields` 生成（字段名与说明之间留一个空格），
        # 与 service/projects 两处配置共用同一口径；断言随该口径对齐。
        assert self.document_message_of(config(projects={"bad name": dict(PROJECT_KEYS)})) == (
            "项目名 必须非空且不含空白字符，实际 'bad name'"
        )

    def test_project_field_messages_name_the_field(self) -> None:
        def profile_message(**overrides: object) -> str:
            fields = dict(PROJECT_KEYS, **overrides)
            return self.document_message_of(config(projects={"demo": fields}))

        assert profile_message(nope=1) == "projects.demo 含未知配置项: nope"
        assert profile_message(path="") == "projects.demo.path 必须是非空字符串"
        assert profile_message(pi_home=123) == "projects.demo.pi_home 必须是非空字符串"
        assert profile_message(pi_command=[]) == "projects.demo.pi_command 不能为空"
        assert profile_message(pi_command=["pi", ""]) == (
            "projects.demo.pi_command 的每一项都必须是非空字符串"
        )
        assert profile_message(pi_command="pi --mode rpc") == (
            "projects.demo.pi_command 必须是字符串数组"
        )
        assert profile_message(test_command=None) == ("projects.demo.test_command 必须是字符串数组")
        assert profile_message(baseline=42) == "projects.demo.baseline 必须是字符串"
