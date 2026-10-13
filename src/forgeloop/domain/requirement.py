"""需求受理的身份与修订规则：原文与追加版本都按身份保留。

规则来源（完整目标 §3 工作对象与修改规则）：
- 一个研发工作项绑定一个项目，不同项目的工作项不混用。
- 首次提交的原文占用版本 1，永久保留；补充或修改只追加新版本，不覆盖历史。
- 同一目标的修订不重新分配身份，版本号从 1 起连续递增。
- 按身份回查未知需求必须明确失败，不能返回空结果。

修订不会自动清零失败记录、已消耗工时或追加授权（见 counting、limits）。
持久化由 records 层负责；本模块只维护不可变事实。
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime


class RequirementError(ValueError):
    """违反需求身份或修订版本规则。"""


class RequirementNotFoundError(LookupError):
    """按身份回查不到需求；未知身份必须明确失败。"""


def allocate_requirement_id() -> str:
    """分配一个新的、全局唯一的需求身份。"""

    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    return f"req-{stamp}-{uuid.uuid4().hex[:6]}"


@dataclass(frozen=True)
class RequirementVersion:
    """需求的一个修订版本；版本 1 是首次提交的原始输入。"""

    version: int
    text: str
    created_at: datetime

    def __post_init__(self) -> None:
        if self.version < 1:
            raise RequirementError("需求版本号必须从 1 开始")
        if not self.text.strip():
            raise RequirementError("需求版本原文不能为空")


@dataclass(frozen=True)
class Requirement:
    """一个绑定项目、身份稳定的研发工作项，历史修订全部保留。"""

    req_id: str
    project: str
    versions: tuple[RequirementVersion, ...]

    def __post_init__(self) -> None:
        if not self.req_id:
            raise RequirementError("需求身份不能为空")
        if not self.project:
            raise RequirementError("需求必须绑定一个项目")
        if not self.versions:
            raise RequirementError("需求至少要有原始输入这一版本")
        numbers = [version.version for version in self.versions]
        if numbers != list(range(1, len(self.versions) + 1)):
            raise RequirementError("需求版本号必须从 1 起连续递增，历史版本不得覆盖")

    @property
    def original_text(self) -> str:
        """首次提交的原文，始终是版本 1。"""

        return self.versions[0].text

    @property
    def latest(self) -> RequirementVersion:
        return self.versions[-1]

    @property
    def version_count(self) -> int:
        return len(self.versions)

    def append(self, text: str, created_at: datetime) -> "Requirement":
        """追加一个修订版本；原文与历史版本保持不变。"""

        next_version = RequirementVersion(len(self.versions) + 1, text, created_at)
        return Requirement(self.req_id, self.project, (*self.versions, next_version))
