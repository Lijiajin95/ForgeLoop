"""仓库布局事实与任务包合规校验（纯规则）。

规划阶段把仓库的固定布局作为事实注入提示词，并校验模型产出的任务包：

- 文件清单必须落在已知源码层、源码根精确顶层文件、测试层（含测试根顶层
  共享文件）、文档、辅助目录（含 ``.github`` 树）、已知契约快照或已知顶层文件，
  且末段必须是文件名——不得把目录或“文件名前缀”当成文件路径，也不得臆造
  源码根/测试根顶层的模块或测试文件；
- 测试命令必须使用可用解释器（``uv run``/``python3``）或已知门禁命令。

校验逐条给出具体路径/命令与原因，由规划调用方据此拒绝任务包并要求重规划，
不静默接受。合法源码分层不再硬编码，而是从机读架构事实
``contracts/architecture.json`` 的 ``modules`` 与 ``layer_edges`` 动态解析，
因此架构契约变更后无需改代码即可生效；仓库布局变化仍由架构契约门禁
（``docs/architecture.md`` 与 ``contracts/architecture.json``）强制同步。

本模块是纯规则层，只依赖标准库与 ``forgeloop.domain`` 内的同层模块；不依赖
``cli`` / ``graph`` / ``adapter`` / ``langgraph``。契约定位从模块文件与当前工作
目录沿父目录向上查找，兼顾源码树、wheel 安装后从项目根运行与 mutmut 的
``mutants/`` 副本；找不到（或损坏）契约时导入仍成功，默认事实退化为“架构未知”
并让路径校验 fail-closed，而不是让 ``--help`` 或测试收集崩溃。纯函数
:func:`parse_architecture_contract` 也可直接接受调用方传入的机读事实。
"""

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypedDict, cast

from forgeloop.domain.task_plan import TaskPlan

# 机读架构事实：合法源码分层从这里动态读取，不再硬编码层名清单。
# 不把绝对路径固定为 ``parents[3]``：wheel 安装与 mutmut 副本的目录深度不同。
ARCHITECTURE_CONTRACT = "contracts/architecture.json"
# 源码根顶层文件（不在分层目录内）：精确清单，避免把臆造顶层文件当成合法。
SOURCE_ROOT_FILES = ("__init__.py", "__main__.py")

# 已知无扩展名的点文件：点号开头的段默认按目录处理（挡住 .github 这类点目录），
# 但真实的点文件需要放行。带扩展名的点文件（如 frontend/.prettierrc.json）由
# 「点号数量 ≥ 2」判定；无扩展名的点文件在此精确登记。
DOTFILES_WITHOUT_EXTENSION = (".prettierignore",)

# 测试根与测试分层：tests/ 下的一级目录。
TEST_ROOT = "tests"
TEST_LAYERS = (
    "unit",
    "property",
    "component",
    "scenario",
    "integration",
    "system",
    "fixtures",
)
# 测试根顶层共享文件：精确清单（真实存在，必须放行），其余顶层臆造文件拒绝。
TEST_ROOT_FILES = ("conftest.py", "project_support.py")

# 契约快照：规划任务可显式更新这两个机读事实，不得臆造其它契约文件名。
CONTRACT_SNAPSHOTS = ("contracts/cli-contract.json", "contracts/architecture.json")
# 架构描述文档：模块清单必须与源码互为镜像。
ARCHITECTURE_DOC = "docs/architecture.md"

# 除源码/测试/契约外允许出现的已知目录（允许其子树）与顶层文件。
# .github 是 git 跟踪的真实 CI 配置树，属于可修改的仓库事实。
# frontend 是 B01 只读状态页引入的 TypeScript 前端树（含其工具链配置与锁文件），
# 同样是真实跟踪的仓库事实；登记它使 test_every_tracked_path_is_legal 不再误拒。
AUXILIARY_ROOTS = ("config", "docs", "frontend", "runtime", "scripts", ".github")
TOP_LEVEL_FILES = (
    ".gitignore",
    ".pre-commit-config.yaml",
    ".python-version",
    ".semgrep.yml",
    "AGENTS.md",
    "CONTEXT.md",
    "CONTRIBUTING.md",
    "Makefile",
    "README.md",
    "pyproject.toml",
    "uv.lock",
)

