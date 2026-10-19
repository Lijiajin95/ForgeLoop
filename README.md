# ForgeLoop

ForgeLoop 首版是一个 CLI 自动研发工具：把边界明确的小需求变成可验收的代码改动，用户负责批准方案与验收结果。

本文件只描述稳定的产品范围与文档索引；当前实现、验证数字、CI 与远程同步状态、未完成缺口见[状态记录](docs/status.md)。

## 首版只做这一条闭环

文本需求 → 批准范围与方案 → PI 实现／自验证 → 独立审查 → 真实测试 → 人工验收 → 交付 diff 与记录。

在此单任务闭环之上，CLI 已把三条业务线接到真实入口：需求线 `requirement submit|revise|analyze|plan|approve|advance|accept|status` 把一条需求分析、拆成任务包并按依赖推进；任务线 `submit|approve|grant|status|stop` 执行每个任务；交付线 `candidate <task_id>`、`merge|release|deploy|rollback` 在验收后受控归并、发布并部署到本机。

状态页的行为代码是 TypeScript（`frontend/src`，编译为随包模块），带与 Python 同强度的一套门禁：ESLint／Prettier／tsc／dependency-cruiser／knip／Vitest（覆盖 90%）／Playwright（真实 Chromium）／Stryker（凌晨作业），命令见 `make frontend-check`、`make frontend-e2e`、`make frontend-mutation`。

采用 LangGraph＋Agent Runtime Adapter（PI RPC 与 DSH headless 两个实现，`forgeloop runtime set` 可在下一个动作前热切换）。需求内任务按依赖串行执行、单执行现场，main 保持受控；验收后由受控命令接回并部署，仍需人工批准与验收。CLI 保留提交、批准、查询、请求停止与简单备份。执行器热切换命令 `forgeloop runtime show|set|list` 查看与切换当前 Agent Runtime 并保留审计。只读状态页 `forgeloop web` 在浏览器里查看需求／任务／问题处理进展（默认每 1 分钟自动刷新，配置项 `config/web.toml` 的 `refresh_seconds`，`--refresh-seconds` 可覆盖），它只读权威记录，批准与推进仍走 CLI；邮件入口仍未做。

保留原始输入、配置快照、PI 会话与可取得事件、实际测试日志和交付报告。每次授权最多三个正式测试失败轮次，追加授权与累计失败保留。首版无模型费用硬上限，保留工时限制；现场默认保留，人工清理。真实端到端验收（G01/G02）尚未执行。

## 文档入口

1. [状态记录](docs/status.md)：当前实现范围、验证数字、CI 与远程同步、未完成缺口。
2. [五步工作法需求审查](docs/requirements-review.md)：每项为什么保留、简化或后置。
3. [首版产品需求](docs/product-requirements.md)：当前实现范围与交付条件。
4. [待实现需求列表](docs/pending-requirements.md)：后置需求、触发条件和验收要求。
5. [架构说明](docs/architecture.md)：已实现的五层结构（domain/records/adapter/graph/cli）、依赖方向、业务图、持久化与外部边界；机读快照在 `contracts/architecture.json`，架构变化必须同步更新这两份文件。
6. [快速启动验收计划](docs/first-validation-plan.md)：验证真实交付（人工投入上限已按所有者决定撤销）。
7. [RoadMap](docs/roadmap.md)：先使用，再按真实痛点逐项扩展。
8. [领域术语](CONTEXT.md)与[分层决策](docs/adr/0001-orchestration-and-executors.md)。
9. [工程可靠性方案](docs/engineering-reliability.md)与[研发纪律](docs/development-discipline.md)：分层测试、统一门槛、提交纪律与激活顺序，含逐批次执行记录、失败与负例矩阵。
10. [DogFood 执行任务计划](docs/dogfood-execution-plan.md)：按需求规划、研发交付、版本交付三条业务线拆成执行任务，明确依赖、拟修改文件、验证和门槛；I01 已接通三条业务线入口，I02 同步范围与契约，真实端到端（G01/G02）未执行。

## 后置范围

邮件、页面上的操作入口（状态页首版只读，批准与推进仍在 CLI）、附件平台、自动部署、版本运维、自升级、复杂暂停恢复、多任务调度、自研 Runtime 和其他执行器均进入待实现列表。

[完整产品历史快照](docs/history/full-product-scope-2026-10-12.md)用于保留长期目标，不能扩大当前首版范围。跑通并验收一个真实小任务后即可开始使用；人工时间测量与 30 小时上限已按所有者决定撤销（2026-10-12）。
