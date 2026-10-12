# ForgeLoop 工程可靠性方案

日期：2026-10-12，Asia/Shanghai。状态：**方案与骨架已创建，全部门槛未执行，无任何通过记录。**

本方案复刻自同机 EvidHist 项目已实际运行并验证的工程可靠性体系（其开发说明、架构分析第 12/13 章、交接清单第 8–12 节），按 ForgeLoop 的形态适配。研发纪律见[研发纪律](development-discipline.md)；首版产品范围以[首版需求](product-requirements.md)为准——可靠性门槛是工程手段，不构成产品范围扩张。

## 1. 来源与适配原则

EvidHist 的可靠性方案由四部分组成：统一门槛配置、分层测试方法论、提交纪律、以负例验证每个硬门槛的执行矩阵。复刻时按三条适配原则取舍：

| 适配点 | EvidHist | ForgeLoop |
| --- | --- | --- |
| 形态 | FastAPI 服务 + React 前端 + PostgreSQL | 纯 Python CLI + LangGraph + 本地 SQLite |
| 前端工具链 | Vitest/Playwright/Stryker/ESLint/depcruise/Knip | **不移植**（首版无前端，B01 前不接入） |
| 契约管理 | OpenAPI 快照与漂移检查 | CLI JSON 输出契约快照（见第 9 节） |
| 外部边界 | PostgreSQL 容器、真实 HTTP、浏览器 | PI RPC（stdin/stdout JSONL）、受限容器、CLI 进程 |
| 数据库服务 | db-up/db-down + 测试 DSN 门 | 无服务；SQLite 文件为持久边界，集成测试本地可离线 |
| LLM 评测 | evals/ 固定案例与评分器 | 不移植（首版无模型质量评测，PI 执行质量由 A01 证据与独立审查约束） |

未移植项均为"暂不适配"而非否定：ForgeLoop 出现对应形态（首个界面、远程仓库、模型评测）时按同方法接入，接入时机见[待实现列表](pending-requirements.md)。

## 2. 骨架清单与当前状态

本次创建的工程骨架（`git init` 于 main 分支；因提交时间纪律，首个 commit 顺延至 2026-10-12 18:00 后）：

| 文件 | 作用 | 当前状态 |
| --- | --- | --- |
| `pyproject.toml` | 依赖分组（dev/mutation/security）与全部工具配置 | `uv.lock` 已生成并锁定（147 包，CPython 3.13.15，langgraph 1.2.14）；两项依赖修正见第 13 节 |
| `Makefile` | 统一检查入口（check/coverage/mutation/security/hooks） | `check_commit_policy.py`、`run_semgrep.py` 已落地；结构度量/覆盖/变异门槛与 CLI 契约脚本待实现 |
| `config/quality-policy.toml` | 唯一门槛来源：结构/覆盖/变异/属性测试 | 消费脚本部分落地；属性 profile 已由 `tests/conftest.py` 注册 |
| `config/commit-policy.toml` + `config/workday-calendars/2026.json` | 提交时间策略与年度日历 | 已落地并实测（16:45 周一被正确阻断） |
| `.semgrep.yml` | 四条本地 SAST 规则 | 已执行：4 规则 20 文件 0 命中 |
| `.pre-commit-config.yaml` | pre-commit/commit-msg/pre-push hooks | hooks 尚未安装（`make hooks` 待执行） |
| `.github/workflows/quality.yml` | CI 四作业（quality/security/mutation/commit-policy） | 无远程仓库，无执行记录；Action SHA 沿用 EvidHist 已核验值 |
| `src/forgeloop/`（domain/records/adapter/graph/cli） | 首版系统架构分层实现 | 已实现并测试（见第 13 节执行记录） |
| `.gitignore` / `.python-version` | 忽略生成物；Python 基线 3.13 | 3.13.15 已实际使用并锁定 |

骨架是目标态：定义代码落地时的入口与门槛，不声称任何检查已经运行。已执行部分见第 13 节。

## 3. 分层测试策略

测试从业务不变量出发，先确定“输入、操作、可观察结果及失败状态”，再选择工具。对内部实现的模拟只用于隔离外部边界（PI RPC、容器、时钟、文件系统），核心领域规则通过公共接口验证。

