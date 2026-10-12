# ForgeLoop 状态记录

本文件是 ForgeLoop **当前状态**的唯一记录入口。README 只描述稳定的产品范围与文档索引，不写当前状态；逐批次的实测过程、失败与门禁细节保留在[工程可靠性方案](engineering-reliability.md)第 13–19 节。

更新规则：实现批次、门槛数字、CI 与远程状态变化后更新本文件；只写实际执行的证据，未执行或未验证的事项如实标记（沿用历史记录时注明来源）。

## 1. 当前状态（截至 2026-10-12 23:00，Asia/Shanghai）

首版 CLI 闭环已实现并通过工程门槛，**尚未在真实任务上跑通**（见第 6 节缺口）。

### 实现范围

| 层 | 内容 |
| --- | --- |
| domain | 失败轮次计数与累计、追加授权额度、批准绑定任务身份与方案版本、执行时间限额、提交时间策略、受控归并规则 |
| records | SQLite 权威记录（任务、批准、计划、失败轮次、交付、归并、停止） |
| adapter | PI RPC（JSONL 帧、命令/响应 id 关联、abort、模型错误如实上报）、正式测试命令运行器、独立 git 工作副本 |
| graph | LangGraph 两次批准（方案／验收）、失败回边、追加授权 |
| cli | `submit` / `approve` / `grant` / `status --json` / `stop` / `merge`（`--no-push` 可选） |
| 自迭代链路 | submit → 批准 → PI 副本实现 → 独立审查 → 副本内真实测试 → 人工验收 → `merge`（绑定验收基线、漂移拒绝、推送 GitHub） |

### 验证数字（提交 4faa283 的代码状态，2026-10-12 23:00 实测）

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| `make check` | 十项门槛 exit 0（lint、format、typecheck、test、cli-contract-check、commit-policy-config、structure-metrics、import-lint、deptry、pylint） | 本地实跑 |
| 测试 | 快速套件 216 项通过；含集成 234 项通过、5 项 pi_live 显式跳过；系统层 2 项通过 | 本地实跑 |
| 覆盖率 | 行 96.06%、分支 91.85%；diff-cover 增量对 `origin/main` 通过 | `reports/coverage.xml` 与门槛脚本 |
| 变异 | 200/246 杀死、46 幸存（46 条全部审阅登记）、0 未完成状态；判定含可疑项复测 | 本机与 Linux 容器实测；CI 运行 38264830328 日志同值 |
| CLI 契约 | `contracts/cli-contract.json` 快照一致（含 merge 节），受控漂移负例可拒绝 | `make cli-contract-check` |
| pi_live | 5/5 通过（真实 PI RPC＋真实模型 `cc-switch-open-code-go/deepseek-v4.1-flash`） | 方案第 16 节记录（2026-10-12 晚），本会话未复跑 |

### CI 状态

| 作业 | 触发 | 最近运行 | 结果 |
| --- | --- | --- | --- |
| quality / security / commit-policy | push、PR、手动 | [38265014611](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38265014611)（提交 4faa283） | 三作业 success |
| mutation | 每日 19:00 UTC（= 03:00 Asia/Shanghai）、手动 | [38264830328](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38264830328)（手动触发） | success，`200/246 killed, 46 survivors (46 reviewed)` |

修复前四作业全绿记录见 [38258313311](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38258313311)。下一次自动变异运行：2026-10-13 03:00（Asia/Shanghai）。

### 远程与提交

- `origin` → `Lijiajin95/ForgeLoop`；核验时 `main` 与 `origin/main` 同步，无未推送提交、无标签、无 stash。本文件的验证数字对应代码提交 `4faa283`；其后的文档提交以 `git log` 为准。
- 2026-10-12 晚的主要提交（完整列表见 `git log`）：`71d74eb` 变异门槛修复、`fe7b249` CI 结果记录、`59fc87e` CI 节奏调整、`4faa283` 新节奏执行记录、`7301fb1` 状态记录拆分。

### 所有者决定（2026-10-12）

- 撤销 30 小时人工投入上限与人工时间／ROI 测量；价值判断以交付质量与使用体验为准。
- B04（验收后自动归并 main 与 GitHub 同步）提前启用。
- 变异门槛移出推送关键路径，改为每日作业（推送 CI 保留三作业）。

## 2. A01 真实闭环

尚未执行：仓库内没有 `.forgeloop/records.sqlite` 真实任务记录，第一个真实小任务（候选：为 `status --json` 增加字段）未提交。自迭代链路的证据目前来自场景测试（`tests/scenario/test_self_iteration.py`，使用假 PI 真实改副本、真实 diff、副本内真实测试，源 main 未被改写），**不等于**真实模型闭环已验证。

## 3. 已实现的工程门槛

结构度量、覆盖、变异、CLI 契约、提交策略、依赖审计（pip-audit）、Semgrep 四条规则、Import Linter、deptry、pylint 均已落地并有可重跑负例；门槛来源为 `config/quality-policy.toml`。变异门槛对首次测量与清单不一致的项复测一次后再判定，用于吸收 mutmut 子集测试的运行级噪声（±1 变异体）。细节与负例矩阵见方案第 11 节、第 19 节。

## 4. 运行方式（现状）

- 本地：`make setup`、`make check`、`make coverage`、`make mutation`、`make security`、`make test-system`、`make pi-live`（显式选择加入）。
- CI：推送三作业 + 每日变异作业；分支保护与必需状态检查**未设置**，CI 结果目前不是合入门槛。

## 5. 与历史记录的关系

本文件只保留“现在是什么状态”；为什么这样改、失败与验证过程见[工程可靠性方案](engineering-reliability.md)第 13–19 节；后续要做的事见[待实现需求列表](pending-requirements.md)与[RoadMap](roadmap.md)。

## 6. 未完成与缺口（如实记录）

| 项 | 现状 |
| --- | --- |
| A01 真实代码闭环 | 未执行（无真实任务记录） |
| A05 备份 | 未执行（依赖本机独立硬盘） |
| 分支保护／必需状态检查 | 未设置（`gh api …/branches/main/protection` → 404） |
| 变异回归发现延迟 | 最多滞后一天；夜间失败只有 Actions 页面可见（无通知） |
| 变异判定噪声 | 已通过复测确认收敛，但源头（mutmut 子集测试偶发失败）未根除 |
| `make hooks` | 未安装（pre-push 快速测试 hook 未验证） |
| 容器隔离 | PI 仍直接宿主运行（架构 §5 的受限容器未接入） |
