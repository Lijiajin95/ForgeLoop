"""git 工作副本：独立 clone、基线 checkout、候选 diff 提取与发布标签。

架构 §5 的落地：候选改动只在独立工作副本中产生，真实 main 不暴露写权限。
发布标签（S1）与候选分支/快进归并（S3 方案 B）也集中在本模块：它们都是
git 仓库现场操作，放 CLI 会破坏"CLI 只调用 adapter"的分层。
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


def _apply_diff(project: Path, diff_text: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(project), "apply", "--whitespace=nowarn", "-"],
        input=diff_text,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise WorkspaceError(f"git apply 失败：{result.stderr.strip()[:200]}")


def _require_clean_main(project: Path, baseline: str) -> None:
    """归并/候选分支前的现场约束：必须在 main、工作树干净且 HEAD 等于交付基线。"""

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


def list_branches(project: Path) -> tuple[str, ...]:
    output = _git(project, "branch", "--format=%(refname:short)")
    return tuple(line.strip() for line in output.splitlines() if line.strip())


def create_candidate_branch(
    project: Path, branch: str, baseline: str, diff_text: str, message: str
) -> str:
    """从交付基线创建候选分支并提交候选改动；main 不被触碰，失败不留半成品。

    与直接归并共用同一组现场约束（在 main、工作树干净、HEAD 等于基线）；
    任何一步失败都切回 main 并删除半成品分支，再抛出错误。
    """

    _require_clean_main(project, baseline)
    if branch in list_branches(project):
        raise WorkspaceError(f"候选分支已存在：{branch}；请先清理")
    _git(project, "switch", "--create", branch)
    try:
        _apply_diff(project, diff_text)
        _git(project, "add", "-A")
        _git(project, "-c", "user.useConfigOnly=true", "commit", "-m", message)
    except WorkspaceError:
        switch_to_main(project)
        _git(project, "branch", "--delete", "--force", branch)
        raise
    return _git(project, "rev-parse", "HEAD").strip()


def switch_to_main(project: Path) -> None:
    """把工作副本切回 main（候选分支保留供核对）。"""

    _git(project, "switch", "main")


def fast_forward_main(project: Path, branch: str) -> str:
    """把 main 快进到候选分支（只允许 fast-forward）；返回新的 main 提交号。"""

    _git(project, "switch", "main")
    result = subprocess.run(
        ["git", "-C", str(project), "merge", "--ff-only", branch],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise WorkspaceError(f"无法快进 main：{(result.stderr or result.stdout).strip()[:200]}")
    return _git(project, "rev-parse", "HEAD").strip()


def merge_candidate_to_main(project: Path, baseline: str, diff_text: str, message: str) -> str:
    """把已验收的候选 diff 受控归并到 project 的 main；返回合并提交号。

    前置（由领域规则判定）：任务已验收、diff 非空。此处再核对仓库现场：
    当前分支必须是 main 且工作树干净、HEAD 等于交付基线——任何不符都
    抛 WorkspaceError，不拼接差异、不沿用旧批准。
    """

    _require_clean_main(project, baseline)
    _apply_diff(project, diff_text)
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


def _push_ref(project: Path, ref: str, remote: str) -> tuple[bool, str]:
    """推送单个引用（分支或标签）；失败如实报告，不改状态。"""

    result = subprocess.run(
        ["git", "-C", str(project), "push", remote, ref],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    detail = (result.stdout or result.stderr).strip()[-400:]
    return result.returncode == 0, detail


def push_main(project: Path, remote: str = "origin") -> tuple[bool, str]:
    """推送 main 到远程（B04 含 GitHub 同步）；失败如实报告不改状态。"""

    return _push_ref(project, "main", remote)


def push_branch(project: Path, branch: str, remote: str = "origin") -> tuple[bool, str]:
    """推送候选分支到远程（S3 方案 B：先让检查在候选分支上跑）。"""

    return _push_ref(project, branch, remote)


def delete_branch(project: Path, branch: str, remote: str | None = None) -> tuple[bool, str]:
    """删除本地候选分支；给定 remote 时同时删除远程分支（失败如实返回）。"""

    _git(project, "branch", "--delete", "--force", branch)
    if remote is None:
        return True, ""
    result = subprocess.run(
        ["git", "-C", str(project), "push", remote, "--delete", branch],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    detail = (result.stdout or result.stderr).strip()[-400:]
    return result.returncode == 0, detail


def list_tags(project: Path) -> tuple[str, ...]:
    """列出现有标签（供发布前判定版本号是否已被占用）。"""

    output = _git(project, "tag", "--list")
    return tuple(line.strip() for line in output.splitlines() if line.strip())


def create_annotated_tag(project: Path, tag: str, commit: str, message: str) -> None:
    """在指定提交上创建 annotated tag；身份只读仓库配置，不自动探测。

    与受控归并一致使用 ``user.useConfigOnly=true``：缺少身份配置时宁可失败，
    也不用宿主名或邮箱臆造签名者。
    """

    _git(project, "-c", "user.useConfigOnly=true", "tag", "-a", tag, "-m", message, commit)


def push_tag(project: Path, tag: str, remote: str = "origin") -> tuple[bool, str]:
    """推送单个标签到远程（S1 触发 Release 构建）；失败如实报告不改状态。"""

    return _push_ref(project, tag, remote)


def tag_commit(project: Path, tag: str) -> str | None:
    """读取标签指向的提交号；标签不存在时返回 None（供部署判定使用，不抛错）。"""

    result = subprocess.run(
        ["git", "-C", str(project), "rev-parse", "--verify", f"{tag}^{{commit}}"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()