# 可用解释器前缀：前两段相同的命令视为使用该解释器。
INTERPRETERS = (("uv", "run"), ("python3",))
# 已知门禁命令：规划可把整体门禁作为任务的正式测试命令。
GATE_COMMANDS = (
    ("make", "check"),
    ("make", "coverage"),
    ("make", "test-system"),
    ("make", "test"),
)


class RepoFactsError(ValueError):
    """任务包违反仓库布局事实，或架构契约不可用；据此拒绝并要求重规划。"""


@dataclass(frozen=True)
class ArchitectureFacts:
    """从机读架构契约解析出的源码根与合法目录分层。"""

    source_root: str
    source_layers: tuple[str, ...]


def _is_directory_layer(name: str) -> bool:
    """目录分层必须是普通标识符；``(root)`` 与 ``__main__`` 是结构哨兵。"""

    return name.isidentifier() and not (name.startswith("__") and name.endswith("__"))


def _contract_edges(raw: object) -> tuple[tuple[str, str], ...]:
    """解析 ``layer_edges``；形状不合法或缺失时返回空元组。"""

    if not isinstance(raw, list):
        return ()
    edges: list[tuple[str, str]] = []
    for item in cast("list[object]", raw):
        if not isinstance(item, list):
            continue
        pair = cast("list[object]", item)
        if len(pair) == 2 and isinstance(pair[0], str) and isinstance(pair[1], str):
            edges.append((pair[0], pair[1]))
    return tuple(edges)


def _order_layers(layers: Sequence[str], edges: Sequence[tuple[str, str]]) -> tuple[str, ...]:
    """按依赖先行排序：先生成基础层，同批就绪时取层名逆序以保证确定性。"""

    unique = sorted(set(layers), reverse=True)
    dependencies: dict[str, set[str]] = {layer: set() for layer in unique}
    for source, target in edges:
        if source in dependencies and target in dependencies and source != target:
            dependencies[source].add(target)
    ordered: list[str] = []
    remaining = set(unique)
    while remaining:
        satisfied = set(ordered)
        ready = [layer for layer in remaining if dependencies[layer] <= satisfied]
        chosen = max(ready) if ready else max(remaining)
        ordered.append(chosen)
        remaining.discard(chosen)
    return tuple(ordered)


def parse_architecture_contract(payload: object) -> ArchitectureFacts:
    """从机读架构事实解析源码根与合法源码分层（不读文件系统）。

    ``modules`` 的层值去掉结构哨兵后即为合法目录分层；``layer_edges`` 用于把
    基础层排在依赖层之前，并让清单不随契约键序变化保持确定性。契约缺少必要
    字段或未登记任何目录分层时抛出 :class:`RepoFactsError`。
    """

    if not isinstance(payload, Mapping):
        raise RepoFactsError("架构契约不是 JSON 对象")
    contract = cast("Mapping[str, object]", payload)
    source_root = contract.get("source_root")
    if not isinstance(source_root, str) or not source_root:
        raise RepoFactsError("架构契约缺少 source_root")
    modules = contract.get("modules")
    if not isinstance(modules, Mapping):
        raise RepoFactsError("架构契约缺少 modules 映射")
    registered = [
        value for value in cast("Mapping[str, object]", modules).values() if isinstance(value, str)
    ]
    directory_layers = [name for name in registered if _is_directory_layer(name)]
    if not directory_layers:
        raise RepoFactsError("架构契约未登记任何合法源码目录分层")
    ordered = _order_layers(directory_layers, _contract_edges(contract.get("layer_edges")))
    return ArchitectureFacts(source_root=source_root, source_layers=ordered)


