# 需求库重建设计：多源提取与确认闭环（设计稿）

状态：**设计稿，未实施**（2026-11-16）。本文只定义方案，不代表代码已具备；实施前按
[AGENTS](../../AGENTS.md) 的 worktree、行为测试与 `make check` 流程执行。
相关入口：[产品与首版方案](../product/product.md)、[当前架构](architecture.md)、
[状态记录](../verification/status.md)、[领域术语](../../CONTEXT.md)、
[需求库条目格式](../../packages/forgeloop/src/domain/library.ts)。

## 1. 目标与非目标

### 目标

- 任何**租户项目**都能从自身仓库与记录重建需求库，不依赖作者记忆，不写死在 ForgeLoop 仓库上。
- 产出**可审计的草案**：每条候选带证据（提交、文档小节、测试、代码表面），能在产品页展开核对。
- 覆盖三类条目：产品目标与范围（`goal`）、已确认决策（`decision`）、能力与验收（`capability` / `acceptance`）。
- 重建过程幂等、可中断、可重跑；草案与正式库分离，确认前不进入分析上下文。

### 非目标

- 不自动把草案标为 `confirmed`：提交、代码、测试都不是所有者授权。
- 不覆盖或删除已确认条目；同主题只生成取代提案（supersede）与冲突列表。
- 不跨项目读取：所有路径来自当前租户 `config.projectPath`/`recordsRoot`。
- 不把验证数字、测试数、覆盖率、版本号、安装记录写进库——这些会立刻过时。
- 不评估费用与工期，不在重建中执行项目命令（Git 只读）。

## 2. 事实等级与证据规则

需求库的价值在于“可追溯的结论”，因此先固定来源等级：

| 等级 | 来源 | 能产出 | 可信度 |
| --- | --- | --- | --- |
| L4 | 所有者确认、结构化访谈 | 目标、取舍、非目标 | 唯一可 `confirmed` |
| L3 | 产品文档、ADR、变更日志、状态批次记录 | 目标、决策、边界 | 高 |
| L2 | 测试与对外契约（可执行规格） | 验收标准、业务规则、状态机 | 中高 |
| L1 | 代码表面：端点、工具、菜单、i18n、配置、错误码 | 能力地图、用户可见行为 | 中 |
| L0 | 数据模型与迁移：表、枚举、约束 | 领域实体、状态、不变量 | 中 |
| L- | 提交记录、工单、IM、监控 | 动机线索、时间线 | 低（只作线索） |

规则（建议写进校验器，而不是只写在提示词里）：

1. **每条候选至少一个可定位证据**（`文件:行`、测试名、端点名、表名、提交 sha）；无证据不入草案。
2. **单一来源只能产出 `draft`**，包括“代码与测试一致”也不行。
3. 两类独立来源一致时标 `confidence: high`，但仍是 `draft`。
4. 代码与文档冲突时以文档为意图、代码为现状，并列入 `conflicts`。
5. **目标类条目不允许从代码推断**：`kind: goal` 只能来自文档或所有者回答。
6. 能力类条目可以由代码表面自动生成（`kind: capability`），但必须标 `draft`。

## 3. 多源提取器

每个来源实现为独立 `extractor`，输出统一候选格式（§4），由流水线统一聚类、校验与落盘。
这样“重建”不绑定 Git，也不要求每个项目都有同一种记录。

| 提取器 | 输入 | 产出 | 默认开启 | 是否用模型 |
| --- | --- | --- | --- | --- |
| `git` | `git log` 元数据与变更路径 | 时间线、决策线索、能力变更 | 是 | 摘要用 |
| `docs` | 产品文档、ADR、状态批次段、README | 目标、决策、边界 | 是 | 是 |
| `tests` | 测试文件、`describe`/`it` 标题、断言 | 验收标准、业务规则 | 是 | 否 |
| `code-surface` | 端点、工具、菜单、i18n、配置、错误码 | 能力地图、用户可见行为 | 是 | 否 |
| `schema` | 建表语句、枚举、约束、迁移 | 领域模型、状态机 | 是 | 否 |
| `contracts` | OpenAPI / JSON Schema / 架构契约 | 对外承诺与边界 | 有则开启 | 否 |
| `issues` | GitHub/GitLab Issue、PR 描述（需凭据） | 动机、被否决方案 | 手动 | 是 |
| `interview` | 所有者问卷与确认记录 | `confirmed` 结论 | 手动 | 否 |

### 3.1 各提取器要点

- `git`：只读 `git log`，不 checkout、不改工作区；默认排除合并提交与 `docs/verification/**` 一类
  过程记录作为“条目来源”，但仍作为时间线证据。提交信息平均很短，**不能单独成条**。
