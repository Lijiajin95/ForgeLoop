"""候选产物构建 IO 边界（S4）：从确定提交真实构建 wheel、独立环境安装冒烟。

- 构建在从该提交导出的独立工作目录（git worktree，detached HEAD）中进行：
  不使用工作树当前内容冒充确定提交。
- 产物校验值用 sha256 内容寻址，与发布/部署端同一算法。
- 独立环境复用 S2 的安装机制（全新 venv）建立，随后跑 ``forgeloop --help`` 冒烟；
  与部署现场共用同一套"独立版本环境"语义。
- 任何一步失败都清理半成品（导出的工作目录、临时环境），如实抛出 ArtifactError。
"""

import os
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from forgeloop.adapter.deployment import (
    DeploymentError,
    install_wheel,
    sha256_of_file,
)

SMOKE_TIMEOUT_SECONDS = 60.0


class ArtifactError(RuntimeError):
    """候选产物构建或验证的现场操作失败（导出、构建、安装、冒烟）。"""


@dataclass(frozen=True)
class CandidateBuild:
    """一次真实构建的产物：项目版本、wheel 路径、文件名与内容寻址校验值。"""

    project_version: str
    wheel: Path
    wheel_name: str
    sha256: str


def find_uv() -> str | None:
    """优先用当前解释器同目录的 uv（开发环境 dev 依赖），再退回 PATH。"""

    candidate = Path(sys.executable).with_name("uv")
    if candidate.is_file():
        return str(candidate)
    return shutil.which("uv")


def read_project_version(root: Path) -> str:
    """读取项目声明的版本；缺失或不可解析时返回空串（如实标注未知）。"""

    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return ""
    try:
        document: dict[str, object] = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return ""
    project_table = document.get("project")
    if not isinstance(project_table, dict):
        return ""
    table = cast("dict[str, object]", project_table)
    version = table.get("version")
    return version if isinstance(version, str) else ""


def _run(command: list[str], cwd: Path, environment: dict[str, str] | None = None) -> None:
    result = subprocess.run(
        command,
        cwd=str(cwd),
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-400:]
        raise ArtifactError(f"命令失败（{' '.join(command[:2])}）：{detail}")


def _export_commit(project: Path, commit: str, destination: Path) -> None:
    """把确定提交导出为独立 detached worktree；不使用工作树当前内容。"""

    destination.parent.mkdir(parents=True, exist_ok=True)
    _run(
        ["git", "-C", str(project), "worktree", "add", "--detach", str(destination), commit],
        project,
    )


def _remove_worktree(project: Path, destination: Path) -> None:
    """清理导出的工作目录（尽力而为，不掩盖原始错误）。"""

    subprocess.run(
        ["git", "-C", str(project), "worktree", "remove", "--force", str(destination)],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    shutil.rmtree(destination, ignore_errors=True)
    subprocess.run(
        ["git", "-C", str(project), "worktree", "prune"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )


def build_wheel(source: Path, output_dir: Path) -> Path:
    """在源码目录真实运行 ``uv build``，返回唯一 wheel 产物。"""

    uv = find_uv()
    if uv is None:
        raise ArtifactError("未找到 uv；无法构建候选产物（开发环境由 dev 依赖提供）")
    output_dir.mkdir(parents=True, exist_ok=True)
    # 缓存与解释器目录放在构建目录旁：宿主默认缓存目录在受限环境里不可写（EPERM）。
    environment = dict(os.environ)
    environment["UV_CACHE_DIR"] = str(output_dir.parent / "cache" / "uv")
    environment["UV_PYTHON_INSTALL_DIR"] = str(output_dir.parent / "toolchain" / "python")
    _run([uv, "build", "--out-dir", str(output_dir)], source, environment)
    wheels = sorted(output_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise ArtifactError(f"构建未产生唯一 wheel（实际 {len(wheels)} 个）：{output_dir}")
    return wheels[0]


def build_candidate(project: Path, commit: str, output_dir: Path) -> CandidateBuild:
    """从确定提交导出并构建一次候选 wheel；失败清理导出的工作目录。"""

    output_dir.mkdir(parents=True, exist_ok=True)
    source = output_dir / "source"
    try:
        _export_commit(project, commit, source)
        version = read_project_version(source)
        wheel = build_wheel(source, output_dir / "dist")
    finally:
        _remove_worktree(project, source)
    return CandidateBuild(
        project_version=version,
        wheel=wheel,
        wheel_name=wheel.name,
        sha256=sha256_of_file(wheel),
    )


def smoke_executable(
    executable: Path, timeout_seconds: float = SMOKE_TIMEOUT_SECONDS
) -> tuple[int, str]:
    """对独立环境里的 CLI 做冒烟检查：``forgeloop --help``。"""

    if not executable.exists():
        return 127, f"未找到可执行文件：{executable}"
    try:
        result = subprocess.run(
            [str(executable), "--help"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return 124, "冒烟检查超时"
    return result.returncode, (result.stdout or result.stderr).strip()[-400:]


def install_and_smoke(artifact: Path, environment: Path) -> tuple[int, str]:
    """在全新独立 venv 中安装 wheel 并冒烟；安装失败归一为 ArtifactError。

    复用当前解释器建立独立环境（不重新下载解释器）：候选验证只要求环境独立，
    不要求与部署端同型号；这样现场验证不依赖网络。
    """

    try:
        install_wheel(artifact, environment, python_version=sys.executable)
    except DeploymentError as error:
        raise ArtifactError(str(error)) from error
    return smoke_executable(environment / "bin" / "forgeloop")
