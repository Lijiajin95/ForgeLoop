"""候选产物构建与验证领域规则（S4）：授权提交、产物身份与可复现判定。

规则来源（P1 CD：本机部署只接受同一份已验收产物）：
- 只允许从任务已归并（验收通过并接回 main）的提交构建候选产物；任何其他提交
  都是"未授权提交"，一律拒绝——产物必须绑定可回查的任务身份，不能用工作树当前
  内容或任意提交冒充。
- 产物身份 = 任务 + 提交 + 版本 + wheel 文件名；校验值用内容寻址 sha256，与
  发布/部署端同一算法，部署端据此核对"同一份验收产物"。
- 可复现判定：同一提交独立构建两次校验值一致才算通过；不一致如实报告两次值，
  不把不同产物当成同一份。
- 本模块是纯规则：不做任何 IO，导出提交、构建、安装与冒烟在 adapter / CLI 边界。
"""

import re
from dataclasses import dataclass
from datetime import datetime

from forgeloop.domain.release import DIGEST_PATTERN, parse_version

COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
WHEEL_PATTERN = re.compile(r"^forgeloop-(?P<version>\d+\.\d+\.\d+)-py3-none-any\.whl$")


@dataclass(frozen=True)
class ArtifactDecision:
    """候选产物判定：允许与否及可回查的原因。"""

    allowed: bool
    reason: str


@dataclass(frozen=True)
class BuildComparison:
    """两次独立构建的对比结果：是否可复现，以及两次校验值。"""

    consistent: bool
    reason: str
    first_sha256: str
    second_sha256: str


@dataclass(frozen=True)
class ArtifactRecord:
    """一次真实候选产物构建与验证的固化记录（身份 + 校验值 + 冒烟结果）。"""

    task_id: str
    commit: str
    version: str
    wheel_name: str
    sha256: str
    rebuild_sha256: str
    reproducible: bool
    smoke_exit_code: int
    smoke_detail: str
    wheel_path: str
    receipt_path: str
    built_at: datetime


def wheel_version(wheel_name: str) -> str | None:
    """从规范 wheel 文件名解析版本；不符合约定时返回 None。"""

    match = WHEEL_PATTERN.match(wheel_name)
    return match.group("version") if match else None


def check_commit_authorization(
    task_id: str, commit: str, authorized_commit: str
) -> ArtifactDecision:
    """候选构建的提交授权判定：只允许任务已归并的提交。"""

    if not task_id:
        return ArtifactDecision(False, "缺少任务身份；无法确定授权提交")
    if not authorized_commit:
        return ArtifactDecision(
            False, "任务尚未归并，没有可授权的提交；先完成验收与受控归并再构建候选产物"
        )
    if not commit:
        return ArtifactDecision(False, "缺少待构建的提交号")
    if not COMMIT_PATTERN.match(commit):
        return ArtifactDecision(False, f"提交号格式错误：{commit}；须为 40 位十六进制小写")
    if commit != authorized_commit:
        return ArtifactDecision(
            False,
            f"未授权提交：{commit[:12]} 不是任务 {task_id} 的归并提交 "
            f"{authorized_commit[:12]}；拒绝从非授权提交构建产物",
        )
    return ArtifactDecision(True, f"提交 {commit[:12]} 是任务 {task_id} 的归并提交，已授权构建")


def check_artifact_identity(project_version: str, wheel_name: str) -> ArtifactDecision:
    """产物身份判定：wheel 文件名声明的版本必须与项目声明版本一致。"""

    version = wheel_version(wheel_name)
    if version is None:
        return ArtifactDecision(
            False, f"产物文件名不符合约定：{wheel_name}；须为 forgeloop-<version>-py3-none-any.whl"
        )
    if parse_version(f"v{version}") is None:
        return ArtifactDecision(False, f"产物版本号不合法：{version}")
    if project_version != version:
        return ArtifactDecision(
            False,
            f"产物版本与项目声明版本不一致：产物 {version}，项目 {project_version or '未知'}；"
            "拒绝采信身份不明的产物",
        )
    return ArtifactDecision(True, f"产物身份一致：版本 {version}")


def compare_builds(first_sha256: str, second_sha256: str) -> BuildComparison:
    """可复现判定：两次独立构建校验值必须一致才通过。"""

    if not DIGEST_PATTERN.match(first_sha256) or not DIGEST_PATTERN.match(second_sha256):
        return BuildComparison(
            False,
            "构建校验值缺失或格式错误（须为 64 位十六进制小写）",
            first_sha256,
            second_sha256,
        )
    if first_sha256 == second_sha256:
        return BuildComparison(
            True, f"两次独立构建校验值一致：{first_sha256[:12]}", first_sha256, second_sha256
        )
    return BuildComparison(
        False,
        f"两次独立构建校验值不一致：首次 {first_sha256[:12]}，再次 {second_sha256[:12]}；"
        "产物不可复现，拒绝采信",
        first_sha256,
        second_sha256,
    )
