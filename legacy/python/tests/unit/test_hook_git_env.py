"""推送钩子的 git 环境隔离：跑测试的钩子必须先清掉真实仓库定位变量。

2026-10-19 实测事故：``git push`` 时 git 会向 pre-push 钩子导出 ``GIT_DIR``、
``GIT_INDEX_FILE`` 等变量，钩子里的 pytest 把它们继承给测试进程，于是测试中为**临时仓库**
启动的 git 子进程命中真实仓库——``tests/scenario/test_self_iteration.py`` 从 23/23 通过变成
21 失败，且仓库 HEAD 与索引被测试的 checkout 与 reset 改到别的提交上（同源记录见
``docs/status.md`` 的 `.git/config` 被覆盖事故）。

本用例把「跑测试的钩子先清掉这些变量」钉成机器判定的约束：改掉配置就失败，不能只靠注释约定。
"""

from pathlib import Path

CONFIG = Path(__file__).resolve().parents[2] / ".pre-commit-config.yaml"

LEAKED_VARIABLES = (
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
)


def hook_blocks() -> dict[str, str]:
    """按 ``- id: <名字>`` 把配置切成块：块名 → 原文（含续行，供整体断言）。"""

    blocks: dict[str, list[str]] = {}
    current: str | None = None
    for line in CONFIG.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("- id: "):
            current = stripped[len("- id: ") :].strip()
            blocks[current] = [line]
        elif current is not None:
            blocks[current].append(line)
    return {name: "\n".join(lines) for name, lines in blocks.items()}


class TestPytestHooksClearGitEnv:
    def test_fast_tests_hook_exists(self) -> None:
        assert "fast-tests" in hook_blocks()

    def test_every_hook_that_runs_pytest_clears_the_repository_env(self) -> None:
        offending = sorted(
            name
            for name, block in hook_blocks().items()
            if "pytest" in block and "env -u GIT_DIR" not in block
        )
        assert offending == [], f"这些跑测试的钩子没有清掉 git 仓库定位变量：{offending}"

    def test_fast_tests_clears_each_variable_git_leaks(self) -> None:
        block = hook_blocks()["fast-tests"]
        missing = [variable for variable in LEAKED_VARIABLES if f"-u {variable}" not in block]
        assert missing == [], f"fast-tests 未清掉：{missing}"
