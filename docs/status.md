# ForgeLoop 状态记录

本文件是 ForgeLoop **当前状态**的唯一记录入口。README 只描述稳定的产品范围与文档索引，不写当前状态；逐批次的实测过程、失败与门禁细节保留在[工程可靠性方案](engineering-reliability.md)第 13–19 节。

更新规则：实现批次、门槛数字、CI 与远程状态变化后更新本文件；只写实际执行的证据，未执行或未验证的事项如实标记（沿用历史记录时注明来源）。

## 1. 当前状态（截至 2026-10-13 09:40，Asia/Shanghai）

首版 CLI 闭环已实现并通过工程门槛，**尚未在真实任务上跑通**（见第 6 节缺口）。CD 的受控发布（S1）与受控部署（S2）已实现，本机已完成首次引导部署（独立版本目录 + 原子切换 + 部署回执）；S3 的合入门槛方案 B（候选分支流程）已实现，S1–S3 全部改动已提交并推送 GitHub（`f28635c`），推送 CI 三作业 success。

### 实现范围

| 层 | 内容 |
| --- | --- |
| domain | 失败轮次计数与累计、追加授权额度、批准绑定任务身份与方案版本、执行时间限额、提交时间策略、受控归并规则、受控发布规则、受控部署与回滚规则 |
| records | SQLite 权威记录（任务、批准、计划、失败轮次、交付、归并、发布、停止） |
| adapter | PI RPC（JSONL 帧、命令/响应 id 关联、abort、模型错误如实上报）、正式测试命令运行器、独立 git 工作副本与发布标签、本机部署（下载 Release 资产、独立版本环境、原子切换、冒烟检查、部署日志） |
| graph | LangGraph 两次批准（方案／验收）、失败回边、追加授权 |
| cli | `submit` / `approve` / `grant` / `status --json` / `stop` / `merge` / `release` / `deploy` / `rollback` |
| 自迭代链路 | submit → 批准 → PI 副本实现 → 独立审查 → 副本内真实测试 → 人工验收 → `merge`（绑定验收基线、漂移拒绝、推送 GitHub） |
| CD 受控发布（S1） | `release` 创建 annotated tag 并按需推送 → Release 工作流从标签构建一次产物并附 `SHA256SUMS` → 发布回执固化标签／归并提交／基线／候选 diff 校验值；同标签重复发布幂等、换标签拒绝 |
| CD 受控部署（S2） | `deploy` 只部署 Release 上同一份产物（校验值不匹配即拒绝，禁止重新构建）→ 独立版本目录 `releases/<version>` → 原子切换 `current` → 冒烟检查 → 部署日志；`rollback` 只切到已安装且留有校验记录的版本 |

### CD 进展（P1）

| 段 | 状态 |
| --- | --- |
| S1 受控发布 | 代码与门槛已落地（`forgeloop release`、`releases` 表、发布回执、Release 工作流、CLI 契约含 release 节）；场景测试覆盖发布／同标签幂等／换标签拒绝／未归并拒绝；**尚无真实标签**——首个发布要等真实任务归并后、由所有者指定版本号执行 |
| S2 本机部署 | 代码与门槛已落地（`deploy` / `rollback`、部署日志、deploy 工作流）；**本机已完成一次真实引导部署**（`v0.0.1`，来源 bootstrap，校验值 `ab03c198…c4e`，冒烟 exit 0，独立 venv Python 3.13.5）；「Release → 自托管 runner → 部署」链路与真实两版本回滚**尚未执行**（见[部署说明](deployment.md)） |
| S3 CI 合入门槛 | **方案 B 已实现并已推送**（`0f4aa3b`）：`forgeloop merge` 有远程时默认走"候选分支 → 匿名等必需检查 → 快进 main → 删候选分支"，失败/超时保持 main 不动并保留分支，证据写入 `merge-evidence.json`（本地真实 git + 假检查状态已实测）；**ruleset 仍未设置**，需所有者按[分支保护方案](branch-protection.md)在网页执行（Evaluate → Active） |

