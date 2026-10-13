# ForgeLoop DogFood 执行任务计划

状态：方案草案，未实施。依据 2026-10-13 对 HEAD d1f1582 及当时工作区的核查；实施前再次读取实际基线。本文不启用 DogFood 窗口，不授权提交、发布或部署。

## 当前采用的执行方式

DSH 的协调 Agent 负责拆解这份计划、安排依赖、准备输入、跟踪记录与组织人工批准。三个业务 Agent 负责各自任务，逐项操作当前可运行的 ForgeLoop CLI。初期仍需 DSH 明确填写 goal、scope、acceptance、baseline、pi_command、test_command 和独立 records-root；这些由人或外层 Agent 准备的步骤必须标记，不算 ForgeLoop 自动分析或自动拆解。

任务执行应优先经过现有 submit → approve → PI → review → test → acceptance。尚未具备的能力先在本计划的执行任务中实现。若现有 ForgeLoop 无法承载某个必要启动任务，提交最小 bootstrap 方案，列明阻塞证据与精确文件范围，由所有者单项授权外部修复；不能自行改源码后补挂任务 ID。bootstrap 和 DogFood 交付分别统计。

人工继续负责明确方案、追加、验收和发布决定；已有与本任务对应的批准可复用，不重复询问，也不能把总体建设意图当作任意文件或发布的批准。

## 并行组织

协调 Agent 先完成 T00/T01 的基线核查与业务交接约定。随后需求规划 Agent 执行 A01，研发交付 Agent 执行 B01，版本交付 Agent 执行 C01，三条线并行开始。

每条线使用独立代码副本、记录目录和会话；同一任务只允许一个执行者。各线内部按依赖顺序执行。开发期可用契约样例验证交接；样例、替身与模拟服务不能作为真实场景验收依据。

同一文件的不同函数可在独立副本中开发，但协调 Agent 必须记录重叠范围，并通过单独的 ForgeLoop 集成任务合成、验证。任何基线漂移都要核对影响并重新绑定有效批准；不直接拼接旧 diff 沿用旧验收。

依赖默认指上游实现可调用且独立行为验证通过，不表示其真实联合场景已经验收。每项同时记录“实现/独立验证”和“集成/真实验证”的状态；联合场景由 G01-G04 收口，不能因等待集成而造成循环依赖。

以下文件范围均为拟批准范围。每任务除自身列出的文件外，包含 docs/architecture.md 与 contracts/architecture.json 的必要同步；改变 CLI 契约的任务另包含 scripts/export_cli_contract.py 与 contracts/cli-contract.json。只允许与该任务相关的同步，不顺手修文档或重构。发现必须扩大范围时提交方案评审。

## 通用任务执行单

每项开始前填写：业务场景、具体输入、预期行为、依赖任务、执行版本与基线、准许修改的文件、正式测试命令、允许的资源、工时限制、批准来源。

关键行为先写并运行失败的行为测试，再由 PI 实现；缺依赖或配置错误不能充当行为失败。之后运行该任务的验证命令和 make check。新测试路径须先创建测试再执行；本计划列出的新命令与新文件当前均不代表已经实现。

交付记录至少包含任务 ID、范围与方案版本、初始失败证据、独立审查、实际命令与日志、候选身份、未验证项和发现但不碰。提交必须另有所有者授权，并遵守真实 Asia/Shanghai 提交时段；不修改策略或伪造时间绕过。

## 执行任务

### T00：冻结可运行基线与执行环境

- 执行者：协调 Agent
- 依赖：无
- 执行内容：清点现有未提交改动及归属；选择已提交、可复现的基线；核查 DSH 的 Python/uv/PI、模型、容器、测试资源与 hooks；分别准备独立记录根和代码副本；记录稳定执行版本与开发目标版本。
- 拟修改范围：只读核查与批准后的环境准备；本任务不修改产品源码。保留当前在途架构契约改动，不替其他会话提交或覆盖。
- 验证：选定基线上的 make check；CLI --help；无模型协议检查；经预算允许的最小真实模型调用。分别保存结果。
- 交付与退出条件：能明确说明实际运行的是哪个 ForgeLoop 版本、目标基线和每条线的现场；配置与模型不可用时记录具体阻塞。

