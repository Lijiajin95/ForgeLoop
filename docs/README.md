# 文档索引

最新产品目标、需求、技术和验证方案统一维护在 [product.md](product.md)。
方案、当前实现和历史证据分别标明；已确认方案不表示代码已实现，也不替代具体实施范围。

## 统一方案

| 想知道 | 入口 |
| --- | --- |
| 产品目标、首版范围与客户决定 | [§2–§4](product.md#2-产品目标与首版范围已确认) |
| 宿主、Agent、存储、停止规则 | [§5–§7](product.md#5-宿主协调与多-agent-流程) |
| 客户工作台、发布与运维 | [§8](product.md#8-客户入口发布与运维) |
| 首版需求 | [§9](product.md#9-首版需求与可观察结果细化稿) |
| 已收口的验证与评测方案 | [§10](product.md#10-首版验证与评测方案已收口) |
| 里程碑、场景、自主程度统计与证据 | [§11–§13](product.md#11-里程碑与验收路径细化稿) |
| 待实施事项与 DSH 接缝依据 | [§14–§15](product.md#14-实施边界与待决项) |

## 当前实现与工程操作

| 文档 | 保留职责 |
| --- | --- |
| [status.md](status.md) | 当前能力、已知缺口、实际检查与安装记录；事实唯一入口 |
| [architecture.md](architecture.md) | 当前模块、持久化与外部接缝，对应源码和架构契约 |
| [CONTEXT.md](../CONTEXT.md) | 当前代码的领域术语；与新方案差异有明确说明 |
| [插件 README](../packages/forgeloop/README.md) | 当前插件入口与最小使用说明 |
| [deployment.md](deployment.md) | 当前本机安装、升级、验证与恢复操作 |
| [AGENTS.md](../AGENTS.md) | 开发规则统一入口：简单性、文件范围、测试先行、授权与交付纪律 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献、许可、提交与交付操作 |

检查入口与门槛以 [Makefile](../Makefile)、[覆盖率配置](../packages/forgeloop/vitest.config.ts)和
[架构契约](../contracts/architecture.json)为准，不重复维护数值。
契约检查使用 `make contracts`；更新入口为 `make architecture-contract`。

## 保留的决定与交付记录

- [ADR 0008](adr/0008-typescript-native-dsh-plugin.md)：2026-10-22 转为 TypeScript／DSH 的历史决定，后续选择以统一方案为准。
- [ADR 0009](adr/0009-remove-retired-implementation.md)：删除退役代码快照、失效安装入口与未接入运行链路的重复实现。
- [ADR 0010](adr/0010-remove-command-surface-legacy-compat-and-commit-policy.md)：删除 `/fl` 命令表面、旧库兼容与本机提交时间策略。
- [2026-10-22 交付记录](delivery/2026-10-22-typescript-dsh.md)：真实迁移、自迭代、失败与补救证据，不作为现行操作手册。

## 清理与回查

- [2026-10-25 清理](status.md#7-文档清理2026-10-25)：旧需求、路线图、待办和退役提案退出活动文档，原文可从 Git 历史回查。
- [2026-10-28 整合](status.md#11-方案文档整合与清理2026-10-28)：最新方案合并，删除重复接续稿、独立验证稿和过时现状稿，独有事实与资料已迁入对应入口。

[2026-10-28 职责优化与勘误](status.md#12-文档职责优化与历史证据核对2026-10-28)：研发纪律合并入 AGENTS，状态、术语与安装说明按各自职责维护。

[2026-10-28 代码清理](status.md#13-冗余功能与代码清理2026-10-28)：退役 `legacy/` 快照与旧安装脚本已删除，按 Git 历史回查。

[2026-10-28 命令面与提交策略清理](status.md#14-命令表面旧库兼容与提交策略清理2026-10-28)：`/fl` 命令、旧库补列与提交时间策略已删除，替代入口尚未实现。

本机 `docs/library/` 是阅读资料、来源快照与历史研究，不是现行产品方案。
原始业务证据、数据库和候选包独立保存；代码清理不处理这些数据，也不改变 DSH 配置。