def architecture_contract_candidates(anchor: Path | None = None) -> tuple[Path, ...]:
    """按优先级列出机读架构契约的候选路径（可能都不存在）。

    覆盖三类运行现场：源码树/可编辑安装（相对 ``repo_facts`` 模块向上）、wheel
    安装后从被测项目根运行（相对当前工作目录向上），以及显式 ``anchor``（测试
    注入）。从每个锚点沿父目录向上查找，使 mutmut 的 ``mutants/`` 工作副本也能
    命中所属仓库根下的 ``contracts/``。
    """

    anchors = (anchor,) if anchor is not None else (Path(__file__).resolve().parent, Path.cwd())
    candidates: list[Path] = []
    for base in anchors:
        start = base if base.is_dir() else base.parent
        for parent in (start, *start.parents):
            candidate = parent / ARCHITECTURE_CONTRACT
            if candidate not in candidates:
                candidates.append(candidate)
    return tuple(candidates)


def resolve_architecture_contract(anchor: Path | None = None) -> Path | None:
    """定位第一个真实存在的机读架构契约；找不到时返回 ``None``（不抛错）。"""

    return next(
        (path for path in architecture_contract_candidates(anchor) if path.is_file()),
        None,
    )


def load_architecture_contract(path: Path | None = None) -> ArchitectureFacts:
    """读取并解析机读架构事实；文件缺失或非法时抛出 :class:`RepoFactsError`。

    ``path`` 为 ``None`` 时按 :func:`resolve_architecture_contract` 自动定位；
    找不到契约同样抛错，供显式加载调用。导入期的默认事实改走
    :func:`_default_architecture_facts` 安全降级，不把缺失契约变成导入失败。
    """

    if path is None:
        path = resolve_architecture_contract()
    if path is None:
        raise RepoFactsError("未找到架构契约 contracts/architecture.json")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise RepoFactsError(f"无法读取架构契约 {path}：{error}") from error
    except ValueError as error:
        raise RepoFactsError(f"架构契约不是合法 JSON {path}：{error}") from error
    return parse_architecture_contract(payload)


def _default_architecture_facts() -> ArchitectureFacts | None:
    """解析默认机读架构事实；契约缺失或损坏时安全降级为 ``None``。

    导入期不因缺少 ``contracts/architecture.json`` 而失败：wheel 安装到任意目录、
    mutmut 在 ``mutants/`` 副本内跑测试都可能没有契约文件。此时
    :data:`DEFAULT_REPO_FACTS` 退化为“架构未知”，由 :func:`file_location_problem`
    fail-closed 拒绝路径，而不是让 ``--help`` 或测试收集崩溃。
    """

    path = resolve_architecture_contract()
    if path is None:
        return None
    try:
        return load_architecture_contract(path)
    except RepoFactsError:
        return None


_DEFAULT_ARCHITECTURE = _default_architecture_facts()
# 架构契约不可用时保持为空，让校验 fail-closed；不在此硬编码层名清单。
SOURCE_ROOT = _DEFAULT_ARCHITECTURE.source_root if _DEFAULT_ARCHITECTURE else ""
SOURCE_LAYERS = _DEFAULT_ARCHITECTURE.source_layers if _DEFAULT_ARCHITECTURE else ()