### T01：固定三个业务交接约定

- 执行者：协调 Agent
- 依赖：T00
- 执行内容：约定 Requirement/TaskPlan、验收包、候选产物/发布回执的字段、身份关系和状态词；明确需求到任务的批准传播、依赖产物传递、候选提交和用户验收的先后顺序；逐任务确认文件范围。
- 拟修改范围：docs/dogfood-contracts.md（新增）；docs/product-requirements.md；docs/roadmap.md。
- 验证：人工逐字段核对：任务可追溯到原始需求和批准版本；候选代码、测试、产物与验收能关联；新业务范围与旧文档不矛盾。
- 交付与退出条件：三个业务 Agent 使用同一交接约定；全部新命令明确标为拟实现，不凭不存在的接口开始自动运行。

### A01：用户提交需求并可回查、补充原始材料

- 执行者：需求规划 Agent
- 依赖：T01
- 执行内容：新增需求级身份和原始文本记录；补充说明保留版本与原文；提供需求提交和查询入口；需求记录与既有执行任务区分。
- 拟修改范围：src/forgeloop/domain/requirement.py（新增）；src/forgeloop/records/requirements.py（新增）；src/forgeloop/cli/requirements.py（新增）；tests/scenario/test_requirement_input.py（新增）。入口注册归入 I01。
- 验证：.venv/bin/pytest tests/scenario/test_requirement_input.py -q；make check。
- 交付与退出条件：提交真实文本后退出、重启仍可查原文和补充记录；不同项目的需求不能混用；未知身份得到明确失败。

### A02：系统分析需求并发起必要澄清

- 执行者：需求规划 Agent
- 依赖：A01
- 执行内容：增加只读分析角色，通过 PI 生成目标、业务场景、验收标准和待澄清项；校验结果；回答澄清后重新分析并保留版本；分析阶段不改代码。
- 拟修改范围：src/forgeloop/graph/planning.py（新增）；src/forgeloop/domain/requirement.py；src/forgeloop/records/requirements.py；src/forgeloop/cli/requirements.py；tests/scenario/test_requirement_analysis.py（新增）。
- 验证：.venv/bin/pytest tests/scenario/test_requirement_analysis.py -q；make check；另保存一次真实模型分析及澄清记录。
- 交付与退出条件：清楚需求产生可审阅分析；缺关键信息时等待回答；畸形结果如实阻塞；没有批准执行时源代码无变化。

### A03：生成可批准、可执行的任务包

- 执行者：需求规划 Agent
- 依赖：A02
- 执行内容：从分析生成少量任务：每项有目标、文件清单、验收、测试、依赖和限额；校验循环、缺失依赖、跨项目和无有效测试；批准绑定需求身份与任务包版本；明确任务级授权来源。
- 拟修改范围：src/forgeloop/domain/task_plan.py（新增）；src/forgeloop/graph/planning.py；src/forgeloop/records/requirements.py；src/forgeloop/cli/requirements.py；tests/unit/test_task_plan.py（新增）；tests/property/test_task_plan.py（新增）；tests/scenario/test_requirement_planning.py（新增）。
- 验证：.venv/bin/pytest tests/unit/test_task_plan.py tests/property/test_task_plan.py tests/scenario/test_requirement_planning.py -q；make check；核心纯规则纳入变异范围并验证，配置更新由 I02 处理。
- 交付与退出条件：一条需求能够形成至少两个有意义且有依赖的任务；未批准不执行，旧版本批准不能驱动新任务包。

### A04：按依赖推进任务并汇总需求状态

- 执行者：需求规划 Agent
- 依赖：A03、B02、B03
- 执行内容：先实现需求内按依赖串行推进；将前置任务的已确认产物作为显式输入交给下游副本；汇总阻塞原因、当前任务和下一步动作；所有任务完成后仍需需求整体验收。
- 拟修改范围：src/forgeloop/graph/requirements.py（新增）；src/forgeloop/records/requirements.py；src/forgeloop/cli/requirements.py；tests/scenario/test_requirement_execution.py（新增）。既有运行入口和状态字段接线归入 I01。
- 验证：.venv/bin/pytest tests/scenario/test_requirement_execution.py -q；make check；完成一次真实两个任务的顺序推进并核对依赖输入身份。
- 交付与退出条件：前置失败不启动下游；下游读到正确前置产物；等待不消耗执行工时；状态能说明下一步需要谁做什么。

