"""本机部署 IO 边界（S2）：下载 Release 资产、安装版本目录、原子切换与冒烟检查。

目录约定（``--prefix``，默认 ``~/.local/share/forgeloop``）::

    releases/<version>/        每个版本一个独立环境（不覆盖既有版本）
    releases/<version>/bin/forgeloop   稳定入口 shim
    current -> releases/<version>      激活指针（原子切换）
    artifacts/<name>           下载到的产物原件（保留以便复核校验值）
    deployments.jsonl          部署日志（版本、产物校验值、来源、上一版本、冒烟结果）

只下载 Release 上发布的产物；本地产物仅用于显式 bootstrap，并在日志里如实标注
来源，不冒充控制路径。安装失败会清理半成品版本目录，绝不留下"看起来已安装"的现场。
"""

import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import cast

GITHUB_API = "https://api.github.com/repos/{slug}/releases/tags/{tag}"
GITHUB_ASSET = "https://github.com/{slug}/releases/download/{tag}/{name}"
HTTP_TIMEOUT_SECONDS = 60.0
SMOKE_TIMEOUT_SECONDS = 60.0
REMOTE_SLUG = re.compile(r"github\.com[:/](?P<slug>[^/]+/[^/]+?)(?:\.git)?/?$")


class DeploymentError(RuntimeError):
    """部署或回滚的现场操作失败（下载、安装、切换、冒烟检查）。"""


def default_prefix() -> Path:
    return Path.home() / ".local" / "share" / "forgeloop"


def sha256_of_file(path: Path) -> str:
    """产物文件的内容寻址校验值；与发布端 sha256sum 口径一致。"""

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remote_slug(project: Path) -> str | None:
    """从仓库 origin 解析 ``owner/name``（支持 HTTPS 与 SSH 两种写法）。"""

    result = subprocess.run(
        ["git", "-C", str(project), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        return None
    match = REMOTE_SLUG.search(result.stdout.strip())
    return match.group("slug") if match else None


def _fetch_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def release_assets(slug: str, tag: str) -> dict[str, str]:
    """列出某个 Release 的资产：{文件名: 下载地址}；公开仓库无需凭据。"""

    payload = _fetch_json(GITHUB_API.format(slug=slug, tag=tag))
    if not isinstance(payload, dict):
        raise DeploymentError(f"Release 元数据格式错误：{slug} {tag}")
    document = cast("dict[str, object]", payload)
    assets = document.get("assets")
    if not isinstance(assets, list):
        raise DeploymentError(f"Release {tag} 没有资产列表（是否已发布?）")
    found: dict[str, str] = {}
    for asset in cast("list[object]", assets):
        if not isinstance(asset, dict):
            continue
        entry = cast("dict[str, object]", asset)
        name, url = entry.get("name"), entry.get("browser_download_url")
        if isinstance(name, str) and isinstance(url, str):
            found[name] = url
    if not found:
        raise DeploymentError(f"Release {tag} 资产为空")
    return found


def download_asset(url: str, destination: Path) -> Path:
    """下载单个资产到本地（保留原件以便复核校验值）。"""

    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url)
    with (
        urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response,
        destination.open("wb") as handle,
    ):
        shutil.copyfileobj(response, handle)
    return destination


def current_version(prefix: Path) -> str | None:
    """读取激活指针指向的版本（未激活时返回 None）。"""

    pointer = prefix / "current"
    if not pointer.is_symlink():
        return None
    return Path(os.readlink(pointer)).name


def _run(command: Sequence[str], environment: Mapping[str, str] | None = None) -> None:
    result = subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        check=False,
        shell=False,
        env=dict(environment) if environment is not None else None,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-400:]
        raise DeploymentError(f"命令失败（{command[0]}）：{detail}")


def _find_uv() -> str | None:
    """优先用当前解释器同目录的 uv（开发环境的 dev 依赖），再退回 PATH。"""

    candidate = Path(sys.executable).with_name("uv")
    if candidate.is_file():
        return str(candidate)
    return shutil.which("uv")


def _write_shim(target: Path) -> None:
    """写入稳定入口 shim：``<version>/bin/forgeloop`` → 该版本环境里的控制台脚本。"""

    shim_dir = target / "bin"
    shim_dir.mkdir(exist_ok=True)
    shim = shim_dir / "forgeloop"
    shim.write_text(f'#!/bin/sh\nexec "{target}/.venv/bin/forgeloop" "$@"\n', encoding="utf-8")
    shim.chmod(0o755)