@dataclass(frozen=True)
class RepoFacts:
    """规划阶段使用的仓库布局事实；源码根与合法分层默认取自机读架构契约。"""

    source_root: str = SOURCE_ROOT
    source_layers: tuple[str, ...] = SOURCE_LAYERS
    source_root_files: tuple[str, ...] = SOURCE_ROOT_FILES
    test_root: str = TEST_ROOT
    test_layers: tuple[str, ...] = TEST_LAYERS
    test_root_files: tuple[str, ...] = TEST_ROOT_FILES
    contract_snapshots: tuple[str, ...] = CONTRACT_SNAPSHOTS
    architecture_doc: str = ARCHITECTURE_DOC
    auxiliary_roots: tuple[str, ...] = AUXILIARY_ROOTS
    top_level_files: tuple[str, ...] = TOP_LEVEL_FILES
    interpreters: tuple[tuple[str, ...], ...] = INTERPRETERS
    gate_commands: tuple[tuple[str, ...], ...] = GATE_COMMANDS

    def __post_init__(self) -> None:
        # 架构契约不可用时（部署目录或变异副本没有 contracts/）允许源码根与分层
        # 同时缺省，由 file_location_problem fail-closed；两者必须同时给出或同时缺省。
        if bool(self.source_root) != bool(self.source_layers):
            raise ValueError("仓库事实的源码根与合法源码分层必须同时给出或同时缺省")
        if not self.test_root or not self.test_layers:
            raise ValueError("仓库事实必须声明测试根与合法测试分层")
        if not self.interpreters:
            raise ValueError("仓库事实必须至少声明一个可用解释器")

    @property
    def interpreter_labels(self) -> tuple[str, ...]:
        return tuple(" ".join(prefix) for prefix in self.interpreters)

    @property
    def gate_labels(self) -> tuple[str, ...]:
        return tuple(" ".join(command) for command in self.gate_commands)


DEFAULT_REPO_FACTS = RepoFacts()


def repo_facts_from_architecture(
    payload: object, base: RepoFacts = DEFAULT_REPO_FACTS
) -> RepoFacts:
    """在给定仓库事实基础上套用一份机读架构契约的源码根与合法分层。"""

    architecture = parse_architecture_contract(payload)
    return replace(
        base,
        source_root=architecture.source_root,
        source_layers=architecture.source_layers,
    )


@dataclass(frozen=True)
class RepoFactViolation:
    """一条具体的违规：任务、类别（文件/命令）、原值与原因。"""

    task_id: str
    kind: str
    value: str
    reason: str

    def describe(self) -> str:
        label = "文件" if self.kind == "file" else "测试命令"
        return f"任务 {self.task_id} 的{label} {self.value} {self.reason}"


# 无扩展名但确属文件的已知名字（目录子树内使用）；顶层同类文件走精确清单。
EXTENSIONLESS_FILES = ("Dockerfile", "Makefile", "LICENSE")


def _path_parts(relative: str) -> list[str]:
    return re.split(r"[\\/]+", relative)


def _labels(values: tuple[str, ...]) -> str:
    return "、".join(values)


def _looks_like_file(segment: str) -> bool:
    """纯字符串判定末段是否像文件名（不读文件系统）。

    含扩展名点（且不是以点开头的目录/点文件）或位于已知无扩展名文件清单的段
    视为文件名；层名、``domain`` 之类目录名与 ``.github`` 之类点目录不算。
    顶层点文件（如 ``.gitignore``）由精确清单处理，不依赖本函数。
    点号开头的段默认按点目录处理；带扩展名的点文件（``.prettierrc.json``，
    点号数量 ≥ 2）与登记在 ``DOTFILES_WITHOUT_EXTENSION`` 的无扩展名点文件
    （``.prettierignore``）仍是文件名，从而不误拒真实的工具链配置文件。
    """

    if segment in EXTENSIONLESS_FILES or segment in DOTFILES_WITHOUT_EXTENSION:
        return True
    if segment.startswith("."):
        return segment.count(".") >= 2
    return "." in segment


def _directory_problem(parts: list[str], *, start: int = 0) -> str | None:
    """校验中间段都是目录名；任一段像文件名则说明把文件当成了目录。"""

    for segment in parts[start:-1]:
        if _looks_like_file(segment):
            return f"把文件 {segment!r} 当作目录使用"
    return None


def _filename_problem(parts: list[str]) -> str | None:
    """校验末段确实是文件名，而不是目录名或层名。"""

    last = parts[-1]
    if not _looks_like_file(last):
        return f"末段 {last!r} 不是文件名（目录或层名不能作为文件路径）"
    return None