| 层次 | 重点验证 | ForgeLoop 的具体样例 | 执行入口 |
| --- | --- | --- | --- |
| 单元测试 | 确定性领域规则、错误契约及边界 | 失败轮次只计正式测试失败（同轮多用例计一）；追加授权不清零累计；旧方案版本的批准拒绝重复执行；超限停止启动新动作并报告 | `tests/unit/`，`make test` |
| 属性测试 | 大量输入下始终成立的不变量 | 任意失败序列累计只增不减；第 n 次授权额度为 3n–2..3n；任意原始文本保存后回查不变；重复决定不产生第二次执行 | `tests/property/`，Hypothesis |
| 组件与契约测试 | CLI JSON 输出结构、错误码与状态 | `status --json` 输出契约；异常运行标记“中断/待核对”；不存在任务的查询行为 | `tests/component/` |
| 集成测试 | 真实组件、驱动与配置的交界 | SQLite checkpointer 持久化与恢复；PI Adapter 的 JSONL 会话保存、`agent_settled` 判定与 stderr 分流 | `tests/integration/`，`make coverage` |
| 流程场景测试 | 多步骤组合后的领域行为 | 批准→实现→审查→测试通过→交付；三失败轮次用尽→等待追加；明确追加→继续执行；请求停止→核对→保留现场 | `tests/scenario/`，`make test` |
| 系统测试 | 独立进程、运行配置与依赖 | CLI 进程退出后记录仍可回查；重启后查询状态与报告；请求停止后的真实状态核对 | `tests/system/`，`make test-system` |
| PI 真实调用 | 容器内 PI RPC 真实事件、会话与结果 | 最小 RPC 调用真实落盘；开发与审查独立会话；真实停止请求 | `pi_live` marker，显式选择加入 |
| 变异测试 | 测试是否会发现故意引入的代码错误 | 改变计数边界、授权判断、时间比较、返回值 | mutmut，`make mutation` |

测试以快速且稳定的规则测试为主，在关键依赖边界使用真实组件（对应[验收计划](first-validation-plan.md) A01–A05 的证据要求），为完整流程保留少量高价值系统用例。数量比例随风险和运行成本调整。

## 4. 结构门槛、统计口径与例外

结构度量由 `scripts/structure_metrics.py`（AST/tokenize 精确计数）与 `scripts/check_structure_metrics.py`（策略应用与报告）实现，门槛读自 `config/quality-policy.toml` 的 `[structure]`。

| 指标 | 官方默认或参考 | ForgeLoop 取值 | 执行方式 |
| --- | --- | --- | --- |
| 函数有效代码行 | ESLint 默认 50 | 40 行提示，超过 50 行失败 | Python 精确 AST/tokenize 门槛 |
| 本类公开接口 | Pylint 默认 20 | 超过 10 提示，超过 20 失败 | Pylint R0904 辅助 + 专用口径 |
| 手写源码文件总行数 | ESLint 300 / Pylint 1000 | 超过 300 提示，上限 500；审阅例外上限 1000 | Pylint C0302 |
| 圈复杂度 | Ruff/Pylint 默认 10 | 超过 10 失败 | Ruff `C901` |
| 参数数量 | Ruff/Pylint 默认 5 | 超过 5 失败 | `PLR0913` |
| 分支数量 | Ruff/Pylint 默认 12 | 超过 12 失败 | Ruff `PLR0912` |
| 返回/语句/局部变量 | 6 / 50 / 15 | 超过提示（不阻断） | 审阅报告，见 `[structure.review_hints]` |

统计口径必须固定（复刻 EvidHist 交接清单 8.2）：

- 函数行数从声明行到函数结束，含多行签名；装饰器在范围外不计。排除空行、纯注释与 AST 识别的真实 docstring；尾部注释所在行的代码仍计入。
- 字符串内的 `#`、多行字符串仍是代码，不能正则删除后当注释排除。嵌套函数分别检查，其内容保留在外层函数范围中。
- 公开接口定义为本类声明的公开方法和公开 property，按“接收者 + 名称”去重；不计继承、构造器、下划线私有/特殊方法。数据字段的序列化契约另审阅。
- 文件门槛计算物理总行数（含注释与空行），只对手写源码应用；Markdown、锁文件、记录与可验证生成物使用各自规则。
- 例外记录 `path/rule/reason/owner/review/recheck` 六项俱全；例外文件仍受 1000 行绝对上限约束。不允许折叠语句、删除说明或全目录忽略规避门槛。

