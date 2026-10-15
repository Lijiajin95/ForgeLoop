"""git 工作副本：独立 clone、基线 checkout、候选 diff 提取与发布标签。

架构 §5 的落地：候选改动只在独立工作副本中产生，真实 main 不暴露写权限。
发布标签（S1）与候选分支/快进归并（S3 方案 B）也集中在本模块：它们都是
git 仓库现场操作，放 CLI 会破坏"CLI 只调用 adapter"的分层。
- 副本用 ``git clone --no-hardlinks`` 建立完整独立副本（自有 .git 与引用，
  不与源仓库共享任何可写对象/引用——避免通过共享 Git 引用改写真实 main）。
  克隆后立刻删除指向源仓库的 ``origin``；否则副本内进程可以用
  ``git push origin main`` 直接改写源 main（host 模式下没有别的闸）。
- 基线以 detached HEAD checkout（默认分支或显式基线），实际基线提交号
  由 ``git rev-parse HEAD`` 记录，并写入副本内 ``refs/forgeloop/baseline``。
  候选 diff 始终对**那个**批准基线计算，而不是对当前 HEAD——PI 在副本内
  自行 commit 后 HEAD 会前移，若以 HEAD 为基线就会把已提交改动漏掉。
- 候选 diff = ``git add -A`` 后 ``git diff <基线提交>``：覆盖已修改、新增、
  删除与已提交的改动（工作树对基线的完整差异），不依赖 PI 的文本自述。
"""

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import cast

# 批准基线在副本内的落点：写进 .git 引用而不是工作树文件，
# 因此不会出现在候选 diff 里，也不会被 ``git add -A`` 采集。
BASELINE_REF = "refs/forgeloop/baseline"

# 已应用前置候选的工作副本本地标记：落在 .git 下，不进工作树、不进候选 diff。
# 它是「本副本已应用过该前置候选」的唯一判据，因此下游对前置文件的后续修改
# 不会让幂等判定误判成「尚未应用」而重复 apply（重复 apply 会失败并触发回退）。
_APPLIED_PREREQUISITES_NAME = "forgeloop-applied-prerequisites.json"


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