def file_location_problem(relative: str, facts: RepoFacts = DEFAULT_REPO_FACTS) -> str | None:
    """判断项目根相对路径是否落在合法布局；合法返回 ``None``，否则给出原因。

    绝对路径、包含空段或 ``..`` 的路径直接拒绝；源码路径必须落在已知源码层，
    测试路径必须落在已知测试层；源码根/测试根顶层只允许精确清单内的真实文件
    （``src/forgeloop/__init__.py``、``tests/conftest.py`` 等），臆造顶层文件拒绝；
    契约只允许已知快照，文档、辅助目录与 ``.github`` 树允许子树，顶层文件必须
    精确匹配已知清单。任何分支都要求末段是文件名：目录、层名、文件前缀
    （如 ``src/forgeloop/domain`` 或 ``src/forgeloop/domain/status.py/extra``）一律拒绝。

    架构契约不可用（默认事实的源码根与分层都为空）时 fail-closed：所有路径都
    拒绝并说明缺少契约，绝不因为读不到契约而放行臆造路径。
    """

    if not facts.source_root or not facts.source_layers:
        return "架构契约不可用，无法判定项目路径（缺少 contracts/architecture.json）"
    if not relative or relative.startswith(("/", "\\")):
        return "不是项目内相对路径"
    parts = _path_parts(relative)
    if any(part in ("", "..") for part in parts):
        return "包含空段或越出项目根"
    if relative in facts.contract_snapshots:
        return None
    source_parts = _path_parts(facts.source_root)
    if parts[: len(source_parts)] == source_parts:
        remainder = parts[len(source_parts) :]
        if not remainder:
            return f"指向源码根目录 {facts.source_root}，必须是文件"
        problem = _directory_problem(remainder) or _filename_problem(remainder)
        if problem is not None:
            return problem
        if len(remainder) == 1:
            # 源码根顶层只允许精确清单内的真实文件，不得放行臆造的顶层模块。
            if remainder[0] not in facts.source_root_files:
                return f"源码根顶层文件 {remainder[0]!r} 不在已知清单内"
            return None
        if remainder[0] not in facts.source_layers:
            return f"源码路径不在合法分层（允许：{_labels(facts.source_layers)}）"
        return None
    if parts[0] == facts.test_root:
        remainder = parts[1:]
        if not remainder:
            return f"指向测试根目录 {facts.test_root}，必须是文件"
        problem = _directory_problem(remainder) or _filename_problem(remainder)
        if problem is not None:
            return problem
        if len(remainder) == 1:
            # 测试根顶层只允许精确清单内的共享文件，不得放行臆造测试文件。
            if remainder[0] not in facts.test_root_files:
                return f"测试根顶层文件 {remainder[0]!r} 不在已知清单内"
            return None
        if remainder[0] not in facts.test_layers:
            return f"测试路径不在合法分层（允许：{_labels(facts.test_layers)}）"
        return None
    if parts[0] in facts.auxiliary_roots:
        if len(parts) < 2:
            return f"指向目录 {parts[0]}，必须是文件"
        problem = _directory_problem(parts) or _filename_problem(parts)
        if problem is not None:
            return problem
        return None
    if relative in facts.top_level_files:
        return None
    return "不在仓库合法路径清单内（源码分层、测试分层、文档、契约快照或已知顶层文件）"


def _normalized_argv(argv: tuple[str, ...]) -> tuple[str, ...]:
    """把含空格的首元素拆成逐词 argv，使等价写法可被前缀匹配。

    规划模型可能把 ``uv run`` 写进单个元素（``["uv run", ...]``）；这不是规范的
    argv，但语义等价于 ``["uv", "run", ...]``。校验前按空白拆分首元素，其余元素
    原样保留，从而两种写法都走同一条前缀匹配路径。
    """

    head, *tail = argv
    if any(char.isspace() for char in head):
        return (*head.split(), *tail)
    return argv


