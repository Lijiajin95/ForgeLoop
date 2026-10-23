"""Ruff 安全规则子集：精确启用 7 条 bandit（S）规则，不整体启用 S。

``pyproject.toml`` 的 ``[tool.ruff.lint].select`` 只选取与本项目真实风险面相关的
7 条 S 代码，替代已移除的 Semgrep 本地规则。本套件把这份清单固化为可回归的契约：
后续编辑若误删某条、顺带启用别的 S 代码，或整体启用 S 家族，都会在此失败。
"""

import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parents[2] / "pyproject.toml"

# 7 条安全代码：任意代码执行、反序列化、TLS 校验、YAML 加载、shell 执行。
EXPECTED_SECURITY_SELECT = frozenset(
    {
        "S102",  # exec-builtin
        "S301",  # suspicious-pickle-usage
        "S307",  # suspicious-eval-usage
        "S501",  # request-with-no-cert-validation
        "S506",  # unsafe-yaml-load
        "S602",  # subprocess-popen-with-shell-equals-true
        "S605",  # start-process-with-a-shell
    }
)

# 安全子集之外的既有 lint 选择必须原样保留，证明本轮是精确新增。
EXISTING_LINT_SELECT = frozenset({"E4", "E7", "E9", "F", "I", "UP", "B", "SIM", "RUF"})


def lint_select() -> list[str]:
    """读取 ``[tool.ruff.lint].select`` 的原始清单（保持声明顺序）。"""
    payload = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    return payload["tool"]["ruff"]["lint"]["select"]


def selected_bandit_codes(select: list[str]) -> set[str]:
    """只挑出 bandit 代码（``S`` + 数字），避免把 ``SIM`` 误当 S 家族。"""
    return {code for code in select if code.startswith("S") and code[1:].isdigit()}


def test_select_contains_all_seven_security_codes() -> None:
    select = lint_select()
    assert set(select) >= EXPECTED_SECURITY_SELECT
    assert selected_bandit_codes(select) >= EXPECTED_SECURITY_SELECT


def test_select_contains_exactly_the_seven_security_codes() -> None:
    assert selected_bandit_codes(lint_select()) == EXPECTED_SECURITY_SELECT


def test_bandit_family_is_not_enabled_wholesale() -> None:
    select = lint_select()
    assert "S" not in select
    assert "ALL" not in select


def test_existing_lint_rules_are_preserved() -> None:
    assert set(lint_select()) >= EXISTING_LINT_SELECT
