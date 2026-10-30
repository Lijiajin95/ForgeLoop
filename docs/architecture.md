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
agent preset 后，在普通输入框输入；插件在 `agent/pre-step` 接管人类输入，交给需求 Agent
拆解为结构化需求。任务包批准、推进、验收与停止通过浏览器认证动作实现；例外取舍与追加授权仍没有完整入口，
已批准任务包默认冻结（修改需所有者显式许可并说明原因），
不能用工具参数或文档声明代替。

## 2. 运行结构

```
DSH 宿主（唯一常驻产品）
├── 原生交互：会话 / 工具卡片
├── forgeloop-dsh 插件（同进程）
│   ├── domain/     纯规则：身份、版本、批准、失败轮次、工时、材料身份；影响事实/推断分区只经注入窄接口
│   ├── records/    node:sqlite：权威记录、请求领取、动作身份、证据索引
│   ├── runtime/    协调器、Agent 执行器、正式测试、快照工作副本、候选打包、运维巡检、状态看板事实
│   ├── session/    ForgeLoop 业务会话：preset、agent/pre-step 输入接管、自定义会话事件
│   ├── tools.ts    模型只读工具 + 需求受理（不能批准、推进或验收）
│   └── client.js   Web 会话区「天工」页 + ForgeLoop 受理/分析自定义 Chat 节点
├── DSH Agent（宿主内独立会话）
│   ├── 分析 / 规划 / 审查：无工具，纯推理，结果按 JSON 校验
│   ├── 运维诊断：无工具，只读检查输出，提出已登记动作
│   └── 实现：有工具，在独立快照副本中工作
└── 项目现场：git 仓库、SQLite、证据、候选包
```

## 3. 分层与依赖方向

| 层 | 路径 | 允许依赖 | 职责 |
| --- | --- | --- | --- |
| config | `src/config.ts` | domain | 配置解析与路径布局；非法值装载时失败 |
| domain | `src/domain/` | 无 | 不可变事实与纯判定；不直接接触文件、数据库或模型实现；影响推断只经注入的无工具 Agent 窄接口 |
| records | `src/records/` | domain | SQLite 权威表读写；事务领取；不读取或修补旧业务库 |
| runtime | `src/runtime/` | domain、records、config | 编排、Agent、测试、快照、打包、运维巡检、状态看板事实与任务重试准入 |
| entry | `src/index.ts`、`tools.ts`、`session/`、`cli/` | 以上全部 | 插件接入、工具表面与业务会话输入接管 |

任务包授权由 `domain/task-plan.ts` 判定，运行时与记录层保存批准及验收材料指纹；
`domain/delivery.ts` 提供摘要计算，`domain/work.ts` 定义任务运行与产物类型，`domain/ops.ts` 定义运维目录、事件、诊断与授权规则，
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
   `plugin:forgeloop/intake` 会话事件，然后调用运行时 `analyzeRequirement`，由需求 Agent 输出
   目标、业务场景、验收标准与待澄清项；分析提示词同时携带程序查询的当前项目活动需求与任务
   （标题、状态、创建／更新时间、任务包版本与批准状态、任务状态与最近活动），已结束需求只给数量，
   这些内容只是背景事实，不构成授权；成功追加 `plugin:forgeloop/analysis`，失败追加
   `plugin:forgeloop/error`。有待澄清项时再追加 `plugin:forgeloop/clarification-request`。
5. 同一会话存在待澄清需求时，下一条人类消息按澄清回答处理：追加需求版本并重新分析，
   追加 `plugin:forgeloop/clarification-answer`、`plugin:forgeloop/analysis`，必要时再次推送
   `plugin:forgeloop/clarification-request`；不会新建第二条需求。
6. 分析无待澄清项时，把需求分析全文（目标、业务场景、验收标准）交给研发 Agent 做技术方案与
   任务拆解，追加 `plugin:forgeloop/plan`；需求 Agent 只出分析结论，不拆研发任务。
   规划失败追加 `plugin:forgeloop/error`。任务包落库后由验证 Agent 做实现前评审（无工具、只读），
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

### 4.2 运行时内部操作

模型工具仍只读查询或受理需求：`forgeloop_submit_requirement` 先落库，返回稳定需求身份与
版本 1；其余工具只读查询。`/fl` 人类命令表面已删除。批准、推进、重新生成任务包、独立验证与
验收的唯一入口是 Web 任务包卡片上的认证动作；例外取舍仍没有完整入口，不能由工具或参数伪造。