def command_problem(argv: tuple[str, ...], facts: RepoFacts = DEFAULT_REPO_FACTS) -> str | None:
    """判断测试命令是否可用；合法返回 ``None``，否则给出可操作的拒绝原因。

    校验前先规范化：首元素含空格（如 ``"uv run"``）时按空白拆分为多词，再与已知
    解释器前缀（``uv run``/``python3``）或已知门禁命令前缀匹配，使 ``["uv run", …]``
    与 ``["uv", "run", …]`` 等价通过。``python`` 等未登记解释器与缺内容的空命令
    一律拒绝；拒绝信息明确要求逐词拆分（``uv run`` 写成两个元素 ``["uv","run"]``）
    并列出可用前缀，不再出现“不可用”与“允许”并存的矛盾表述。
    """

    if not argv:
        return "测试命令为空"
    normalized = _normalized_argv(argv)
    for prefix in (*facts.interpreters, *facts.gate_commands):
        if tuple(normalized[: len(prefix)]) == prefix:
            if len(normalized) == len(prefix) and prefix in facts.interpreters:
                return f"命令 {' '.join(normalized)} 缺少要执行的内容"
            return None
    allowed = _labels((*facts.interpreter_labels, *facts.gate_labels))
    hint = '命令必须逐词拆分：uv run 写成两个元素 ["uv","run"]'
    return f"解释器 {argv[0]!r} 不可用。{hint}；可用前缀：{allowed}"


def validate_task_plan(
    plan: TaskPlan, facts: RepoFacts = DEFAULT_REPO_FACTS
) -> tuple[RepoFactViolation, ...]:
    """逐任务校验文件清单与测试命令，返回全部违规项（稳定顺序）。"""

    violations: list[RepoFactViolation] = []
    for task in plan.tasks:
        for path in task.files:
            problem = file_location_problem(path, facts)
            if problem is not None:
                violations.append(RepoFactViolation(task.task_id, "file", path, problem))
        problem = command_problem(task.test_command, facts)
        if problem is not None:
            violations.append(
                RepoFactViolation(task.task_id, "command", " ".join(task.test_command), problem)
            )
    return tuple(violations)


def require_repo_facts(plan: TaskPlan, facts: RepoFacts = DEFAULT_REPO_FACTS) -> None:
    """校验任务包；任一条违规即抛出 :class:`RepoFactsError` 并列出具体路径/命令。"""

    violations = validate_task_plan(plan, facts)
    if violations:
        detail = "；".join(violation.describe() for violation in violations)
        raise RepoFactsError(detail)


class RepositoryFactsPayload(TypedDict):
    """``repository_facts_payload`` 的稳定结构；提示词与类型检查共用。"""

    source_root: str
    source_layers: list[str]
    source_root_files: list[str]
    test_root: str
    test_layers: list[str]
    test_root_files: list[str]
    contract_snapshots: list[str]
    architecture_doc: str
    auxiliary_roots: list[str]
    top_level_files: list[str]
    interpreters: list[str]
    gate_commands: list[str]


def repository_facts_payload(facts: RepoFacts = DEFAULT_REPO_FACTS) -> RepositoryFactsPayload:
    """把固定仓库事实映射为规划提示词使用的稳定 JSON 片段。"""

    return {
        "source_root": facts.source_root,
        "source_layers": list(facts.source_layers),
        "source_root_files": list(facts.source_root_files),
        "test_root": facts.test_root,
        "test_layers": list(facts.test_layers),
        "test_root_files": list(facts.test_root_files),
        "contract_snapshots": list(facts.contract_snapshots),
        "architecture_doc": facts.architecture_doc,
        "auxiliary_roots": list(facts.auxiliary_roots),
        "top_level_files": list(facts.top_level_files),
        "interpreters": list(facts.interpreter_labels),
        "gate_commands": list(facts.gate_labels),
    }