这些数字中 40/20/500 与提示值是项目选择（EvidHist 已按其代码校准），**不是普适最优值**；ForgeLoop 落地后按真实命中校准，先报告现有命中再对新代码落实。

## 5. 统一质量策略与数值基线

`config/quality-policy.toml` 是唯一门槛来源；Ruff、Pylint 等工具的等值配置与其保持一致，专用脚本（覆盖/变异/结构）直接读取本文件。

| 指标 | 取值 | 必须一起报告的条件 |
| --- | --- | --- |
| 行覆盖、分支覆盖 | 各 ≥90% | 两个独立原始计数；coverage.py 综合百分比不能冒充两项各 90% |
| 新增/修改行覆盖 | ≥90% | diff-cover；无 Git 基线时标“不适用”，出现基线后强制接入 |
| 核心领域变异 | 有效非等价变异全部捕获，未审幸存 0 | 维持核心范围严格门槛；等价项逐条审阅 |
| 扩展的一般模块变异 | killed ≥90%（试行值） | 总数必须 >0；超时不自动算有效捕获 |
| 变异异常/未完成 | 0 | no tests/skipped/suspicious/timeout/segfault/中断分别检查 |
| 属性样例数 | 本地 100，PR 高风险 300，发布前 1000 | 执行预算而非统计置信度；保留 seed、最小反例与实际次数 |
| 单测时限 | 30 秒（signal 模式） | 含 fixture；超时为失败/未完成 |
| CI 错误/非法配置/空关键测试 | 0 | 禁止 test-only 式占位；没有测试或报告缺失直接失败 |
| 新增依赖循环/越层依赖 | 0 | Import Linter 契约；不能靠遗漏入口达标 |
| 未处置密钥命中 | 0 | 单列误报与真实泄漏（Gitleaks 按 EvidHist 先例顺延至发布 CI 前） |
| 未批准的破坏性契约变更 | 0 | CLI JSON 契约快照差异；版本化变更须解释迁移 |

关键分母规则（复刻）：一般模块 killed 比例以有效、非等价变异中的 killed/survived/no coverage/有效 timeout 总数为分母，timeout 不计入 killed；pending 与未完成范围不能从分母删除后宣称完成。

## 6. 执行分层

| 时机 | 必须执行 | 成本控制 |
| --- | --- | --- |
| 编辑中 | 格式、Lint、类型与所改规则测试 | 快速反馈，固定样例不访问外部服务 |
| 提交前 | Ruff 检查、格式、Pyright、提交时间策略 | pre-commit 用项目环境；CI 仍重复检查 |
| 推送前 | 单元、属性、组件、场景测试 | 本地 hook 可被绕过，不承担最终合入保证 |
| 每个 PR | 上述 + 集成、系统、覆盖、fixture 之外的安全审计与核心范围变异 | CI 作业分开，保存失败报告，限时 |
| 相关功能变更 | PI Adapter/容器变更 → `pi_live` 真实调用；CLI 输出变更 → 契约快照核对 | 按变更影响选择，真实 PI 调用有显式预算 |
| 发布/交付前 | 全部适用检查、记录回查、关键场景 | 测试通过的同一锁定版本进入交付 |

## 7. 安全与依赖护栏

- **pip-audit**：审计完整锁定的运行与工程依赖（`uv export` 全组导出），`--strict --no-deps --disable-pip` 基于精确锁定输入；漏洞与“无法完成审计”都是检查失败，不静默放过。
- **Semgrep 四条本地规则**（`.semgrep.yml`，`--error --strict`，解析失败即失败）：禁止 `shell=True`/`os.system`（ForgeLoop 真实执行测试命令与容器命令，此规则是第一道护栏）；禁止 `eval`/`exec`（任务输入、PI 事件与模型输出是数据不是代码）；禁止 `pickle`/`yaml.unsafe_load`（记录与会话是外部产物）；禁止关闭 TLS 校验。无命中不等于无漏洞；规则按真实风险扩充并带正反例。
- **依赖纪律**：运行、开发、变异、安全依赖分组，`uv.lock` 冻结完整解析；deptry 核查声明与分组（dev 依赖无理由导入被 DEP004 拒绝）；certifi 显式声明于 dev 组供安全工具使用；更新依赖必须重新执行相关检查并更新锁文件。
- **Import Linter**：`forgeloop.domain` 禁止依赖 `cli/graph/adapter` 与 `langgraph`（领域规则保持纯净，编排适配留在图与 Adapter 层）；新契约随代码分层落地时增加，不能靠遗漏入口达标。
- **环境隔离**：测试不触碰真实 main 仓库副本；`mutants/` 是可再生缓存目录，更换测试集后必须删除强制重生成（复刻 EvidHist 踩坑结论；mutmut `also_copy` 需要 `tests/config/scripts`）。

