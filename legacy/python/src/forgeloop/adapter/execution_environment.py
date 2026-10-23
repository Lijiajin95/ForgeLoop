"""受限执行环境：为 PI 与正式测试固定可写的执行边界。

架构 §5 把「不把真实 main 的写权限交给 PI」拆成两层：独立工作副本是第一层，
显式执行环境是第二层。本模块把「命令在哪里运行、能看到哪些文件系统」变成
可测试的事实，供 dev/review/test 节点共用：

- ``host``（默认）：直接宿主运行。命令只在独立工作副本内运行，源仓库路径
  不交给命令；但宿主进程仍有宿主权限，因此 host 只能支撑「本次运行未改写
  源库」的结论，**不构成「PI 无权改写源库」**——后者必须由容器隔离验收。
- ``container``：用容器运行时执行。只有工作副本（dev/test 可写、review 只读）、
  专用 PI 配置目录与正式测试命令点名的测试资源被挂载；源仓库从不挂载，因此
  容器内进程没有源库/main 的写入口。镜像由 ``runtime/Dockerfile`` 构建。

容器内 PI 自己要通过网络访问模型（``pi --mode rpc`` 直接连模型；宿主 JSONL
只是外层控制通道，不是 RPC 代理），因此默认网络是 ``bridge``——容器不是
「无网络沙箱」，而是「文件系统边界」。模型凭据/配置由 ``container_home``
指向的专用目录提供，缺省不提供即拒绝启动，避免静默使用宿主 HOME。

环境由任务配置或进程环境变量选择，不新增 CLI 参数：
``execution_environment``/``FORGELOOP_EXECUTION_ENV``（默认 ``host``），
``container_image``/``FORGELOOP_CONTAINER_IMAGE``，
``container_runtime``/``FORGELOOP_CONTAINER_RUNTIME``（JSON 字符串数组），
``container_network``/``FORGELOOP_CONTAINER_NETWORK``（默认 ``bridge``），
``container_home``/``FORGELOOP_CONTAINER_HOME``（专用 PI 配置目录，容器模式必填，
不能指向宿主 HOME，也不能指向任何 git 仓库（源库/副本）内的目录——那会把源库
一并带进容器），
``container_test_mounts``/``FORGELOOP_CONTAINER_TEST_MOUNTS``
（额外测试资源目录，JSON 字符串数组；正式测试命令里出现的绝对路径会被自动
识别为必要测试资源，两类都会以可写方式挂载；两类都不能来自源库/副本子树）。

路径翻译：容器里工作副本固定在 ``/forgeloop/workspace``，测试资源固定在
``/forgeloop/resources/<序号>``。dev 提示与正式测试命令都经 :meth:`translate_argv`
翻译后才交给容器内进程，避免把宿主绝对路径写进容器（那会改不到挂载副本、
也跑不了自验证测试）。
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

HOST = "host"
CONTAINER = "container"
DEFAULT_IMAGE = "forgeloop-runtime:0.1"
DEFAULT_RUNTIME: tuple[str, ...] = ("docker",)
# 容器内 PI 必须能连模型；JSONL 不是 RPC 代理，容器本身需要出网。
DEFAULT_NETWORK = "bridge"
WORKSPACE_MOUNT = "/forgeloop/workspace"
HOME_MOUNT = "/forgeloop/home"
RESOURCE_MOUNT_ROOT = "/forgeloop/resources"


class ExecutionEnvironmentError(ValueError):
    """执行环境配置非法（未知类型、运行命令/镜像为空、容器缺少配置目录）。"""


@dataclass(frozen=True)
class Mount:
    """一次容器挂载：宿主路径 → 容器路径，可写（rw）或只读（ro）。"""

    source: Path
    target: str
    read_only: bool = False

    @property
    def mode(self) -> str:
        return "ro" if self.read_only else "rw"

    def volume_arg(self) -> str:
        return f"{self.source}:{self.target}:{self.mode}"


def _resolve_existing(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise ExecutionEnvironmentError(f"容器挂载路径不存在：{resolved}")
    return resolved


def _validate_container_home(home: Path, workspace: Path) -> None:
    """拒绝把宿主 HOME、任务现场或任何 git 仓库子树当配置目录挂进容器。

    宿主 HOME 是源库与宿主配置的祖先；工作副本及其祖先同样会把任务现场
    （乃至源库）带进容器；源仓库子树（本项目实际布局里工作副本位于
    ``<source>/.cache/...``，配置目录很容易落在源库内）更会直接交出源库写入口。
    三种情况都与「容器只开放工作副本/测试资源/模型配置」矛盾，必须拒绝。
    """

    resolved = home.resolve()
    resolved_workspace = workspace.resolve()
    host_home = Path.home().resolve()
    # 宿主 HOME 或其祖先会把源库一并带进容器（HOME 是源库的祖先），必须拒绝。
    # ``host_home.is_relative_to(resolved)`` 恰为「resolved 是 host_home 本身或其祖先」。
    if host_home.is_relative_to(resolved):
        raise ExecutionEnvironmentError(
            f"container_home 不能是宿主 HOME 或其祖先目录：{resolved}；请使用专用配置目录"
        )
    if (
        resolved == resolved_workspace
        or resolved_workspace in resolved.parents
        or resolved in resolved_workspace.parents
    ):
        raise ExecutionEnvironmentError(
            f"container_home 不能是工作副本或其祖先目录：{resolved}；请使用专用配置目录"
        )
    if _inside_git_repository(resolved):
        raise ExecutionEnvironmentError(
            f"container_home 不能是 git 仓库（源库/副本）内的目录：{resolved}；"
            "请把专用配置目录放在源仓库之外"
        )


def _validate_test_mount(resource: Path, workspace: Path) -> None:
    """测试资源不能来自工作副本或任何 git 仓库（源库）子树。

    自动识别的测试命令路径已由 :func:`command_test_resources` 过滤，但显式配置的
    ``container_test_mounts`` 与直接构造 :class:`ExecutionEnvironment` 都要在这里
    再核一遍，避免把源库/副本内部路径以可写方式挂进容器。
    """

    resolved = resource.resolve()
    resolved_workspace = workspace.resolve()
    if resolved == resolved_workspace or resolved_workspace in resolved.parents:
        raise ExecutionEnvironmentError(
            f"测试资源不能位于工作副本内：{resolved}；工作副本已单独挂载"
        )
    if _inside_git_repository(resolved):
        raise ExecutionEnvironmentError(
            f"测试资源不能位于 git 仓库（源库/副本）内：{resolved}；请放到源仓库之外"
        )


@dataclass(frozen=True)
class ExecutionEnvironment:
    """一个动作的运行现场：执行方式、挂载、工作目录与路径翻译。

    ``workspace`` 是唯一的候选代码目录；源仓库路径从不进入本对象，因此不可能
    被写进挂载清单。``home`` 是专用 PI 配置目录（容器模式必填）。``test_mounts``
    是正式测试点名的资源目录，容器内以可写方式挂载到 ``RESOURCE_MOUNT_ROOT`` 下。
    """

    kind: str
    workspace: Path
    runtime: tuple[str, ...] = DEFAULT_RUNTIME
    image: str = DEFAULT_IMAGE
    network: str = DEFAULT_NETWORK
    home: Path | None = None
    test_mounts: tuple[Path, ...] = ()

    def __post_init__(self) -> None:
        if self.kind not in (HOST, CONTAINER):
            raise ExecutionEnvironmentError(f"未知执行环境: {self.kind}")
        if self.kind == CONTAINER:
            # 只有容器会挂载配置目录；host 不解析也不校验，避免容器配置问题
            # 影响宿主运行（与 build_execution_environment 的取舍一致）。
            if self.home is not None:
                _validate_container_home(self.home, self.workspace)
            if not self.runtime or not all(self.runtime):
                raise ExecutionEnvironmentError("容器运行时命令不能为空")
            if not self.image:
                raise ExecutionEnvironmentError("容器镜像不能为空")
            if self.home is None:
                raise ExecutionEnvironmentError(
                    "容器模式必须提供 container_home（专用 PI 配置目录）"
                )
            for mount in self.test_mounts:
                _validate_test_mount(mount, self.workspace)

    @property
    def isolated(self) -> bool:
        """是否由容器强制文件系统边界；host 不声称具备隔离能力。"""

        return self.kind == CONTAINER

    def _resource_mounts(self) -> tuple[Mount, ...]:
        return tuple(
            Mount(path, f"{RESOURCE_MOUNT_ROOT}/{index}", read_only=False)
            for index, path in enumerate(self.test_mounts)
        )

    def mounts(self, *, workspace_read_only: bool = False) -> tuple[Mount, ...]:
        """容器挂载清单；host 返回空元组。

        只挂载工作副本、专用配置目录与正式测试点名的资源，源仓库从不出现。
        review 角色把工作副本挂为只读，避免审查会话顺手改动候选。
        """

        if self.kind == HOST:
            return ()
        mounts = [Mount(self.workspace, WORKSPACE_MOUNT, read_only=workspace_read_only)]
        if self.home is not None:
            mounts.append(Mount(self.home, HOME_MOUNT))
        mounts.extend(self._resource_mounts())
        return tuple(mounts)

    def exposed_workspace(self) -> str:
        """工作副本在命令眼中的路径：容器里是挂载点，host 里是宿主路径。"""

        return WORKSPACE_MOUNT if self.kind == CONTAINER else str(self.workspace)

    def translate(self, value: str) -> str:
        """把一个宿主路径翻译成容器内路径；非路径或 host 模式原样返回。

        只翻译工作副本与已挂载测试资源的前缀，其余字符串（相对路径、flag、
        容器内既有的绝对路径）不动。这样正式测试命令与 dev 提示都不再出现
        容器里不存在的宿主路径。
        """

        if self.kind == HOST:
            return value
        candidates = [(str(self.workspace), WORKSPACE_MOUNT)]
        candidates.extend(
            (str(path), f"{RESOURCE_MOUNT_ROOT}/{index}")
            for index, path in enumerate(self.test_mounts)
        )
        for source, target in candidates:
            if value == source:
                return target
            if value.startswith(source + os.sep):
                return target + value[len(source) :]
        return value

    def translate_argv(self, argv: Sequence[str]) -> tuple[str, ...]:
        """逐项翻译命令参数；供容器内执行的命令共用。"""

        return tuple(self.translate(part) for part in argv)

    def command(self, argv: Sequence[str], *, workspace_read_only: bool = False) -> tuple[str, ...]:
        """把逻辑命令包装成实际启动的命令；host 原样返回。

        ``-i`` 保持 stdin 打开以承载 JSONL 协议；``--rm`` 保证退出后不残留容器；
        ``--network`` 让容器内 PI 连得上模型。参数先经路径翻译，容器里看到的是
        挂载点而不是宿主路径。
        """

        if self.kind == HOST:
            return tuple(argv)
        args = [*self.runtime, "run", "--rm", "-i", "--network", self.network]
        # HOME 必须作为容器运行参数注入：PISpawnOptions.extra_env 只作用于宿主
        # docker 客户端进程，不会进入容器；只设宿主 env 时容器内 PI 仍用镜像默认
        # HOME（通常是 /root），挂载的专用配置/凭据不会被读取，容器实际无法访问模型。
        if self.home is not None:
            args += ["--env", f"HOME={HOME_MOUNT}"]
        for mount in self.mounts(workspace_read_only=workspace_read_only):
            args += ["-v", mount.volume_arg()]
        args += ["-w", WORKSPACE_MOUNT, self.image, *self.translate_argv(argv)]
        return tuple(args)

    def process_cwd(self, cwd: Path) -> Path | None:
        """子进程的宿主工作目录；容器内工作目录由 ``-w`` 决定，返回 ``None``。"""

        return None if self.kind == CONTAINER else cwd

    def spawn_env(self) -> dict[str, str]:
        """附加给宿主子进程（docker 客户端）的环境变量；这里始终为空。

        ``PISpawnOptions.extra_env`` 只会并入宿主 docker CLI 进程的环境，
        ``docker run`` 不会把客户端环境转发进容器；把宿主 HOME 指到容器内路径
        还会破坏宿主 docker 配置。容器内 HOME 由 :meth:`command` 的 ``--env`` 设置。
        """

        return {}


def _configured(config: Mapping[str, str], key: str, env_key: str) -> str:
    value = config.get(key)
    if value:
        return value
    return os.environ.get(env_key, "")


def _decode_str_list(raw: str, label: str) -> tuple[str, ...]:
    try:
        parsed: object = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ExecutionEnvironmentError(f"{label} 必须是 JSON 字符串数组: {error}") from error
    if not isinstance(parsed, list) or not parsed:
        raise ExecutionEnvironmentError(f"{label} 必须是非空字符串数组（JSON）")
    items: list[str] = []
    for part in cast("list[object]", parsed):
        if not isinstance(part, str) or not part:
            raise ExecutionEnvironmentError(f"{label} 必须是非空字符串数组（JSON）")
        items.append(part)
    return tuple(items)


def _decode_runtime(raw: str) -> tuple[str, ...]:
    return _decode_str_list(raw, "container_runtime")


def _inside_git_repository(path: Path) -> bool:
    """路径是否位于某个 git 仓库内（含路径自身）。

    只看候选目录自身是否带 ``.git`` 会漏掉 ``<project>/src`` 这类子目录；
    源仓库与工作副本都带 ``.git``，沿祖先向上检查即可把它们的整个子树排除，
    避免以可写方式把源库/副本内部路径挂进容器。
    """

    current = path
    while True:
        if (current / ".git").exists():
            return True
        if current.parent == current:
            return False
        current = current.parent


def command_test_resources(argv: Sequence[str], workspace: Path) -> tuple[Path, ...]:
    """从正式测试命令里提取必要的宿主测试资源（绝对路径且真实存在）。

    只接受绝对路径、存在且不位于工作副本或任何 git 仓库（源仓库）子树内，
    避免把源库/副本内部路径以可写方式挂进容器。返回顺序稳定、已去重。
    """

    resolved_workspace = workspace.resolve()
    found: list[Path] = []
    for arg in argv:
        if not arg or not os.path.isabs(arg):
            continue
        candidate = Path(arg)
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if not candidate.exists():
            continue
        if resolved == resolved_workspace or resolved_workspace in resolved.parents:
            continue
        if _inside_git_repository(resolved):
            continue
        if resolved not in found:
            found.append(resolved)
    return tuple(found)


def build_execution_environment(
    config: Mapping[str, str],
    workspace: Path,
    *,
    home: Path | None = None,
    test_resources: Sequence[Path] = (),
) -> ExecutionEnvironment:
    """按任务配置/进程环境构建执行环境；缺省为宿主 ``host``。

    容器模式必须给出专用 ``container_home``（模型凭据/配置目录）；缺失就拒绝
    构建，而不是静默用宿主 HOME 启动一个连不上模型的容器。
    """

    kind = _configured(config, "execution_environment", "FORGELOOP_EXECUTION_ENV") or HOST
    image = _configured(config, "container_image", "FORGELOOP_CONTAINER_IMAGE") or DEFAULT_IMAGE
    raw_runtime = _configured(config, "container_runtime", "FORGELOOP_CONTAINER_RUNTIME")
    runtime = _decode_runtime(raw_runtime) if raw_runtime else DEFAULT_RUNTIME
    network = (
        _configured(config, "container_network", "FORGELOOP_CONTAINER_NETWORK") or DEFAULT_NETWORK
    )
    resources: list[Path] = list(test_resources)
    raw_mounts = _configured(config, "container_test_mounts", "FORGELOOP_CONTAINER_TEST_MOUNTS")
    if raw_mounts:
        resources.extend(
            Path(item) for item in _decode_str_list(raw_mounts, "container_test_mounts")
        )
    # 只有容器需要配置目录与测试资源挂载；host 不解析以免配置问题影响宿主运行。
    resolved_home: Path | None = None
    resolved_resources: list[Path] = []
    if kind == CONTAINER:
        configured_home = _configured(config, "container_home", "FORGELOOP_CONTAINER_HOME")
        resolved_home = home or (Path(configured_home) if configured_home else None)
        if resolved_home is None:
            raise ExecutionEnvironmentError(
                "容器模式必须提供 container_home（专用 PI 配置目录，提供模型访问配置）"
            )
        for resource in resources:
            resolved = _resolve_existing(resource)
            _validate_test_mount(resolved, workspace)
            if resolved not in resolved_resources:
                resolved_resources.append(resolved)
    return ExecutionEnvironment(
        kind=kind,
        workspace=workspace,
        runtime=runtime,
        image=image,
        network=network,
        home=resolved_home,
        test_mounts=tuple(resolved_resources),
    )
