"""CLI 层：提交、批准、追加授权、状态查询与请求停止。

``main`` 惰性转发到 ``forgeloop.cli.main``：``forgeloop.cli.commit_policy`` 等轻量
子模块（提交策略钩子/审计，pre-commit 与 CI 都调用）必须能在没有编排依赖
（LangGraph/langchain-core 等）的环境里导入，因此包初始化不再顶层导入整个 CLI
依赖栈。控制台入口 ``forgeloop.cli:main`` 首次读取属性时才真正加载实现。
"""

__all__ = ["main"]


def __getattr__(name: str) -> object:
    if name == "main":
        from forgeloop.cli.main import main as entry

        # 缓存到包命名空间，避免首次读取后再解析子模块。
        globals()["main"] = entry
        return entry
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
