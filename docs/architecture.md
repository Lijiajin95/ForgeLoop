# ForgeLoop 架构说明

本文描述 **`src/forgeloop` 已实现的实际架构**：分层、模块职责、依赖方向、业务图、持久化与外部边界。它不描述尚未实现的设计意图，也不记录当前验证数字。

| 想知道 | 看哪里 |
| --- | --- |
| 架构长什么样（已实现） | 本文，以及机读快照 `contracts/architecture.json` |
| 为什么这样选（方向性决策） | `docs/adr/` |
| 首版做哪些需求 | `docs/product-requirements.md` |
| 现在跑到哪一步、验证数字 | `docs/status.md` |
| 工程门槛与统计口径 | `docs/engineering-reliability.md` |
| 领域词义 | `CONTEXT.md` |

**维护义务（强制）**：架构变化必须与本文、`contracts/architecture.json` 在同一次改动中同步更新。该义务由 `scripts/export_architecture_contract.py --check`（`make check` 的一环）机器强制；判定标准与流程见第 9 节。

## 1. 系统上下文

ForgeLoop 是单用户、单执行现场的本地 CLI 工具：一次推进一个任务，需求内的任务按依赖串行执行。操作者是任务所有者，负责方案／任务包与验收批准、追加授权，以及需求整体验收决定。

```mermaid
flowchart LR
  Owner[所有者] -->|submit approve grant stop status requirement| CLI[forgeloop CLI]
  CLI -->|merge release| Git[(Git 仓库与远程)]
  CLI -->|deploy rollback| Prefix[本机部署前缀]
  CLI -->|JSONL RPC| PI[pi --mode rpc 子进程]
  CLI -->|受控命令| Project[被测项目测试命令]
  CLI -->|check-runs releases| GitHub[(GitHub REST)]
  PI -->|在代码副本内改文件| WS[执行现场]
  Project --> WS
```

外部系统共六类，都是真实外部边界，不是可忽略的实现细节：PI RPC 子进程、git CLI 与真实仓库、GitHub REST（公开数据可匿名读；检查读取用 `GITHUB_TOKEN`／`GH_TOKEN` 提高配额，未提供即匿名）、本机部署前缀（符号链接＋独立 venv）、被测项目的测试命令进程、系统时钟。

## 2. 分层与依赖方向

包按职责分六层，外加进程入口。层是**物理目录**，不是抽象概念：模块名形如 `forgeloop.<层>.*`。

```mermaid
flowchart TD
  Main["__main__<br/>进程入口"] --> CLI["cli<br/>命令解析与驱动"]
  CLI --> Graph["graph<br/>LangGraph 业务编排"]
  CLI --> Adapter["adapter<br/>外部边界"]
  CLI --> Records["records<br/>权威记录"]
  CLI --> Domain["domain<br/>纯领域规则"]
  Graph --> Adapter
  Graph --> Records
  Graph --> Domain
  Records --> Domain
  Mail["mail<br/>邮箱接口与纯逻辑（仅标准库）"]
```

允许的依赖方向（`scripts/export_architecture_contract.py` 的 `LAYER_RULES`；机读事实见 `contracts/architecture.json` 的 `layer_edges`）：

| 层 | 允许依赖 | 实际跨层边 |
| --- | --- | --- |
| `(root)`（顶层包） | 无 | 无 |
| `__main__` | `cli` | → `cli` |
| `cli` | `graph`、`adapter`、`records`、`domain` | → `graph`、`adapter`、`records`、`domain` |
| `graph` | `adapter`、`records`、`domain` | → `adapter`、`records`、`domain` |
| `adapter` | 无 | 无 |
| `records` | `domain` | → `domain` |
| `domain` | 无 | 无 |
| `mail` | 无（只依赖标准库） | 无（当前尚无实现模块） |

三条硬规则，由门槛强制：

1. **`domain` 是纯规则层。** 不依赖任何内部模块、`langgraph` 或第三方编排库；已知的内部依赖是 `domain.deploy` → `domain.release` 与 `domain.repo_facts` → `domain.task_plan`（均为同层）。
2. **`adapter` 与 `mail` 是叶子层。** 二者都不 import 任何 `forgeloop.*`，只用标准库；适配器不知道领域规则与记录结构，邮箱层只提供接口与纯逻辑。
3. **模块依赖图无环。** 跨层与同层边一起检查。