### A05：多个需求并行推进、同项目交付串行

- 执行者：需求规划 Agent
- 依赖：A04、B03、C02、I01
- 执行内容：复用现有业务图，以最小进程级执行支持两个独立需求；独立现场与记录身份，限制并发资源；重复启动同一需求被拒；同项目归并/发布通过程序互斥串行，不依赖 DSH 口头安排。
- 拟修改范围：src/forgeloop/graph/dispatch.py（新增）；src/forgeloop/graph/requirements.py；src/forgeloop/records/actions.py（执行槽位部分，与 B03 明确分工）；src/forgeloop/cli/requirements.py；tests/scenario/test_parallel_requirements.py（新增）。
- 验证：.venv/bin/pytest tests/scenario/test_parallel_requirements.py -q；make check；真实两个需求并行执行和同项目交付排队。
- 交付与退出条件：不同需求能同时推进、不串记录；同需求不重复运行；同项目主干更新不发生竞争；保持批准与工时不变量，不建设通用调度平台。

### B01：PI 在批准现场开发并产生真实候选

- 执行者：研发交付 Agent
- 依赖：T01
- 执行内容：固定候选工作目录、不可变初始基线和测试环境；实现并验证一种受限执行方式，源库/main 和批准记录不向 PI 暴露写权限；保存原生会话与可取得轨迹；候选 diff 始终针对批准基线；范围外改动阻断交付。
- 拟修改范围：src/forgeloop/adapter/pi_rpc.py；src/forgeloop/adapter/git_workspace.py；src/forgeloop/adapter/execution_environment.py（新增）；runtime/Dockerfile（新增，若选定容器）；src/forgeloop/graph/nodes.py；tests/unit/test_git_workspace.py；tests/integration/test_execution_environment.py（新增）。
- 验证：.venv/bin/pytest tests/unit/test_git_workspace.py tests/integration/test_execution_environment.py -q；make check；真实受限环境中运行 PI 的文件修改与主干写入拒绝检查。
- 交付与退出条件：PI 真实修改批准副本，源 main 无变化；副本内提交/HEAD 变化不会丢失改动；副本测试确实加载候选代码。

### B02：实现、审查、正式测试和反馈修复闭环

- 执行者：研发交付 Agent
- 依赖：B01
- 执行内容：开发提示包含批准测试命令、自验证要求和当前尝试；审查提示包含范围、验收、候选副本和结果契约；将审查阻断和实际测试日志传回下一轮；结果缺失时阻塞；保留每轮记录。
- 拟修改范围：src/forgeloop/graph/nodes.py；src/forgeloop/graph/prompts.py（新增）；tests/unit/test_nodes.py；tests/scenario/test_flow.py；tests/integration/test_pi_task_live.py（新增）。
- 验证：.venv/bin/pytest tests/unit/test_nodes.py tests/scenario/test_flow.py -q；make check；经显式预算许可运行一次真实 PI 开发、审查和正式测试链。
- 交付与退出条件：有缺陷的候选收到具体反馈并被修复；真实测试失败计一轮；三次后等待追加，累计保留；模型异常不伪装通过。

### B03：运行中停止、中断及重复调用得到明确处理

- 执行者：研发交付 Agent
- 依赖：B02
- 执行内容：持久化动作启动/完成身份；拒绝对未核对动作重放；任务创建、批准消费和工时更新具备原子性；同任务并发启动只允许一个；停止请求与确认区分，运行工具和实际副作用可核对。
- 拟修改范围：src/forgeloop/records/store.py；src/forgeloop/records/actions.py（新增）；src/forgeloop/graph/nodes.py；tests/unit/test_store.py；tests/scenario/test_guards.py；tests/integration/test_action_lifecycle.py（新增）。CLI 决定阶段校验归入 I01。
- 验证：.venv/bin/pytest tests/unit/test_store.py tests/scenario/test_guards.py tests/integration/test_action_lifecycle.py -q；make check。使用真实进程中断、两个 SQLite 连接和写入故障注入。
- 交付与退出条件：开发中杀进程后再次批准不重放；两个调用只有一个消费成功；2 秒累计保存 2 秒；创建失败无半条任务；停止最终状态有事实依据。

