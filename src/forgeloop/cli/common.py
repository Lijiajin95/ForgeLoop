"""CLI 命令共享的小助手：记录根目录解析、存储打开与统一失败输出。

拆出原因：``pylint max-module-lines=500`` 是启用中的门槛，main 入口接近上限；
各命令模块若各自再持一份助手，会同时引入重复与循环导入。集中一处既避免循环，
也让失败输出格式（``FAIL:`` 前缀 + stderr + 退出码 1）保持一致。
"""

import argparse
import sys
from pathlib import Path

from forgeloop.records.store import RecordStore


def records_root(args: argparse.Namespace) -> Path:
    """解析记录根目录；默认值由解析器提供（``--records-root``）。"""

    return Path(args.records_root)


def open_store(root: Path, task_id: str) -> RecordStore:
    """打开记录存储；任务不存在时以确定的失败退出，不返回半初始化对象。"""

    store = RecordStore(root / "records.sqlite")
    if store.get_task(task_id) is None:
        store.close()
        raise SystemExit(f"任务不存在: {task_id}")
    return store


def fail(message: str) -> int:
    """统一失败输出：写 stderr 并返回非零退出码。"""

    print(f"FAIL: {message}", file=sys.stderr)
    return 1
