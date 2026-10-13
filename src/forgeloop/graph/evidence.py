"""失败回边的真实证据：读取上一轮正式测试与审查结果，供实现会话修复。

原始记录（``test-run.jsonl`` 与 ``reviews.jsonl``）是唯一来源：失败回边不靠模型
自述，也不猜测缺失内容。输出按固定上限截断后放进实现提示词，避免无界提示词；
记录缺失或损坏时按"无证据"处理（此时实现会话与首次尝试一样工作）。
"""

import json
from pathlib import Path

FAILURE_TAIL_LIMIT = 2000
TEST_EVIDENCE_NAME = "test-run.jsonl"
REVIEW_EVIDENCE_NAME = "reviews.jsonl"


def tail(value: object, limit: int = FAILURE_TAIL_LIMIT) -> str:
    """截取文本尾部（非字符串或空值返回空串）。"""

    if not isinstance(value, str) or not value:
        return ""
    return value[-limit:] if len(value) > limit else value


def last_jsonl_entry(path: Path) -> dict:
    """读取 JSONL 的最后一条非空记录；缺失、损坏或非对象时返回空字典。"""

    if not path.exists():
        return {}
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return {}
    try:
        entry = json.loads(lines[-1])
    except json.JSONDecodeError:
        return {}
    return entry if isinstance(entry, dict) else {}


def previous_failure_context(task_dir: Path) -> dict:
    """上一轮真实失败证据：正式测试退出码与输出尾部、审查阻断问题。"""

    failure: dict = {}
    test_entry = last_jsonl_entry(task_dir / TEST_EVIDENCE_NAME)
    exit_code = test_entry.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        failure["formal_test"] = {
            "exit_code": exit_code,
            "stdout_tail": tail(test_entry.get("stdout")),
            "stderr_tail": tail(test_entry.get("stderr")),
        }
    issues = last_jsonl_entry(task_dir / REVIEW_EVIDENCE_NAME).get("blocking_issues")
    if isinstance(issues, list) and issues:
        failure["review_blocking_issues"] = [str(issue) for issue in issues]
    return failure