- `docs`：按标题切段，用段标题 + 首段做候选摘要；引用行号作为证据。ADR 与状态批次段优先，
  因为它们记录“为什么”和“被否决的方案”。
- `tests`：`describe` 分组聚成能力，`it` 标题作为验收标准候选；断言里的业务不变量作为
  `decision` 候选证据。临时兼容行为不允许直接升为 `confirmed`。
- `code-surface`：端点/工具/菜单/i18n/配置项直接生成 `capability` 候选；错误码与拒绝分支
  生成边界候选。
- `schema`：表名与枚举生成领域实体；唯一约束、外键、状态枚举生成不变量与状态机候选。
- `issues`：默认关闭；启用需要显式凭据与“只本地聚合、不上传”的约定，并过滤个人信息。
- `interview`：唯一把 `draft` 变 `confirmed` 的通道，问题用“行为差异”式提问。

### 3.2 本仓库实测素材（说明多源可行）

| 来源 | 规模 | 能补什么 |
| --- | --- | --- |
| 提交 | 975 条（2026-10-12 → 2026-11-16），62 个合并 | 时间线与证据索引 |
| 测试 | 220 个文件、2399 项 | 验收标准、业务规则、异常边界 |
| 表结构 | 56 张表 | 领域实体、状态机、不变量 |
| 端点 / 工具 | 35 / 16 | 能力地图 |
| i18n | 1630 条 | 用户可见行为与状态 |
| 文档 | 21 个 Markdown、5 个 ADR | 目标、决策、边界 |
| 状态记录 | 209 个批次段 | 决策时间线与已废弃方案 |

## 4. 统一候选格式

```ts
type CandidateKind = 'goal' | 'decision' | 'capability' | 'acceptance'
type SourceKind = 'commit' | 'doc' | 'test' | 'code' | 'schema' | 'contract' | 'issue'

interface LibraryCandidate {
  /** 与库条目一致的稳定身份：^[a-z0-9][a-z0-9._-]{0,63}$ */
  readonly id: string
  readonly kind: CandidateKind
  readonly title: string
  /** 受控词表，与澄清缺口的 topic 对齐 */
  readonly topics: readonly string[]
  /** ≤240 字符；一条只回答一个主题 */
  readonly summary: string
  /** ≤4 KiB；引用条目可留空，正文留在被引用文档 */
  readonly body: string
  readonly sources: ReadonlyArray<{ kind: SourceKind; ref: string; note?: string }>
  readonly confidence: 'low' | 'medium' | 'high'
  /** 同主题已有确认条目时的取代提案 */
  readonly supersedes?: string
  /** 与其他候选或现有条目的互斥结论 */
  readonly conflicts?: readonly string[]
}
```

示例：

```json
{
  "id": "decisions.library-gate",
  "kind": "decision",
  "title": "需求库澄清闸门",
  "topics": ["library.gate", "workflow.clarification"],
  "summary": "默认空澄清；遍历全库后才允许提问；命中 confirmed 主题禁止重复提问；≤3 条；所有者回答回写 confirmed。",
  "body": "……",
  "sources": [
    { "kind": "commit", "ref": "1429b48" },
    { "kind": "doc", "ref": "docs/verification/status.md#241" },
    { "kind": "test", "ref": "packages/forgeloop/tests/library-gate.test.ts" }
  ],
  "confidence": "high"
}
```

## 5. 流水线

```
提取 extractors
   │   git / docs / tests / code-surface / schema / contracts
   ▼
归一化与去重（确定性）
   │   id 冲突合并、同证据去重、证据路径标准化
   ▼
聚类（确定性）
   │   按 scope → 目录 → 关键词；每簇 ≤60 条证据、全库 ≤20 簇
   ▼
提炼（模型，仅 decision/goal 需要）
   │   每簇一次调用，严格 JSON，tools: none，失败不中断整次运行
   ▼
校验与冲突（确定性）
   │   复用需求库解析器；证据必须存在；同主题冲突显式列出
   ▼
草案落盘 + 报告
   │   docs/product/library-drafts/<id>.md（不进入扫描目录）
   ▼
所有者确认（页面动作）
   │   确认后才写入 docs/product/library/ 并置 confirmed
   ▼
漂移维护（P2）
       代码/测试变化 → 受影响条目 → 提示复核
```

### 5.1 阶段细节

- **归一化**：同一 `id` 的多条候选按证据合并；`topics` 去重并归一到受控词表；证据 `ref`
  统一为项目内相对路径。
- **聚类**：优先用提交 scope，其次用变更目录，再次用关键词；低于 3 条证据且无文档/契约支撑的簇
  直接丢弃，避免碎片。
