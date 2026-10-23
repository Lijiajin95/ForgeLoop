# 文档索引

当前实现是 TypeScript 原生 DSH 插件。先读下面四份，再按需下钻：

| 想知道 | 看哪里 |
| --- | --- |
| 产品范围与验收基线 | [product-requirements.md](product-requirements.md) |
| 当前状态、验证证据与缺口 | [status.md](status.md) |
| 架构、分层、持久化与信任边界 | [architecture.md](architecture.md) |
| 为什么转为 TypeScript／DSH | [adr/0008-typescript-native-dsh-plugin.md](adr/0008-typescript-native-dsh-plugin.md) |

## 开发与交付

- [研发纪律](development-discipline.md)、[工程可靠性](engineering-reliability.md)
- [安装、升级与恢复](deployment.md)
- [DogFood 执行计划](dogfood-execution-plan.md)
- [2026-10-22 交付记录](delivery/2026-10-22-typescript-dsh.md)
- [待实现需求](pending-requirements.md)、[RoadMap](roadmap.md)

## 历史

- [历史文档索引](history/README.md)：Python／Web／serve 路线、早期提案与旧验收记录，按当时
  事实保留，不作为当前依据。
- ADR 0001–0007 保留历史决定；0008 取代其中与产品宿主相关的路径。
- 研究笔记在 `docs/library/research/`（本机阅读资料，不入库）。

## 契约

- `contracts/architecture.json`：模块、分层、表、命令/工具、外部接缝。
- `contracts/cli-contract.json`：人类命令子命令、模型工具与决定信任表。
- 检查入口：`make contracts`；生成入口：`make architecture-contract` / `make cli-contract`。