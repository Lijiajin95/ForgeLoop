# 贡献与提交规范

ForgeLoop 是个人研发工具项目。许可方式（代码与文档）由所有者后续决定；未决定前不对外分发代码。贡献遵循本规范与[研发纪律](docs/development-discipline.md)。

## 提交时间限制

**北京时间（Asia/Shanghai），法定调休工作日的 09:00（含）至 18:00（不含）禁止创建 commit。** 午间仍在禁止窗口内。周末如被安排为调休工作日，同样禁止；法定放假日按已维护日历处理。

策略存放在 `config/commit-policy.toml`，年度安排存放在 `config/workday-calendars/`，每份日历附官方出处和核验日期。2026 年按国务院办公厅通知维护，包括 1 月 4 日、2 月 14/28 日、5 月 9 日、9 月 20 日和 10 月 10 日的调休工作日。[官方通知](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html)

缺少年度日历时，09:00–18:00 期间拒绝提交，不默认把未知年份的周末当成休息日；窗口之外可提交。次年官方通知公布后，应在非禁止时段更新日历，核对放假、补班、跨年日期及边界测试。

规范要求本地 `pre-commit` 与 `commit-msg` 都读取真实时钟；`commit-msg` 同时检查消息。CI 核对新增 commit 的作者时间、提交者时间和消息，按北京时间转换，CI 的运行时间不作为 commit 创建时间。禁止使用 `--no-verify`、禁用 hooks 或伪造时间戳绕过项目规则。当前 `scripts/check_commit_policy.py` 尚未实现，激活顺序见[工程可靠性方案](docs/engineering-reliability.md#10-激活顺序骨架--可执行)；该脚本落地前按本规范人工执行。

Git 本地 hooks 可以被仓库使用者绕过；CI 核对的 Git 时间戳也不是不可伪造的外部时间证明。发布远程仓库后须设置受保护分支与必要状态检查，才能把检查结果落实为合入门槛。

## Commit 消息与范围

遵循 Conventional Commits 的项目约定：

```text
type(scope): 简洁描述

说明修改原因、行为变化和验证方式（必要时）。
```

支持 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。scope 可省略；建议使用 `cli`、`graph`、`adapter`、`domain`、`records`、`quality`、`docs` 等明确范围。描述可使用中文，首行最多 100 个字符，禁止空描述及前后多余空格。

破坏兼容性时使用 `!`，并在正文解释迁移方式及影响，例如 `feat(cli)!: 调整 status 输出契约`。格式校验只检查首行语法，破坏性变更和 footer 的正确性仍需审阅。[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

一个 commit 表达一个可解释、可验证的变化。行为变更与回归测试同行；无关重构、格式修改和新功能尽量分开。合入优先保持符合规范的线性历史；GitHub squash 或 merge 创建的新 commit 也须遵守提交时间约束。

## 架构描述同步

架构的人工权威描述是[架构说明](docs/architecture.md)，机读事实是 `contracts/architecture.json`。两者与源码必须同时成立，缺一不可。

以下情况属于**架构变化**，必须在同一次改动中更新上述两份文件：

- 模块的新增、删除、改名或换层；
- 跨层依赖方向的新增、删除或改变；
- `scripts/export_architecture_contract.py` 中 `LAYER_RULES` 允许依赖表的改变；
- 业务图节点增删或拓扑、路由改变；
- 持久化介质、记录表结构或现场产物文件名的改变；
- 外部依赖系统的新增或替换、接缝形态的改变。

流程：改代码 → 更新[架构说明](docs/architecture.md)（至少层与模块清单）→ 运行 `make architecture-contract` 重新导出快照 → 运行 `make check`。方向性选择（换编排框架、换执行器、改变分层）另写[分层决策](docs/adr/)记录，ADR 只回答「为什么」，架构说明回答「现在是什么」。

该义务由 `make architecture-contract-check`（含在 `make check` 内）机器强制：模块增删换层、跨层边漂移、越层依赖、import 环，以及架构说明的模块清单与源码不互为镜像，任一发生即失败。同层内部重构且不改变任何边时不算架构变化，但快照仍须保持一致。

## 开发与检查

先阅读[研发纪律](docs/development-discipline.md)与[工程可靠性方案](docs/engineering-reliability.md)，执行 `make setup`、`make hooks` 和 `make check`（当前骨架不可执行，随首批代码激活）。提交前运行相关测试；涉及 CLI 输出、PI Adapter、容器边界或安全时，执行对应层级检查并记录结果。

PR 说明要描述用户问题、修改后的行为、验证证据和实质限制。CLI 输出变更同时更新契约快照；新增外部依赖需说明用途、许可、锁定版本和运行成本。缺失、跳过、超时及不稳定测试保留在结果中。

简单优先，只修改已确认方案列出的文件；范围外发现写入变更摘要的“发现但不碰”。新增关键判断、计算、状态流转和幂等逻辑，先运行失败的行为测试，再实现使其通过，之后在测试保护下改善结构。其他改动按风险选择验证方式。核心领域规则同时接受属性与变异检查；不以覆盖率、绿色 CI 或模型自评代替用户任务验收。
