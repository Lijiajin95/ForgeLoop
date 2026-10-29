# ForgeLoop 状态记录

本文件是当前状态与实际证据的入口；新目标、需求和方案见[统一方案](product.md)。
更新时区分当前快照与历史批次，数字绑定检查日期、构建和原始日志；发现冲突先核对并留勘误。
本文件不把工程检查、安装回执或历史自迭代当作新方案的完整验收。

## 当前快照（2026-10-29）

| 项目 | 最近有依据的状态 | 回查 |
| --- | --- | --- |
| 新产品方案 | 产品、技术与验证决定已合并；种子范围、首条真实需求及 M2 参数仍待明确 | [统一方案 §14](product.md#14-实施边界与待决项) |
| 活动实现 | TypeScript 原生 DSH 插件；业务会话已实现输入接管、需求拆解、澄清回答、技术方案/任务包、批准、推进、验证任务、验收与停止；任务失败原因/确定性解决方案、失败任务重试与最小重新规划已接入；需求分析读取当前活动需求与任务事实（状态、时间）；天工页具备总览/需求/任务/问题、搜索、需求与任务详情、调试证据与响应式布局；真实候选构建、运行中停止等仍未验证 | [架构](architecture.md)、§15–§31 |
| 架构契约 | 2026-10-29 起为 schema v3：只固定分层/依赖方向/循环/退役路径/工具与 UI/会话表面；源码模块、工具名、Web 端点自动发现，`make contracts` 只检查、无登记更新步骤 | §30 |
| 退役代码清理 | 已删除 `legacy/`、失效安装脚本与未接入运行链路的重复代码；历史从 Git 回查 | §13、[ADR 0009](adr/0009-remove-retired-implementation.md) |
| 最近安装记录 | 2026-10-29 最小重新规划候选包 `6b9363…`（103,109 字节）已安装到正式 `web` profile，并热重载正式 3080（PID 82207，owner `MacAir.local:82207:3d3e7f3c`，acquiredAt `2026-10-29T11:33:37.308Z`）；安装后客户端 143,687 字节，SHA-256 `a5cf66…` | §29 |
| 最近工程检查 | 2026-10-29 `make check` 通过，27 个测试文件、277 项测试；覆盖率 行/语句 91.65%、函数 95.87%、分支 84.81%；本批未重新打包 | §31 |
| 真实业务链路 | 真实 Web 已完成“输入 → 需求 → 拆解 → 澄清 → 技术方案/任务包 → 批准 → 推进 → 验证 → 验收”；停止入口真实触发；失败任务的真实证据已用于核对原因/建议；本批工作台在隔离环境完成真实浏览器检查，但不计为正式业务链路验收 | §16–§28 |
| 关键缺口 | 实际候选构建 → 摘要 → 验收未闭环；开发 Agent 运行中停止与副作用核对未验证；例外取舍、追加授权、完整重新规划仍缺失；最小重新规划只补文件、不新建任务；正式 blocked 需求仍需 owner 在页面确认后才会生成待批准 v2；架构检查仍是静态正则，不能替代代码审阅 | §4.1、§21–§30 |
| 覆盖率 | 2026-10-29 行／语句 91.65%、函数 95.87%、分支 84.81%，门槛通过 | §31；历史测量及勘误见 §30、§29、§28、§27、§26、§25、§23、§22、§21、§19、§18、§15、§14、§13、§3.4、§2.2 |

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
| 服务与[失败计数](../packages/forgeloop/src/domain/counting.ts) | 失败额度在记录失败、循环分支、advance 入口与 retryTask 检查（2026-10-29 补齐推进准入）；回合 ID 已绑定推进请求与尝试序号，跨请求重试不再吞轮次；追加授权入口与额度用尽后的继续路径仍未实现 |
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
