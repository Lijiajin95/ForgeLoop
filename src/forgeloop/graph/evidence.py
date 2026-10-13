"""失败回边的真实证据：读取上一轮正式测试与审查结果，供实现会话修复。

原始记录（``test-run.jsonl`` 与 ``reviews.jsonl``）是唯一来源：失败回边不靠模型
自述，也不猜测缺失内容。输出按固定上限截断后放进实现提示词，避免无界提示词；
记录缺失或损坏时按"无证据"处理（此时实现会话与首次尝试一样工作）。
"""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.adapter.git_workspace import (
    WorkspaceError,
    collect_candidate_change,
    is_git_workspace,
)

FAILURE_TAIL_LIMIT = 2000
TEST_EVIDENCE_NAME = "test-run.jsonl"
PARTIAL_CANDIDATE_NAME = "partial-candidate.diff"
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


def capture_partial_candidate(task_dir: Path, workspace: Path, halted_reason: str) -> bool:
    """dev 未取得明确结果时，把副本已有改动落盘为**部分候选**，供人工核对与恢复。

    只写 ``partial-candidate.diff`` 与 ``partial-candidate.json``，**绝不写 candidate.diff**：
    部分候选不得进入自动审查与验收流程——那等于放行不完整交付。真实故障（provider 断连、
    调用超时）下模型往往已经改了若干文件，落盘能避免工作丢失，并让恢复有据可查。
    """

    if not is_git_workspace(workspace):
        return False
    try:
        change = collect_candidate_change(workspace)
    except WorkspaceError:
        # 采集失败不能掩盖原始中断原因：只放弃部分候选，不改写 halted_reason。
        return False
    if not change.diff.strip():
        return False
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / PARTIAL_CANDIDATE_NAME).write_text(change.diff, encoding="utf-8")
    note = {
        "halted_reason": halted_reason,
        "captured_at": datetime.now(UTC).isoformat(),
        "baseline_commit": change.baseline_commit,
        "diff_sha256": hashlib.sha256(change.diff.encode("utf-8")).hexdigest(),
        "changed_files": sorted(
            line.split(" b/", 1)[1]
            for line in change.diff.splitlines()
            if line.startswith("diff --git ") and " b/" in line
        ),
        "note": "部分候选：仅供人工核对/恢复，不进入自动审查与验收",
    }
    (task_dir / "partial-candidate.json").write_text(
        json.dumps(note, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return True