`pyproject.toml` 的 `[tool.importlinter]` 另有两条同型的 `forbidden` 契约：禁止 `forgeloop.domain` 依赖 `cli`／`graph`／`adapter`／`langgraph`，禁止 `forgeloop.mail` 依赖 `cli`／`graph`／`records`／`adapter`／`langgraph`。本文的 `LAYER_RULES` 是覆盖全部层的更完整版本。

## 3. 模块清单

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 顶层 | `src/forgeloop/__init__.py` | 包声明，无逻辑 |
| 入口 | `src/forgeloop/__main__.py` | `python -m forgeloop` 入口，转调 `cli.main` |
| domain | `src/forgeloop/domain/__init__.py` | 层声明与分层契约指向 |
| domain | `src/forgeloop/domain/counting.py` | 失败轮次账本 `GrantLedger`：按 `round_id` 幂等计数、每次授权 3 轮、追加授权累加不清零 |
| domain | `src/forgeloop/domain/status.py` | 任务状态 → 下一步动作的纯映射：动作、主体（user／agent）与阻塞／等待原因；未知状态落到人工核对 |
| domain | `src/forgeloop/domain/dependency_facts.py` | 依赖事实与真实阻塞判定的纯规则：前置未达 accepted／delivered 等终态即未满足；有未满足前置且无 `started` 未完成动作才判 `waiting`；状态词滞后不判阻塞；依据缺失输出 `unknown` 并列出缺少的记录 |
| domain | `src/forgeloop/domain/status_reason.py` | 中文阻断原因 `blocked_reason_text` 的纯推导：只读权威事实（任务／方案／批准／动作／失败轮次／授权／工时／终态），主句按固定优先级（等待人工决定 → 依赖未满足 → 失败轮次用尽 → 运行中 → 已终态）选取，句末「；另外还有…」最多补两条其他成立条件；依据缺失输出 `unknown` 并列出缺少的记录 |
| domain | `src/forgeloop/domain/requirement.py` | 需求身份与版本规则：`req-<project>-<seq>` 项目内唯一、原文本与追加版本不可覆盖、未知身份明确失败；只读分析的结构化校验（A02）也落在本模块 |
| domain | `src/forgeloop/domain/task_plan.py` | 任务包规则：从分析产出至少两个有依赖的任务；未批准不执行；旧版本或过期批准不能驱动最新任务包 |
| domain | `src/forgeloop/domain/repo_facts.py` | 仓库布局事实与任务包合规校验：源码根与合法源码分层从机读架构契约 `contracts/architecture.json` 的 `modules`／`layer_edges` 动态解析，契约缺失或损坏时导入不崩溃并对路径 fail-closed；测试分层、契约快照、可用解释器与门禁命令仍为固定事实；纯规则校验文件清单与测试命令，逐条给出具体路径／命令与原因 |
| domain | `src/forgeloop/domain/artifact.py` | 候选产物身份与校验规则：wheel 文件名 + SHA256、同一候选重复构建的一致性判定、未授权提交拒绝 |
| domain | `src/forgeloop/domain/limits.py` | 执行时间账目 `ExecutionBudget`：只记实际执行耗时、超限停止启动新动作、显式延长 |
| domain | `src/forgeloop/domain/budget_summary.py` | 工时摘要 `BudgetSummary` 的只读纯规则：无 budget 行且状态未开始记为 `not_started` 且不产生 0 秒歧义；有 budget 行输出 `consumed_seconds`／`limit_seconds`／`exhausted`；存在性与状态冲突以存在 budget 行为准输出 `unknown` 并说明冲突；`dimensions` 当前仅 `seconds` |
| domain | `src/forgeloop/domain/approval.py` | 方案 `Plan` 与批准 `Approval`：批准绑定任务身份与方案版本，一次批准只能触发一次执行；验收批准还绑定实际交付材料（候选 diff、测试证据、审查结论、产物校验值），替换材料后原批准失效 |
| domain | `src/forgeloop/domain/delivery.py` | 交付绑定 `DeliveryBinding` 与需求整体验收判定：候选 diff／测试证据／审查结论／产物校验值各自内容寻址；材料变化使批准失效；单个任务通过不等于需求整体验收 |
| domain | `src/forgeloop/domain/commit_policy.py` | 提交时间策略与年度工作日历判定、Conventional Commits 首行校验；仓库默认与本地覆盖的键级合并、生效策略来源与机器标签 |
| domain | `src/forgeloop/domain/merge.py` | 归并就绪判定与必需检查判定（候选分支 → 检查 → 快进 main） |
| domain | `src/forgeloop/domain/release.py` | 发布就绪判定、版本标签解析、发布记录 `ReleaseRecord`、同标签幂等／换标签拒绝 |
| domain | `src/forgeloop/domain/deploy.py` | 部署与回滚就绪判定、`SHA256SUMS` 解析、产物唯一选择（拒绝重新构建） |
| domain | `src/forgeloop/domain/mail.py` | 邮件需求领域规则：三类分类建议（消歧／不接纳候选／接纳成功）、消歧轮次上限 3 轮后退回人工、终态不再提问、7 天无回复单次提醒与开关、回复关联按 `In-Reply-To`／`References`／主题／正文回退解析（`req-…` 与 `#req-…` 都接受）、中文纯文本固定模板渲染；附件只记录元数据 |
| records | `src/forgeloop/records/__init__.py` | 层声明 |
| records | `src/forgeloop/records/store.py` | `RecordStore`／`OutcomeStore`：SQLite 15 张表的权威业务记录，读时重建领域对象；`read_task_dependency_record` 只读汇总单任务终态、`started` 动作与失败轮次事实；`prerequisite_applications` 固化下游任务各前置候选的应用状态与原因（幂等判定与回退依据）；旧库缺少动作进程列时显式补列 |
| records | `src/forgeloop/records/actions.py` | `ActionStore`：动作启动/完成身份、进程身份与心跳，以及单任务并发占用；未完成动作拒绝重放；按权威记录判定槽位残留（空闲／已死／存活／不确定），只清理已死残留并写入 `slot_cleanups`，不确定时不清理并给出原因 |
| records | `src/forgeloop/records/checkpoints.py` | 只读读取记录根下 `checkpoints.sqlite` 的 LangGraph 检查点：给出待执行节点、`halted_reason` 与检查点身份，判定可续跑业务节点（`dev`/`review`/`test` 及自动回边）与等待人工决定（计划批准、追加授权、整体验收、终态、空 `next`）；以 `actions.action_id` 去重判断重复推进，记录缺失输出 `unknown` |
| records | `src/forgeloop/records/requirements.py` | 需求记录：需求、版本、分析、任务包、批准、任务推进、产物与需求工时共 8 张表；与任务记录同一 `records.sqlite`，提交原文、追加版本、按身份与项目回查（进程重启后仍可读）；`dependency_facts` 按任务包依赖只读汇总每个任务的依赖事实 |
| adapter | `src/forgeloop/adapter/__init__.py` | 层声明 |
| adapter | `src/forgeloop/adapter/commit_policy.py` | 本机提交策略覆盖的 IO 边界：读取仓库默认配置与年历，按固定优先级二选一发现并读取本地覆盖 TOML（仓库内 `.cache` 或用户级 `~/.config`），只返回原始文档，不做合并 |
| adapter | `src/forgeloop/adapter/pi_rpc.py` | `PIProcess`：JSONL RPC 子进程、命令／响应 id 关联、`agent_settled` 判定、abort、会话与 stderr 落盘 |
| adapter | `src/forgeloop/adapter/test_runner.py` | `run_test_command`：以 argv＋`shell=False` 运行批准的测试命令，证据追加 JSONL |
| adapter | `src/forgeloop/adapter/git_workspace.py` | 独立代码副本、基线 detached 检出、候选 diff 提取、受控归并与标签 |
| adapter | `src/forgeloop/adapter/github_checks.py` | 读取提交的 check-runs（有 `GITHUB_TOKEN`／`GH_TOKEN` 则按认证配额，否则匿名），归一为「名称 → 结论」或 `pending`；403/429 归一为带剩余量与重置时刻的配额耗尽错误 |
| adapter | `src/forgeloop/adapter/deployment.py` | 下载 Release 资产、独立版本 venv 安装、原子切换 `current`、冒烟检查、部署日志 |
| adapter | `src/forgeloop/adapter/execution_environment.py` | 受限执行环境：dev/test 在容器内可写工作副本、review 只读；源仓库从不挂载，容器内没有源库/main 写入口（`runtime/Dockerfile`） |
| adapter | `src/forgeloop/adapter/artifact.py` | 候选产物构建与验证：真实 `uv build`（工作区内缓存）、独立 venv 安装、`forgeloop --help` 冒烟 |
| graph | `src/forgeloop/graph/__init__.py` | 层声明 |
| graph | `src/forgeloop/graph/state.py` | `TaskState`：只放路由与续跑所需的最小字段 |
| graph | `src/forgeloop/graph/planning.py`
| graph | `src/forgeloop/graph/dispatch.py` | 多需求并行推进：每需求独立记录与现场、重复启动被拒；同项目交付（归并/发布）程序互斥串行，不依赖人工安排 | | 需求只读分析：PI 产出目标/场景/验收标准/待澄清项，结构化校验；缺信息等待澄清、畸形如实阻塞，只追加版本不改源码 |
| graph | `src/forgeloop/graph/requirements.py` | 需求执行编排（A04）：按依赖串行推进已批准任务包；把已确认前置产物交给下游；等待不计执行工时；汇总当前任务、阻塞原因与下一步动作 |
| graph | `src/forgeloop/graph/nodes.py` | 八个节点工厂与 `NodeContext`：方案、批准门、实现、审查、测试、追加授权门、验收门、交付 |
| graph | `src/forgeloop/graph/evidence.py` | 失败回边证据读取：上一轮正式测试输出尾部与审查阻断问题（截断，供实现会话修复） |
| graph | `src/forgeloop/graph/prompts.py` | 提示词构造（纯函数）：开发提示（目标/范围/验收/工作区/尝试序号/批准测试命令/自验证要求/失败回边）与审查提示（含输出契约常量） |
| graph | `src/forgeloop/graph/builder.py` | 图装配：节点注册、条件路由、SQLite 持久 checkpointer；`RequirementTaskRunner` 把已批准需求任务映射到单任务图 |
| cli | `src/forgeloop/cli/__init__.py` | 惰性导出 `main`（首次读取属性才加载实现，轻量提交策略入口不拉入编排依赖栈） |
| cli | `src/forgeloop/cli/common.py` | 记录根解析、`open_store`、`fail` 统一失败输出 |
| cli | `src/forgeloop/cli/main.py` | 单任务命令 `submit`／`approve`／`grant`／`status`／`stop`，需求线命令 `requirement submit|revise|analyze|plan|approve|advance|accept|retry|status`，以及参数总装 |
| cli | `src/forgeloop/cli/commit_policy.py` | 提交策略命令：加载仓库默认与本地覆盖后的生效策略，放行/拒绝审计输出生效来源、机器标签与命中时间窗及其来源；文案明确为客户端限制而非服务端强制 |
| cli | `src/forgeloop/cli/merge.py` | `merge`：候选分支流程与归并证据 |
| cli | `src/forgeloop/cli/candidate.py`
| cli | `src/forgeloop/cli/requirements.py` | `requirement` 命令组：受理/澄清/分析/规划/批准/推进/整体验收/人工续跑/状态回查，接线到真实业务记录 | | `candidate <task_id>`：从已归并的授权提交真实构建候选产物、记录身份与 SHA256、重复构建校验可复现并在独立环境冒烟（构建与验证在一次调用内完成） |
| cli | `src/forgeloop/cli/release.py` | `release`：annotated tag、上传已验收产物为 Release 资产与发布回执 |
| cli | `src/forgeloop/cli/deploy.py` | `deploy`／`rollback`：从 Release 装产物、原子切换、回滚 |
| mail | `src/forgeloop/mail/__init__.py` | 层声明：邮箱接口与纯逻辑层，只依赖标准库；当前仅登记分层，尚无实现模块 |

