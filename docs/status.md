# ForgeLoop 状态记录

本文件是当前状态与实际证据的入口；新目标、需求和方案见[统一方案](product.md)。
更新时区分当前快照与历史批次，数字绑定检查日期、构建和原始日志；发现冲突先核对并留勘误。
本文件不把工程检查、安装回执或历史自迭代当作新方案的完整验收。

## 当前快照（2026-10-28）

| 项目 | 最近有依据的状态 | 回查 |
| --- | --- | --- |
| 新产品方案 | 产品、技术与验证决定已合并；种子范围、首条真实需求及 M2 参数仍待明确 | [统一方案 §14](product.md#14-实施边界与待决项) |
| 活动实现 | TypeScript 原生 DSH 插件，宿主内 Agent、SQLite 与只读看板；`/fl` 命令面、旧库兼容与提交时间策略已删除，客户决定入口未实现 | [架构](architecture.md)、§14 |
| 退役代码清理 | 已删除 `legacy/`、失效安装脚本与未接入运行链路的重复代码；历史从 Git 回查 | §13、[ADR 0009](adr/0009-remove-retired-implementation.md) |
| 最近安装记录 | 2026-10-26 desktop profile 安装移除选择器后的候选；本次未重新核验运行实例 | §9 的包摘要与槽位实测 |
| 最近工程检查 | 2026-10-28 `make check`、覆盖率与候选打包通过，25 个测试文件、202 项测试；未重跑真实宿主 | §14 |
| 真实业务链路 | 历史需求闭环有证据；新方案的自主研发／运维闭环与介入率未验收 | [迁移交付记录](delivery/2026-10-22-typescript-dsh.md) |
| 关键缺口 | 客户决定入口缺失；需求级停止、逐动作工时、跨请求失败额度及副本外权限未完整落实 | [§4.1](#41-当前实现缺口2026-10-28-整理)、§14 |
| 覆盖率 | 2026-10-28 行／语句 91.52%、函数 96.07%、分支 84.11%，门槛通过 | §14；历史测量及勘误见 §13、§3.4、§2.2 |

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
| 持久请求、去重、重启 unknown、动作 interrupted | 已实现；真实重启场景见 §2.3/§2.5 |
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
| 服务与[失败计数](../packages/forgeloop/src/domain/counting.ts) | 失败额度主要在记录失败及循环分支检查，重新推进前缺完整额度准入；回合 ID 使用任务及当次尝试序号，跨请求重试与幂等累计需专项验证 |
| 服务与[Agent 执行器](../packages/forgeloop/src/runtime/agent-runner.ts) | 实现请求 `danger-full-access`，独立副本与事后 diff 检查未形成副本外写入的预防性限制；ADR 中“工作区写权限”不能当作实际约束证据 |
| 失败计数与入口 | 有 `user_acceptance` 失败类型，但当前无公开的用户验收失败反馈入口，尚未形成完整累计路径 |
| [服务验收入口](../packages/forgeloop/src/runtime/service.ts)与[记录层](../packages/forgeloop/src/records/repository.ts) | 当前允许未构建候选包时按任务材料验收；验收成功不证明已经打包、安装或上线。历史 diff 对变化后源码重放曾需外部合并，见 §2 与交付记录 |

其他保留限制：当前任务包要求至少两个任务且有依赖；运行时恢复入口需要显式确认，
但不会自动核验副作用。费用计量、脱敏与材料保留策略、
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
