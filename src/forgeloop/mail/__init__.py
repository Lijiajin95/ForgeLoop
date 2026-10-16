"""邮箱层声明：邮箱接口与纯逻辑，只依赖标准库。

本层为后续邮箱模块提供合法源码分层；当前仅登记分层，尚无实现模块。
不得依赖 cli、graph、records、adapter 或 langgraph；
分层契约见 pyproject.toml 的 [tool.importlinter] 与 docs/architecture.md。
"""