运行时仍保留下列内部操作，供协调器、业务会话、测试和未来可靠入口复用：

1. **受理**：业务会话的输入接管或 `forgeloop_submit_requirement` 先落库，返回稳定需求身份
   与版本 1。两者都提供客户端幂等键：同键同内容复用、内容不同拒绝。
2. **分析**：运行时排队 `analyze`；协调器领取后创建无工具 Agent，校验结构化分析
   （目标、场景、验收标准、待澄清项）并按版本保存。有待澄清项时等待人工。
3. **规划（研发 Agent 工作记录）**：系统准入后可自动排队 `advance`；首个 `advance` 在需求级研发
   工作区中由研发 Agent 读取代码并形成技术方案与任务拆解。任务包必须≥2 个任务、至少一条依赖、
   文件清单在 TypeScript 工程内、测试命令为真实 argv；不得引用 Python、旧 `.venv`、旧 `forgeloop`
   CLI 或并行的第二个插件包。违规时在同一会话带拒绝原因重试，仍不合规即阻塞。任务包落库后不再做
   独立的实现前评审批次，也不再要求所有者批准；技术方案是研发工作记录，系统准入与验证证据才是
   后续动作依据。旧的 `plan`／`approve` 请求与批准行仅作为历史兼容路径保留，不再是普通需求的常规门禁。
4. **系统准入**：分析完成且无待澄清项后，运行时按真实需求来源、所有者、授权策略、需求版本与
   分析版本做确定性判定，写入 `requirement_admissions`。准入与人类批准分开记录，不写
   `by=owner`／`approved=true`。准入通过后需求进入 `specified`，协调器自动排入 `advance`；
   未通过则停在 `blocked` 并说明原因。可信来源前缀与是否允许代码提交由 `autonomy` 配置控制。
5. **连续推进**：一个 `advance` 请求完成方案、实现、自验、独立验证、定向修复和受控提交：
   - 在**包含未提交在途改动的快照副本**中建立需求级研发工作区；需求版本变化时重建，旧现场保留。
   - 研发 Agent 在同一会话与工作区中按依赖执行任务；每任务完成后由程序采集增量 diff、运行正式测试、
     记录自验与产物，并把候选提交到工作区 Git（临时快照基线提交不是产品提交）。
   - 研发自验失败留在现场继续修，不形成正式失败轮；任务尝试超限、停止或超时才阻塞。
   - 全部任务完成后导出相对快照基线的需求级候选 diff，绑定需求版本、任务包版本、基线与 diff 摘要，
     写入 `requirement_code_candidates`；同一需求多版候选、旧报告与失败轮次保留。
   - 验证 Agent 从研发工作区按固定快照建立**独立验证工作区**，应用候选 diff，只能写 `verification/`；
     运行时拒绝 `verification/` 之外的改动、HEAD 变化或命令修改候选，并重新执行命令，只按退出码、
     超时、必过场景覆盖与证据原文判定。验证场景由产品需求说明的场景与验收标准生成，不再依赖
     实现前评审记录。阻断计入 `stage=verification` 的失败轮次。
   - 验证通过后，同一验证会话继续按原始需求做业务验收；结论绑定候选、验证摘要与需求版本，阻断计入
     `stage=business_review`。原独立审查与业务终审合并到验证 Agent，不再由产品 Agent 另开会话终审。
   - 验证阻断且额度未尽时，把具体缺陷、复现条件与证据回给**同一研发会话与工作区**定向修复；修复后
     产生新候选并重新验证，不归档全部任务、不清空失败轮次、不重建任务包。额度用尽才停在 `blocked`。
6. **受控提交**：验证与业务验收通过后，主控核对真实项目工作树干净、HEAD 与候选基线一致，在临时
   工作树应用候选并运行 `autonomy.commitCheckCommand`；检查通过后只把该候选 diff 暂存到真实项目、
   创建本地提交，记录提交 SHA、文件清单、检查命令与日志。不 push、不打 tag、不递增版本、不混合其他
   在途改动；项目不干净或基线变化时阻断并保留候选。
