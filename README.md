# ForgeLoop

ForgeLoop 首版是一个 CLI 自动研发工具：把边界明确的小需求变成可验收的代码改动，用户负责批准方案与验收结果。

## 当前状态

2026-10-12，Asia/Shanghai：按“快速启动＋五步工作法”重新审查范围，文档已调整；同日复刻 EvidHist 工程可靠性方案（方案文档＋工程骨架＋纪律件，入口见[工程可靠性方案](docs/engineering-reliability.md)）并完成**首版系统架构实现**：domain（失败轮次/授权/批准绑定/时间限额）、records（SQLite 权威记录）、adapter（PI RPC JSONL＋测试命令）、graph（LangGraph 两次批准＋失败回边）、cli（submit/approve/grant/status --json/stop）。181 项六层测试通过（含变异/覆盖/结构门槛脚本与全部负例），行/分支覆盖 96.2%/91.2%，`make check` 十项门槛全绿，变异 199/246 杀死（47 幸存全部审阅登记）；**pi_live 真实 RPC 与真实模型已实测**：协议层全部验证；模型层经 cc-switch-open-code-go/deepseek-v4.1-flash 真实调用取得结果（最终文本、用量、健康事件流），验收计划步骤 1 达成。已初始化 Git 仓库（main 分支），首个 commit 因提交时间纪律（法定工作日 09:00–18:00 禁止）顺延至当日 18:00 后；GitHub 远程仓库创建／同步仍由用户手动完成。执行记录见[工程可靠性方案第 13 节](docs/engineering-reliability.md#13-首批执行记录2026-10-12首版系统架构实现)。

## 首版只做这一条闭环

文本需求 → 批准范围与方案 → PI 实现／自验证 → 独立审查 → 真实测试 → 人工验收 → 交付 diff 与记录。

采用 LangGraph＋Python PI RPC Adapter，PI 在受限容器中使用独立工作副本。单任务执行，main 保持受控；验收后由用户人工接回代码与部署。CLI 提供提交、批准、查询、请求停止与简单备份，不先做页面和邮件。

保留原始输入、配置快照、PI 会话与可取得事件、实际测试日志和交付报告。每次授权最多三个正式测试失败轮次，追加授权与累计失败保留。首版无模型费用硬上限，保留工时限制；现场默认保留，人工清理。

## 文档入口

1. [五步工作法需求审查](docs/requirements-review.md)：每项为什么保留、简化或后置。
2. [首版产品需求](docs/product-requirements.md)：当前实现范围与交付条件。
3. [待实现需求列表](docs/pending-requirements.md)：后置需求、触发条件和验收要求。
4. [最小架构](docs/architecture.md)：CLI、一个业务图、PI Adapter 与本地记录。
5. [快速启动验收计划](docs/first-validation-plan.md)：30 小时人工投入上限内验证真实交付。
6. [RoadMap](docs/roadmap.md)：先使用，再按真实痛点逐项扩展。
7. [领域术语](CONTEXT.md)与[分层决策](docs/adr/0001-orchestration-and-executors.md)。
8. [工程可靠性方案](docs/engineering-reliability.md)与[研发纪律](docs/development-discipline.md)：复刻自 EvidHist 的分层测试、统一门槛、提交纪律与激活顺序；配套骨架（pyproject.toml、Makefile、config/、.semgrep.yml、pre-commit、CI）已创建，全部未执行。

## 后置范围

邮件、管理页面（含原先只读状态页优先任务）、附件平台、自动部署、版本运维、自升级、复杂暂停恢复、多任务调度、自研 Runtime 和其他执行器均进入待实现列表。

[完整产品历史快照](docs/history/full-product-scope-2026-10-12.md)用于保留长期目标，不能扩大当前首版范围。30 小时是人工投入上限，不是必须用满的工期；跑通并验收一个真实小任务后即可开始使用。
