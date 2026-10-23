"""受控发布领域规则（S1）：发布前置判定与重复发布幂等。

规则来源（所有者 2026-10-12 决定把 CD 交付目标定为本机 Debian 设备）：
- 只有已验收并归并、main 未漂移的任务才允许发布；未验收或漂移一律拒绝。
- 版本号由所有者显式指定（vMAJOR.MINOR.PATCH），不自动递增；自动版本体系属 B06。
- 标签必须与项目声明的版本一致（tag == "v" + pyproject version）：否则产物名
  与标签身份不一致，部署端就无法核对"同一份验收产物"。
- 候选 diff 用内容寻址的 sha256 固化，部署端以同一值核对改动身份。
- 重复发布幂等：同任务同标签重复执行不重复发布；换标签重复发布拒绝。

本模块是纯规则：不做任何 IO，git 与文件系统操作留在 adapter / CLI 边界。
"""

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

VERSION_PATTERN = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
WHEEL_PATTERN = re.compile(r"^forgeloop-(?P<version>\d+\.\d+\.\d+)-py3-none-any\.whl$")


@dataclass(frozen=True)
class ReleaseDecision:
    """发布判定：允许与否及可回查的原因。"""

    allowed: bool
    reason: str


@dataclass(frozen=True)
class ReleaseRequest:
    """一次发布判定所需的全部事实（由调用方从记录与仓库现场读取）。"""

    task_status: str
    acceptance_recorded: bool
    merge_commit: str
    main_head: str
    tag: str
    existing_tags: Sequence[str]
    diff_sha256: str
    project_version: str


@dataclass(frozen=True)
class ReleaseRecord:
    """一次真实发布的固化记录：标签、归并提交、基线、校验值与推送结果。"""

    task_id: str
    tag: str
    merge_commit: str
    baseline_commit: str
    diff_sha256: str
    receipt_path: str
    pushed: bool
    push_detail: str
    released_at: datetime


def parse_version(tag: str) -> tuple[int, int, int] | None:
    """解析 vMAJOR.MINOR.PATCH；不合法的标签返回 None。"""

    match = VERSION_PATTERN.match(tag)
    if match is None:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def sha256_of_text(text: str) -> str:
    """候选 diff 的内容寻址校验值（部署端用同一算法核对）。"""

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_release_readiness(request: ReleaseRequest) -> ReleaseDecision:
    """发布前的纯规则判定；全部通过才允许创建并推送版本标签。"""

    if request.task_status != "merged":
        return ReleaseDecision(False, f"任务未归并（当前状态 {request.task_status}）；未归并不发布")
    if not request.acceptance_recorded:
        return ReleaseDecision(False, "缺少验收批准记录；未经验收不发布")
    if not request.merge_commit:
        return ReleaseDecision(False, "缺少归并提交号；无法绑定发布产物")
    if parse_version(request.tag) is None:
        return ReleaseDecision(False, f"版本号不合法：{request.tag}；须为 vMAJOR.MINOR.PATCH")
    if request.tag in request.existing_tags:
        return ReleaseDecision(False, f"标签已存在：{request.tag}；不允许复用版本号")
    if request.project_version != request.tag.removeprefix("v"):
        return ReleaseDecision(
            False,
            f"标签与项目版本不一致：标签 {request.tag}，项目版本 {request.project_version or '未知'}；"
            "先由任务更新 pyproject 版本再发布",
        )
    if request.main_head != request.merge_commit:
        return ReleaseDecision(
            False,
            f"main 已漂移：归并提交 {request.merge_commit[:12]}，当前 {request.main_head[:12]}；"
            "须核对差异后重新执行任务",
        )
    if not DIGEST_PATTERN.match(request.diff_sha256):
        return ReleaseDecision(False, "候选 diff 校验值缺失或格式错误（须为 64 位十六进制小写）")
    return ReleaseDecision(True, "已验收归并、版本一致且 main 未漂移")


def check_repeat_release(existing_tag: str | None, requested_tag: str) -> ReleaseDecision:
    """重复发布判定：同标签幂等放行，换标签重复发布拒绝。"""

    if existing_tag is None:
        return ReleaseDecision(True, "首次发布")
    if existing_tag == requested_tag:
        return ReleaseDecision(True, f"任务已发布 {existing_tag}；重复执行按幂等处理")
    return ReleaseDecision(
        False, f"任务已发布为 {existing_tag}；不允许改用 {requested_tag} 重复发布"
    )


def check_release_artifact(
    version: str,
    wheel_name: str,
    artifact_sha256: str,
    accepted_sha256: str,
) -> ReleaseDecision:
    """发布产物身份判定（K12）：发布必须复用 C01 已验收的同一份 wheel。

    ``version`` 是裸版本（``X.Y.Z``）；产物文件名必须为该版本的规范 wheel。
    ``accepted_sha256`` 给出验收时绑定的产物校验值，非空时必须与待发布产物一致。
    """

    expected_wheel = f"forgeloop-{version}-py3-none-any.whl"
    if not DIGEST_PATTERN.match(artifact_sha256):
        return ReleaseDecision(False, "缺少已构建候选产物校验值；发布必须复用 C01 的同一产物")
    if wheel_name != expected_wheel:
        return ReleaseDecision(
            False,
            f"候选产物文件名与版本不一致：{wheel_name or '未知'}（应为 {expected_wheel}）；"
            "拒绝发布身份不明的产物",
        )
    if accepted_sha256 and not DIGEST_PATTERN.match(accepted_sha256):
        return ReleaseDecision(False, "验收产物校验值缺失或格式错误（须为 64 位十六进制小写）")
    if accepted_sha256 and accepted_sha256 != artifact_sha256:
        return ReleaseDecision(
            False,
            f"发布产物与验收产物不一致：验收 {accepted_sha256[:12]}，"
            f"待发布 {artifact_sha256[:12]}；拒绝发布不同产物",
        )
    return ReleaseDecision(True, f"发布复用验收产物 {artifact_sha256[:12]}")


def check_release_retry(
    existing_tag: str | None,
    requested_tag: str,
    existing_artifact_sha256: str,
    current_artifact_sha256: str,
) -> ReleaseDecision:
    """重试判定（K12）：同标签幂等，且重试产物必须仍是已发布的那一份。

    重试不制造新发布身份：不新建标签、不换提交；若当前候选产物与已发布产物
    校验值不同，说明重试拿到的是另一份产物，拒绝按幂等放行。
    """

    decision = check_repeat_release(existing_tag, requested_tag)
    if not decision.allowed or existing_tag is None:
        return decision
    if (
        DIGEST_PATTERN.match(existing_artifact_sha256)
        and DIGEST_PATTERN.match(current_artifact_sha256)
        and existing_artifact_sha256 != current_artifact_sha256
    ):
        return ReleaseDecision(
            False,
            f"重试产物与已发布产物不一致：已发布 {existing_artifact_sha256[:12]}，"
            f"当前 {current_artifact_sha256[:12]}；不制造新发布身份",
        )
    return decision
