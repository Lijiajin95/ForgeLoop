# 天工「代码可靠性」看板方案

- 状态：P1 已实现（2026-11-03）；P2 未做
- 日期：2026-11-03
- 范围：`conversation.view` 的 `forgeloop` 天工页新增「可靠性」视图；只读展示
- 相关：[架构 §4.3](architecture.md#43-天工层级工作台web-只读事实--客户动作)、[状态 §44–§50](status.md)、[Makefile](../Makefile)、[覆盖率配置](../packages/forgeloop/vitest.config.ts)

## 1. 目标与边界

### 1.1 目标

- 用一页回答两个问题：**当前代码的质量门禁是否通过**，以及**最近交付的变更是否可靠**。
- 每个数字都能回查到来源、生成时间、提交和样本量；门禁结果绑定一次具体快照。
- 未运行、未采集、过期、样本不足分别呈现，不显示为 `0` 或“通过”。
- 只读：页面不执行检查、不构建、不部署、不修改业务记录。

### 1.2 非目标

- 不替代 `make check`、CI、独立验证、业务终审或验收。
- 不新建第二套质量或业务状态；门禁快照是登记材料，运行指标来自现有 SQLite 表。
- 不做跨项目汇总；v1 只展示当前项目。
- 不在 v1 接入依赖漏洞、Semgrep、测试 flaky 率等尚无稳定数据源的指标（见 §3.4）。

## 2. 页面入口与结构

### 2.1 入口

在现有工作台视图基础上新增一个内部视图，顺序如下：

```text
层级工作台 | 全部任务 | 需要处理 | 可靠性 | 运维
```

- 视图键：`reliability`；中文标签「可靠性」，英文 `Reliability`。
- 页面标题用「代码可靠性」，导航标签用「可靠性」，避免窄屏挤压。
- `conversation.view` 的注册不变（`id=forgeloop`），只增加内部切换，不新增第二个页面入口。
- 保留现有的刷新与自动刷新；搜索框只用于层级/任务/问题视图，可靠性视图隐藏搜索框，避免无效输入。
- 导航计数显示“未通过门禁数”；没有快照时显示 `—`，不显示 `0`。

### 2.2 线框图

```text
┌ 代码可靠性 ─ ForgeLoop · main@5dd2041 · 快照 2026-11-03 09:12 ─ [7天][30天][90天][全部] [刷新] [自动] ┐
│ ⚠ 快照落后当前 HEAD 3 个提交；变异测试未在最近一次快照运行                    │
├ KPI：门禁 8/9 │ 测试 737 通过 / 1 跳过 │ 行覆盖 91.9% │ 变异 97.8% │ 验证通过 92% │ 上线核对 100% ┤
├ 门禁矩阵                                                                       ┤
│ 状态   门禁        实测        门槛      变化     最近执行        证据          │
│ 通过   类型检查    0 errors    0         —        11-03 09:10     .cache/...    │
│ 通过   ESLint      0 errors    0         —        11-03 09:10     .cache/...    │
│ 未运行 变异测试    —           ≥80       —        —               reports/...   │
├ 覆盖率                                                                         ┤
│ 行 91.9%   █████████░ 90    分支 84.6% ████████░░ 84                          │
│ 函数 96.7% █████████░ 93    关键文件 6/6 达标                                  │
│ [展开关键文件覆盖率明细]                                                       │
├ 交付可靠性（全部记录，按记录样本）                                             ┤
│ 独立验证 92%（n=25）  首轮验证 80%（n=20）  业务终审 100%（n=8）              │
│ 上线核对 100%（n=3）  失败轮次 12（每需求 1.5）                                │
│ 8 周趋势（通过/阻断）  [内联 SVG 柱状图 + 可展开表格]                          │
│ 失败阶段分布：planning 2 · review 3 · formal_test 4 · verification 2 · ...     │
│ 运维：已收口恢复率 80%（4/5） · MTTR 中位数 2.4h · 未解决 1                    │
├ 最近可靠性事件                                                                 ┤
│ - 11-03 09:20 验证阻断 req-...（打开需求）                                      │
│ - 11-02 18:10 上线核对失败 req-...（打开需求）                                  │
└ 口径：未采集/未运行不算通过；样本 < 5 标注“样本不足”；所有时间按本地时区显示。 ┘
```

### 2.3 页面区块与数据

| 区块 | 内容 | 刷新 |
| --- | --- | --- |
| 顶部状态条 | 项目、分支、快照提交、快照时间、新鲜度、窗口 | 随请求 |
| KPI 六卡 | 门禁通过、测试通过、行覆盖、变异得分、验证通过率、上线核对通过率 | 随请求 |
| 门禁矩阵 | 每项门禁的状态、实测、门槛、变化、最近执行、证据路径 | 随快照 |
| 覆盖率 | 行/语句/函数/分支进度条、关键文件明细 | 随快照 |
| 交付可靠性 | 验证、终审、上线、失败轮次、运维恢复、MTTR | 随窗口 |
| 趋势与事件 | 最近 8 周验证/失败/部署趋势、最近阻断与失败事件 | 随窗口 |
| 口径脚注 | 公式、排除项、缺失项、数据时间 | 静态 |

## 3. 展示的指标

### 3.1 代码质量门禁（点快照）

这一组指标来自一次显式的质量快照，绑定生成时间与 Git 提交；门槛只引用现有配置，不在页面复制一份新的门槛。

| 编号 | 指标 | 口径与公式 | 页面位置 | 门槛/目标 | 数据源 | v1 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 门禁总览 | `通过项 ÷ (pass + fail)`；`skipped`/`not_run` 不计入分母，单独提示；分母为 0 显示 `—` | KPI、门禁矩阵 | 全部已运行项通过 | 快照 `gates[]` | 是 |
| G2 | 类型检查 | `tsc --noEmit` 错误数 | 门禁矩阵 | `0` | `gate:typecheck` | 是 |
| G3 | ESLint | error 与 warning 数；error 决定通过 | 门禁矩阵 | error `0` | `gate:lint` | 是 |
| G4 | 格式 | Prettier 报告未格式化文件数 | 门禁矩阵 | `0` | `gate:format` | 是 |
| G5 | 架构契约 | `make contracts` 违规数 | 门禁矩阵 | `0` | `gate:contracts` | 是 |
| G6 | 行为测试 | `passed ÷ (total - skipped)`；同时显示 total、failed、skipped、文件数、耗时 | KPI、门禁矩阵 | failed `0` | `tests` | 是 |
| G7 | 行/语句覆盖率 | `covered ÷ total` | 覆盖率进度条 | 行 ≥ `90%` | `coverage.total.lines` | 是 |
| G8 | 函数覆盖率 | `covered ÷ total` | 覆盖率进度条 | ≥ `93%` | `coverage.total.functions` | 是 |
| G9 | 分支覆盖率 | `covered ÷ total` | 覆盖率进度条 | ≥ `84%` | `coverage.total.branches` | 是 |
| G10 | 关键文件覆盖率 | 6 个关键文件中，行/分支/函数三项都达到各自门槛的数量 | 覆盖率明细 | `6/6` | `coverage.files[]` + `vitest.config.ts` | 是 |
| G11 | 变异测试得分 | 按 Stryker 报告口径：`(Killed + Timeout) ÷ (Killed + Timeout + Survived + NoCoverage)`；分母为 0 视为未采集 | KPI、门禁矩阵 | break `80`、low `85`、high `95` | `reports/mutation.json` | 是 |
| G12 | 断言预算 | 当前 `as` 断言数 ÷ 基线；`当前 ≤ 基线` 为通过 | 门禁矩阵 | 只降不升 | `budget.assertions` | 是 |
| G13 | Token 预算 | 超过 25k 的文件数；最大文件 token；文件上限 25k | 门禁矩阵 | 超限 `0` | `budget.tokens` | 是 |
| G14 | ESLint 抑制条目 | `eslint-suppressions.json` 条目数 | 预算区 | 只减不增 | 抑制文件 | 是 |
| G15 | 依赖漏洞 | high/critical 漏洞数 | 门禁矩阵 | `0` | `npm audit` | P2 |
| G16 | 静态扫描 | Semgrep findings 数 | 门禁矩阵 | `0` | `reports/semgrep.json` | P2 |
| G17 | 测试稳定性 | 同一用例重复运行的失败率 | 明细 | 信息项 | 需多次运行记录 | P2 |

关键文件门槛引用现有 `vitest.config.ts` 的六个条目：`service.ts`、`coordinator.ts`、`repository.ts`、`verification.ts`、`admission.ts`、`retry-policy.ts`。页面与快照脚本不得各写一份门槛；实现时从配置或单一共享常量读取。

### 3.2 交付与运行可靠性（权威记录）

这一组指标来自 ForgeLoop 的 SQLite 记录。**只有追加型表可以按时间窗口统计**；`requirement_task_runs` 是可变当前状态，只能显示“当前”，不能画历史趋势。

| 编号 | 指标 | 口径与公式 | 页面位置 | 关注线 | 数据源 | v1 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 独立验证通过率 | `pass ÷ (pass + block)`，按 `verified_at` 落在窗口内；每条验证记录一票 | KPI、趋势 | 建议 ≥ `90%`；低于标黄，不阻断 | `requirement_verifications` | 是 |
| R2 | 首轮验证通过率 | 每个需求取全历史最早一条验证；若该条在窗口内且为 pass，计入分子；分母为窗口内有验证记录的需求数 | 明细 | 建议 ≥ `80%` | `requirement_verifications` | 是 |
| R3 | 业务终审通过率 | `pass ÷ total`，按 `reviewed_at` 窗口 | KPI | 建议 `100%` | `requirement_business_reviews` | 是 |
| R4 | 上线核对通过率 | `state = verified ÷ total`，按 `recorded_at` 窗口 | KPI | 建议 `100%` | `requirement_deployments` | 是 |
| R5 | 失败轮次 | 总数、每需求均值、按阶段分布（planning、implementation_review、formal_test、interrupted、verification、business_review、user_acceptance） | 明细、阶段柱状图 | 信息项，观察趋势 | `requirement_failure_rounds` | 是 |
| R6 | 任务交付率（当前） | 每个需求最新任务包中 `delivered` 任务数 ÷ 全部任务运行数 | 明细 | 信息项 | `requirement_task_runs` | 是 |
| R7 | 任务失败/阻塞占比（当前） | `(failed + blocked + awaiting_user) ÷ 全部任务运行数` | 明细 | 信息项 | `requirement_task_runs` | 是 |
| R8 | 运维事件恢复率 | `recovered_at` 非空的事件数 ÷ 已收口事件数；已收口 = 有 `recovered_at` 或 `state = unresolved/closed`；按 `opened_at` 窗口，进行中事件不计入分母 | KPI | 信息项 | `ops_events` | 是 |
| R9 | 运维 MTTR | 窗口内已恢复事件的 `recovered_at - opened_at` 中位数；同时显示样本数 | 明细 | 信息项 | `ops_events` | 是 |
| R10 | 未解决运维事件（当前） | 当前状态不属于 `recovered`/`closed` 的事件数 | 顶部提醒 | 理想为 `0` | `ops_events` | 是 |
| R11 | 候选构建数 | 窗口内成功记录的候选构建数（不是成功率；失败构建没有独立表） | 明细 | 信息项 | `requirement_candidate_builds` | 是 |
| R12 | 上线失败检查项 | 失败部署中 `checks[].ok = false` 的检查 ID 与次数 | 明细 | 信息项 | `requirement_deployments.checks_json` | 是 |
| R13 | 失败后交付率（当前） | 有失败轮次且当前全部任务已交付的需求数 ÷ 有失败轮次的需求数 | 明细 | 信息项 | 失败轮次 + 任务运行 | P2 |
| R14 | 需求取消/停止率 | 窗口内取消或停止需求数 ÷ 全部需求数 | 明细 | 信息项 | 取消/停止表 | P2 |

`关注线` 是展示用的建议值，不是新的硬门禁；若要变成阻断规则，必须另走方案与实现，不在本页偷偷放行或拦截。

### 3.3 趋势

- **交付趋势**：最近 8 个自然周，每周显示独立验证 pass/block 数、失败轮次数、上线核对 verified/failed 数。只用追加型表，按事件时间归周。
- **门禁趋势**：v1 显示“与上一份快照的差值”；完整的多快照折线放到 P2，需要保留快照历史。
- **不画**：任务运行状态的历史趋势。`requirement_task_runs` 每行只保留当前状态，用它回放历史会把后来状态错误地算进过去。
- 样本少于 5 时，数字照常显示，但标注“样本不足，趋势仅供参考”，不据此给出结论。

### 3.4 v1 不展示的指标

| 指标 | 原因 | 后续条件 |
| --- | --- | --- |
| 依赖漏洞、Semgrep | 当前活动工具链没有稳定产物；`make audit` 在受限网络下可能失败 | 先接入 CI 产物并在快照中登记状态 |
| flaky 率 | 需要同一用例多次运行的历史，目前不保存 | 增加重复运行记录后再做 |
| 变更前置时间、部署频率 | 现有记录没有可靠的“开始开发/发布”时间边界 | 需要新的时间事实，不能从任务更新时间猜测 |
| 跨项目可靠性排名 | 不在单项目看板范围 | 另立方案 |

## 4. 数据来源与真实性

### 4.1 现状核对（2026-11-03）

- 生成器已实现：`make reliability-report` 运行全部门禁并包含变异测试；`make reliability-report-fast`
  跳过变异并把该项记为 `not_run`。快照写入 `reports/reliability/latest.json`，历史保留最近 30 份；
  `reports/` 已被 Git 忽略，页面只读取本机生成物。
- 当日 `reliability-report-fast` 实测：8 项门禁通过（类型检查、ESLint、格式、契约、Token 预算、
  断言预算、行为测试、覆盖率），变异测试未运行；770 项测试 / 71 个文件通过；行/语句 92.47%、
  函数 96.45%、分支 84.11%；覆盖率明细 89 个文件，路径已统一为项目相对路径。
- 覆盖率与变异产物必须晚于本次测试/变异运行；脚本按 mtime 判断新鲜度，旧产物按未采集处理。
  覆盖率里指向项目根之外的路径会被丢弃，不混用其他工作树的结论。
- 断言预算当前 18 处（基线 18）；最大源文件为 `runtime/service.ts` 21,747 tokens（文件上限 25,000）。
- SQLite 已有 `requirement_verifications`、`requirement_business_reviews`、`requirement_deployments`、
  `requirement_failure_rounds`、`requirement_task_runs`、`ops_events` 等表，字段足够计算 §3.2 的指标。

结论：门禁矩阵只能来自上述显式快照；仅有覆盖率或变异 JSON 不能证明类型检查、lint、格式、契约与测试通过。

### 4.2 快照格式

快照是本地登记材料，写入 `reports/reliability/latest.json`（`reports/` 已被 `.gitignore` 忽略），
并保留最近 30 份历史到 `reports/reliability/history/`。建议结构如下；示例中的数字只示意字段形状，
不代表当前测量结果。

```json
{
  "schemaVersion": 1,
  "project": "ForgeLoop",
  "generatedAt": "2026-11-03T01:12:00.000Z",
  "git": { "head": "5dd2041...", "branch": "main", "dirty": false },
  "package": { "name": "forgeloop-dsh", "version": "0.0.2" },
  "gates": [
    {
      "id": "typecheck",
      "label": "类型检查",
      "status": "pass",
      "command": "make typecheck",
      "measured": 0,
      "unit": "errors",
      "threshold": 0,
      "durationMs": 12000,
      "at": "2026-11-03T01:10:00.000Z"
    }
  ],
  "tests": {
    "files": 68,
    "total": 738,
    "passed": 737,
    "failed": 0,
    "skipped": 1,
    "durationMs": 45000
  },
  "coverage": {
    "lines": 91.99,
    "statements": 91.99,
    "functions": 96.66,
    "branches": 84.6,
    "thresholds": { "lines": 90, "functions": 93, "branches": 84, "statements": 90 },
    "files": []
  },
  "mutation": {
    "score": 97.8,
    "killed": 178,
    "survived": 4,
    "timeout": 0,
    "noCoverage": 0,
    "thresholds": { "break": 80, "low": 85, "high": 95 }
  },
  "budgets": {
    "assertions": { "current": 18, "baseline": 18 },
    "tokens": { "fileLimit": 25000, "overLimit": 0, "maxFile": "", "maxTokens": 0 }
  },
  "suppressions": 0,
  "artifacts": {
    "coverage": "packages/forgeloop/coverage/coverage-summary.json",
    "mutation": "packages/forgeloop/reports/mutation.json",
    "vitest": "reports/vitest.json"
  }
}
```

`gates[].status` 只允许 `pass | fail | skipped | not_run`。`skipped` 与 `not_run` 都不算通过；
`measured` 缺失时写 `null`，不能写 `0`。`git.dirty = true` 时快照仍可展示，但必须标明“包含未提交改动，
结果不对应单一提交”。

### 4.3 新鲜度规则

| 状态 | 判定 | 页面 |
| --- | --- | --- |
| `missing` | 快照文件不存在 | 门禁区显示“未采集”与生成命令；其他区照常 |
| `invalid` | JSON 损坏、schema 不匹配、路径越界、文件过大 | 显示具体原因；不渲染半份数据 |
| `stale` | `git.head ≠ 当前 HEAD`，或 `git.dirty = true`，或 `generatedAt` 超过 7 天 | 正常显示数值，顶部黄色提醒并给每项标“过期” |
| `fresh` | 以上都不成立 | 正常显示 |

- 快照路径固定为 `<projectPath>/reports/reliability/latest.json`，不接受请求参数指定路径。
- 读取上限 256 KB；门禁最多 32 项；覆盖率明细最多 200 个文件；超出部分截断并提示。
- 快照生成时必须把覆盖率/变异产物中的绝对路径规范化为项目相对路径；发现文件不在当前项目根下，
  该产物标为 `invalid`，不混用另一个工作树的结果。

### 4.4 窗口与分母

- 允许窗口：`7d`、`30d`、`90d`、`all`；默认 `all`，页面与端点一致。
- 时间边界按服务器本地时区计算，响应同时返回窗口起止的 ISO 时间；页面按本地时间显示。
- 分母为 0 时返回 `null`，页面显示 `—（无样本）`，不显示 `0%`。
- 验证与终审按“每条记录”计，不按需求去重；首轮验证按“需求”计。页面必须同时显示样本数 `n`，避免把
  25 条记录误读成 25 个需求。
- 运维恢复率按“开启时间落在窗口内”的事件计；恢复时间可以晚于窗口结束，仍算该事件的恢复。
- 取消、停止、终审、上线核对的历史记录不因需求当前状态改变而重算。

### 4.5 禁止的推断

- 不用心跳、最后活动时间推断任务成功或失败。
- 不用任务当前 `delivered` 状态回放历史交付率。
- 不用文件名、顺序或模型总结补齐缺失的验证/审查记录。
- 不把“未运行”算成“通过”，也不把“没有失败记录”算成“零失败”。
- 不把候选构建成功数写成构建成功率；当前没有失败构建的独立记录。

## 5. 接口

新增一个只读端点，沿用现有认证看板路由：

```json
{ "endpoint": "reliability", "window": "all" }
```

响应要点：

```ts
{
  ok: true,
  value: {
    project: string,
    generatedAt: string,
    window: { key: '7d' | '30d' | '90d' | 'all', from: string | null, to: string },
    snapshot: {
      availability: 'fresh' | 'stale' | 'missing' | 'invalid',
      path: string,
      generatedAt: string,
      commit: string,
      branch: string,
      dirty: boolean,
      behindCommits: number | null,
      ageSeconds: number | null,
      packageVersion: string,
      gates: GateView[],
      tests: TestsView | null,
      coverage: CoverageView | null,
      keyCoverage: KeyCoverageView | null,
      mutation: MutationView | null,
      budgets: BudgetsView | null,
      suppressions: number,
      error: string,
      warnings: string[]
    },
    runtime: {
      verification: RateView,
      firstPassVerification: RateView,
      businessReview: RateView,
      deployment: RateView,
      failureRounds: {
        total: number,
        requirements: number,
        perRequirement: number | null,
        byStage: Record<FailureStage, number>
      },
      tasks: {
        total: number, delivered: number, failed: number,
        blocked: number, awaitingUser: number, running: number
      },
      ops: {
        opened: number, closed: number, recovered: number,
        unresolved: number, mttrSeconds: number | null
      },
      candidateBuilds: number,
      deploymentFailures: Array<{ checkId: string, count: number }>,
      trend: WeeklyReliability[],
      recentEvents: ReliabilityEventView[]
    },
    warnings: string[]
  }
}
```

- `RateView = { pass: number, total: number, rate: number | null }`；`rate = null` 表示无样本。
- 快照缺失是正常状态，返回 HTTP 200 与 `availability: 'missing'`；快照损坏也是 200 + `invalid` +
  原因，便于页面局部降级。`snapshot.warnings` 与顶层 `warnings` 都是可直接展示的字符串。
- 快照读取或运行聚合失败返回 HTTP 500 与 `internal` 错误；页面保留已有数据并显示错误横幅，
  不渲染伪造的空布局。
- 顶层 `warnings` 会把过期、样本不足与无记录转成提醒；页面不自行改写数值。
- `window` 只接受 `7d`、`30d`、`90d`、`all`；其他值返回 400。
- 端点只加入 `BOARD_ENDPOINTS` 的只读分支（`handleRead`），不加入任何写动作。
- 端点不执行项目命令；只读取固定路径的快照文件与 SQLite 聚合。当前 HEAD 用已有的
  `headCommit()` 读取（仅 `git rev-parse`），缓存 60 秒；读取失败时 `behindCommits = null`，
  页面显示“无法判断新鲜度”，不猜测。
- 快照读取按 mtime 缓存，避免每次轮询重复解析。

## 6. 页面状态与交互

### 6.1 状态

| 状态 | 页面表现 |
| --- | --- |
| 加载中 | KPI 与区块骨架，保持布局高度；不显示 `0` |
| 正常 | 所有区块按 §2.2 展示 |
| 快照缺失 | 门禁矩阵与覆盖率显示“未采集”，附 `make reliability-report` 提示；运行区正常 |
| 快照过期 | 顶部黄色提醒；门禁数值仍显示，但每项带“过期”标签；KPI 不宣称当前通过 |
| 快照损坏 | 门禁区显示错误原因与证据路径；运行区正常 |
| 无样本 | 对应指标显示 `—（无样本）`；不显示绿色通过 |
| 运行区失败 | 运行区独立错误与重试；门禁区不受影响 |
| 整体读取失败 | 显示错误与重试按钮；不覆盖已有数据，不伪造空布局 |

### 6.2 交互

- **窗口切换**：重新请求 `reliability` 端点并带上新窗口；服务端按 mtime 复用已解析的快照，
  门禁区不闪烁。切换期间保留旧数据，窗口标注仍是旧值直到响应返回。
- **刷新**：重新请求快照与运行指标；门禁快照按文件 mtime 判断是否需要重新解析。
- **自动刷新**：沿用现有开关；可靠性视图激活时每 30 秒请求一次，切走后停止。
- **下钻**：
  - 点击最近事件里的需求，先切回 `hierarchy` 视图，再调用现有 `openRequirement`，复用已有详情。
  - 失败轮次、验证记录与部署失败是窗口聚合，不伪造单条需求映射；只展示可回查的汇总。
  - 点击门禁行展开命令、门槛、耗时与证据路径；证据路径只读展示，不在浏览器里直接打开本地文件。
- **不提供**：运行检查、重跑测试、生成快照、修复、批准、验收等按钮。页面只读。
- **键盘与读屏**：视图切换保持 `role=tab`/`aria-selected`；表格有标题；进度条有
  `role=progressbar` 与 `aria-valuenow`；图表有文字摘要与可展开表格，不依赖颜色表达状态。
- **窄屏**：≤1100px 时 KPI 三列、运行率两列；≤820px 时进度条单列、门禁表横向滚动；
  ≤480px 时 KPI 两列，保留关键数字，不隐藏样本量。
- **文案**：中文/英文词典同时补齐；数字格式统一（百分比一位小数、计数整数、耗时转小时/分钟）。

## 7. 实施范围

### 7.1 分批

| 批次 | 内容 | 交付判断 | 状态 |
| --- | --- | --- | --- |
| P1-1 | 质量快照生成器与 `make reliability-report` | 快照包含 G1–G13；命令失败如实记录 | 完成 |
| P1-2 | 领域计算与只读仓储聚合 | 率、首轮、MTTR、阶段分布、新鲜度有行为测试 | 完成 |
| P1-3 | `reliability` 端点 | 只读、窗口校验、缺失/损坏/过期状态 | 完成 |
| P1-4 | 客户端视图、KPI、门禁矩阵、覆盖率、运行区 | 真实页面可见，窄屏可用，无写入口 | 完成 |
| P2 | 快照历史折线、依赖漏洞、Semgrep、flaky、失败后交付率 | 另列数据源与验证方案 | 未做 |

### 7.2 实际实施文件

| 文件 | 目的 | 类型 |
| --- | --- | --- |
| `docs/reliability-dashboard.md` | 本方案、指标口径与实施记录 | 新增 |
| `docs/README.md` | 文档索引加入专题方案 | 修改 |
| `scripts/ts/reliability-report.ts` | 运行门禁、读取覆盖率/变异/测试 JSON、生成快照与历史 | 新增 |
| `Makefile` | 增加 `reliability-report` 与 `reliability-report-fast` 目标 | 修改 |
| `packages/forgeloop/src/domain/reliability.ts` | 纯计算：率、首轮、中位数、阶段分布、新鲜度、快照解析 | 新增 |
| `packages/forgeloop/src/records/reliability-store.ts` | 只读 SQL 聚合，避免逐需求 N+1 | 新增 |
| `packages/forgeloop/src/records/dev-session-store.ts` | 继承链让运维/可靠性查询共用同一 Repository | 修改 |
| `packages/forgeloop/src/runtime/reliability.ts` | 读取快照、校验、组合运行指标，按仓库实例缓存 | 新增 |
| `packages/forgeloop/src/runtime/service.ts` | 暴露只读 `reliability(window)` | 修改 |
| `packages/forgeloop/src/runtime/board-route.ts` | 增加 `reliability` 只读端点与窗口校验 | 修改 |
| `packages/forgeloop/client.js` | 新视图、词典、KPI/矩阵/覆盖率/趋势、响应式样式 | 修改 |
| `packages/forgeloop/tests/reliability.test.ts` | 领域与快照解析行为测试 | 新增 |
| `packages/forgeloop/tests/reliability-records.test.ts` | 只读聚合与窗口行为测试 | 新增 |
| `packages/forgeloop/tests/reliability-runtime.test.ts` | 快照缺失/损坏/过期与组合视图测试 | 新增 |
| `packages/forgeloop/tests/board-route.test.ts` | 端点窗口与分发测试 | 修改 |
| `packages/forgeloop/tests/client-view.test.ts` | 新视图顺序与词典注册 | 修改 |
| `docs/architecture.md` §4.3 | 新视图、端点与只读边界 | 修改 |
| `docs/status.md` | 实施批次、检查结果与未完成项 | 修改 |
| `CONTEXT.md` | “代码可靠性看板”术语与工作台视图清单 | 修改 |

没有修改 `vitest.config.ts`：测试 JSON 由命令行 `--reporter=json --outputFile` 生成；token 与断言脚本
已有可解析的文本输出，因此不需要新增 `--json`。

### 7.3 验证

- **领域测试**：零分母返回 `null`；首轮验证只取最早一条；MTTR 中位数；阶段分布；缺失/过期判定；
  路径规范化拒绝越界文件；`not_run` 不计入通过率。
- **快照脚本测试**：用固定 fixture 的覆盖率/变异/测试 JSON 生成快照；命令失败记录 `fail`；
  跳过变异记录 `not_run`；`git.dirty` 标记。
- **路由测试**：`window` 非法 400；无快照 200 + `missing`；损坏快照 200 + `invalid`；
  运行聚合返回预期率；端点不写任何表。
- **客户端测试**：注册新视图、词典键齐全、入口顺序、没有新增写动作。
- **工程检查**：`make check`、`make coverage`、`make contracts`、`make format`；客户端改动后
  运行 `make build` 与真实 3080 页面刷新检查。
- **真实页面**：正常、无快照、过期快照、运行区失败、390px 五种状态；切换窗口不丢门禁区；
  打开需求详情能回到层级工作台。

### 7.4 验收标准

1. 天工页出现「可靠性」入口，其他视图行为不变。
2. 有快照时，G1–G13 的数值、门槛、状态与快照文件逐项一致；没有快照时显示“未采集”而不是通过。
3. 运行指标的率、样本数、首轮、MTTR 与 fixture 记录一致；无样本显示 `—`。
4. 快照提交与当前 HEAD 不一致、工作树脏或超过 7 天时，页面明确标记过期，仍可查看历史数值。
5. 端点只读，页面没有执行检查、构建、部署或写入业务状态的入口。
6. `make check` 通过；新增行为测试覆盖拒绝与允许两侧；真实页面在 390px 下可用。
7. 文档同步：架构、状态、术语与索引与实际实现一致；未完成项如实列出。

## 8. 已确认的决定

1. **导航位置与名称**：放在「需要处理」与「运维」之间，中文「可靠性」、英文 `Reliability`。
2. **保留运行可靠性层**：保留验证、首轮验证、业务终审、上线、失败轮次与运维恢复；静态门禁不能说明交付是否可靠。
3. **默认窗口**：`all`，并保留 `7d/30d/90d`；数据少时标注样本不足。
4. **快照生成时机**：显式执行 `make reliability-report` 或 `make reliability-report-fast`，不在页面请求里跑检查；
   夜间 CI 接入未做，留待 P2 另行确认。

## 9. 未完成

- P2：快照历史折线、依赖漏洞、Semgrep、flaky、失败后交付率与跨项目汇总。
- 变异测试只在 `make reliability-report`（非 fast）运行时采集；最近一次 fast 快照显示 `not_run`。
- 页面不提供生成快照、重跑检查、修复、批准或验收入口；这些动作仍需显式命令或既有会话流程。
- 真实页面验收需在部署后的 3080 端口复核；未执行前不把本页视为线上已验收。