### 验证数字（对应提交 `f28635c`，已推送；Debian 本机 2026-10-13 实测）

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| `make check` | 十项门槛 exit 0（lint、format、typecheck、test、cli-contract-check、commit-policy-config、structure-metrics、import-lint、deptry、pylint）；结构 0 失败 / 22 警告 | 本地实跑（S1+S2 落地后） |
| 测试 | 快速套件 337 项通过；含集成 355 项通过、5 项 pi_live 显式跳过；系统层 2 项通过 | 本地实跑 |
| 覆盖率 | 行 96.66%、分支 92.16%；diff-cover 增量对 `origin/main` 通过 | `reports/coverage.xml` 与门槛脚本 |
| 变异 | 512/596 杀死、84 幸存（84 条全部审阅登记）、0 未完成状态；判定含可疑项复测；S1 `domain/release.py`、S2 `domain/deploy.py`、S3 `domain/merge.py` 均已纳入范围 | 本机实跑（清缓存重跑，`mutants/mutmut-cicd-stats.json`） |
| CLI 契约 | `contracts/cli-contract.json` 快照一致（含 merge 与 release 节），受控漂移负例可拒绝 | `make cli-contract-check` |
| 部署现场 | `~/.local/share/forgeloop`：`releases/0.0.1` + `current` 指针 + `deployments.jsonl`；`~/.local/bin/forgeloop` 指向 current；已安装 CLI 独立 venv（Python 3.13.5） | 本机真实引导部署（2026-10-13 08:10） |
| SAST | Semgrep 4 条规则、35 个目标、0 findings（含 release/deploy 工作流） | `make sast` 本地实跑 |
| 部署守卫（真实前缀） | 同版本不同产物被拒：已激活 `ab03c19885c7` vs 待部署 `986a885b4821`，exit 1，已安装版本与部署日志未变 | 本机实测（2026-10-13 09:2x，`~/.local/share/forgeloop`） |
| pi_live | 5/5 通过（真实 PI RPC＋真实模型 `cc-switch-open-code-go/deepseek-v4.1-flash`） | Debian 本机实测（`reports/local-pi-live.log`）；证据探针取得真实文本 `ok`、stderr 空（`.cache/pi-live-evidence/sessions/`） |

### CI 状态

| 作业 | 触发 | 最近运行 | 结果 |
| --- | --- | --- | --- |
| quality / security / commit-policy | push、PR、手动 | [38331898625](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38331898625)（提交 f28635c，2026-10-13 09:23） | 三作业 success（`commit-policy`、`quality`、`security`） |
| mutation | 每日 19:00 UTC（= 03:00 Asia/Shanghai）、手动 | [38330443954](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38330443954)（提交 4394282） | success；本机同批实测 `512/596 killed, 84 survivors (84 reviewed)` |
| Release | 标签 `v*` 推送 | 尚未运行（仓库无标签） | 未执行 |
| Deploy | Release 发布或手动 | 尚未运行 | 未执行 |

自托管 runner 已在本机安装并在线，**GitHub 侧标签已确认**：`debian-forgeloop`（`self-hosted`、`Linux`、`X64`、`forgeloop-deploy`）状态 **Idle**（2026-10-13 所有者核对 Runners 页面）。安装见[自托管 runner 说明](self-hosted-runner.md)。