7. **候选包**：只从“已通过独立验证的那一份工作区”复制构建，先核对受保护内容摘要与验证记录一致，
   再执行构建与 `npm pack`，核对包版本与 tarball 摘要，记录候选包身份、验证绑定与构建证据
   （`candidate-builds`）。验证之后内容或版本变化形成新候选，必须重新验证；本地入口见
   `npm run candidate --workspace forgeloop-dsh`。
8. **发布与上线核对**：发布使用独立授权。安装由外部受控机制完成；`deploy` 核对目标 profile 的安装
   文件与包内内容逐一致、安装版本与实际运行版本、本次需求模块随包加载、看板/记录入口与验收记录，
   写入 `deployments`。发布授权缺失只阻断安装与上线，不回退已完成研发、验证和本地提交。
8. **查询与呈现**：影响摘要、看板和会话摘要共用权威记录；`submit`、`analyze`、`advance`、`retry`、
   `requeue`、`stop`、`cancel` 以及历史兼容的 `plan/approve/verify/build/deploy/accept` 组成写动作端点。
   普通需求展示 `specified/developing/verifying/committed` 与准入、候选、提交证据；历史
   `plan_proposed/approved` 卡片保留给旧记录，不作为新需求的常规批准入口。停止会中止该需求当前在途
   请求并置阻塞。失败任务卡展示运行原因、失败轮次与确定性建议；重试只重排一次 advance，不清零累计、
   不越过项目边界。中断/超时按未交付收口，研发现场保留，可继续执行。
9. **运维巡检**：协调器按 `ops.intervalSeconds` 运行登记的只读检查；失败按签名归并为 `ops` 事件。
   运维 Agent 无工具，只读取检查输出与登记动作目录，输出业务影响、事实、推断与一个动作建议。
   主控校验动作与参数：目录 `auto` 且诊断未要求人工时自动执行，否则停在待决定；页面批准后由协调器执行。
   动作先写 running 意图再启动，退出码 0 才进入恢复复核；复核只认登记检查退出码。
   超时/中止是确定事实（动作未完成、无退出码），按未解决收口；宿主中断时动作标为 `interrupted`，
   事件按未解决收口，再由运维 Agent 基于已记录事实分析根因并上报，不自动重放。
   未恢复或诊断 `fix_required` 时创建关联修复需求并排队分析。
   当前不抢占研发任务，每个事件最多执行一次动作；细节与限制见[运维 Agent](ops-agent.md)。

### 4.3 天工层级工作台（Web 只读事实 + 客户动作）

- 入口仍是 `conversation.view` 的 `forgeloop` 视图（标签「天工」/Forge）。页面提供
  **层级工作台 / 全部任务 / 需要处理 / 运维** 入口；左侧需求树按需求 → 任务 → 关联问题展开，
  中间显示当前需求的目标、状态、版本、交付进度、待处理事项与任务列表/依赖切换，右侧为统一详情。
- 详情分 **概览 / 前后序 / Agent 执行过程 / 测试与审查 / 变更记录**；支持面包屑、选中高亮、
  展开完整详情，窄屏按列表 → 详情逐级进入并返回。搜索、筛选、选中对象、详情分区与执行尝试在切换时保留。
- 任务执行过程由 `taskExecution` 读取证据目录中的 `dev.jsonl`：只展示用户/助手公开文本、
  工具调用与结果、阶段事件；过滤模型 reasoning 与 DSH 运行上下文提醒，按 `callId` 关联调用和结果，
  分页返回总数/截断。执行尝试、会话、候选、日志、审查均由证据行和真实身份绑定；历史失败轮次没有
  独立执行文件时明确标记不可用，不用顺序或文件名猜测。
- 搜索走同一认证 `board` 端点，`query` 只匹配权威记录中的文字事实：需求身份/状态/原文与版本、
  分析结论、最新任务包与任务目标/文件/验收标准、任务运行原因、失败轮次、请求说明与看板问题文字；
  不读取 Agent 日志文件。`limit` 限制 1..100，客户端默认请求 50；结果被截断时页面明确提示。
- 需求详情由 `requirementDetail` 返回：原文与版本历史、分析（目标/场景/验收标准/待澄清）、
  最新任务包正文（技术方案、任务、文件、依赖）、交付进度与产物摘要、验收记录、批准、失败轮次与请求。
