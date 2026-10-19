"""git 工作副本：项目镜像 + worktree、基线记录、候选 diff 提取与发布标签。

架构 §5 的落地：候选改动只在独立工作副本中产生，真实 main 不暴露写权限。
发布标签（S1）与候选分支/快进归并（S3 方案 B）也集中在本模块：它们都是
git 仓库现场操作，放 CLI 会破坏"CLI 只调用 adapter"的分层。

工作副本的当前形态是 **git worktree**，但宿主不是源仓库，而是每个项目自己的
bare 镜像（``<项目记录根>/repo.git``）：

- 项目登记时 ``git clone --bare`` 建立镜像并立即删除 ``origin``；每次新建任务
  现场时用显式源路径 fetch 到 ``refs/forgeloop/source/*``，不把源仓库留成远程。
  worktree 共享的是**镜像**的对象与引用，不是源仓库的；因此 worktree 内
  ``git push origin main`` 不会改写源 main。
- 每个任务用 ``git worktree add --detach <现场> <基线提交>`` 建立。基线提交
  记录在**该 worktree 私有的 gitdir** 的 ``forgeloop-baseline`` 文件里，而不是
  镜像的共享引用：同项目多个任务并发时不会互相覆盖批准基线。旧 clone 副本仍
  读取 ``refs/forgeloop/baseline``，保持向后兼容。
- 候选 diff = ``git add -A`` 后 ``git diff <批准基线>``：覆盖已修改、新增、
  删除与已提交的改动（工作树对基线的完整差异），不依赖 PI 的文本自述。
- PI 在 worktree 内 commit 只写入镜像对象库，不会移动源仓库的 main；修复轮
  复用同一 worktree，基线仍取首次记录的批准提交。
"""

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import cast

# 批准基线在旧 clone 副本内的落点：写进 .git 引用而不是工作树文件，
# 因此不会出现在候选 diff 里，也不会被 ``git add -A`` 采集。
BASELINE_REF = "refs/forgeloop/baseline"
# worktree 私有 gitdir 内的基线文件名；同一镜像下的多个 worktree 各有一份。
BASELINE_FILENAME = "forgeloop-baseline"
# 项目仓库镜像目录名（位于项目记录根下）。
MIRROR_DIRNAME = "repo.git"
# 派生镜像（未显式给出 mirror 时）的目录名；位于任务目录的父目录下。
DERIVED_MIRROR_DIRNAME = ".repos"
# 显式 fetch 源仓库的写入命名空间：不占用镜像的本地分支，也不留下 origin。
SOURCE_REF_PREFIX = "refs/forgeloop/source"

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


def _git_result(
    workspace: Path | None,
    *args: str,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """运行 git 并返回完整结果；调用方负责把非零退出码转成明确错误。"""

    command = ["git", *args] if workspace is None else ["git", "-C", str(workspace), *args]
    return subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )


def recorded_baseline(workspace: Path) -> str | None:
    """读取工作副本记录的批准基线；没有记录时返回 ``None``。

    worktree 的基线在私有 gitdir 的 ``forgeloop-baseline`` 文件里（项目镜像下
    多个 worktree 各一份，互不覆盖）；旧 clone 副本没有该文件时回退读取
    ``refs/forgeloop/baseline``。文件损坏或为空时继续尝试旧引用，不把空值当基线。
    """

    try:
        path = _git_dir(workspace) / BASELINE_FILENAME
    except WorkspaceError:
        return None
    if path.is_file():
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            text = ""
        if text:
            return text
    result = _git_result(workspace, "rev-parse", "--verify", "--quiet", BASELINE_REF)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _record_baseline(workspace: Path, commit: str) -> None:
    """把批准基线写到该工作副本私有的 gitdir；旧 clone 仍同步维护旧引用。"""

    (_git_dir(workspace) / BASELINE_FILENAME).write_text(commit, encoding="utf-8")
    if (workspace / ".git").is_dir():
        _git(workspace, "update-ref", BASELINE_REF, commit)


def _drop_source_remote(workspace: Path) -> None:
    """删除指向源仓库的 ``origin``，切断从副本 ``git push`` 回写源 main 的路径。"""

    result = _git_result(workspace, "remote")
    if "origin" in result.stdout.split():
        _git(workspace, "remote", "remove", "origin")


def _derived_mirror(workspace: Path, source: Path) -> Path:
    """未显式给出镜像时的派生位置：任务目录的父目录（记录根）下按源路径散列。"""

    key = hashlib.sha256(str(source.resolve()).encode("utf-8")).hexdigest()[:16]
    return workspace.parent.parent / DERIVED_MIRROR_DIRNAME / f"{key}.git"