CLI 对外命令分三条业务线：单任务研发 `submit`、`approve`、`grant`、`status`、`stop`；需求研发 `requirement submit`／`revise`／`analyze`／`plan`／`approve`／`advance`／`accept`／`retry`／`status`；版本交付 `merge`、`release`、`deploy`、`rollback`、`candidate <task_id>`。`status --json` 与 `requirement status --json` 的输出结构是对外契约，由 `contracts/cli-contract.json` 快照守住。

## 4. 研发闭环业务图

`graph` 层用 LangGraph 装配一条顺序主链，加失败回边与两个批准门。拓扑以 `src/forgeloop/graph/builder.py` 为准。

```mermaid
flowchart LR
  START([START]) --> plan --> gate_plan_approval
  gate_plan_approval -->|批准| dev
  gate_plan_approval -->|拒绝或批准绑定失败| END1([END])
  dev --> review
  review -->|有阻断问题| dev
  review -->|通过| test
  test -->|通过| gate_acceptance
  test -->|失败·额度未尽| dev
  test -->|额度用尽| gate_grant
  gate_acceptance -->|接受| deliver --> END2([END])
  gate_acceptance -->|拒绝·额度未尽| dev
  gate_acceptance -->|拒绝·额度用尽| gate_grant
  gate_grant -->|明确追加| dev
  gate_grant -->|停止| END3([END])
```

