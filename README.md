# ForgeLoop

ForgeLoop 面向需要软件但不懂研发的人，在客户确定的业务目标和授权边界内，通过多 Agent
完成软件建设、持续迭代与线上运维，提供全链路审计，并将例外决策交给客户。

[产品与首版方案](docs/product.md)统一保存最新产品目标、需求、技术、验证规则和待决项。
首版从零建设自身进行 DogFood：先建立种子，再验证自主闭环，最后分别验收研发与运维的人工介入率。
已确定使用 DSH 插件、当前 macOS 开发机和独立 DSH 子运行时；这些方案尚不等于当前能力。

## 当前实现

当前是 TypeScript 原生 DSH 插件，DSH 为唯一常驻宿主；运行时有需求、任务包、代码实施、
独立审查、正式测试和候选包记录。2026-10-28 已删除 `/fl` 命令表面与旧业务库兼容，
模型工具只读查询与受理需求，页面仍为只读看板；新方案的客户决定入口尚未实现。

- [状态与证据](docs/status.md)：实际检查、安装版本、历史交付和已知缺口。
- [当前架构](docs/architecture.md)与[领域语言](CONTEXT.md)：源码使用的模块、状态与术语。
- [插件使用说明](packages/forgeloop/README.md)：当前入口与配置。
- [安装、升级与恢复](docs/deployment.md)：依赖要求、源码／候选安装、桌面 profile 和验证步骤。
- [文档索引](docs/README.md)：统一方案、工程约定和保留记录的阅读入口。

## 开发与检查

```sh
npm install --cache .cache/npm-cache
make check                  # 类型、架构契约与行为测试
make build                  # 编译插件
make package                # 生成候选包与 artifact.json
make verify-plugin          # 真实宿主装载与模型调用，需要可用模型接入
```

修改前阅读[开发约定与研发纪律](AGENTS.md)、[贡献规范](CONTRIBUTING.md)。
具体门槛由 [Makefile](Makefile)、项目配置与契约维护，实际结果写入状态记录。
旧 Python／Web／serve 代码及失效安装脚本已从工作树删除，原文从 Git 历史回查，见
[清理记录](docs/status.md#13-冗余功能与代码清理2026-10-28)。