### B04：用户验收绑定实际候选及需求整体结果

- 执行者：研发交付 Agent
- 依赖：B03；与 C01 的产物契约已一致
- 执行内容：汇总全部任务的业务验证；验收绑定任务包版本、候选代码/提交、真实测试、独立审查和产物校验身份；批准后材料变化使决定失效；验收拒绝回到对应任务且累计保留。
- 拟修改范围：src/forgeloop/domain/delivery.py（新增）；src/forgeloop/domain/approval.py；src/forgeloop/records/store.py；src/forgeloop/graph/nodes.py；tests/unit/test_approval.py；tests/scenario/test_delivery_binding.py（新增）。
- 验证：.venv/bin/pytest tests/unit/test_approval.py tests/scenario/test_delivery_binding.py -q；make check；新增批准/内容绑定规则补属性和变异检查。
- 交付与退出条件：代码验收先绑定不可变候选与测试证据；C01 交接后再完成产物/需求整体验收绑定。替换 diff、测试或产物后不能沿用原批准；单个任务通过不自动等于需求整体验收。

### C01：构建并验证待验收的候选版本

- 执行者：版本交付 Agent
- 依赖：T01；可先按交接约定独立开发
- 执行内容：从候选分支的确定提交构建一次 wheel；在独立安装环境验证业务行为；保存构建运行身份、提交、资产位置与 SHA256；把候选产物结果交给 B04。候选提交必须获得授权并在合法时段创建。
- 拟修改范围：src/forgeloop/domain/artifact.py（新增）；src/forgeloop/cli/candidate.py（新增）；src/forgeloop/adapter/artifact.py（新增）；src/forgeloop/adapter/git_workspace.py（仅候选分支相关函数）；.github/workflows/candidate.yml（新增）；tests/scenario/test_candidate_artifact.py（新增）。
- 验证：.venv/bin/pytest tests/scenario/test_candidate_artifact.py -q；make check；在真实候选 CI 上构建和独立安装测试一次，记录原始证据。
- 交付与退出条件：候选构建与独立安装接口可用；真实上游交接后，用户验收前已有实际构建并验证的产物；测试对象为该 wheel。单独接口验证不能记为真实业务交付。

### C02：验收成果受控归并并发布同一产物

- 执行者：版本交付 Agent
- 依赖：B04、C01；正式端到端依赖 I01
- 执行内容：校验验收内容身份与全部必需检查；未知检查状态不放行；归并经验证的同一候选 SHA；main 漂移时重新核对验证和验收；Release 复用 C01 的已验收产物，不在标签工作流重新构建。
- 拟修改范围：src/forgeloop/domain/merge.py；src/forgeloop/domain/release.py；src/forgeloop/cli/merge.py；src/forgeloop/cli/release.py；.github/workflows/release.yml；tests/unit/test_merge.py；tests/scenario/test_merge_flow.py；tests/scenario/test_self_iteration.py。
- 验证：.venv/bin/pytest tests/unit/test_merge.py tests/scenario/test_merge_flow.py tests/scenario/test_self_iteration.py -q；make check；真实候选检查、归并、标签与 Release 路径。
- 交付与退出条件：验收内容漂移被拒；未知/失败检查被拒；Release wheel 的 SHA256 等于验收产物；重试不制造新发布身份。

### C03：新版本部署可用并能恢复稳定执行版本

- 执行者：版本交付 Agent
- 依赖：C02
- 执行内容：使用已安装的受控执行版本下载并部署同一资产；记录当前/上一版本、校验值与业务冒烟；真实演练两版本回滚；核对任务记录的数据兼容，兼容不明则阻断切换；保留独立恢复入口。
- 拟修改范围：src/forgeloop/domain/deploy.py；src/forgeloop/adapter/deployment.py；src/forgeloop/cli/deploy.py；.github/workflows/deploy.yml；docs/deployment.md；tests/scenario/test_deployment.py；tests/scenario/test_deployment_refusals.py。
- 验证：.venv/bin/pytest tests/scenario/test_deployment.py tests/scenario/test_deployment_refusals.py -q；make check；在批准的真实 Debian 目标完成部署、业务冒烟、回滚和记录回读。
- 交付与退出条件：新版本能处理实际业务；失败有明确回执；无需调用坏掉的新版本即可恢复旧版本；回滚后既有记录可读取。

