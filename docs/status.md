# ForgeLoop 状态记录

本文件是 ForgeLoop **当前状态**的唯一入口。逐批次的实测过程与门禁细节保留在本文件与
[工程可靠性方案](engineering-reliability.md)；文档与事实不一致时以源码、记录库与原始日志为准，
并明确披露差异。

更新规则：实现批次、验证结果、安装状态与远程状态变化后更新本文件；只写实际执行的证据，
未执行或未验证的事项如实标记。

版本策略：**产品版本只由 git tag 决定**；文档与契约不记录语义化版本号，构建产物的版本名
以打标签时的构建记录为准。

## 1. 当前形态（截至 2026-10-23，Asia/Shanghai）

- 产品：`forgeloop-dsh`，TypeScript 原生 DSH 插件（`packages/forgeloop`）。
- 唯一常驻宿主：DSH。不再启动 `forgeloop serve`、`forgeloop-launcher`、独立 HTTP 服务或网页。
- Web 页面：DSH 会话区「天工」页（`conversation.view`，`id=forgeloop`，只读），展示需求、任务
  与待处理问题的状态；批准、推进、验收仍只从 `/fl` 命令进入。
- 业务记录：SQLite（`node:sqlite`），`<recordsRoot>/projects/<project>/records.sqlite`，兼容旧库读取。
- 旧 Python／前端／serve 路线：由 [ADR 0008](adr/0008-typescript-native-dsh-plugin.md) 取代；
  代码隔离在 `legacy/`，不参与构建、检查或运行（迁移见 §6）。
- 详细架构与信任边界：[docs/architecture.md](architecture.md)。

## 2. 2026-10-22 批次：全量转 TypeScript／DSH 并完成 V0→V1

### 2.1 基线与在途工作处理

- 执行起点 HEAD：`6233a6e9762fa65d61565eef78765cc72d3e290b`。工作树有 58 项其他执行方的
  在途改动（54 个已跟踪修改、4 个未跟踪文件）。
- 基线快照保存在 `.cache/forgeloop/dsh-migration/baseline/`（不入库）：
  `git-state.txt`、`worktree.patch`、`diffstat.txt`、记录库副本 `records.sqlite`。
  SHA-256：`worktree.patch adfa8dae…`、`git-state be7d763e…`、`records cbb48b2f…`。
- 没有覆盖、回退或清理这些改动；没有创建产品 commit。执行副本按“Git 跟踪清单＋未忽略新文件”
  复制，因此包含未提交实现，而不是只从 HEAD 取树。

### 2.2 实现与检查（TypeScript）

- 新增 `packages/forgeloop`：领域规则、SQLite 记录、协调器、DSH Agent 执行、正式测试、快照
  工作副本、候选打包、`/fl` 命令与 6 个模型工具。
- 新增 `scripts/ts/`：契约校验／生成、提交策略、宿主装载验证；`Makefile`、`.githooks/` 改接
  TypeScript 工具链。
- `make check`（类型检查＋契约＋提交策略配置＋vitest）在本批多次运行；最终 **97 项通过**
  （门槛以 `Makefile`、`vitest` 与 `contracts/` 为准）。
- 真实宿主验证：`make verify-plugin --full` 使用隔离 `DSH_HOME`，检查 profile 清单、安装形态
  （`installed-copy`）、组合层、真实模型调用 `forgeloop_status` 与真实 `/fl status` 命令。
- 覆盖率已接入（行 92.16%、分支 85.1%，阈值 90/84）；依赖审计已配置但本机受限缓存下未
  验证；变异测试与格式化器未接入，对应 `make` 目标显式失败，不冒充通过。

### 2.3 V0：真实研发闭环

需求 `req-20261022151546-b52121`（失败轮次可见性）：经 DSH 命令入口提交，分析 v1、任务包
v2（3 个任务，拓扑依赖）、人工批准 v2、真实 DSH Agent 实现、独立审查、正式测试、候选包。

- 交付：3/3 任务 `delivered`；正式测试日志 `exit_code: 0`；独立审查 `pass`（有 7 条非阻断
  findings，含额度公式复用与测试脆弱性）。
- 候选包（V0 构建，版本名以 git tag 为准）：SHA-256
  `789965d6cf136058926f62499eccab62bda5af6498b27c6eda59f800af7ba418`，44 KB，仅含
  `lib/`、`package.json`、`cordis.patch.yml`、`README.md`，无 Python 文件。