节点职责与状态字段：

| 节点 | 职责 | 写 `TaskState` |
| --- | --- | --- |
| `plan` | 由任务配置生成方案并落库，等第一次批准 | `plan_version` |
| `gate_plan_approval` | 第一次批准门；用领域批准绑定校验消费批准 | `halted_reason` |
| `dev` | 在代码副本内由 PI 实现并自验证，产出候选 diff | `dev_attempts` |
| `review` | 独立 PI 会话审查候选 diff | `last_review_blocking` |
| `test` | 程序执行批准的测试命令；失败计一轮失败轮次 | `last_test_passed`、`needs_grant`、`failure_cumulative` |
| `gate_acceptance` | 第二次批准门（整体验收）；消费时核对候选／测试／审查／产物材料，材料替换则原批准失效；拒绝按同一候选轮次计数 | `acceptance_passed`、`needs_grant` |
| `gate_grant` | 额度用尽后等待明确追加授权 | `needs_grant` |
| `deliver` | 二次核对验收材料未漂移后写交付报告与交付记录（含绑定指纹） | 无 |

条件路由共五个（`route_after_plan_gate`、`route_after_review`、`route_after_test`、`route_after_grant`、`route_after_acceptance`），**全部先检查 `halted_reason`，一旦置位即走 `END`**。这是「停止／中断后不再推进」的统一落点。

