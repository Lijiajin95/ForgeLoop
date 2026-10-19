"""``cli.common`` 记录根解析的边界：项目登记缺失、任务定位失败与无项目回退。"""

import argparse
from pathlib import Path

import pytest
from project_support import project_records, register_project

from forgeloop.cli.common import base_records_root, open_task, project_for_name, records_root


def args_for(tmp_path: Path, **extra: str) -> argparse.Namespace:
    return argparse.Namespace(records_root=str(tmp_path), **extra)


class TestRecordsRootResolution:
    def test_without_project_returns_registration_root(self, tmp_path: Path) -> None:
        assert records_root(args_for(tmp_path)) == tmp_path
        assert base_records_root(args_for(tmp_path)) == tmp_path

    def test_with_project_returns_project_root(self, tmp_path: Path) -> None:
        register_project(tmp_path)

        assert records_root(args_for(tmp_path, project="forgeloop")) == project_records(tmp_path)

    def test_unknown_project_fails(self, tmp_path: Path) -> None:
        register_project(tmp_path)

        with pytest.raises(SystemExit, match="未登记"):
            records_root(args_for(tmp_path, project="missing"))


class TestLocators:
    def test_unknown_project_name_fails(self, tmp_path: Path) -> None:
        register_project(tmp_path)

        with pytest.raises(SystemExit, match="未登记"):
            project_for_name(tmp_path, "missing")

    def test_open_task_unknown_identity_fails(self, tmp_path: Path) -> None:
        register_project(tmp_path)

        with pytest.raises(SystemExit, match="任务"):
            open_task(tmp_path, "task-does-not-exist")
