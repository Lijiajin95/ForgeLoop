"""机读架构事实驱动合法分层的属性测试：任意契约下不变量始终成立。

不变量：
- 合法分层恰好是 ``modules`` 中非结构哨兵的层值，且不重复、不丢失；
- 每个已登记分层下的路径都合法，任何未登记目录都被拒绝；
- ``layer_edges`` 只影响清单顺序，不改变合法分层的集合。
"""

from typing import Any

from hypothesis import given
from hypothesis import strategies as st

from forgeloop.domain.repo_facts import (
    file_location_problem,
    parse_architecture_contract,
    repo_facts_from_architecture,
)

layer_names = st.from_regex(r"[a-z][a-z0-9_]{0,7}", fullmatch=True)


@st.composite
def contracts(draw: st.DrawFn) -> dict[str, Any]:
    layers = draw(st.lists(layer_names, min_size=1, max_size=5, unique=True))
    edges = draw(st.lists(st.tuples(st.sampled_from(layers), st.sampled_from(layers)), max_size=8))
    modules = {f"forgeloop.{layer}": layer for layer in layers}
    modules["forgeloop"] = "(root)"
    modules["forgeloop.__main__"] = "__main__"
    return {
        "source_root": "src/forgeloop",
        "modules": modules,
        "layer_edges": [list(edge) for edge in edges],
    }


@given(contracts())
def test_legal_layers_are_exactly_registered_directory_layers(payload: dict[str, Any]) -> None:
    registered = {
        value for value in payload["modules"].values() if value not in ("(root)", "__main__")
    }
    facts = parse_architecture_contract(payload)
    assert set(facts.source_layers) == registered
    assert len(facts.source_layers) == len(set(facts.source_layers))


@given(contracts())
def test_registered_layer_paths_are_legal(payload: dict[str, Any]) -> None:
    facts = repo_facts_from_architecture(payload)
    for layer in facts.source_layers:
        assert file_location_problem(f"src/forgeloop/{layer}/module.py", facts) is None


@st.composite
def unregistered_directory(draw: st.DrawFn) -> tuple[dict[str, Any], str]:
    payload = draw(contracts())
    registered = set(payload["modules"].values())
    other = draw(layer_names.filter(lambda name: name not in registered))
    return payload, other


@given(unregistered_directory())
def test_unregistered_directory_is_always_rejected(case: tuple[dict[str, Any], str]) -> None:
    payload, other = case
    facts = repo_facts_from_architecture(payload)
    assert file_location_problem(f"src/forgeloop/{other}/module.py", facts) is not None


@given(contracts())
def test_edges_do_not_change_membership(payload: dict[str, Any]) -> None:
    without_edges = dict(payload)
    without_edges["layer_edges"] = []
    with_edges = parse_architecture_contract(payload)
    no_edges = parse_architecture_contract(without_edges)
    assert set(with_edges.source_layers) == set(no_edges.source_layers)


@given(contracts())
def test_fabricated_directories_are_rejected_in_every_contract(payload: dict[str, Any]) -> None:
    facts = repo_facts_from_architecture(payload)
    for fabricated in ("bogus", "fabricated_layer", "not_registered"):
        if fabricated in facts.source_layers:
            continue
        assert file_location_problem(f"src/forgeloop/{fabricated}/x.py", facts) is not None
