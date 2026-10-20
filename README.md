# ForgeLoop

ForgeLoop 首版是一个 CLI 自动研发工具：把边界明确的小需求变成可验收的代码改动，用户负责批准方案与验收结果。

本文件只描述稳定的产品范围与文档索引；当前实现、验证数字、CI 与远程同步状态、未完成缺口见[状态记录](docs/status.md)。

## 首版只做这一条闭环

文本需求 → 批准范围与方案 → PI 实现／自验证 → 独立审查 → 真实测试 → 人工验收 → 交付 diff 与记录。

在此单任务闭环之上，CLI 已把三条业务线接到真实入口：项目线 `project add|list|show|update|migrate` 登记多个代码仓，每个项目使用独立记录根 `<records-root>/projects/<project_id>/`，需求、任务、检查点、会话与 worktree 互不混用；需求线 `requirement submit|revise|analyze|plan|approve|advance|accept|status` 把一条需求分析、拆成任务包并按依赖推进；任务线 `submit|approve|grant|status|stop` 执行每个任务；交付线 `candidate <task_id>`、`merge|release|deploy|rollback` 在验收后受控归并、发布并部署到本机。邮箱交互入口 `mail interact --once` 复用同一套需求、批准与执行记录，支持通过邮件提交、追问、状态查询、批准与整体验收。

状态页的行为代码是 TypeScript（`frontend/src`，编译为随包模块），带与 Python 同强度的一套门禁：ESLint／Prettier／tsc／dependency-cruiser／knip／Vitest（覆盖 90%）／Playwright（真实 Chromium）／Stryker（凌晨作业），命令见 `make frontend-check`、`make frontend-e2e`、`make frontend-mutation`。

采用 LangGraph＋Agent Runtime Adapter（PI RPC 与 DSH headless 两个实现，`forgeloop runtime set` 可在下一个动作前热切换）。每个项目使用独立记录根与项目 bare 镜像，需求内任务按依赖串行执行、任务现场是从镜像派生的 `git worktree`，main 保持受控；验收后由受控命令接回并部署，仍需人工批准与验收。CLI 保留提交、批准、查询、请求停止与简单备份；执行器热切换命令 `forgeloop runtime show|set|list` 查看与切换当前 Agent Runtime 并保留审计。只读状态页 `forgeloop web` 在浏览器里查看需求／任务／问题处理进展（默认每 1 分钟自动刷新，配置项 `config/web.toml` 的 `refresh_seconds`，`--refresh-seconds` 可覆盖），它只读权威记录，批准与推进仍走 CLI；常驻服务 `forgeloop serve` 在同一进程里提供状态页、`GET /api/service` 与页面写入口（提交/批准/推进/验收/停止），按 `config/service.toml` 心跳，**一个进程服务一个项目**（`--project` 指定，缺省取唯一已登记项目；多项目部署时按项目各起一个进程）；`auto_advance`（默认关闭）打开后可自动接续已批准需求。同一页面右栏还提供**会话面板**：按项目新建会话、发一条消息驱动一轮真实 PI 调用（**流式**写入面板，整轮结束前就能看到文字在增长）、逐次看到工具调用（名字、参数与结果摘要、风险级别、耗时；本轮跑过写入或执行类工具时在**轮次边界**停下等人批准——RPC 协议没有执行前拦截事件，文案如实写明工具已经跑过）、处理 Agent 显式提出的「待人工决定」（批准=可带指令立即重跑，拒绝=终止会话）、随时终止会话；每个活跃会话在服务端由一个**常驻 PI 进程**承接，暖进程只发本次输入、冷启动回放历史（面板注明这一轮是哪种），空闲或超出上限会被回收；PI 的自动压缩会在流水里留一条系统消息并计数，面板自己的会话记录一条不删；面板项目档案（可增删改多个代码仓）由页面维护在 `config/projects.toml`，与 `config/service.toml` 的手写项目档案不得同名。会话是过程记录，不等于研发工作项：面板不批准任务包、不做验收、不推进需求。页面写操作与本机回环、页面令牌、同源校验绑定，且调用与 CLI 相同的入口，常驻进程与页面都不代替所有者验收，见[常驻服务与页面操作入口方案](docs/resident-service-plan.md)。邮箱入口 `forgeloop mail interact --once` 与 CLI 同源：只处理 `--allowed-sender` 白名单发件人，命令词固定（`status`／`revise`／`approve <任务包版本>`／`accept`／`analyze`／`plan`／`advance`／`help`），批准确认显式绑定任务包版本，重复邮件按 Message-ID 幂等、发送失败只重发回信、不自动重放中断现场；邮件入口已有 `mail poll --once`（cron 单次轮询，只给分类建议）与 `mail confirm`（人工确认后才发信，绝不自动发信），事件通知／进展／成果仍未实现（待实现列表 B02）。自动化与凭据配置见[架构说明](docs/architecture.md)。

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

页面上的操作入口（状态页首版只读，批准与推进仍在 CLI）、附件平台、自动部署、版本运维、自升级、复杂暂停恢复、多任务调度、自研 Runtime 和其他执行器均进入待实现列表。邮箱入口的**任务级**验收／追加授权与主动进度通知仍未实现，当前邮件交互覆盖需求级提交、追问、查询、批准与整体验收。

[完整产品历史快照](docs/history/full-product-scope-2026-10-12.md)用于保留长期目标，不能扩大当前首版范围。跑通并验收一个真实小任务后即可开始使用；人工时间测量与 30 小时上限已按所有者决定撤销（2026-10-12）。
