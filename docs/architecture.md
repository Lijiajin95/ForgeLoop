# ForgeLoop 架构（TypeScript 原生 DSH 插件）

编写日期：2026-10-22。本文描述**当前活动实现**；旧 Python／Web／serve 路线按当时事实保留在
[ADR 0006](adr/0006-supervised-hot-upgrade.md)、[ADR 0007](adr/0007-web-operations-console.md)
与 `legacy/` 快照中，由 [ADR 0008](adr/0008-typescript-native-dsh-plugin.md) 取代产品路径。
架构契约由 `contracts/architecture.json` 与 `make architecture-contract` 强制。

## 1. 目标与唯一宿主

ForgeLoop 的产品价值是复杂软件项目中的目标、约束、研发、验证、交付与运行反馈。活动实现位于
`packages/forgeloop`（TypeScript 原生 DSH 插件）。本轮把通用交互、会话、模型、工具、权限与
进程生命周期交给 DSH：

**用户只启动 DSH 宿主 → 插件提供业务命令／工具 → 插件内持久工作服务唤醒 DSH Agent 执行 →
业务记录、证据与候选包留在项目现场。**

不再需要 `forgeloop serve`、`forgeloop-launcher`、独立 HTTP 服务或自建网页。调用 Git、
构建与测试时使用受控子进程；不得借此启动旧 Python 核心。

## 2. 运行结构

```
DSH 宿主（唯一常驻产品）
├── 原生交互：会话 / slash 命令 / 工具卡片
├── forgeloop-dsh 插件（同进程）
│   ├── domain/     纯规则：身份、版本、批准、失败轮次、工时、材料身份；影响事实/推断分区只经注入窄接口
│   ├── records/    node:sqlite：权威记录、请求领取、动作身份、证据索引
│   ├── runtime/    协调器、Agent 执行器、正式测试、快照工作副本、候选打包、只读状态看板
│   ├── commands.ts 人类入口 /fl（批准/验收/停止只在这里）
│   ├── tools.ts    模型只读工具 + 需求受理（不能批准或推进）
│   └── client.js   Web 会话区「天工」页：只读展示需求、任务与待处理问题
├── DSH Agent（宿主内独立会话）
│   ├── 分析 / 规划 / 审查：无工具，纯推理，结果按 JSON 校验
│   └── 实现：有工具，在独立快照副本中工作
└── 项目现场：git 仓库、SQLite、证据、候选包
```

## 3. 分层与依赖方向

| 层 | 路径 | 允许依赖 | 职责 |
| --- | --- | --- | --- |
| config | `src/config.ts` | domain | 配置解析与路径布局；非法值装载时失败 |
| domain | `src/domain/` | 无 | 不可变事实与纯判定；不直接接触文件、数据库或模型实现；影响推断只经注入的无工具 Agent 窄接口 |
| records | `src/records/` | domain | SQLite 读写；旧库兼容；事务领取 |
| runtime | `src/runtime/` | domain、records、config | 编排、Agent、测试、快照、打包、只读状态看板 |
| entry | `src/index.ts`、`commands.ts`、`tools.ts`、`cli/` | 以上全部 | 插件接入与命令/工具表面 |

`client.js` 是浏览器端入口（普通 `dsh.client` 模块，不参与 tsc 编译），只通过认证 Fetch 路由
读取看板，不导入任何 DSH Client 包；`contracts/architecture.json` 的 `ui_surface` 固定槽位、
排序、通道与展示资源，`make architecture-contract` 校验其与实现一致。

`make architecture-contract` 解析实际相对导入并拒绝反向依赖；模块清单、持久化表、命令与
工具清单同时核对，防止文档与实现漂移。

## 4. 业务闭环

1. **受理**：`/fl submit` 或 `forgeloop_submit_requirement` 先落库，返回稳定需求身份与版本 1。
   客户端幂等键相同则复用；同键不同内容明确拒绝。
2. **分析**：`/fl analyze` 写 `service_requests` 后返回；协调器领取后创建无工具 Agent，
   校验结构化分析（目标、场景、验收标准、待澄清项）并按版本保存。有待澄清项时等待人工。
3. **规划**：`/fl plan` 依据最新且同版本的分析生成任务包。任务包必须≥2 个任务、至少一条
   依赖、文件清单在 TypeScript 工程内、测试命令为真实 argv；不得引用 Python、旧 `.venv`、
   旧 `forgeloop` CLI 或并行的第二个插件包。违规时带着拒绝原因重试，仍不合规即阻塞。
4. **批准**：`/fl approve <需求> <任务包版本>` 由人类命令入口执行；校验语言/工程边界、
   需求版本与任务包版本一致，写入绑定需求身份与版本的批准行与授权来源。