修复前四作业全绿记录见 [38258313311](https://github.com/Lijiajin95/ForgeLoop/actions/runs/38258313311)。下一次自动变异运行：2026-10-13 03:00（Asia/Shanghai）。

### 远程与提交

- `origin` → `Lijiajin95/ForgeLoop`；`main` 与 `origin/main` 均为 `f28635c`，工作树干净，无标签、无 stash。
- 2026-10-13 上午推送三个提交：`f35ff0c` 所有者授权的临时提交窗口修订、`0f4aa3b` S1–S3 代码与测试、`f28635c` 文档（部署/runner/分支保护/状态）。
- 更早的主要提交（完整列表见 `git log`）：`71d74eb` 变异门槛修复、`fe7b249` CI 结果记录、`59fc87e` CI 节奏调整、`4faa283` 新节奏执行记录、`7301fb1` 状态记录拆分。

### 所有者决定（2026-10-12）

- 撤销 30 小时人工投入上限与人工时间／ROI 测量；价值判断以交付质量与使用体验为准。
- B04（验收后自动归并 main 与 GitHub 同步）提前启用。
- 变异门槛移出推送关键路径，改为每日作业（推送 CI 保留三作业）。
- 2026-10-12 深夜：**CD 交付目标定为本机 Debian 设备**（提前启用 B05），要求只部署同一份已验收产物并保留可核对的回滚入口。
- 发布版本号由所有者**显式指定**（`vMAJOR.MINOR.PATCH`），不自动递增；自动版本体系仍属 B06。
- 部署触发方式：GitHub Actions **自托管 runner**，专用标签 `forgeloop-deploy`，仅部署作业使用本机。

### 所有者决定（2026-10-13）

- S3 采用**方案 B**（候选分支 → 匿名等待必需检查 → 快进 main → 删除候选分支，不需要 PAT）：代码侧已实现并实测。
- **明确授权在禁止提交窗口内提交 S1–S3 批次**，并选择"临时策略修订"路径：`config/commit-policy.toml` 的 `blocked_start`/`blocked_end` 临时由 `09:00–18:00` 缩为 `00:00–00:01`（策略要求 `start < end`，无法置零），文件内已留痕原值与恢复义务。
- **待恢复（必须完成）**：2026-10-13 18:00 之后的合法窗口把 `blocked_start = "09:00"`、`blocked_end = "18:00"` 写回并删除临时期说明；恢复本身也是一次 commit，必须落在合法窗口内。恢复前不得把本项标记为完成。

## 2. A01 真实闭环

尚未执行：仓库内没有 `.forgeloop/records.sqlite` 真实任务记录，第一个真实小任务（候选：为 `status --json` 增加字段）未提交。自迭代链路的证据目前来自场景测试（`tests/scenario/test_self_iteration.py`，使用假 PI 真实改副本、真实 diff、副本内真实测试，源 main 未被改写），**不等于**真实模型闭环已验证。

## 3. 已实现的工程门槛

结构度量、覆盖、变异、CLI 契约、提交策略、依赖审计（pip-audit）、Semgrep 四条规则、Import Linter、deptry、pylint 均已落地并有可重跑负例；门槛来源为 `config/quality-policy.toml`。变异门槛对首次测量与清单不一致的项复测一次后再判定，用于吸收 mutmut 子集测试的运行级噪声（±1 变异体）。细节与负例矩阵见方案第 11 节、第 19 节。

## 4. 运行方式（现状）

- 本地：`make setup`、`make check`、`make coverage`、`make mutation`、`make security`、`make test-system`、`make pi-live`（显式选择加入）。
- CLI 附加命令：`forgeloop merge`（B04 受控归并：有远程时默认走候选分支 + 等必需检查 + 快进 main；`--direct-push` 为不安全直推、`--require-checks none` 用于无 CI 仓库）、`forgeloop release <task> --tag vX.Y.Z`（S1 受控发布；`--no-push` 只建本地标签）、`forgeloop deploy --tag vX.Y.Z`（S2 受控部署；`--artifact … --bootstrap` 为工具首次安装的引导路径）、`forgeloop rollback [--to X.Y.Z]`。
- 已安装 CLI：`~/.local/bin/forgeloop`（→ `~/.local/share/forgeloop/current/bin/forgeloop`）；部署与回滚细节见[部署说明](deployment.md)。
- CI：推送三作业 + 每日变异作业 + 标签发布的 Release 作业 + 自托管 runner 上的 Deploy 作业；分支保护与必需状态检查**未设置**（方案见[分支保护方案](branch-protection.md)），CI 结果目前不是合入门槛。

## 5. 与历史记录的关系

本文件只保留“现在是什么状态”；为什么这样改、失败与验证过程见[工程可靠性方案](engineering-reliability.md)第 13–19 节；后续要做的事见[待实现需求列表](pending-requirements.md)与[RoadMap](roadmap.md)。

## 6. 未完成与缺口（如实记录）

| 项 | 现状 |
| --- | --- |
| A01 真实代码闭环 | 未执行（无真实任务记录） |
| A05 备份 | 未执行（依赖本机独立硬盘） |
| 分支保护／必需状态检查 | 未设置；方案与操作步骤见[分支保护方案](branch-protection.md)（含"先 Evaluate 后 Active"）；代码侧候选分支流程已实现并实测 |
| 变异回归发现延迟 | 最多滞后一天；夜间失败只有 Actions 页面可见（无通知） |
| 变异判定噪声 | 已通过复测确认收敛，但源头（mutmut 子集测试偶发失败）未根除 |
| `make hooks` | **已安装并实际执行**（2026-10-13 09:1x 装 pre-commit / pre-push / commit-msg；本次三个提交与推送均经 hook 校验通过） |
| 容器隔离 | PI 仍直接宿主运行（架构 §5 的受限容器未接入） |
| S1 真实发布 | 未执行：仓库无标签，也没有真实任务归并记录；首个发布需 A01 完成后由所有者指定版本号执行 `forgeloop release` |
| S2 真实部署链路 | 引导部署已在真实前缀执行；**「Release → 自托管 runner → 本机部署」未执行**（需先有真实发布），真实两版本回滚未演练（本机仅一个版本） |
| S3 CI 合入门槛 | 代码侧完成（候选分支流程 + 检查判定）；**ruleset 未设置**（需所有者网页操作）；GitHub 真实检查下的端到端归并**未验证**（本地用假检查状态覆盖通过/失败/超时/重试） |
| 工作树清洁 | 干净（HEAD = `f28635c` = `origin/main`）；`email.txt` 与 `.forgeloop/` 已加入 `.gitignore`（所有者要求个人草稿不入库；记录目录属本机现场），未跟踪文件不再弄脏工作树、不再阻断 `forgeloop merge` |
| 提交窗口临时修订 | **未恢复**：`config/commit-policy.toml` 现为临时的 `00:00–00:01`，必须在 2026-10-13 18:00 之后的合法窗口恢复为 `09:00–18:00`；恢复前的提交不受时段保护，恢复前不得把本项标记为完成 |
| 已安装 CLI 版本 | `~/.local/bin/forgeloop` 仍是 `v0.0.1` 引导构建（早于 S1–S3 代码）；升级需经受控路径并使用**新版本号**（同版本不同产物已被守卫拒绝），属 S1 真实发布之后的事 |