三类人工决定点通过 `langgraph.types.interrupt` 挂起，载荷是普通 dict，用 `kind` 区分：`plan_approval`、`grant_decision`、`acceptance`。CLI 用 `Command(resume={"decision": ...})` 恢复；决定词表是硬编码字面量（`approved`／`grant`／`accepted`），**其他任何值（含缺省）一律按拒绝处理**。

`TaskState` 只有 9 个字段、无 reducer，且节点一律使用 `NodeContext.task_id`，不读 `state["task_id"]`。原始日志、PI 事件与会话文件**不进检查点**。

### 4.1 需求线编排

`cli` 的需求命令不另建一套图：`graph.planning` 负责只读分析与任务包生成，生成时把仓库布局事实（源码根与源码分层从机读架构契约动态解析，测试分层、契约快照与可用解释器／门禁命令为固定事实）注入提示词，并用 `domain.repo_facts` 纯规则校验任务包的文件清单与测试命令；臆造路径或不可用命令的任务包在规划阶段被拒绝并要求重规划，不静默接受。`records.requirements.RequirementStore` 保存需求身份、分析、任务包、批准、任务推进与需求工时；`graph.requirements.RequirementExecutor` 按依赖拓扑串行推进已批准任务包，前置任务未交付时不启动下游，等待人工决定不计执行工时。查询依赖事实时由 `records.requirements.RequirementStore.dependency_facts` 只读取数、`domain.dependency_facts.assess_dependency` 纯规则判定：前置未达终态且无 `started` 动作才为真实等待，依据缺失输出 `unknown` 并列出缺少的记录。