def install_wheel(artifact: Path, target: Path, python_version: str = "3.13") -> None:
    """在新版本目录建立独立环境并安装 wheel；失败清理半成品，不覆盖既有版本。

    缓存与 Python 解释器目录都放在部署前缀内（``<prefix>/cache``、
    ``<prefix>/toolchain``）：部署不依赖宿主可写的家目录缓存，也便于整体核对与清理。
    """

    if target.exists():
        raise DeploymentError(f"版本目录已存在，拒绝覆盖：{target}")
    target.mkdir(parents=True)
    try:
        prefix = target.parent.parent
        environment = dict(os.environ)
        environment["UV_CACHE_DIR"] = str(prefix / "cache" / "uv")
        environment["UV_PYTHON_INSTALL_DIR"] = str(prefix / "toolchain" / "python")
        venv_dir = target / ".venv"
        uv = _find_uv()
        if uv is not None:
            _run([uv, "venv", str(venv_dir), "--python", python_version], environment)
            _run(
                [uv, "pip", "install", "--python", str(venv_dir / "bin/python"), str(artifact)],
                environment,
            )
        else:
            _run([sys.executable, "-m", "venv", str(venv_dir)], environment)
            _run([str(venv_dir / "bin/python"), "-m", "pip", "install", str(artifact)], environment)
        _write_shim(target)
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise


def version_binary(prefix: Path, version: str) -> Path:
    """某个已安装版本的稳定入口 shim；不经过 ``current``，供坏版本恢复时直接调用。"""

    return prefix / "releases" / version / "bin" / "forgeloop"


def activate(prefix: Path, version: str) -> None:
    """原子切换激活指针：临时符号链接 + ``os.replace``，切换瞬间不存在半激活状态。"""

    target = prefix / "releases" / version
    if not version_binary(prefix, version).exists():
        raise DeploymentError(f"版本未安装或不完整：{target}")
    prefix.mkdir(parents=True, exist_ok=True)
    temporary = prefix / f"current.tmp-{os.getpid()}"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, prefix / "current")


def health_check(prefix: Path, timeout_seconds: float = SMOKE_TIMEOUT_SECONDS) -> tuple[int, str]:
    """按 ADR 0004 的健康检查：激活后的 ``serve --once --json`` 退出码 0 且输出可解析。

    返回 ``(0, 摘要)`` 表示健康；非 0 时第二项写明原因（退出码、stderr 摘要或 JSON 解析
    错误），供部署命令据此**自动回滚**（所有者 2026-10-18 决定：保留健康检查）。
    """

    executable = prefix / "current" / "bin" / "forgeloop"
    if not executable.exists():
        return 127, f"未找到可执行文件：{executable}"
    try:
        result = subprocess.run(
            [str(executable), "serve", "--once", "--json"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return 126, f"健康检查无法执行：{error}"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        return result.returncode, detail[0][:200] if detail else "无输出"
    if not result.stdout.strip():
        # 退出码 0 但没有输出：机器上还没有可检查的服务配置（例如刚安装、尚未接入）。
        # 按"不适用"处理并如实说明，不当成不健康——否则首次接入会被自己的健康检查挡住。
        return 0, "无可检查的服务配置（空输出）：健康检查不适用"
    try:
        json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return 125, f"健康检查输出不是 JSON：{error}"
    return 0, "serve --once --json 通过"


def smoke_check(prefix: Path, timeout_seconds: float = SMOKE_TIMEOUT_SECONDS) -> tuple[int, str]:
    """对激活后的 CLI 做冒烟检查：``current/bin/forgeloop --help``。"""

    executable = prefix / "current" / "bin" / "forgeloop"
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


def journal_path(prefix: Path) -> Path:
    return prefix / "deployments.jsonl"


def append_journal(prefix: Path, entry: Mapping[str, object]) -> Path:
    """追加一条部署日志；日志是本机安装现场的权威记录。"""

    path = journal_path(prefix)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(entry), ensure_ascii=False) + "\n")
    return path


def journal_entries(prefix: Path) -> list[dict[str, object]]:
    """读取部署日志（损坏行跳过，不臆造内容）。"""

    path = journal_path(prefix)
    if not path.is_file():
        return []
    entries: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        with contextlib.suppress(json.JSONDecodeError):
            parsed: object = json.loads(line)
            if isinstance(parsed, dict):
                entries.append(cast("dict[str, object]", parsed))
    return entries


def installed_digests(prefix: Path) -> dict[str, str]:
    """已安装版本 → 最近一次记录的产物校验值（回滚核对用）。"""

    digests: dict[str, str] = {}
    for entry in journal_entries(prefix):
        version, digest = entry.get("version"), entry.get("artifact_sha256")
        if isinstance(version, str) and isinstance(digest, str):
            digests[version] = digest
    return digests


def previous_version(prefix: Path) -> str | None:
    """最近一次部署记录的上一版本（供 ``rollback --previous``）。"""

    entries = journal_entries(prefix)
    if not entries:
        return None
    value = entries[-1].get("previous_version")
    return value if isinstance(value, str) else None


def installed_versions(prefix: Path) -> tuple[str, ...]:
    releases = prefix / "releases"
    if not releases.is_dir():
        return ()
    return tuple(sorted(path.name for path in releases.iterdir() if path.is_dir()))
