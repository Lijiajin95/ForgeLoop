# ForgeLoop

ForgeLoop 是一个 **TypeScript 原生 DSH 插件**：把边界明确的需求变成可审查、可测试、可回查的
代码改动，用户负责人工批准与整体验收。DSH 是唯一需要启动的常驻宿主；ForgeLoop 不再提供
独立网页、`serve` 或 Python 核心。

- 现在是什么状态、验证到哪一步：见[状态记录](docs/status.md)
- 架构、分层、持久化与信任边界：见[架构说明](docs/architecture.md)
- 为什么转为 TypeScript／DSH：见[ADR 0008](docs/adr/0008-typescript-native-dsh-plugin.md)
- 开发、检查与提交纪律：[CONTRIBUTING.md](CONTRIBUTING.md)、[研发纪律](docs/development-discipline.md)

## 一条闭环

```
/fl submit 需求原文
  → /fl analyze 结构化分析（无工具 Agent）
  → /fl plan 任务包（文件清单 + 正式测试命令 + 依赖）
  → /fl approve <需求> <任务包版本>        （人类决定）
  → /fl advance 实现 → 独立审查 → 正式测试 → 交付证据
  → /fl candidate 构建本地安装包与摘要
  → /fl accept <需求> <产物摘要>           （人类决定）

/fl impact <需求> [--explain]   修订影响摘要：确定性事实为主，--explain 才给模型推断
```

批准绑定需求版本、任务包版本与授权来源；验收绑定候选 diff、测试日志、审查结论与产物摘要。
材料变化后原批准失效。模型可以提交需求、查询状态与证据，但不能批准、推进或验收。

## 安装

需要 DSH `0.2.1-rc.2` 或兼容版本、Node ≥ 22.5（本机验证用 Node 26）。

```sh
# 从源码目录安装到专用 profile
dsh plugin --profile forgeloop add /path/to/ForgeLoop/packages/forgeloop
dsh --profile forgeloop --dump-config | grep forgeloop-dsh

# 或从本地候选包安装
dsh plugin --profile forgeloop add packages/forgeloop/dist/forgeloop-dsh-<version>.tgz
```

在 profile 的 `cordis.patch.yml` 中覆盖插件行的配置（至少有 `recordsRoot`、`project`、
`projectPath`；模型可用 `agent.provider/model` 指定，缺省用宿主默认选择）：

```yaml
- id: forgeloop
  config:
    recordsRoot: /path/to/project/.forgeloop
    project: my-project
    projectPath: /path/to/project
    agent:
      provider: <provider>
      model: <model>
```

重启 DSH 后在任意会话使用 `/fl help`。记录根布局与旧版兼容：
`<recordsRoot>/projects/<project>/records.sqlite`。

## 开发与检查

```sh
npm install --cache .cache/npm-cache
make check                  # tsc 类型检查 + 契约 + 提交策略配置 + vitest
make build                  # 编译 packages/forgeloop/lib
make package                # 构建本地候选包与 artifact.json
make verify-plugin          # 隔离 DSH_HOME 中真实装载、真实模型调用（需凭据）
```

检查入口全部是 TypeScript；旧 Python 实现隔离在 `legacy/`，不参与构建、检查或运行。
变异测试、依赖漏洞扫描与格式化器**尚未接入**，对应 `make` 目标会显式失败，不冒充通过。

## 范围与限制

- 首版只做本地专用 profile、单项目、单宿主；多租户、远程访问、邮件/IM、发布/部署不在范围。
- 独立审查是“独立会话 + 无工具 + 固定 diff”，不是 OS/容器级隔离。
- DSH 仍是 developer preview；升级插件前需重新验证接缝。
- 未验证事项在状态记录中逐条标注，不用“已退役”替代“已迁移”。