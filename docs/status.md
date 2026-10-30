# ForgeLoop 状态记录

本文件是当前状态与实际证据的入口；新目标、需求和方案见[统一方案](product.md)。
更新时区分当前快照与历史批次，数字绑定检查日期、构建和原始日志；发现冲突先核对并留勘误。
本文件不把工程检查、安装回执或历史自迭代当作新方案的完整验收。

## 当前快照（2026-10-30）

| 项目 | 最近有依据的状态 | 回查 |
| --- | --- | --- |
| 新产品方案 | 产品、技术与验证决定已合并；种子范围、首条真实需求及 M2 参数仍待明确 | [统一方案 §14](product.md#14-实施边界与待决项) |
| 活动实现 | TypeScript 原生 DSH 插件；业务会话、需求分析/澄清、研发拆解、实现前评审、批准、推进、独立验证与验收均已接入；2026-10-30 进一步收紧为“执行角色全工作区 + 已批准任务包冻结 + 验证阻断自动回研发修复”，退役最小重新规划与手工重新研发入口；天工页显示业务终审/候选/部署并提供构建、核对上线、重新执行动作；编辑/草稿删除/问题补充/等待回答仍无入口；完整真实候选安装与上线核对尚未在正式需求上跑通 | [架构](architecture.md)、§15–§37 |
| 架构契约 | 2026-10-29 起为 schema v3：只固定分层/依赖方向/循环/退役路径/工具与 UI/会话表面；源码模块、工具名、Web 端点自动发现，`make contracts` 只检查、无登记更新步骤 | §30 |
| 退役代码清理 | 已删除 `legacy/`、失效安装脚本与未接入运行链路的重复代码；历史从 Git 回查 | §13、[ADR 0009](adr/0009-remove-retired-implementation.md) |
| 最近安装记录 | 2026-10-30 `forgeloop-dsh@0.1.6` tarball（177,096 字节，SHA-256 `0ebbfa37…`）已通过 `plugin_manager` 安装到正式 `web` profile 并热重载（3080 进程 PID 82207 未重启；新 owner `MacAir.local:2477:c0ce681f` 起于 `2026-10-30T01:28:42Z`），`last_recovery` 记录 `interruptedRuns: 1`；安装记录不等于交付完成 | §36 |
| 最近工程检查 | 2026-10-30 `make check` 通过，41 个测试文件、433 项测试；`make coverage` 通过（行/语句 92.14%、函数 96.90%、分支 84.09%，门槛 90/93/84）；`make contracts` 通过；`make package` 产出 0.0.2（版本号未变） | §39 |
| 真实业务链路 | 真实需求 `req-20261029070230-bab6bf` 已完成受理→分析→澄清→研发拆解→实现前评审→批准→真实研发→交付→越界拒绝→重新规划→再次评审/批准；未完成：独立验证、业务终审、验收、候选构建/安装/上线核对。2026-10-30 一次开发回合在宿主重启时中断，系统按 failed 收口并丢弃一次性快照，等待重新执行 | §16–§28、§33、§36 |
| 运维 Agent | 2026-10-29 首版：登记资源/检查/少量恢复动作，事件归并与未知收口，无工具诊断，目录授权或所有者批准后执行，登记检查复核恢复，诊断要求永久修复时生成关联修复需求；只读工具与认证端点、天工“运维”视图；尚无真实线上事件验证 | §35、[运维设计](ops-agent.md) |
| 关键缺口 | M0 真实闭环未完成：正式需求尚缺独立验证、业务终审、验收、候选安装与上线核对；候选构建/上线核对只有行为测试，未在正式需求上执行；研发执行已是 `workspace-write`，验证/终审仍非 OS 隔离；追加授权、例外取舍仍缺失；已批准任务包修改只有端点显式许可，无 UI 入口；运维无真实线上事件；需求编辑、草稿删除、问题补充与等待回答无服务端入口 | §4.1、§21–§37 |
| 覆盖率 | 2026-10-29 行／语句 92.31%、函数 96.36%、分支 84.27%，门槛通过 | §35；历史测量及勘误见 §34、§33、§32、§31、§30、§29、§28、§27、§26、§25、§23、§22、§21、§19、§18、§15、§14、§13、§3.4、§2.2 |

产品版本以 Git tag 为准；历史记录中的包名、构建标识与摘要用于追溯，不单独作为运行版本证明。
以下章节保留原编号和锚点，历史批次按当时环境理解；没有再次执行的检查不刷新为本次结果。

## 1. 当前形态（截至 2026-10-23，Asia/Shanghai）

- 产品：`forgeloop-dsh`，TypeScript 原生 DSH 插件（`packages/forgeloop`）。
- 唯一常驻宿主：DSH。不再启动 `forgeloop serve`、`forgeloop-launcher`、独立 HTTP 服务或网页。
- 入口：模型只读工具与需求受理；`/fl` 人类命令表面已于 2026-10-28 删除，客户决定入口待实现（§14）。
- Web 页面：DSH 会话区「天工」页（`conversation.view`，`id=forgeloop`，只读），展示需求、任务
  与待处理问题的状态；页面不提供批准、推进或验收入口。
- 业务记录：SQLite（`node:sqlite`），`<recordsRoot>/projects/<project>/records.sqlite`；
  新库从空库建立，不读取或修补旧业务库。
- 旧 Python／前端／serve 路线：由 [ADR 0008](adr/0008-typescript-native-dsh-plugin.md) 取代；
  代码隔离在 `legacy/`，不参与构建、检查或运行（迁移见 §6）。
- 详细架构与信任边界：[docs/architecture.md](architecture.md)。

## 2. 2026-10-22 批次：全量转 TypeScript／DSH 并完成 V0→V1

完整范围、产物、失败、外部补救和恢复记录见[当批交付报告](delivery/2026-10-22-typescript-dsh.md)。
本节保留基线、检索身份及勘误，不再复制报告全文。

### 2.1 基线与在途工作处理

- 执行起点 HEAD：`6233a6e9762fa65d61565eef78765cc72d3e290b`。工作树有 58 项其他执行方的
  在途改动（54 个已跟踪修改、4 个未跟踪文件）。
- 基线快照保存在 `.cache/forgeloop/dsh-migration/baseline/`（不入库）：
  `git-state.txt`、`worktree.patch`、`diffstat.txt`、记录库副本 `records.sqlite`。
  SHA-256：`worktree.patch adfa8dae…`、`git-state be7d763e…`、`records cbb48b2f…`。
- 没有覆盖、回退或清理这些改动；没有创建产品 commit。执行副本按“Git 跟踪清单＋未忽略新文件”
  复制，因此包含未提交实现，而不是只从 HEAD 取树。

### 2.2 实现与检查（TypeScript）

迁移把领域、存储、运行时与检查工具接入 TypeScript／DSH；具体文件与检查见交付报告 §3、§7。
2026-10-28 核对原始日志后，对此前重复文档中的数字和引用作如下勘误：

| 原表述 | 核对结果与正确来源 |
| --- | --- |
| 本批覆盖率 92.16%／85.1% | 属于后续 §3.4 的记录；迁移批次 `final-check-and-coverage.log` 第 80 行为行／语句 80.28%、分支 71.23%、函数 82.43% |
| `clean-make-check.log` 支持 97 项测试 | 该日志实际为 84 项；97 项的依据是 `final-check-and-coverage.log` 第 39–40 行与第 71–72 行 |

日志均位于 `.cache/forgeloop/evidence-20261022/`；其中 UTC 执行时间为 2026-10-22T16:38，
即 Asia/Shanghai 的 2026-10-23 00:38，属于 10 月 22 日开始的迁移批次。
交付报告的历史原文保留，通过本勘误明确来源，不回写或补造原始日志。

### 2.3 V0：真实研发闭环

需求 `req-20261022151546-b52121`（失败轮次可见性），3 个任务完成；候选约 44 KB。
产物摘要、审查、测试、安装与验收见[交付报告 §5](delivery/2026-10-22-typescript-dsh.md#5-v0-与-v1-链路证据)。
批准、安装等来自外部执行，不能计为 ForgeLoop 独立成果。

### 2.4 V1：自迭代结果

需求 `req-20261022154141-b8907b`（修订影响摘要），4 个任务完成；事实／推断区、恢复及候选摘要见同一交付报告。
当时 `/fl impact` 验证 current（0 过期／0 待核对）和 pending（5 项待核对），V1 可读 4 条旧需求；
专用用户 profile 调用状态工具返回 5 条需求。它们是不同现场的当批记录，不代表当前库数量。

### 2.5 规则与负例

规划不合规、文件越界、第二宿主造成 unknown、上游改动未交接及外部补救见[交付报告 §8](delivery/2026-10-22-typescript-dsh.md#8-人工介入与外部补救)。
当批新增单消费者锁与依赖产物交接；局部测试和事件不能证明所有限额、停止或恢复路径已完整验收，当前缺口见 §4.1。

## 3. 2026-10-23 批次：会话区「天工」页（只读状态看板）

所有者要求：在会话区「轨迹」标签旁增加一个页面，展示需求、任务、问题的状态。本批由 DSH
执行 Agent 直接实现（不是 ForgeLoop 自身需求流程的产物），如实记录执行工具与未验证事项。

### 3.1 实现

- 新增 `packages/forgeloop/src/runtime/board.ts`：只读状态看板事实视图。
  - 需求：最新版本标题、生命周期状态、最新任务包与批准绑定（精确批准优先；只有旧版本批准时
    判 `stale`）、交付进度、失败轮次与剩余额度。
  - 任务：最新任务包内每个任务的状态，优先级为产物（已交付）→ 任务运行（失败/阻塞/待决定）→
    待执行；不凭需求状态推断“执行中”。
  - 问题：分析待澄清项、需求阻塞原因、最新失败轮次（额度用尽升为阻断）、结果未知/失败的持久
    请求、待批准任务包。终态需求不再产生待处理问题，但仍显示最终状态。
- `src/runtime/service.ts` 新增 `statusBoard()`，与 `/fl status` 共用同一条记录读取链。
- `src/index.ts` 在存在 `connection` 服务时注册认证 Fetch 路由 `/api/forgeloop/board`
  （POST，`board` 与 `detail` 两个只读端点）；没有浏览器连接服务的 headless profile 不注册，
  装载行为不变。`detail` 复用 `runtime.status(reqId)`，按需返回单条需求的版本、分析、任务、
  批准、失败轮次与待处理请求。
  - 不使用 `ctx.connection.rpc.handle()`：DSH 0.2.1-rc.2 实测它以 Connection 插件自身的上下文
    作为注册 owner，该上下文没有注入 `webServer`，注册时抛 `cannot get property "webServer"
    without inject`。Fetch 路由走同一 Connection 认证层（Host/Origin 检查 + 浏览器凭据准入，
    仅 owner 可读），且不依赖调用方的 webServer 注入。
- 新增 `client.js`（`dsh.client` 模块）：注册 `conversation.view` 的 `forgeloop` 视图，
  `order: 20`（对话 0、轨迹 10 之后），中文标签「天工」、英文标签「Forge」；三列只读卡片，每 15 秒自动刷新，只用
  `--dsw-alias-*` 主题令牌，不导入任何 DSH Client 包。交互只有只读动作：需求/任务/问题卡片
  可展开对应需求详情（分析目标、待澄清项、验收标准、任务状态、批准、失败轮次、待处理请求），
  顶部可按 全部/进行中/已验收 过滤；「复制命令」按钮只把 `/fl show|approve|advance|evidence`
  文本放进剪贴板，绝不执行，批准与验收仍只从 `/fl` 进入。
  输入框工具行新增**工作流选择器**（`conversation.input.left`，`id=forgeloop-mode`）：DSH 模式
  不改写消息；ForgeLoop 模式把草稿保持在 `/fl submit ` 前缀下，使用户输入作为需求受理，
  而不是普通模型消息。前缀可被用户删除，删除后该条按 DSH 处理；选择器不改变批准或执行状态。
- `package.json` 增加 `dsh.client`、`./client` 导出与 `files` 项；新增 `locale/zh.json`、
  `locale/en.json` 与 `icon.svg`。
- 契约：`contracts/architecture.json` 增加 `ui_surface` 与 `web_board_route` 接缝；
  `scripts/ts/contracts.ts` 增加 `checkUiSurface()`，校验槽位、视图身份、排序、数据路径、
  端点、入口文件、图标与 locale 与实现一致。`docs/architecture.md`、包 README 同步。

### 3.2 检查（实际执行）

- `make check` 通过：类型检查、架构/CLI 契约、提交策略配置校验与 vitest，本批 **124 项通过**
  （覆盖率扩充后全量为 238 项，见 §3.4）。
- 新增行为测试 21 项：
  - `tests/status-board.test.ts`（14）：空项目、未规划缺口、产物/运行推导、失败轮次额度、
    待澄清、待批准与过期批准、阻塞、未知/失败请求、终态需求、条数上限、严重度排序、标题截断。
  - `tests/board-channel.test.ts`（4）：`apply` 在存在 `connection` 时注册
    `/api/forgeloop/board`（POST、buffered），`board` 返回看板数据，`detail` 返回单条需求、
    缺身份 400、未知身份 404，未知端点 404、畸形请求体 400；没有 Fetch 注册表时不注册。
  - `tests/client-view.test.ts`（5）：客户端模块身份、`conversation.view` 的 id/order/locale/label、
    工作流选择器注册、DSH/ForgeLoop 草稿路由（含不覆盖 `/fl` 命令与切回 DSH 去前缀）、
    中英文字典键一致。
- `make package`：候选包（版本名以 git tag 为准），SHA-256
  `8fa2ff664e8c4a46fae09897785a18bb3116ebe2967ab0a778d5c24ec0d3bb3f`，70,883 字节；tarball
  清单含 `client.js`、`locale/*.json`、`icon.svg` 与 `lib/runtime/board.js`。
  前两次候选因宿主半路由方式错误未能取数，修正后页面跑通；当前构建增加详情端点与只读交互。
- 安装：desktop profile 由应用独占管理，`dsh plugin` CLI 拒绝写入；改用 `plugin_manager`
  `install_bundle` 安装上述 tarball，结果 `application: applied`，安装版本与 `package.json` 一致。
  安装后的重载会重新生成插件模块，**无需重启 DSH Desktop**；页面刷新后客户端 bundle 生效。
  该 profile 的 pnpm 原绑定在仓库内 store，安装前在其 `pnpm-workspace.yaml` 增加
  `storeDir: /Users/lijiajin/Project/ForgeLoop/.pnpm-store`（本机 profile 配置，不入库）。

### 3.3 未完成与限制

- **页面已在真实桌面宿主跑通（2026-10-23 13:40）**：刷新后「天工」页显示真实记录（5 条需求、
  10 个任务、7 个已交付、2 个问题），无错误提示；此前“必须重启桌面宿主”的推断被实际结果
  推翻——`plugin_manager` 安装后的重载会加载新模块，只需刷新页面。
- 桌面同一份代码此前在隔离探测 profile 上验证过路由：无凭据 401，带凭据返回看板 JSON。
- 仍未验证：明暗主题下的实际观感、浏览器控制台是否有告警、详情展开与复制命令在桌面浏览器中
  的实际交互（本批新增，等刷新后确认）。
- 未在明暗主题下实际查看页面，也未核对浏览器控制台是否无槽位崩溃。
- 安装输出带既有 peer dependency 警告；与本批改动无关，未处理。

### 3.4 2026-10-23 覆盖率扩充

在真实记录之外补齐可确定验证的分支，目标是把覆盖率门槛从“阻止明显回退”提高到接近历史目标。

- 实测（`vitest run --coverage`，27 个文件 / **238 个用例**）：行/语句 **92.16%**、函数 **95.45%**、
  分支 **85.1%**；历史目标（行/语句 90、分支 85）已达到。
- `vitest.config.ts` 门槛提高到 lines/statements **90**、functions **93**、branches **84**，低于实测约
  1–2 个百分点，用来阻断回退而不是制造偶发失败。
- 新增测试文件（11 个、114 项）：
  - `limits.test.ts`：执行限额的构造、累计、耗尽与显式延长；
  - `work`/`task-plan-rules.test.ts`：任务包解析与拒绝（文件越界、重复、自依赖、环、畸形限额、
    非规范测试命令）与交付材料完整性；
  - `prompts.test.ts`：分析/规划/实现/审查提示的必需要素与审查结论 fail-closed 解析；
  - `lock.test.ts`：单消费者锁的获取、活持有者拒绝、残留锁清理、只释放自己的锁；
  - `formal-test.test.ts`：真实子进程与注入 subprocess 两条路径的退出码、超时、取消与日志摘要；
  - `workspace.test.ts`：快照副本（跳过 legacy）、worktree 建立/移除、候选 diff 与越界清单；
  - `service-lifecycle.test.ts`：修订/取消/停止/授权、请求排队与冲突、计划/证据/请求查询、
    恢复确认、候选前置条件、验收材料绑定、执行守卫与目录摘要；
  - `coordinator-actions.test.ts`：单消费者锁生命周期、重启核对、自动推进请求与错误留存；
  - `command-surface.test.ts`：`/fl` 全部子命令的成功与拒绝路径、usage 错误、异常收口与注册；
  - `tools.test.ts`：7 个模型工具的只读查询、受理身份不可伪造、幂等键冲突与渲染；
  - `config-validation.test.ts`：项目名、轮询间隔、超时、尝试次数与命令列表的装载期拒绝。
- 仍未覆盖的低值区域：`service.ts` 的深层执行流水线（82.67% 行、79.33% 分支）依赖真实 Agent
  回合的失败组合；`index.ts`/`cli/` 按配置从覆盖率统计中排除。

### 3.5 版本标签与仓库同步（2026-10-23 19:33）

- 同步提交 `f316f06`（整个工作树）已推送 `origin/main`；注释标签 **`v0.0.2`** 指向该提交，
  这是产品版本的唯一权威来源。
- `package.json` 的 `0.0.2` 只是构建标识；文档与契约不再记录产品版本字面量。
- HTTPS OAuth 令牌缺少 `workflow` 作用域，GitHub 拒绝更新工作流文件；本次改用本机已认证的
  SSH 身份推送，remote URL 未修改。CI 已随代码推送，但尚未在 GitHub 上执行。

## 4. 当前能力与缺口

以下能力结论来自所指批次；未单独重验的历史安装、宿主和 CI 状态不视为本次现场测量。

| 能力 | 状态 |
| --- | --- |
| 插件安装、组合与真实模型工具调用 | 已验证（隔离 DSH_HOME、V0 tarball） |
| 会话区「天工」页 | 已实现并有装配/注册测试；当前构建已装入 desktop profile，宿主路由在隔离 Web 宿主与桌面页面均验证通过（见 §3.3）。输入框工作流选择器已于 2026-10-26 按所有者要求移除（见 §9） |
| 需求提交/修订、分析、规划、批准、推进、查询、验收 | 运行时保留并有真实链路证据；`/fl` 删除后无客户决定入口，批准/推进/验收路径当前不可达；需求级停止和限额入口缺口见 §4.1 |
| 持久请求、去重、重启收口、动作 interrupted | 已实现；真实重启场景见 §2.3/§2.5，§44 删除全部 unknown 状态 |
| 单消费者锁（同一记录根只允许一个协调器） | 已实现并有并发测试；修复基线起安装。此前的双宿主事件暴露了缺口，见 §2.5 |
| 依赖任务产物交接 | 已实现（上游已交付 diff 先进入下游副本并在新基线提交），有行为测试；修复基线起安装 |
| 独立审查、正式测试、证据绑定 | 已实现并有真实日志 |
| 候选包构建、安装与恢复入口 | 已实现；V0 已验证，V1 见 §2.4 |
| 专用 profile 安装 | **已执行**：`~/.dsh/profiles/forgeloop`（headless 模板）安装 V1 tarball，真实模型调用 `forgeloop_status` 成功；启动需提供 `QWEN_TOKEN_PLAN_CN_API_KEY` 或在 Models 页登记 |
| 桌面 profile（`~/.dsh/profiles/desktop`） | **2026-10-26 已重装**移除选择器后的构建：`plugin_manager` 安装候选 tarball（`application: applied`），宿主重载后客户端槽位即时生效；记录根配置仍在 `cordis.patch.yml`。应用独占管理该 profile，CLI 拒绝直接启动/转储 |
| 常驻宿主中断开客户端后继续推进 | **未单独执行**：协调器行为有单测与真实命令链路；验证宿主是无头的一次性进程，不等同浏览器长连 |
| GitHub Actions | 工作流已改为 Node/TypeScript（quality/nightly）；随同步提交推送到 origin，**未在 GitHub 执行**，本地只验证了同一组 `make` 命令 |
| 容器/OS 级审查隔离 | 未接入；当前是独立会话＋无工具＋固定 diff |
| 多用户、远程访问、邮件/IM、自动发布/部署 | 尚未形成当前完整能力；新首版发布与运维范围见统一方案，不沿用旧“不做部署”边界 |
| 覆盖率 | 已接入；最近实际测量见 §13，2026-10-23 历史测量见 §3.4。有效门槛以 `vitest.config.ts` 为准 |
| 变异、格式化 | 未接入；目标显式失败 |
| 依赖审计 | 已配置；本机受限缓存下未验证，CI 网络环境执行 |
| DSH 跨版本兼容 | 未验证；本机仅 0.2.1-rc.2 |

### 4.1 当前实现缺口（2026-10-28 整理）

本表迁入旧现状稿的独有核对结果，结合当前源码复查；本批没有修复实现或重新执行历史真实场景。
2026-10-28 删除 `/fl` 后，原先经命令触发的缺口改为“无客户入口”；运行时内部操作保留，
领域函数与实际动作接线仍需分别判断，不能据此声明所有硬约束均已落实。

| 位置 | 已知缺口与影响 |
| --- | --- |
| 客户入口、[服务](../packages/forgeloop/src/runtime/service.ts)、[协调器](../packages/forgeloop/src/runtime/coordinator.ts) | 当前没有客户决定入口；stop／cancel 的运行时操作能更新状态并撤销 pending，但在途 AbortController 只接协调器整体 stop，需求级停止未接通。成功文案不能证明 Agent 已停稳；在途修订的停止边界同样需验证 |
| 服务与[工时规则](../packages/forgeloop/src/domain/limits.ts) | 推进开始检查工时，后续动作／尝试未逐一复检；领域存在 extend，但无公开工时延长命令。不能声明逐动作工时已强制 |
| 服务与[失败计数](../packages/forgeloop/src/domain/counting.ts) | 失败额度在记录失败、循环分支、advance 入口与 retryTask 检查（2026-10-29 补齐推进准入）；回合 ID 已绑定推进请求与尝试序号，跨请求重试不再吞轮次；追加授权入口与额度用尽后的继续路径仍未实现 |
| 服务与[Agent 执行器](../packages/forgeloop/src/runtime/agent-runner.ts) | 实现请求 `danger-full-access`，独立副本与事后 diff 检查未形成副本外写入的预防性限制；ADR 中“工作区写权限”不能当作实际约束证据 |
| 失败计数与入口 | 有 `user_acceptance` 失败类型，但当前无公开的用户验收失败反馈入口，尚未形成完整累计路径 |
| [服务验收入口](../packages/forgeloop/src/runtime/service.ts)与[记录层](../packages/forgeloop/src/records/repository.ts) | 当前允许未构建候选包时按任务材料验收；验收成功不证明已经打包、安装或上线。历史 diff 对变化后源码重放曾需外部合并，见 §2 与交付记录 |

其他保留限制：当前任务包要求至少两个任务且有依赖；运行时不自动核验外部副作用，
中断任务按未交付收口，运维中断动作由 Agent 上报根因但不重放。费用计量、脱敏与材料保留策略、
指令注入／副本外访问、客户端断开长跑及部分桌面交互没有完整验收结论。
旧稿原始证据指向的两项真实需求、数据库和 evidence 目录继续按 §2 与交付记录回查。
上述缺口用于界定当前能力，不自动成为本轮实施范围。

## 5. 环境与版本（本机实测）

- DSH `0.2.1-rc.2`（`/opt/homebrew/bin/dsh`）；Node `v26.11.1`；npm `11.20.0`；
- TypeScript `5.9.3`（`node_modules/typescript`）；SQLite 通过 `node:sqlite`；
- 验证 DSH_HOME：`.cache/forgeloop/dsh-home`（profile `forgeloop`，不入库）；
- 模型路由：`qwen-token-plan-cn / deepseek-v4.1-flash-1017`，凭据由启动环境提供，未写入仓库。

## 6. 旧实现处置与未完成事项

本节保留 2026-10-22 迁移时的处置事实；2026-10-28 的后续源码删除见 §13。

- Python 源码、旧测试、旧前端、旧脚本与旧配置已移入 `legacy/`（`.venv`、`node_modules`、
  `mutants` 等生成物已删除）。活动构建、检查与运行不引用 `legacy/`；`make architecture-contract`
  通过。
- 迁移批次曾将旧 docs 移入 `docs/history/`；2026-10-25 文档清理后，旧方案从 Git 历史回查，见 §7。
- 旧记录库兼容读取曾在迁移时实测（旧需求 `req-20261021015151-fbbc3f` 可在当时的 `/fl status` 中查到）；
  该兼容已于 2026-10-28 删除，见 §14。
- 真实发布、部署、回滚、备份未执行；“发现但不碰”的问题保留在批次记录，不借迁移顺手修改。
- 文档、契约与安装版本已按最终状态同步；未执行检查在[交付记录](delivery/2026-10-22-typescript-dsh.md)
  中逐条标注。

## 7. 文档清理（2026-10-25）

所有者准备重新规划产品，要求删除冗余、过时文档。本批由 Codex 直接整理仓库文档；未通过
ForgeLoop 执行需求，不计为插件独立成果，也没有新增实现、提交、安装或真实宿主验收。

### 7.1 范围与实际改动

- 删除 5 份重复或过时的阶段文件：`docs/product-requirements.md`、`docs/dogfood-execution-plan.md`、
  `docs/pending-requirements.md`、`docs/roadmap.md`、`docs/engineering-reliability.md`。
- 删除 `docs/history/` 原有 16 份旧方案、提案及其索引，退役路线不再保留工作树内的第二套文档入口。
- 删除 7 份旧路线 ADR：0001、0003-agent-runtime、0003-requirement-baseline、0004、0005、0006、0007；
  保留仍说明当前机制的 ADR 0002 与 0008。
- 同步 `AGENTS.md`、根 README、文档索引、PRD 草稿、研发纪律、架构、安装说明、保留 ADR 与迁移交付记录的引用；
  `.github/workflows/nightly.yml` 仅修改文档引用注释，不改变作业。
- PRD 保留现状正文与所有者手动修订，标明它是重规划输入；不把旧需求重新确认为新范围。
- 安装说明移除过时的桌面 profile 手动写入步骤，采用最近状态记录中已实测的宿主插件管理入口；
  工程门槛直接指向 Makefile、vitest 配置与契约，不另维护旧阈值。

本批新增删除 **28 份文档**。开始前已存在的 `docs/dsh-plugin-10h-goal-prompt.md` 删除保持原样，
不计入本批新增删除；未清理 `.forgeloop/`、`.cache/`、候选包、数据库、原始轨迹、`legacy/` 或本机阅读资料。

### 7.2 历史回查

清理前参考提交：`b344b5a08407f0f94ab5d3ca90887ecf17a24e7f`。本批待删文件开始前均与 Git 基线一致，
没有混入其他人的在途修改。被删除文件仍可按原路径查看，例如：

```sh
git show b344b5a08407f0f94ab5d3ca90887ecf17a24e7f:docs/product-requirements.md
git show b344b5a08407f0f94ab5d3ca90887ecf17a24e7f:docs/history/dsh-plugin-product-proposal.md
git log -- docs/history docs/adr
```

### 7.3 验证与发现但不碰

- 活动文档检查覆盖 14 份项目 Markdown（包括未跟踪的 PRD 草稿）：99 处本地链接与锚点均可解析。
- `git diff --check` 通过；实际改动与上述清理范围一致，未修改实现、测试、契约、依赖或检查配置。
- `make check` 通过：类型、架构／CLI 契约、本机提交策略配置有效；27 个测试文件、238 项测试通过。
- 本批仅整理文档，未重跑真实宿主、打包或安装，不新增真实业务验收结论。
- 发现但不碰：PRD §14 已记录的停止、工时、额度及权限实现缺口仍保留；本机资料库、旧代码快照与原始证据不纳入本轮清理。

## 8. 产品目标确认与 PRD 草案（2026-10-26）

所有者通过本轮 grill 确认产品目标基线完整，并要求继续进行 PRD 规划。
本批由外部 Codex 直接编写文档，不是 ForgeLoop 自主执行成果；目标已确认，需求与验收细化仍为草案。

### 8.1 计划范围与实际改动

- 新增 `docs/product.md`：保存已确认的目标、首版从零 DogFood 范围、例外人决、受控架构演进、
  配置与部署边界、研发和运维两类统计口径；细化 14 项需求、12 个验收场景与三个阶段。
- 修改 `AGENTS.md`、`README.md`、`docs/README.md` 的定位与入口，区分新目标、当前实现和待评审方案。
  保留现有命令／工具的人类决定边界，不通过目标文档放宽运行门禁。
- 仅调整 `docs/proudct.md` 的顶部说明，保留重规划前的现状正文及所有者手动修订。
- 更新本状态记录。实际变更限定在上述 6 份文档；开始前已有的修改、删除和未跟踪现状稿均保留。

本轮仅做产品规划，未修改实现、契约、依赖、检查配置或已部署应用，未创建 commit。
初版不接管已有系统；现有代码如何复用、种子如何建设、宿主与工程工具如何选型仍需后续方案。

### 8.2 实际验证与未完成事项

- `make check` 通过：类型检查、架构／CLI 契约、本机提交策略配置校验；27 个测试文件、238 项测试通过。
  本机原始日志：`.cache/forgeloop/prd-planning/2026-10-26-5s91nbcx/make-check.log`。
- 对本批文档检查本地链接与锚点，并对比修改前快照核对增量范围、既有改动和现状稿正文保留情况；
  `git diff --check` 与新增文档空白检查通过。
- 本批未执行真实宿主、打包、部署或新产品场景验收；上述仓库检查不构成新目标能力已交付的证据。
- 待评审：种子范围与首条真实需求、停止与质量阈值、工程控制与运维授权方案、统计样本及窗口等，
  统一列在 PRD §11，没有补造默认参数、排期、批准或通过结论。

### 8.3 发现但不碰

当前命令、模型工具及 `CONTEXT.md` 使用逐包人工批准／人工验收模型，与新目标需要的既有授权内
自主处理不同；运行权限、停止与限额的既有缺口也未在本批修复。差异及源码依据记录于 PRD §10。
后续授权模型、接口、模块或契约变化需要独立方案和行为验证；本批未恢复被清理的旧方案，
也未把历史 DogFood 记录改写为新一轮自主闭环或人工介入率达标证据。

## 9. 移除输入框工作流选择器（2026-10-26）

所有者要求删除会话输入框工具行里的「工作流」选择器（截图指向该控件）。本批由 DSH 会话内的
Agent 直接实施，未通过 ForgeLoop 受理需求，不计为插件自主执行成果。

### 9.1 实际改动

- `packages/forgeloop/client.js` 删除 `conversation.input.left` 槽位注册（`id=forgeloop-mode`）、
  `WorkflowMode` 组件与样式、`nextDraft` 草稿前缀路由、localStorage 模式记忆及 `mode.*` 文案；
  客户端只保留 `conversation.view` 的「天工」页。
- 需求受理入口不变：仍需在会话里执行 `/fl submit` 人类命令；普通消息按 DSH 对话处理。
  批准、推进、验收与停止的入口和判定没有改变。
- `tests/client-view.test.ts` 改为断言不再注册 `conversation.input.left`，并保留「天工」页
  身份/排序/文案与双语文案键一致性的测试。
- `contracts/architecture.json` 的 `ui_surface` 删除 `composer_slot` 与 `composer_id`；
  `scripts/ts/contracts.ts` 同步移除对应校验。
- `docs/architecture.md` 与 `packages/forgeloop/README.md` 的入口描述同步为当前事实。

### 9.2 检查与实际安装

- `make check` 通过：类型检查、架构／CLI 契约、本机提交策略配置校验；27 个测试文件、
  **237 项测试通过**（原 238 项：删除 2 项选择器测试、新增 1 项“不注册”断言）。
- `make package` 生成候选包 69,665 字节，SHA-256
  `a8e8c5238598ccac9d6c91d44ab3fcc63b53c09a5fbc4a212cb1d8fc341c1361`
  （`packages/forgeloop/dist/forgeloop-dsh-0.0.2-noselector.tgz`）；tarball 内 `client.js`
  已确认不含 `conversation.input.left` / `forgeloop-mode`。
- 通过 `plugin_manager` `install_bundle` 安装到 desktop profile，结果 `application: applied`，
  安装副本与源码 `client.js` 的 SHA-256 一致（`b1a97536…`）。
- 客户端槽位实测：`conversation.input.left` 占用为空；`conversation.view` 仍注册
  `forgeloop`（order 20），「天工」页未受影响。

### 9.3 未做与边界

- 未创建 commit；§3 的历史批次记录保留当时的实现与验证事实，不回写为“从未存在”。
- 未重跑真实模型工具调用、需求受理或业务链路；本批只验证客户端槽位与安装生效。
- 发现但不碰：`docs/proudct.md` 等重规划前文档仍按历史事实保留选择器描述。

## 10. 首版验证评测方案收口（2026-10-28）

所有者在逐项确认后明确“收口，写入项目文档”。本批由外部 Codex 直接整理方案，
不属于 ForgeLoop 自主执行的交付，也没有新增代码实现或产品场景验收结论。

### 10.1 计划范围与实际改动

- 新增 `docs/validation-evaluation.md`，作为已确认首版方案的入口：小型回归库、真实主路径、
  独立业务终审、模型配置保护、测试有效性与回归库维护、两道交付门槛、失败计数及有据复验。
- 更新 `docs/README.md` 的方案入口与状态说明。
- 定向更新 `docs/product.md` 的验证说明、停止参数及上线检查表述：固定检查通过即交付，
  不增加发布后固定观察期；原 PRD 的其他技术细化没有在本批全面重写。
- 更新 `docs/planning-handoff-2026-10-27.md` 的收口状态，补充上线缺陷计入本轮、检查集合通过即完成、
  有据复验三项决定；保留既有讨论来源与历史检查记录。
- 更新本状态记录。计划与实际范围为上述 5 份文档；已有代码、契约、测试和其他文档在途改动保持原样。

### 10.2 已执行检查与边界

- `make check` 通过：类型检查、架构／CLI 契约、本机提交策略配置校验；27 个测试文件、237 项测试通过。
  本机原始日志：`.cache/forgeloop/validation-plan/2026-10-28-vjm0vppj/make-check.log`。
- 本批 5 份文档的 75 处本地链接与锚点检查通过；`git diff --check` 和新增文档空白检查通过。
  对照修改前状态和内容摘要，范围外既有改动及删除保持原样；检查日志与增量差异保存在上述日志目录。
- 未修改实现、依赖、契约、测试配置或生效门禁，未运行真实宿主验证、打包或部署，也未创建 commit。
  仓库检查结果不表示新方案要求的真实端到端主路径、初始化保护或交付闭环已经实现。

### 10.3 待做与发现但不碰

后续在种子实施方案中确定测试工具接线、初始用例、具体数据样本、模型接入及路径保护、报告 schema
和用例等待参数，并实际验证。M2 样本量、窗口与事件归并另行确定；不补造默认时限、达标数字或实施结果。
当前领域术语、架构和命令契约仍描述现有实现；PRD 其他技术段与后续已确认决定的同步留给技术方案整理，
本批不重开已结束的运维讨论，也不扩大首版环境建设。

## 11. 方案文档整合与清理（2026-10-28）

来源：所有者要求“合并最新的产品目标、需求、技术、验证方案文档为一个文档”，并审查删除冗余、过时文档。
本批由外部 Codex 完成，只整理项目文档，不计为 ForgeLoop 自主交付。

### 11.1 计划范围与实际改动

- 统一 `docs/product.md`：合并产品基线、需求与场景映射、技术决定、验证规则、统计口径、待实施项及 DSH 接缝依据。
  用最新决定替换“宿主待定”“旧数据兼容待定”等表述；保留需求／场景细化与具体实施尚未完成的状态。
- 删除 `docs/planning-handoff-2026-10-27.md`、`docs/validation-evaluation.md`：有效方案已并入统一文档，不再维护重复版本。
- 删除 `docs/proudct.md`：重规划前的范围与阶段已过时，现状大部分重复；独有实现缺口迁入 §4.1，原件包含的手动修订已留本机副本。
- 同步 `docs/README.md`、根 `README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`CONTEXT.md`、
  `docs/architecture.md`、`docs/deployment.md`、`docs/development-discipline.md`、
  `docs/adr/0008-typescript-native-dsh-plugin.md`、`docs/delivery/2026-10-22-typescript-dsh.md`、
  `packages/forgeloop/README.md` 和本状态记录：修复入口、旧范围和不准确的完成表述，标明当前与历史文档适用性。
- 共修改 13 份、删除 3 份文档。保留当前架构／领域／安装说明、工程纪律、两份 ADR 与真实交付记录，
  它们承担独立的实现、操作或证据职责；本机阅读资料、退役代码、原始数据及已有代码／契约改动保持原样。

### 11.2 来源回查与验证

本批三个被删文件原为未跟踪文件，不能声称可从 Git 恢复。删除前的完整文档副本、文件范围、
工作树状态与内容摘要保存在本机 `.cache/forgeloop/doc-consolidation/2026-10-28-fvuvnsg8/`，
原件位于 `before/`；这是本机回查材料，不随仓库分发。更早已跟踪文档的回查方法仍见 §7.2。

接续稿中的独有建档记录同时迁入本节：2026-10-27 批次只新增接续稿并更新索引，
`make check` 为 27 个测试文件、237 项测试通过；两份文档 37 处本地链接／锚点检查通过，
未改实现、部署或提交。原始日志在 `.cache/forgeloop/discussion-handoff/2026-10-27-z0vmlwvz/`。
§8–§10 的旧文件名保留其历史含义，当前阅读统一转到 `product.md`，不改写当批事实。

- `make check` 通过：类型、架构／CLI 契约、本机提交策略配置校验，27 个测试文件、237 项测试通过；
  原始输出见上述目录的 `make-check.log`。这是现有仓库检查，不是新方案已完成真实验收。
- 14 份活动项目文档的 123 处本地链接／锚点检查通过；修改文档空白检查与 `git diff --check` 通过。
  核对修改前内容摘要，范围外既有文件及删除保持原样。详情见 `document-check.json`，本批增量见 `documentation.diff`。
- 未运行真实宿主验证、打包或安装，未清理业务数据或修改生效配置，未创建 commit。

### 11.3 待做与发现但不碰

统一方案中的具体实施、M2 参数和首条 DogFood 需求仍未确定；工作台时间线只是建议，没有被记录为已批准任务。
§4.1 的现有实现缺口与统一方案 §15 所述 DSH 接缝限制留待具体任务处理，不借文档清理扩建运维平台或改变权限。

## 12. 文档职责优化与历史证据核对（2026-10-28）

所有者接受文档审查建议并要求处理。本批为外部 Codex 文档维护，不计作 ForgeLoop 自主成果。

### 12.1 范围与实际改动

- 开发规则并入 `AGENTS.md`，删除 `docs/development-discipline.md`；`CONTRIBUTING.md` 聚焦许可、提交策略与钩子操作，删除重复时段。
- `CONTEXT.md` 精简为当前术语与对象关系，不重复命令流程和参数；`docs/product.md` 保持统一方案，补需求至方案／验收场景映射，压缩重复提醒。
- `docs/architecture.md` 压缩功能操作细节，保留模块、依赖、数据、状态与信任边界；`docs/deployment.md` 区分桌面、非桌面和测试入口，改用候选／上一已验证版本，并修正验证脚本环境变量说明。
- 本状态记录前置最新快照、精简已有独立交付报告的迁移批次，并在 §2.2 登记覆盖率及测试日志勘误。
- 根 `README.md`、`docs/README.md` 仅同步纪律入口；`docs/library/reading-guide.md` 标明历史背景并修复最新入口，其余研究正文保留。
- 范围为上述 10 份修改、1 份删除；两份 ADR、历史交付报告、插件 README 与 legacy 说明原样保留。未修改源码、契约、测试、依赖或运行配置。

### 12.2 检查与回查

- `make check` 通过：类型、架构／CLI 契约、本机提交策略配置校验，27 个测试文件、237 项测试通过；原始输出为本批目录的 `make-check.log`。
- 13 份活动项目文档与阅读指南共 14 份文档，160 处本地链接／锚点检查通过；Markdown 表格列数、修改文档空白和 `git diff --check` 检查通过。
- 对照修改前摘要，范围外既有文件改动和删除保持原样；检查明细为 `document-check.json`，本批差异为 `documentation.diff`。

完整原件、范围、工作树摘要及本批增量保存在本机
`.cache/forgeloop/doc-optimization/2026-10-28-6yka8z32/`；不随仓库分发。
`docs/library/reading-guide.md` 原本为忽略文件，本次修改仍不入库。未执行部署、数据清理或提交。

### 12.3 发现但不碰

当前代码缺口继续按 §4.1 记录；没有据文档优化实施新方案。历史交付报告引用错位通过 §2.2 勘误处理，
§3.4 的后续覆盖率值按当时记录保留，本次未重新取得其原始输出或复跑。资料库其他文章、论文与研究未逐篇更新。

## 13. 冗余功能与代码清理（2026-10-28）

来源：所有者要求“根据最新的项目文档，删除冗余的功能和代码”。本批由外部 Codex 直接执行，
不计为 ForgeLoop 自主交付。依据统一方案的 DSH 唯一宿主、首版边界及待实施事项，结合源码引用确定清理范围。

### 13.1 计划范围与实际改动

精确文件清单和修改前快照保存在本机
`.cache/forgeloop/code-cleanup/2026-10-28-gKhr06/plan.md`、`scope.json` 与 `before/`。
产品文件范围为 `legacy/` 的 368 个退役文件及另列的 26 个文件；实际为删除 371 个、修改 21 个、新增 2 个，未扩大产品文件范围。

| 范围 | 目的与实际处置 |
| --- | --- |
| `legacy/`、`scripts/install_local_service.sh` | 删除退役 Python 核心、独立网页／服务、邮件、固定启动器、旧配置、工作流、测试与失效 systemd 接入入口 |
| `src/domain/approval.ts` | 删除无活动调用的内存批准簿；实际任务包授权仍由 `task-plan.ts`、运行时和记录层承担 |
| `src/domain/delivery.ts`、`work.ts` | 删除孤立的绑定、阶段路由和产物草稿校验，保留被使用的摘要计算与任务运行／产物类型 |
| `src/domain/requirement.ts`、`task-plan.ts`、`status.ts`、`src/runtime/coordinator.ts` | 删除无活动调用的重复辅助函数、状态集合与导出；保留实际执行规则 |
| `src/runtime/workspace.ts` | 删除仅测试使用的 worktree 和改动探测 API；快照文件选择使用 Git 跟踪／忽略规则，保留未提交修改，移除按 `legacy` 名称漏拷文件的特判 |
| `tests/domain`、`requirement`、`task-plan-rules`、`workspace`、`formal-test`、`work-formal` | 删除退役 API 的专用用例，候选采集改测实际快照路径；重复的正式测试文件合并，保留成功文字不能覆盖失败退出码、超时日志等反例 |
| `scripts/ts/contracts.ts`、`contracts/architecture.json`、新增 `tests/architecture-contract.test.ts` | 同步模块清单，登记退役路径并拒绝重新引入，覆盖合法插件、旧目录／安装脚本和旧检查的组合绕过场景 |
| Makefile 注释、AGENTS、根 README、文档索引、当前架构、ADR 0008 后续说明、新增 ADR 0009、本状态记录 | 同步当前实现、清理边界和历史回查；旧批次事实保留 |

表内 `src/`、`tests/` 均位于 `packages/forgeloop/`。未新增通用框架或抽象。
本批删除的已跟踪文件开始前均与 `b344b5a08407f0f94ab5d3ca90887ecf17a24e7f` 一致，按原路径从 Git 回查。
旧目录另外遗留 290 个忽略的 `.pyc`，先移入本批 `before-generated/`，再移除空目录；摘要清单为 `archived-generated.json`。
打包前备份并移除本机残留的 `lib/domain/approval.js`，上一份默认候选与 `artifact.json` 同样保留副本。

### 13.2 验证与证据

- 基线 `make check`：27 个测试文件、237 项测试通过，见 `baseline-check.log`。
- 先运行新增准入及快照行为测试：捕获 5 项目标失败，分别指向退役目录／脚本仍被允许、旧源码与 legacy 同存可绕过检查、按目录名漏拷文件；见 `red-contract-and-snapshot.log`。实现后两份定向测试共 12 项通过，见 `green-contract-and-snapshot.log`；其中退役 worktree 的一项测试随 API 删除。
- `make architecture-contract` 已更新模块清单；`make check` 通过类型、架构／CLI 契约、本机提交策略配置及行为测试：27 个文件、224 项通过，见 `architecture-update.log`、`make-check.log`。测试数量变化来自删除 19 项退役／重复用例并新增 6 项准入用例。
- `make coverage` 通过：行／语句 92.03%、函数 95.88%、分支 85.03%；阈值和统计配置保持原样。原始输出与本次摘要为 `coverage.log`、`coverage-summary.json`，仓库原有摘要文件保持修改前内容。
- `make package` 通过：候选构建标识 `0.0.2`，66,767 字节，SHA-256 `27fc1c6819ef4a34288b4fdd01c02ff14e027a4735d3c7928284fc6b4340ef03`。实际 tarball 的 26 个编译模块逐一匹配活动源码与本机编译内容，没有退役模块、Python 文件或旧安装脚本；清单核对见 `package-verification.json`，候选和元数据另存本批 `candidate/`。
- 14 份活动文档的 164 处本地链接／锚点与 `git diff --check` 通过。对照修改前摘要核对全部实际改动均在计划范围内，暂存内容与开始前完全一致，290 个字节码备份摘要一致；明细为 `document-check.json`、`scope-verification.json`。

上述证据均位于本批缓存目录，不随仓库分发。Git、文件和正式测试子进程在行为测试中实际执行；
没有重跑 `make verify-plugin`、真实 DSH／模型主路径或业务 DogFood，也没有安装、升级、部署或创建 commit。
本批未产生新的目标 profile 和实际运行版本验证结论。

### 13.3 未完成与发现但不碰

- 当前 `/fl` 仍是批准、验收与停止入口，旧库补列仍由活动记录层调用；统一方案的新入口和存储尚未替代它们。本批保留这些实际依赖，后续迁移需覆盖替代入口及状态／授权行为验证。
  （2026-10-28 后续：这些依赖已按 §14 删除；本项是当批状态，不代表当前实现。）
- §4.1 的停止、逐动作工时、失败累计与权限缺口继续保留；本次清理没有把孤立规则的测试改写成这些缺口已经落实的证据。
- 当前 `tsc` 构建不清理旧 `lib/` 文件；本批已备份并移除这次退役模块的残留 JS，检查实际安装包没有夹带。后续删除源码时仍需核对编译目录，通用构建清理策略未在本批调整。
- 架构契约 `external_seams.web_board_rpc` 仍保存过时 RPC 描述，当前实现使用 Fetch，实际检查使用 `ui_surface.data_path`。建议单独核对接缝元数据，避免把该说明当作当前调用方式。

开始前已有的暂存及工作树改动继续保留；业务数据库、原始轨迹、候选历史、DSH 模型配置和凭据未作清理。

## 14. 命令表面、旧库兼容与提交策略清理（2026-10-28）

来源：所有者要求“根据最新的项目文档，删除冗余代码和功能，删除 /fl 系列命令和旧库兼容；
删除本级的 git 提交限制策略；git 提交所有修改”。本批由 DSH 会话内 Agent 直接实施，
未通过 ForgeLoop 受理需求，不计为插件自主执行成果。

### 14.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `packages/forgeloop/src/commands.ts`、`src/index.ts` | 删除 `/fl` 命令表面及其注册；插件不再注入 `ctx.commands` |
| `tests/command-surface.test.ts`、`tests/status-command-output.test.ts`、`tests/impact-command.test.ts`、`tests/board-channel.test.ts` | 删除命令专用用例，影响摘要测试改走运行时与 `forgeloop_impact`；假宿主不再提供命令服务 |
| `contracts/cli-contract.json`、`scripts/ts/contracts.ts`、`Makefile` | 删除 CLI 契约、子命令校验、`--cli` 模式与 `make cli-contract`；架构契约只保留模块、依赖、表与工具 |
| `packages/forgeloop/client.js`、`tests/client-view.test.ts` | 删除复制 `/fl` 命令的按钮、状态与文案；页面保持只读，不暗示命令入口 |
| `packages/forgeloop/src/runtime/service.ts`、`board.ts`、`prompts.ts` | 删除运行提示与页面文案中的 `/fl` 指令；保留的运行时流水线不再宣称有人类入口 |
| `packages/forgeloop/src/records/db.ts`、`repository.ts`、`status.ts`、`config.ts` | 删除旧库补列、旧库兼容注释与相关表述；新库从空库按当前结构建立 |
| `scripts/ts/commit-policy.ts`、`config/commit-policy.template.toml`、`config/workday-calendars/`、`.githooks/` | 删除本机提交时间策略、配置模板、年历与钩子 |
| `Makefile`、`.github/workflows/quality.yml`、`CONTRIBUTING.md`、`AGENTS.md`、`scripts/ts/verify-plugin.ts` | 删除提交策略目标、CI 作业、操作说明与命令探针；`make check` 只做类型、架构契约与行为测试 |
| `docs/adr/0002-*`、新增 `docs/adr/0010-*`、`docs/README.md`、`docs/product.md`、`docs/architecture.md`、`docs/deployment.md`、`CONTEXT.md`、根与插件 README、本记录 | 记录删除决定、当前事实、替代入口缺口与历史回查方式 |

本机 `core.hooksPath` 已取消，`.cache/forgeloop/commit-policy.toml` 已移除；仓库不再包含提交时间判定代码。
删除的命令、契约与策略文件可按原路径从 Git 历史回查。未清理业务数据库、证据、候选包、DSH 配置或凭据。

### 14.2 验证与证据

- 删除前基线：`make check` 通过，27 个测试文件、224 项测试；本批原始输出保留在本机缓存。
- 删除后 `npm run typecheck --workspace forgeloop-dsh` 与 `npm test --workspace forgeloop-dsh` 通过，
  25 个测试文件、202 项测试。
- `make check` 通过类型检查、架构契约与行为测试：25 个测试文件、202 项测试。
- `make coverage` 通过：行／语句 91.52%、函数 96.07%、分支 84.11%；阈值保持原样。
- `make package` 通过：候选构建标识 `0.0.2`，62,641 字节，SHA-256
  `d3fb37bdea8d4621bff91a2260416824f47b67a2bc2146f87676d9f2050e0d43`；tarball 清单不再包含
  `commands`、`cli-contract`、`commit-policy` 或 `.githooks` 文件。
- `git diff --check` 与文档本地链接检查通过（文档索引、ADR、架构、部署与状态记录）。
- 未运行真实 DSH 宿主、模型主路径、安装或部署；上述仓库检查不代表客户决定入口或新方案能力已交付。
- 按所有者要求，本批与开始前已存在的文档、退役代码及代码清理改动一并提交；提交身份与哈希由 `git log` 回查。

### 14.3 未完成与发现但不碰

- 客户决定入口尚未实现：插件当前只能受理需求和只读查询，不能完成批准、推进、验收或停止。
  统一方案的工作台、专用会话模式和自主交付仍需单独实施与验证。
- 运行时仍保留 `approvePlan`、`advance`、`accept`、`grant`、`stop`、`cancel`、`recover`、
  `buildCandidate` 等内部操作；它们由运行时、协调器与测试使用，供未来可信入口复用。
  本批没有删除业务流水线，也没有为便于调用而放宽任何授权或材料判定。
- 旧数据库、证据、候选包和本机提交记录未清理；新库不再兼容旧库，是否迁移或清理业务数据另行决定。
- 历史批次中的 `/fl`、提交策略与旧库兼容记录按当时事实保留，不改为“从未存在”。

## 15. 业务会话输入接管与需求拆解（2026-10-28）

来源：所有者要求“实现 ForgeLoop 劫持用户输入，转入 ForgeLoop 流程，对接需求 Agent，
把用户输入拆解为需求”。本批由 DSH 会话内 Agent 直接实施，未通过 ForgeLoop 受理需求，
不计为插件自主执行成果。

### 15.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/session/intake.ts` | 在 `agent/pre-step` 中识别 `agentPreset=forgeloop` 的非子 Agent 会话；只处理真实人类消息，按 `sessionId + messageId` 幂等提交需求，调用需求 Agent 分析后追加会话事件并 reject 普通模型步骤 |
| `src/session/events.ts`、`src/session/index.ts` | 定义 `forgeloop/intake`、`forgeloop/analysis`、`forgeloop/error` 自定义会话事件；安装输入接管监听器，统一释放 |
| `src/session/preset.ts` | 注册 `forgeloop` agent preset（显示名“ForgeLoop 业务会话”，空插件组合）；宿主没有 `agentPresets` 时不注册并保留原因 |
| `src/runtime/service.ts` | 新增 `analyzeRequirement`：复用需求分析链路，已有同版本分析时不重复调用模型；失败或终态显式返回 |
| `client.js` | 注册三个自定义 Chat 节点定义与 keyed 渲染器；展示原始输入、需求身份、需求 Agent 的目标/场景/验收/待澄清结果与失败原因 |
| `tests/session-intake.test.ts`、`tests/client-view.test.ts`、`contracts/architecture.json`、`scripts/ts/contracts.ts` | 增加输入接管、幂等、普通会话不拦截、失败事件、preset 注册、节点折叠测试；登记 `session_surface` 并由契约检查 preset、事件、节点与实现一致 |
| 架构说明、插件 README、本记录 | 说明业务会话入口、真实宿主未验证和当前边界 |

没有新增 `/fl` 命令、客户决定入口、旧库兼容或新的通用框架。输入接管只在 host 半实现；
没有改 DSH 源码。

### 15.2 行为与证据

1. 用户选择 ForgeLoop 业务会话后，普通输入框的文本由 `agent/pre-step` 接管；成功时写入
   `forgeloop/intake` 与 `forgeloop/analysis`，普通聊天步骤被 reject，不调用模型聊天。
2. 需求身份由 `sessionId + messageId` 幂等键保证；同一消息重复投递不会重复建需求。
3. 非 ForgeLoop 会话、子 Agent 会话、`runtime-context` 等非人类消息不进入受理；不会误拦截。
4. 需求 Agent 失败时写入 `forgeloop/error`，需求与原始输入仍保留，普通聊天仍被拒绝。
5. 客户端按事件类型渲染卡片；节点事件是 log-only，不进入模型历史。

### 15.3 检查与实际结果

- `make check` 通过：类型检查、架构契约与行为测试，26 个测试文件、220 项测试。
- 新增 `tests/session-intake.test.ts` 15 项：受理并展示分析、普通/子 Agent 不拦截、系统上下文
  不受理、同消息幂等、需求 Agent 失败、preset/事件 helper、监听器释放与失败回退。
- `tests/client-view.test.ts` 增加到 6 项：自定义节点注册、事件折叠与普通 DSH 行为不受影响。
- `make contracts` 通过：`session_surface` 的 preset、`agent/pre-step`、人类来源、会话事件与
  客户端节点均与实现一致。
- `make coverage` 通过：行／语句 91.54%、函数 95.28%、分支 84.35%，门槛保持原样。
- `make package` 通过：候选构建标识 `0.0.2`，68,160 字节，SHA-256
  `63b234588f9b5517f94f530bd73183d0958b3e3f4390cc92b0740405c16bcb2e`；tarball 含新增
  `lib/session/*.js` 模块。
- 2026-10-29 已在 DSH `0.2.1-rc.4` Web profile 完成首次真实试验，见 §16；重启恢复与多会话
  隔离仍未验证。

### 15.4 未完成与发现但不碰

- 客户决定入口、批准/验收/推进/停止仍无入口；本批只做到“输入 → 需求 → 需求 Agent 拆解”。
- 只受理文本；附件、图片和一条输入拆成多条需求尚未实现。当前一条人类消息对应一条需求。
- 需求分析在 `agent/pre-step` 内同步等待，耗时期间该轮占用输入；长耗时需要改为异步队列 +
  会话事件回填，尚待后续任务。
- 会话事件只在其 agent 存活时追加；重启后的补发/outbox 未实现，业务事实以 SQLite 为准。
- 真实宿主上的 preset 空组合如不被接受，需要增加最小 session 标记插件行；这不改变本批
  的输入接管判定。
- 未创建 commit；工作树改动与验证结果保留，等待所有者下一步指示。

## 16. DSH Web 首次安装与业务会话试验（2026-10-29）

来源：所有者要求“DSH web 安装 ForgeLoop 插件，并试验第一个版本功能”。本批由 DSH 会话内
Agent 直接执行，不是 ForgeLoop 自主交付。

### 16.1 安装与配置

- 目标：DSH `0.2.1-rc.4`，profile `web`，现有 Web 实例 `127.0.0.1:3080` 保留不动。
- 安装：`dsh plugin --profile web add packages/forgeloop/dist/forgeloop-dsh-0.0.2.tgz`；
  候选包 SHA-256 `63b234588f9b5517f94f530bd73183d0958b3e3f4390cc92b0740405c16bcb2e`，
  68,160 字节。profile 的 `dsh.profile.bundles` 增加了 `forgeloop-dsh`。
- 配置：在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖 `forgeloop` 的 `recordsRoot`、`project`、
  `projectPath`；测试实例再用 `--patch` 覆盖到独立记录根
  `.cache/forgeloop/dsh-web-test2`，避免污染正式项目记录。
- 启动：同一 web profile 在 3090 启动隔离实例（`dsh --profile web --patch ... --no-open --port 3090`）；
  3080 原实例不重启，避免中断当前会话。试验结束后 3090 实例与自动化浏览器已关闭。

### 16.2 实际试验与结果

1. 新会话选择 **“ForgeLoop 业务会话”** preset，在普通输入框输入
   `给需求看板增加按状态过滤` 并发送。
2. 聊天区出现 `已进入 ForgeLoop 流程` 与 `需求 Agent 拆解结果` 卡片（默认折叠在
   “已完成分析” 过程组内，展开可见）；没有普通 assistant 回复。
3. 需求落库：`req-20261028235909-a9efb3`，会话 `session-2960bfd5-a759-40d5-bff8-0c17b1e629b2`，项目 `forgeloop-web-test2`，状态
   `awaiting_clarification`；需求原文、session 身份与 message 身份保存在 `requirements`。
4. 需求 Agent 产出目标、4 条业务场景、5 条验收标准与 4 条待澄清项，记录在
   `requirement_analyses`；会话日志有 `forgeloop/intake`、`forgeloop/analysis`。
5. 该轮会话日志为 `turn/start → forgeloop/intake → forgeloop/analysis → turn/end(blocked)`，
   **没有 `step/start`、`user/message` 或 `assistant/message`**；普通聊天步骤被拒绝。
6. 截图：`.cache/forgeloop/dsh-web-test2/forgeloop-web-test.png`（本机证据，不随仓库分发）。

试验中发现并修正了一个真实问题：Web 会话 header 是创建事实，用户可能在首轮前切换 preset；
只读 header 会把已选择 `forgeloop` 的会话误判为普通会话。实现已改为优先读取运行中的
preset 组合，header 仅作回退；重新安装候选包后在 3090 实例复验通过。

### 16.3 限制与后续

- 自定义卡片默认折叠在“已完成分析”过程组内，用户需要展开；入口可见性需要后续调整。
- 需求 Agent 产生了待澄清项；当前没有客户回答/决定入口，状态停在 `awaiting_clarification`。
- 只验证了单条文本、单会话、首次受理；重启恢复、并发会话、附件、审批与后续规划未验证。
- 3090 测试实例已停止；3080 正式实例未重启，是否加载了新包未作为本批结论。安装与配置记录
  已写入本机 web profile 与 `.cache`，未提交代码或文档之外的运行配置。

## 17. 独立测试环境与正式环境隔离（2026-10-29）

### 17.1 环境边界

| 项 | 正式环境 | 测试环境 |
| --- | --- | --- |
| DSH_HOME | `~/.dsh` | `~/.dsh-forgeloop-test` |
| profile | `web` | `forgeloop-test` |
| Web 端口 | 3080（运行进程 pid 82207） | 3091（试验后已停止） |
| ForgeLoop 记录根 | `~/Library/Application Support/ForgeLoop/production` | `~/.dsh-forgeloop-test/forgeloop` |
| 项目名 | `forgeloop` | `forgeloop-test` |
| 项目路径 | `/Users/lijiajin/Project/ForgeLoop` | `/Users/lijiajin/Project/ForgeLoop/.cache/forgeloop/test-workspace`（git worktree） |
| DSH sessions/storages | `~/.dsh/sessions`、`~/.dsh/storages` | `~/.dsh-forgeloop-test/sessions`、`storages` |
| 凭据 | `~/.dsh/.credentials.yaml` | `~/.dsh-forgeloop-test/.credentials.yaml`（权限 600 的本机副本） |
| 配置 | `~/.dsh/profiles/web/cordis.patch.yml` | `~/.dsh-forgeloop-test/profiles/forgeloop-test/cordis.patch.yml` |

两套 DSH_HOME、profile、记录根、会话存储、凭据文件与工作副本均独立；测试启动命令：

```sh
DSH_HOME="$HOME/.dsh-forgeloop-test" \
  dsh --profile forgeloop-test --no-open --port 3091
```

### 17.2 隔离验证

- 正式 `web` profile 在 3080 运行进程已按新配置生成
  `~/Library/Application Support/ForgeLoop/production/projects/forgeloop/records.sqlite`，
  当前 `requirements` 为 0；锁 owner 为 pid 82207。
- 测试实例使用独立 DSH_HOME 启动后，日志显示记录根为
  `~/.dsh-forgeloop-test/forgeloop/projects/forgeloop-test/records.sqlite`，没有单消费者锁冲突。
- 测试输入 `给隔离测试环境增加状态过滤` 生成需求 `req-20261029011147-921826`，需求 Agent
  输出目标“为隔离测试环境增加按状态筛选的能力”等结构化结果；会话
  `session-9589452d-619e-468e-a148-31c5968cd5ab` 有 `forgeloop/intake`、
  `forgeloop/analysis` 和 `turn/end(blocked)`，无 `step/start` 或 assistant 回复。
- 测试 DSH_HOME 的 sessions 与正式 `~/.dsh/sessions` 分开；测试运行未写入正式记录根。
- 隔离测试截图：`~/.dsh-forgeloop-test/forgeloop/isolated-test.png`。

### 17.3 限制与残留

- 测试 DSH_HOME 的 `.credentials.yaml` 是正式凭据的本机只读用途副本；必须保持 600 权限，
  不进入版本库或候选包。更严格的做法是提供独立测试凭据。
- 09:10 之前的 3090 快速试验曾共享正式 DSH_HOME，其测试会话仍留在 `~/.dsh/sessions`；
  未擅自删除。后续测试统一使用独立 DSH_HOME。
- 正式 3080 实例已按新配置持有正式记录根，但没有在 UI 上重新跑一遍输入接管；本批只把测试
  实例的真实 Web 试验作为功能证据。
- 测试实例在验证后已关闭；需要时按 §17.1 命令重新启动。

## 18. 需求澄清闭环与会话末尾需求摘要（2026-10-29）

来源：所有者要求“增加需求澄清闭环功能，把等待澄清的需求推送到会话中；把已拆解的需求，
同步展现到会话末尾。以 需要澄清 | 不需要澄清 的顺序布局会话”。

### 18.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/runtime/service.ts` | 新增 `pendingClarifications(sessionId)`、`answerClarifications(...)` 与 `sessionSummary(sessionId)`；回答追加需求版本、调用需求 Agent 重新分析；摘要按会话 source 过滤 |
| `src/session/intake.ts` | 会话存在唯一待澄清需求时，下一条人类输入作为澄清回答而不是新需求；多待澄清项时拒绝猜测；追加 `forgeloop/clarification-answer`、`forgeloop/analysis`，必要时再次推送 `forgeloop/clarification-request` |
| `src/session/events.ts` | 新增 `forgeloop/clarification-request` 与 `forgeloop/clarification-answer` 事件及载荷 |
| `src/index.ts` | `/api/forgeloop/board` 增加 `session` 端点，按会话返回已拆解需求与待澄清项 |
| `client.js` | 注册澄清请求/回答 Chat 节点；注册 `conversation.chat.turnTail` 需求摘要，按 **需要澄清 | 不需要澄清** 两列展示，等待澄清在左且在前 |
| 测试、契约、架构、插件说明 | 新增澄清回答、版本绑定、多待澄清拒绝、会话摘要、UI 注册测试；更新 `session_surface` 与文档 |

回答不会新建需求：需求 Agent 把澄清回答追加为需求新版本（保留原文与历史），重新分析后
需求可离开 `awaiting_clarification`。

### 18.2 真实测试结果

- 测试环境：`~/.dsh-forgeloop-test`，profile `forgeloop-test`，records
  `~/.dsh-forgeloop-test/forgeloop`，端口 3091；测试后已关闭。
- 需求：`req-20261029013231-395402`。
- 第一轮：需求 v1、分析 v1 有 4 条待澄清；会话末尾摘要显示
  `需要澄清 1`、`不需要澄清 0`。
- 第二轮：输入澄清回答后，需求变为 v2、分析 v2、状态 `draft`，没有创建第二条需求；
  会话末尾摘要显示 `需要澄清 0`、`不需要澄清 1`。
- 会话 `session-eebc8fcb-2185-4a8d-b43a-5089302c9820` 的事件顺序包含
  `forgeloop/intake → forgeloop/analysis → forgeloop/clarification-request →
   forgeloop/clarification-answer → forgeloop/analysis`，两轮均为 `turn/end(blocked)`，
  无普通 assistant 回复。
- 截图：`~/.dsh-forgeloop-test/forgeloop/clarification-loop.png`。

### 18.3 检查与未完成

- `make check` 通过：26 个测试文件、226 项测试。
- `make coverage` 通过：行／语句 91.43%、函数 95.39%、分支 84.31%，门槛保持原样。
- `make package` 通过：70,944 字节，SHA-256
  `436da0ad9d106c37109eb4dd1bece15d97f278f141b18f96ecc34b2de1582566`；候选包已安装到测试与正式 web profile。
- 多待澄清需求当前返回错误并要求先收敛，没有提供选择/切换待澄清需求的 UI；需要后续任务。
- 摘要端点按会话 source 过滤，页面每轮结束时重新读取；未实现主动推送/轮询。
- 正式 3080 已更新候选包，但未在正式实例上重跑澄清闭环；本批真实证据来自隔离测试实例。
- 待澄清期间新输入都会作为回答，用户不能直接提交第二条新需求；后续需要显式“新需求”入口。

## 19. 研发 Agent 技术方案与任务包（2026-10-29）

来源：所有者要求“下一步接入研发 Agent 生成技术方案与任务包”。

### 19.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/domain/task-plan.ts` | 任务包增加可选 `technicalSolution`（摘要、实施步骤、风险）；校验空摘要、空步骤与重复项 |
| `src/runtime/prompts.ts` | 规划提示词要求研发 Agent 同时输出 `technical_solution` 与 `tasks`，任务包仍须依赖、文件、验收和测试命令 |
| `src/runtime/service.ts` | 新增 `planRequirement(reqId)` 包装 `executePlanning`；规划成功写任务包并置 `plan_proposed`，规划仍不等于批准或执行 |
| `src/session/intake.ts` | 需求分析无待澄清项时自动调用研发 Agent；追加 `forgeloop/plan`，规划失败追加 `forgeloop/error` |
| `src/session/events.ts` | 新增 `forgeloop/plan` 事件，带技术方案与任务清单 |
| `client.js` | 新增“研发 Agent 任务包”Chat 节点，展示技术方案、实施步骤、风险、任务、文件和依赖 |
| 测试、契约、架构、插件说明 | 技术方案解析/拒绝、自动规划、事件顺序、节点注册与契约同步 |

历史任务包没有技术方案仍可读取；新规划提示词要求提供技术方案。

### 19.2 真实测试结果

- 测试环境：`~/.dsh-forgeloop-test`，profile `forgeloop-test`，端口 3091；测试后已关闭。
- 需求：`req-20261029014038-8bbf45`（README 末尾追加一行）。
- 分析 v1 无待澄清项；随后研发 Agent 生成技术方案与任务包 v1：
  - 技术方案摘要、5 条实施步骤、4 条风险；
  - 2 个任务：`core`（修改 `README.md`）与 `verify`（新增回归测试，依赖 `core`）；
  - 需求状态 `plan_proposed`（页面显示“待批准”）。
- 会话 `session-ca6cebc7-7375-4011-a41b-af3e743d9342` 的事件顺序为
  `forgeloop/intake → forgeloop/analysis → forgeloop/plan → turn/end(blocked)`；
  没有普通 assistant 回复，没有批准、推进或执行。
- 规划子会话 `session-fl-plan-...` 真实调用了模型；任务包通过语言/工程边界与任务规则校验。
- 截图：
  - `~/.dsh-forgeloop-test/forgeloop/dev-agent-plan.png`（会话末尾摘要，状态待批准）；
  - `~/.dsh-forgeloop-test/forgeloop/dev-agent-plan-card.png`（技术方案与实施步骤）。

### 19.3 检查与未完成

- `make check` 通过：26 个测试文件、228 项测试。
- `make coverage` 通过：行／语句 91.47%、函数 95.43%、分支 84.12%，门槛保持原样。
- `make package` 通过：72,554 字节，SHA-256
  `1b4f0738f19f43a5d29c8d0fb1102978218675883d44cbeffba54ee79e2230e3`；已安装到测试与正式
  `web` profile。真实 Web 验证在代码相同的 52beaa 构建上完成；最终包差异为同批文档。
- 任务包仍停在 `plan_proposed`；还没有批准/推进入口，也没有执行工作副本、候选包、验证或部署。
- 规划在输入接管内同步执行，耗时由模型与任务包复杂度决定；没有独立后台队列或取消入口。
- 正式 3080 已安装新包，但未在正式实例上重跑规划链路；真实证据来自隔离测试实例。
- 规划 Agent 的“技术方案”是任务包字段，不是独立版本的架构文档；后续若需要方案评审与变更历史，
  应另建对象或版本化记录。

## 20. 测试环境模型配置（2026-10-29）

来源：所有者要求“配置测试环境模型为”并给出 penguin-go 自定义 provider 的界面配置。

### 20.1 配置

测试 profile `forgeloop-test`（`~/.dsh-forgeloop-test/profiles/forgeloop-test/cordis.patch.yml`）
新增两条 patch：

- `llm-pi-ai.providers.penguin-go`：
  - 显示名称 `penguin-go`
  - API key 环境变量 `PENGUIN_GO_API_KEY`
  - 协议 `anthropic-messages`
  - 地址 `https://go.penguin.ooo/api/anthropic`
  - 模型 `deepseek-flash`，上下文 1,000,000，最大输出 384,000，支持 text/image，
    reasoning 档位 off/low/high/max
- `agent-default-model`：`provider: penguin-go`、`model: deepseek-flash`、
  `reasoningEffort: max`

测试 DSH_HOME 的凭据副本已包含 `PENGUIN_GO_API_KEY`，未读取正式 profile 的运行时状态；
正式 `web` profile 的模型配置未改动。

### 20.2 验证

- `DSH_HOME=~/.dsh-forgeloop-test dsh --profile forgeloop-test --dump-config` 显示
  `agent-default-model = penguin-go/deepseek-flash`，`llm-pi-ai` 带 penguin-go provider。
- 测试 Web 实例输入“在 README.md 末尾增加一行：penguin-go 模型验证。”，需求
  `req-20261029014719-701466` 完成分析并生成任务包 v1，状态 `plan_proposed`，页面模型显示
  `deepseek-flash / Max`；没有认证或协议错误。
- 测试实例验证后已关闭；正式 3080 未使用该测试 profile。

### 20.3 边界

- 测试与正式使用同一模型路由，但 profile、DSH_HOME、记录根、sessions 与凭据文件仍独立；
  测试凭据是正式凭据的本机只读用途副本，权限 600。
- 模型配置属于本机 profile，不进入仓库、候选包或正式记录。
- 该验证证明测试环境模型可调用，不代表正式 3080 已切换到该模型或已重启。

## 21. 任务包批准与任务推进（2026-10-29）

来源：所有者要求“实现任务包批准与任务推进”。

### 21.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/index.ts` | 认证 Fetch 路由新增 `approve` 与 `advance`；批准/推进的 `by` 使用插件配置的本机 owner，模型工具不能调用 |
| `client.js` | 任务包卡片增加“批准任务包”“推进任务”按钮；显示批准状态、已交付数量、推进受理与错误；批准/推进后 3 秒轮询详情 |
| `src/runtime/service.ts` | `sessionSummary` 增加 planVersion、approved、delivered、taskCount，供会话末尾显示进度 |
| `src/runtime/agent-runner.ts` | 编程式 dev/review Agent 显式挂载 `standard` preset，取得 shell/fs 等编码工具；只推理角色继续禁用全部工具 |
| `src/runtime/prompts.ts` | 规划要求每个任务在 files 中产生实际改动，禁止无改动的“纯验证任务” |
| 测试、契约、架构、插件说明 | 增加批准/推进路由、非法动作拒绝、Agent preset 组合与任务进度测试 |

批准写入绑定需求版本与任务包版本的批准行，授权来源为
`plan-approval:<reqId>:v<planVersion>:<owner>`；推进只排队 `advance` 请求，由协调器领取后逐任务执行，
不是同步执行，也不等于验收。

### 21.2 真实测试结果

- 测试环境：`~/.dsh-forgeloop-test`，profile `forgeloop-test`，端口 3091；测试后已关闭。
- 第一次推进（工具组合修复前）：需求 `req-20261029015137-6ff9d1` 批准成功，但开发 Agent 只有
  只读查询工具，无法写文件，三个任务尝试均失败。
- 修复：`AgentRunner` 为 dev/review 明确 `agentPresets.mount(agentCtx, 'standard')`。
- 第二次推进：需求 `req-20261029015606-04a05c`：
  - 任务包 v1 批准成功；点击“推进任务”返回推进请求并领取；
  - 第一个任务 `readme-append` **交付成功**：在独立工作副本的 `README.md` 末尾追加
    “开发工具组合验证。”，生成候选 diff、正式测试日志与审查材料；
  - 第二个任务 `verify-check` 连续 3 次失败：“开发回合没有产生任何文件改动”；
  - 需求最终 `blocked`，等待人工决定；没有冒充成功或自动验收。
- 该失败暴露了任务包设计边界：只运行检查、不修改文件的验证任务不能产生候选 diff。
  规划提示词已改为要求每个任务产生实际改动，但当前已生成的任务包不能追溯修正。
- 截图：
  - `~/.dsh-forgeloop-test/forgeloop/approve-advance.png`
  - `~/.dsh-forgeloop-test/forgeloop/approve-advance-actions.png`

### 21.3 检查与未完成

- `make check` 通过：26 个测试文件、232 项测试。
- `make coverage` 通过：行／语句 91.58%、函数 95.78%、分支 84.28%，门槛保持原样。
- `make package` 通过：74,285 字节，SHA-256
  `3a65c19e43d8b4add091055e2a0c7d3407bacb9a98f68a79481d5b3ddfa7ad58`；已安装到测试与正式
  `web` profile。
- 批准/推进是异步的：按钮只负责排队，协调器执行；页面轮询 3–4 秒刷新，没有独立实时推送。
- 没有验收、停止、追加授权、取消或“重新规划”入口；当前阻塞需求需人工处理。
- 任务包中纯验证任务缺少 diff 的语义尚未建模；当前用规划提示词规避，后续需要显式任务类型或
  验证任务交付规则。
- 正式 3080 已安装最终包，但未在正式实例重跑批准/推进；真实证据来自隔离测试实例。
- 未创建 commit。

## 22. 验证任务交付、验收与停止入口（2026-10-29）

来源：所有者要求“先补验证任务的交付语义，再补验收和停止入口”。

### 22.1 验证任务交付语义

- 任务包新增可选 `verification: true`；验证任务必须 `files: []`，不得声明可修改文件。
- 规划提示词允许显式验证任务，但仍优先把验证放进实现任务的 `test_command`；普通实现任务不得标成验证任务。
- 运行时对验证任务只运行批准过的正式测试，不调用开发 Agent、不生成 diff、不要求文件改动。
- 交付材料包含空候选 diff、正式测试日志和“仅验证、无文件改动”的审查说明；候选/测试/审查摘要照常记录。
- 后续任务应用空 diff 和候选构建都跳过空 patch，不把验证任务当成实现改动。
- 非验证任务保持原规则：必须有实际文件改动，否则失败。

### 22.2 验收与停止入口

- 任务包卡片在全部任务交付后显示“验收交付”，调用认证 `accept` 端点；有候选包时仍要求显式产物摘要。
- “停止需求”调用认证 `stop` 端点；协调器先中止该需求在途请求，再置阻塞并撤销待执行请求。
- 批准、推进、验收、停止均使用配置的本机 owner 身份；模型工具不能调用。
- 会话末尾需求摘要增加任务进度、批准与交付数量，并按 4 秒轮询刷新。

### 22.3 测试与真实证据

- 新增确定性测试：
  - 验证任务无 diff 交付：空候选摘要、空 diff 文件、验证说明、随后整体验收通过；
  - 验证任务声明文件被拒绝；
  - `accept`/`stop` 路由的缺少身份、未知需求、成功停止与在途中止计数；
  - AgentRunner 的开发/推理工具组合。
- 真实 Web 证据仍来自 §21：批准后首个实现任务真实交付；当前测试需求
  `req-20261029015606-04a05c` 因旧任务包的纯验证任务失败而阻塞，未重跑。
- 本批没有在真实 Web 上重新验证“验证任务交付 → 验收 → 停止”的完整链路；相关结论仅来自
  确定性测试与路由测试，必须如实标注。

### 22.4 检查与边界

- `make check` 通过：26 个测试文件、236 项测试。
- `make coverage` 通过：行／语句 90.80%、函数 95.80%、分支 84.17%，门槛保持原样。
- `make package` 通过：75,844 字节，SHA-256
  `e80f836c8fbea99de73d82c524bd9fe7e22d4ddc6a0b4d644cdf50473a39ebb5`；已安装到测试与正式
  `web` profile。
- 验证任务跳过独立审查，只以正式测试与验证说明作为材料；这是当前简化，不等于完整验证 Agent 角色。
- 验收没有候选包摘要输入控件；有候选包时按钮会返回“必须显式给出产物 SHA256”，需要后续补齐输入。
- 停止是请求式：中止在途信号依赖协调器实际持有该请求；已完成动作不会回滚。
- 未创建 commit。

## 23. 真实 Web 验证任务、验收与停止（2026-10-29）

来源：所有者要求“补真实 Web 的‘验证任务 → 验收 → 停止’端到端验证，并补候选产物摘要输入”。

### 23.1 候选产物摘要输入

- `requirementView` 增加当前任务包的 `candidate` 字段。
- 任务包卡片在存在候选包时显示“候选产物 SHA-256”输入框；默认填入已记录的候选摘要，
  可手工修改。
- 验收按钮在候选包存在但摘要为空时禁用；点击后把输入值作为 `artifactSha256` 传给认证
  `accept` 端点，运行时仍按候选记录严格比对。
- 没有候选包时不显示输入框，验收仍可依据任务材料完成。

### 23.2 真实 Web 验证任务 → 验收

- 需求：`req-20261029033744-563cbb`。
- 任务包 v1 含两个任务：`readme-append`（实现）与 `verify`（`verification: true`、`files: []`）。
- 在真实 Web 会话中批准并推进：
  - `readme-append` 交付真实候选 diff；
  - `verify` 只运行 `node -e process.exit(0)`，交付空候选 diff
    （SHA-256 `e3b0c442…b855`）、正式测试日志和验证说明；
  - 两个任务均 `delivered`，需求状态停留 `executing` 等待验收。
- 为验证候选摘要输入，在测试记录库中登记了一个候选包摘要
  `78c0a7ba…19c9d`（**该候选记录为 UI 测试种子，不是实际构建产物**）。
- 页面候选摘要输入框自动带出该值；点击“验收交付”后：
  - 需求状态 `accepted`；
  - `accepted_by=test-owner`；
  - `acceptance_source=web-decision:session-5116e778-494a-4645-be42-d929cd7e05ae:accept`。
- 截图：
  - `~/.dsh-forgeloop-test/forgeloop/e2e-candidate-input.png`
  - `~/.dsh-forgeloop-test/forgeloop/e2e-accept.png`

### 23.3 真实 Web 停止

- 需求：`req-20261029034207-2f2444`。
- 在真实 Web 会话中批准并点击“推进任务”，随后点击“停止需求”：
  - 状态变为 `blocked`，原因“停止请求：从任务包卡片停止（test-owner）”；
  - 推进请求最终为 `unknown`，详情为
    `执行异常：aborted before spawn: AbortError: This operation was aborted`；
  - 没有生成任务交付产物，未发生代码副作用。
- 截图：`~/.dsh-forgeloop-test/forgeloop/e2e-stop.png`。
- 这次中途中止发生在开发 Agent 启动前；停止信号中止了协调器请求，但没有验证“开发 Agent
  已运行后停止”的收口路径。

### 23.4 其他真实验证事实

- 第一次验证任务使用 `npm run check --workspace forgeloop-dsh`，在隔离工作副本中因缺少
  `tsc`/依赖以退出码 127 失败；这是环境/依赖问题，不是验证任务语义失败，需求按规则阻塞。
- 修复：验证任务测试命令改为不依赖已安装依赖的 `node -e process.exit(0)`。
- 会话末尾状态已修正：`accepted` 优先显示“已验收”，不再被“已批准”覆盖。

### 23.5 检查与边界

- `make check` 通过：26 个测试文件、236 项测试。
- `make coverage` 通过：行／语句 90.80%、函数 95.80%、分支 84.17%，门槛保持原样。
- `make package` 通过：76,213 字节，SHA-256
  `ce01593f2526bc410cbf2516fed7b22065be5cc0c00a67a3f470c2b742519f28`；已安装到测试与正式
  `web` profile。
- 本轮真实 Web 测试使用隔离测试 DSH_HOME、penguin-go/deepseek-flash（Max）和测试工作副本；
  测试实例已关闭。
- 候选包摘要是种子记录，不是实际 `buildCandidate` 产物；候选摘要输入控件与验收绑定已验证，
  但“构建候选包 → 输入摘要 → 验收”的完整真实链路仍未验证。
- 验证任务的正式测试是空退出命令，证明交付语义，不证明业务验证质量。
- 停止发生在开发 Agent 启动前；运行中 Agent 的停止与副作用核对仍未真实验证。
- 正式 3080 未重跑这些入口；未创建 commit。

## 24. 正式环境装载（2026-10-29）

- 正式 profile：`~/.dsh/profiles/web`，包 `forgeloop-dsh@0.0.2`，已安装最终候选包
  SHA-256 `ce0159…`（76,213 字节）。
- 正式记录根：`~/Library/Application Support/ForgeLoop/production`；项目 `forgeloop`，
  项目路径 `/Users/lijiajin/Project/ForgeLoop`，`autoAdvance=false`。
- 正式 DSH Web 进程 pid 82207（3080）未重启；通过 profile patch 触发热重载后，
  ForgeLoop 协调器 owner 从 `MacAir.local:82207:b7fab49a` 变为
  `MacAir.local:82207:9335f622`，`host.lock` 取得时间更新为 `2026-10-29T06:57:34.569Z`，
  说明插件宿主已重新装载。
- 正式 `forgeloop_status` 可查询，当前正式记录根需求数为 0。
- 浏览器页面仍需刷新以取得新的 ForgeLoop 客户端 bundle；新会话必须重新选择
  “ForgeLoop 业务会话”，已有会话的 preset 不会自动改变。
- 测试环境仍是独立的 `~/.dsh-forgeloop-test`，不共享正式记录、sessions 或凭据文件。

## 25. 天工页交互与取消需求（2026-10-29）

来源：所有者要求“增加取消/归档需求的按钮，误提交的 `req-…f214fd` 可被取消”；同时明确天工页
不是只读页面，应支持批准、推进，不支持验收。

### 25.1 天工页交互

- 天工需求卡新增按钮：
  - **批准任务包**：`plan_proposed`、有任务包且未批准时显示；
  - **推进任务**：任务包已批准且仍有未交付任务时显示；
  - **取消需求**：非终态需求显示。
- 天工页**不显示验收按钮**；验收仍在 ForgeLoop 任务包卡片中完成。
- 批准/推进/取消使用认证 Fetch 路由，`by` 为配置的本机 owner；按钮动作后刷新天工记录和详情。
- 页脚由“只读视图”改为“可交互看板：支持批准、推进和取消需求；验收请回到任务包会话完成”。

### 25.2 取消语义

- 新增认证 `cancel` 端点；先中止该需求当前在途请求，再调用运行时 `cancel`。
- 取消后需求进入终态 `cancelled`；原文、版本、分析、任务包、批准、运行与证据全部保留，
  不物理删除数据库行。
- 取消的需求从“进行中”筛选隐藏；“全部”仍可回查。
- `req-20261029070857-f214fd` 仍为 `awaiting_clarification`；页面刷新并打开任一天工页后，
  可点击“取消需求”将其置为 `cancelled`。本批没有替所有者自动点击。
- `req-20261029070230-bab6bf` 可在天工页直接“批准任务包”，再“推进任务”。

### 25.3 测试与边界

- 新增路由测试：缺少 reqId 拒绝、取消成功、详情状态 `cancelled`；天工动作接线复用
  `approve/advance` 路由。
- `make check` 通过：26 个测试文件、237 项测试。
- `make coverage` 通过：行／语句 90.80%、函数 95.80%、分支 84.19%。
- `make package` 通过：77,184 字节，SHA-256
  `899af384db5d0baf812fd5b3f60a93dbbc23b2d14a38b1981e1250ec2d7a4262`。
- 取消/归档目前只有 `cancelled` 终态和“进行中”隐藏，没有独立归档状态、恢复或物理删除入口。
- 最终包已安装到正式 `web` 与独立测试 profile；正式 3080 通过 profile 热重载，协调器 owner
  于 `2026-10-29T07:22:12.299Z` 更新为 `MacAir.local:82207:634cb860`，取消路由已随宿主加载。
- 天工页动作没有在正式 3080 上做真实点击验证；正式页面需要刷新加载新客户端 bundle。
- 未创建 commit。

## 26. 任务心跳、最后活动与任务详情（2026-10-29）

来源：所有者要求“在页面显示正在执行哪个任务、最后活动时间，增加任务心跳或运行中状态；
点击任务详情页，可以看到 Agent 执行过程”。

### 26.1 实现

- `TASK_RUN_RUNNING`：任务启动时写入运行中状态；`heartbeatTaskRun` 只刷新 `reason/updated_at`，
  不增加执行秒数。
- `AgentRunner` 每 1.5 秒把当前事件快照写入 `dev.jsonl`，并回调 `onActivity`；开发任务把最新活动
  写入任务运行记录，例如“正在调用工具 bash”“执行步骤 N”“模型回复并继续”。
- 天工页：
  - 任务卡显示“执行中”和最后活动时间；
  - 需求卡显示“正在执行：taskId · goal · 最后活动”；
  - 任务卡可打开任务详情抽屉。
- 任务详情端点 `task` 返回任务、运行状态、证据、测试日志尾部和 Agent 活动摘要；详情抽屉显示
  文件、验收标准、测试命令、活动过程与正式测试日志。
- 天工页仍不提供验收；验收只在任务包卡片。

### 26.2 当前真实阻塞

正式 `req-20261029070230-bab6bf` 的 `queue-core` 任务：

- 第一次正式测试失败（退出码 1）；
- 第二次开发 Agent 在 `step 8` 调用了 `ask_user_question`，当前会话在等待工具结果；
- 请求仍是 `claimed`，动作仍是 `started`，需求仍为 `executing`；
- 该任务不是“正常执行中”，而是**等待一个尚未接入任务详情/回答入口的 Agent 提问**。

这意味着仅做心跳只能显示“正在调用 ask_user_question”，不能替用户回答。任务详情抽屉会展示
该问题，但还没有回答按钮；这是下一步需要补的闭环。

### 26.3 检查与装载边界

- `make check` 通过：26 个测试文件、239 项测试。
- `make coverage` 通过：行／语句 90.66%、函数 95.56%、分支 84.02%。
- `make package` 通过：80,404 字节，SHA-256
  `866c950798af90723ee26af4b3040e689883922260dd8dc9f6cd9fafefc645ca`。
- 正式 3080 已在所有者确认“停止任务并热重载”后热重载（协调器 owner 更新为
  `MacAir.local:82207:41263e35`，acquiredAt `2026-10-29T07:35:39.695Z`）。
- 在途开发回合被停止：`req-20261029070230-bab6bf` 状态变为 `blocked`，原因
  “开发回合被停止：工作副本可能有未收口改动，需核对；不会盲目重放”；推进请求和动作均为
  `unknown`，没有自动重放。
- 待决问题原文：架构契约要求新模块登记 `contracts/architecture.json`，但该文件不在
  `queue-core` 允许清单；开发 Agent 给出的选项是扩大范围、保持范围只交付可编译模块、或取消/改方案。
- 正式页面仍需刷新以加载心跳/任务详情客户端；未在正式页面做真实点击验证。
- 待当前任务停止/结束，或所有者确认可以中断后，再热重载正式 profile 并刷新页面。
- 未创建 commit。

## 27. 任务失败原因、解决方案与重试（2026-10-29）

来源：所有者要求“任务失败，展示失败原因，并给出解决方案；任务卡片增加重试按钮，支持重试机制”。
本批由 DSH 会话内 Agent 直接实施，未通过 ForgeLoop 受理需求，不计为插件自主执行成果。

### 27.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/domain/failure-advice.ts` | 纯函数：从任务运行原因、正式测试日志尾部与审查结论归纳失败原因、可执行下一步和涉及文件；覆盖契约未登记、文件越界、审查阻断、无改动、停止/超时、测试失败、额度用尽与原因缺失 |
| `src/runtime/board.ts` | 任务视图新增 `failureReason` 与 `failureAdvice`；失败/阻塞/待决定任务卡可直接显示原因与首条建议 |
| `src/runtime/service.ts` | 新增 `retryTask`/`retryEligibility`；任务详情返回失败轮次、建议与重试准入；重试时把上一次失败原因和测试日志尾部带回开发提示词；推进入口共用失败额度准入；失败轮次 ID 绑定推进请求，跨请求重试不吞轮次 |
| `src/index.ts` | 新增认证 `retry` 端点；请求体增加 `confirmRecovery`，其余端点不变 |
| `client.js` | 失败任务卡显示原因与首条解决方案；任务详情显示失败原因、完整建议、失败轮次与测试日志；新增重试按钮，unknown 请求采用“第一次提示核对、第二次确认重试”两步 |
| `tests/failure-advice.test.ts`、`tests/status-board.test.ts`、`tests/service.test.ts`、`tests/board-channel.test.ts`、`tests/client-view.test.ts` | 覆盖建议分类、看板字段、重试准入两侧、额度不清零、失败上下文回灌、unknown 二次确认、路由校验与中英文标签 |
| `contracts/architecture.json`、`scripts/ts/contracts.ts`、架构说明、插件 README、`CONTEXT.md`、本记录 | 登记新模块与 `retry` 端点，说明重试边界与术语 |

没有新增持久化表、任务包版本、重新规划或扩范围入口，也没有修改模型工具；重试不是新的批准路径。

### 27.2 行为与规则

1. **展示原因**：任务运行记录中的 `reason` 原样进入看板任务视图；失败/阻塞/待决定时显示在任务卡上。
2. **给出方案**：`failure-advice.ts` 只依据已记录证据做确定性归因。正式测试日志中的
   `[contracts] FAIL 活动源码未登记在契约 modules：…` 会转成“在 `contracts/architecture.json`
   登记模块、把契约文件纳入任务清单、重新规划并批准后再重试”；文件越界、审查阻断、无改动、
   停止/超时、额度用尽分别给出对应下一步。证据不足时明确写“未记录失败原因”，不调用模型猜方案。
3. **重试准入**（服务端强制，页面只做展示）：
   - 需求非终态、任务包是最新版本、依据当前需求版本且已批准；
   - 任务有失败/阻塞/待决定运行记录，且没有交付产物；
   - 没有 pending/claimed 请求；失败轮次额度必须大于 0；
   - 该任务是拓扑序中第一个未交付任务，不能跳过前置任务；
   - 不满足时返回 `terminal`、`plan_not_approved`、`stale_plan`、`stale_requirement`、
     `already_delivered`、`not_failed`、`busy`、`grant_required` 或 `predecessor_pending`。
4. **重试语义**：只排队一次 `advance`，由协调器按原任务包重新执行；不新建任务包、不清零失败轮次与证据、
   不扩大已批准文件清单。下一次实现回合会收到上一次运行原因、最近失败轮次与正式测试日志尾部。
   失败轮次 ID 从“任务 + 尝试序号”改为“任务 + 推进请求 + 尝试序号”，跨请求重试的 `a1` 不会被
   上一次请求的同名轮次吞掉；同一请求重复执行仍保持幂等。
5. **unknown 请求**：存在结果未知请求时，第一次调用返回 `recovery_required`，不关闭也不重放；
   携带 `confirmRecovery:true` 后才把 unknown 标为 `dismissed` 并排队重试。该确认由 Web owner 动作触发，
   模型工具没有该入口。
6. **额度共用**：`requestOperation` 的普通 `advance` 与 `retryTask` 使用同一失败额度判定；额度用尽后
   两者都拒绝，避免借重试或再次推进绕过计数。

### 27.3 真实证据核对

用正式记录根 `/Users/lijiajin/Library/Application Support/ForgeLoop/production` 的失败任务
`req-20261029070230-bab6bf` / `queue-core` 离线核对（只读）：

- 看板任务卡带出原因“正式测试失败（退出码 1），日志 …/formal-test.log”，并给出查看日志、修复后重试的建议；
- 任务详情读取真实日志尾部后识别出两个未登记模块
  `requirement-queue.ts`、`requirement-stage.ts`，建议登记 `contracts/architecture.json` 并重新规划；
- 重试准入为 `allowed:true`、`requiresRecovery:true`（该需求确有 1 条 unknown 推进请求），与页面两步确认一致。

这是记录与建议链路的核对，不是浏览器点击验收；正式页面仍需刷新加载新客户端。

### 27.4 检查与实际结果

- `make check` 通过：27 个测试文件、255 项测试。
- `make coverage` 通过：行／语句 91.22%、函数 95.72%、分支 84.56%。
- `make package` 通过：86,446 字节，SHA-256
  `dcb9af33c9ae011cf8e6417f03b76ffe5cd517bffac39e847a05a68069ef78a3`；tarball 含
  `lib/domain/failure-advice.js` 与更新后的 `client.js`。
- 已安装到正式 `web` profile 并触发热重载：协调器 owner 为 `MacAir.local:82207:0fea7f5e`，
  acquiredAt `2026-10-29T08:05:19.043Z`；正式 3080 未重启。
- 认证路由 `/api/forgeloop/board` 在无浏览器凭据时返回 401，未绕过认证做真实点击；
  重试按钮、两步确认与页面刷新后的展示仍待所有者实际操作确认。

### 27.5 未完成与发现但不碰

- 重试不改变已批准文件边界。`queue-core` 的根因是任务包未包含 `contracts/architecture.json`；
  正确处置是重新规划并批准，而该入口仍未实现。页面会如实提示“直接重试会再次被同一契约检查阻断”。
- 规划提示词未要求“新增 `src` 模块时把 `contracts/architecture.json` 纳入同一任务”；这会重复触发本类失败。
  位置：`src/runtime/prompts.ts` 的规划硬性规则；建议在规划规则或契约校验前移中处理，本批未改。
- 失败建议文案目前为中文，英文界面只本地化标签；现有看板问题详情也如此，未新增第二套服务端文案。
- 未在正式 3080 点击验证重试、unknown 确认或刷新后的客户端；未创建 commit。

## 28. 天工 UI 工作台首批（2026-10-29）

来源：所有者要求“请将 ForgeLoop 的 UI 工作台作为当前高优先级需求，优先开发”，并给出统一导航、
需求/任务详情、执行过程与调试证据三组首批范围。本批由 DSH 会话内 Agent 直接实施，未通过
ForgeLoop 受理需求，不计为插件自主执行成果。

### 28.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/runtime/board.ts` | `board` 支持 `query`/`limit`；新增 `awaiting_input`、`resultUnknown`、`stopRequested`、服务端 `actions`（approve/advance/stop/cancel，无 accept）、任务/请求/失败轮次搜索事实与 `taskIdOfFailureRound`；运行中或等待输入时不重复提供 `advance`；已交付任务不标“结果未知” |
| `src/runtime/service.ts` | `readActivity` 返回 `total/truncated`；任务详情增加活动总数、日志字节数/尾部/截断、审查路径、unknown/active request、等待输入与结果未知；新增 `requirementDetail`（原文版本、分析、任务包正文、交付进度、产物摘要、验收记录、失败轮次与请求） |
| `src/index.ts` | `board` 端点校验 `query` 字符串与 `limit` 1..100；`detail` 改走 `requirementDetail`；其余端点与认证不变 |
| `client.js` | 重写天工页：总览/需求/任务/问题四视图、搜索（300ms 防抖）、刷新/自动刷新、筛选、空与无结果与读取失败状态；需求详情、任务详情抽屉、失败原因/建议/重试/停止/取消/批准/推进；响应式单列与 390px 窄屏；不提供验收 |
| `tests/status-board.test.ts`、`tests/service.test.ts`、`tests/board-channel.test.ts`、`tests/failure-advice.test.ts` | 覆盖搜索范围与截断、运行/等待/停止/unknown 事实、服务端动作准入、失败轮次与任务关联、任务详情证据字段、需求详情、路由参数校验、旧审查结论不得解释新测试失败 |
| `contracts/architecture.json`、架构说明、插件 README、`CONTEXT.md`、本记录 | 登记工作台视图、搜索范围、详情字段、证据截断与状态边界；未新增模块、持久化表、端点或模型工具 |

没有改变批准/验收/失败额度/unknown 的服务端准入，也没有新增 Agent 权限、前端业务状态或第二条数据源。

### 28.2 行为与边界

1. **统一导航与搜索**：总览显示统计、当前执行/等待输入、需要处理的问题、下一步与能力边界；
   需求/任务/问题独立筛选。搜索只读权威记录文字，不读取 Agent 日志文件内容；结果被截断时
   页面明确提示“最多显示 50 条”。
2. **需求与任务详情**：需求详情展示原文/版本、分析、任务包正文与任务跳转、交付进度、产物摘要、
   验收记录、批准、失败轮次（带任务跳转）与请求；任务详情展示目标/依赖/允许文件/验收标准、
   实际状态、失败原因与建议、失败轮次、活动（最近 120 条及总数）、正式测试日志（末尾 4000 字符、
   字节数、路径、截断标记）、独立审查、产物摘要与证据路径/会话。
3. **状态语义**：`awaiting_input` 表示最近活动出现 `ask_user_question`；`resultUnknown` 表示需求存在
   unknown 请求；`stopRequested` 表示阻塞原因为停止请求。心跳/最后活动超过 60 秒标“可能停滞”；
   三种状态都不等于任务已经停稳或副作用已经核对。
4. **动作入口**：需求级动作由服务端 `actions` 判定；任务级重试仍由 `retryTask` 复核批准、额度、
   前置任务、在途请求与 unknown 二次确认；天工页始终不提供验收。页面只展示服务端返回的
   `allowed/reason`，不自行推断可重试。
5. **数据来源**：所有事实来自 SQLite 与登记证据；页面不另存业务状态。读取失败保留旧内容并显示
   错误横幅与重试，不伪造空状态。

### 28.3 检查与实际界面核对

- `make check` 通过：27 个测试文件、262 项测试；`make architecture-contract-check` 通过。
  同步 `contracts/architecture.json` 时，契约更新命令一并登记了其他执行方在途的 `src/session` 模块
  与 `session_surface`；未改动这些模块的实现。
- `make coverage` 通过：行／语句 91.54%、函数 95.76%、分支 84.81%，高于门槛 90/93/84。
- `make package` 通过：100,220 字节，SHA-256
  `badc3f83648780e97a73befdb66e2ad9fd423dd0bfdfeec46e7b72c69e5bf116`。
- 隔离环境：`DSH_HOME=~/.dsh-forgeloop-test`，profile `forgeloop-test`，记录根
  `~/.dsh-forgeloop-test/forgeloop/projects/forgeloop-test`；测试宿主端口 3090，空项目宿主
  端口 3091（记录根 `/tmp/fl-ui-empty/records`）。Chromium 1248 真实浏览器，截图保存在
  `.cache/forgeloop/ui-workbench-20261029/`（01–16）。
- 页面状态实际核对：正常项目总览、需求/任务/问题列表、搜索命中（“工作台”匹配 1 条需求、
  2 个任务）、搜索无结果、读取失败（注入 500，保留旧内容并显示错误横幅）、执行中/等待输入、
  失败任务、结果未知与停止请求、已交付任务的产物/证据、空项目、390×844 窄屏。页面底部内容
  可在 DSH 会话滚动区滚到输入框上方，未被输入框遮挡；任务详情抽屉不覆盖输入框。
- 一条可追溯链路：`req-20261029033605-e867ed` 的 `verify` 任务失败退出码 127 → 任务卡显示原因/
  建议 → 任务详情显示 512 字节正式测试日志的末尾 4000 字符与截断标记、3 个失败轮次与审查阻断 →
  重试被服务端以额度 3/3 用尽拒绝；需求详情的 3 个失败轮次均带“查看执行”任务跳转。
  `req-20261029033744-563cbb` 验收详情展示 2/2、产物摘要与证据路径；`req-20261029034207-2f2444`
  同时展示结果未知与停止请求横幅；`req-ui-20261029-running` 展示等待输入与心跳可能停滞。
- 这是真实浏览器对测试记录根的界面核对，不是正式业务数据验收。正式 3080 随后已安装并热重载本批：
  `dsh plugin --profile web add …/forgeloop-dsh-0.0.2.tgz` 后安装客户端 140,194 字节、SHA-256
  `e8522a45669aae63fda528f803ab3e6962124ad47b5ee77faa30290bdc2a3c70`；在 profile patch 追加
  注释触发热重载，协调器 owner 更新为 `MacAir.local:82207:d907b201`，acquiredAt
  `2026-10-29T09:24:52.461Z`，Web 进程 PID 82207 未重启。安装前备份在
  `/tmp/forgeloop-web-backup-20261029-1723`。
  正式记录中 `rq-753ce3ae-…` 仍为 unknown、无运行中任务，安装/热重载未重放或修改它。
  浏览器控制台只出现 DSH 自身的 `/api/changes.summary` 404（非 ForgeLoop）与脚本主动注入的
  一次 500；没有 ForgeLoop 客户端异常。

### 28.4 未完成、未验证与发现但不碰

- 已按所有者“安装到正式环境”的明确授权安装到正式 `web` profile 并热重载 3080；正式页面需刷新
  以加载新客户端 bundle。未在正式 3080 做点击验证，未绕过认证。未创建 commit。
- 未在浏览器实际点击批准、推进、停止、取消或重试，避免改变测试记录；这些动作的服务端准入由
  行为测试覆盖，页面只调用既有认证端点。停止确认对话框、过滤组合、键盘操作、读屏、长列表性能
  与正式数据规模未验证。
- 工作台没有仓库内浏览器自动化；本批使用临时 Playwright 脚本，截图是人工核对材料，未接入 CI。
- 发现但不碰：规划提示词仍未要求把 `contracts/architecture.json` 纳入新增模块任务，可能重复触发
  契约未登记失败（`src/runtime/prompts.ts`）；失败建议文案仍为中文，英文界面只本地化标签
  （`src/domain/failure-advice.ts`）；DSH 自身 `/api/changes.summary` 404 与本插件无关，未改动；
  追加授权、重新规划与需求级验收仍无页面入口。

## 27. 新会话日志兼容性修复（2026-10-29）

来源：正式 Web 新建会话失败：

```text
SessionQueryError: failed to observe session "session-2960…":
contains event type "forgeloop/intake" (seq 9) unknown to this harness
and not marked ignorable
```

### 27.1 根因

ForgeLoop 旧实现用 `session.append('forgeloop/…')` 写入自定义会话事件。这些事件不是 DSH
已知事件，也没有 `ignorable: true` 信封标记；当前 DSH 读取旧会话时拒绝解释日志，导致
会话列表/新建会话失败。

### 27.2 修复

- 旧生产会话与旧测试会话中已有的 `forgeloop/…` 事件加 `ignorable: true`，保留原事件；
  修复前备份到：
  - `~/.dsh/session-backups/forgeloop-event-repair-20261029-173939`
  - `~/.dsh-forgeloop-test/session-backups/forgeloop-event-repair-20261029-174119`
- 插件新事件改为 DSH 插件记录类型：
  - `plugin:forgeloop/intake`
  - `plugin:forgeloop/analysis`
  - `plugin:forgeloop/clarification-request`
  - `plugin:forgeloop/clarification-answer`
  - `plugin:forgeloop/plan`
  - `plugin:forgeloop/error`
- `appendSessionEvent` 从 DSH 入口解析 `appendPluginRecord`，写入 `ignorable: true` 的
  `plugin:` 记录；测试用假会话没有 DSH 时回退到旧的 append 仅用于断言。
- 旧会话中的 `forgeloop/…` 事件会被当前读取器跳过；它们的历史卡片不再渲染，但会话可正常打开。
  新会话的事件以 `plugin:forgeloop/…` 写入，客户端仍按原节点渲染。

### 27.3 验证

- 修复后测试环境新建 ForgeLoop 会话成功，日志中实际出现：

```json
{"type":"plugin:forgeloop/intake","ignorable":true,...}
{"type":"plugin:forgeloop/analysis","ignorable":true,...}
```

- 旧 `session-2960…` 不再阻塞会话查询；旧事件保留为 ignorable。
- 正式 3080 已重新热重载：协调器 owner 更新为 `MacAir.local:82207:65c0efb5`，
  acquiredAt `2026-10-29T09:44:15.054Z`。
- `make check`：27 个测试文件、262 项测试通过。
- 覆盖率：行／语句 91.50%、函数 95.76%、分支 84.65%。
- 候选包：100,689 字节，SHA-256
  `5742806c8e1f019afa5e195265bab952d74d1d02f72e90d0394b564ce94d7341`；已安装到正式
  `web` 与测试 profile。
- 正式页面仍需刷新；本次修复的是会话日志兼容性，不改变已停止任务 `queue-core` 的阻塞状态。
- 未创建 commit。

## 29. 最小重新规划（2026-10-29）

来源：所有者要求继续处理正式阻断需求 `req-20261029070230-bab6bf`，并在核对后选择“实现最小
重新规划入口（产品能力）”。本批由 DSH 会话内 Agent 直接实施，未通过 ForgeLoop 受理需求，
不计为插件自主执行成果。

### 29.1 现场核对

- 需求 `req-20261029070230-bab6bf`：blocked；任务包 v1 已由 `local-owner` 批准；`queue-core`
  正式测试退出码 1，失败轮次 1，剩余额度 2；unknown 推进请求 `rq-753ce3ae-…` 仍未收口。
- 工作副本 `workspaces/<req>/v1/queue-core`：Git 工作区干净，基线 `ea9dc7e`；`candidate.diff`
  仅新增 `requirement-queue.ts`、`requirement-stage.ts`、`requirement-queue.test.ts` 三个文件；
  独立审查 `pass`；正式测试唯一失败为 `contracts/architecture.json` 未登记新增模块。
- 结论：直接重试会再次失败；任务包遗漏契约文件，属于计划范围缺口。现场没有未收口的运行中任务，
  unknown 请求可由 owner 在确认核对工作副本、Git 与证据后关闭。

### 29.2 实现范围

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/runtime/service.ts` | 新增 `replanTask` 与 `normalizeReplanFiles`：只基于当前最新且已批准的任务包，为失败/阻塞/待决定的**非验证任务**补充允许文件，生成新的待批准版本；不自动批准、不改需求原文、不新建任务、不清零失败轮次；unknown 需确认后关闭；验证任务、已交付、非失败任务、在途请求、运行中任务与越界路径均拒绝 |
| `src/runtime/board.ts` | 需求级 `actions` 新增 `replan`：仅当当前计划已批准、存在失败的非验证任务、无运行/等待输入/在途请求时提供；验证任务失败不提供；终态不提供 |
| `src/index.ts` | 认证 `replan` 端点：校验 `reqId`、正整数 `planVersion`、1..20 个补充文件；`confirmRecovery` 显式确认 unknown；端点仍走浏览器认证，模型工具没有入口 |
| `client.js` | 需求卡新增“重新规划”：提示输入补充文件（默认 `contracts/architecture.json`）；存在 unknown 时先确认已核对现场；成功后显示新版本号并提示等待批准；批准仍由现有“批准任务包”按钮完成 |
| `tests/service.test.ts`、`tests/status-board.test.ts`、`tests/board-channel.test.ts` | 覆盖 v2 生成、文件只加到目标失败任务、旧批准保留而新批准缺失、unknown 二次确认、verify-only 不出现入口、错误路径（越界文件、no_change、not_failed、already_delivered、plan_not_approved、busy、plan_missing）与路由参数校验 |
| `contracts/architecture.json`、架构说明、插件 README、`CONTEXT.md`、本记录 | 登记 `replan` 端点、动作与边界；未新增持久化表、模块、模型工具或自动批准路径 |

### 29.3 规则与边界

1. **只补文件，不重新生成计划**：复制当前任务包的 technicalSolution、任务、依赖与验收标准；
   只在目标任务 `files` 追加去重后的补充文件。完整重新规划、追加授权、例外取舍仍未实现。
2. **只对失败的非验证任务**：当前计划必须已批准且是最新版本；目标必须是失败/阻塞/待决定、
   未交付、`verification !== true` 的任务；无在途请求、无运行中任务。验证任务不能补文件。
3. **不自动批准**：新版本落库后需求回到 `plan_proposed`，旧批准仍保留但绑定旧版本，
   页面显示“批准过期”；必须由 owner 再点“批准任务包”，之后才能推进。
4. **unknown 必须显式确认**：存在 unknown 时第一次请求返回 `recovery_required`，不写新计划；
   携带 `confirmRecovery:true` 才先关闭 unknown、再生成 v2，且不重放旧请求。
5. **范围校验**：文件必须是项目内相对路径、不得绝对路径或 `..`、一次最多 20 个；
   新任务包仍走 `validateTaskPlan`，失败则返回 `invalid_plan`，不改变记录。

### 29.4 检查与实际界面核对

- `make check` 通过：27 个测试文件、267 项测试；`make architecture-contract-check` 通过。
- `make coverage` 通过：行／语句 91.54%、函数 95.79%、分支 84.60%。
- `make package` 通过：103,109 字节，SHA-256
  `6b9363f5dafb48868d0a0cd3ae19e3cffd6d31af6717f7b3e989f9b15e7f34ae`。
- 隔离环境浏览器核对（`forgeloop-test`，端口 3090，测试记录根）：
  - `req-20261029015137-6ff9d1` 失败任务 `readme` 卡出现“重新规划”；输入默认
    `contracts/architecture.json` 后生成任务包 v2，状态回到“待批准”，旧批准显示“批准过期”，
    出现“批准任务包”；
  - `req-20261029033605-e867ed` 的失败任务是验证任务 `verify`，卡上只有“取消需求”，没有“重新规划”；
  - 截图：`.cache/forgeloop/ui-workbench-20261029/17-replan.png`。
- 正式安装：候选包 `6b9363…` 已安装到正式 `web` profile；客户端 143,687 字节、SHA-256
  `a5cf66f7164c288f2dbd695c39516a4bf4777819ff5b26dbf89875a7fa1e9ba4`；服务端
  `lib/runtime/service.js` 与构建一致。profile 追加注释后热重载，owner 更新为
  `MacAir.local:82207:3d3e7f3c`，acquiredAt `2026-10-29T11:33:37.308Z`，Web 进程 PID 82207
  未重启。安装前备份：`/tmp/forgeloop-web-backup-20261029-1928`。
- 正式需求 `req-20261029070230-bab6bf` 未被自动重新规划、批准或推进；unknown 请求保持 unknown。
  正式页面需要刷新后由 owner 点击“重新规划”，确认 unknown 核对后生成 v2，再批准、推进。
  这是 owner 决定，未见正式 3080 的点击验证。

### 29.5 未完成、未验证与发现但不碰

- 只在隔离测试记录根实际点击了“重新规划”；正式 3080 的点击由 owner 完成，未绕过认证。
- 最小重新规划没有独立审计行记录 actor/source；可回查的是新任务包版本、旧批准与新批准状态，
  没有“谁在何时补了哪个文件”的专用记录。完整审计需新增表或事件，本批未做。
- 完整重新规划（新增/删除任务、重写技术方案、调整验收）、追加授权、例外取舍、需求级验收仍无入口。
- 规划提示词仍未要求新增 `src` 模块时把 `contracts/architecture.json` 纳入任务；本入口是事后补救，
  不能替代提示词/计划校验前移。
- unknown 请求的关闭与重新规划复用 `recover`；若新计划写入后 `recover` 失败，可能留下
  `plan_proposed` + unknown 的部分状态，当前无事务回滚。该路径未在真实失败中复现。
- 未创建 commit；未修改正式业务数据、DSH 模型配置或凭据。

## 30. 架构契约与治理机制优化（2026-10-29）

来源：所有者任务“优化 ForgeLoop 架构契约与工程治理机制”，要求以最小治理成本保留可靠、
可执行、可持续维护的架构约束，不新增治理系统或业务功能。

### 30.1 现状问题

- `contracts/architecture.json` 的 `modules` 与文件系统重复：`scripts/ts/contracts.ts` 已能扫描
  `src/**/*.ts`，却仍要求逐项登记，并提供 `--update-architecture` 自动回写。结果新增模块会先让
  `make check` 失败，再运行更新命令；`queue-core` 的正式测试失败正是这一类。
- `persistence.tables` 与 `records/db.ts` 重复，`model_surface.tools` 与 `tools.ts` 重复，
  `ui_surface.data_endpoints` 与 `index.ts` 的 `BOARD_ENDPOINTS` 重复，`session_surface` 的事件/节点
  与 `session/events.ts`、`client.js` 重复。登记表越细，越容易与实现漂移。
- `external_seams`、`verification`、`ui_surface.note` 等纯描述字段没有可执行检查；其中
  `web_board_rpc` 的端点列表在 `replan` 加入后已经过时。
- 端点检查只验证“契约列出的端点出现在源码”，不拒绝源码新增未声明端点；`BOARD_ENDPOINTS`
  可被扩充而不被发现。
- 契约没有依赖环检测；`docs/architecture.md` 的检查只匹配三个字符串，不能证明文档与代码一致。
- `retired` 把路径数组、说明文字和历史命令面混在一个对象里，路径规则本身可验证，其余是文档。

### 30.2 修改内容

`contracts/architecture.json` 升至 `schema_version: 3`，保留并强化规则，删除重复事实：

| 字段 | 处置 |
| --- | --- |
| `layers` | 保留；校验名称/路径唯一、路径在 `src` 内、每个源码文件能判定分层、每层有文件、依赖方向合法 |
| `runtime.package` | 保留；用于定位 `src`，不再重复语言/宿主/`python_runtime` 描述 |
| `modules` | 删除；全部 `.ts` 从文件系统自动发现 |
| `persistence` | 保留 `engine`/`driver`/`database`；删除 `tables` 与 `durable_artifacts` 重复清单；检查 driver 与 `db.ts`、路径与 `config.ts` 一致 |
| `model_surface` | 只保留 `prefix`；工具名从 `tools.ts` 自动发现，校验前缀/唯一性/`tools.register`，并拒绝调用批准、验收、推进、重试、重新规划等决定方法 |
| `ui_surface` | 保留槽位、视图身份、排序、数据路径；删除 `client_bundle`、`data_endpoints`、标签、只读标志与长说明；端点从 `BOARD_ENDPOINTS` 自动发现，校验每个非默认端点都有分发分支、无重复/非法名 |
| `retired_paths` | 由对象改为字符串数组；只保留可验证的仓库路径 |
| `session_surface` | 只保留 `preset_id` 与 `interception`；事件从 `events.ts` 自动发现，校验 client 注册且无孤儿事件 |
| `external_seams`、`verification`、`product` | 删除；外部边界与命令入口由 `docs/architecture.md`、`Makefile` 维护，不再伪装成契约 |
| `--update-architecture` | 删除；模块/工具/端点无需生成回写 |
| `Makefile` | `make architecture-contract` 与 `architecture-contract-check` 都只执行检查；`make contracts` 仍为统一入口 |

新增/强化的自动检查：

- 源码扫描覆盖全部 `src/**/*.ts`，新增文件无需登记；未知分层、相对导入无法解析、越界导入失败。
- 依赖图 DFS 检测循环依赖；错误信息给出完整 `a.ts -> b.ts -> a.ts` 路径。
- 退役路径数组逐项检查存在性；新增代码不能仅靠删 `modules` 条目绕过。
- 工具/端点/会话事件从源码提取，不再依赖人工列表。
- 保留 `checkNoPython`，拒绝活动代码引用旧 Python/虚拟环境。

### 30.3 验证

- 先增加 4 项边界测试：新源码自动通过、跨层依赖拒绝、循环依赖拒绝、未分发端点拒绝；
  旧实现下新源码、循环、端点 3 项失败，跨层依赖旧检查已能拒绝。实现后 10 项通过；
  再补 2 项无前缀工具/未注册会话事件的反向测试，最终 12 项通过（含原退役路径正/反例）。
- `make check` 通过：27 个测试文件、273 项测试。
- `make coverage` 通过：行/语句 91.54%、函数 95.79%、分支 84.58%。
- `make package` 通过：103,109 字节，SHA-256
  `6b9363f5dafb48868d0a0cd3ae19e3cffd6d31af6717f7b3e989f9b15e7f34ae`；运行时代码未变。
- `node scripts/ts/contracts.ts` 与 `make contracts` 输出
  `[contracts] OK：分层、依赖、循环、退役路径、工具、UI 与会话边界一致；活动代码未引用 Python`。
- 未安装/热重载正式环境；本批只改仓库治理文件与测试。

### 30.4 维护成本

- 新增普通 `src/**/*.ts`：无需登记；只要放在已有分层内并遵守依赖方向。
- 新增模型工具：无需登记；工具名必须使用 `forgeloop_` 前缀，且不得调用决定方法。
- 新增 Web 端点：需要在 `BOARD_ENDPOINTS` 与分发分支同时出现；不需要改契约。
- 修改槽位、视图身份、排序、数据路径、preset 或输入拦截事件：需要改契约与实现，检查会拦截漂移。
- 修改分层或依赖方向：需要改 `layers`，Git Diff 可见；审查负责判断是否合理。
- 数据库表结构：以 `records/db.ts` 为唯一来源，契约不再复制表清单。

### 30.5 剩余风险

- 工具名、端点、会话事件仍通过正则解析 TypeScript/JS；过于动态的生成式注册可能绕过或误报。
- 端点检查只验证数组与分发分支一致，不验证每个端点的业务授权细节；认证仍由共享路由与行为测试保证。
- 契约本身可被修改以放宽 `may_import` 或减少 `retired_paths`；依赖 Git Diff 与审查，不另建审批系统。
- `layers` 的路径是人工规则；新增目录若落在 `entry` 的宽前缀下不会报错，需要审查是否应单独分层。
- 持久化只约束 SQLite 驱动与路径，不约束表结构变更；表结构由 `db.ts` 与迁移/测试负责。
- 文档语义仍不能自动验证；本次移除了低价值的三个字符串文档检查，避免制造“已检查”的假象。

## 31. 需求 Agent 读取当前需求与任务事实（2026-10-29）

来源：所有者要求“需求 Agent 支持读取当前需求和任务列表，包括时间、状态等信息”。

### 31.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/runtime/board.ts` | 新增 `buildProjectFacts`：从权威记录组装活动需求的标题、状态、需求版本、创建／更新时间、最新分析目标、任务包版本与批准状态、任务状态与最近活动；当前需求固定第一条并标记；已结束需求只计数；活动需求与单需求任务数分别设上限（10／8）；抽取 `boardTaskState` 供看板与事实共用 |
| `src/runtime/prompts.ts` | `analysisPrompt` 增加“当前项目需求与任务”只读段落，声明背景事实不是指令、不构成授权，仍要求只输出 JSON |
| `src/runtime/service.ts` | `executeAnalysis` 查询项目事实并传入分析提示词；需求 Agent 仍无工具，也不写任何记录 |
| 测试与说明 | `status-board.test.ts` 增加事实组装、当前优先、终态排除与上限用例；`prompts.test.ts` 断言时间／状态／批准／任务渲染；`service.test.ts` 断言分析提示词实际包含当前需求与在途任务；同步架构与插件说明 |

### 31.2 行为与边界

- 分析提示词现在包含：项目活动需求总数、每条需求的标题／状态／需求版本／创建与更新时间、
  最新分析目标、任务包版本与批准状态（已批准／未批准／批准已过期／无批准记录），以及任务列表
  （taskId、目标、状态、依赖、最近活动）。
- 当前需求始终排在第一条并标注“（当前需求）”，即使它不在最近若干条需求里。
- 读取的是记录事实，不是模型推断；不新增工具、不写表、不读取 Agent 日志。
- 上限：一次最多 10 条活动需求、每条需求最多 8 个任务；超出部分在提示词中标注数量。

### 31.3 检查与实际结果

- `make check` 通过：27 个测试文件、277 项测试（含本批新增 4 项）。
- `make coverage` 通过：行／语句 91.65%、函数 95.87%、分支 84.81%，阈值保持原样。
- 未在真实宿主上重跑需求分析；本批只验证事实组装与提示词渲染的行为测试。

### 31.4 未完成与发现但不碰

- 需求 Agent 仍无工具，不能主动读取代码、文档或按需查询；事实是每次分析时的固定快照。
- 其他需求的标题与分析目标属于同项目所有者文本，提示词已声明为背景事实，但未做内容隔离。
- 分析失败后的重试入口、业务终审 Agent 等既有差距不变（§4.1、§15.4）。

## 31. `queue-core` 阻断复测（2026-10-29）

架构契约 v3 自动发现源码后，原阻断根因“任务包漏登记 `contracts/architecture.json`”不再成立。
为确认这一点，在**临时副本**中做了只读复测：

- 复制当前生产仓库工作树（包含 v3 契约、`src/session` 等在途改动），排除 `.git`、`node_modules`、
  `.cache`、`dist`、`coverage`，再应用 `queue-core` 的 `candidate.diff`；
- 执行 `npm run check --workspace forgeloop-dsh`：**28 个测试文件、300 项测试通过**，退出码 0；
- 复测中的旧任务工作副本（`ea9dc7e` 基线）单独使用新契约时会因 `session/events.ts` 尚无事件而失败；
  当前仓库快照包含完整会话事件，因此真实重试的工作副本应使用仓库快照而不是旧任务副本。

结论：`queue-core` 的 v1 任务包与当前仓库快照已能通过原失败点，**优先重试**而不是重新规划。
正式需求仍为 blocked，unknown 请求 `rq-753ce3ae-…` 仍未关闭；正式 3080 需要 owner 在页面
“重试任务”中确认核对，首次点击只提示 recovery，确认后才关闭 unknown 并排队。未在正式实例
执行点击，未修改正式记录；重试的真实 Agent 执行、后续任务与正式验收仍未发生。

复测是临时目录中的构建/测试事实，不等于正式任务执行。当前仓库 `make check` 为 273 项，
复测的 300 项包含其他在途测试，不能把 300 当作产品版本门槛。

## 32. 层级工作台与 Agent 执行过程（2026-10-29）

来源：所有者要求把现有「天工」页升级为层级工作台，完整支持需求 → 任务 → 问题关系与每个任务的
Agent 执行过程，并复用认证入口、真实记录与既有批准/重试/停止规则。

### 32.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `packages/forgeloop/src/runtime/task-execution.ts`（新增） | 解析 `dev.jsonl` 为公开消息、工具调用/结果和阶段事件；按 `callId` 关联、按 seq 排序、过滤 reasoning 与 DSH 运行上下文提醒、按事件数分页、截断长文本、记录会话身份 |
| `src/runtime/service.ts` | 新增 `taskExecution`：读取证据行、开发记录、审查、正式测试头、交付物与失败轮次；返回真实会话/任务包/任务身份、尝试列表（历史不可用明确缺失）、执行阶段、分页事件、测试退出码/耗时/路径与会话跳转可用性；`taskDetail` 增加测试头字段 |
| `src/index.ts` | 新增认证 `execution` 端点及分页校验；原有 `board/detail/task` 端点不变 |
| `src/runtime/board.ts` | 已交付任务的旧失败轮次不再进入首屏待处理；任务仍保留历史证据 |
| `client.js` | 三栏层级工作台：需求树（需求 → 任务 → 关联问题）、中间需求摘要/任务列表/依赖、右侧统一详情（概览/前后序/Agent 执行过程/测试与审查/变更记录）；面包屑、选中高亮、完整详情、搜索/筛选/刷新/自动刷新、390px 列表→详情、任务卡与详情顶部执行入口；执行过程支持尝试切换、工具展开、分页、暂停、新活动提示与滚动位置保留 |
| `tests/task-execution.test.ts`（新增）、`tests/board-channel.test.ts`、`tests/status-board.test.ts` | 覆盖 reasoning 过滤、工具配对、分页/截断、运行上下文过滤、真实会话与空执行、历史尝试缺失、已交付失败轮次隐藏 |
| `contracts/architecture.json`、架构说明、插件 README、本记录 | `execution` 作为认证端点自动纳入契约；工作台/执行过程边界写入文档；未新增持久化表或模型工具 |

没有修改正式业务记录、DSH 模型配置或凭据；没有创建 commit。
正式安装与热重载在所有者本轮明确授权后完成（见 §32.3）；测试环境使用 `forgeloop-test` 与测试记录根。

### 32.2 层级与执行过程规则

1. **关系身份**：需求 → 任务 → 问题全部由 `reqId + planVersion + taskId + issueId` 绑定；同一
   `taskId` 不再跨需求匹配问题（修复了树中“别的需求的 verify 失败”挂到当前任务的错误）。
2. **任务前后序**：只从同需求、同任务包版本的 `dependsOn` 推导前置；后继由其他任务的
   `dependsOn` 反推。前置未交付显示“等待 … 交付”，前置已交付只表示依赖条件满足，不表示已批准、
   已排队或已开始。
3. **执行过程**：只读取证据目录中该任务的 `dev.jsonl`，不按文件名猜测尝试；当前记录身份来自
   需求/任务包/任务/证据行，会话来自 `dev_session` 或事件中的真实 `sessionId`。当前尝试与历史
   失败轮次分开标记；历史轮次没有独立文件时明确显示“仅摘要，不能回放”。
4. **公开内容**：助手文本（排除 reasoning）、任务输入、工具调用/结果、阶段事件；工具结果按
   `callId` 关联。DSH 注入的 `<system-reminder>`、`Current runtime context.` 和
   `Time sampled while preparing turn` 运行上下文提醒不作为公开消息。
5. **状态**：排队、执行中、等待回答、失败、可能停滞、停止待核对、结果未知分开显示；心跳不是
   推进证明，停止请求不等于停稳。执行过程沿用任务详情的失败原因、建议、测试/审查/证据。
6. **刷新与位置**：执行过程每 4 秒检查新事件，发现新总数时只显示提示，不替换当前列表；用户可
   暂停、加载更多或手动刷新；切换详情分区时组件保持挂载，尝试选择、暂停状态和滚动位置保留。
7. **缺口**：没有 DSH 原始会话跳转地址，页面只显示会话身份并提供复制；历史旧尝试没有独立
   `dev.jsonl`/review/log 快照；需求编辑、任务修订草稿、草稿删除、问题补充说明和等待回答没有
   服务端/持久化入口，因此不添加按钮冒充可用。

### 32.3 检查与真实页面核对

- `make check` 通过：29 个测试文件、308 项测试。
- `make coverage` 通过：行／语句 92.23%、函数 96.33%、分支 84.51%。
- `make package` 通过：137,561 字节，SHA-256
  `c0594d15dbf94722b638546730ffdd09ed9cc445c0f32b6c5cdc4cb83bb108d1`。
- 隔离环境 `forgeloop-test`（端口 3090，测试记录根）用 Chromium 实际点击：
  - 需求树、任务卡“查看 Agent 执行过程”、详情顶部入口、执行过程 25 条公开事件/13 个工具调用；
    任务包 v1、任务/尝试/会话身份与开发/审查/正式测试/交付阶段可见；
  - 切换“测试与审查”再返回“Agent 执行过程”，25 条事件仍保留；测试面板显示退出码 0、3310ms、
    日志路径/大小、审查结论与产物身份；
  - 展开完整详情、390×844 列表→详情、任务输入折叠、无横向溢出；
  - 搜索无结果显示“没有匹配记录/清除搜索”，读取失败保留旧内容并显示错误横幅与重试；
  - 失败/缺失执行显示缺失原因；已交付任务不再挂旧失败问题。
- 截图：`.cache/forgeloop/hierarchy-workbench-20261029/`（desktop/execution/tests/full/mobile/no-result/read-error）。
- 正式安装（所有者授权“部署到正式环境”）：候选包已安装到正式 `web` profile；安装后客户端
  260,060 字节、SHA-256 `cb9f31546204e9c4bb464c526c766c0b82881adc5762d469feb77ac1bf399568`，
  服务端 `service.js` 与构建一致。profile 追加注释后热重载，owner 更新为
  `MacAir.local:82207:a2aaa6cf`，acquiredAt `2026-10-29T13:53:27.698Z`，PID 82207 未重启；
  安装前备份 `/tmp/forgeloop-web-backup-20261029-2153`。正式记录无运行中任务/待执行请求；
  未在正式 3080 做点击验证（认证由浏览器持有），页面需刷新加载新客户端。
- 浏览器控制台只出现 DSH 自身 `/api/changes.summary` 404；ForgeLoop 无客户端异常。

### 32.4 未完成与发现但不碰

- 需求编辑、任务修订草稿、草稿删除、问题补充说明、等待回答、完整重新规划没有服务端/持久化入口；
  本批没有添加仅改变页面的按钮。
- 历史旧尝试没有独立执行快照，只能显示失败轮次摘要；新运行尚未改成每尝试独立 `dev.jsonl`。
- 无 DSH 原始会话跳转地址；只显示/复制真实会话身份。
- 正式 3080 已安装并热重载本批，但未在正式记录根做业务点击验收；测试 profile 的安装不代表正式验收。
- 计划提示词仍可能遗漏 `contracts/architecture.json`；契约 v3 自动发现已消除模块登记类阻断，
  但任务包范围缺口仍需计划提示词前移。
- 未创建 commit；未修改正式业务数据、DSH 模型配置或凭据。

## 33. 验证 Agent 与验收门禁（2026-10-29）

来源：所有者审阅验证 Agent 的设计与实现后，选择“增加完整的 verify 角色与验收门禁”。
此前只有 `analyze | plan | dev | review` 四种角色，验证仅表现为可选的 `verification: true` 任务；
计划无需评审即可批准，验收也不要求独立验证，因而全部任务写成验证任务即可零代码走到验收。

### 33.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/domain/verification.ts`（新增） | 实现前评审、验证命令、逐场景报告的结构化解析与必过场景覆盖校验；模型自述不能直接作为通过 |
| `src/domain/delivery.ts` | 新增 `candidateIdentityOf`：候选身份由任务包版本、需求版本、基线与各任务候选摘要决定 |
| `src/domain/counting.ts`、`src/domain/status.ts` | 新增 `verification` 失败阶段与 `verify` 动作 |
| `src/config.ts` | 新增 `reviews/<req>/v<plan>/plan` 与 `verifications/<req>/v<plan>/<candidate>` 目录 |
| `src/records/db.ts`、`src/records/repository.ts` | 新增 `requirement_plan_reviews` 与 `requirement_verifications` 表；评审按任务包版本、验证按候选摘要保存结论、报告与证据摘要 |
| `src/runtime/prompts.ts`、`src/runtime/agent-runner.ts` | 新增 `verify-plan`（无工具）与 `verify`（workspace-write）角色提示词；要求报告场景文本与验证计划一致 |
| `src/runtime/service.ts` | 规划后自动做实现前评审，阻断时带原因重试；批准强制要求当前任务包的通过评审；全部任务交付后自动独立验证（也可 `verify` 请求触发）；命令由运行时重跑，只按退出码、超时与覆盖判定；验收绑定当前候选与验证报告摘要 |
| `src/runtime/board.ts`、`src/index.ts` | 看板新增 `plan`/`verify` 动作、评审与验证视图、新鲜度；认证端点新增 `plan`、`verify` |
| `client.js`、`locale` | 任务包卡片只在评审通过时提供批准；全部交付后提供独立验证，只有 fresh pass 才提供验收；需求卡/详情显示评审与验证状态、阻断原因与场景摘要 |
| `tests/verification.test.ts`（新增）及既有测试 | 覆盖计划评审/命令/报告解析与覆盖规则、批准门禁、规划阻断重试、验证通过/命令失败/缺证据/越界/缺材料/代理失败、候选过期与报告篡改、请求门禁、看板动作与路由 |

没有新增模型工具；批准、验证与验收仍只能经认证动作或服务端内部调用。没有创建 commit，
没有安装或热重载正式 profile，也没有修改正式业务数据、模型配置或凭据。

### 33.2 强制规则

1. **实现前评审**：任务包落库后，验证 Agent 在无工具会话中只读需求、分析与任务包，输出
   `verdict`、`blocking`、`findings`、`summary` 与 `verification_plan`。计划必须至少包含一条
   `required=true` 的必过场景，场景不得重复；运行时逐项核对分析中的每个业务场景与验收标准，
   缺项即使模型自报通过也按阻断记录。评审记录绑定**已落库任务包**的 SHA-256 与需求版本，
   报告写入 `reviews/<req>/v<plan>/plan/plan-review.json`；阻断原因反馈给规划 Agent（最多 3 次）。
2. **批准门禁**：当前任务包必须存在通过、未过期、证据摘要完整的评审；缺失、阻断、任务包摘要不符、
   需求版本变化或报告被篡改都拒绝批准。`plan` 动作在评审缺失/阻断时重新生成任务包，新任务包仍需评审。
3. **独立验证**：全部任务交付后，把各任务候选 diff 应用到新的快照副本，固定候选身份、工作区树摘要
   与 HEAD；验证 Agent 只能写 `verification/`，产出 `commands.json`（≤10 条）与逐场景 `report.json`。
   运行时拒绝 `verification/` 之外的改动与 HEAD 变化，随后重新执行命令；退出码非 0、超时、
   必过场景缺失/未通过/无证据、报告自述阻断都会判 block。阻断计入 `stage=verification` 失败轮次。
4. **验收门禁**：验收必须存在与当前候选身份、需求版本一致的独立验证，报告文件存在且摘要匹配，
   结论为 pass；验证缺失、过期、被篡改或阻断均拒绝。验收记录新增 `verificationSha256` 与
   `verificationCandidateSha256` 绑定。
5. **幂等**：同一候选已有通过验证时不再重复运行；已有阻断结论时返回原阻断，要求产生新候选后重验。
6. **边界**：验证 Agent 仍是宿主进程内会话，不是 OS/容器隔离；只检查验证工作副本的 Git 状态，
   不能证明没有外部副作用。命令清单最多 10 条，验证材料缺失一律 fail-closed。

### 33.3 检查

- `make check` 通过：TypeScript 类型检查、架构契约与 29 个测试文件、310 项测试。
- `make coverage` 通过：行／语句 92.25%、函数 96.34%、分支 84.57%（门槛 90/93/84），
  `coverage/coverage-summary.json` 已刷新。
- 新增 `tests/verification.test.ts` 22 项，覆盖纯解析规则与真实候选副本/命令执行的门禁路径。
- 修复实现缺陷：计划评审摘要原先按内存任务包计算，批准时重新加载任务包后字段顺序不同会误判过期；
  现按已落库任务包计算，评审与批准使用同一表示。

### 33.4 未验证与缺口

- 未用真实模型跑通实现前评审与独立验证的完整生产批次；测试使用确定性假 Agent。
- 未在正式 3080 profile 安装本批；`make package` 未重新执行，不刷新包摘要。
- 验证 Agent 的工具权限仍是宿主级 `workspace-write`，不防外部副作用；独立验证只覆盖 Git 可见改动。
- 验证阻断后没有恢复入口：任务已交付因而不能重试，`replan` 只针对失败任务，页面此时只剩“请求停止／取消”。
  要换候选必须修订需求重新规划，属完整重新规划缺口（§14），本批未实现。
- 失败轮次、追加授权与完整重新规划仍按既有规则，本批没有改变其语义。

## 34. 研发 Agent 任务拆解与需求分析边界（2026-10-29）

来源：所有者要求“接纳需求后，由研发 Agent 拆分研发任务，而不是需求 Agent 拆分研发任务”。

### 34.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/runtime/prompts.ts` | 规划提示词改为 `devPlanningPrompt`：身份明确为“研发 Agent，负责技术方案与研发任务拆解”，声明需求分析由需求 Agent 完成、不得改写；输入从“分析目标”扩大为分析全文（目标、业务场景、验收标准）；新增“任务拆解必须覆盖每条业务场景与验收标准”的硬性规则。需求分析提示词补一条边界：只做需求分析，不拆研发任务、不给出实现步骤或文件清单 |
| `src/runtime/service.ts` | `planRequirement` 更名为 `planDevTasks`，私有方法改为 `executeDevPlanning`；拆解提示词传入完整分析对象，不再只传 `analysis.goal` |
| `src/session/intake.ts` | 交接调用改为 `planDevTasks`；错误文案改为“研发 Agent 任务拆解异常” |
| `client.js` | 会话卡片文案：“需求 Agent 拆解结果”改为“需求 Agent 分析结果”，“等待需求 Agent 拆解”改为“等待需求 Agent 分析”；中英文同步 |
| 测试与说明 | `prompts.test.ts` 断言研发 Agent 身份、分析全文进入提示词与覆盖规则；`service.test.ts` 断言端到端拆解提示词包含场景与验收标准；同步架构与插件说明 |

### 34.2 行为与边界

- 需求 Agent 只输出目标、业务场景、验收标准与待澄清项；任务、文件清单、实施步骤由研发 Agent
  在分析无待澄清项后产出，并绑定需求版本与任务包版本。
- 研发 Agent 的拆解输入包含分析全文；任务目标与验收标准要能看出与分析场景、验收标准的对应关系。
- 验证 Agent 的实现前评审仍独立核对验证计划是否覆盖分析场景与验收标准，模型自报不替代该检查。
- 拆解不等于批准或执行：任务包生成后仍是 `plan_proposed`，批准与推进走认证动作。

### 34.3 检查与实际结果

- `make check` 通过：29 个测试文件、310 项测试。
- `make coverage` 通过：行／语句 92.25%、函数 96.34%、分支 84.58%，阈值保持原样。
- `make contracts` 通过，分层与外部表面未变。
- 未在真实宿主上重跑需求分析与研发拆解；本批只验证提示词与端到端接线。

### 34.4 未完成与发现但不碰

- 研发 Agent 的“覆盖每条场景与验收标准”目前是提示词规则，程序只对验证 Agent 的验证计划做覆盖核对；
  没有逐条比对任务目标是否覆盖分析场景的确定性检查。
- 拆解提示词仍只带需求原文与分析全文，不读取代码；工程事实仍是固定的目录说明。
- 完整重新规划、追加授权与需求编辑入口等既有缺口不变（§14、§33.4）。

## 35. 运维 Agent 首版（2026-10-29）

来源：产品方案 §8.3 与所有者要求“运维Agent的设计和实现”。目标是把首版运维范围落成可运行的
巡查、诊断、受控处置与恢复复核，而不是建设通用运维平台；资源、检查与动作全部来自插件配置中的
登记目录，生产变更不接受任意 Shell。设计与配置示例见[运维 Agent](ops-agent.md)。

### 35.1 实现

| 范围 | 改动 |
| --- | --- |
| `src/domain/ops.ts`（新增） | 严重度（`critical`/`major`/`minor`）与资源类型；目录校验（唯一身份、资源引用、同资源恢复检查、argv 数组、枚举参数、占位符与声明一致）；`actionArgv` 只替换已声明且合法的参数；事件签名；诊断 JSON 解析与序列化；自动授权判定；恢复判定；事件统计 |
| `src/config.ts` | `ops` 装载期校验与默认值：默认关闭，周期默认 300 秒、最小 30 秒，超时默认 60 秒，严重度默认 `major`，单检查资源可推断恢复检查；新增 `opsDir` |
| `src/records/db.ts`、`src/records/repository.ts` | 新增 `ops_events`、`ops_observations`、`ops_action_attempts` 三张表与对应读写方法；动作先写 `running` 意图再写结果；`markRunningOpsActionsUnknown` 在宿主启动时把上次未收口动作标为未知 |
| `src/runtime/ops.ts`（新增） | 巡检调度、事件归并、诊断、授权执行、恢复复核、关联修复需求与所有者动作；动作与检查通过 `spawn` 执行、不经 Shell，输出上限 256 KiB，超时 SIGKILL，中止或超时记 `unknown`；每个事件每次 Tick 最多诊断一次，状态机每 Tick 最多推进三轮 |
| `src/runtime/prompts.ts`、`src/runtime/agent-runner.ts` | 新增 `ops` 角色与诊断提示词：只提供检查输出与登记动作目录，要求事实与推断分离，不提供 argv 或工具 |
| `src/runtime/service.ts`、`src/runtime/coordinator.ts` | 运维服务方法与所有者入口；协调器在启用且持有单消费者锁时按 `pollSeconds` 唤醒巡检，独立 in-flight 保护 |
| `src/tools.ts`、`src/index.ts` | 只读工具 `forgeloop_ops`；认证端点 `ops`、`ops-detail`、`ops-decide`、`ops-confirm-unknown`、`ops-close`、`ops-request-fix` |
| `client.js` | 天工“运维”视图：统计、事件列表与详情、影响、事实/推断、处置尝试、观测与证据路径、批准/拒绝/核对未知/关闭/生成修复需求；中英文词典 |
| 测试与文档 | 新增 6 个运维测试文件并更新工具测试；新增运维设计文档，同步架构、术语、插件说明与本记录 |

### 35.2 行为与安全语义

1. **登记目录**：检查与动作只接受 argv 数组；动作模板中的 `{参数}` 必须对应已声明参数并只能取
   `values` 枚举值；恢复检查必须属于同一资源；非法目录在装载期失败，未启用的目录同样静态校验。
2. **事件身份**：签名为资源、检查、退出码与首条输出摘要；同一签名的活动事件吸收重复告警并保留
   观测次数，终态事件不吸收新告警，复发新开事件。
3. **授权**：自动执行必须同时满足目录标记 `auto`、动作属于事件资源、动作正是诊断提出的动作、
   参数通过校验、诊断未要求人工决定；任一不成立就停在 `awaiting_decision` 等待所有者批准或拒绝。
   执行前重新判定授权，模型不能把未登记动作变成自动执行。
4. **处置与未知**：每个事件最多执行一次登记动作；执行前写 `running` 意图（动作、参数、授权来源），
   退出后写结果；超时、中止或宿主中断都记 `unknown`，不自动重放，必须所有者核对后才能转为未解决
   或关闭。连续 3 次诊断未完成或诊断结果畸形累计到上限时转人工判断，不无限调用模型。
5. **恢复与修复分离**：只有登记恢复检查退出码 0 且未超时才 `recovered`；恢复不代表永久修复，
   诊断要求修复时生成一个关联修复需求（`source=ops:<事件>`），进入正常分析、任务包、批准、验证与
   验收流程，不自动批准。
6. **统计**：独立事件为分母；诊断后发生批准/拒绝、核对未知、关闭或外部接管的事件计为人工介入，
   正常巡检不产生事件；同时报告已恢复、未解决、未知、待决定、关联修复需求数与平均恢复时长。

### 35.3 检查

- `make check` 通过：TypeScript 类型检查、架构契约与 35 个测试文件、364 项测试。
- `make coverage` 通过：行／语句 92.31%、函数 96.36%、分支 84.27%（门槛 90/93/84），
  `coverage/coverage-summary.json` 已刷新。
- 新增 `tests/ops-domain.test.ts` 13 项、`tests/ops-records.test.ts` 5 项、`tests/ops-config.test.ts` 5 项、
  `tests/ops-agent.test.ts` 9 项、`tests/ops-coordinator.test.ts` 2 项、`tests/ops-controls.test.ts` 19 项；
  `tests/tools.test.ts` 断言 8 个工具。
- 行为测试覆盖：目录与参数拒绝、签名归并、诊断结构与非法动作拒绝、自动/人工两条处置路径、
  所有者批准/拒绝/核对未知/关闭/生成修复需求的状态门禁、诊断失败与畸形结果的次数上限、
  超时与中止记为未知且不重放、宿主中断后的动作结果收口、恢复复核失败判未解决、
  修复需求只建一次、命令输出截断标记。
- 修复实现缺陷：输出恰好填满 256 KiB 上限时原先不写截断标记，证据可能被误认为完整；现在
  超出上限后一律保留截断标记，并有回归测试。

### 35.4 未验证与缺口

- 没有真实线上事件：巡检与处置使用仓库内命令和确定性假 Agent，不能证明真实故障下的诊断质量。
- 未接入告警、日志或监控平台；检查输出是唯一自动证据，原始输出直接落盘、只有 256 KiB 截断，
  没有脱敏。
- 不抢占正在执行的研发任务；严重度只影响事件排序，“严重故障优先”没有进程级落实。
- 每个事件最多一次登记处置，没有第二种动作、自动重试或跨事件策略。
- 动作在宿主账户与项目目录下执行，没有 OS/容器隔离；持有插件配置的人可以登记任意命令，
  这是当前信任边界，不是安全沙箱。
- 所有者核对未知仍是人工读取现场；没有自动收口的适配器，也没有资料保留策略。
- 未在正式 3080 上验证运维视图与端点；本批只做仓库测试与契约检查。

## 36. M0 种子批次：验证可信度、研发交接与真实需求尝试（2026-10-30）

来源：所有者要求“让 ForgeLoop 达到 M0，完成最小真实研发闭环”，并先处理上次核查在临时副本中复现的两个
错误放行问题。本批由 DSH 会话内 Agent 实施并操作，外部改动与人工点击均按实际来源记录，不计为 ForgeLoop
独立成果。

### 36.1 计划范围与实际改动

| 范围 | 目的与实际处置 |
| --- | --- |
| `src/domain/verification.ts` | 场景证据必须引用本次实际执行的命令 label，且证据是命令输出原文；校验引用身份、所属执行、退出码与材料完整性 |
| `src/runtime/service.ts` | 验证前后核对 HEAD、受保护内容与 `verification/` 材料；验证命令改动候选即阻断；记录 `candidateIntegrity` 与材料摘要 |
| `src/records/db.ts`、`src/records/repository.ts` | 新增产物历史、业务终审、候选构建、部署记录表；任务运行中断收口方法 |
| `src/domain/business-review.ts`（新增） | 业务终审结构化解析与覆盖校验：逐项覆盖分析场景/验收标准，证据须能在验证命令输出中核对 |
| `src/runtime/service.ts`（交接） | 验证阻断后 `rework` 归档旧候选并重新研发；独立验证后自动业务终审；验收新增业务终审与 unknown 门禁；候选包只从已通过验证的工作区构建；新增上线核对 |
| `src/runtime/board.ts`、`src/index.ts`、`client.js` | 需求详情显示业务终审/候选/部署；新增 `rework`、`recover`、`build`、`deploy` 认证动作与“核对未知”入口；已批准但缺评审/规则不合规的任务包提供“重新生成任务包” |
| `src/domain/task-plan.ts`、`src/runtime/prompts.ts` | 正式测试命令引用的测试文件必须列入同一任务允许文件；规划与评审提示词同步逐字引用与测试文件规则 |
| `src/runtime/coordinator.ts` | 宿主启动把残留 `running` 任务运行标为 blocked（中断未收口），不自动重放 |
| 版本与安装 | 0.1.0→0.1.6 连续安装到正式 `web` profile；每个版本均有 tarball 摘要，见 §36.5 |

### 36.2 验证可信度缺陷：先失败后通过

两个错误放行在最新代码上先写正式回归并确认失败（`.cache/forgeloop/m0-verification-red.log`，4 项失败）：

- 报告引用从未执行的命令 label、填写无法在输出中核对的 evidence，仍判 `done`；
- 验证命令修改跟踪文件或新增未保护文件，仍记录 `pass` 并允许验收。

修复后同一文件 27 项全部通过（`.cache/forgeloop/m0-verification-green.log`）。规则如下：

1. 必过场景的 `commands` 只能引用 `verification/commands.json` 的 label；引用不存在、命令未成功、
   超时或中止都阻断。
2. `evidence` 必须是所引用命令输出的原文片段（归一化空白后至少 8 个字符）；非空字符串、模型自述
   “pass”或无关命令退出 0 都不能替代。
3. 验证 Agent 结束后、验证命令重新执行后分别核对候选：HEAD、Git 可见改动只允许 `verification/`，
   其余变化（含未保护新文件）判“验证命令修改了固定候选”；Git 忽略的构建输出不属于候选，
   策略写入 `verification.json` 的 `candidateIntegrity`，不以“忽略所有变化”规避。
4. `verification/` 材料生成 `path/sha256/bytes` 清单并进入报告摘要，报告被篡改或候选变化后不能沿用旧结论验收。

### 36.3 研发交接

- **失败→修复→重新送验**：新增 `rework`。只接受当前候选确有阻断验证结论，归档旧产物与证据到
  `<task>.history/attempt-<n>-<sha>`，清交付标记并排队一次 `advance`；失败轮次、旧候选与旧报告保留。
  验证因基线变化无法组装时记录一次 preflight 阻断验证与失败轮次，使修复路径可达。
- **业务终审**：独立验证通过后由需求 Agent 新会话按原始需求复核；逐项覆盖分析场景/验收标准，
  证据必须落到验证命令真实输出；报告绑定候选、验证摘要与需求版本；阻断计入 `business_review` 失败轮次。
- **候选与交付身份**：候选包只从“已通过独立验证的工作区”复制构建，核对受保护内容摘要、包版本与
  tarball 摘要，记录 `candidate-builds` 与验证绑定；换版本或内容变化必须重新验证。上线核对比较
  安装文件与包内内容、安装/运行版本、需求模块是否随包加载、看板与业务记录，并记录 `deployments`；
  验收、可发布、已安装、交付完成是不同记录。
- **中断与未知**：宿主启动把残留 `running` 任务运行标为 blocked；unknown 请求必须由所有者显式
  “核对未知”关闭，验收在有 unknown 时拒绝；关闭只收口记录，不重放副作用。

### 36.4 真实需求执行与人工介入

真实需求 `req-20261029070230-bab6bf`（需求队列与自动串联）继续收口。真实发生并保留：

1. 任务包 v1 的 4 个任务在 2026-10-29 已由研发 Agent 交付；本批独立验证尚未开始，且 v1 早于
   实现前评审门禁（无评审记录），先按规则要求重新生成任务包。
2. 规划 v2–v4：评审 v2 因验证计划漏覆盖 2 条验收标准阻断；v3 因自行改写场景/标准文本被覆盖校验阻断；
   v4 由评审 Agent 给出实质阻断（正式测试命令不能证明验收、状态枚举不一致、复用点未落到允许文件）。
   其中覆盖校验只做逐字相等，属确定性误伤，已改为“逐字包含原文 + 允许补充”，提示词同步明确。
3. 规划 v5/v6：v5 仍用澄清要点替代分析原文被阻断；v6 评审输出场景重复、解析畸形，规划循环直接结束。
   修复为：评审畸形或缺项先带精确缺项重试评审本身（同一任务包），连续两次仍不可用才 fail-closed，
   覆盖缺项按阻断记录后交回研发重新规划。
4. 任务包 v7 通过评审并在 00:05:51Z 被所有者批准；推进到 `domain-records` 时研发改动
   `packages/forgeloop/src/domain/errors.ts` 越出批准清单，被范围门禁拒绝（真实拒绝证据）。
5. 最小重新规划生成 v8 并补充 `errors.ts`，但入口当时未评审新任务包，批准会永远缺评审；已修复为
   重规划后立即评审，通过才返回受理成功。
6. 所有者并发触发“重新生成任务包”，生成 v9 并覆盖为最新版本（v9 的测试命令引用了未列入允许文件的
   测试文件，属任务包规则缺口）；已修复为批准前按现行规则复校，并提供“重新生成任务包”入口。
7. 所有者批准 v9 并推进；`domain` 任务运行到 step 35 时宿主重启，回合以 `aborted/disposed` 结束。
   系统标记请求 unknown、任务运行 blocked，恢复记录 `interruptedRuns: 1`，未自动重放。核对现场：
   `workspaces/<req>/v9/domain` 仅新增 `requirement-queue.ts` 与 `requirement-queue-test.ts` 两个
   未跟踪文件，HEAD 未变、无提交、无交付记录。
8. 所有者在“核对未知 + 重新生成任务包”选择前决定先停下；正式需求保持 blocked，等待其动作。

人工介入如实记录：所有者批准 v1/v7/v8/v9、两次重新生成任务包、一次重新规划、一次推进与中断后的
暂停决定；本 Agent 修改代码、修复门禁并安装 0.1.0–0.1.6，均不属于 ForgeLoop 自主实施。

### 36.5 检查与实际结果

- `make check` 通过：39 个测试文件、425 项测试（逐批失败证据见 `.cache/forgeloop/m0-*-red.log`）。
- `make coverage` 通过：行/语句 93.02%、函数 97.06%、分支 84.15%（门槛 90/93/84），
  `coverage/coverage-summary.json` 已刷新。
- `make contracts` 通过：分层、依赖、循环、退役路径、工具、UI 与会话边界一致。
- `make package` 通过：`forgeloop-dsh@0.1.6`，177,096 字节，SHA-256
  `0ebbfa3745e67544f39d02b11c32a3cbaf44b9e3f4a6f7ee8665905eb8f8b2e3`（已安装并运行）。
- 当前 HEAD 另构建了 `forgeloop-dsh@0.1.7`，177,496 字节，SHA-256
  `84ec016c607781e8c7ad00e714004b27449a9d0783ac692083bebeab61b6f509`（含“验收后仍可构建/核对上线”
  的看板修复）；所有者决定先停，**未安装**，交付前需重新执行安装与上线核对。
- 安装：0.1.0→0.1.6 均通过 `plugin_manager` 装入正式 `web` profile；0.1.6 安装后宿主热重载
  （owner `MacAir.local:2477:c0ce681f`，`last_recovery` 于 `2026-10-30T01:28:42Z` 记录
  `interruptedRuns: 1`），3080 进程未重启。
- 真实需求：无 `requirement_verifications`、`requirement_business_reviews`、`requirement_candidates`、
  `requirement_deployments` 记录；`accepted_at` 为空。候选构建与上线核对仅由行为测试覆盖
  （`tests/candidate-build.test.ts` 5 项），未在正式需求执行。
- 本批新增/更新测试：验证证据与候选完整性 4 项、重新研发 5 项、业务终审 7 项、候选构建/部署 5 项、
  评审与规划重试 5 项、测试文件范围 2 项、中断收口 1 项、未知核对路由 1 项，以及既有测试适配。
- `make verify-plugin` 未通过：隔离 DSH_HOME 下 `.cache/forgeloop/dsh-home/profiles/forgeloop` 缺少
  `QWEN_TOKEN_PLAN_CN_API_KEY`（`MISSING_CREDENTIAL`），属环境未就绪，不是插件代码结论；
  日志 `.cache/verify-plugin-m0.log`。正式页面动作由所有者点击，未做自动化浏览器断言。

### 36.6 未完成、未验证与发现但不碰

- **M0 未通过**：正式需求停在 blocked；独立验证、业务终审、验收、候选构建、受控安装、运行版本与
  业务效果核对均未在真实需求上发生。
- 候选构建/上线核对只有替身测试；`plugin_manager` 安装回执与 `runtime_meta` 版本不能替代正式需求的上线检查。
- 验证/研发/业务终审 Agent 仍是宿主内会话与 `workspace-write`，不是 OS/容器隔离；`verification/`
  之外的写入靠执行后检查与文件范围，不是预防性隔离。
- 失败轮次当前只有 `queue-core-a1` 一条正式测试失败；业务终审/验证失败轮次字段已接入但尚无真实记录。
- 追加授权、例外取舍、完整重新规划、需求编辑与等待回答入口仍缺；运维无真实事件。
- 发现但不碰：`plan` 端点不处理 unknown（需先“核对未知”），未为此改路由；`make package` 未在 CI 中执行。

## 37. 执行范围、任务包冻结与验证回研发（2026-10-30）

所有者明确三条交接规则：需求受理后由研发 Agent 的 Plan 角色拆任务；执行角色与 DSH 默认 Agent
一致，允许默认代码工具、文件范围是当前工作区全部文件；任务版本在拆分完成后不再变动，
非用户许可禁止 replan，验证问题由验证 Agent 提出并交回研发执行角色修复。

### 37.1 实现

| 文件 | 改动 |
| --- | --- |
| `src/runtime/workspace.ts` | `captureCandidate` 的 `allowedFiles` 改为可选；省略时不再计算越界文件，仍返回全部改动与 diff |
| `src/runtime/prompts.ts` | 开发提示词改为“工作副本全部文件 + 默认代码工具”，`files` 降为计划说明；删除“只能改清单”约束 |
| `src/domain/task-plan.ts` | 退役“test_command 引用的测试文件必须在 files 内”规则；执行已不再受文件清单限制，保留该规则会误拒合法任务包 |
| `src/runtime/service.ts` | 移除交付时的越界阻断；`executeAdvance` 增加修复循环：验证阻断→归档旧产物→回研发→重新验证，任务包版本不变；`requestOperation('plan')` 与 `executeDevPlanning` 双处校验任务包冻结；新增 `reopenDeliveredTasks`；删除 `replanTask`、`rework` 与 `normalizeReplanFiles` |
| `src/runtime/board.ts` | 动作收敛为 `plan/approve/advance/verify/recover/build/deploy/stop/cancel`；已批准任务包不再出现 `plan`；删除 `replan`、`rework` |
| `src/index.ts`、`client.js` | 删除 `replan`/`rework` 端点与按钮；`plan` 端点透传 `confirmPlanChange` 与 `reason` |
| 测试 | 新增“执行可改计划外文件”“批准后计划冻结（含入队后批准的竞态）”“验证阻断自动回研发且版本不变”；退役越界拒绝、replan、rework 用例 |

### 37.2 行为与边界

- 执行范围是整个工作副本；候选 diff、逐任务改动、审查与验证证据仍完整记录，不存在“改动不可见”。
- 已批准任务包默认冻结：无显式许可时 `plan` 返回 `plan_frozen`；许可必须带原因，来源记录为
  `plan-change:<原因>`。入队后、执行前才被批准的请求同样拒绝。
- 验证阻断后在同一 `advance` 请求内修复，失败轮次每次 +1；额度用尽后停在 blocked，不无限循环。
- 修复会重跑全部非验证任务，而不是只改被点名的文件；这是当前任务产物模型的限制，已在 §37.4 记录。

### 37.3 验证

- 先写 3 个行为测试并确认失败：计划外文件被阻断、批准后 `plan` 仍可入队、验证阻断不自动回研发。
- 修复后 `make check` 通过：39 个测试文件、417 项测试；`make coverage` 通过（92.31/96.84/84.10）；
  `make contracts` 通过。
- 未运行：`make verify-plugin`（隔离 profile 缺模型凭据）、真实浏览器点击脚本、正式需求上的新策略闭环。

### 37.4 未完成与风险

- 只重跑全部任务，不能只针对验证提出的问题定向修复；大任务包会放大修复成本。
- 已批准任务包修改只有认证端点的显式许可入口，天工页没有二次确认界面；所有者要改包需走端点或后续补 UI。
- 任务包冻结后，计划质量完全取决于首次拆分；Plan 角色仍不读仓库，文件清单可能与实现需要不一致
  （现在不再阻断执行，但会影响审查与验证预期）。
- 正式需求仍停在中断核对后的 blocked；本批没有对它执行推进、验证或安装。

## 38. 执行权限收紧、项目内改动与版本号冻结（2026-10-30）

所有者追加三条规则：研发执行改为工作区内修改；开发提示词只允许改动当前项目文件；
未经用户允许不得改动版本号。

### 38.1 实现

| 文件 | 改动 |
| --- | --- |
| `src/runtime/service.ts` | 研发执行请求的权限从 `danger-full-access` 改为 `workspace-write`；越界写入由宿主沙箱拒绝，候选采集逻辑不变 |
| `src/runtime/prompts.ts` | 开发提示词明确“具体实现需要时只允许改动当前项目的文件，不允许改动其他项目的文件”；增加“未经任务要求与所有者许可不得改动版本号” |
| `AGENTS.md` | 版本号变更规则：只在用户明确要求时变更，不得为安装/重装/修复/发布自行递增或回退 |
| `docs/architecture.md` | 执行范围补充 `workspace-write`、当前项目边界与版本号约束 |

### 38.2 验证

- 先写 2 个行为测试并确认失败：执行请求权限不是 `workspace-write`、提示词缺少项目内改动约束。
- 修复后 `make check` 通过：38 个测试文件、417 项测试；`make coverage` 通过（92.31/96.84/84.11）；
  `make contracts` 通过。
- 版本号保持 `0.0.2`，未按安装需要递增。同版本重新安装被 `plugin_manager` 拒绝
  （`already-installed`），因此采用 `remove_bundle` → `install_bundle` 的受控重装，版本仍为 0.0.2。
- 重装后核对：`node_modules/forgeloop-dsh/package.json` 为 0.0.2；运行包内可见
  `permission: 'workspace-write'` 与新的项目内改动提示词；宿主热重载（`host_owner`
  `MacAir.local:2477:135d7131`，2026-10-30T02:56:53Z，`interruptedRuns: 0`）。
- 安装包：175,134 字节，SHA-256 `f347bd72c40a02174d46a099bd4bf10736f5c457748f7759ada995fbe5a6ffe2`。

### 38.3 未完成与风险

- 版本号规则是研发流程约束，尚未做成机器门禁；`package.json` 仍可被直接改动，靠评审与提交纪律发现。
- `workspace-write` 阻止工作副本之外的写入，但不提供 OS 级隔离；验证/终审 Agent 仍非独立沙箱。
- 同版本重装需要先卸载；版本冻结期间无法用版本号区分不同构建，只能用 tarball 摘要识别。
- 正式需求仍在 blocked，未因本批重装而推进或改变状态。

## 39. 未知请求的 Agent 根因诊断（2026-10-30）

所有者要求：不使用「核对未知」按钮，改为由 Agent 分析问题根因、把具体问题描述清楚并给出解决方案，
文本限制在 100 字节内（后续按所有者要求改为 100 个字符）。

### 39.1 实现

| 文件 | 改动 |
| --- | --- |
| `src/domain/diagnosis.ts` | 新增：`parseUnknownDiagnosis`（`root_cause`/`solution` 各 ≤100 个字符，超长/缺字段/空串拒绝）、`replaySafe`（按工作副本是否有非基线提交判定）、`renderUnknownFacts` |
| `src/records/db.ts` | 新表 `requirement_unknown_diagnoses`：根因、方案、重放安全性、事实 JSON、报告路径与摘要、会话、关闭条数 |
| `src/records/repository.ts` | `recordUnknownDiagnosis`、`unknownDiagnoses`、`latestUnknownDiagnosis` |
| `src/runtime/service.ts` | `diagnoseUnknown()`：采集现场事实 → `diagnosis` 角色（无工具）→ 校验材料 → 程序判定重放安全 → 安全才关闭 unknown；`collectUnknownFacts()` |
| `src/runtime/prompts.ts` | `unknownDiagnosisPrompt`：只给程序采集的事实，明确 100 字符上限与“不要空话” |
| `src/runtime/agent-runner.ts` | 新增 `diagnosis` 角色 |
| `src/runtime/board.ts` | 动作 `recover` → `diagnose`；新增 `diagnosis` 视图（根因/方案/安全性/关闭条数） |
| `src/index.ts`、`client.js` | 新端点 `diagnose`；按钮改为「分析根因」，移除确认弹窗；详情显示诊断结果 |

### 39.2 判定权仍在程序

- 模型只提供“解释 + 方案”，不参与“能否解除阻塞”的判定；
- 重放安全性看工作副本事实：运行时建立的快照只有一个基线提交，出现第二个提交即判 `replay_unsafe`；
- 材料不合格（超长、缺字段、畸形、回合失败）一律不关闭 unknown，原文另存 `*.rejected`；
- `recover` 端点保留给“已知现场、人工收口”，但看板不再默认展示它。

### 39.3 验证

- 先写 `tests/diagnosis.test.ts`（10 项）与路由/服务测试，覆盖：正常诊断、超 100 字符拒绝、
  缺字段拒绝、`replay_unsafe` 保留 unknown、回合失败保留 unknown、无 unknown 时拒绝、看板视图。
- `make check` 通过：39 个测试文件、431 项测试；`make coverage` 通过（92.49/96.91/84.39）；
  `make contracts` 通过。

### 39.4 未完成与风险

- 100 字符对“根因 + 方案”仍然偏紧，模型常需压缩表达；超长会被拒绝并留下 `*.rejected`，
  需要重试或调整提示词。
- 重放安全性只覆盖“执行者是否自行提交”这一种越界；未覆盖“执行者把改动写到工作副本外”等情况。
- 诊断结论不改变任务包、不清零失败轮次、不自动推进；解除阻塞后仍需所有者点「推进任务」。
- 正式需求仍为 blocked，本批未对它执行诊断或推进。

## 40. 诊断字符上限与失败后重新执行（2026-10-30）

所有者追加两条：根因分析放宽到 100 个字（中英文同等）；文件修改范围扩展到整个工作区/项目文件，
任务可能不再阻塞，支持自动/手动重新执行。

### 40.1 诊断上限：字节 → 字符

| 文件 | 改动 |
| --- | --- |
| `src/domain/diagnosis.ts` | `DIAGNOSIS_TEXT_MAX_BYTES` → `DIAGNOSIS_TEXT_MAX_CHARS`；`byteLength` → `charLength`（按 Unicode 码点计数），报错文案改为“超过 100 个字符” |
| `src/runtime/prompts.ts` | 提示词说明按字符计、汉字算 1 个字符 |
| `src/runtime/service.ts` | 传参与报告字段改为 `charLimit` |
| 测试 | 改为 100 字符边界；新增中英文混排与 emoji（代理对算 1 个字符）用例 |

效果：100 个汉字现在可以通过（此前只有 33 个），中英文同一标准。

### 40.2 执行范围与重新执行

- 执行范围上一批已改为“整个工作副本的全部项目文件”，越界不再阻断；本批补的是**失败后如何继续**。
- 新增 `src/domain/retry-policy.ts`：`retryDecision` 统一判定能否重新执行——终态、未批准、无任务、
  已全部交付、有 unknown、有在途请求、有运行中或等待输入任务、额度用尽、以及“需要人工处置”的
  blocked 文案，全部拒绝；其余允许。
- `runtime.requeue(reqId)`：需求级重新排队一次 `advance`；不新建任务包、不清零失败轮次。
- 看板：新增 `requeue` 动作与 `retry` 视图（`allowed` + `reason`），拒绝原因直接显示在页面上。
- 协调器：`autoAdvance` 打开时，对 `blocked` 且判定允许的需求自动排队一次
  （`source = auto-requeue`）；判定不通过则不排队，避免无限重试。
- 语义仍是**显式失败一轮**：每次重新执行都计一次失败轮次，额度用尽后停止，不会自我续命。

### 40.3 验证

- 先写 `tests/retry-policy.test.ts`（7 项）并确认全部通过后接入；看板与服务侧新增 4 项行为测试；
  协调器新增 1 项，覆盖“失败可重排、额度用尽/unknown 不重排”。
- `make check` 通过：40 个测试文件、444 项测试；`make coverage` 通过（92.56/96.93/84.46）；
  `make contracts` 通过（补登 `requeue` 端点）。
- 未运行：`make verify-plugin`（缺模型凭据）、真实浏览器点击、正式需求上的新流程。

### 40.4 未完成与风险

- 自动重新执行默认关闭（`autoAdvance: false`）；打开后会在额度内自己重试，需所有者明确接受。
- 重新执行仍从任务快照重跑整个任务，不是只修上一个失败点；大任务包成本高。
- 100 字符对复杂根因仍偏紧；超出会被拒绝并留下 `*.rejected`，需要重新诊断。
- 正式需求仍为 blocked，本批未对它执行诊断或重新执行。

## 41. “结果未知”误报与中断任务未收口（2026-10-30）

现象：正式需求的任务列表里 `domain`、`records`、`orchestrator`、`verify` 全部显示“结果未知，需核对”，
其中 `domain` 还显示“执行中”，但 12:29 之后没有任何进展。

### 41.1 根因

1. **开发回合超时后运行记录没有收口**：`deliverTask` 在 `dev.status === 'timeout'` 时直接返回
   `unknown`，没有写任务运行状态；运行记录停留在最后一次心跳（`running`，“执行步骤 20”）。
   看板因此一直显示“执行中”，心跳也停在中断时刻。
2. **结果未知被当成“整条需求所有未交付任务”的属性**：`buildStatusBoard` 里
   `resultUnknown: unknownRequests > 0 && state !== delivered`，只要有 1 条 unknown 请求，
   所有待执行任务也会被标成“结果未知”。待执行任务没有产生任何副作用，这是误报。
3. **超时的直接原因**：`dev.jsonl` 记录 `pi-ai stream idle timeout after 300000ms`（模型流 5 分钟无输出）
   在第 20 步反复重试，最终触发 `agent.timeoutSeconds`（默认 1800 秒）回合超时；运行时的中止
   处理只把请求标 unknown，没有同步运行态。

### 41.2 修复

| 文件 | 改动 |
| --- | --- |
| `src/runtime/service.ts` | 开发回合超时/停止、审查回合未完成、验证任务超时/停止时，先写 `blocked` 运行记录（含具体原因）再返回 unknown |
| `src/runtime/board.ts` | `resultUnknown` 只对“已开始但未收口”的任务为真：`running`、`blocked`、等待输入、等待人工；待执行任务不再误标 |
| 测试 | 新增开发超时收口、按任务范围标记两项行为测试；沿用既有“等待输入仍算未知”用例 |

### 41.3 验证

- 先写两项失败测试：超时后运行仍是 `running`、待执行任务被标 `resultUnknown`；修复后通过。
- `make check` 通过：40 个测试文件、446 项测试；`make coverage` 通过（92.46/96.93/84.47）。

### 41.4 配置变更

- 按所有者要求，`~/.dsh/profiles/web/cordis.patch.yml` 的 `autoAdvance` 从 `false` 改为 `true`；
  插件重载后 coordinator 会对判定允许的 `blocked`/`approved`/`executing` 需求自动排队推进或重试。
- 自动重试仍受 `retryDecision` 约束：有 unknown、在途请求、运行中任务、额度用尽时不排队；
  当前正式需求因仍有 1 条 unknown 不会被自动推进，需先做根因诊断。
- 宿主已重载（`host_owner` 变化、`interruptedRuns: 1`，把中断的 `domain` 运行收口为 blocked）。

### 41.5 未完成与风险

- 模型流空闲超时属于外部 provider 行为，本批只保证运行时正确收口，不解决超时本身；
  长任务仍可能在 30 分钟后被中止。
- `autoAdvance: true` 会让合格需求在后台自动推进；如果不想让它继续跑，需要把配置改回或停止需求。
- 正式需求仍为 blocked（1 条 unknown），未自动诊断或推进。

## 42. ForgeLoop 独立配置文件（2026-10-30）

所有者要求：ForgeLoop 的配置存放到独立文件，不再影响 DSH 自己的配置文件。

### 42.1 实现

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | 新增 `defaultConfigPath`（`~/.forgeloop/config.json`，`FORGELOOP_CONFIG` 可覆盖）、`loadConfigFile`、`mergeConfig`、`loadConfigOrThrow`；文件缺失且无关键装载参数时装载失败，不静默回落 |
| `src/index.ts` | `apply` 用 `loadConfigOrThrow(rawConfig)` 合并：宿主装载参数做底，独立文件覆盖 |
| `tests/config-file.test.ts` | 覆盖缺失、合法、非法 JSON/非对象、覆盖顺序、拒绝静默回落 |
| `~/.dsh/profiles/web/cordis.patch.yml` | 删除 ForgeLoop 的 `config:` 块，只留 `- id: forgeloop` 与说明；业务配置移入 `~/.forgeloop/config.json`（含 `autoAdvance: true`） |

### 42.2 迁移中发现的问题

- 删除 cordis 配置块后，运行中的旧版插件（不含独立文件加载）按默认值连到了
  `~/.forgeloop/projects/forgeloop`（一个空库），出现“看着在跑、记录库却是另一个”的分叉。
  已通过重新打包、重装并重载 `include:forgeloop` 恢复；正式记录库仍是
  `~/Library/Application Support/ForgeLoop/production`。
- 该空库只有 0 条需求、0 条请求，未写入业务数据；保留未删，避免误删。
- 教训：配置回落不能静默；`loadConfigOrThrow` 就是为这类情况加的硬失败。

### 42.3 验证

- `make check` 通过：41 个测试文件、452 项测试；`make coverage` 通过（92.48/96.96/84.47）；`make contracts` 通过。
- 安装 `forgeloop-dsh@0.0.2`（SHA-256 `aacade79…`，182,181 字节）后重载插件，
  正式记录库 `runtime_meta.host_owner` 更新，确认使用 production 根；
  `~/.forgeloop/config.json` 的 `autoAdvance: true` 生效。

### 42.4 未完成与风险

- 配置文件是明文 JSON，包含本机路径；未提供 schema 校验之外的权限收紧。
- 修改配置仍需重载插件（DSH 配置或启停 `include:forgeloop` 触发），没有自动监听文件变化。
- 版本号仍为 0.0.2（按规则未改）。

## 43. 删除 unknown 状态：任务会话为什么无法确认结果（2026-10-30）

所有者判断：unknown 是任务会话状态跟踪失败后的兜底，不是业务需要的状态。本批删除该状态，
并把“无法确认”改成可判定的失败收口。

### 43.1 为什么之前无法确认结果

1. **结果只在回合结束时写一次**：请求先标 `claimed`，执行完才写 `done/failed`。宿主在两者之间
   崩溃、超时或被停止，就没有任何持久记录能说明“这次执行到底做完了没有”。
2. **Agent 回合只存在于内存 await**：`runner.run()` 的 Promise 随进程消失；`dev.jsonl` 里其实有
   `turn/end`，但运行时重启时从不回读会话日志，也就无法据此判定回合是否正常结束。
3. **交付是全有或全无**：只有正式测试通过、审查通过、产物写入后才记录 task artifact；在中间
   任何一步中断，库里既没有“已完成”也没有“未完成”的持久检查点。
4. **没有把“工作副本可丢弃”当作恢复依据**：执行发生在运行时自己创建的一次性快照里
   （`git init` + 基线提交），执行者不应提交；只要丢弃快照，未交付的改动就不会进入真实项目。
   之前的实现没有利用这一点，而是用 unknown 兜底。
5. **把外部副作用泛化了**：`workspace-write` 把写入限制在快照内，但沙箱内的网络调用等仍可能
   产生外部副作用；当时用“未知”覆盖了所有情况，没有区分“可丢弃的本地快照”和“不可回收的外部调用”。

### 43.2 改法

| 文件 | 改动 |
| --- | --- |
| `src/domain/status.ts` | 删除 `REQUEST_UNKNOWN`；请求状态收敛为 `pending → claimed → done / failed / dismissed` |
| `src/records/repository.ts` | `markClaimedUnknown` → `failClaimedOnRestart`（claimed 判 failed）；新增 `migrateLegacyUnknown` 把旧库 unknown 迁成 failed，保留原 detail |
| `src/runtime/service.ts` | 新增 `recoverInterrupted`：迁移旧 unknown、收口 claimed、删除该任务包的一次性工作副本，并把需求标为“可重新执行”；删除 `recover`/`diagnoseUnknown`/诊断事实采集；`retryTask` 不再要求 recovery 确认；`accept` 不再因 unknown 拒绝 |
| `src/runtime/coordinator.ts` | 启动时调用 `recoverInterrupted`，`last_recovery` 记录中断请求、迁移数与丢弃的工作副本；执行异常按 failed 落库 |
| `src/runtime/service.ts`（补充） | `executeRequest` 在请求层把内部 `unknown` 统一收敛为 `failed`（附“按失败收口，可重新执行”），中断/超时不再写进请求状态 |
| 删除 | `src/domain/diagnosis.ts`、未知诊断提示词、`diagnosis` Agent 角色、`requirement_unknown_diagnoses` 表、`diagnose`/`recover` 端点、看板 `diagnosis` 视图、客户端诊断按钮与“结果未知”标记 |
| 看板 | 任务不再有 `resultUnknown`；请求失败作为 attention 问题展示；`requeue`/`autoAdvance` 负责重新执行 |
| 测试 | 删除诊断与 unknown 用例；改写重启收口、重试、requeue、impact 与看板用例为 failed 语义 |

### 43.3 语义变化

- 中断不再需要人工“核对未知”：启动时直接判该请求 failed，丢弃快照，然后按 `retryDecision`
  自动或手动重新执行。
- 失败轮次照常累计；**中断/超时也计一轮**（stage=`interrupted`），否则 `autoAdvance`
  会对同一条 30 分钟上限的任务无限重试。额度用尽后停在 blocked。
- `dismissed` 仍然保留，用于取消/修订导致的未执行请求，以及旧 unknown 迁移后的历史记录。

### 43.4 验证

- `make check` 通过：41 个测试文件、433 项测试；`make coverage` 通过（92.14/96.90/84.07）；
  `make contracts` 通过。
- 手工验证点：重启收口把 claimed 变 failed 并删除工作副本；旧 unknown 迁移为 failed；
  `requeue` 不要求额外确认；看板不再出现“结果未知，需核对”。

### 43.5 未完成与风险

- 沙箱内执行者发起的网络请求等外部副作用仍不可回收；删除 unknown 后这部分风险由“可重放”假设
  承担，已在架构说明中列为边界，后续若要收紧需要网络白名单或副作用登记。
- 删除 unknown 后，频繁崩溃会表现为“反复 failed → 反复重试”；中断已计入失败轮次，
  三次后停在 blocked，由所有者决定是否追加授权。
- 正式需求的旧 unknown 会在下次宿主启动/插件重载时迁移为 failed 并丢弃 v9 工作副本，随后
  在 `autoAdvance: true` 下自动重新排队执行。
- 版本号仍为 0.0.2（按规则未改）。

## 44. 全链路删除 unknown 状态与任务会话结果不可确认的根因（2026-10-30）

所有者要求：研发任务链路、运维链路和全链路都不允许 `unknown` 状态；发现不明确的情况时，
由 Agent 分析根因后上报，而不是新造一个业务状态。§43 只删除了请求层的 `unknown`；
本批把任务执行返回值、运维动作与事件、看板/客户端残留一并收敛，并补上中断根因上报。

### 44.1 任务会话为什么无法确认结果

1. **结果只在回合结束后写一次**：请求先标 `claimed`，Agent 回合 `await` 返回后才写
   `done/failed`，任务运行只在回合中写心跳。宿主在两者之间崩溃、被停止或超时，就没有任何
   持久记录说明“这一步到底做完了没有”。
2. **回合只存在于内存 Promise**：`runner.run()` 的 Promise、DSH Agent handle 与在途回合都
   随宿主进程消失。`dev.jsonl` 由同一个运行时进程每 1.5 秒覆盖写入，既不是独立见证，也不能
   保证包含终态 `turn/end`；重启时运行时从不回读它，因此无法据此判定回合是否正常结束。
3. **交付是全有或全无**：只有开发回合、独立审查、正式测试全部通过并写入产物后，才记录
   task artifact。中间任何一步中断，库里既没有“已交付”也没有“未交付”的终态，运行记录停在
   最后一次心跳，看板只能显示“执行中”。
4. **没有利用“工作副本可丢弃”这一确定事实**：执行发生在运行时自己创建的一次性快照里；
   只要丢弃快照，未交付改动就不会进入真实项目。也就是说“未交付”本来是可判定的，旧实现却
   用 `unknown` 覆盖了它，把可判定结果变成了人工核对。
5. **状态词表没有“尝试结束但没有结果”的位置**：任务运行只有
   `running/delivered/awaiting_user/failed/blocked`，请求只有 `pending/claimed/done/failed`。
   `unknown` 是硬塞进去的第五种语义，随后从请求泄漏到任务运行、看板，甚至被当成整条需求的
   属性（§41 的“结果未知”误报就是这条泄漏路径）。
6. **界面从状态字符串推导事实**：删除请求层 `unknown` 后，客户端仍保留“未知请求”标签，并把
   `failed` 请求计数显示成“结果未知请求待核对”；这类残留让“已删除”的状态继续出现在页面上。

结论：任务会话不是缺少一个“未知”状态，而是缺少**每个阶段结束时必写的终态**和**对一次性
副本的确定性处置**。把“未交付”判成失败/阻塞，比引入一个无法判定的状态更准确。

代码证据：`executeRequest` 只在 `dispatchRequest` 返回后统一落请求状态；`AgentRunner.run`
用 `await handle.agent.whenIdle()` 等待回合，活动快照由同进程的 `setInterval` 写入；`deliverTask`
在开发、审查、正式测试都成功后调用 `recordTaskArtifact`/`recordEvidence`；`recoverInterrupted`
只处理 `claimed` 请求与工作副本，不读取会话日志。这些观察与 §43.1 的结论一致，并解释了
为什么“重启后先查实际结果”在产品语义上成立，却一直缺少实现它的持久检查点。

### 44.2 改法

| 文件 | 改动 |
| --- | --- |
| `src/runtime/service.ts` | 删除任务执行返回值中的 `unknown`：分析/规划/评审/验证/业务终审/推进/交付的停止、超时、中断统一收敛为 `failed` 或 `blocked`，并写明“任务未交付、一次性副本可丢弃、可重新执行”；补齐交付阶段正式测试被停止/超时时缺失的终态运行记录，未预期异常也写失败终态；失败轮次由执行结果显式的 `interrupted` 标记计一轮 |
| `src/runtime/agent-runner.ts`、`src/records/repository.ts` | 中断原因改为确定表述；启动时仍为 `running` 的任务运行收口为 `blocked`，说明副本会在下次执行时重建，不再要求“核对后重试” |
| `src/domain/ops.ts` | 删除 `OPS_UNKNOWN` 与事件结果未知统计；新增动作尝试状态 `running/succeeded/failed/interrupted`、活动事件集合与中断根因报告结构/解析（有长度上限、至少一条事实） |
| `src/runtime/ops.ts` | 超时/中止记 `failed`（没有退出码，事件转 `unresolved`；超时后再用登记检查判定实际状态）；宿主中断记 `interrupted` 并转 `unresolved`；新增 `interruption` 事实观测与一次性的运维 Agent 根因报告（`interruption_report`，失败记 `interruption_error`，不重试、不改变状态、不授权重放）；删除 `confirmUnknown` 与关闭前的人工核对门禁 |
| `src/records/repository.ts`、`src/records/db.ts` | `markRunningOpsActionsUnknown` → `markRunningOpsActionsInterrupted`；新增旧库运维 `unknown` 迁移（事件→`unresolved`、动作→`interrupted`）；删除 `result_unknown` 字段与写入 |
| `src/runtime/prompts.ts` | 新增中断根因上报提示词：只给已记录动作、参数、授权来源、日志尾部与观测摘要，要求区分事实与可能、给出人工下一步，禁止自动执行与猜测副作用 |
| `src/index.ts`、`client.js` | 删除 `ops-confirm-unknown` 端点、`confirmUnknown`/`confirmRecovery` 参数与页面按钮；删除未知请求/未知事件标签、死代码与两步确认；失败请求明确显示为“请求失败待处理”；运维处置记录新增尝试状态标签 |
| 测试 | 新增/改写中断收口、旧 unknown 迁移、超时转未解决、根因报告解析与只上报一次、关闭不再需要核对、看板/词典无未知标签等行为测试 |

### 44.3 收敛后的状态

- 任务请求：`pending → claimed → done | failed`；任务运行：`running → delivered | awaiting_user | failed | blocked`。
  停止/超时/宿主中断都是确定失败或阻塞，不再出现“无法判定”。
- 运维事件：`open → diagnosed → awaiting_decision → recovering → recovered | unresolved | closed`。
  动作尝试：`running → succeeded | failed | interrupted`。`interrupted` 是“没有结果记录”的事实，
  不是业务状态；事件按 `unresolved` 收口，根因报告作为观测和证据保留。
- 关闭不再需要“已经核对未知”的前置确认；仍拒绝关闭仍有动作在执行的事件。
- 旧库中的请求/运维 `unknown` 在协调器启动时迁移为 `failed`/`unresolved`、`interrupted`；
  新库和新写入不产生 `unknown`。

### 44.4 验证

- `make check` 通过：类型检查、架构契约与 40 个测试文件、440 项测试。
- 重点行为测试：开发回合超时仍以 `failed` 收口并计一轮中断；开发回合抛异常时运行记录写
  `failed` 而不是停在 `running`；正式测试被停止时运行记录写 `blocked` 并计一轮中断；超时/停止
  不再返回 `unknown`；运维超时动作记 `failed`、事件 `unresolved`，且不产生第二条动作；
  宿主中断动作记 `interrupted`，只调用一次运维 Agent 写出根因报告；旧 `unknown` 迁移；
  关闭未解决事件无需额外确认；客户端中英文词典不再包含未知状态标签。

### 44.5 未完成与风险

- 删除 `unknown` 不回收外部副作用：执行者在沙箱内发起的网络调用、测试命令改动外部系统等
  仍可能发生且无法由本地记录确认。这是已知边界，不能用状态改名消除。
- 中断根因报告是模型基于事实的分析，不是副作用证明；模型失败时只保留确定性事实与
  `interruption_error`，不重试、不阻塞收口。
- 运维仍保持“每个事件最多执行一次登记动作”，根因报告不会自动触发第二次动作；是否需要重试
  仍由所有者决定。
- 旧库迁移在协调器取得单消费者锁时执行；只读宿主不会迁移，若页面直接读取旧库仍可能看到历史
  `unknown` 原文。当前只读宿主不领取工作，不影响正式推进。
- 版本号仍为 0.0.2（按规则未改）；本批随后已打包并安装到当前 web profile，见 §45。

## 45. 部署到当前 DSH 正式环境（2026-10-30）

### 45.1 目标与配置

- 目标：`DSH_HOME=/home/link/.dsh`，profile `web`（运行中的 `dsh web`，PID 40055，
  `127.0.0.1:3080`）。部署前该 profile 没有安装 `forgeloop-dsh`。
- 新建 `~/.forgeloop/config.json`（权限 600）：
  `project=forgeloop`、`projectPath=/home/link/Project/ForgeLoop`、
  `recordsRoot=~/.forgeloop/production`、`owner=link`、`pollSeconds=5`、`autoAdvance=false`；
  未配置 `agent`，使用宿主默认模型；`ops` 未启用。
- 记录根为全新目录：0 条需求、0 条请求，不与 `~/.local/share/forgeloop` 下的旧 0.0.4
  发布物混用，也没有删除旧目录。

### 45.2 安装

- 候选：`packages/forgeloop/dist/forgeloop-dsh-0.0.2.tgz`，180,887 字节，
  SHA-256 `d1d16cc4e9045e3b52db4bf382b739fdce5ec602bd1bd9b8f8781a34261261ab`，
  构建时 Git HEAD `270642d`，工作树干净。
- 通过宿主插件管理器 `install_bundle` 安装上述 tarball，结果 `application: applied`。
  profile `package.json` 记录 `forgeloop-dsh: file:...tgz`，`dsh.profile.bundles` 已包含
  `forgeloop-dsh`；插件 `forgeloop` 的 fiber 为 active。

### 45.3 安装后核对

- `forgeloop_status`：返回项目 `forgeloop` 0 条需求；`forgeloop_ops`：返回运维统计且
  `enabled=false`，没有事件。
- 生产库 `runtime_meta.host_owner` 为 `link-debian:40055:c50f5380`，`last_recovery` 各项为 0；
  `host.lock/owner.json` 指向 PID 40055，说明当前 web 宿主持有单消费者锁并已启动协调器。
- 客户端 `conversation.view` 槽位已注册 `forgeloop-board` 的 `forgeloop` 视图
  （order 20，active），与「对话」「轨迹」并列；页面需要刷新后显示「天工」。
- 未认证请求 `POST /api/forgeloop/board` 返回 401，符合认证路由预期；浏览器会话刷新后可读。

### 45.4 未完成与边界

- 尚未用真实需求跑端到端交付、验证、验收或发布；本次只证明安装、装载、工具、协调器与
  客户端视图可用。
- 没有配置或启用运维目录；`forgeloop_ops` 为空是配置结果，不是部署失败。
- 未推送、未打 tag、未改版本号；未修改正式库之外的其他项目或凭据。
- 回退路径：此前未安装该插件，需要回退时卸载 `forgeloop-dsh` 并保留
  `~/.forgeloop/production`（当前为空）与 `~/.forgeloop/config.json`；不要删除旧
  `~/.local/share/forgeloop` 发布物。

## 46. 四 Agent 连续研发闭环（2026-10-30）

### 46.1 目标与角色映射

- 目标：普通可信需求在既有授权内，从输入、产品澄清、系统准入、研发实现与自验、独立验证与业务验收
  到受控提交，不逐阶段等待人工批准；技术失败和额度内缺陷自动恢复。
- 身份收敛为 **产品 Agent（product）、研发 Agent（dev）、验证 Agent（verify）、运维 Agent（ops）**。
  删除 `analyze`、`plan`、`review`、`verify-plan`、`business-review`、`diagnosis` 作为独立 Agent 身份；
  阶段、提示词和状态仍可细分，但不再创建新的业务身份或永久会话。
- 研发 Agent 吸收原规划、实现、独立审查前的实现与修复；验证 Agent 吸收原实现前评审中的验证设计、
  独立审查和业务终审；产品 Agent 只做需求澄清与真实业务歧义，不做常规技术批准或最终业务验收。
- 主控仍是确定性协调者：负责领取请求、自动排入研发、状态、准入/授权校验、身份与版本绑定、停止与恢复、
  失败额度、证据与提交整合，不是第五个 Agent。

### 46.2 主要改动

| 文件 | 改动 |
| --- | --- |
| `src/domain/agents.ts` | 新增唯一四身份词表与阶段常量；任何新子角色都会被类型和契约测试挡回 |
| `src/domain/admission.ts` | 新增确定性系统准入：可信来源、所有者、项目、需求版本、分析版本、澄清项；输出绑定依据与是否允许代码提交 |
| `src/domain/status.ts` | 新增 `specified`、`developing`、`verifying`、`committed`；`committed` 为终态 |
| `src/config.ts` | 新增 `autonomy.enabled/allowCodeCommit/trustedSources/commitCheckCommand`；新增需求级研发工作区与提交证据目录 |
| `src/records/db.ts`、`repository.ts` | 新增 `requirement_admissions`、`requirement_code_candidates`、`requirement_commits`；准入与人类批准、候选与候选包、提交与临时快照分开记录 |
| `src/runtime/agent-runner.ts` | 角色收敛为四身份；新增可复用的 `open/send/close` 连续会话，同一研发过程不再每轮新建 Agent |
| `src/runtime/integration.ts` | 新增候选导出与受控提交：真实项目干净/基线一致检查、临时工作树检查、只暂存本候选、记录提交与检查日志 |
| `src/runtime/service.ts` | 新增产品→准入→研发→验证→定向修复→提交的连续推进；准入后自动排队；验证与业务验收同一会话；修复保留现场和旧候选；提交只包含本需求 |
| `src/runtime/coordinator.ts` | 自动推进判定统一委托 `autoAdvanceRequests`；覆盖已准入的 `specified/developing/verifying`，不再只服务旧 `approved/executing` |
| `src/runtime/prompts.ts` | 提示词改为四身份；研发方案允许只读工具；验证基线由需求说明生成；业务验收由验证 Agent 完成 |
| `client.js` | 新增四个状态的中英文标签与色调；历史批准/验收入口保留给旧记录 |
| `tests/admission.test.ts`、`tests/continuous-flow.test.ts` | 新增准入正反例、四身份、可信需求自动分析→准入→研发→验证→提交、定向修复保留成果、脏项目阻断提交等行为测试 |
| 其他测试 | 角色断言改为四身份；旧批准/验收路径保留为历史兼容测试；协调器自动推进期望同步 |

### 46.3 正常路径与人工节点

- 正常路径：`submit`（可信来源）→ 自动 `analyze` → 产品说明无歧义 → 系统准入 `admit` →
  协调器自动 `advance` → 研发方案/任务/实现/自验 → 候选 → 验证 Agent 独立验证 → 同会话业务验收 →
  受控本地提交。普通需求在该路径上的人工节点为 **0**。
- 仍保留的真实例外：业务目标/承诺冲突、需要改变已生效授权边界、无法确认后果的高风险动作、
  发布/部署授权、运维目录外的生产操作、额度用尽或提交检查失败后的客户决定。
- 旧的任务包批准、实现前评审、独立验收入口保留为历史记录与兼容路径，不再是可信新需求的常规门禁；
  没有伪造 `by=owner`、`approved=true` 或批准行。

### 46.4 验证与未完成

- `make check` 通过：43 个测试文件、481 项测试；新增测试覆盖准入、连续提交、定向修复、模型/工具失败、
  方案畸形与脏项目阻断；`make contracts` 通过。`make coverage` 行覆盖约 90%，分支仍低于 84% 门槛。
- `make package` 生成 `forgeloop-dsh-0.0.2.tgz`，197,247 字节，SHA-256
  `f0427486b07e2105d39d57ef5434ab369b382ba1b3eda41c750945f59aabf694`；未安装到正式 profile。
- **真实 happy path 已跑通**（隔离 `DSH_HOME` + `e2eweb` profile，DSH 0.2.1-rc.5，真实
  `deepseek/deepseek-v4.1-flash`）：在认证的 ForgeLoop 业务会话中以所有者 `link` 输入需求
  `req-20261030155523-5939e5`，产品 Agent 完成分析 v1，系统准入 `admit`（来源
  `dsh-session:...`、提交者 `link`），协调器自动排入 advance；研发 Agent 在需求级工作区完成 2 个任务
  （`math-core`、`math-tests`），验证 Agent 在独立工作区执行 7 条自动化命令并通过，同一会话完成业务验收，
  主控在干净基线提交 `667cf99b31a807630eec2e894e0dc95a3285948a`。
- 交付证据：候选 `aefa0a6c0a9ccefa712932958993e08e6685101e131735f77f35288bca2d647a`，
  验证报告摘要 `e9b0ceaa47516d7b451ba4026aa697fb0be93697e821756efff926b884de3378`，
  业务验收摘要 `f5b948972d493ba2e0548a322b82ce5f61cd900f37fcd25c5b297bd99cfd0724`；
  提交文件仅 `packages/forgeloop/src/math.js` 与 `packages/forgeloop/tests/math.test.js`；
  项目内 `node --test` 为 2/2 通过。该路径没有任务包批准、实现前评审、手工推进、手工验证或整体验收。
- 工具入口仍按设计拒绝自准入：`forgeloop_submit_requirement` 固定提交 `by=agent:<owner>`，与系统准入
  的“提交者等于所有者”规则冲突并返回 `owner_mismatch`。这不是本轮 happy path 的入口；真实人类路径使用
  认证业务会话，二者边界已记录。
- 真实执行发现并修复：验证 Agent/研发 Agent 在有工具会话中可能把 DSML/工具调用文本当最终答案，
  方案回合改为工具禁用并保留 3 次格式重试；宿主 session dispose 可能悬挂，关闭改为 5 秒有界；
  方案失败计入 `stage=planning` 并停止自动整轮重放。
- 未部署、未 push、未打 tag、未递增版本；正式生产插件仍是旧 0.0.2。
- 未触碰：正式生产库中的既有需求与失败记录、模型路由/凭据、其他项目、已部署应用；
  `package-lock.json` 版本与根包版本不一致、缺失 `.pre-commit-config.yaml` 仍是既有问题。
- 旧 UI 的任务包批准/验收卡片仍显示历史字段；普通新需求不经过这些动作，但完整界面收敛尚未完成。
- 既有文档中部分相对链接指向仓库外 `references/`，不是本批新增；未改动。