### C04：建立可验证的 DogFood 提交来源

- 执行者：版本交付 Agent
- 依赖：B04、C02；先在专用验证分支测试，正式时间窗在 G04 启用
- 执行内容：受控执行端生成回执，绑定需求、任务、批准、基线、候选内容、测试与提交；证据与签发权限放在 PI 可写候选之外；可信校验端验证来源和内容；服务端准入与限定写入身份单独验证，不让允许写入的身份绕过质量门槛。
- 拟修改范围：scripts/check_dogfood_provenance.py（新增）；config/dogfood-policy.toml（新增）；.github/workflows/quality.yml；src/forgeloop/cli/merge.py；tests/unit/test_dogfood_provenance.py（新增）；tests/scenario/test_dogfood_gate.py（新增）；docs/branch-protection.md。
- 验证：.venv/bin/pytest tests/unit/test_dogfood_provenance.py tests/scenario/test_dogfood_gate.py -q；make check；真实验证无回执、伪造任务 ID、内容漂移和非授权更新被拒绝。
- 交付与退出条件：技术门禁能拒绝普通直接提交或补挂任务 ID；证据不可由实现 PI 自行伪造；未完成服务端验证时只标为待启用。

### I01：把三条业务线接到真实可调用入口

- 执行者：协调 Agent
- 依赖：A04、B04、C02
- 执行内容：通过独立 ForgeLoop 集成任务注册需求/候选入口，装配需求到任务的图与业务记录；既有单任务命令保持可用；每条状态转换有明确调用者与批准绑定。
- 拟修改范围：src/forgeloop/cli/main.py；src/forgeloop/graph/builder.py；src/forgeloop/graph/state.py；src/forgeloop/graph/nodes.py；src/forgeloop/records/store.py；tests/scenario/test_full_development_flow.py（新增）；tests/system/test_requirement_process.py（新增）。不在此阶段混入一般重构。
- 验证：.venv/bin/pytest tests/scenario/test_full_development_flow.py tests/system/test_requirement_process.py -q；make check。
- 交付与退出条件：从真实 CLI 能逐步执行需求受理、澄清、批准、任务推进、验收、归并与发布；系统自身状态可回查，不依赖 DSH 私有内存记录。

### I02：同步范围、架构、质量门槛和操作说明

- 执行者：协调 Agent
- 依赖：I01；各批次按影响及时同步
- 执行内容：按新增业务流程更新产品需求/路线图和架构描述；补 CLI/架构快照；把新纯规则纳入属性和变异范围；为 DSH 写实际命令与人工介入说明；执行记录仅登记实际结果。
- 拟修改范围：docs/product-requirements.md；docs/roadmap.md；docs/architecture.md；docs/status.md；docs/engineering-reliability.md；CONTEXT.md；README.md；pyproject.toml；config/quality-policy.toml；contracts/architecture.json；contracts/cli-contract.json；scripts/export_cli_contract.py。
- 验证：make architecture-contract；make cli-contract；make check；make coverage；make test-system；按影响运行真实集成、变异和安全检查。
- 交付与退出条件：文档描述与源码契约一致；所有统计明确运行基线、环境与未执行项；不以模拟场景证明完整产品通过。

### G01：首次真实单任务 DogFood 验收

- 执行者：协调 Agent及所有者
- 依赖：B01-B04；当前 CLI 可先在 I01 前验证
- 执行内容：选择真实小需求：status --json 增加明确下一步动作、动作主体和阻塞原因。由 DSH 先准备清楚的任务参数，通过 ForgeLoop 完成实际实现、独立审查、正式测试和用户验收。人工准备的分析/任务标记为人工。
- 拟修改范围：实际开发子任务范围：src/forgeloop/domain/status.py（新增）、src/forgeloop/cli/main.py、tests/unit/test_status.py（新增）、tests/component/test_cli.py、tests/component/test_cli_contract.py、scripts/export_cli_contract.py、contracts/cli-contract.json，及必要架构同步。先批准这份清单，再由 ForgeLoop 实施；验收不偷偷追加功能。
- 验证：真实 PI 工具与会话、候选 diff、实际正式测试、审批记录；旧契约兼容或明确变更；真实状态场景覆盖。
- 交付与退出条件：证明现有任务执行链能改进 ForgeLoop；仅记为单任务 DogFood，不宣称需求分析、拆解与部署已经自动完成。

