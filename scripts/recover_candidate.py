"""Bootstrap 恢复：采纳工作副本已有改动为候选，并让图从审查节点继续。

适用情形（所有者授权的最小 bootstrap）：dev 会话因 provider 连接错误未 settle，
但工作副本里的实现已完成、批准测试命令能通过；正常流程无法捕获候选，因为 dev 节点
在拿到明确结果前不会写 ``candidate.diff``。

本工具只做两件事，且都不创建提交：
1. 从任务工作副本的 git 取完整改动（含未跟踪新文件，用 ``git add -N`` 后 ``git diff``，
   取完恢复索引原状）写入 ``candidate.diff``（与 dev 节点同一来源、同一位置）；
2. 以 ``as_node="dev"`` 更新图状态（清除 halted_reason、把采纳记为一次开发尝试），
   随后继续执行图：真实审查 → 正式测试 → 停在验收门。

采纳事实与原因写入任务目录 ``recovery-note.json``，供交付记录追溯。
"""

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from forgeloop.cli.main import _build_runtime, _close_runtime, _run_config


def _git(workspace: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args], check=True, capture_output=True, text=True
    )
    return result.stdout


def capture_candidate_diff(workspace: Path) -> str:
    """取副本工作树的完整改动（含未跟踪新文件）；不创建提交，取完恢复索引原状。"""

    _git(workspace, "add", "-N", ".")
    try:
        return _git(workspace, "diff")
    finally:
        _git(workspace, "reset", "-q")


def _changed_files(diff_text: str) -> list[str]:
    return sorted(
        line.split(" b/", 1)[1]
        for line in diff_text.splitlines()
        if line.startswith("diff --git ") and " b/" in line
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id")
    parser.add_argument("--records-root", type=Path, required=True)
    parser.add_argument(
        "--reason", default="dev 会话因 provider 连接错误未 settle，采纳副本已有改动"
    )
    args = parser.parse_args()

    store, ctx, graph = _build_runtime(args.records_root, args.task_id)
    try:
        diff_text = capture_candidate_diff(ctx.workspace)
        if not diff_text.strip():
            print("工作副本没有改动，无需恢复", file=sys.stderr)
            return 1
        candidate = ctx.task_dir / "candidate.diff"
        candidate.write_text(diff_text, encoding="utf-8")
        state = graph.get_state(_run_config(args.task_id)).values
        adopted_attempt = int(state.get("dev_attempts") or 0) + 1
        note = {
            "task_id": args.task_id,
            "kind": "bootstrap_adopt_workspace",
            "reason": args.reason,
            "adopted_at": datetime.now(UTC).isoformat(),
            "previous_halted_reason": state.get("halted_reason"),
            "candidate_diff_sha256": hashlib.sha256(diff_text.encode("utf-8")).hexdigest(),
            "changed_files": _changed_files(diff_text),
            "adopted_attempt": adopted_attempt,
        }
        (ctx.task_dir / "recovery-note.json").write_text(
            json.dumps(note, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            f"已采纳候选：{len(note['changed_files'])} 个文件，sha256={note['candidate_diff_sha256'][:12]}"
        )
        graph.update_state(
            _run_config(args.task_id),
            {"halted_reason": None, "dev_attempts": adopted_attempt},
            as_node="dev",
        )
        graph.invoke(None, _run_config(args.task_id))
        task = store.get_task(args.task_id)
        pending = graph.get_state(_run_config(args.task_id)).next
        print(f"状态: {task.status if task else 'unknown'}")
        if pending:
            print(f"等待节点: {', '.join(pending)}")
        print(f"请核对恢复说明: {ctx.task_dir / 'recovery-note.json'}")
        return 0
    finally:
        _close_runtime(graph)
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