def _ensure_mirror(source: Path, mirror: Path) -> None:
    """建立或刷新项目 bare 镜像；镜像不保留指向源仓库的远程。"""

    if not mirror.exists():
        mirror.parent.mkdir(parents=True, exist_ok=True)
        result = _git_result(None, "clone", "--bare", "--no-hardlinks", str(source), str(mirror))
        if result.returncode != 0:
            raise WorkspaceError(f"clone failed from {source}: {result.stderr.strip()[:200]}")
    _drop_source_remote(mirror)
    result = _git_result(
        mirror,
        "fetch",
        "--force",
        "--no-tags",
        str(source),
        f"+refs/heads/*:{SOURCE_REF_PREFIX}/heads/*",
        f"+HEAD:{SOURCE_REF_PREFIX}/HEAD",
    )
    if result.returncode != 0:
        raise WorkspaceError(f"fetch failed from {source}: {result.stderr.strip()[:200]}")


def ensure_project_mirror(source: Path, mirror: Path) -> None:
    """建立或刷新项目 bare 镜像；项目登记与迁移入口共用同一实现。"""

    if not source.is_dir() or not (source / ".git").exists():
        raise WorkspaceError(f"project_path 不是 git 仓库: {source}")
    _ensure_mirror(source, mirror)


def _resolve_commit(mirror: Path, baseline: str) -> str:
    """解析基线提交：显式基线优先，否则用本次从源仓库 fetch 的 HEAD。"""

    reference = f"{baseline}^{{commit}}" if baseline else f"{SOURCE_REF_PREFIX}/HEAD^{{commit}}"
    result = _git_result(mirror, "rev-parse", "--verify", "--quiet", reference)
    if result.returncode != 0:
        detail = f"基线不存在: {baseline}" if baseline else f"无法解析源仓库 HEAD: {mirror}"
        raise WorkspaceError(detail)
    return result.stdout.strip()


def prepare_workspace(
    source: Path,
    baseline: str,
    workspace: Path,
    *,
    mirror: Path | None = None,
) -> str:
    """建立（或复用）一个任务 worktree；返回实际批准基线提交号。

    新现场从项目 bare 镜像 ``git worktree add --detach`` 建立，镜像由 *mirror*
    指定（CLI 传项目记录根下的 ``repo.git``）；未指定时在记录根下派生一个
    散列命名的镜像，供单元测试与独立调用使用。源仓库本身从不作为 worktree
    宿主，也不会被写入任何引用。

    幂等：workspace 已是 git 仓库时不再创建（修复轮继续同一现场），并返回
    首次建立时记录的批准基线——即使 PI 已在 worktree 内 commit，候选 diff 仍对
    原始基线计算。旧副本缺少基线记录时用显式 *baseline* 回填（无显式基线时
    只能以当前 HEAD 回填），修复轮不再把新 HEAD 当成基线。
    """

    if not source.is_dir() or not (source / ".git").exists():
        raise WorkspaceError(f"project_path 不是 git 仓库: {source}")
    if is_git_workspace(workspace):
        _drop_source_remote(workspace)  # 旧副本也切断回写源 main 的路径
        recorded = recorded_baseline(workspace)
        if recorded:
            return recorded
        # 旧副本（没有 for/legacy 基线记录）：用显式批准基线回填，避免 PI 提交后
        # HEAD 前移被当成基线而丢掉已提交改动；没有显式基线时只能以当前 HEAD 回填。
        resolved = (
            _git(workspace, "rev-parse", f"{baseline}^{{commit}}").strip()
            if baseline
            else _git(workspace, "rev-parse", "HEAD").strip()
        )
        _record_baseline(workspace, resolved)
        return resolved
    host = _derived_mirror(workspace, source) if mirror is None else mirror
    _ensure_mirror(source, host)
    commit = _resolve_commit(host, baseline)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    if workspace.exists():
        # 旧现场可能是一个空的占位目录（历史测试或人工预建）：worktree add 不会
        # 覆盖已存在路径，空目录可安全移除；非空且不是 git 现场时明确失败。
        if any(workspace.iterdir()):
            raise WorkspaceError(f"workspace 已存在且不是 git 现场: {workspace}")
        workspace.rmdir()
    result = _git_result(host, "worktree", "add", "--detach", str(workspace), commit)
    if result.returncode != 0:
        raise WorkspaceError(f"git worktree add failed in {host}: {result.stderr.strip()[:200]}")
    _record_baseline(workspace, commit)
    return commit


def remove_workspace(workspace: Path, *, mirror: Path | None = None) -> None:
    """删除一个 worktree 并清理镜像的 worktree 登记；不是 git 现场时静默跳过。

    只用于人工清理与测试收尾；调用方负责先确认现场可以丢弃。``mirror`` 缺省时
    从 worktree 的 common gitdir 反查宿主镜像。
    """

    if not is_git_workspace(workspace):
        return
    host = mirror
    if host is None:
        common = Path(_git(workspace, "rev-parse", "--git-common-dir").strip())
        host = common if common.is_absolute() else (workspace / common).resolve()
    result = _git_result(host, "worktree", "remove", "--force", str(workspace))
    if result.returncode != 0:
        raise WorkspaceError(f"git worktree remove failed in {host}: {result.stderr.strip()[:200]}")
    _git_result(host, "worktree", "prune")


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