- 任务详情由 `taskDetail` 返回：目标、依赖、允许文件、验收标准、实际运行状态、失败原因与建议、
  失败轮次、Agent 活动（最近 120 条及总数）、正式测试日志（末尾 4000 字符、字节数、路径与截断标记）、
  独立审查结论、交付产物摘要、证据路径与会话身份。`taskExecution` 进一步返回执行阶段、公开事件、
  工具调用/输出、尝试列表、会话与测试头信息。心跳/最后活动不是推进证明；页面把超过 60 秒
  未更新的运行中任务标为可能停滞。
- **运维**视图读取 `ops` 端点：事件列表、严重度与状态、业务影响、诊断事实与推断、处置记录与证据路径；
  动作只有批准/拒绝处置、关闭与生成修复需求。服务端校验事件状态、动作目录与参数，
  页面不执行命令，也不另存业务状态。
- 状态区分：`awaiting_input` 表示最近活动显示 `ask_user_question`；`stopRequested` 表示阻塞原因是
  请求停止。两者都不等于任务已经停稳或结果已经收口；中断的运维动作以 `interrupted` 记录，
  根因报告作为观测与证据展示，不是新的业务状态。
- 需求级动作由服务端 `actions` 判定：`plan`、`approve`、`advance`、`verify`、`requeue`、
  `build`、`deploy`、`stop`、`cancel`；任务级 `retry` 仍由 `retryTask` 复核批准、额度、任务顺序与
  在途请求。`requeue` 在失败停在 blocked 后重新排队一次执行（与 `retry` 共用 `retryDecision`：
  额度、在途请求、批准状态与终态都在判定里拦下，不新建任务包、不清零失败轮次）；协调器的
  `autoAdvance` 打开时，同一判定也会自动为 blocked 需求排队；`build` 要求验收后且
  只从已验证工作区构建；`deploy` 只做安装后核对。批准入口还会按现行 `validateTaskPlan` 复校已落库
  任务包，旧规则下生成的任务包不会被放行。
- **执行范围**：需求批准后，研发执行 Agent 使用 DSH 默认代码工具，权限 preset 为
  `workspace-write`（只允许写隔离工作副本）；文件范围是当前工作副本内的全部文件，只允许改动
  当前项目，不得改动其他项目。任务包的 `files` 只是计划说明，不是硬边界。运行时仍采集完整候选
  diff、逐任务改动与审查证据，越界不再靠清单拒绝，而由宿主沙箱、独立审查、正式测试与验证结论把关。
  版本号（`package.json` 的 `version`）不得由执行角色擅自改动，除非任务明确要求并获所有者许可。
- **任务包冻结**：任务包批准后版本冻结，不再提供 `replan`，也不再自动重新生成。`plan` 请求在
  入队与执行两处都校验冻结状态；只有所有者显式确认并说明原因（端点 `confirmPlanChange=true`
  与 `reason`，来源写入 `plan-change:<原因>`）才允许生成新版本。
- **验证失败回研发**：独立验证阻断时，运行时归档旧产物、清空交付并把阻断问题写回任务运行原因，
  在同一持久请求内重新交给执行 Agent 修复，再重新验证；任务包版本不变。修复次数受失败轮次额度
  约束，额度用尽后停在 blocked，等待追加授权或所有者决定。
- 天工页不提供验收；验收仍在任务包会话完成。页面不另存业务状态，所有事实来自 SQLite 与登记证据。

## 5. 持久化

- 引擎：SQLite，Node 内置 `node:sqlite`，WAL 与 `busy_timeout`；不引入原生扩展。
- 位置：`<recordsRoot>/projects/<project>/records.sqlite`。
- 表：需求与版本、分析、系统准入、任务包、历史任务包批准／实现前评审、需求级代码候选、受控提交、
  独立验证、业务验收、任务运行、任务产物、产物历史、工时、取消、证据路径、失败轮次、授权、候选包、
  候选构建、部署核对、持久请求、动作身份、运行元信息，以及运维事件、运维观测与运维动作 attempt；
  权威 Schema 在 `records/db.ts`，契约只固定 SQLite 驱动、数据库路径与单库边界，不复制表清单。
- 新库从空库按当前结构建立；不承担旧业务库兼容、补列、迁移或只读历史查询。
  旧记录和证据按历史保留，但不进入当前产品承诺。