## 8. 提交纪律

与 EvidHist 相同（同一所有者、同一时区）：

- **北京时间（Asia/Shanghai）法定调休工作日 09:00（含）至 18:00（不含）禁止创建 commit**；周末调休上班日同样禁止；法定假日按已维护日历。缺失年度日历时窗口内拒绝提交，不默认把未知年份周末当休息日。
- pre-commit 与 commit-msg 都读取真实时钟；commit-msg 同时校验消息；CI 核对新增 commit 的作者/提交者时间戳与消息（`--audit`）。禁止 `--no-verify`、禁用 hooks 或伪造时间戳绕过。
- 消息遵循 Conventional Commits，scope 建议 `cli`/`graph`/`adapter`/`domain`/`records`/`quality`/`docs`；一个 commit 表达一个可解释、可验证的变化，行为变更与回归测试同行。
- 本仓库于 2026-10-12（周一）15:28 初始化，处于禁止窗口，故**首个 commit 顺延至当日 18:00 后**，由用户在合法时段执行（详见[贡献规范](../CONTRIBUTING.md)）。

Git 本地 hooks 可被绕过，CI 时间戳也可伪造；远程仓库建立后须设置分支保护与状态检查，才能把检查结果落实为合入门槛。

## 9. 契约管理：CLI JSON 输出快照

EvidHist 用 OpenAPI 快照守住 HTTP 契约；ForgeLoop 的对外契约是 CLI 的 JSON 输出（`status --json` 等，也是首个候选真实任务）。等价机制：

- `scripts/export_cli_contract.py` 导出 CLI JSON 输出的 Schema 快照并提交入库；`--check` 模式拒绝漂移（改动快照 → 退出 1；快照缺失 → 退出 1；一致 → 退出 0）。
- 修改输出结构后执行 `make cli-contract` 重新导出并审阅兼容影响；组件测试断言实际输出与快照一致。
- 未批准的破坏性变更（字段删除、类型收紧、语义变化）必须版本化并解释迁移。

脚本随首批 CLI 代码落地（见第 10 节），落地时以受控漂移负例验收。

## 10. 激活顺序（骨架 → 可执行）

门槛随[验收计划](first-validation-plan.md)的最短实现顺序逐项激活，不一次接入全部工具：

| 步骤（对应验收计划） | 激活内容 | 脚本/门槛落地要求 |
| --- | --- | --- |
| 1. 环境核查与最小 PI 调用 | `make setup` 生成 `uv.lock`；git 身份与 hooks；Ruff/Pyright/pytest 基础；`tests/unit`、`tests/property` + Hypothesis profile 注册；`forgeloop/commit_policy.py` + `scripts/check_commit_policy.py`（先于业务代码，带正反例测试） | 首个 commit 在合法时段创建；`make test` 有真实通过记录 |
| 2. 任务、方案、批准与本地记录 | `tests/component` + `scripts/export_cli_contract.py`（CLI JSON 契约）；结构度量脚本与 import-lint、deptry、pylint | `make check` 首次全绿；结构度量先报告现有命中 |
| 3. 串联实现、审查、正式测试 | `tests/integration`（SQLite、PI Adapter 替身）；mutmut `only_mutate` 固定核心领域文件清单（失败计数/授权/批准版本绑定/时间限额） | `make coverage`、`make mutation` 首次执行并落报告 |
| 4. 失败轮次、限额与停止 | 计数/授权/限额的属性测试与负例矩阵落地；`pi_live` 真实调用验证 Adapter 契约 | A03/A04 负例可重跑 |
| 5. 查询、验收与备份 | `tests/system`（CLI 端到端）；CI 四作业随远程仓库启用 | 远程 CI 有执行记录后，门槛才成为合入约束 |

