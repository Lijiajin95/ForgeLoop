"""git 工作副本：独立 clone、基线 checkout 与候选 diff 提取。

架构 §5 的落地：候选改动只在独立工作副本中产生，真实 main 不暴露写权限。
- 副本用 ``git clone --no-hardlinks`` 建立完整独立副本（自有 .git 与引用，
  不与源仓库共享任何可写对象/引用——避免通过共享 Git 引用改写真实 main）。
- 基线以 detached HEAD checkout（默认分支或显式基线），实际基线提交号
  由 ``git rev-parse HEAD`` 记录，交付时与 diff 一同固化。
- 候选 diff = ``git add -A`` 后 ``git diff <基线提交>``：覆盖已修改、新增、
  删除与已提交的改动（工作树对基线的完整差异），不依赖 PI 的文本自述。
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path


class WorkspaceError(RuntimeError):
    """git 工作副本操作失败（源缺失、基线无效或 git 不可用）。"""


@dataclass(frozen=True)
class CandidateChange:
    """一次候选改动：相对基线的 diff 与实际基线提交号。"""

    baseline_commit: str
    diff: str


def _git(workspace: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(workspace), *args],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise WorkspaceError(
            f"git {' '.join(args)} failed in {workspace}: {result.stderr.strip()[:200]}"
        )
    return result.stdout


def is_git_workspace(workspace: Path) -> bool:
    return (workspace / ".git").exists()


def prepare_workspace(source: Path, baseline: str, workspace: Path) -> str:
    """建立（或复用）独立工作副本并检出基线；返回实际基线提交号。

    幂等：workspace 已是 git 仓库时不再 clone（修复轮继续同一副本）。
    """

    if not source.is_dir() or not (source / ".git").exists():
        raise WorkspaceError(f"project_path 不是 git 仓库: {source}")
    if is_git_workspace(workspace):
        return _git(workspace, "rev-parse", "HEAD").strip()
    workspace.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "clone", "--no-hardlinks", str(source), str(workspace)],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise WorkspaceError(f"clone failed from {source}: {result.stderr.strip()[:200]}")
    if baseline:
        _git(workspace, "checkout", "--detach", baseline)
    return _git(workspace, "rev-parse", "HEAD").strip()


def collect_candidate_change(workspace: Path) -> CandidateChange:
    """提取候选改动：暂存全部变更后取工作树对基线的完整 diff。"""

    if not is_git_workspace(workspace):
        raise WorkspaceError(f"workspace 不是 git 仓库: {workspace}")
    baseline = _git(workspace, "rev-parse", "HEAD").strip()
    _git(workspace, "add", "-A")
    diff = _git(workspace, "diff", baseline)
    return CandidateChange(baseline_commit=baseline, diff=diff)