- 证据：`workspaces/<req>/dev/` 保存需求级研发工作区（`dev-meta.json` 与其父目录记录基线和需求版本，
  元数据不进入候选）；`evidence/<req>/v<plan>/<task>/` 保存每任务 `candidate.diff`、`formal-test.log`、
  `review.json`、`dev-a*.jsonl`；需求级候选在 `candidates/<req>/v<plan>/candidate-<n>.diff`；
  候选包在 `candidates/<req>/v<plan>/`；独立验证按候选身份保存在
  `verifications/<req>/v<plan>/<candidate 前 16 位>/`（`candidate.json`、`candidate.diff`、命令日志、
  `verification.json`、`business-review.json`）；提交检查在 `integrations/<req>/<candidate 前 16 位>/`；
  运维证据在 `ops/<事件>/`。

## 6. 持久工作、去重与恢复

- 请求状态：`pending → claimed → done | failed | dismissed`。没有 unknown 中间态：
  执行者中断后，工作副本是一次性快照，直接判 failed 并丢弃快照，随后可重新执行。
- 任务运行状态：`running → delivered | awaiting_user | failed | blocked`。停止、超时与宿主中断
  都收口为 `failed`/`blocked` 并写入确定原因；不保留“无法判定”的任务状态。
- 受理先落库再返回；`service_requests` 对同需求同动作复用、不同动作拒绝，数据库唯一索引兜底。
  协调器在分析完成后由 `autoAdvanceRequests` 排入 `advance`，不要求人工点击推进。
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
  旧库中的运维 `unknown` 在启动时迁移为 `interrupted`/`unresolved`，新路径不写入该状态。
- 工时：只累计真实执行段，用户等待不计入；目前在推进开始检查，尚未在每个后续动作／尝试前复检。
- **中断恢复**：不保留“无法判定”的状态。执行发生在一次性快照内，运行时是唯一写入记录的一方；
  宿主重启时把 `claimed` 判为 `failed`、丢弃快照，再由 `requeue`/`autoAdvance` 重新执行。
  残余风险是执行者在沙箱内发起的网络调用等外部副作用无法回收，已在状态记录中列为边界。