I01 通过 `graph.builder.RequirementTaskRunner` 把每个已批准任务映射为带稳定身份的单个任务记录（`task-<req_id>-v<plan_version>-<task_id>`），复用本节的单任务业务图执行实现、独立审查、正式测试与验收；随后既有 `merge`／`release`／`deploy` 命令从该任务记录回查交付、归并与发布状态。需求文本一经追加，旧任务包与旧批准立即失效，未批准任务包不执行。

推进非终态任务前，`graph.requirements.RequirementExecutor` 经 `records.checkpoints` 只读读取记录根下 `checkpoints.sqlite` 的检查点与 `records.sqlite` 的动作事实：停在可续跑业务节点（`dev`／`review`／`test` 及其自动回边）、无 `halted_reason` 且没有未核对 `started` 动作时，不判定为等待人工决定，而是把 `TaskExecution.resume` 置真交给注入的执行器就地恢复，已完成节点不重放；停在人工决策门（计划批准、追加授权、整体验收）、终态、存在 `halted_reason` 或仍有未核对动作时保持等待人工决定，不自动续跑。重复推进按检查点身份与 `actions.action_id` 去重、记录缺失输出 `unknown`，不重复计入执行工时。

## 5. 执行现场、隔离与 main

- **执行现场**：每个任务一个目录 `<records_root>/<task_id>/`，内含 `workspace/`（代码副本）与 `sessions/`（PI 会话与 stderr）。现场默认保留，由用户清理。
- **代码副本**：`prepare_workspace` 用 `git clone --no-hardlinks` 建立自有 `.git` 的副本，再以 detached HEAD 检出基线提交，不与源仓库共享任何可写对象。候选 diff 由 `git add -A` 后 `git diff <基线提交>` 得到，覆盖修改／新增／删除，**不依赖 PI 的文本自述**。
- **前置产物应用（接缝）**：需求内下游任务在克隆副本后、进入实现前，由 `graph.nodes` 的 dev 节点把已完成前置任务的候选 diff 交给 `graph.requirements.apply_prerequisite_candidates`：逐条读取并按权威记录校验值核对，任一缺失或校验不符即整体阻塞、不写任何代码、不启动 PI；全部通过才按依赖顺序应用（菱形/冗余依赖下被传递包含的祖先标记为不单独应用），应用失败回退到应用前的干净副本。逐条结果同时写入下游任务现场 `prerequisite-applications.json` 与记录表 `prerequisite_applications`，重复启动据二者幂等跳过。
- **main 保护**：副本与容器不得直接改写真实 `main`。候选结果先经人工验收，再由 `merge` 以受控路径接回；`create_candidate_branch` 与 `merge_candidate_to_main` 都要求现场干净、HEAD 等于基线且位于 main。
- **PI 工具权限取决于进程权限与开放资源**，不能把 `cwd` 当作隔离。

**已知偏差（如实记录）**：受限容器隔离**尚未接入**，PI 目前直接宿主运行（与 `docs/status.md` 第 6 节同口径）。因此本节的「隔离」目前由独立克隆副本＋真实基线的 diff 提取实现，不由容器实现。

## 6. 持久化与记录

两类存储职责分离，都在 `<records_root>`（默认 `.forgeloop`）下：

| 存储 | 文件 | 内容 | 管理者 |
| --- | --- | --- | --- |
| 业务记录 | `records.sqlite` | 领域事实的**权威**记录（任务 15 张表＋需求 8 张表） | `records.store.RecordStore`、`records.requirements.RequirementStore` |
| 图检查点 | `checkpoints.sqlite` | `TaskState` 的推进状态，`thread_id = task_id` | LangGraph `SqliteSaver` |

图检查点由 LangGraph `SqliteSaver` 管理；`records.checkpoints` 只读解析其待执行节点、`halted_reason` 与检查点身份，并只读汇总 `records.sqlite` 的未完成/已完成动作身份，供需求推进器判定可续跑与重复推进的幂等口径（动作身份 `actions.action_id`，记录缺失输出 `unknown`）。

