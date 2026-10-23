"""需求受理场景：分配身份、保留原文与追加版本、按身份与项目回查、未知身份失败。

只覆盖领域规则与记录层：通过真实 SQLite 文件与独立子进程验证进程重启后仍可回查；
不同项目的需求按项目边界隔离；未知身份按身份回查必须明确失败。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from forgeloop.domain.requirement import RequirementNotFoundError
from forgeloop.records.requirements import RequirementStore

SRC = Path(__file__).resolve().parents[2] / "src"

SUBMIT_SCRIPT = """
import json
import sys
from pathlib import Path

from forgeloop.records.requirements import RequirementStore

store = RequirementStore(Path(sys.argv[1]))
try:
    req = store.submit(sys.argv[2], sys.argv[3])
    req = store.append(req.req_id, sys.argv[4])
    print(json.dumps({"req_id": req.req_id, "texts": [v.text for v in req.versions]},
                     ensure_ascii=False))
finally:
    store.close()
"""

APPEND_SCRIPT = """
import json
import sys
from pathlib import Path

from forgeloop.records.requirements import RequirementStore

store = RequirementStore(Path(sys.argv[1]))
try:
    before = store.get(sys.argv[2])
    after = store.append(sys.argv[2], sys.argv[3])
    print(json.dumps({"before": [v.text for v in before.versions],
                      "after": [v.text for v in after.versions]}, ensure_ascii=False))
finally:
    store.close()
"""

READ_SCRIPT = """
import json
import sys
from pathlib import Path

from forgeloop.records.requirements import RequirementStore

store = RequirementStore(Path(sys.argv[1]))
try:
    req = store.get(sys.argv[2])
    print(json.dumps({"req_id": req.req_id, "project": req.project,
                      "versions": [{"version": v.version, "text": v.text}
                                   for v in req.versions]}, ensure_ascii=False))
finally:
    store.close()
"""


def child_env() -> dict[str, str]:
    """子进程可导入 forgeloop：显式加入 src，沿用既有系统测试做法。"""

    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(part for part in (str(SRC), existing) if part)
    return env


def run_child(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", script, *args],
        capture_output=True,
        text=True,
        timeout=30,
        env=child_env(),
        check=False,
    )


class TestRestartPersistence:
    def test_original_and_appended_versions_survive_restart(self, tmp_path: Path) -> None:
        """提交原文后可在新进程回查全部版本，并继续追加第三个版本。"""

        db = tmp_path / "records.sqlite"
        submitted = run_child(
            SUBMIT_SCRIPT, str(db), "项目甲", "原始需求：加 status", "追加：同时输出 JSON"
        )
        assert submitted.returncode == 0, submitted.stderr
        first = json.loads(submitted.stdout)
        req_id = first["req_id"]
        assert req_id
        assert first["texts"] == ["原始需求：加 status", "追加：同时输出 JSON"]

        # 全新进程：先核对历史版本，再追加第三个版本。
        appended = run_child(APPEND_SCRIPT, str(db), req_id, "再追加：补充错误码")
        assert appended.returncode == 0, appended.stderr
        second = json.loads(appended.stdout)
        assert second["before"] == ["原始需求：加 status", "追加：同时输出 JSON"]
        assert second["after"] == [
            "原始需求：加 status",
            "追加：同时输出 JSON",
            "再追加：补充错误码",
        ]

        # 又一个全新进程：原文与全部追加版本仍可回查，版本号连续。
        reloaded = run_child(READ_SCRIPT, str(db), req_id)
        assert reloaded.returncode == 0, reloaded.stderr
        third = json.loads(reloaded.stdout)
        assert third["req_id"] == req_id
        assert third["project"] == "项目甲"
        assert [(v["version"], v["text"]) for v in third["versions"]] == [
            (1, "原始需求：加 status"),
            (2, "追加：同时输出 JSON"),
            (3, "再追加：补充错误码"),
        ]


class TestRequirementQueries:
    def test_append_keeps_original_text(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            created = store.submit("项目甲", "原始")
            updated = store.append(created.req_id, "追加")
            reloaded = store.get(created.req_id)
        finally:
            store.close()
        assert updated.original_text == "原始"
        assert reloaded.original_text == "原始"
        assert [version.version for version in reloaded.versions] == [1, 2]

    def test_projects_do_not_mix(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            first = store.submit("项目甲", "甲-原始")
            second = store.submit("项目甲", "甲-第二个需求")
            other = store.submit("项目乙", "乙-原始")
            store.append(first.req_id, "甲-追加")
            project_a = store.for_project("项目甲")
            project_b = store.for_project("项目乙")
        finally:
            store.close()
        assert {item.req_id for item in project_a} == {first.req_id, second.req_id}
        assert all(item.project == "项目甲" for item in project_a)
        assert [item.req_id for item in project_b] == [other.req_id]
        assert project_b[0].project == "项目乙"

    def test_unknown_project_has_no_requirements(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            store.submit("项目甲", "甲-原始")
            assert store.for_project("项目丙") == ()
        finally:
            store.close()

    def test_unknown_identity_fails_explicitly(self, tmp_path: Path) -> None:
        store = RequirementStore(tmp_path / "records.sqlite")
        try:
            with pytest.raises(RequirementNotFoundError):
                store.get("req-unknown")
            with pytest.raises(RequirementNotFoundError):
                store.append("req-unknown", "追加")
        finally:
            store.close()
