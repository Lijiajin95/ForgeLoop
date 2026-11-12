# ForgeLoop 架构（TypeScript 原生 DSH 插件）

编写日期：2026-10-22；文档适用性与缺口说明更新：2026-10-29（同日增补运维 Agent 首版）。本文描述**当前活动实现**。
新方案的主控／独立子运行时、角色权限和全新存储见[产品与首版方案](product.md#5-宿主协调与多-agent-流程)，尚不能视为当前实现。
旧 Python／Web／serve 路线由 [ADR 0008](adr/0008-typescript-native-dsh-plugin.md) 取代，
退役代码快照已按 [ADR 0009](adr/0009-remove-retired-implementation.md) 删除；源码和旧文档从 Git 历史回查。
2026-10-28 又按 [ADR 0010](adr/0010-remove-command-surface-legacy-compat-and-commit-policy.md)
删除 `/fl` 命令表面、旧业务库兼容与本机提交时间策略。架构契约由 `contracts/architecture.json`
与 `make contracts` 强制：只固定分层、依赖方向、外部表面与退役路径；源码文件、工具和端点从实现扫描。

## 1. 目标与唯一宿主

ForgeLoop 的产品价值是复杂软件项目中的目标、约束、研发、验证、交付与运行反馈。活动实现位于
`packages/forgeloop`（TypeScript 原生 DSH 插件）。本轮把通用交互、会话、模型、工具、权限与
进程生命周期交给 DSH：

**用户只启动 DSH 宿主 → 插件提供工具与认证页面（查询 + 客户决定动作）→ 插件内持久工作服务唤醒 DSH Agent 执行 →
业务记录、证据与候选包留在项目现场。**

不再需要 `forgeloop serve`、`forgeloop-launcher`、独立 HTTP 服务或自建网页。调用 Git、
构建与测试时使用受控子进程；不得借此启动旧 Python 核心。

当前插件没有人类 slash 命令表面。需求入口是 **ForgeLoop 业务会话**：用户选择 `forgeloop`
agent preset 后，在普通输入框输入；插件在 `agent/pre-step` 接管人类输入，交给产品 Agent
澄清为结构化需求说明。任务包批准、推进、验收与停止通过浏览器认证动作实现；例外取舍与追加授权仍没有完整入口，
已批准任务包默认冻结（修改需所有者显式许可并说明原因），
不能用工具参数或文档声明代替。

## 2. 运行结构

```
DSH 宿主（唯一常驻产品）
├── 原生交互：会话 / 工具卡片
├── forgeloop-dsh 插件（同进程）
│   ├── domain/     纯规则：身份、版本、批准、失败轮次、工时、材料身份；影响事实/推断分区只经注入窄接口
│   ├── agents/     需求测试 Agent：仅凭需求说明生成测试方案；执行与业务验收由同一会话经工具完成
│   ├── records/    node:sqlite：权威记录、请求领取、动作身份、证据索引
│   ├── runtime/    协调器、Agent 执行器、正式测试、快照工作副本、候选打包、运维巡检与主动监控、状态看板事实
│   ├── session/    ForgeLoop 业务会话：preset、agent/pre-step 输入接管、自定义会话事件
│   ├── tools.ts    模型只读工具 + 需求受理（不能批准、推进或验收）
│   └── client.js   Web 会话区「天工」页 + ForgeLoop 受理/分析自定义 Chat 节点
├── DSH Agent（宿主内独立会话）
│   ├── 产品分析：仅项目 Markdown 读写与联网检索工具，结果按 JSON 校验
│   ├── 规划 / 审查：无工具，纯推理，结果按 JSON 校验
│   ├── 运维评审与诊断：只有两个只读工具（制品状态与登记日志），另读取有界监控快照或检查输出，提出已登记动作
│   └── 实现：有工具，在独立快照副本中工作
└── 项目现场：git 仓库、SQLite、证据、候选包
```

## 3. 分层与依赖方向

| 层      | 路径                                           | 允许依赖                        | 职责                                                                                                                    |
| ------- | ---------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| config  | `src/config.ts`                                | domain                          | 配置解析与路径布局；非法值装载时失败                                                                                    |
| domain  | `src/domain/`                                  | 无                              | 不可变事实与纯判定；不直接接触文件、数据库或模型实现；影响推断只经注入的无工具 Agent 窄接口                             |
| agents  | `src/agents/`                                  | domain                          | 测试 Agent 的会话内方案阶段：仅凭需求说明与任务目标生成测试方案；执行由运行时工具记录，判定只依赖真实退出码、输出与日志 |
| records | `src/records/`                                 | domain                          | SQLite 权威表读写；事务领取；不读取或修补旧业务库                                                                       |
| runtime | `src/runtime/`                                 | domain、agents、records、config | 编排、Agent、测试、快照、打包、运维巡检与主动监控、状态看板事实与任务重试准入                                           |
| entry   | `src/index.ts`、`tools.ts`、`session/`、`cli/` | 以上全部                        | 插件接入、工具表面与业务会话输入接管                                                                                    |

任务包授权由 `domain/task-plan.ts` 判定，运行时与记录层保存批准及验收材料指纹；
`domain/delivery.ts` 提供摘要计算，`domain/work.ts` 定义任务运行与产物类型，`domain/ops.ts` 定义运维目录、事件、诊断与授权规则，
`domain/monitor.ts` 定义主动监控报告、问题身份与状态自洽规则，
`domain/ops-provider.ts` 定义监控提供方契约与登记表（当前只有自研 `builtin`），
`runtime/monitor.ts` 的 `OpsMonitorProvider.collect` 是提供方的采集接口，`PROVIDER_IMPLEMENTATIONS`
登记实现；未登记描述符或未实现 `collect` 的提供方都不会被使用，
`domain/failure-advice.ts` 把失败原因、正式测试日志与审查结论整理成确定性的下一步建议。
工作副本使用 `runtime/workspace.ts` 的快照路径，包含未提交进展；文件选择遵循 Git 跟踪与忽略规则。

`client.js` 是浏览器端入口（普通 `dsh.client` 模块，不参与 tsc 编译），通过认证 Fetch 路由
读取层级工作台、需求/任务/问题/运维详情与任务执行过程，并按客户动作写入批准、推进、重试、取消、停止与运维决定；
用 `uiConversation.events.register` + `conversation.chat.node` 渲染 ForgeLoop 受理、分析、澄清与任务包节点；
不导入任何 DSH Client 包。`contracts/architecture.json`
固定槽位、视图身份、数据路径、preset 与输入接管事件；客户端节点和会话事件从源码自动发现并校验配对。

`make contracts` 扫描 `packages/forgeloop/src` 的全部 `.ts` 文件：按 `layers` 判定分层、解析相对导入、
拒绝反向/越界依赖并检测循环。模块不需要逐项登记；新增源码自动纳入检查。工具名从 `tools.ts`
自动发现并校验 `forgeloop_` 前缀与禁止的决定方法；Web 端点从 `BOARD_ENDPOINTS` 自动发现并校验每个
非默认端点都有分发分支；数据库只检查 SQLite 驱动与路径边界，表结构以 `records/db.ts` 为准。
退役路径由 `retired_paths` 拒绝重新进入工作树。文档描述仍需人工审阅，不能由检查代替。

## 4. 入口与业务闭环

### 4.1 ForgeLoop 业务会话（输入接管）

1. 插件装载时注册 `forgeloop` agent preset（无普通助手工具），展示为“ForgeLoop 业务会话”。
2. 用户在该 preset 会话的普通输入框提交文本；DSH 照常把消息交给会话 Agent。
3. 插件在 `agent/pre-step` 中检查当前生效 preset 为 `forgeloop`（运行中组合优先，
   `session.header.agentPreset` 仅作回退），排除 `origin=subagent` 或带父会话的子 Agent；
   只处理 `message.source.kind === 'user'` 的消息。
4. 对每条人类消息：用 `sessionId + messageId` 作为幂等键提交需求（版本 1），追加
   `plugin:forgeloop/intake` 会话事件，然后调用运行时 `analyzeRequirement`，由产品 Agent 输出
   目标、业务场景、业务规则、异常与边界、非目标、结构化业务要点（稳定编号 `BP-n`、依据来源、用户／触发／预期行为、
   规则、异常边界状态）、可观察验收项（`AC-n`，`point_ids` + given/when/then）、假设（`AS-n`）、验收标准与待澄清项；
   分析提示词同时携带
   `docs/forgeloop/business-context.md` 的行业与业务背景、程序查询的当前项目活动需求与任务
   （标题、状态、创建／更新时间、任务包版本与批准状态、任务状态与最近活动），已结束需求只给数量，
   与当前原文相关的少量历史要求（含已结束需求，按词面重合度有界查询并给出命中词）、
   上一次结构化说明与结构化澄清问答（问题编号、原文、所有者回答、解决结论）；这些内容只是背景事实，
   不构成授权；成功追加 `plugin:forgeloop/analysis`，失败追加
   `plugin:forgeloop/error`。有待澄清项时再追加 `plugin:forgeloop/clarification-request`。
5. 消息归属由确定性入口决定，不让模型猜：会话只有一个待澄清需求时，直接回复按澄清回答处理；
   多条待澄清时必须写“回答 <需求编号>：<回答>”指定对象；任何需要独立受理的新输入写
   “新需求：<内容>”，即使有需求待澄清也不会并入回答。回答追加需求版本并重新分析，
   追加 `plugin:forgeloop/clarification-answer`、`plugin:forgeloop/analysis`，必要时再次推送
   `plugin:forgeloop/clarification-request`。每个问题在首次提出的分析内有稳定编号
   `Q<分析版本>-<序号>`；重新分析必须逐项处置旧问题，未解决项由程序保留，模型不能静默丢弃。
6. 分析无待澄清项时，需求才入队；协调器在研发空闲时把分析全文（目标、业务场景、业务规则、
   异常与边界、非目标、验收标准、业务要点与验收项）交给研发 Agent 做技术方案与任务拆解；任务包每个任务用
   `covers` 列出覆盖的 `BP` 编号，未覆盖、引用不存在的要点按不合规退回重规，追加
   `plugin:forgeloop/plan`；产品 Agent 只出分析结论，不拆研发任务。
   规划失败追加 `plugin:forgeloop/error`。任务包落库后由测试 Agent 做实现前评审（无工具、只读），
   输出通过/阻断、阻断项与验证计划；阻断时把原因交回研发 Agent 重新拆解（最多 3 次），
   最终仍阻断则保留 `plan_proposed` 与评审记录，不能批准。规划成功把需求置为 `plan_proposed`，
   但不批准、不推进。
7. 会话末尾的 `conversation.chat.turnTail` 组件读取 `session` 端点，按
   **需要澄清 | 不需要澄清** 的顺序展示该会话已拆解需求；普通会话没有需求时不渲染。
8. 无论成功或失败都返回 `{ kind: 'reject' }`，普通模型聊天不会发生；用户看到的是自定义
   Chat 节点，不是 assistant 回复。
9. 这些自定义事件是 log-only 呈现，不带 `surfaceOp`，不进入模型历史，也不构成客户决定或验收。

`forgeloop` preset 组合为空（没有普通工具）；已在 DSH 0.2.1-rc.4 的真实 Web 会话验证
`agent/pre-step` 接管、澄清回答与规划链路。

**产品分析只执行一次。** `ExecutionPlan.executeAnalysis` 先看当前需求版本是否已有分析：
有就返回“未重复调用模型”，不再产生第二次模型调用；因此会话入口的同步分析、入队请求和
协调器的推进都不会叠加成两次分析。每次真正执行的分析尝试写入 `requirement_analysis_attempts`：
需求 ID、需求版本、attempt 序号、来源（`initial`/`auto`/`manual`）、结果、原因、模型、
提示词版本（`analysis-v4`）、轨迹文件（`sessions/<reqId>-v<需求版本>-analyze-a<n>.jsonl`）与工具调用；
成功结论另写 `requirement_analyses`，同样带这些元数据。轨迹路径同时包含需求版本与 attempt，
同一版本失败重试、不同版本首次分析都不会互相覆盖。澄清问题与回答分别写入
`requirement_clarification_questions`、`requirement_clarification_answers`，问题状态与解决版本随分析结论
同一事务更新；回答只追加，不覆盖历史。失败不会覆盖历史结论，也不清零 attempt。

产品 Agent 以 `workspace-write` 权限运行，但工具面由 `domain/analysis.ts` 的白名单固定：
`forgeloop_read_project_doc`、`forgeloop_write_project_doc`、`forgeloop_web_search`、
`forgeloop_web_fetch`；宿主登记的其他工具（shell、文件编辑等）一律 deny，也不挂 standard 编码
preset。文档工具只接受项目内 `.md` 路径（拒绝绝对路径、越界、`.git`/`node_modules` 与代码文件），
读上限 64 KiB、写上限 128 KiB，所以“禁止修改代码”由工具面确定性保证，而不是只靠提示词。
两个联网工具调用 DeepSeek Search & Fetch（`api.deepseek.com/v1/tools/search|fetch`，密钥取自
宿主环境变量 `DEEPSEEK_API_KEY`），30 秒超时、抓取正文截断 20k 字符，失败按状态码映射成原因。
密钥只读：不写入 DSH 配置或环境，不落库、不进输出；缺密钥时工具直接说明来源且不发出请求，
服务端若在错误里回显密钥，返回前替换为 `****`。

分析结果可以带 `business_context: { changed, document }`：`changed=true` 时必须给出整份 Markdown，
`changed=false` 时 `document` 必须为空；缺字段按未变化处理。`executeAnalysis` 在解析成功后由
**程序**调用 `writeProjectDoc` 写 `docs/forgeloop/business-context.md`，写失败按分析失败处理
（记 `analysis_failed`、不落分析结论），因此“识别到新背景就必须同步文档”是确定性规则，
不依赖模型遵守提示词；`forgeloop_write_project_doc` 对同一路径直接拒绝，运行时是唯一写入方。

分析失败时需求进入 `analysis_failed` 并保留失败原因；协调器每拍扫描一次，对没有在途请求、
没有主动停止且该版本 `auto` 尝试不足 3 次的失败需求排一次 `analyze`（来源
`system:analysis-retry`）。自动次数用完后仍可由看板“重新分析”排一次人工重试（来源以
`:analysis-retry` 结尾，记为 `manual`），不受 3 次上限约束。

**输入分诊。** 产品 Agent 先判定输入是需求还是问题，结论写入分析的 `input_kind`
（`requirement` / `problem`，缺省按需求），旁置存放在 `requirement_analysis_input_kinds`；
已有分析没有该记录时按需求处理。需求继续做场景、业务规则、验收标准等分析；问题不做需求拆解，
只给出现象与可检查的修复判据，`clarifications` 必须为空——解析与落库都会拒绝带待澄清项的问题分析，
所以问题不会停在待澄清，而是与分析通过的需求一样经过系统准入后由协调器直接排给研发；
研发据 `input_kind` 按“复现定位根因 → 最小修复 → 按修复判据验证”拆任务。看板的需求详情与
会话内的分析卡片展示该类型。

### 4.2 运行时内部操作

模型工具只读查询、受理需求、写项目内 Markdown 文档、联网检索或执行测试方案：`forgeloop_submit_requirement`
先落库，返回稳定需求身份与版本 1；`forgeloop_write_project_doc` 只写项目内 `.md`，不能写代码，
也不能写由运行时维护的业务背景文档；`forgeloop_web_search`/`forgeloop_web_fetch` 只读检索；
`forgeloop_run_verification_check` 与 `forgeloop_write_verification_material` 是测试会话专用入口：
分别执行方案命令、写入 `verification/` 下的测试脚本；前者执行当前候选测试方案里已登记的
label，与工具白名单外的一切命令无关；`forgeloop_ops_artifact`/`forgeloop_ops_logs` 是运维会话专用的
只读入口，只能读 `ops.artifacts` 登记的制品状态与日志尾部；其余工具只读查询。`/fl` 人类命令表面已删除。普通需求的推进由系统准入与协调器自动完成，
不再需要 Web 任务包卡片上的批准、推进、独立测试或验收动作；这些旧端点只保留历史兼容。
例外取舍仍没有完整入口，不能由工具或参数伪造。

运行时仍保留下列内部操作，供协调器、业务会话、测试和未来可靠入口复用：

1. **受理**：业务会话的输入接管或 `forgeloop_submit_requirement` 先落库，返回稳定需求身份
   与版本 1。两者都提供客户端幂等键：同键同内容复用、内容不同拒绝。可信来源的受理同时写入
   需求队列并记录提出时间；协调器只在没有在研需求与未收口请求时领取队首并为其排队 `analyze`，
   研发忙时新需求只入队等待、不并发启动；同一时间最多一个需求在研，队列为空时领取返回空。
2. **分析**：运行时排队 `analyze`；协调器领取后创建无工具 Agent，校验结构化分析
   （目标、场景、验收标准、待澄清项）并按版本保存。有待澄清项时等待人工。产品分析阶段的确定性约束：
   - 同一需求版本的并发 `analyze` 只发起一次模型调用，其余调用共享同一结果；模型返回后先核对需求是否
     仍是发起时的版本、是否被停止/取消或已有结论。迟到结果只追加一条 `stale` 分析尝试（独立轨迹），
     不更新需求状态、系统准入或业务背景；服务返回独立错误码 `analysis_stale`。
   - 格式或确定性校验失败时，同一运行内带着上一轮的具体校验错误重试一次；每次调用各自占用
     `a<n>.jsonl` 轨迹与尝试行，不覆盖第一次失败证据。仍失败才把需求置为 `analysis_failed`。
   - 业务要点必须给出可核对依据：`user_requirement` 的 `source` 要能在需求版本原文中逐字找到；
     `project_convention` 要指向项目内真实存在的 Markdown 文档；`external_material` 要是 http(s) 地址。
     与已有承诺冲突时，`conflicts` 必须引用真实存在的其他需求，并给出至少两种取舍与待决定事项；
     程序暂停系统准入并把冲突与取舍写入阻塞原因，等待所有者修订需求后重新分析。
   - 业务背景变更先落 `requirement_business_context_changes` 草稿（含需求版本、分析版本与明确 reason）；
     只有分析校验通过且无待澄清项时，程序才把草稿同步为 `docs/forgeloop/business-context.md` 并标记
     `applied`，记录文档摘要。失败或待澄清的分析只保留草稿，绝不写正式文档。
   - 澄清回答逐题绑定：每条回答记录需求版本、问题首次提出的分析版本、问题编号与同题序号。只回答一部分时，
     其余问题保持开放并继续阻断准入；同一道题可以有多条历次回答，重新分析会看到全部回答。
     会话输入支持“回答 <reqId> [Q1-1]：…”只回答指定问题。
   - 需求修订会登记 `requirement_analysis_invalidations`，旧分析保留可回查但不再作为当前版本依据；
     详情只展示当前需求版本的准入记录。业务要点/验收编号一旦在任何历史分析中使用过即退役，不得复用。
3. **研发会话路由与规划（研发 Agent 工作记录）**：系统准入后可自动排队 `advance`。运行时先把需求
   说明与已有研发会话清单（会话 ID、最近总结、忙闲、最后需求）交给无工具的主控 Agent，由它选出一个
   最合适的既有会话并给出理由；清单为空或选择不合法时新建会话。工作区随会话：一个研发会话绑定一个
   固定工作区，复用会话就在原工作区继续，需求与会话、工作区的对应关系记在新表里。选中的会话正被占用时，
   需求停在 `awaiting_dev_session`，协调器等该会话空闲后把同一需求重新排队并入，不并发插队，也不把
   等待判为失败。路由的异常路径都由程序收口：候选为空不调用模型；候选数量与最近总结长度有上限；
   调用前后各查一次停止请求；模型返回畸形 JSON、非字符串 ID、不存在的会话或未完成回合都回退为新建，
   并把原因写进需求详情；选中的会话在真正占用时失效（工作区被删、有未提交现场、宿主恢复失败）时，
   按主控给出的备选顺序继续尝试，全部不可用才改派新会话并更新需求绑定，旧会话记录与工作区保留。
   进入会话后由研发 Agent 读取代码并形成技术方案与任务拆解。任务包按实际业务成果拆成一个或多个任务，
   依赖只表达真实前置关系；每个任务必须声明 `covers` 需求条目 ID，且覆盖分析中的全部场景、业务规则、
   异常与边界和验收标准。文件清单在 TypeScript 工程内、测试命令为真实 argv；不得引用 Python、旧 `.venv`、
   旧 `forgeloop` CLI 或并行的第二个插件包。违规时在同一会话带拒绝原因重试，仍不合规即阻塞。任务包
   落库后不再做独立的实现前评审批次，也不再要求所有者批准；技术方案是研发工作记录，系统准入与验证
   证据才是后续动作依据。研发会话不因任务结束而关闭：一轮工作结束时自动总结本轮会话内容与需求内容，
   与会话 ID、需求 ID 一并落库，供下次路由与回查。旧的 `plan`／`approve` 请求与批准行仅作为历史兼容
   路径保留，不再是普通需求的常规门禁（旧显式批准链路仍使用按需求 ID 的任务级工作区，不在会话复用范围）。
4. **系统准入**：分析完成且无待澄清项后，运行时按真实需求来源、所有者、授权策略、需求版本与
   分析版本做确定性判定，写入 `requirement_admissions`。准入与人类批准分开记录，不写
   `by=owner`／`approved=true`。准入通过后需求进入 `specified`，协调器自动排入 `advance`；
   未通过则停在 `blocked` 并说明原因。可信来源前缀与是否允许代码提交由 `autonomy` 配置控制。
5. **连续推进**：一个 `advance` 请求完成方案、实现、自验、独立测试、定向修复和受控提交：
   - 在绑定的研发会话工作区里工作（工作区随会话，保留在途改动）；工作区缺失、Git 元数据损坏或基线
     为空时按当前项目 HEAD 重建并更新绑定，旧现场保留。研发会话跨请求复用，不在任务结束时关闭。
   - 研发 Agent 在同一会话与工作区中按依赖执行任务；每任务完成后由程序采集增量 diff、运行正式测试、
     记录自验与产物，并把候选提交到工作区 Git（临时快照基线提交不是产品提交）。
   - 研发自验失败留在现场继续修，不形成正式失败轮；显式配置的任务尝试上限、无进展看门狗与回合超时
     才会阻塞，停止请求始终有效。默认三者都为 `-1`（不限，页面显示 MAX），只记录过程与时长。
     取消是终态：验证/修复/提交入口会重新读取记录，迟到的在途结果不能提交；停止请求同样在提交前复核。
   - 全部任务完成后导出相对快照基线的需求级候选 diff，绑定需求版本、任务包版本、基线与 diff 摘要，
     写入 `requirement_code_candidates`；同一需求多版候选、旧报告与失败轮次保留。
   - 研发 Agent 在任务回合结束前完成白盒与黑盒自验证，并输出结构化自测试报告：自验证模式
     （`independent`／`self`）、风险、实际检查、红灯/绿灯证据与是否需要产品澄清。BUG 修复或高风险
     改动必须提供“修复前失败、修复后通过”证据；低风险文档改动可按影响选择。运行时把每次尝试的
     报告、命令、退出码、日志摘要与代码身份保存在独立 `attempts/` 目录，不覆盖历史。
   - 研发根据代码 diff 自行决定是否进入独立测试：测试方案仍按下一段在研发前准备；选择 `self`
     且自验证证据充分时跳过测试执行并直接进入受控提交，选择 `independent` 或证据不足时才使用该测试会话。
     判断 `self` 前必须读取**全部已交付任务**的持久化报告；任一任务缺报告、选择 independent 或证据不足，
     整份候选转独立测试，跨请求恢复同样适用。红灯/绿灯必须引用真实命令、基线/修复后代码身份、退出码与日志。
   - 测试材料在第一条命令执行时冻结摘要；之后脚本或输入被改写、摘要不一致，旧结果失效并阻断。
     每条命令记录冻结摘要，正向与错误对照必须复用同一份材料。
   - 任务交付、定向修复和受控提交都按实际 diff 校验 `activeRoots`：目录按路径边界匹配，文件按完整路径匹配；
     计划文件合法但实际改动越界同样阻断。
   - **准入后、研发开始前**为测试 Agent 新开一个会话并保持到本次推进结束：该会话只挂
     `forgeloop_run_verification_check`、`forgeloop_write_verification_material` 两个工具
     （`allowTools`），cwd 是真实项目目录。测试 Agent 是独立黑盒测试人员：不读取源码、不接触候选 diff、
     不使用源码变异工具；以需求、产品可见行为、工具形态、系统与环境约束为依据，参考等价类、边界值、
     判定表、状态迁移、错误猜测与风险优先级等方法设计测试。方案阶段只投
     原始需求全部版本、分析的目标/业务场景/业务规则/异常与边界/非目标（只作背景）/验收标准与结构化业务要点，
     以及已准入任务包的任务目标（`taskId：goal`），不传任务包实现细节、候选 diff、源码或工作区；有结构化要点时
     方案用 `point_ids`／`acceptance_ids` 引用并覆盖每个 `BP`/`AC`，旧分析仍逐字覆盖场景与验收标准；任一缺项
     即 fail-closed，方案不入库。落盘位置
     `<project>/verifications/<req>/v<plan>/plan/verification-plan.json`，会话轨迹同目录。
   - 独立测试方案要求每个必过场景同时包含正向检查与错误对照（`expect_failure: true`）；正向必须成功、
     对照必须失败，缺少任一或对照返回 0 都判阻断。错误对照来自无效输入、缺失依赖、越权操作或环境故障，
     以黑盒可观察行为为准；不要求也不允许读取源码或生成源码补丁。
   - 研发前的方案只固定场景、`BP`/`AC`、输入、预期与反例，不写命令；候选固定后在同一测试会话里
     依据只读公开接口准备命令，再合并回设计并校验覆盖。旧方案已带命令时跳过该准备步骤。
   - 研发产物交付后，运行时按固定快照建立**独立测试工作区**并应用候选 diff，只允许写 `verification/`；
     随后在**同一个测试会话**里投递执行提示词，由模型逐条调用
     `forgeloop_run_verification_check(req_id, label)`。运行时只接受当前候选测试方案中已登记的
     label，其他会话、方案外命令、猜写的命令一律拒绝；同一 label 在一个候选上幂等，重复调用返回
     上一次的真实结果。工具调用必须携带宿主注入的 `session_id`／`attempt_id`，与当前执行上下文不一致
     即拒绝；测试材料写入拒绝经过符号链接的路径。退出码、超时、中止、耗时、日志路径与 `logSha256` 全部由程序记录，并在执行
     前后核对 HEAD 与 `verification/` 之外的文件变化，任何越界都记为完整性问题。第一条命令执行前
     封存 `verification/` 材料摘要；之后换脚本或换输入都会使正向结果失效并要求重新测试。
   - 错误对照必须取得非零退出码且输出命中目标规则；无退出码、超时、信号终止或无关报错都不算有效
     对照。失败额度由协调器领取、定向修复与再次送验共用：额度用尽后
     问题单本身不再自动入队，必须由有效追加授权恢复。
   - 执行轮结束时，方案中任一 label 没有真实执行记录、执行上下文丢失或收到停止请求，都按当前
     attempt 写入 `verification.json` 并计入 `verification-prep` 失败轮；中止、超时、材料错误与
     上下文丢失分别记录 `failureKind`，不建需要改代码的研发问题单。业务终审超时/畸形另写
     `business-review-error.json`，与同一次尝试绑定。命令失败、输出不满足预期或完整性告警才生成 `VerificationRecord`，阻断计入
     `stage=verification`，并按问题单流程修复。
   - 判定只按工具记录的真实结果：只有全部方案命令退出码为 0、未超时/中止、输出满足预期、必过场景
     覆盖完整且候选未被改动才判通过；模型在文本里声称“已执行/已通过”不构成证据。
   - 每条测试命令按 `acceptance`／`regression`／`integration`／`artifact` 标注证据类别，必过场景至少
     一条 acceptance；报告按类别汇总计数。同一候选的复验各自保留 attempt 报告与命令日志，旧尝试不被覆盖。
   - 测试通过后，**同一个测试会话**继续按原始需求做业务验收（方案、执行、验收同一 `sessionId`）；
     有结构化要点时报告逐条给出 `points` 与 `acceptance` 的编号结果，旧分析仍覆盖业务场景、验收标准、
     业务规则与异常边界；逐项引用实际执行的命令标签与可在输出中核对的原文。结论绑定候选、验证摘要与需求版本，阻断计入 `stage=business_review`。终审证据只取
     工具记录的命令输出，并同时保留开头与末尾两段（中间可省略）；只截尾部会把开头打印的前置证据
     误判为不可核对。
   - 测试阻断时创建关联需求 ID 的 ForgeLoop 内建问题单：固化本次验证的命令、退出码、日志路径、
     运行环境与状态。同一推进请求内先按问题单在**同一研发会话与工作区**定向修复并重新验证；
     单请求验证重试次数由 `maxVerificationAttempts` 控制（默认 `-1` 表示不限，页面显示 MAX），
     显式设为 `> 0` 时达到该次数仍失败就收口为 `blocked`，由协调器依据未收口问题单自动排队
     下一次修复与验证。跨请求重试同样默认不设轮次上限，attempt 与验证历史持续累积，不归档全部
     任务、不清空失败轮次、不重建任务包。业务验收阻断默认按不限的失败轮次额度处理；显式配置
     `failureRoundsPerGrant > 0` 时按额度阻塞。
   - **系统准入需求的连续验证**（`runtime/verification-pipeline.ts`）与上面同一会话的旧验证路径并存：
     研发产物交付后按任务 diff 重建固定候选，测试 Agent 在候选工作区写
     `verification/{commands.json,report.json}`；程序重跑命令。该路径仍保留旧的补丁式对照兼容，
     但模型工具面已不再提供源码补丁登记；新的黑盒错误对照由 `expect_failure` 命令承担。
   - 阻断按事实分类（`domain/verification-failure.ts`）：实现缺陷、用例错误、环境异常、证据不足、
     需求争议、原因未明。只有实现缺陷且仍有失败额度时才回研发定向修复；其余保留阻断并给出各自处置，
     不要求研发产生无意义 diff，也不把分类当作放行。
   - 每次验证尝试有独立 `attemptId`、序号与 `previousAttemptId`，证据目录为
     `verifications/<req>/v<plan>/<candidate 前 16 位>/attempt-<n>/`；`requirement_verification_attempts`
     追加保存，`requirement_verifications` 只作为最新结果投影。同一候选只对已知非实现缺陷做有界复验
     （最多 3 次），旧报告、日志与结论不被覆盖；新候选不能沿用旧候选通过结果。
6. **受控提交**：验证与业务验收通过后，主控取得仓库级提交锁，核对真实项目工作树干净、HEAD 与候选
   基线一致，在临时工作树应用候选并运行 `autonomy.commitCheckCommand`；检查通过后重新核对工作树、
   暂存区与 HEAD，只暂存并提交该候选 diff，再核对暂存内容摘要。提交失败时反向应用候选并撤销本次
   暂存，不用 reset/clean 清空他人在途工作；提交成功记录 SHA、文件清单、检查命令与日志。
   不 push、不打 tag、不递增版本；锁被占用、现场变化或基线变化时阻断并保留双方现场。
7. **候选包**：只从“已通过独立测试的那一份工作区”复制构建。构建前同时核对测试报告与业务验收
   文件摘要及规范字段、候选 diff 摘要与身份、测试工作区 HEAD 树/未提交改动、受控提交的实际
   文件集合与候选文件集合；任一缺失、被修改或互不关联都拒绝。构建副本对全部受版本控制的源码
   做快照，构建或打包步骤改变其中任一文件即拒绝，不沿用旧验证结论。通过后再执行构建与
   `npm pack`，核对包版本与 tarball 摘要，记录候选包身份、验证绑定、受控提交与构建证据
   （`candidate-builds`）。准入需求不再要求旧任务包批准或整体验收；有旧批准/验收时仅作兼容。
   验证之后内容或版本变化形成新候选，必须重新验证；本地入口见
   `npm run candidate --workspace forgeloop-dsh`。
8. **发布与上线核对**：发布使用独立授权。安装由外部受控机制完成；`deploy` 核对目标 profile 的安装
   文件与包内内容逐一致、安装版本与实际运行版本、候选 diff 中本次需求源码模块随包加载、
   看板/记录入口与业务验收/提交记录，并读取插件装载时写入的 `runtime-identity.json`，
   校验存活 PID 与安装入口/服务摘要一致，写入 `deployments`。发布授权缺失只阻断安装与上线，
   不回退已完成研发、验证和本地提交。
   部署执行与上面的“上线核对”分开：`deployment-intent` 经门禁与 preflight 后按 target 的
   `approval` 进入 `awaiting_approval` 或自动 apply；intent 可显式指定需求，省略时用 target 的
   默认需求，门禁按该需求校验当前版本、系统准入、候选、独立测试、业务终审与受控提交。
   人类验收只对 `approval: "owner"` 目标必需；`auto` 目标由 target 配置授权，不能用验收记录
   替代系统交付判定。`autoDeliver` 目标在普通需求受控提交后由协调器自动构建、提议并（auto 时）
   apply，再由协调器执行 `status` 核对；owner 目标停在 `awaiting_approval` 等真实决定。
   `delivery_handoffs` 按需求+候选+target 持久化交接状态，重复轮询与宿主重启不重复构建/安装。
   `delivery_rechecks` 单独记录“原事件复核”，部署核对完成与复核完成互不覆盖：复核抛异常或宿主
   重启后仍会续跑，已完成的不会被重开。
   门禁不只在 intent 创建时执行：preflight、等待批准与 apply 之前都会按当前记录重新核对停止、
   需求版本、候选、验证与授权；预检后依据变化只拒绝执行，不改变 intent 状态，显式恢复并重新
   满足门禁后仍可批准。安装或核对中途中断时，协调器先按 target 的 `status` 只读观测实际结果：
   一致则收口为已安装待核对/已核对，不一致转失败，无法确认时保留原状态并记录一次待人工决定，
   不重复调用安装工具。
   交付推进（自动交接、核对超时收口、中断恢复）在协调器里有独立的执行链与定时器，
   不等同一轮研发请求收口；长研发任务因此不会阻塞部署核对或 `verifyTimeoutSeconds` 超时处理。
   `deployment-approve/-reject/-verify/-rollback` 只由认证看板以 `config.owner` 调用，
   `DeploymentService` 仍复核所有者身份；部署决定（批准/核对）记录执行者，供自主率统计区分
   人工与系统动作。回退先按 target 声明的卷/迁移执行 `data-rollback`，再执行 `rollback`，
   最后用 `status` 复核；回退失败与 `verify_failed` 向配置的 webhook 尽力发送告警。
   核对同时比对版本、安装制品摘要与运行中制品摘要；工具无法提供摘要或摘要不一致时保持
   `verify_failed`，不把“版本相同”当作同一构建。
   运维诊断只能输出 `proposed_deployment: { target_id }`，由主控校验已登记 target 与事件资源，
   需求取事件关联的修复需求或 target 默认需求，再走同一部署门禁；修复需求部署核对通过后，
   协调器回到原事件执行原检查并记录 `fix_check` 观测，通过则关闭事件，仍失败则转 `unresolved`。
   模型工具面没有部署、批准或回退参数，只有只读 `forgeloop_rollouts`。
9. **查询与呈现**：影响摘要、看板和会话摘要共用权威记录；`submit`、`analyze`、`advance`、`retry`、
   `requeue`、`stop`、`cancel`、`deployment-intent/-approve/-reject/-verify/-rollback`
   以及历史兼容的 `plan/approve/verify/build/deploy/accept` 组成写动作端点。准入需求的验收是所有者
   对交付物的显式记录，不再要求旧任务包批准；验收身份绑定最近一次代码候选，部署门禁再绑定制品摘要。
   普通需求展示 `specified/developing/verifying/committed` 与准入、候选、提交证据（含提交信息）；历史
   `plan_proposed/approved` 卡片保留给旧记录，不作为新需求的常规批准入口。停止会记录请求时间、人和原因，
   撤销待执行请求并置阻塞；实际停稳时间单独记录。扫描、重启和重复唤醒不会自动恢复，只有显式
   `advance`/`requeue` 才恢复并重新校验版本、额度与边界。失败任务卡展示运行原因、失败轮次与确定性建议；重试只重排一次 advance，不清零累计、
   不越过项目边界。中断/超时按未交付收口，研发现场保留，可继续执行。
10. **运维巡检与主动监控**：协调器按 `ops.intervalSeconds` 运行登记的只读检查；失败按签名归并为 `ops` 事件。
    按 `ops.monitor.intervalSeconds` 另跑主动监控：`runtime/monitor.ts` 采集主机负载/CPU/内存、`ps` 进程聚合、
    HTTP 延迟、日志尾部、外部告警文件、检查最后状态与活动事件，`runtime/ops-monitor.ts` 把有界快照交给
    运维 Agent 评审；报告畸形成 `error` 摘要而不建事件。快照记录产生它的提供方
    （`providers`，来自 `domain/ops-provider.ts` 的登记表，当前只有 `builtin`），配置里写未登记的
    提供方在装载时失败；外部工具接入按同一只读契约登记后才会被接受。扫描结束由
    `runtime/ops-heartbeat.ts` 向登记的 `heartbeat.url` 上报一次存活（GET/POST，一次尽力、不重试），
    结果写 `ops_heartbeat_last` 并进入监控摘要，用于让外部死信服务发现“监控整体停摆”。问题按
    `monitor/<资源>/<key>` 归并，新问题建事件并由主控校验资源、动作与参数。
    运维 Agent 只有两个只读工具：`forgeloop_ops_artifact`（`ops.artifacts` 登记的制品运行状态）与
    `forgeloop_ops_logs`（登记日志尾部），不接受任意路径；它另读取快照/检查输出与登记动作目录，
    输出业务影响、事实、推断与一个动作建议。
    主控校验动作与参数：目录 `auto` 且诊断未要求人工时自动执行，否则停在待决定；页面批准后由协调器执行。
    动作先写 running 意图再启动，退出码 0 才进入恢复复核；复核只认登记检查退出码。
    超时/中止是确定事实（动作未完成、无退出码），按未解决收口；宿主中断时动作标为 `interrupted`，
    事件按未解决收口，再由运维 Agent 基于已记录事实分析根因并上报，不自动重放。
    新事件按配置向 webhook 发送一次尽力告警，结果作为 `alert`/`alert_error` 观测留档。
    未恢复或诊断 `fix_required` 时创建关联修复需求并排队分析。
    当前不抢占研发任务，每个事件最多执行一次动作；细节与限制见[运维 Agent](ops-agent.md)。

### 4.3 天工层级工作台（Web 只读事实 + 客户动作）

- 入口仍是 `conversation.view` 的 `forgeloop` 视图（标签「天工」/Forge）。页面提供
  **层级工作台 / 全部任务 / 需要处理 / 可靠性 / 运维** 入口；左侧需求树按需求 → 任务 → 关联问题展开，
  中间显示当前需求的目标、状态、版本、交付进度、待处理事项与任务列表/依赖切换，右侧为统一详情。
- 详情分 **概览 / 前后序 / Agent 执行过程 / 测试与审查 / 变更记录**；支持面包屑、选中高亮、
  展开完整详情，窄屏按列表 → 详情逐级进入并返回。搜索、筛选、选中对象、详情分区与执行尝试在切换时保留。
- 任务执行过程由 `taskExecution` 读取证据目录中的 `dev.jsonl`：只展示用户/助手公开文本、
  工具调用与结果、阶段事件；过滤模型 reasoning 与 DSH 运行上下文提醒，按 `callId` 关联调用和结果，
  分页返回总数/截断。执行尝试、会话、候选、日志、审查均由证据行和真实身份绑定；历史失败轮次没有
  独立执行文件时明确标记不可用，不用顺序或文件名猜测。
- 搜索走同一认证 `board` 端点，`query` 只匹配权威记录中的文字事实：需求身份/状态/原文与版本、
  分析结论、最新任务包与任务目标/文件/验收标准、任务运行原因、失败轮次、请求说明与看板问题文字；
  不读取 Agent 日志文件。`limit` 限制 1..100，客户端默认请求 100；结果被截断时页面明确提示。
  `board` 同时返回运行构建身份（插件版本、启动时间、已装载客户端摘要与源码客户端摘要），页脚在缺失时
  显示“未记录”，在界面与源码不一致时显示警告；来源仍是运行身份与只读文件摘要，不猜测。
  终态需求（`committed`/`accepted`/`rejected`/`cancelled`）只显示最终状态，不再回放历史批准与评审警告；
  取消需求的任务默认折叠且不计入交付进度分母，原记录仍可在详情回查。
- 需求详情由 `requirementDetail` 返回：原文与版本历史、分析（目标/场景/验收标准/待澄清）、
  `analysisHistory`（全部历次分析）、`clarificationHistory`（问题与回答）、`specChanges`
  （本次新增/修改/移除的要点与验收、已解决/仍待澄清/新增问题）以及页面同源生成的需求说明，
  最新任务包正文（技术方案、任务、文件、依赖）、交付进度与产物摘要、验收记录、批准、失败轮次与请求。
  页面按“目标/范围与待决定事项 → 业务要点及验收 → 规则、异常、非目标与依据 → 可展开历史”呈现，
  不另维护独立 PRD；这些字段只读，不新增批准或推进入口。
- 任务详情由 `taskDetail` 返回：目标、依赖、允许文件、验收标准、实际运行状态、失败原因与建议、
  失败轮次、Agent 活动（最近 120 条及总数）、正式测试日志（末尾 4000 字符、字节数、路径与截断标记）、
  独立审查结论、交付产物摘要、证据路径与会话身份。`taskExecution` 进一步返回执行阶段、公开事件、
  工具调用/输出、尝试列表、会话与测试头信息。心跳/最后活动不是推进证明；页面把超过 60 秒
  未更新的运行中任务标为可能停滞。
- **运维**视图读取 `ops` 端点：顶部显示主动监控状态、最近扫描、CPU／内存／负载、来源计数与告警配置；
  下方为事件列表、严重度与状态、业务影响、诊断事实与推断、处置记录与证据路径；
  动作只有批准/拒绝处置、关闭与生成修复需求。服务端校验事件状态、动作目录与参数，
  页面不执行命令，也不另存业务状态。
- **可靠性**视图读取只读 `reliability` 端点，分两层：质量快照（门禁、测试、覆盖率、关键文件、变异与预算）
  来自显式执行 `make reliability-report` 写入的 `reports/reliability/latest.json`；交付可靠性（验证、首轮、
  业务终审、上线、失败轮次、运维恢复与 MTTR、候选构建与最近事件）来自 SQLite 追加型记录。
  快照固定路径、按 mtime 缓存，绑定生成时的 Git 提交；缺失、损坏、过期（HEAD 不一致、工作树脏或超过 7 天）
  分别显示，不把未采集或未运行算成通过。页面请求不执行任何检查；窗口只接受 `7d/30d/90d/all`（默认 `all`），
  任务运行只显示当前状态，不回放历史趋势。下钻先切回 `hierarchy` 再复用需求/任务详情。
- 状态区分：`awaiting_input` 表示最近活动显示 `ask_user_question`；`stopRequested` 表示存在未恢复的
  主动停止记录，不等于已经停稳。两者都不等于任务已经停稳或结果已经收口；中断的运维动作以 `interrupted` 记录，
  根因报告作为观测与证据展示，不是新的业务状态。
- 需求级动作由服务端 `actions` 判定：`plan`、`approve`、`advance`、`verify`、`requeue`、
  `build`、`deploy`、`stop`、`cancel`；任务级 `retry` 仍由 `retryTask` 复核批准、额度、任务顺序与
  在途请求。准入需求在 `committed` 后即可 `build`；旧链路仍要求验收。`requeue` 在失败停在 blocked 后重新排队一次执行（与 `retry` 共用 `retryDecision`：
  额度、在途请求、批准状态与终态都在判定里拦下，不新建任务包、不清零失败轮次）；协调器的
  `autoAdvance` 打开时，同一判定也会自动为 blocked 需求排队；`build` 对旧链路要求验收后构建，对准入链路要求验证、
  业务验收、提交与候选齐全，且只从已测试工作区构建；`deploy` 只做安装后核对。批准入口还会按现行 `validateTaskPlan` 复校已落库
  任务包，旧规则下生成的任务包不会被放行。
- **执行范围**：需求批准后，研发执行 Agent 使用 DSH 默认代码工具，权限 preset 为
  `workspace-write`（只允许写隔离工作副本）；文件范围是当前工作副本内的全部文件，只允许改动
  当前项目，不得改动其他项目。任务包的 `files` 只是计划说明，不是硬边界。运行时仍采集完整候选
  diff、逐任务改动与审查证据，越界不再靠清单拒绝，而由宿主沙箱、独立审查、正式测试与验证结论把关。
  版本号（`package.json` 的 `version`）不得由执行角色擅自改动，除非任务明确要求并获所有者许可。
- **任务包冻结**：任务包批准后版本冻结，不再提供 `replan`，也不再自动重新生成。`plan` 请求在
  入队与执行两处都校验冻结状态；只有所有者显式确认并说明原因（端点 `confirmPlanChange=true`
  与 `reason`，来源写入 `plan-change:<原因>`）才允许生成新版本。
- **测试失败回研发**：独立测试阻断时，运行时归档旧产物、清空交付并把阻断问题写回任务运行原因，
  在同一持久请求内重新交给执行 Agent 修复，再重新验证；任务包版本不变。默认不限制修复次数
  （`failureRoundsPerGrant=0`、`maxVerificationAttempts=0`）；显式配置额度时，用尽后停在 blocked，
  等待追加授权或所有者决定。
- 天工页不提供验收；验收仍在任务包会话完成。页面不另存业务状态，所有事实来自 SQLite 与登记证据。

### 4.3.1 工作区绑定与隔离（2026-11-12）

- **绑定键**：每个 DSH Workspace 一个租户，租户键取工作区 id，记录目录
  `<recordsRoot>/projects/ws-<workspaceId>`；工作区路径本身就是该租户的 `projectPath`。
  同一工作区内的业务会话、研发会话、验证会话共享同一份记录，不同工作区之间不共享
  SQLite、工作区、证据、候选、集成、部署记录、运维事件与日志。
- **模式判定**：装载时读取宿主 `workspaceRegistry`；存在即进入多工作区模式，
  枚举已注册工作区并按需创建运行时与协调器。没有该服务的宿主（headless profile）
  保持单项目模式；单项目模式只是没有工作区身份可绑定时兼容路径，不是跨工作区回退。
- **会话身份**：业务会话取 `session.header.cwd`；研发/验证/运维子会话的 cwd 在租户记录目录内。
  解析顺序是先比较工作区路径，再判断是否位于某租户记录目录内（按路径边界，不做字符串前缀匹配）。
  未归属任何工作区的会话在受理、工具与看板三处都失败关闭，不落到默认项目。
- **工具入口**：模型工具按 `exec.agent.session.header.cwd` 解析租户，只调用该租户的运行时；
  没有 agent 或解析不到租户时返回明确拒绝。工具注册仍然一次完成，作用域在每次调用时解析。
- **看板入口**：`/api/forgeloop/board` 的每个请求都必须携带 `sessionId`，服务端按该会话的
  工作区选择记录库与协调器；请求体里的任何工作区标识都不作数。缺少会话返回
  `session_required`，会话未绑定工作区返回 `workspace_unbound`，跨工作区的需求/任务/运维/
  部署身份按 `not_found` 处理，不泄露对方是否存在。
- **旧目录兼容**：profile 中显式配置的 `project`/`projectPath` 只作为旧项目名复用条件，
  仅当某个工作区路径与旧 `projectPath` 完全相同时沿用 `<recordsRoot>/projects/<旧 project>`；
  其他工作区一律使用 `ws-<id>`，不会自动挂载无法证明归属的旧目录。
- **当前限制**：部署目标与运维检查清单仍来自 profile 级配置（记录、工具根与回滚点按工作区隔离）；
  两个工作区登记同一部署目标时，安装副作用仍落在同一目标。工作区删除后的运行时释放尚未接入
  注册表变更事件，需重启或后续补齐。以上均按“未落实”记录，不当作已隔离。

### 4.4 放开限制与自主率（2026-11-03）

- **限额语义统一**：`-1` 表示不限，界面显示 MAX；正数恢复原行为。任务工时、需求工时、
  任务尝试、失败轮次/追加授权与验证次数默认 `-1`，配置项与统计保留；格式重试类仍有正数上限
  （规划 3、实现前评审 2、分析/诊断 3），避免畸形输出无限循环。
- **来源准入放开**：默认 `allowAnySource=true`、`requireOwner=false`，任何非空来源都可进入系统
  准入，需求来源与提交者在 `requirements`/`requirement_versions` 完整记录；收紧时显式设置
  `allowAnySource=false` 并维护 `trustedSources`。运维事件在 `awaiting_decision` 状态也可生成
  修复需求，来源记为 `ops:<event>`，可进入产品分析后转研发。
- **真实模型验证**：测试会话在研发前生成方案，产物交付后在独立候选工作区逐条执行真实命令并做
  业务验收；测试阻断回到研发定向修复，默认不限轮次，但失败记录、问题单与验证历史继续累积。
  `make real-model-e2e`（opt-in）用真实模型走通提交→准入→研发→验证→受控提交。
- **研发不可部署**：研发 Agent 只有 `workspace-write` 与普通代码工具，任务拆解与执行提示词都
  禁止部署、发布、安装到正式 profile 或修改正式环境；部署只由所有者在认证 Web 端点按独立授权
  执行，研发自验通过不等于可部署。
- **自主率**：看板 `autonomy` 从权威记录计算研发/运维的人工介入率与自主成功率；需求或事件为零
  时比率为 `null`，页面显示“无样本”，不把空样本算成 0% 或 100%。分子分母随看板一并返回，可回查
  需求版本、授权、工时延长审计、请求、提交、验证与运维事件。

## 5. 持久化

- 引擎：SQLite，Node 内置 `node:sqlite`，WAL 与 `busy_timeout`；不引入原生扩展。
- 位置：`<recordsRoot>/projects/<project>/records.sqlite`；插件运行日志固定写入
  `<recordsRoot>/projects/<project>/logs/plugin.log`（同时保留宿主 console 输出）。
- 表：需求与版本、分析、分析尝试（含 `stale` 迟到审计）、分析失效登记、结构化需求说明（`requirement_analysis_specs` JSON 旁置）、澄清问题与逐题回答（`requirement_clarification_question_answers`，旧格式只读回退）、业务背景变更草稿与应用记录、系统准入、需求队列、内建问题单、主动停止与恢复、任务包、历史任务包批准／实现前评审、
  需求级代码候选、受控提交、独立测试（含追加式验证尝试）、业务验收、任务运行、任务产物、产物历史、工时、取消、证据路径、失败轮次、授权、候选包、
  候选构建、部署核对、持久请求、动作身份、运行元信息，研发会话、需求与会话绑定、研发会话总结（`dev_sessions`、
  `requirement_dev_sessions`、`dev_session_summaries`），以及运维事件、运维观测与运维动作 attempt；
  权威 Schema 在 `records/db.ts`，契约只固定 SQLite 驱动、数据库路径与单库边界，不复制表清单。
- 新库从空库按当前结构建立；不承担旧业务库兼容、补列、迁移或只读历史查询。
  旧记录和证据按历史保留，但不进入当前产品承诺。
- 证据：`workspaces/dev-sessions/<session>/` 保存研发会话工作区（一个会话一个固定工作区，`dev-meta.json`
  与其父目录记录基线和需求版本，元数据不进入候选），`sessions/dev-sessions/<session>/` 保存同会话的轨迹；
  `workspaces/<req>/dev/` 只为旧显式批准链路与问题单证据保留；`evidence/<req>/v<plan>/<task>/` 保存每任务 `candidate.diff`、`formal-test.log`、
  `review.json`、`dev-a*.jsonl`；需求级候选在 `candidates/<req>/v<plan>/candidate-<n>.diff`；
  候选包在 `candidates/<req>/v<plan>/`；独立测试按候选与尝试保存在
  `verifications/<req>/v<plan>/<candidate 前 16 位>/attempt-<n>/`（`candidate.json`、`candidate.diff`、
  命令日志、敏感性对照副本与日志、`verification.json`、`business-review/`）；提交检查在
  `integrations/<req>/<candidate 前 16 位>/`；
  产品分析每次尝试的 Agent 轨迹在 `sessions/<reqId>-v<需求版本>-analyze-a<n>.jsonl`（不覆盖历史尝试）；
  运维证据在 `ops/<事件>/`。

## 6. 持久工作、去重与恢复

- 请求状态：`pending → claimed → done | failed | dismissed`。没有 unknown 中间态：
  执行者中断后，工作副本是一次性快照，直接判 failed 并丢弃快照，随后可重新执行。
- 任务运行状态：`running → delivered | awaiting_user | failed | blocked`。停止、超时与宿主中断
  都收口为 `failed`/`blocked` 并写入确定原因；不保留“无法判定”的任务状态。
- 受理先落库再返回；`service_requests` 对同需求同动作复用、不同动作拒绝，数据库唯一索引兜底。
  协调器在分析完成后由 `autoAdvanceRequests` 排入 `advance`，不要求人工点击推进。
- 需求队列：`requirement_queue` 按提出时间升序、同一时间按入队序号排序；领取是单条原子操作，
  已有在研需求时不领取，终态需求被跳过。队列占用在需求进入终态、`blocked`、待澄清或没有自动
  推进时收口，后续需求才可领取；入队本身不等待当前研发完成。首次分析成功后需求才入队：
  会话入口先同步分析再入队，非会话入口在提交时排一次分析，执行器保证不会展开第二次分析；
  `analysis_failed` 不进入自动推进候选，只由协调器的自动重试与看板的人工重试处理。
- 测试失败回流：独立测试判定阻断时写入 `requirement_issues`，包含需求 ID、attempt、阶段、状态、
  阻断项、命令与日志、环境、测试报告摘要与候选身份。未收口问题单让需求继续占用研发位；协调器
  自动排队下一次修复与验证，跨请求重试不设轮次上限，验证结果与问题单都按需求 ID 可反查。
- 协调器单实例、单条领取：`UPDATE … WHERE state='pending'` 原子领取；重复唤醒不会重复执行。
- 单消费者锁：`<记录根>/host.lock` 目录原子创建并记录 PID；第二个宿主只读、不领取、不把
  别人的在途请求不领取、不修改；进程已退出的残留锁会被清理后重试一次。
- 宿主启动时：`claimed` 请求改为 `failed`（执行者已不在，结果按“未交付”收口），丢弃该任务包
  的一次性工作副本，`started` 动作改为 `interrupted`，仍为 `running` 的任务运行标为 `blocked`
  （任务未交付，副本会在下次执行时重建）；恢复摘要（含丢弃的工作副本）写入 `runtime_meta`。
- 停止：需求级操作撤销待执行请求并记录状态；当前在途 Agent 的取消接在协调器整体停止路径，
  需求级取消未落实。中断的任务按未交付收口，可重新执行。
- 运维：动作先写 running 意图；宿主启动时把未收口的动作标为 `interrupted`，事件按 `unresolved`
  收口，并由运维 Agent 基于事实分析根因、写出观测与证据；不自动重放有副作用的动作。
  主动监控按 `ops.monitor.intervalSeconds` 由协调器在锁内触发；`ops_monitor_at` 记录扫描时间，
  模型失败或报告畸形只更新 `ops_monitor_last`，不会每拍重试，也不会把空结果当成健康。
  旧库中的运维 `unknown` 在启动时迁移为 `interrupted`/`unresolved`，新路径不写入该状态。
- 工时：只累计真实执行段，用户等待不计入；限额 `-1`（默认，页面显示 MAX）表示不限，仍持续累计
  消耗并展示。显式配置正数限额时在推进开始检查，尚未在每个后续动作／尝试前复检。
- **中断恢复**：不保留“无法判定”的状态。执行发生在一次性快照内，运行时是唯一写入记录的一方；
  宿主重启时把 `claimed` 判为 `failed`、丢弃快照，再由 `requeue`/`autoAdvance` 重新执行。
  残余风险是执行者在沙箱内发起的网络调用等外部副作用无法回收，已在状态记录中列为边界。
- 失败额度与验收失败入口等已知缺口见[状态记录 §4.1](status.md#41-当前实现缺口2026-10-28-整理)。

## 7. 信任边界

- **业务会话入口**：只有 `agentPreset=forgeloop` 的非子 Agent 会话中、来源为真实人类
  （`source.kind === 'user'`）的消息才受理；会话身份、消息身份与原始文本落库后可回查。
  输入接管只创建需求、回答待澄清项并调用产品 Agent；批准与推进走任务包卡片的认证动作，
  不来自聊天文本或模型工具。
  澄清回答与稳定问题编号及 `reqId + requirementVersion + analysisVersion` 对应；直接回复只在单个
  待澄清需求时使用，多待澄清项必须写明“回答 <reqId>：”，其他会话不得猜测。新需求入口
  “新需求：”只是文本分诊前缀，不是可批准、推进或验收的命令表面。
- **模型工具**：只读查询、需求受理与项目 Markdown 文档写入（不含代码）。工具不能提交
  `by=owner` 或 `approved=true`，也不能触发
  推进或验收。`forgeloop_impact` 默认不调用模型；显式 `explain=true` 的推断与事实分区，
  推断不能作为批准、推进或验收依据。
- **客户决定入口**：普通需求由系统准入自动推进；浏览器认证动作保留停止、取消、追加授权、发布/
  部署、运维处置与真正的业务例外取舍。历史任务包批准与验收入口只服务旧记录，不是新需求常规门禁。
  已批准任务包对旧流程仍冻结，修改需所有者显式许可并说明原因。
  不能把工具参数、消息角色标签或模型转述当作所有者决定；动作身份使用本机 owner 配置。
- **Agent**：身份只有产品、主控、研发、验证、运维五种。主控 Agent 只做研发会话路由（无工具，只输出
  会话 ID 与理由），不推进流程、不验收；研发 Agent 在绑定的研发会话工作区连续工作并自验，会话不主动
  删除，结束时留下与会话 ID 关联的总结；测试 Agent 在研发前新开测试会话生成方案，交付后在同一会话通过
  运行时工具执行方案命令，再按原始需求做业务验收，命令由运行时按方案 label 执行并核对候选完整性，
  测试会话收尾即关闭；运维 Agent 只在登记目录内诊断和处置。模型自评、消息投递回执与工具退出码
  都不是验收证据。系统准入、候选身份、验证绑定、提交检查与停止/恢复由运行时执行，页面与工具只展示
  服务端判定，不能提交 `by=owner` 或 `approved=true`。
- 已知边界：审查的“受控访问”是独立会话＋无工具＋固定 diff，不是 OS/容器级隔离；宿主插件
  本身拥有比普通工作区工具更宽的文件权限，必须继续按动作检查授权。
  当前实现 Agent 请求 `danger-full-access`，副本与事后 diff 校验没有落实副本外写入的预防性限制。

## 8. DSH 接缝与版本

- 宿主服务：`ctx.agents`（创建/驱动/恢复会话：`create`、`resume`）、`ctx.tools`、`ctx.subprocess`、
  `ctx.permissionPresets`（可选）、`agentDefaultModel`（可选）、`ctx.agentPresets`（可选，
  业务会话 preset 注册）。影响摘要的推断复用 `ctx.agents`，只在显式 `--explain`/`explain=true`
  时创建无工具会话。
- 研发会话恢复只依赖 `ctx.agents.resume`：宿主缺这个接口、恢复超时、宿主报错或返回空/残缺句柄时明确失败，
  不新建同名会话冒充恢复；需求随后改派新会话并更新绑定，旧会话记录与工作区保留。恢复等待有上限
  （默认 60 秒，`resumeTimeoutMs` 可覆盖），超时后晚到的句柄会被释放，避免泄漏。
- `agent/pre-step` waterfall 负责业务会话输入接管；`ctx.on` 的监听器随插件 effect 释放。
  业务会话事件使用 `session.append` 追加自定义事件，客户端用 `uiConversation.events.register`
  与 `conversation.chat.node` 注册节点和渲染器。
- Web 接缝（可选）：宿主半用 `ctx.inject(['connection'])` 注册 `ctx.connection.fetch.register`
  的认证路由 `/api/forgeloop/board`，端点 `board`、`detail`、`session`、`task`、`execution`、
  `plan`、`approve`、`advance`、`verify`、`requeue`、`build`、`deploy`、`retry`、`cancel`、`accept`、`stop`，
  以及运维 `ops`、`ops-detail`、`ops-decide`、`ops-close`、`ops-request-fix`，和只读 `reliability`；
  `board` 支持 `query`/`limit` 搜索，`detail` 返回需求原文/任务包/交付/验收材料，`task` 返回运行、日志截断、审查与证据身份。
  浏览器半是 `dsh.client` 模块，经 `ctx.slots.inject('conversation.view')` 注册「天工」工作台（英文 Forge），
  并注册 ForgeLoop Chat 节点（含技术方案/任务包）与 `conversation.chat.turnTail` 需求摘要，
  用同源 `fetch` 读取数据并提交 owner 动作。
  profile 不提供连接服务时不激活，headless profile 的装载不受影响。
- 不用 `ctx.connection.rpc.handle()`：DSH 0.2.1-rc.2 中它以 Connection 插件自身的上下文为注册
  owner，该上下文没有注入 `webServer`，注册即抛错；Fetch 路由是同一认证层的宿主功能入口。
- 已验证本机版本：DSH `0.2.1-rc.4`、Node `26.11.1`、TypeScript `5.9`、SQLite 通过
  `node:sqlite`。参考源码版本见 ADR 0008。
- 插件以 npm bundle 发布：`dsh.bundle.patch` 插入 `forgeloop-dsh` 行；`engines.dsh` 限定范围。

### 8.1 配置来源

- 业务配置存放在 ForgeLoop 自己的文件：默认 `~/.forgeloop/config.json`，可用
  `FORGELOOP_CONFIG` 指定其他路径；DSH 的 `cordis.patch.yml` 只负责装载插件，不再保存
  `recordsRoot`、`project`、`autoAdvance` 等业务配置。
- 合并顺序：宿主装载参数做底，独立文件覆盖；文件缺失且装载参数也没有关键值时插件**装载失败**
  并指出路径，不静默回落到“当前目录/.forgeloop”（否则会连到另一个记录库）。
- 文件是普通 JSON，字段与 `RawConfig` 一致；非法 JSON、非对象在装载期报错。
- 修改配置后需要重载插件宿主；业务数据（记录库、证据、工作副本）仍只在 `recordsRoot` 下。

## 9. 已退役与清理

| 旧形态                                              | 处置                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Python 业务核心、旧测试与工程工具                   | `legacy/` 工作树副本已删除；活动检查由 vitest/tsc/`scripts/ts/` 承担                  |
| 自建网页、`serve` / `web`、邮件与热升级启动器       | 随退役快照删除；既往交付记录按当时事实保留                                            |
| 旧配置与发布／部署工作流快照                        | 随 `legacy/` 删除；保留活动 Node／TypeScript CI                                       |
| `scripts/install_local_service.sh`                  | 删除失效的 Python／systemd 接入入口；当前安装见部署说明                               |
| `/fl` 人类命令表面与命令契约                        | 删除 `commands.ts`、`cli-contract.json` 与命令专用测试；客户决定入口待新方案实现      |
| 旧业务库兼容                                        | 删除补列逻辑与兼容声明；新库从空库建立                                                |
| 本机提交时间策略                                    | 删除 `commit-policy` 脚本、配置模板、年历、钩子与 CI 作业；提交授权只来自用户明确要求 |
| 孤立的内存批准簿、材料绑定、阶段路由与 worktree API | 删除无活动调用的重复实现；保留实际授权、快照、正式测试与验收路径                      |

历史源码从 Git 回查。架构契约的 `retired_paths` 登记退役仓库路径，检查拒绝其重新进入工作树，
包括同时放回旧源码与 `legacy/` 的情况。

## 10. 未验证与后续

- 五种 Agent 的连续闭环（含主控 Agent 的研发会话路由）、系统准入、需求级候选、独立测试/业务验收、定向修复与受控提交已实现；
  真实 DSH + DeepSeek v4.1 Flash 已跑通一条需求（`req-20261030155523-5939e5`，提交
  `667cf99b31a8`）。层级工作台保留停止、取消、恢复、构建与上线动作；旧批准/实现前评审/验收
  按钮已从客户端操作区移除，历史记录只读展示。
  需求/任务编辑、草稿删除、问题补充说明、等待回答与完整重新规划仍无服务端入口，不能用按钮冒充。
- 真实 Debian/生产宿主、容器隔离、多用户身份、远程访问未验证。
- 运维 Agent 已接入协调器与天工视图，但真实线上事件、严重故障抢占研发与外部接管核对尚未验证；
  当前只在本地命令与行为测试中验证，限制见[运维 Agent](ops-agent.md#9-首版限制如实保留)。
- 邮件／IM、自动发布／部署和跨版本升级兼容尚未形成当前完整能力。新首版的发布与运维要求见统一方案。
- 候选安装仍由 `plugin_manager` 等外部机制完成；安装后的正式上线核对只在行为测试中验证，未在正式需求执行。
- 验证、研发与业务终审 Agent 仍是宿主内会话与 `workspace-write`，不是 OS 隔离。
- 变异测试已接入 Stryker：`make mutation` 覆盖 `src` 下全部源码，夜间按模块分片执行并由
  `make mutation-merge` 校验每个源码文件都进入报告；格式化使用 Prettier（`make format`）。
  依赖审计已配置为 `make audit`，实际执行与验证情况见状态记录。
- DSH 仍是 developer preview；升级可能改变接缝，需按版本重新验证。

## 11. 进阶可靠性门禁（2026-11-03）

在不改变业务分层与外部接缝的前提下，新增一组机器可执行、可阻断的可靠性入口。
详细口径见[进阶代码可靠性门禁](reliability.md)。

- 清单：`contracts/reliability.json` 登记核心模块、关键不变量、状态机迁移、P0 场景、
  稳定性测试与受控变异范围；不重复 `contracts/architecture.json` 的分层/依赖规则。
  `scripts/ts/reliability-registry.ts` 校验结构、文件存在、门禁或 N/A 理由、属性测试
  `min_runs >= 200`、状态机终态闭包与 Stryker break 一致，并接入 `make check-static`。
- 测试：`tests/property-invariants*.test.ts`（fast-check，失败打印 seed 与 shrink 反例）、
  `tests/state-machines.test.ts`（部署穷举、需求终态/合法边、任务运行结果、ops 入口）、
  `tests/p0-scenarios.test.ts`（null/越界/超时/重试耗尽/DB 失败/资源释放/状态冲突/幂等/中断）。
  共享参数在 `tests/property-support.ts`，清单加载在 `tests/contract-support.ts`。
- 执行器：`scripts/ts/reliability-lib.ts` 串行跑 vitest 并解析 JSON；
  `scripts/ts/reliability-tests.ts` 按清单分组运行属性/状态机/场景；
  `scripts/ts/stability.ts` 对登记测试串行独立运行 3 次并区分 FAIL/ERROR；
  `scripts/ts/mutation-incremental.ts` 只变异 `git diff BASE` 影响源码及其直接依赖
  （或清单受控范围），有效得分必须 ≥80，关键文件不允许存活变异；
  `scripts/ts/reliability-report-advanced.ts` 汇总为 `reports/reliability-advanced.json`
  与控制台 Markdown，ERROR/缺失报告不算 PASS。
- 变异执行器使用 `packages/forgeloop/vitest.mutation.config.ts`：与快速配置相同，另排除
  依赖宿主 `ps` 进程表的 `tests/monitor.test.ts`（Stryker 沙箱内假失败）；该用例仍在
  正常测试与覆盖率中运行，不排除业务源码、不下调 break。
- 报告落在已忽略的 `reports/`：`reliability-advanced.json`、`stability.json`、
  `mutation-incremental.json`；均带 base/head SHA、时间戳、分母与范围。
- CI：PR/push 的 `quality.yml` 运行 `make reliability-advanced`（增量变异，不做全量）；
  nightly 以更大属性次数、更多稳定性轮次运行同一入口，并保留全量覆盖率与 8 分片变异；
  release 保持 real-host E2E。
- 持久化表、外部工具契约与运行时状态机没有新增或改名；本批只新增测试、门禁脚本、
  报告入口与一处幂等资源释放修复（`Database.close()`，回归测试先红后绿）。