5. **推进**：`/fl advance` 领取后按拓扑序逐任务执行：
   - 在**包含未提交在途改动的快照副本**中准备依赖（`npm install --no-package-lock`），
     再还原准备阶段对跟踪文件的改动，保证候选 diff 只来自开发回合；
   - 实现 Agent 在有工具的独立副本中工作；采集二进制 diff 并核对改动是否越出批准清单；
   - 独立审查 Agent 使用新会话、无工具、独立目录，只审查固定 diff；阻断则回到实现；
   - 正式测试由程序运行批准过的 argv，保存命令、退出码、耗时与完整日志；
   - 失败计入失败轮次（同一轮幂等），额度未尽才自动重试；用尽则等待追加授权或停止；
   - 交付写入候选摘要、测试证据摘要、审查结论摘要、授权来源与基线。
6. **候选包**：`/fl candidate <需求> [x.y.z]` 把已交付 diff 应用到另一份快照，执行构建与
   `npm pack`，核对 tarball 摘要与清单，记录候选包身份。
7. **验收**：`/fl accept <需求> [产物摘要]` 由人类命令入口绑定实际材料；材料变化或摘要
   不一致即拒绝。验收后需求进入终态，记录不回写。
8. **影响摘要**：`/fl impact <需求> [--explain]` 与只读工具 `forgeloop_impact` 查询同一份
   修订影响事实，不批准、不推进、不验收。
   - `domain/impact.ts` 从权威记录快照纯计算事实：需求全部版本（版本号、时间、修订来源）、
     各分析版本及其依据的需求版本、各任务包版本及其依据的需求版本与任务、当前批准绑定、
     已交付任务与材料摘要，以及待核对请求。条目依据的需求版本落后于最新版本时标为
     `stale`；分析/任务包/批准版本不一致、最新阶段缺口、任务未交付、交付材料不完整或请求
     结果未知时标为 `pending`，两类可同时成立。
   - `domain/impact-explain.ts` 负责展示分区：事实区恒在第一位；默认不调用模型，并明确
     说明“未请求推断、未调用任何模型”。只有显式 `--explain` 才把事实快照交给无工具 Agent
     （运行时注入，领域层不直接持有会话），返回值单列为 `provenance=model-inference`、
     `inference=true` 的推断区，明确标注为模型
     推断、不是确定事实，且不回写事实区。
   - 该路径只读记录并可选调用模型；没有批准、推进、验收或追加授权的写入口。
9. **只读状态看板**：会话区「天工」页（`conversation.view` 槽位，`id=forgeloop`，排在对话与
   轨迹之后）展示三类当前状态，全部来自同一条记录读取链：
   - **需求**：最新版本标题、生命周期状态、最新任务包与批准绑定、已交付进度、失败轮次与剩余额度；
   - **任务**：最新任务包内每个任务的状态，由产物（已交付）与任务运行（失败/阻塞/待决定）推导，
     其余为待执行，不凭需求状态猜「执行中」；
   - **问题**：分析待澄清项、需求阻塞原因、最新失败轮次（额度用尽升为阻断）、结果未知/失败的
     持久请求、待批准任务包。终态需求不再产生待处理问题，但仍显示最终状态。

   页面经 `ctx.connection.fetch.register` 注册的认证路由 `/api/forgeloop/board` 读取 `board`
   端点；无浏览器连接服务的 profile 不注册该路由，只保留命令与工具。该页没有任何写入、
   批准或推进入口。

   会话区输入框工具行另有工作流选择（`conversation.input.left`，`id=forgeloop-mode`）：
   - **DSH**：不作任何改写，消息按普通对话交给 DSH；
   - **ForgeLoop**：把草稿保持在 `/fl submit ` 前缀下，回车提交的是人类命令而不是模型消息，
     用户输入因此成为 ForgeLoop 的需求受理；批准、规划与验收仍由所有者从 `/fl` 决定。
   前缀由用户可删；删掉后该条消息按 DSH 处理，选择本身不改变任何批准或执行状态。

## 5. 持久化

- 引擎：SQLite，Node 内置 `node:sqlite`，WAL 与 `busy_timeout`；不引入原生扩展。
- 位置：`<recordsRoot>/projects/<project>/records.sqlite`，与旧版布局一致。
- 表：需求与版本、分析、任务包、任务包批准、任务运行、任务产物、工时、取消、证据路径、
  失败轮次、授权、候选包、持久请求、动作身份、运行元信息（见 `contracts/architecture.json`）。
- 兼容：旧库表结构与列保持可读；启动时只补新列、不迁移或覆盖历史值。旧记录仍可按身份回查。
- 证据：`evidence/<req>/v<plan>/<task>/` 保存 `baseline.json`、`candidate.diff`、
  `formal-test.log`、`review.json`、`dev.jsonl`、`review.jsonl`；候选包在
  `candidates/<req>/v<plan>/`。

