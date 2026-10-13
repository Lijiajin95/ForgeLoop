"""本机部署与回滚领域规则（S2）：只部署同一份已验收产物，保留可核对回滚入口。

规则来源（所有者 2026-10-12 决定 CD 交付目标为本机 Debian 设备）：
- 控制路径只接受 Release 上发布的同一份产物：标签指向发布回执里的归并提交，
  产物 sha256 必须等于 Release 的 ``SHA256SUMS`` 记录值；不重新构建、不放宽。
- 幂等：同版本同产物已激活时不重复安装；同版本但产物不同一律拒绝（不覆盖）。
- 回滚只允许切到**已安装且留有产物校验记录**的版本；未校验版本一律拒绝。
- 本模块是纯规则：不做 IO；下载、安装、原子切换与冒烟检查在 adapter / CLI 边界。
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from forgeloop.domain.release import DIGEST_PATTERN, parse_version

CHECKSUM_LINE = re.compile(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$")


@dataclass(frozen=True)
class DeployDecision:
    """部署与回滚判定：允许与否、原因，以及"已是目标状态"的幂等标记。"""

    allowed: bool
    reason: str
    noop: bool = False


@dataclass(frozen=True)
class DeployRequest:
    """一次部署判定所需的事实（由调用方从发布回执与 Release 现场读取）。

    版本口径：``tag`` 是标签（``vX.Y.Z``），``version`` 是裸版本（``X.Y.Z``），
    与版本目录名、激活指针、部署日志保持同一事实。
    ``source`` 区分两条路径：``release`` 是控制路径（发布回执 + 标签提交 +
    发布校验值三者一致）；``bootstrap`` 只用于工具自身的首次安装，必须在部署
    日志里如实标注来源，不能冒充控制路径。
    """

    tag: str
    version: str
    source: str
    release_recorded: bool
    tag_commit: str
    release_merge_commit: str
    artifact_sha256: str
    published_sha256: str
    active_version: str | None
    active_sha256: str | None


@dataclass(frozen=True)
class RollbackRequest:
    """一次回滚判定所需的事实：目标版本、当前版本与已安装版本的校验记录。"""

    target_version: str
    active_version: str | None
    installed_digests: Mapping[str, str]


def parse_checksum_file(text: str) -> dict[str, str]:
    """解析 ``sha256sum`` 输出为 {文件名: 校验值}；忽略注释、空行与畸形行。"""

    checksums: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = CHECKSUM_LINE.match(stripped)
        if match is None:
            continue
        checksums[match.group(2)] = match.group(1).lower()
    return checksums


def select_wheel(checksums: Mapping[str, str], version: str) -> str | None:
    """从校验清单中选出该版本的 wheel 发行文件；缺失时返回 None。"""

    expected = f"forgeloop-{version}-py3-none-any.whl"
    return expected if expected in checksums else None


def _release_source_refusal(request: DeployRequest) -> DeployDecision | None:
    """控制路径的发布侧校验；全部通过返回 None。"""

    if not request.release_recorded:
        return DeployDecision(False, f"缺少 {request.tag} 的发布回执；未发布的版本不部署")
    if request.tag_commit != request.release_merge_commit:
        return DeployDecision(
            False,
            f"标签提交与发布回执不一致：标签 {request.tag_commit[:12]}，"
            f"回执 {request.release_merge_commit[:12]}；拒绝部署",
        )
    if not DIGEST_PATTERN.match(request.published_sha256):
        return DeployDecision(False, "发布校验值缺失或格式错误（须为 64 位十六进制小写）")
    if request.artifact_sha256 != request.published_sha256:
        return DeployDecision(
            False,
            f"产物校验值不匹配：实际 {request.artifact_sha256[:12]}，"
            f"发布 {request.published_sha256[:12]}；拒绝部署（禁止重新构建）",
        )
    return None


def check_deploy_readiness(request: DeployRequest) -> DeployDecision:
    """部署前置判定：控制路径要求发布回执、标签提交与产物校验值三者一致。

    bootstrap 路径只跳过"发布回执/标签提交/发布校验值"三项（工具自身首次安装
    时它们尚不存在），产物校验值格式与幂等冲突检查两条路径共用。
    """

    if parse_version(request.tag) is None:
        return DeployDecision(False, f"标签不合法：{request.tag}；须为 vMAJOR.MINOR.PATCH")
    if request.tag != f"v{request.version}":
        return DeployDecision(
            False, f"标签与版本不一致：标签 {request.tag}，版本 {request.version}"
        )
    if request.source not in ("release", "bootstrap"):
        return DeployDecision(
            False, f"产物来源不合法：{request.source}；只接受 release 或 bootstrap"
        )
    if not DIGEST_PATTERN.match(request.artifact_sha256):
        return DeployDecision(False, "产物校验值缺失或格式错误（须为 64 位十六进制小写）")
    if request.source == "release":
        refusal = _release_source_refusal(request)
        if refusal is not None:
            return refusal
    if request.active_version == request.version:
        if request.active_sha256 == request.artifact_sha256:
            return DeployDecision(True, f"{request.tag} 已是当前版本且校验值一致", noop=True)
        return DeployDecision(
            False,
            f"{request.tag} 已激活但产物校验值不同：已激活 {str(request.active_sha256)[:12]}，"
            f"待部署 {request.artifact_sha256[:12]}；拒绝覆盖",
        )
    return DeployDecision(True, f"{request.tag} 可部署：产物校验值与来源要求一致")


def check_rollback_readiness(request: RollbackRequest) -> DeployDecision:
    """回滚前置判定：只切到已安装且校验记录完整的版本（版本口径为裸版本）。"""

    if parse_version(f"v{request.target_version}") is None:
        return DeployDecision(
            False, f"版本号不合法：{request.target_version}；须为 MAJOR.MINOR.PATCH"
        )
    if request.target_version == request.active_version:
        return DeployDecision(False, f"{request.target_version} 已是当前版本；无需回滚")
    recorded = request.installed_digests.get(request.target_version)
    if recorded is None:
        return DeployDecision(
            False, f"{request.target_version} 未安装或缺少产物校验记录；拒绝回滚到未校验版本"
        )
    if not DIGEST_PATTERN.match(str(recorded)):
        return DeployDecision(False, f"{request.target_version} 的产物校验记录格式错误")
    return DeployDecision(True, f"可回滚到 {request.target_version}：校验记录存在")