- 安装：`dsh plugin --profile forgeloop add <tarball>` 后为真实安装目录（非链接）；
  `make verify-plugin --full` 通过。
- 验收：材料指纹 `e1c7a50b3aba2922…`；需求状态 `accepted`。
- 人工介入如实记录：批准、验收、候选构建与安装由外部执行 Agent 通过命令入口完成，不是模型
  自行决定；所有权属于外部执行，不计为 ForgeLoop 独立成果。

### 2.4 V1：自迭代结果

需求 `req-20261022154141-b8907b`（需求修订影响摘要 `/fl impact` 与只读工具
`forgeloop_impact`）：由已安装的 V0 从 DSH 命令入口提交，分析 v1、任务包 v1（4 个任务：
事实引擎 → 推断模块 → 命令/工具接线 → 契约文档）、人工批准 v1、真实 Agent 实现、独立审查、
正式测试、候选包与安装。

- 交付：4/4 任务 `delivered`；各任务正式测试 `exit_code: 0`（交付时快照 84 项通过；当前主源码补测后为 97 项）；
  独立审查均为 `pass`（保留非阻断 findings，如“旧任务包未交付任务的 pending 语义”“当前批准
  取值口径”）。
- 候选包（V1 构建，版本名以 git tag 为准）：SHA-256
  `415b85fd6467bd80e9f722b5ca1dff32465ea048cb01b5fe12502c1e980ee124`；包含
  `impact.ts`、`impact-explain.ts`、`lock.ts` 等构建产物，无 Python/legacy 文件。
- 安装与验证：安装到同一隔离 profile（`installed-copy`）；`make verify-plugin --full`
  通过；真实模型调用 `forgeloop_impact` 成功；`/fl impact` 分别验证了
  `current`（已验收需求，0 过期/0 待核对）与 `pending`（多任务包无批准，5 项待核对）；
  `--explain` 返回与事实分区的模型推断并明确标注“不是确定事实”。
- 历史与恢复：V1 下 `/fl status` 仍可读全部 4 条历史需求；重新安装修复基线构建后 `/fl status`
  仍可读、`/fl impact` 明确为未知子命令（证明运行版本确已切换），随后重新安装 V1 作为最终
  运行版本。
- 验收：材料指纹 `8ac4afa284c13e10…`；需求状态 `accepted`。人工决定、安装与重启由外部执行
  Agent 通过命令入口完成，如实记录。
- 专用用户 profile：另在 `~/.dsh/profiles/forgeloop`（headless 模板）安装同一 V1 tarball，
  真实模型调用 `forgeloop_status` 返回 `ok:true` 与 5 条需求；该 profile 需要模型凭据环境变量
  或在 Models 页登记，未改桌面 profile。

### 2.5 规则与负例

- 行为测试覆盖：需求版本连续性与修订、分析畸形、任务包依赖/文件越界/并行包、批准过期与
  重复消费、材料变化、失败轮次幂等与额度用尽、工时、请求去重与原子领取、重启标记 unknown、
  停止撤销待执行、越出文件清单阻断、正式测试失败重试与额度耗尽。
- 真实负例：规划模型两次输出目录路径／旧 Python 测试命令，被确定性规则拒绝并带原因重试；
  一次准备命令修改 `package-lock.json` 被范围检查阻断；一次宿主中断把在途请求标为 `unknown`
  而未重放。
- 依赖交接缺口：V1 的第三个任务在副本中看不到上游已交付改动，试图重写上游文件而被范围检查
  阻断。修复为“上游 artifact 先应用到下游副本并作为新基线”，新增行为测试；以修复基线构建（`a2b62e78…`）重新安装后继续，未放宽文件清单。
- 并发缺口：验证脚本启动第二个 DSH 宿主时，把正在执行的 V1 请求标为 `unknown`。已新增
  `<记录根>/host.lock` 单消费者锁（目录原子创建、PID 存活检查、残留清理），第二个宿主只读
  不领取；该事件的状态已按恢复流程核对，未重放副作用。

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
- 仍未覆盖的低值区域：`service.ts` 的深层执行流水线（81.23% 行、76.44% 分支）依赖真实 Agent
  回合的失败组合；`index.ts`/`cli/` 按配置从覆盖率统计中排除。