def recorded_baseline(workspace: Path) -> str | None:
    """读取副本内记录的批准基线；没有记录时返回 ``None``。"""

    result = subprocess.run(
        ["git", "-C", str(workspace), "rev-parse", "--verify", "--quiet", BASELINE_REF],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _record_baseline(workspace: Path, commit: str) -> None:
    _git(workspace, "update-ref", BASELINE_REF, commit)


def _drop_source_remote(workspace: Path) -> None:
    """删除指向源仓库的 ``origin``，切断从副本 ``git push`` 回写源 main 的路径。"""

    result = subprocess.run(
        ["git", "-C", str(workspace), "remote"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if "origin" in result.stdout.split():
        _git(workspace, "remote", "remove", "origin")


def prepare_workspace(source: Path, baseline: str, workspace: Path) -> str:
    """建立（或复用）独立工作副本并检出基线；返回实际批准基线提交号。

    幂等：workspace 已是 git 仓库时不再 clone（修复轮继续同一副本），并返回
    首次建立时记录的批准基线——即使 PI 已在副本内 commit，候选 diff 仍对
    原始基线计算，不会丢失已提交改动。旧副本缺少基线记录时用显式 *baseline*
    回填（无显式基线只能以当前 HEAD 回填），修复轮不再把新 HEAD 当成基线。
    """

    if not source.is_dir() or not (source / ".git").exists():
        raise WorkspaceError(f"project_path 不是 git 仓库: {source}")
    if is_git_workspace(workspace):
        _drop_source_remote(workspace)  # 旧副本也切断回写源 main 的路径
        recorded = recorded_baseline(workspace)
        if recorded:
            return recorded
        # 旧副本（B01 之前建立，没有 refs/forgeloop/baseline）：用显式批准基线
        # 回填，避免 PI 提交后 HEAD 前移被当成基线而丢掉已提交改动；没有显式
        # 基线时只能以当前 HEAD 回填，并如实暴露该限制。
        resolved = (
            _git(workspace, "rev-parse", f"{baseline}^{{commit}}").strip()
            if baseline
            else _git(workspace, "rev-parse", "HEAD").strip()
        )
        _record_baseline(workspace, resolved)
        return resolved
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
    _drop_source_remote(workspace)
    if baseline:
        _git(workspace, "checkout", "--detach", baseline)
    resolved = _git(workspace, "rev-parse", "HEAD").strip()
    _record_baseline(workspace, resolved)
    return resolved


def collect_candidate_change(workspace: Path, baseline: str | None = None) -> CandidateChange:
    """提取候选改动：暂存全部变更后取工作树对批准基线的完整 diff。

    基线优先取显式参数，其次取副本内记录的批准基线，最后回落到当前 HEAD
    （兼容未记录基线的旧副本）。对正式流程而言基线在 ``prepare_workspace``
    时固化，因此 PI 在副本内 commit 也不会让 diff 变空。
    """

    if not is_git_workspace(workspace):
        raise WorkspaceError(f"workspace 不是 git 仓库: {workspace}")
    resolved = (
        baseline or recorded_baseline(workspace) or _git(workspace, "rev-parse", "HEAD").strip()
    )
    _git(workspace, "add", "-A")
    diff = _git(workspace, "diff", resolved)
    return CandidateChange(baseline_commit=resolved, diff=diff)


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


def apply_diff_to_workspace(workspace: Path, diff_text: str) -> None:
    """把候选 diff 作为代码输入应用到工作副本；失败抛 :class:`WorkspaceError`。

    与受控归并共用同一底层 ``git apply``：应用不提交、不改写引用，成功与否
    如实返回，由调用方决定记录与回退。
    """

    _apply_diff(workspace, diff_text)


def apply_diff_to_workspace_three_way(workspace: Path, diff_text: str) -> None:
    """普通应用失败后，用三方合并容忍「同一改动已被其他前置带出」。

    菱形/冗余依赖下，后一个前置候选的 diff 本就包含前一个的改动（它是在已
    应用前者的副本里采集的）。先应用前者再普通 apply 后者会因 hunk 已存在而
    失败，但这不是产物缺失也不是校验不符。这里先暂存现场使索引与工作树一致，
    再让 git 按 blob 三方合并，只补上尚未应用的部分；真实冲突（git 返回非零并
    可能留下冲突标记）仍抛 :class:`WorkspaceError`，由调用方回退并如实记录。

    调用方保证仅在普通 apply 失败后使用；成功与否不改变任何引用。
    """

    # --3way 要求索引与工作树一致：先暂存当前现场，git 才能读到本副本内容。
    _git(workspace, "add", "-A")
    result = subprocess.run(
        ["git", "-C", str(workspace), "apply", "--3way", "--whitespace=nowarn", "-"],
        input=diff_text,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    if result.returncode != 0:
        raise WorkspaceError(f"git apply --3way 失败：{result.stderr.strip()[:200]}")


def diff_is_applied(workspace: Path, diff_text: str) -> bool:
    """反向检查候选 diff 是否已在工作副本生效；用于按现场判定幂等跳过。"""

    result = subprocess.run(
        ["git", "-C", str(workspace), "apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
        input=diff_text,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    return result.returncode == 0


def workspace_head(workspace: Path) -> str:
    """工作副本当前 HEAD 提交号（无可记录基线时的回退快照点）。"""

    return _git(workspace, "rev-parse", "HEAD").strip()


def reset_workspace(workspace: Path, commit: str) -> None:
    """把工作副本回退到指定提交的干净状态：丢弃工作树改动与未跟踪文件。

    只用于前置候选应用失败后的回退，确保不留半成品工作树；不触碰任何引用。
    """

    _git(workspace, "reset", "--hard", commit)
    _git(workspace, "clean", "-fd")


def _git_dir(workspace: Path) -> Path:
    """工作副本的 git 目录；相对路径相对 workspace 解析（兼容 .git 为文件的情形）。"""

    raw = _git(workspace, "rev-parse", "--git-dir").strip()
    path = Path(raw)
    return path if path.is_absolute() else workspace / path


def _applied_prerequisites_path(workspace: Path) -> Path:
    return _git_dir(workspace) / _APPLIED_PREREQUISITES_NAME


def applied_prerequisites(workspace: Path) -> frozenset[tuple[str, str]]:
    """读取本副本已应用的前置候选标识 ``(task_id, candidate_sha256)``。

    标记缺失、损坏或结构不符时按「未应用」处理：宁可让调用方按现场反向校验
    兜底，也不把损坏数据当成已应用而静默跳过。
    """

    path = _applied_prerequisites_path(workspace)
    if not path.is_file():
        return frozenset()
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    if not isinstance(raw, list):
        return frozenset()
    applied: set[tuple[str, str]] = set()
    for entry in cast("list[object]", raw):
        if not isinstance(entry, list):
            continue
        pair = cast("list[object]", entry)
        if len(pair) != 2 or not isinstance(pair[0], str) or not isinstance(pair[1], str):
            continue
        applied.add((pair[0], pair[1]))
    return frozenset(applied)


def mark_prerequisite_applied(workspace: Path, task_id: str, candidate_sha256: str) -> None:
    """记录本副本已应用某前置候选；写失败不抛错（调用方另有反向校验兜底）。"""

    path = _applied_prerequisites_path(workspace)
    applied = set(applied_prerequisites(workspace))
    applied.add((task_id, candidate_sha256))
    try:
        path.write_text(json.dumps(sorted(applied), ensure_ascii=False), encoding="utf-8")
    except OSError:
        return


def clear_applied_prerequisites(workspace: Path) -> None:
    """清空本副本的已应用标记；回退到基线后标记全部失效（回退失败不掩盖原错误）。"""

    try:
        _applied_prerequisites_path(workspace).unlink(missing_ok=True)
    except OSError:
        return


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
