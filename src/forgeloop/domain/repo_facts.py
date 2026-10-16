"""仓库布局事实与任务包合规校验（纯规则）。

规划阶段把仓库的固定布局作为事实注入提示词，并校验模型产出的任务包：

- 文件清单必须落在已知源码层、源码根精确顶层文件、测试层（含测试根顶层
  共享文件）、文档、辅助目录（含 ``.github`` 树）、已知契约快照或已知顶层文件，
  且末段必须是文件名——不得把目录或“文件名前缀”当成文件路径，也不得臆造
  源码根/测试根顶层的模块或测试文件；
- 测试命令必须使用可用解释器（``uv run``/``python3``）或已知门禁命令。

校验逐条给出具体路径/命令与原因，由规划调用方据此拒绝任务包并要求重规划，
不静默接受。事实是手工维护的固定常量，不读文件系统：规划在独立目录内运行，
不能访问被测项目现场；仓库布局变化由架构契约门禁（``docs/architecture.md``
与 ``contracts/architecture.json``）与本文常量一并核对。

本模块不依赖任何第三方库与内部其它层，只维护固定事实与纯判定。
"""

import re
from dataclasses import dataclass
from typing import TypedDict

from forgeloop.domain.task_plan import TaskPlan

# 源码根与源码分层：与 contracts/architecture.json 的 source_root/模块层一致。
SOURCE_ROOT = "src/forgeloop"
SOURCE_LAYERS = ("domain", "records", "adapter", "graph", "cli")
# 源码根顶层文件（不在分层目录内）：精确清单，避免把臆造顶层文件当成合法。
SOURCE_ROOT_FILES = ("__init__.py", "__main__.py")

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
TEST_ROOT_FILES = ("conftest.py",)

# 契约快照：规划任务可显式更新这两个机读事实，不得臆造其它契约文件名。
CONTRACT_SNAPSHOTS = ("contracts/cli-contract.json", "contracts/architecture.json")
# 架构描述文档：模块清单必须与源码互为镜像。
ARCHITECTURE_DOC = "docs/architecture.md"

# 除源码/测试/契约外允许出现的已知目录（允许其子树）与顶层文件。
# .github 是 git 跟踪的真实 CI 配置树，属于可修改的仓库事实。
AUXILIARY_ROOTS = ("config", "docs", "runtime", "scripts", ".github")
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


@dataclass(frozen=True)
class RepoFacts:
    """规划阶段使用的固定仓库布局事实；默认值为 ForgeLoop 当前布局。"""

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
        if not self.source_root or not self.source_layers:
            raise ValueError("仓库事实必须声明源码根与合法源码分层")
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


class RepoFactsError(ValueError):
    """任务包违反仓库布局事实；规划阶段据此拒绝并要求重规划。"""


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
    """

    if segment in EXTENSIONLESS_FILES:
        return True
    if segment.startswith("."):
        return False
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
    """

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
