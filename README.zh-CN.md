# ForgeLoop

[English](README.md) | 简体中文

**基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的多 Agent 软件研发与运维。**

ForgeLoop 希望帮助需要软件、但不从事软件研发的人，将业务目标变成实际运行的应用。客户确定目标与授权边界，Agent 承担日常工程工作，并将例外交回客户决定。需求、改动、验证结果和交付证据贯穿全过程，保持可追溯。

> **项目处于早期开发阶段。** 当前已具备 TypeScript 原生插件基础，完整的自主研发、部署与运维闭环仍在建设和验证中。产品目标不代表能力已经完成。

## ForgeLoop 要解决什么

- **从需求走到运行中的软件。** 协调需求分析、技术规划、实现、独立验证、发布和上线检查。
- **让客户清楚地作决定。** 遇到目标冲突、授权边界变化、重大架构变化等明确例外时，提供证据与可理解的备选方案。
- **让交付结果可检查。** 将每项需求关联到任务、候选改动、测试结果、审查结论和发布产物。
- **持续改进。** 将授权范围内的运行反馈转化为恢复工作和后续研发需求。

目标流程为：

```text
需求 → 分析与规划 → 实现 → 独立验证
     → 业务验收 → 部署 → 上线检查
```

首个应用场景是 ForgeLoop 自身：先建设可用种子，再用它完成真实改进，并记录每次迭代需要多少外部帮助。研发与运维分别评估，长期目标是各自的人工介入率低于 10%；这不是已经取得的结果。

## 基于 DeepSeek Harness

DSH 是唯一常驻宿主，提供会话、模型接入、工具、UI 集成和进程生命周期服务。ForgeLoop 在其上承担软件交付流程与业务记录。

| 层次 | 职责 |
| --- | --- |
| DSH 宿主 | 会话、模型、工具、权限与插件 UI 集成 |
| ForgeLoop 领域层 | 需求、任务包、授权、失败累计与交付规则 |
| ForgeLoop 运行时 | 持久协调、Agent 执行、工作副本、审查与正式测试 |
| 记录与证据 | SQLite 保存业务记录；文件保存 diff、日志、报告与候选产物 |

活动实现位于 [`packages/forgeloop`](packages/forgeloop)，使用 TypeScript 和 Node 内置 SQLite，无需另起独立常驻后端。

目标设计定义三个角色：**需求 Agent、研发 Agent、验证 Agent**。独立子运行时与可强制执行的角色边界属于目标设计；当前宿主进程内的独立 Agent 会话不等于这些边界已经成立。具体区别见[架构说明](docs/architecture.md)与[产品方案](docs/product.md)。

## 当前基础与开发重点

仓库包含需求与任务包版本管理、快照工作副本、候选 diff、独立 diff 审查、正式测试执行、持久请求和证据记录，并通过 DSH 工具与网页看板呈现项目信息。

部分工作流操作仍是内部能力，具体可用功能取决于所用版本。工具调用、测试或安装成功，都不能单独证明完整交付。[状态记录](docs/status.md)保存实现情况、实际验证与已知缺口。

当前开发重点：

1. **可日常使用的 DSH 工作台：** 统一导航、需求与任务详情、执行活动、错误和证据，方便操作与调试。
2. **受控执行：** 角色权限、可靠的停止与恢复，以及实际动作入口一致的授权和失败累计判定。
3. **经验证的交付闭环：** 同一候选贯穿验证、受控部署与运行版本检查。
4. **真实自身改进：** 完整记录结果、失败、外部介入和运维恢复，再评估自主程度。

## 开发

使用符合[工作区](package.json)与[插件](packages/forgeloop/package.json)声明的 Node.js、npm 和 DSH 版本。首个目标环境为 macOS。

```sh
git clone https://github.com/Lijiajin95/ForgeLoop.git
cd ForgeLoop
make setup       # 安装依赖
make check       # 类型检查、架构契约与行为测试
make build       # 编译插件
make package     # 构建候选 tarball 与产物清单
```

安装、模型配置与 profile 选择见[部署指南](docs/deployment.md)和[插件说明](packages/forgeloop/README.md)。`make verify-plugin` 执行真实宿主与模型冒烟，需要独立测试 DSH home 和可用的模型认证；执行前请阅读部署指南。

## 文档

项目的详细文档目前主要使用中文。

| 文档 | 内容 |
| --- | --- |
| [产品与首版方案](docs/product.md) | 目标、范围、设计决定与验证规则 |
| [状态与证据](docs/status.md) | 已实现能力、检查、安装记录与已知缺口 |
| [架构说明](docs/architecture.md) | 当前模块、持久化与外部接缝 |
| [领域语言](CONTEXT.md) | 业务对象、身份与生命周期术语 |
| [插件说明](packages/forgeloop/README.md) | 插件入口与配置 |
| [部署指南](docs/deployment.md) | 安装、升级、验证与恢复 |
| [文档索引](docs/README.md) | 设计决定与历史记录 |

## 贡献与许可

修改前请阅读 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。保持改动范围明确，保留在途工作，为关键行为提供测试和真实执行证据。

代码与文档的许可方式尚未确定，当前分发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