## 6. 持久工作、去重与恢复

- 请求状态：`pending → claimed → done | failed | unknown | dismissed`。
- 受理先落库再返回；`service_requests` 对同需求同动作复用、不同动作拒绝，数据库唯一索引
  兜底。
- 协调器单实例、单条领取：`UPDATE … WHERE state='pending'` 原子领取；重复唤醒不会重复执行。
- 单消费者锁：`<记录根>/host.lock` 目录原子创建并记录 PID；第二个宿主只读、不领取、不把
  别人的在途请求标为 unknown；进程已退出的残留锁会被清理后重试一次。
- 宿主启动时：`claimed` 请求改为 `unknown`（先核对，不重放），`started` 动作改为
  `interrupted`；保留证据与原因。
- 停止：撤销待执行请求、取消在途 Agent、记录停止原因；结果未知的动作不自动重放。
- 工时：只累计真实执行段；用户等待不计入；额度用尽停止新动作。

## 7. 信任边界

- **人类命令** `/fl`：批准、验收、推进、追加授权、停止、取消只从这里进入；批准绑定需求身份、
  任务包版本与实际材料。
- **模型工具**：只读查询与需求受理。工具不能提交 `by=owner` 或 `approved=true`，也不能触发
  推进或验收。`forgeloop_impact` 默认不调用模型；显式 `explain=true` 的推断与事实分区，
  推断不能作为批准、推进或验收依据。
- **Agent**：审查使用独立上下文；实现使用独立副本；模型自评、消息投递回执与工具退出码都
  不是验收证据。
- 已知边界：审查的“受控访问”是独立会话＋无工具＋固定 diff，不是 OS/容器级隔离；宿主插件
  本身拥有比普通工作区工具更宽的文件权限，必须继续按动作检查授权。

## 8. DSH 接缝与版本

- 宿主服务：`ctx.agents`（创建/驱动会话）、`ctx.commands`、`ctx.tools`、`ctx.subprocess`、
  `ctx.permissionPresets`（可选）、`agentDefaultModel`（可选）。影响摘要的推断复用
  `ctx.agents`，只在显式 `--explain`/`explain=true` 时创建无工具会话。
- Web 接缝（可选）：宿主半用 `ctx.inject(['connection'])` 注册 `ctx.connection.fetch.register`
  的认证路由 `/api/forgeloop/board`；浏览器半是 `dsh.client` 模块，经
  `ctx.slots.inject('conversation.view')` 注册「天工」页（英文 Forge），并用同源 `fetch` 读取数据；
  同一模块在 `conversation.input.left` 注册工作流选择器（DSH / ForgeLoop），用 `inputActions`
  维护 `/fl submit ` 前缀。两者都不在 profile 提供连接服务时激活，headless profile 的装载不受影响。
- 不用 `ctx.connection.rpc.handle()`：DSH 0.2.1-rc.2 中它以 Connection 插件自身的上下文为注册
  owner，该上下文没有注入 `webServer`，注册即抛错；Fetch 路由是同一认证层的宿主功能入口。
- 已验证本机版本：DSH `0.2.1-rc.2`、Node `26.11.1`、TypeScript `5.9`、SQLite 通过
  `node:sqlite`。参考源码版本见 ADR 0008。
- 插件以 npm bundle 发布：`dsh.bundle.patch` 插入 `forgeloop-dsh` 行；`engines.dsh` 限定范围。

## 9. 已退役与隔离

| 旧形态 | 处置 |
| --- | --- |
| Python 业务核心（`src/forgeloop`） | 移入 `legacy/python/`，不参与构建、检查或运行 |
| 旧测试与 Python 工程工具 | 同上；新检查由 vitest/tsc/`scripts/ts/` 承接 |
| 自建网页与 `frontend/` | 退役；旧代码在 `legacy/python/frontend/` |
| `forgeloop serve` / `web` / 热升级启动器 | 产品路径退役；记录与 ADR 按当时事实保留 |
| 邮件／IM 渠道 | 本轮不迁移；不声称可用 |

旧实现只作为历史快照与迁移参考；活动源码、包、构建与检查不依赖 Python。

## 10. 未验证与后续

- 真实 Debian/生产宿主、容器隔离、多用户身份、远程访问未验证。
- 邮件／IM、发布／部署、跨版本升级兼容不在首版范围。
- 变异测试、依赖漏洞扫描、格式化器尚未接入 TypeScript 工具链；`make` 目标显式失败，
  不冒充通过。
- DSH 仍是 developer preview；升级可能改变接缝，需按版本重新验证。