### G02：完整需求到部署的真实 DogFood 验收

- 执行者：协调 Agent及所有者
- 依赖：A04、I01、I02、C03、G01
- 执行内容：选择另一条真实需求，从新需求入口分析、澄清并拆成至少两个有意义任务；系统按依赖推进，完成整体验收、同产物发布与部署，回查原始记录。
- 拟修改范围：本轮输入固定为：需求/任务查询增加依赖阻塞说明和交付证据汇总。至少拆成“依赖事实与阻塞判断”和“CLI 展示与契约”两个真实任务；由新规划能力提出精确文件清单并经所有者批准。版本号和部署目标明确指定，验收过程不偷偷追加功能。
- 验证：每阶段真实模型/工具/测试/批准证据；部署后验证业务场景；核对全部任务归属、依赖和最终产物 SHA256。
- 交付与退出条件：第一次可以合理声称完整自动研发业务链跑通；保留人工批准，但 DSH 不再逐项手填或调度内部任务。

### G03：异常业务与并行交付验收

- 执行者：协调 Agent及所有者
- 依赖：G02、A05、C04
- 执行内容：受控演练失败修复、三轮等待追加、运行中断待核对、验收漂移拒绝；并行执行两个独立真实需求，核对记录、授权、工时和归并顺序；备份完成任务到真实独立硬盘并回读。
- 拟修改范围：演练脚本及测试若需入库另给精确批准范围；生产主干不部署故意有缺陷的候选。
- 验证：真实过程记录和可重跑负例分别保存；同任务并发只启动一次；跨需求不会串记录；真实回滚与备份可回读。
- 交付与退出条件：并行自迭代有业务与恢复证据；单元测试绿不能替代该门槛。

### G04：启用限时严格 DogFood

- 执行者：协调 Agent及所有者
- 依赖：G03；可信来源与服务端门槛已验证
- 执行内容：登记起止时间、基线、稳定执行版本、保护范围和单项救援流程；建议首窗 7 天，由所有者确认实际日期；将规则与 DSH Prompt 落库；窗口内来源门禁生效，到期复盘交付、失败、阻塞和救援记录。
- 拟修改范围：AGENTS.md；CONTRIBUTING.md；docs/development-discipline.md；docs/dogfood-policy.md（新增）；docs/prompts/dsh-dogfood-development.md（新增）；config/dogfood-policy.toml；docs/status.md。
- 验证：启用前后负例验证；确认外部直接修改/提交不能进入受控主干，ForgeLoop 正常交付可进入；救援记录与成功 DogFood 分开。
- 交付与退出条件：此时才启用排他时间窗；不补挂历史任务、不修改提交时段策略、不声称本计划已经完成。

## 实际启动顺序

1. T00/T01 完成基线与交接确认。
2. A01、B01、C01 并行启动；各线后续按各自依赖推进，未等到真实上游时可以开发和验证接口，但状态必须标记为未集成。
3. B01-B04 形成可用单任务执行链后，尽早执行 G01。不要等需求规划或完整部署全部完成才首次验证真实代码交付。
4. A04/B04/C02 完成后执行 I01/I02，再以 C03 和 G02 验收完整业务链。
5. A05/C04/G03 证明来源、异常、并行与恢复能力后，才执行 G04。

## 每次进度报告

逐任务报告未开始/方案待批准/测试已失败/实现中/待审查/测试通过/待真实验证/已验收/阻塞；附真实任务 ID、基线、文件、证据和下一步。业务场景通过之前不能只凭修复数量、覆盖率或进程退出 0 标记完成。

同一需求若需要新的范围、基线或方案版本，先列明差异并重新取得对应批准；所有者已授权的事项继续执行，普通状态汇报不应成为无谓的等待点。
