"""Enforce commit headers and workday hours; audit Git timestamps without creating commits.

本脚本是 ``forgeloop.cli.commit_policy`` 的转发入口：pre-commit/commit-msg 钩子与
CI 都调用它。真正的加载与审计实现（生效策略来源、机器标签、命中时间窗及其来源，
以及客户端边界文案）在分层的 ``forgeloop.cli.commit_policy`` 中，本文件不重复
实现规则。
"""

import sys

from forgeloop.cli.commit_policy import load_policy, main

__all__ = ["load_policy", "main"]


if __name__ == "__main__":
    sys.exit(main())