全部 `scripts/` 检查脚本的验收标准一致：每个硬门槛都有可发现、可重跑的负例（见第 11 节），无负例不算接入完成。工具版本在步骤 1 核查后固定（uv 0.12.24；Python 3.13 提案值若与 LangGraph/PI 容器冲突则调整后全档同步）。

## 11. 负例验证矩阵

复刻 EvidHist 的核心实践：**每个硬门槛必须有可发现它的负例回归测试**，防止门槛静默失效。落地时逐项提供，当前全部未执行：

| 门槛 | 负例（应被拒绝/失败） |
| --- | --- |
| 结构度量 | 51 行函数、21 个公开接口、501 物理行文件 |
| Ruff | 复杂度 11、参数 6 |
| Import Linter | 领域导入 adapter 的假包契约被拒绝 |
| pytest-timeout | 卡死测试被 signal 模式终止 |
| deptry | dev 组依赖无理由导入被 DEP004 拒绝 |
| 变异门槛 | 空/幸存/超时/中断变异与缺失报告 |
| 覆盖门槛 | 低独立分支覆盖与缺失覆盖报告 |
| CLI 契约 | 受控漂移：改快照 → 退出 1；缺快照 → 退出 1 |
| 提交策略 | 禁止窗口内 `--check-now` 返回 1；非法消息被 commit-msg 拒绝；伪造时间戳被 `--audit` 拒绝 |
| 业务关键路径 | 旧方案版本重复批准不触发执行；三失败轮次用尽后无追加不继续；停止后不盲目重放旧动作 |

## 12. 与首版范围的关系