记录表：任务侧 `tasks`、`plans`、`approvals`、`approval_consumption`、`acceptance_bindings`、`failure_rounds`、`grants`、`budget`、`stops`、`actions`、`slot_cleanups`、`merges`、`deliveries`、`releases`、`prerequisite_applications`（15 张）；需求侧 `requirements`、`requirement_versions`、`requirement_analyses`、`requirement_task_plans`、`requirement_plan_approvals`、`requirement_task_runs`、`requirement_task_artifacts`、`requirement_budget`（8 张）。两侧共用同一 `records.sqlite`，各自管理连接与表。

**动作生命周期（B03）**：会产生副作用的节点动作（`dev`／`review`／`test`）启动前在 `actions` 登记 `started`，正常结束登记 `completed`。进程在动作中途被杀只会留下 `started`；同一任务再次推进时，未完成动作拒绝重放并标记 `interrupted`，保留现场待人工核对。`begin` 在 `BEGIN IMMEDIATE` 事务内检查后插入，同一任务同时最多一个未完成动作，并发启动只有一个能成功。动作行另存发起进程身份（`pid`）与最近心跳（`heartbeat_at`）。

**槽位残留判定与安全清理（A05 恢复路径）**：执行槽位（同一需求推进、同项目交付）占用同样落在 `actions`，判定只看权威记录里的进程身份是否存活（`os.kill(pid, 0)` 探测接缝），不依据等待时长或心跳年龄：进程存活判 `live`，进程已不存在判 `dead`，缺少进程身份或存活状态无法确认判 `uncertain`。`cleanup_slot_residue` 只清理 `dead` 残留，并在 `BEGIN IMMEDIATE` 内结束占用、写入 `slot_cleanups`（槽位名、原占用者身份与属主、判定依据、清理时间）；`live`／`uncertain` 一律不清理并返回具体原因。重复或并发触发时只有一个能完成清理，其余按幂等返回未清理，绝不误清存活占用者。

**写入语义（现状）**：连接以 `isolation_level=None` 自动提交，但关键读-改-写序列显式使用 `BEGIN IMMEDIATE`／`COMMIT`／`ROLLBACK` 事务：`create_task`（任务＋预算）、`consume_approval`（批准消费）与 `extend_budget`；`charge_budget` 用单条原子 `UPDATE ... consumed_seconds = consumed_seconds + ?` 累加，并发计入不丢更新。连接设置 `busy_timeout=5000` 以等待写锁；仍未启用 WAL。

原始材料**不进**记录表，只以文件留在现场；记录里保存路径与校验值：

| 产物 | 路径（相对任务目录） | 消费者 |
| --- | --- | --- |
| 候选 diff | `candidate.diff` | 审查、验收、归并 |
| 前置应用记录 | `prerequisite-applications.json` | 下游启动幂等与回退判定、人工核对 |
| 实现自述 | `dev-reports.jsonl` | 交付报告 |
| 审查结论 | `reviews.jsonl`、`review-report.json` | 验收 |
| 测试证据 | `test-run.jsonl` | 验收、交付 |
| 交付报告 | `delivery-report.json` | 用户 |
| PI 会话与错误 | `sessions/<task>-<role>.events.jsonl`、`.requests.jsonl`、`.stderr.log` | 回查 |

这些文件名是**跨层契约**：验收中断载荷对外暴露的就是这些路径，`merge`／`release` 依赖它们。改动文件名属于架构变化。

## 7. 外部边界与接缝

需要在真实环境验证的外部依赖（不能用替身替代结论）：PI RPC 子进程与真实模型、git CLI 与真实仓库、GitHub REST、uv／venv／pip 安装子进程、宿主符号链接与 `os.replace` 原子切换、被测项目测试命令进程、系统时钟。

可替换接缝的当前形态：