- **提炼**：只有 `decision` 与 `goal` 需要模型；`capability`/`acceptance` 由确定性提取器直接产出。
  每簇最多重试一次，失败写 `errors` 并继续下一簇。
- **校验**：复用 [`parseLibraryEntry`/`validateLibrary`](../../packages/forgeloop/src/domain/library.ts)
  的 fail-closed 规则；草案目录单独校验，不阻塞正式库。
- **落盘**：先写临时目录，全部解析通过后原子替换；任何失败整体回滚。

### 5.2 失败与恢复

- 单簇失败只记错误，不中断整次运行；报告里列出失败簇。
- 宿主重启时把遗留 `running` 标记为 `failed(interrupted)`，不假装完成。
- 取消通过 `AbortSignal` 中断模型调用；已生成草案保留。

## 6. 存储与状态

### 6.1 文件布局

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 正式条目 | `<projectPath>/docs/product/library/**/*.md` | 现有格式；确认后写入 |
| 草案 | `<projectPath>/docs/product/library-drafts/<id>.md` | 不在扫描目录内，未确认不影响分析 |
| 报告 | `<recordsRoot>/projects/<project>/library-rebuild/<runId>/report.md` | 提交→条目映射、跳过原因、冲突 |
| 摘要证据 | 同上 `digest.jsonl` | 每簇输入摘要，便于复现 |

### 6.2 SQLite

沿用现有 `CREATE TABLE IF NOT EXISTS` + `ensureColumn` 迁移方式：

```sql
CREATE TABLE IF NOT EXISTS library_rebuilds (
  run_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  mode TEXT NOT NULL,              -- incremental | full
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  stage TEXT NOT NULL,             -- collect | cluster | synthesize | validate | draft
  commits_total INTEGER NOT NULL,
  clusters_total INTEGER NOT NULL,
  clusters_done INTEGER NOT NULL,
  drafts_total INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  last_commit TEXT NOT NULL,       -- 水位
  report_path TEXT NOT NULL,
  error TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
```

- 状态机：`queued → running → done | failed | cancelled`；只允许一次运行一个项目。
- 水位：最近一次 `done` 的 `last_commit`；增量模式只处理之后的提交，首次默认全量。
- 草案不写库表；正式条目由现有扫描与 `library_entries` 同步负责。

## 7. 限额与估算

| 参数 | 建议值 | 理由 |
| --- | --- | --- |
| `MAX_COMMITS` | 2000 | 覆盖大多数历史项目，避免无界读取 |
| `MAX_CLUSTERS` | 20 | 控制模型调用次数 |
| `MAX_COMMITS_PER_CLUSTER` | 60 | 单次提示词可控 |
| `MAX_ENTRIES_PER_RUN` | 24 | 避免一次生成过多草案 |
| `MAX_CALLS` | 24 | 与簇数相当，失败重试计入 |
| 单条正文 | ≤4 KiB | 与库读取上限一致 |
| 单条摘要 | ≤240 字符 | 与库格式一致 |
| 全库条目 | ≤64 | 与 `LIBRARY_MAX_ENTRIES` 一致 |
| 单次调用超时 | `agent.timeoutSeconds` | 复用现有配置 |

预览阶段给出：提交数、新增提交数、簇数、预计模型调用次数与预估 token，不调用模型。

## 8. 端点

沿用 `/api/forgeloop/board` 的认证路由与 owner 动作模式（`by=config.owner`，
`source=web-decision:<session>:library-rebuild`）。

| 端点 | 类型 | 请求 | 响应 |
| --- | --- | --- | --- |
| `library-rebuild-preview` | 只读 | `{ mode }` | 提交数、新增数、簇列表、预计调用次数 |
| `library-rebuild-start` | owner 写 | `{ mode }` | `{ runId }` |
| `library-rebuild-status` | 只读 | `{ runId? }` | 状态、阶段、进度、草案数、错误 |
| `library-rebuild-cancel` | owner 写 | `{ runId }` | `{ cancelled: true }` |
| `library-drafts` | 只读 | `{}` | 草案列表（含证据与置信度） |
| `library-draft-decide` | owner 写 | `{ draftId, decision }` | `confirm` 写入库并置 `confirmed`；`discard` 删除草案 |

拒绝语义：缺 `sessionId` → `session_required`；未绑定工作区 → `workspace_unbound`；
项目不是 Git 仓库 → `400` 并说明；运行中重复启动 → `409`。

## 9. 页面

产品页（[`client.js`](../../packages/forgeloop/client.js) 的 `ProductPane`）顶部新增：

```
需求库                                        [从 Git 历史重建]
上次重建：2026-11-16 10:20 · 975 提交 / 14 主题 / 3 条草案
[采集] [聚类] [提炼 7/14] [校验]
草案（待确认）
  决策：工作区模式判定      证据 6 条   [展开] [确认入库] [忽略]
```

