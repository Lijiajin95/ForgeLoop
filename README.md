# ForgeLoop

ForgeLoop 首版是一个 CLI 自动研发工具：把边界明确的小需求变成可验收的代码改动，用户负责批准方案与验收结果。

本文件只描述稳定的产品范围与文档索引；当前实现、验证数字、CI 与远程同步状态、未完成缺口见[状态记录](docs/status.md)。

## 首版只做这一条闭环

文本需求 → 批准范围与方案 → PI 实现／自验证 → 独立审查 → 真实测试 → 人工验收 → 交付 diff 与记录。

采用 LangGraph＋Python PI RPC Adapter，PI 在受限容器中使用独立工作副本。单任务执行，main 保持受控；验收后由用户人工接回代码与部署。CLI 提供提交、批准、查询、请求停止与简单备份，不先做页面和邮件。

保留原始输入、配置快照、PI 会话与可取得事件、实际测试日志和交付报告。每次授权最多三个正式测试失败轮次，追加授权与累计失败保留。首版无模型费用硬上限，保留工时限制；现场默认保留，人工清理。

## 文档入口

1. [状态记录](docs/status.md)：当前实现范围、验证数字、CI 与远程同步、未完成缺口。
2. [五步工作法需求审查](docs/requirements-review.md)：每项为什么保留、简化或后置。
3. [首版产品需求](docs/product-requirements.md)：当前实现范围与交付条件。
4. [待实现需求列表](docs/pending-requirements.md)：后置需求、触发条件和验收要求。
5. [最小架构](docs/architecture.md)：CLI、一个业务图、PI Adapter 与本地记录。
6. [快速启动验收计划](docs/first-validation-plan.md)：验证真实交付（人工投入上限已按所有者决定撤销）。
7. [RoadMap](docs/roadmap.md)：先使用，再按真实痛点逐项扩展。
8. [领域术语](CONTEXT.md)与[分层决策](docs/adr/0001-orchestration-and-executors.md)。
9. [工程可靠性方案](docs/engineering-reliability.md)与[研发纪律](docs/development-discipline.md)：分层测试、统一门槛、提交纪律与激活顺序，含逐批次执行记录、失败与负例矩阵。

## 后置范围

邮件、管理页面（含原先只读状态页优先任务）、附件平台、自动部署、版本运维、自升级、复杂暂停恢复、多任务调度、自研 Runtime 和其他执行器均进入待实现列表。

[完整产品历史快照](docs/history/full-product-scope-2026-10-12.md)用于保留长期目标，不能扩大当前首版范围。跑通并验收一个真实小任务后即可开始使用；人工时间测量与 30 小时上限已按所有者决定撤销（2026-10-12）。