| 接缝 | 形态 | 替换方式 |
| --- | --- | --- |
| 执行器命令 | `config["pi_command"]`、`config["test_command"]` 快照 | 配置注入；测试用 `tests/fixtures/fake_pi.py` 讲同一 JSONL 契约 |
| 记录端口 | `NodeContext.store: RecordStore` | 构造注入（类型是 SQLite 具体实现，不是 Protocol） |
| 任务上下文 | `NodeContext`（`task_id`／`task_dir`／`workspace`／`sessions_dir`／`config`） | 闭包注入，不进检查点 |
| 外部服务地址 | `deployment.GITHUB_API`、`github_checks.CHECK_RUNS_API` 模块常量 | monkeypatch |
| 检查读取凭据 | 环境变量 `GITHUB_TOKEN` → `GH_TOKEN`（`github_checks.github_token()` 每次读取时解析；不落盘、不进证据） | 设置／取消环境变量；未提供即匿名读取（60 次/小时，按出口 IP 共享） |
| 人工决定来源 | `interrupt` 载荷＋CLI `resume` | 换决定来源只需改 CLI 侧 |

**诚实的限制**：`adapter` 层**没有** Protocol／ABC 端口；`graph.nodes` 在模块级直接构造 `PIProcess`、直接调用 `run_test_command` 与 `prepare_workspace`；`build_graph` 也不接受可注入的 checkpointer。因此「在进程内替换执行器」目前要改 `graph/nodes.py` 的调用点，而不是换一个实现类。保留的 Seam 是配置与函数参数，不是接口抽象——这是首版刻意选择的简单性，不声称已经是插件体系。

## 8. 交付链路：归并 → 发布 → 部署

研发闭环之外，`cli` 另有三个受控阶段，规则在 `domain` 的 `merge`／`release`／`deploy`；需求线交付的任务通过 `RequirementTaskRunner` 映射出的单任务记录接入同一链路：

```mermaid
flowchart LR
  Accept[人工验收通过] --> Merge[merge<br/>候选分支→等必需检查→快进 main→推送]
  Merge --> Release[release<br/>annotated tag 与发布回执]
  Release --> Workflow[Release 工作流<br/>下载已验收产物与 SHA256SUMS（不重新构建）]
  Workflow --> Deploy[deploy<br/>校验值比对→独立版本目录→原子切换→冒烟]
  Deploy --> Rollback[rollback<br/>只切到已安装且留有校验记录的版本]
```

关键不变量：**部署必须使用验收过的那一份产物**——`release` 把 C01 已验收产物原件上传为该标签的 Release 资产，`Release` 工作流只下载并核对它（禁止在标签工作流重新构建），`deploy` 校验 `SHA256SUMS`，校验值不匹配即拒绝；同版本不同产物被拒绝；`release` 对同标签幂等、换标签拒绝。

## 9. 架构变更与本文同步

### 什么算架构变化

- 模块的新增、删除、改名或换层；
- 跨层依赖方向的新增、删除或改变；
- `LAYER_RULES` 允许依赖表的改变；
- 业务图节点增删或拓扑／路由改变；
- 持久化介质、记录表结构或现场产物文件名的改变；
- 外部依赖系统的新增或替换、接缝形态的改变。

同层内部重构且不改变任何边时不算架构变化，但契约快照仍必须保持一致。

### 变更时必须做的

1. 在同一次改动中更新本文（至少第 2、3 节的层与模块清单）与 `contracts/architecture.json`；
2. 运行 `make architecture-contract` 重新导出快照，再运行 `make check`；
3. 方向性选择（换编排框架、换执行器、改变分层）另写 `docs/adr/` 决策记录——ADR 只回答「为什么」，本文回答「现在是什么」。

### 机器如何强制

`make architecture-contract-check`（含在 `make check` 内）从源码 AST 重新推导事实，与快照和本文比对，任一不符即失败：

1. 模块新增、删除或换层；
2. 跨层依赖边变化；
3. 越层依赖（违反 `LAYER_RULES`）；
4. 模块之间出现 import 环；
5. **本文第 3 节的模块文件路径与源码模块集合不互为镜像**——漏写新模块或残留已删除模块都失败。

第 5 条是「架构变化必须同步架构描述文档」这条规则的执行点：只要改了模块结构而没改本文，`make check` 就会失败并指出缺失或多余的路径。