- 空库时同样显示按钮；按钮先触发预览，展示估算后再启动；
- 草案卡片展开后复用现有“正文展开”样式显示证据与正文；
- 确认/忽略是 owner 动作，结果即时刷新列表；
- 中英文案：`product.rebuild.*`、`product.drafts.*` 约 15 个 key。

## 10. 提示词与模型

- 复用产品 Agent 角色（`AGENT_PRODUCT`），`tools: 'none'`，只给有界摘要；
- 新增 `LIBRARY_REBUILD_PROMPT_VERSION = 'library-rebuild-v1'`，与 `ANALYSIS_PROMPT_VERSION` 并列；
- 提示词要求：只写可核实陈述；每条必须引用输入提供的证据；不写测试数字/版本号/耗时；
  不把“已实现”写成“已确认”；输出严格 JSON；每簇 0–3 条；
- 模型输出先做 JSON 结构校验，再进入候选校验；失败重试一次，仍失败记错误并继续。

## 11. 安全与隔离

- 只读当前项目：不跨 `projectPath`，不读其他租户记录。
- Git 只读：不 checkout、不 stash、不执行项目脚本。
- 不联网：`issues` 提取器默认关闭，启用需显式凭据与所有者同意。
- 敏感信息：对生成内容做密钥/凭据/内网地址正则扫描，命中即拒绝该条并记错误。
- 审计：每次运行保留输入摘要、模型、提示词版本、证据与报告路径。
- 失败关闭：草案目录解析失败只影响本次运行；正式库解析失败仍按现有 fail-closed 阻断分析。

## 12. 冲突与取代

- 同 `id` 或同 `topics` 已有 `confirmed` 条目：不覆盖，生成 `supersedes` 提案；确认后旧条目改
  `status: superseded`，保留原文与来源。
- 两条候选结论互斥：写入 `conflicts`，不自动选择；页面并把冲突显示给所有者。
- 当前库解析器拒绝未知字段，因此 `supersedes`/`conflicts` 先写在草案正文与报告里；
  是否扩展头部字段属于后续独立改动（需要解析、测试与文档同步）。

## 13. 漂移维护（P2）

- 记录每条条目依赖的证据（测试文件、端点、表、文档小节）。
- 当代码或测试变化命中依赖时，生成“可能过期”提示，并把该条目标为待复核（不自动改内容）。
- 每次重建只提案受影响的条目，不重跑全量。

## 14. 分阶段实施

| 阶段 | 内容 | 交付 | 主要文件 |
| --- | --- | --- | --- |
| **P0** | 确定性提取（tests/code-surface/schema）+ 聚类 + 预览端点 + 页面按钮 + 报告 | 任意项目可看到“可重建的簇与证据”，不调模型、不写库 | `src/domain/library-rebuild.ts`、`src/runtime/library-extract.ts`、`board-route.ts`、`client.js`、测试 |
| **P1** | 后台运行 + 模型提炼 + 草案列表 + 确认/忽略 + `library_rebuilds` 表 | 草案可审阅、确认后入库 | `src/runtime/library-rebuild.ts`、`src/records/library-rebuild-store.ts`、`db.ts`、`prompts.ts`、客户端、测试 |
| **P2** | 增量水位、漂移维护、`issues` 提取器、能力索引 | 增量提案与过期提示 | 同上 + 脚本与文档 |

每阶段都要求：行为测试（正反例）、`make check`、架构说明与状态记录同步。

## 15. 待决问题

1. 模型提炼默认是否开启？建议开启但每次运行上限 24 次调用，并在预览中给出估算。
2. 草案目录：建议 `docs/product/library-drafts/`（与扫描目录分离）；另一种是直接写库目录用 `draft`。
3. 确认方式：建议页面「确认入库」owner 动作；聊天回答用于修改内容。
4. 首次范围：建议首次全量、之后按水位增量，并允许手动“全量重建”。

## 16. 风险

- **提交信息太薄**：只靠 Git 会产出空壳；必须依赖 tests/docs/schema 等确定性来源。
- **文档缺失**：历史项目常没有产品文档，此时只能产出 `capability`/`acceptance` 草案，`goal` 必须访谈补齐。
- **模型幻觉**：严格证据校验 + 单一来源只给 draft + owner 确认三重约束；仍不能证明语义正确。
- **成本**：簇数 × 调用次数；预览与上限先兜底。
- **草案污染**：与扫描目录分离可避免；若选择写库目录，必须只给 `draft` 且页面明确标注。
- **取代关系缺字段**：当前头部不支持 `supersedes`，P0/P1 用正文与报告承载，结构化属于后续改动。