- 可靠性门槛服务 [A01–A05](first-validation-plan.md#4-首版核心检查) 的证据要求：真实测试输出（V0-05）由系统/集成层程序执行产生；记录回查（V0-08）由系统测试验证；`pi_live` 支撑 A01 真实调用证据。
- 30 小时人工投入上限不变：门槛接入按第 10 节顺序随代码走，不为“先把平台建完”投入预算；上限到达而门槛未全部激活时，如实报告缺口。
- 不因骨架存在而提前建设：插件注册中心（B21）、共享包（B15）、页面（B01）、多执行器；不为尚无业务对象的层写空测试占位。
- EvidHist 已验证的运行结论（mutants 缓存陷阱、Stryker/工具兼容性等）中与 Python 后端相关的部分直接继承；其前端结论保留在原项目，ForgeLoop 出现前端时再引用。

## 13. 首批执行记录：2026-10-12（首版系统架构实现）

环境：macOS ARM64，CPython 3.13.15（uv 托管），系统 uv 0.12.5（dev 组锁定 0.12.24）。以下结果只属于已接入的检查，不构成未执行项的通过声明。

| 检查 | 实际结果 |
| --- | --- |
| `uv lock` / `make setup` | 147 包解析并安装（langgraph 1.2.14、langgraph-checkpoint-sqlite 3.1.1、mutmut 3.x、pip-audit、semgrep、ruff、pyright 等） |
| 依赖修正（实测驱动） | ① langgraph-checkpoint-sqlite 2.0.10 与 langgraph-checkpoint 4.2.0 序列化接口（`dumps` → `dumps_typed`）不兼容，实测崩溃后改为 `>=3,<4`；② `langchain-core` 因 `RunnableConfig` 被直接导入，按 deptry 纪律从传递依赖提升为直接依赖 |
| pytest | **132 项通过**：unit 90、property、component、scenario、integration、system（真实子进程 CLI 端到端 2 项）六层 |
| 覆盖率 | 独立行 **96.14%**（1021/1062）、独立分支 **90.91%**（220/242），均超 90 门槛；`check_coverage_thresholds.py` 未实现，数字由 `reports/coverage.json` 原始计数核对 |
| Ruff / Pyright | check + format 全过；0 错误。strict 范围调整为 `domain/records/adapter`（graph/cli 是 LangGraph 松散 Any 边界，用 basic 模式，理由注释在 pyproject） |
| Import Linter / deptry / Pylint | 领域不依赖编排/适配器/CLI 契约 kept；无依赖问题；10.00/10 |
| 提交策略 | `--validate-config` 通过（2026 日历）；`--check-now` 于 16:45（周一）实测退出 1 并阻断——禁止窗口负例真实生效 |
| 安全 | pip-audit 完整锁定依赖 0 已知漏洞；Semgrep 4 规则扫 20 文件 0 命中 0 解析错误（`scripts/run_semgrep.py` 已落地，含设置目录与 CA 修正） |
| 变异（核心领域四文件） | 246 变异：第一轮 169 杀死 / 77 幸存；强化测试后 **175 杀死 / 71 幸存**，无超时/未测/异常状态。**门槛未通过**：71 个幸存者待逐项审阅（抽样分类：错误消息字符串变异属非契约等价；边界比较与重建顺序类需补杀伤测试或说明契约），按第 11 节负例矩阵流程处置 |
| 系统架构实现 | 五层齐备：domain（计数/授权/批准绑定/限额/提交策略）、records（SQLite 权威记录）、adapter（PI RPC JSONL + 测试命令运行器）、graph（LangGraph 两次 interrupt 批准 + 失败回边 + 追加授权）、cli（submit/approve/grant/status --json/stop） |

**未执行/缺口**（如实记录，不视为通过）：
- `scripts/check_coverage_thresholds.py`、`check_mutation_stats.py`、`structure_metrics.py` + `check_structure_metrics.py`、`export_cli_contract.py` 未实现（对应 Makefile 目标暂不可用）。
- `make hooks` 未安装；pre-push 快速测试 hook 未验证。
- 变异门槛未过（71 幸存者待审阅）。
- 真实 PI RPC 调用（`pi_live`）未执行——适配器实现的是文档化契约，真实协议行为是验收计划步骤 1 的核查项；容器与独立工作副本未接入（假 PI 子进程验证适配器行为）。
- 远程仓库与 CI 无执行记录；备份未执行（A05）。

实现说明：首个 commit 仍待合法时段创建；本记录由开发会话写入，变异幸存者审阅与门槛脚本实现移交下一批工作。

## 14. 门槛脚本落地与变异审阅记录：2026-10-12（第二批）

第一批记录的四个缺口全部关闭；`make check` 首次完整通过（lint、format、typecheck、test、cli-contract-check、commit-policy-config、structure-metrics、import-lint、deptry、pylint 十项）。

| 项 | 实际结果 |
| --- | --- |
| `scripts/check_coverage_thresholds.py` | 已落地（复刻 EvidHist）：独立行/分支原始计数门槛，缺失/畸形报告失败，无 Git 基线时 changed-line 显式"不适用"。实跑通过（行 96.19%、分支 91.20%） |
| `scripts/check_mutation_stats.py` | 已落地并扩展：在 EvidHist 版基础上新增幸存者审阅核对——每个幸存者须有 `[[mutation.reviewed_survivors]]` 条目（mutant+reason），未审幸存者 >0 或审阅清单过期（源码变更后条目不再幸存）都显式失败 |
| 变异幸存者审阅 | 47 个幸存者逐项审阅完毕并登记：45 个为错误消息文本变异（XX 包裹/大小写/None——消息内容非行为契约），2 个逐项等价（`or→and` 仅在自定义时区对象出现差异；`split(None,1)` 对合法提交头等价）。审阅前先补杀伤测试杀掉 22 个真实行为缺口（`charge(0)` 合法、周六非工作日、策略时区而非系统时区、首行恰 100 字符边界、多段描述解析、RecordOutcome 严格布尔、FailureRound 字段完整性、ConsumeResult 的 approval/reason 契约、同版本批准幂等更新等） |
| `scripts/export_cli_contract.py` | 已落地：从合成任务样本（最小/全字段/不存在）提取 `status --json` 字段结构，快照 `contracts/cli-contract.json`；`--check` 拒绝漂移（受控漂移负例：改快照→退出 1；缺失→退出 1） |
| `scripts/structure_metrics.py` + `check_structure_metrics.py` | 已落地（复刻 EvidHist，纯 Python 范围）：固定口径的 AST/tokenize 精确计数 + 策略应用。首跑抓住 4 个真实超标（`_status_document` 74 行、`make_review_node` 60 行、`review_node` 58 行、超长场景测试），全部以重构修复而非例外豁免 |
| 结构重构 | `_status_document` 拆为分节助手；dev/review 抽取共享 `_invoke_pi`（含工时计费与关闭）；审查报告写入独立 `_write_review_reports`；超长场景测试拆为三个。领域文件未动，变异编号保持稳定 |
| 门槛脚本负例 | 变异 9 项（空报告/未审幸存/过期清单/计数不闭合/状态不完整等）、覆盖 8 项（低行/低分支独立失败/缺失/畸形/非整数计数/基线门）、契约 5 项（漂移/缺失/往返/结构合并）、结构 9 项（51 行/21 接口/501 行/例外上限/口径固定） |

**变异最终状态**（最终测试集复跑）：246 变异，199 杀死，47 幸存且全部审阅登记（门槛 `critical_unreviewed_survivors_max=0` 满足）；超时/未测/异常状态 0。门槛的过期检测实际生效过一次：最终测试集多杀 1 个变异后，旧清单出现 1 条过期条目被显式拒绝，移除后通过——这正是清单与源码绑定的设计行为。

**仍未完成**（如实记录）：
- `make hooks` 未安装（pre-push 快速测试 hook 未验证）；远程 CI 无执行记录。
- 审阅清单与变异编号绑定领域源码：修改 domain 文件后须重跑变异并重导清单（门槛脚本会显式失败提示）。
- 真实 PI 调用（`pi_live`）与容器隔离仍未接入（验收计划步骤 1 的核查项）。

## 15. pi_live 真实调用记录：2026-10-12 18:00（验收计划步骤 1）

本机 pi 1.1.0（homebrew）+ 官方 RPC 协议文档实测。**协议层全部验证通过；模型层被上游 403 阻断（如实记录）。**入口：`make pi-live`（`FORGELOOP_PI_LIVE=1` 显式选择加入；默认跳过，常规测试不含真实调用）。

**协议适配修正**（依据 https://pi.dev/docs/latest/rpc 实测，替换原文档化假设）：
- prompt 命令字段是 `message`（原假设 `text`）；命令带自增 `id`，响应以 `{"type":"response","command":...,"success":...}` 关联。
- 停止是 `abort` 命令（原假设 `stop`）；优雅停机是关闭 stdin（close() 已按此实现）。
- 最终文本来自 settled 后的 `get_last_assistant_text` 响应（`data.text`）。
- 假 PI 同步改讲真实协议（response 关联、agent 事件序列、abort 语义、退出负例）。

| 验证项 | 实测结果 |
| --- | --- |
| 进程与协议帧 | `pi --mode rpc --no-session` 启动、JSONL 帧、命令/响应 id 关联全部工作 |
| get_state 往返（无模型成本） | success=true 带 data；未知命令返回 success=false 而非崩溃 |
| 优雅停机 | 关闭 stdin → 进程退出码 0 |
| 真实事件流 | response(prompt, disposition=started) → agent_start/turn/message×多 → **auto_retry×3** → agent_end×4 → agent_settled；会话与轨迹落盘可读取 |
| 适配器错误上报 | 真实 prompt 被拒（首次尝试 stderr 显示 ~/.pi 写锁 EPERM）→ `prompt-rejected` + stderr_tail；隔离 HOME fixture 解决 |
| 模型调用 | **403：上游要求有效 OpenCode Go 订阅**（全部 31 个模型同错；本地直验 `pi --model deepseek-v4-flash` 同样 403）。适配器如实上报：settled=True + model_error 携带 403 消息 + 空文本 |

**实测发现并修复的语义缺口**：`agent_settled` 只表示"不再自动推进"——provider 自动重试耗尽后同样 settled（最终消息 stopReason=error、内容为空）。原适配器会把这种运行当成成功完成。修复：`PIInvocationResult.model_error` 从最终 agent_end 消息提取 stopReason/errorMessage；dev/review 节点把模型错误标记为 interrupted（不伪装完成）；假 PI 增加 model-error 模式作回归负例；live 测试断言"非空文本 XOR model_error"的显式结果契约。

**未完成**（验收计划步骤 1 的"真实调用有结果"标准未完全达成）：
- 模型层结果验证被订阅阻断——需要有效订阅或其他 provider 配置后重跑 `make pi-live`（协议测试不受影响）。
- abort 在长运行中的语义（aborted=True）今日无法稳定触发（模型快速失败）；测试暂为显式结果二选一契约，工作模型可用后收紧。
- 容器化与独立工作副本未接入（架构 §5）：当前 `pi --mode rpc` 直接宿主运行；隔离 HOME 已验证配置可迁移。

## 16. 模型层验证补录：2026-10-12 晚（步骤 1 完成）

用户配置新模型服务后复测。**验收计划步骤 1 的"真实调用有结果"标准达成。**

| 项 | 实测结果 |
| --- | --- |
| 可用组合 | `--provider cc-switch-open-code-go --model deepseek-v4.1-flash`（`opencode-go` 订阅仍 403；其余 provider 无此模型）。live 测试命令已固定该组合，`FORGELOOP_PI_PROVIDER/FORGELOOP_PI_MODEL` 可覆盖 |
| 真实调用结果 | 提示词"Reply with exactly one word: ok" → 最终文本 **`'ok'`**；stopReason=stop；事件流健康（agent_start/turn/message×3/message_update 流式/agent_end/agent_settled 各 1，无重试） |
| 用量记录 | input 4477 + output 2 + cacheRead 640 = 5119 tokens，cost 0（事件流的 usage 字段，可取得的费用数据如实保存） |
| live 套件 | 5/5 通过（13.3s，模型层走文本分支；403 期间的显式错误契约测试同步保留为回归负例） |

诚实备注：`~/.pi/agent/settings.json` 的 defaultModel 仍为 kimi-k2.6（用户口头配置未落盘）；ForgeLoop 不依赖该默认——任务配置快照中的 `pi_command` 显式携带 provider/model（架构 V0-01 语义）。

## 17. git 工作副本与自迭代工程落地：2026-10-12 晚

自迭代的最后两块工程缺口关闭（`git 提供修改`）：

| 项 | 实现 |
| --- | --- |
| `adapter/git_workspace.py` | 独立工作副本：`git clone --no-hardlinks`（自有 .git 与引用，不与源仓库共享任何可写对象——架构 §5 main 保护）；基线 detached HEAD 检出（幂等：修复轮复用同一副本）；候选 diff = `git add -A` 后 `git diff <基线提交>`（覆盖修改/新增/删除/已提交，不依赖 PI 文本自述） |
| dev 节点 | `project_path` 配置时建立副本（计工时）；settled 后 git 工作区取真实 diff，无仓库时 payload 回退（pi_live 直用模式）；dev 报告记录 `diff_source` 与 `baseline_commit` |
| 交付报告 | git 工作区固化实际基线提交号（A02：最终交付明确基线与改动） |
| CLI | submit 校验 `project_path` 必须是 git 仓库（负例：非仓库 → SystemExit） |
| 假 PI | `edit` 模式真实修改工作副本（写入 feature.txt=new）；`plain-text` 模式走文本回退路径 |
| 场景测试 | **自迭代模拟**：源仓库（feature.txt=old + run_tests.py 断言 new）→ clone → 假 PI 改副本 → git diff（`-old/+new`）→ 副本内真实测试（exit 0）→ 交付（40 位基线提交号）→ **源 main 全程未被改写** |
| 负例补齐 | clone 失败包裹、非 git 源拒绝、model-error 场景（interrupted 不耗轮次）、确认停止（stopped）、纯文本审查回退、负工时构造拒绝、适配器模型错误/文本提取合成事件 15 项 |

**diff-cover 接入**（远程仓库出现触发）：用户建立 GitHub 远程（origin → Lijiajin95/ForgeLoop）后，覆盖门槛按设计从"不适用"切换为增量覆盖实测——`diff-cover reports/coverage.xml --compare-branch origin/main --fail-under 90` 并入 `check_coverage_thresholds.py`；实跑通过（changed-lines passed）。环境未安装 diff-cover 时显式 `integration_error`，不允许静默通过。

结构门槛抓到场景文件 507 行超限 → 按关注点拆分为 `test_flow.py`（核心闭环）/ `test_guards.py`（守卫负例）/ `test_self_iteration.py`（自迭代）+ 共享 `support.py`（conftest 注入路径），零例外豁免。
