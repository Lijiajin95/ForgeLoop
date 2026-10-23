"""需求领域规则：身份、版本连续性与修订不覆盖（纯规则，不涉及持久化）。"""

from datetime import UTC, datetime, timedelta

import pytest

from forgeloop.domain.requirement import (
    Requirement,
    RequirementError,
    RequirementVersion,
    allocate_requirement_id,
)

WHEN = datetime(2026, 10, 13, 10, 0, tzinfo=UTC)


def version(number: int = 1, text: str = "原始需求") -> RequirementVersion:
    return RequirementVersion(number, text, WHEN)


def requirement(*versions: RequirementVersion) -> Requirement:
    return Requirement("req-1", "ForgeLoop", versions or (version(),))


class TestRequirementVersionRules:
    def test_version_must_start_at_one(self) -> None:
        with pytest.raises(RequirementError, match="从 1 开始"):
            version(0)

    def test_blank_text_is_rejected(self) -> None:
        with pytest.raises(RequirementError, match="不能为空"):
            version(1, "   \n ")


class TestRequirementRules:
    def test_identity_and_project_are_required(self) -> None:
        with pytest.raises(RequirementError, match="身份不能为空"):
            Requirement("", "ForgeLoop", (version(),))
        with pytest.raises(RequirementError, match="绑定一个项目"):
            Requirement("req-1", "", (version(),))

    def test_at_least_one_version_is_required(self) -> None:
        with pytest.raises(RequirementError, match="至少要有原始输入"):
            Requirement("req-1", "ForgeLoop", ())

    def test_versions_must_be_contiguous_from_one(self) -> None:
        with pytest.raises(RequirementError, match="连续递增"):
            requirement(version(1), version(3))

    def test_append_keeps_history_and_numbers_next_version(self) -> None:
        original = requirement(version(1, "第一版"))
        updated = original.append("补充材料", WHEN + timedelta(minutes=1))

        assert updated.version_count == 2
        assert [item.version for item in updated.versions] == [1, 2]
        assert updated.versions[0].text == "第一版"  # 历史不被覆盖
        assert updated.versions[1].text == "补充材料"

    def test_allocated_identities_are_unique_and_prefixed(self) -> None:
        first, second = allocate_requirement_id(), allocate_requirement_id()
        assert first.startswith("req-") and second.startswith("req-")
        assert first != second
