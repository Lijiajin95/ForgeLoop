"""受限执行环境集成测试：真实子进程里验证「PI 只改批准副本」与容器边界。

覆盖 B01 交付条件（DogFood 执行计划 B01）：

- PI（假 PI 子进程，讲同一 JSONL 契约）真实修改工作副本，源 main 无变化；
- 副本内 commit/HEAD 前移不会丢失候选改动（diff 始终对批准基线）；
- 旧副本缺少基线记录时回填显式批准基线，不复用新 HEAD；
- 正式测试命令确实在副本内加载候选代码；
- 容器命令只挂载工作副本（review 只读）、专用配置目录与测试资源，
  源仓库路径从不出现，且参数按挂载点翻译；
- 有 Docker 的本机在真实容器内尝试写源库/main，证明被拒（V-A02）。

Docker 守护进程不在本机时，容器边界用例按**命令构造与真实越权写入**两种
能力分级：构造核对始终运行；真实容器越权写入用例在守护进程/镜像可用时运行，
否则 ``skip``。不为通过而把命令核对当成容器隔离已验收。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

from forgeloop.adapter.execution_environment import (
    CONTAINER,
    HOME_MOUNT,
    HOST,
    RESOURCE_MOUNT_ROOT,
    WORKSPACE_MOUNT,
    ExecutionEnvironment,
    ExecutionEnvironmentError,
    build_execution_environment,
    command_test_resources,
)
from forgeloop.adapter.git_workspace import (
    collect_candidate_change,
    prepare_workspace,
    read_main_head,
)
from forgeloop.adapter.pi_rpc import PIInvocationResult, PIProcess, PISpawnOptions
from forgeloop.adapter.test_runner import run_test_command

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FAKE_PI = [sys.executable, str(FIXTURES / "fake_pi.py")]
TASK_ID = "task-b01"


def git(path: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "HOME": str(path.parent),
            "GIT_AUTHOR_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_COMMITTER_DATE": "2026-10-11T20:00:00+08:00",
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        },
    ).stdout


def make_source_repo(tmp_path: Path) -> Path:
    source = tmp_path / "source-repo"
    source.mkdir()
    (source / "feature.txt").write_text("old\n", encoding="utf-8")
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "t")
    git(source, "config", "user.email", "t@example.com")
    git(source, "add", "-A")
    git(source, "commit", "-m", "chore: baseline")
    return source


def _run_dev_pi(
    workspace: Path, sessions: Path, environment: ExecutionEnvironment, **extra_env: str
):
    """在给定执行环境里跑一次 dev 假 PI（edit 模式）；返回协议结果。"""

    command = environment.command(FAKE_PI)
    options = PISpawnOptions(
        cwd=environment.process_cwd(workspace),
        extra_env={"FAKE_PI_MODE": "edit", **extra_env},
        execution_environment=environment.kind,
    )
    process = PIProcess(command, TASK_ID, "dev", sessions, options)
    process.start()
    try:
        process.send_prompt(
            json.dumps(
                {
                    "workspace": environment.exposed_workspace(),
                    "goal": "edit candidate",
                }
            )
        )
        return process.wait_until_settled(15.0)
    finally:
        process.close()


def _docker_daemon_available() -> bool:
    if shutil.which("docker") is None:
        return False
    result = subprocess.run(["docker", "info"], capture_output=True, check=False, timeout=30)
    return result.returncode == 0


def _available_image() -> str | None:
    for image in (
        "forgeloop-runtime:0.1",
        "python:3.13-slim",
        "alpine:3.20",
        "busybox:1.36",
    ):
        result = subprocess.run(
            ["docker", "image", "inspect", image], capture_output=True, check=False, timeout=30
        )
        if result.returncode == 0:
            return image
    return None


class TestHostDevelopment:
    def test_pi_edits_workspace_and_source_main_is_unchanged(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        source_head = read_main_head(source)
        sessions = tmp_path / "task" / "sessions"

        outcome = _run_dev_pi(
            workspace, sessions, ExecutionEnvironment(kind=HOST, workspace=workspace)
        )

        assert outcome.settled and outcome.error is None
        # PI 真实改了批准副本……
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "new\n"
        # ……源 main 的提交与文件都没有变化。
        assert read_main_head(source) == source_head
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"
        # 候选 diff 来自工作副本对批准基线的真实差异。
        change = collect_candidate_change(workspace, baseline)
        assert change.baseline_commit == baseline
        assert "+new" in change.diff
        # 会话轨迹记录了执行环境，供回查“是不是在受限环境里跑的”。
        requests = (sessions / f"{TASK_ID}-dev.requests.jsonl").read_text(encoding="utf-8")
        assert '"execution_environment": "host"' in requests


class TestCandidateDiffSurvivesCommit:
    def test_commit_inside_workspace_does_not_lose_candidate(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        (workspace / "feature.txt").write_text("new\n", encoding="utf-8")
        # PI 可能在副本里自行 commit：HEAD 前移，但批准基线不变。
        git(workspace, "add", "-A")
        git(workspace, "commit", "-m", "feat: pi committed the candidate")
        assert git(workspace, "rev-parse", "HEAD").strip() != baseline
        change = collect_candidate_change(workspace)
        assert change.baseline_commit == baseline
        assert "+new" in change.diff
        # 修复轮复用副本时，prepare 仍返回原始批准基线。
        assert prepare_workspace(source, "", workspace) == baseline

    def test_legacy_workspace_without_baseline_ref_is_backfilled(self, tmp_path: Path) -> None:
        """旧副本没有 refs/forgeloop/baseline：修复轮用显式批准基线回填，不丢改动。"""

        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        baseline = prepare_workspace(source, "", workspace)
        # 模拟 B01 之前建立的旧副本：基线引用不存在。
        git(workspace, "update-ref", "-d", "refs/forgeloop/baseline")
        assert (
            subprocess.run(
                ["git", "-C", str(workspace), "rev-parse", "--verify", "refs/forgeloop/baseline"],
                capture_output=True,
                check=False,
            ).returncode
            != 0
        )
        # PI 在旧副本里提交后进入修复轮：显式基线回填，diff 仍包含本次提交。
        (workspace / "feature.txt").write_text("committed\n", encoding="utf-8")
        git(
            workspace,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "add",
            "-A",
        )
        git(
            workspace,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "feat: pi committed inside a legacy copy",
        )
        assert prepare_workspace(source, baseline, workspace) == baseline
        change = collect_candidate_change(workspace)
        assert change.baseline_commit == baseline
        assert "+committed" in change.diff


class TestFormalTestLoadsCandidate:
    CHECK_SCRIPT = (
        "import candidate_module\n"
        "from pathlib import Path\n"
        "expected = Path('expected.txt').read_text(encoding='utf-8').strip()\n"
        "raise SystemExit(0 if candidate_module.VALUE == expected else 3)\n"
    )

    def _repo_with_check(self, tmp_path: Path) -> Path:
        source = tmp_path / "source-repo"
        source.mkdir()
        (source / "candidate_module.py").write_text("VALUE = 'old'\n", encoding="utf-8")
        (source / "expected.txt").write_text("old\n", encoding="utf-8")
        (source / "check.py").write_text(self.CHECK_SCRIPT, encoding="utf-8")
        git(source, "init", "-b", "main")
        git(source, "config", "user.name", "t")
        git(source, "config", "user.email", "t@example.com")
        git(source, "add", "-A")
        git(source, "commit", "-m", "chore: baseline")
        return source

    def test_test_command_reads_candidate_code_from_workspace(self, tmp_path: Path) -> None:
        source = self._repo_with_check(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        # 候选代码（PI 的产物）：把模块改成 new，并更新期望值。
        (workspace / "candidate_module.py").write_text("VALUE = 'new'\n", encoding="utf-8")
        (workspace / "expected.txt").write_text("new\n", encoding="utf-8")

        environment = ExecutionEnvironment(kind=HOST, workspace=workspace)
        # ``-B`` 不写 __pycache__：候选代码同秒改写时不会被旧字节码顶替，
        # 保证每次导入都来自副本里的源文件。
        command = environment.command([sys.executable, "-B", "check.py"])
        evidence = tmp_path / "test-run.jsonl"

        passed = run_test_command(command, workspace, 30.0, evidence)
        assert passed.exit_code == 0

        # 把候选改回旧值：同一命令必须失败，证明它加载的是副本里的候选代码，
        # 而不是缓存或宿主上的另一份。
        (workspace / "candidate_module.py").write_text("VALUE = 'old'\n", encoding="utf-8")
        failed = run_test_command(command, workspace, 30.0, evidence)
        assert failed.exit_code == 3

        entries = [json.loads(line) for line in evidence.read_text(encoding="utf-8").splitlines()]
        assert [entry["exit_code"] for entry in entries] == [0, 3]


class TestContainerBoundary:
    def _prepared(self, tmp_path: Path) -> tuple[Path, Path]:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        return source, workspace

    def test_container_command_mounts_workspace_but_never_the_source(self, tmp_path: Path) -> None:
        source, workspace = self._prepared(tmp_path)
        home = tmp_path / "pi-home"
        home.mkdir()
        environment = ExecutionEnvironment(
            kind=CONTAINER, workspace=workspace, image="forgeloop-runtime:test", home=home
        )
        command = environment.command(FAKE_PI)
        rendered = " ".join(command)
        assert command[0] == "docker"
        assert {"run", "--rm", "-i"} <= set(command)
        assert f"{workspace}:{WORKSPACE_MOUNT}:rw" in rendered
        # 容器内 PI 要连模型；默认网络不是 none（JSONL 不是宿主 RPC 代理）。
        assert command[command.index("--network") + 1] == "bridge"
        # 源仓库不在任何挂载里，也不在命令里——容器内进程没有源库/main 写入口。
        assert str(source) not in rendered
        assert str(source) not in [str(mount.source) for mount in environment.mounts()]
        # 容器里的工作目录由 -w 指定，宿主 cwd 不参与。
        assert environment.process_cwd(workspace) is None
        assert environment.isolated is True

    def test_review_mounts_workspace_read_only(self, tmp_path: Path) -> None:
        _source, workspace = self._prepared(tmp_path)
        home = tmp_path / "pi-home"
        home.mkdir()
        environment = ExecutionEnvironment(kind=CONTAINER, workspace=workspace, home=home)
        command = environment.command(FAKE_PI, workspace_read_only=True)
        rendered = " ".join(command)
        assert f"{workspace}:{WORKSPACE_MOUNT}:ro" in rendered
        assert f"{workspace}:{WORKSPACE_MOUNT}:rw" not in rendered

    def test_container_home_is_mounted_writable_and_home_env_points_into_it(
        self, tmp_path: Path
    ) -> None:
        _source, workspace = self._prepared(tmp_path)
        home = tmp_path / "pi-home"
        home.mkdir()
        environment = ExecutionEnvironment(kind=CONTAINER, workspace=workspace, home=home)
        command = environment.command(FAKE_PI)
        rendered = " ".join(command)
        assert f"{home}:{HOME_MOUNT}:rw" in rendered
        # HOME 必须作为容器运行参数注入：extra_env 只作用于宿主 docker 客户端进程，
        # 不会进入容器；否则容器内 PI 仍用镜像默认 /root，挂载的凭据不会被读取。
        assert command[command.index("--env") + 1] == f"HOME={HOME_MOUNT}"
        # 宿主 docker 客户端不被指向容器内路径，避免破坏宿主 docker 配置。
        assert environment.spawn_env() == {}

    def test_dataclass_rejects_test_mount_inside_source_repo(self, tmp_path: Path) -> None:
        """直接构造执行环境也不能把源库子目录当测试资源挂进容器。"""

        source = make_source_repo(tmp_path)
        (source / "src").mkdir()
        workspace = source / ".cache" / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        home = tmp_path / "pi-home"
        home.mkdir()
        with pytest.raises(ExecutionEnvironmentError, match="git 仓库"):
            ExecutionEnvironment(
                kind=CONTAINER,
                workspace=workspace,
                home=home,
                test_mounts=(source / "src",),
            )

    def test_dataclass_rejects_test_mount_inside_workspace(self, tmp_path: Path) -> None:
        _source, workspace = self._prepared(tmp_path)
        home = tmp_path / "pi-home"
        home.mkdir()
        with pytest.raises(ExecutionEnvironmentError, match="工作副本"):
            ExecutionEnvironment(
                kind=CONTAINER,
                workspace=workspace,
                home=home,
                test_mounts=(workspace / "tests",),
            )

    def test_host_command_is_not_wrapped(self, tmp_path: Path) -> None:
        _source, workspace = self._prepared(tmp_path)
        environment = ExecutionEnvironment(kind=HOST, workspace=workspace)
        assert environment.command(FAKE_PI) == tuple(FAKE_PI)
        assert environment.process_cwd(workspace) == workspace
        assert environment.spawn_env() == {}

    def test_test_resources_are_mounted_and_command_paths_translated(self, tmp_path: Path) -> None:
        _source, workspace = self._prepared(tmp_path)
        home = tmp_path / "pi-home"
        home.mkdir()
        cache = tmp_path / "uv-cache"
        cache.mkdir()
        environment = ExecutionEnvironment(
            kind=CONTAINER, workspace=workspace, home=home, test_mounts=(cache,)
        )
        assert f"{cache}:{RESOURCE_MOUNT_ROOT}/0:rw" in " ".join(environment.command(FAKE_PI))
        translated = environment.translate_argv(
            [str(workspace / "tests" / "x.py"), str(workspace), str(cache / "pkg"), "relative"]
        )
        assert translated == (
            f"{WORKSPACE_MOUNT}/tests/x.py",
            WORKSPACE_MOUNT,
            f"{RESOURCE_MOUNT_ROOT}/0/pkg",
            "relative",
        )
        assert environment.exposed_workspace() == WORKSPACE_MOUNT


class TestDevPromptUsesContainerPaths:
    """容器模式下节点必须把工作区与测试命令翻译成容器路径。"""

    def test_dev_node_translates_prompt_and_command(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from forgeloop.graph import agent_execution
        from forgeloop.graph.nodes import NodeContext, make_dev_node, make_plan_node
        from forgeloop.records.store import RecordStore

        captured: dict[str, Any] = {}

        class _CapturingProcess:
            def __init__(self, command, task_id, role, session_dir, options=None) -> None:
                captured["command"] = command
                captured["role"] = role
                captured["options"] = options
                captured["prompt"] = None

            def start(self) -> None:
                pass

            def send_prompt(self, text: str) -> None:
                captured["prompt"] = text

            def wait_until_settled(self, timeout_seconds: float) -> PIInvocationResult:
                return PIInvocationResult(
                    settled=True,
                    aborted=False,
                    text="{}",
                    result={"diff": ""},
                    events=(),
                    error=None,
                )

            def close(self) -> None:
                pass

        # 运行时构造点在 agent_execution（PI 与 DSH 共用的接缝）。
        monkeypatch.setattr(agent_execution, "PIProcess", _CapturingProcess)

        home = tmp_path / "pi-home"
        home.mkdir()
        cache = tmp_path / "uv-cache"
        cache.mkdir()
        task_id = "task-container-prompt"
        store = RecordStore(tmp_path / "records.sqlite")
        try:
            store.create_task(
                task_id,
                "p",
                "input",
                {
                    "pi_command": json.dumps(["pi", "--mode", "rpc"]),
                    "test_command": json.dumps(
                        ["uv", "run", "--cache-dir", str(cache), "pytest", "-q", "tests/x.py"]
                    ),
                    "goal": "g",
                    "scope": "s",
                    "acceptance": "a",
                    "execution_environment": "container",
                    "container_home": str(home),
                },
                limit_seconds=600.0,
            )
            ctx = NodeContext.for_task(store, tmp_path, task_id)
            make_plan_node(ctx)({"task_id": task_id})
            make_dev_node(ctx)({"task_id": task_id})
        finally:
            store.close()

        prompt = json.loads(str(captured["prompt"]))
        assert prompt["workspace"] == WORKSPACE_MOUNT
        assert prompt["formal_test_command"][0] == "uv"
        assert str(cache) not in json.dumps(prompt["formal_test_command"])
        assert f"{RESOURCE_MOUNT_ROOT}/0" in json.dumps(prompt["formal_test_command"])
        command = tuple(str(part) for part in captured["command"])
        assert command[0] == "docker"
        # PI 自身命令不带任何宿主路径；挂载列表才是唯一出现宿主路径的位置。
        assert command[-3:] == ("pi", "--mode", "rpc")
        options = captured["options"]
        assert options.execution_environment == "container"
        assert options.cwd is None
        assert options.runtime == "pi"


class TestBuildExecutionEnvironment:
    def test_defaults_to_host(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FORGELOOP_EXECUTION_ENV", raising=False)
        environment = build_execution_environment({}, tmp_path / "ws")
        assert environment.kind == HOST
        assert environment.isolated is False

    def test_reads_container_configuration(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_EXECUTION_ENV", raising=False)
        home = tmp_path / "pi-home"
        home.mkdir()
        environment = build_execution_environment(
            {
                "execution_environment": "container",
                "container_image": "forgeloop-runtime:9",
                "container_runtime": '["podman"]',
                "container_network": "bridge",
                "container_home": str(home),
            },
            tmp_path / "ws",
        )
        assert environment.kind == CONTAINER
        assert environment.image == "forgeloop-runtime:9"
        assert environment.runtime == ("podman",)
        assert environment.network == "bridge"
        assert environment.home == home

    def test_environment_variable_fallback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        home = tmp_path / "pi-home"
        home.mkdir()
        monkeypatch.setenv("FORGELOOP_EXECUTION_ENV", "container")
        monkeypatch.setenv("FORGELOOP_CONTAINER_IMAGE", "forgeloop-runtime:env")
        monkeypatch.setenv("FORGELOOP_CONTAINER_HOME", str(home))
        environment = build_execution_environment({}, tmp_path / "ws")
        assert environment.kind == CONTAINER
        assert environment.image == "forgeloop-runtime:env"

    def test_container_requires_home(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FORGELOOP_CONTAINER_HOME", raising=False)
        with pytest.raises(ExecutionEnvironmentError, match="container_home"):
            build_execution_environment({"execution_environment": "container"}, tmp_path / "ws")

    def test_container_dataclass_requires_home(self, tmp_path: Path) -> None:
        with pytest.raises(ExecutionEnvironmentError, match="container_home"):
            ExecutionEnvironment(kind=CONTAINER, workspace=tmp_path / "ws")

    def test_host_home_is_rejected_as_container_home(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(ExecutionEnvironmentError, match="宿主 HOME"):
            ExecutionEnvironment(kind=CONTAINER, workspace=tmp_path / "ws", home=Path.home())

    def test_ancestor_of_host_home_is_rejected_as_container_home(self, tmp_path: Path) -> None:
        """宿主 HOME 的祖先同样包含源库；挂进容器等于交出源库写入口。"""

        with pytest.raises(ExecutionEnvironmentError, match="宿主 HOME"):
            ExecutionEnvironment(kind=CONTAINER, workspace=tmp_path / "ws", home=Path.home().parent)

    def test_container_home_inside_source_repo_is_rejected(self, tmp_path: Path) -> None:
        """源库子目录不能当容器配置目录（实际布局：副本位于 <source>/.cache/...）。"""

        source = make_source_repo(tmp_path)
        workspace = source / ".cache" / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        inside_source = source / "config"
        inside_source.mkdir()
        with pytest.raises(ExecutionEnvironmentError, match="git 仓库"):
            build_execution_environment(
                {"execution_environment": "container", "container_home": str(inside_source)},
                workspace,
            )

    def test_explicit_test_mount_inside_source_repo_is_rejected(self, tmp_path: Path) -> None:
        """显式 container_test_mounts 同样不能指向源库子树。"""

        source = make_source_repo(tmp_path)
        (source / "src").mkdir()
        workspace = source / ".cache" / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        home = tmp_path / "pi-home"
        home.mkdir()
        with pytest.raises(ExecutionEnvironmentError, match="git 仓库"):
            build_execution_environment(
                {
                    "execution_environment": "container",
                    "container_home": str(home),
                    "container_test_mounts": json.dumps([str(source / "src")]),
                },
                workspace,
            )

    def test_host_kind_ignores_container_home_configuration(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """host 运行不解析容器配置：配置了 container_home 也不应中断宿主任务。"""

        monkeypatch.delenv("FORGELOOP_EXECUTION_ENV", raising=False)
        environment = build_execution_environment(
            {"container_home": str(Path.home())}, tmp_path / "ws"
        )
        assert environment.kind == HOST
        assert environment.home is None
        assert environment.mounts() == ()

    def test_container_home_resolution_still_required_for_container(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_CONTAINER_HOME", raising=False)
        with pytest.raises(ExecutionEnvironmentError, match="container_home"):
            build_execution_environment({"execution_environment": "container"}, tmp_path / "ws")

    def test_test_resource_paths_exclude_source_and_workspace(self, tmp_path: Path) -> None:
        source = make_source_repo(tmp_path)
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        cache = tmp_path / "uv-cache"
        cache.mkdir()
        inside_workspace = workspace / "exists.py"
        inside_workspace.write_text("x\n", encoding="utf-8")
        resources = command_test_resources(
            ["uv", "--cache-dir", str(cache), str(inside_workspace), str(source), "relative"],
            workspace,
        )
        assert cache.resolve() in resources
        assert source.resolve() not in resources
        assert inside_workspace.resolve() not in resources

    def test_git_repository_subdirectories_are_not_test_resources(self, tmp_path: Path) -> None:
        """源库/副本内部的子目录没有自己的 ``.git``，也绝不能作为资源挂进容器。"""

        source = make_source_repo(tmp_path)
        (source / "src").mkdir()
        (source / "src" / "module.py").write_text("x = 1\n", encoding="utf-8")
        workspace = tmp_path / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        nested = workspace / "nested"
        nested.mkdir()
        (nested / "test_x.py").write_text("x\n", encoding="utf-8")

        resources = command_test_resources(["pytest", str(source / "src"), str(nested)], workspace)
        assert (source / "src").resolve() not in resources
        assert nested.resolve() not in resources

    def test_default_network_allows_model_access(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_CONTAINER_NETWORK", raising=False)
        home = tmp_path / "pi-home"
        home.mkdir()
        environment = build_execution_environment(
            {"execution_environment": "container", "container_home": str(home)},
            tmp_path / "ws",
        )
        assert environment.network == "bridge"
        command = environment.command(["pi", "--mode", "rpc"])
        assert command[command.index("--network") + 1] == "bridge"

    def test_unknown_environment_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_EXECUTION_ENV", raising=False)
        with pytest.raises(ExecutionEnvironmentError, match="未知执行环境"):
            build_execution_environment({"execution_environment": "chroot"}, tmp_path / "ws")

    def test_invalid_container_runtime_is_rejected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("FORGELOOP_CONTAINER_RUNTIME", raising=False)
        with pytest.raises(ExecutionEnvironmentError, match="非空字符串数组"):
            build_execution_environment({"container_runtime": "[]"}, tmp_path / "ws")
        with pytest.raises(ExecutionEnvironmentError, match="非空字符串数组"):
            build_execution_environment({"container_runtime": "42"}, tmp_path / "ws")


def _shared_container_tmp() -> Path:
    """容器越权测试用的共享临时目录。

    Docker 运行时只共享宿主的少数路径（colima 默认共享 $HOME）：若把工作副本放在 pytest 的
    tmp_path（macOS 上是 /var/folders/...），容器里看到的挂载点是空目录，写进去不会落到宿主，
    用例会以"副本未被写入"失败（实机验证时踩到）。可用 FORGELOOP_TEST_SHARED_TMP 覆盖。
    """

    override = os.environ.get("FORGELOOP_TEST_SHARED_TMP")
    base = (
        Path(override)
        if override
        else Path(__file__).resolve().parents[2] / ".cache" / "dogfood" / "pytest-shared-tmp"
    )
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="container-iso-", dir=base))


@pytest.mark.skipif(not _docker_daemon_available(), reason="Docker 守护进程不可用")
class TestRealContainerIsolation:
    """真实容器内尝试写源库/main：证明「PI 无权写入源库/main」（V-A02）。

    这是验收项而非命令构造核对：只有当守护进程与可用镜像都在时才执行，
    否则整体 skip，绝不把 skip 当成通过。
    """

    def test_container_cannot_write_source_repo_or_main(self, tmp_path: Path) -> None:
        image = _available_image()
        if image is None:
            pytest.skip("本机没有可用于越权写入测试的容器镜像")
        shared = _shared_container_tmp()  # 工作副本必须在容器运行时共享的目录下
        source = make_source_repo(shared)
        source_head = read_main_head(source)
        workspace = shared / "task" / "workspace"
        prepare_workspace(source, "", workspace)
        home = tmp_path / "pi-home"  # 配置目录可留在非共享目录：本用例不需要容器内读到它
        home.mkdir()
        environment = ExecutionEnvironment(
            kind=CONTAINER, workspace=workspace, home=home, image=image
        )
        # 容器内：写挂载副本应成功；写源库路径（未挂载）应失败；源库不可见。
        script = (
            "echo new > feature.txt; "
            f"if echo hacked > {source}/feature.txt 2>/dev/null; then exit 7; fi; "
            "exit 0"
        )
        completed = subprocess.run(
            environment.command(["sh", "-c", script]),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        # 副本（挂载）确实被容器写入……
        assert (workspace / "feature.txt").read_text(encoding="utf-8") == "new\n"
        # ……源库文件与 main HEAD 都没变：容器内没有源库写入口。
        assert (source / "feature.txt").read_text(encoding="utf-8") == "old\n"
        assert read_main_head(source) == source_head
