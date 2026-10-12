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


def read_main_head(project: Path) -> str:
    """读取目标仓库 main 当前 HEAD（供领域漂移判定）。"""

    return _git(project, "rev-parse", "HEAD").strip()


def has_remote(project: Path, remote: str = "origin") -> bool:
    """目标仓库是否配置了指定远程（决定是否同步推送）。"""

    result = subprocess.run(
        ["git", "-C", str(project), "remote"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    return remote in result.stdout.split()


def merge_candidate_to_main(project: Path, baseline: str, diff_text: str, message: str) -> str:
    """把已验收的候选 diff 受控归并到 project 的 main；返回合并提交号。

    前置（由领域规则判定）：任务已验收、diff 非空。此处再核对仓库现场：
    当前分支必须是 main 且工作树干净、HEAD 等于交付基线——任何不符都
    抛 WorkspaceError，不拼接差异、不沿用旧批准。
    """

    branch = _git(project, "rev-parse", "--abbrev-ref", "HEAD").strip()
    if branch != "main":
        raise WorkspaceError(f"目标仓库当前分支是 {branch}，不是 main")
    dirty = _git(project, "status", "--porcelain").strip()
    if dirty:
        raise WorkspaceError(f"目标仓库工作树不干净：{dirty[:200]}")
    head = _git(project, "rev-parse", "HEAD").strip()
    if head != baseline:
        raise WorkspaceError(
            f"main 已漂移：交付基线 {baseline[:12]}，当前 {head[:12]}；须重新执行任务"
        )
    apply_result = subprocess.run(
        ["git", "-C", str(project), "apply", "--whitespace=nowarn", "-"],
        input=diff_text,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if apply_result.returncode != 0:
        raise WorkspaceError(f"git apply 失败：{apply_result.stderr.strip()[:200]}")
    _git(project, "add", "-A")
    _git(
        project,
        "-c",
        "user.useConfigOnly=true",
        "commit",
        "-m",
        message,
    )
    return _git(project, "rev-parse", "HEAD").strip()


def push_main(project: Path, remote: str = "origin") -> tuple[bool, str]:
    """推送 main 到远程（B04 含 GitHub 同步）；失败如实报告不改状态。"""

    result = subprocess.run(
        ["git", "-C", str(project), "push", remote, "main"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    detail = (result.stdout or result.stderr).strip()[-400:]
    return result.returncode == 0, detail
