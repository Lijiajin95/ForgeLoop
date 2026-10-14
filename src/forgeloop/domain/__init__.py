"""核心领域规则：失败轮次计数、追加授权、批准版本绑定、时间限额、依赖事实与阻塞判定。

领域模块不得依赖编排（graph）、适配器（adapter）或 CLI；
分层契约见 pyproject.toml 的 [tool.importlinter] 与
docs/engineering-reliability.md。
"""
