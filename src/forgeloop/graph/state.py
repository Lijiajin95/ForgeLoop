"""LangGraph 任务状态：只放推进所需状态与文件引用。

原始日志、事件与会话文件不进检查点（架构 §3）；领域事实的权威记录
在 RecordStore，本状态只保留路由与续跑所需的最小字段。
"""

from typing import TypedDict


class TaskState(TypedDict, total=False):
    task_id: str
    plan_version: int
    dev_attempts: int
    failure_cumulative: int
    last_review_blocking: bool
    last_test_passed: bool
    needs_grant: bool
    acceptance_passed: bool
    halted_reason: str