## 4. 当前能力与缺口

| 能力 | 状态 |
| --- | --- |
| 插件安装、组合与真实模型工具调用 | 已验证（隔离 DSH_HOME、V0 tarball） |
| 会话区「天工」页与工作流选择器 | 已实现并有装配/注册测试；当前构建已装入 desktop profile，宿主路由在隔离 Web 宿主与桌面页面均验证通过（见 §3.3） |
| 需求提交/修订、分析、规划、批准、推进、停止、查询、验收 | 已实现并有真实链路证据 |
| 持久请求、去重、重启 unknown、动作 interrupted | 已实现；真实重启场景见 §2.3/§2.5 |
| 单消费者锁（同一记录根只允许一个协调器） | 已实现并有并发测试；修复基线起安装。此前的双宿主事件暴露了缺口，见 §2.5 |
| 依赖任务产物交接 | 已实现（上游已交付 diff 先进入下游副本并在新基线提交），有行为测试；修复基线起安装 |
| 独立审查、正式测试、证据绑定 | 已实现并有真实日志 |
| 候选包构建、安装与恢复入口 | 已实现；V0 已验证，V1 见 §2.4 |
| 专用 profile 安装 | **已执行**：`~/.dsh/profiles/forgeloop`（headless 模板）安装 V1 tarball，真实模型调用 `forgeloop_status` 成功；启动需提供 `QWEN_TOKEN_PLAN_CN_API_KEY` 或在 Models 页登记 |
| 桌面 profile（`~/.dsh/profiles/desktop`） | **2026-10-23 已安装当前构建**：通过 `plugin_manager` 安装候选 tarball（`application: applied`），重载即时生效、页面刷新后显示真实数据；记录根配置仍在 `cordis.patch.yml`。应用独占管理该 profile，CLI 拒绝直接启动/转储 |
| 常驻宿主中断开客户端后继续推进 | **未单独执行**：协调器行为有单测与真实命令链路；验证宿主是无头的一次性进程，不等同浏览器长连 |
| GitHub Actions | 工作流已改为 Node/TypeScript（quality/nightly）；**未推送、未在 GitHub 执行**，本地只验证了同一组 `make` 命令 |
| 容器/OS 级审查隔离 | 未接入；当前是独立会话＋无工具＋固定 diff |
| 多用户、远程访问、邮件/IM、发布/部署 | 不在首版范围 |
| 覆盖率 | 已接入：行/语句 **92.16%**、函数 **95.45%**、分支 **85.1%**；门槛 90/90/93/84（`vitest.config.ts`） |
| 变异、格式化 | 未接入；目标显式失败 |
| 依赖审计 | 已配置；本机受限缓存下未验证，CI 网络环境执行 |
| DSH 跨版本兼容 | 未验证；本机仅 0.2.1-rc.2 |

## 5. 环境与版本（本机实测）

- DSH `0.2.1-rc.2`（`/opt/homebrew/bin/dsh`）；Node `v26.11.1`；npm `11.20.0`；
- TypeScript `5.9.3`（`node_modules/typescript`）；SQLite 通过 `node:sqlite`；
- 验证 DSH_HOME：`.cache/forgeloop/dsh-home`（profile `forgeloop`，不入库）；
- 模型路由：`qwen-token-plan-cn / deepseek-v4.1-flash-1017`，凭据由启动环境提供，未写入仓库。

## 6. 旧实现处置与未完成事项

- Python 源码、旧测试、旧前端、旧脚本与旧配置已移入 `legacy/`（`.venv`、`node_modules`、
  `mutants` 等生成物已删除）。活动构建、检查与运行不引用 `legacy/`；`make architecture-contract`
  通过。
- 旧 docs 已移入 `docs/history/`，ADR 链接改指历史路径；当前文档链接检查 0 处断裂。
- 旧记录库兼容读取已实测（旧需求 `req-20261021015151-fbbc3f` 可在新 `/fl status` 中查到）。
- 真实发布、部署、回滚、备份未执行；“发现但不碰”的问题保留在批次记录，不借迁移顺手修改。
- 文档、契约与安装版本已按最终状态同步；未执行检查在[交付记录](delivery/2026-10-22-typescript-dsh.md)
  中逐条标注。