- 失败额度与验收失败入口等已知缺口见[状态记录 §4.1](status.md#41-当前实现缺口2026-10-28-整理)。

## 7. 信任边界

- **业务会话入口**：只有 `agentPreset=forgeloop` 的非子 Agent 会话中、来源为真实人类
  （`source.kind === 'user'`）的消息才受理；会话身份、消息身份与原始文本落库后可回查。
  输入接管只创建需求、回答待澄清项并调用需求 Agent；批准与推进走任务包卡片的认证动作，
  不来自聊天文本或模型工具。
  澄清回答与 `reqId + requirementVersion + analysisVersion` 对应；多待澄清项或其他会话不得猜测。
- **模型工具**：只读查询与需求受理。工具不能提交 `by=owner` 或 `approved=true`，也不能触发
  推进或验收。`forgeloop_impact` 默认不调用模型；显式 `explain=true` 的推断与事实分区，
  推断不能作为批准、推进或验收依据。
- **客户决定入口**：普通需求由系统准入自动推进；浏览器认证动作保留停止、取消、追加授权、发布/
  部署、运维处置与真正的业务例外取舍。历史任务包批准与验收入口只服务旧记录，不是新需求常规门禁。
  已批准任务包对旧流程仍冻结，修改需所有者显式许可并说明原因。
  不能把工具参数、消息角色标签或模型转述当作所有者决定；动作身份使用本机 owner 配置。
- **Agent**：身份只有产品、研发、验证、运维四种。研发 Agent 在需求级工作区连续工作并自验；
  验证 Agent 在独立工作区只写 `verification/`，运行时重跑命令并核对候选完整性，随后在同一会话按
  原始需求做业务验收；运维 Agent 只在登记目录内诊断和处置。模型自评、消息投递回执与工具退出码
  都不是验收证据。系统准入、候选身份、验证绑定、提交检查与停止/恢复由运行时执行，页面与工具只展示
  服务端判定，不能提交 `by=owner` 或 `approved=true`。
- 已知边界：审查的“受控访问”是独立会话＋无工具＋固定 diff，不是 OS/容器级隔离；宿主插件
  本身拥有比普通工作区工具更宽的文件权限，必须继续按动作检查授权。
  当前实现 Agent 请求 `danger-full-access`，副本与事后 diff 校验没有落实副本外写入的预防性限制。

## 8. DSH 接缝与版本

- 宿主服务：`ctx.agents`（创建/驱动会话）、`ctx.tools`、`ctx.subprocess`、
  `ctx.permissionPresets`（可选）、`agentDefaultModel`（可选）、`ctx.agentPresets`（可选，
  业务会话 preset 注册）。影响摘要的推断复用 `ctx.agents`，只在显式 `--explain`/`explain=true`
  时创建无工具会话。
- `agent/pre-step` waterfall 负责业务会话输入接管；`ctx.on` 的监听器随插件 effect 释放。
  业务会话事件使用 `session.append` 追加自定义事件，客户端用 `uiConversation.events.register`
  与 `conversation.chat.node` 注册节点和渲染器。
- Web 接缝（可选）：宿主半用 `ctx.inject(['connection'])` 注册 `ctx.connection.fetch.register`
  的认证路由 `/api/forgeloop/board`，端点 `board`、`detail`、`session`、`task`、`execution`、
  `plan`、`approve`、`advance`、`verify`、`requeue`、`build`、`deploy`、`retry`、`cancel`、`accept`、`stop`，
  以及运维 `ops`、`ops-detail`、`ops-decide`、`ops-close`、`ops-request-fix`；
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

| 旧形态 | 处置 |
| --- | --- |
| Python 业务核心、旧测试与工程工具 | `legacy/` 工作树副本已删除；活动检查由 vitest/tsc/`scripts/ts/` 承担 |
| 自建网页、`serve` / `web`、邮件与热升级启动器 | 随退役快照删除；既往交付记录按当时事实保留 |
| 旧配置与发布／部署工作流快照 | 随 `legacy/` 删除；保留活动 Node／TypeScript CI |
| `scripts/install_local_service.sh` | 删除失效的 Python／systemd 接入入口；当前安装见部署说明 |
| `/fl` 人类命令表面与命令契约 | 删除 `commands.ts`、`cli-contract.json` 与命令专用测试；客户决定入口待新方案实现 |
| 旧业务库兼容 | 删除补列逻辑与兼容声明；新库从空库建立 |
| 本机提交时间策略 | 删除 `commit-policy` 脚本、配置模板、年历、钩子与 CI 作业；提交授权只来自用户明确要求 |
| 孤立的内存批准簿、材料绑定、阶段路由与 worktree API | 删除无活动调用的重复实现；保留实际授权、快照、正式测试与验收路径 |

历史源码从 Git 回查。架构契约的 `retired_paths` 登记退役仓库路径，检查拒绝其重新进入工作树，
包括同时放回旧源码与 `legacy/` 的情况。

## 10. 未验证与后续

- 批准、推进、取消、验收与停止已实现；层级工作台与任务执行过程已实现；
  已批准任务包默认冻结，验证阻断会在同一请求内回研发修复。实现前评审、独立验证、业务终审、候选构建与上线核对已实现并由运行时强制，
  但尚未在真实正式需求上跑通完整批次（截至 2026-10-30，正式需求停在中断核对后的 blocked）。
  需求/任务编辑、草稿删除、问题补充说明、等待回答与完整重新规划仍无服务端入口，不能用按钮冒充。
- 真实 Debian/生产宿主、容器隔离、多用户身份、远程访问未验证。
- 运维 Agent 已接入协调器与天工视图，但真实线上事件、严重故障抢占研发与外部接管核对尚未验证；
  当前只在本地命令与行为测试中验证，限制见[运维 Agent](ops-agent.md#9-首版限制如实保留)。
- 邮件／IM、自动发布／部署和跨版本升级兼容尚未形成当前完整能力。新首版的发布与运维要求见统一方案。
- 候选安装仍由 `plugin_manager` 等外部机制完成；安装后的正式上线核对只在行为测试中验证，未在正式需求执行。
- 验证、研发与业务终审 Agent 仍是宿主内会话与 `workspace-write`，不是 OS 隔离。
- 变异测试与格式化器尚未接入 TypeScript 工具链；对应 `make` 目标显式失败。
  依赖审计已配置为 `make audit`，实际执行与验证情况见状态记录。
- DSH 仍是 developer preview；升级可能改变接缝，需按版本重新验证。
