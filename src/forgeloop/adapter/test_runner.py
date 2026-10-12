"""正式测试命令运行器：程序执行批准的命令，记录实际退出码与输出。

规则来源（首版需求 V0-05）：测试结果来自程序运行的实际命令，
不能只读取 Agent 声称通过；实际退出码、stdout、stderr 与超时如实记录。
"""

import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


@dataclass(frozen=True)
class TestRunOutcome:
    command: tuple[str, ...]
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    started_at: str
    finished_at: str


def run_test_command(
    command: Sequence[str],
    cwd: Path,
    timeout_seconds: float,
    evidence_path: Path,
) -> TestRunOutcome:
    """运行批准的测试命令并把证据追加到 evidence_path（JSONL）。"""

    if not command:
        raise ValueError("Test command must not be empty")
    if timeout_seconds <= 0:
        raise ValueError("Test timeout must be positive")
    started_at = datetime.now(UTC).isoformat()
    try:
        completed = subprocess.run(
            list(command),
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            shell=False,
            check=False,
        )
        outcome = TestRunOutcome(
            command=tuple(command),
            exit_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            timed_out=False,
            started_at=started_at,
            finished_at=datetime.now(UTC).isoformat(),
        )
    except subprocess.TimeoutExpired as expired:
        outcome = TestRunOutcome(
            command=tuple(command),
            exit_code=None,
            stdout=(expired.stdout or b"").decode("utf-8", errors="replace")
            if isinstance(expired.stdout, bytes)
            else (expired.stdout or ""),
            stderr=(expired.stderr or b"").decode("utf-8", errors="replace")
            if isinstance(expired.stderr, bytes)
            else (expired.stderr or ""),
            timed_out=True,
            started_at=started_at,
            finished_at=datetime.now(UTC).isoformat(),
        )
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    with evidence_path.open("a", encoding="utf-8") as evidence_file:
        evidence_file.write(json.dumps(outcome.__dict__, ensure_ascii=False) + "\n")
    return outcome
