"""Counting library for structure metrics with the fixed calibers of the quality policy.

Calibers (docs/coding-agent-handoff-2026-10-09.md section 8.2): function effective
lines run from the ``def``/``lambda`` line to the function end, including multi-line
signatures and excluding decorators; blank lines, comment-only lines and
AST-identified real docstrings do not count; a code line keeps counting when it
carries a trailing comment, and lines inside strings always count as code. Nested
functions are checked on their own while their lines stay part of the enclosing
function's range; lambdas count as anonymous function units. Public interfaces of a
class are its own declared public methods and properties, deduplicated by
(receiver, name) so getter/setter and overload chains merge; constructors,
underscore-private and special methods, and inherited interfaces do not count.
``staticmethod`` is the only receiver without a bound argument; plain methods,
classmethods and properties share the instance-receiver bucket.

Review hints (return statements, statements, local variables) count the function's
own scope only, excluding nested function/class bodies; comprehension targets are
not locals.
"""

import ast
import io
import tokenize
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class FunctionMetric:
    file: str
    name: str
    kind: str
    start_line: int
    end_line: int
    effective_lines: int
    return_statements: int
    statements: int
    local_variables: int


@dataclass(frozen=True)
class ClassMetric:
    file: str
    name: str
    line: int
    public_interfaces: int
    interfaces: tuple[tuple[str, str], ...]


class SourceLines:
    """Physical line classification from tokenize; ``#`` inside strings stays code."""

    def __init__(self, source: str) -> None:
        self._code: set[int] = set()
        self._comment: set[int] = set()
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type in {
                tokenize.NL,
                tokenize.NEWLINE,
                tokenize.INDENT,
                tokenize.DEDENT,
                tokenize.ENCODING,
                tokenize.ENDMARKER,
            }:
                continue
            span = range(token.start[0], token.end[0] + 1)
            if token.type == tokenize.COMMENT:
                self._comment.update(span)
            else:
                self._code.update(span)

    def is_code(self, line: int) -> bool:
        return line in self._code


def docstring_lines(tree: ast.Module) -> set[int]:
    """Line numbers covered by AST-identified docstrings of module/class/function bodies."""
    lines: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        if node.body and _is_string_statement(node.body[0]):
            statement = node.body[0]
            end = statement.end_lineno if statement.end_lineno is not None else statement.lineno
            lines.update(range(statement.lineno, end + 1))
    return lines


def _is_string_statement(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def is_static_method(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for decorator in function.decorator_list:
        if isinstance(decorator, ast.Name):
            name = decorator.id
        elif isinstance(decorator, ast.Attribute):
            name = decorator.attr
        else:
            name = ""
        if name == "staticmethod":
            return True
    return False


def class_interfaces(node: ast.ClassDef) -> tuple[tuple[str, str], ...]:
    """Own public methods and properties, deduplicated by (receiver, name)."""
    interfaces: set[tuple[str, str]] = set()
    for child in node.body:
        if not isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        if child.name.startswith("_"):
            continue
        receiver = "static" if is_static_method(child) else "instance"
        interfaces.add((receiver, child.name))
    return tuple(sorted(interfaces))


def _own_scope_nodes(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.AST]:
    """Nodes of the function body excluding nested function/class/lambda scopes."""
    nodes: list[ast.AST] = []
    for statement in function.body:
        nodes.append(statement)
        if isinstance(statement, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            continue
        nodes.extend(_descendant_nodes(statement))
    return nodes


def _descendant_nodes(node: ast.AST) -> list[ast.AST]:
    nodes: list[ast.AST] = []
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Lambda):
            continue
        nodes.append(child)
        nodes.extend(_descendant_nodes(child))
    return nodes


def count_return_statements(function: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    return sum(isinstance(node, ast.Return) for node in _own_scope_nodes(function))


def count_statements(function: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    return sum(isinstance(node, ast.stmt) for node in _own_scope_nodes(function))


def _bound_names(nodes: list[ast.AST]) -> set[str]:
    names: set[str] = set()
    for node in nodes:
        if isinstance(node, ast.Assign):
            names.update(_target_names(node.targets))
        elif isinstance(
            node, ast.AnnAssign | ast.AugAssign | ast.NamedExpr | ast.For | ast.AsyncFor
        ):
            names.update(_target_names([node.target]))
        elif isinstance(node, ast.withitem):
            names.update(_target_names([node.optional_vars]))
        elif isinstance(node, ast.ExceptHandler):
            names.update([node.name] if node.name else [])
        elif isinstance(node, ast.Import):
            names.update(alias.asname or alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.update(alias.asname or alias.name for alias in node.names)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            names.add(node.name)
    return names


def _target_names(targets: Sequence[object]) -> set[str]:
    names: set[str] = set()
    for target in targets:
        if target is None:
            continue
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, ast.Tuple | ast.List):
            names.update(_target_names(list(target.elts)))
        elif isinstance(target, ast.Starred):
            names.update(_target_names([target.value]))
    return names


def count_local_variables(function: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    parameters = {arg.arg for arg in function.args.posonlyargs + function.args.kwonlyargs}
    for argument in [function.args.vararg, function.args.kwarg]:
        if argument:
            parameters.add(argument.arg)
    for argument in function.args.args:
        parameters.add(argument.arg)
    return len(_bound_names(_own_scope_nodes(function)) - parameters)


def _function_metric(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda,
    lines: SourceLines,
    docstrings: set[int],
    relative: str,
) -> FunctionMetric:
    end = node.end_lineno if node.end_lineno is not None else node.lineno
    effective = sum(
        1 for line in range(node.lineno, end + 1) if lines.is_code(line) and line not in docstrings
    )
    if isinstance(node, ast.Lambda):
        return FunctionMetric(relative, "<lambda>", "lambda", node.lineno, end, effective, 0, 0, 0)
    kind = "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function"
    return FunctionMetric(
        relative,
        node.name,
        kind,
        node.lineno,
        end,
        effective,
        count_return_statements(node),
        count_statements(node),
        count_local_variables(node),
    )


def python_metrics(source: str, relative: str) -> tuple[list[FunctionMetric], list[ClassMetric]]:
    """Count every function unit and class of one Python source text."""
    tree = ast.parse(source)
    lines = SourceLines(source)
    docstrings = docstring_lines(tree)
    functions: list[FunctionMetric] = []
    classes: list[ClassMetric] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
            functions.append(_function_metric(node, lines, docstrings, relative))
        elif isinstance(node, ast.ClassDef):
            interfaces = class_interfaces(node)
            classes.append(
                ClassMetric(relative, node.name, node.lineno, len(interfaces), interfaces)
            )
    return functions, classes


def physical_lines(source: str) -> int:
    return len(source.splitlines())
