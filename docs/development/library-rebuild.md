# 需求库一键重建设计：多源提取、无持续人工输入（设计稿 v2）

状态：**设计稿，未实施**（2026-11-16，v2）。本文替换 v1 的“草案逐条确认”流程，只定义方案，
不代表代码已具备；实施按 [AGENTS](../../AGENTS.md) 的 worktree、行为测试与 `make check` 流程执行。
相关入口：[产品与首版方案](../product/product.md)、[当前架构](architecture.md)、
[状态记录](../verification/status.md)、[领域术语](../../CONTEXT.md)、
[需求库条目格式](../../packages/forgeloop/src/domain/library.ts)。

## 0. 本版变更（相对 v1）

| 项 | v1 | v2 |
| --- | --- | --- |
| 触发 | 预览 → 启动 → 逐条确认 | **一键**：点一次即开始并直接生效 |
| 人工输入 | owner 问卷、逐条确认 | **不要求**持续输入业务场景或逐条确认 |
| 条目状态 | 只产出 `draft`，确认后 `confirmed` | 新增 `rebuilt`：机器重建、所有者一次授权生效 |
| 提取器 | 含 `interview` | 去掉 `interview`；`issues` 仅按配置自动读取 |
| 端点 | preview/start/status/cancel/drafts/decide | run/status/cancel（+ 只读草案） |

## 1. 目标与非目标

### 目标

- **一键重建**：所有者只做一次点击（浏览器认证动作），之后不再需要指定业务场景或逐条确认。
- 任何租户项目都能从自身仓库与记录重建，不依赖作者记忆，不写死 ForgeLoop 仓库。
- 产出可直接参与分析上下文的条目：机器重建、所有者一次授权、证据可审计。
- 幂等、可中断、可重跑；重跑自动替换上一次重建结果，不叠加垃圾。

### 非目标

- 不逐条征求确认，也不要求在聊天里补充场景；一键之后没有“下一步输入”。
- 不覆盖或删除 `confirmed`（所有者逐条回答产生的条目）。
- 不跨项目读取；不执行项目命令；Git 只读。
- 不保证语义绝对正确：重建是“有证据的推断”，所有者可随时用回答取代。
- 不把验证数字、测试数、覆盖率、版本号、安装记录写进库。

## 2. 授权模型（一键的关键）

- **点击本身就是授权**：`library-rebuild-run` 是 owner 动作，记录 `by=config.owner`、
  `source=web-decision:<session>:library-rebuild`，与批准/验收同一套认证入口。
- 重建产出的条目状态为 **`rebuilt`**，`source` 固定为
  `owner-authorized-rebuild:<runId>#<candidateId>`，可回溯到本次运行与证据。
- `confirmed` 仍只来自所有者逐条回答；两者区别：

| 状态 | 含义 | 分析闸门是否阻止重复提问 | 页面标识 |
| --- | --- | --- | --- |
| `confirmed` | 所有者逐条确认 | 是 | 已确认 |
| `rebuilt` | 机器重建、所有者一次授权 | 是 | 重建 |
| `draft` | 低置信候选，未生效 | 否 | 草稿 |
| `superseded` | 被新结论取代 | 否 | 已被取代 |

- 所有者回答命中 `rebuilt` 覆盖的主题时，允许写入 `confirmed`，并把对应 `rebuilt` 条目置
  `superseded`——一键结果可被纠正，但不阻塞。

## 3. 事实等级与证据规则

| 等级 | 来源 | 能产出 | 可信度 |
| --- | --- | --- | --- |
| L4 | 所有者逐条回答 | 目标、取舍、非目标 | `confirmed` |
| L3 | 产品文档、ADR、变更日志、状态批次记录 | 目标、决策、边界 | 高 |
| L2 | 测试与对外契约（可执行规格） | 验收标准、业务规则、状态机 | 中高 |
| L1 | 代码表面：端点、工具、菜单、i18n、配置、错误码 | 能力地图、用户可见行为 | 中 |
| L0 | 数据模型与迁移：表、枚举、约束 | 领域实体、状态、不变量 | 中 |
| L- | 提交记录、工单、监控 | 动机线索、时间线 | 低（只作线索） |

规则：

1. 每条候选至少一个可定位证据（`文件:行`、测试名、端点名、表名、提交 sha），无证据不写库。
2. **决定“写库为 `rebuilt` 还是留草案”的是证据组合，不是模型自评**（见 §5 阈值）。
3. 代码与文档冲突时：文档代表意图、代码代表现状，写入 `conflicts`，冲突条目降为草案。
4. `kind: goal` 只能来自文档或所有者回答；代码与测试不能生成目标类条目。
5. 目标类条目数量少而稳；能力类条目可多，但只描述“系统确实具备什么”。

## 4. 多源提取器（全部自动，无人工输入）

| 提取器 | 输入 | 产出 | 一键流程 | 用模型 |
| --- | --- | --- | --- | --- |
| `tests` | 测试文件、`describe`/`it` 标题、断言 | 验收标准、业务规则 | 是 | 否 |
| `code-surface` | 端点、工具、菜单、i18n、配置、错误码 | 能力地图、可见行为 | 是 | 否 |
| `schema` | 建表语句、枚举、约束 | 领域模型、状态机 | 是 | 否 |
| `contracts` | OpenAPI / JSON Schema / 架构契约 | 对外承诺与边界 | 有则启用 | 否 |
| `docs` | 产品文档、ADR、状态批次段、README | 目标、决策、边界 | 是 | 是 |
| `git` | `git log` 元数据与变更路径 | 时间线、决策线索 | 是 | 是（仅辅助） |
| `issues` | Issue/PR 描述（需凭据） | 动机、被否决方案 | 配置后自动 | 是 |

- 不设 `interview` 提取器：一键流程不接受“指定业务场景”的输入。
- `issues` 不产生交互：凭据在配置里，读取失败只记错误，不阻塞其余提取器。
- 所有提取器输出统一候选（§5），由流水线决定状态。

## 5. 候选格式与状态判定

```ts
type CandidateKind = 'goal' | 'decision' | 'capability' | 'acceptance'
type SourceKind = 'commit' | 'doc' | 'test' | 'code' | 'schema' | 'contract' | 'issue'

interface LibraryCandidate {
  readonly id: string                 // ^[a-z0-9][a-z0-9._-]{0,63}$
  readonly kind: CandidateKind
  readonly title: string
  readonly topics: readonly string[]  // 受控词表
  readonly summary: string            // ≤240 字符
  readonly body: string               // ≤4 KiB
  readonly sources: ReadonlyArray<{ kind: SourceKind; ref: string; note?: string }>
  readonly confidence: 'low' | 'medium' | 'high'   // 由证据组合计算，不由模型决定
  readonly supersedes?: string
  readonly conflicts?: readonly string[]
}
```

**写库阈值（确定性）**：

| 条件 | 结果 |
| --- | --- |
| `kind` 为 `capability`/`acceptance`，且证据 ≥1 个代码/测试/契约来源 | 写为 `rebuilt` |
| `kind` 为 `decision`，证据含 ≥1 个文档/ADR 来源，或 ≥2 类独立来源 | 写为 `rebuilt` |
| `kind` 为 `goal`，证据含产品文档或 ADR | 写为 `rebuilt` |
| 只有提交消息、只有单一低等级来源、或存在未解冲突 | 写草案目录，状态 `draft` |
| 与现有 `confirmed` 主题冲突 | 不写库；进 `conflicts` 与草案 |

## 6. 一键流水线

```
点击“一键重建”
   │  owner 动作 → 创建 run（唯一并发）
   ▼
采集（并行）   tests / code-surface / schema / contracts / docs / git / issues
   ▼
归一化与聚类   按 scope → 目录 → 关键词；≤20 簇，每簇 ≤60 条证据
   ▼
提炼（模型，仅 decision/goal 需要的簇；每簇 0–3 条）
   ▼
校验与冲突     复用例库解析器；证据必须存在；冲突降级
   ▼
写库            高置信 → docs/product/library/*.md（status=rebuilt）
                低置信 → docs/product/library-drafts/*.md（status=draft）
                上一次重建产生的 rebuilt 条目整体替换
   ▼
报告与索引      报告写入 records；刷新页面列表
```

- **没有预览门槛、没有逐条确认**；点击后立即运行并生效。
- 模型失败或额度不足时，确定性提取器仍会写出一批 `rebuilt` 能力/验收条目，一键不会“空手而归”。
- 取消：中断模型调用，已写入的条目保留，报告标记 `cancelled`。
- 重跑：删除 `source` 以 `owner-authorized-rebuild:` 开头的旧条目后重写，`confirmed` 不动。

## 7. 存储

| 内容 | 位置 |
| --- | --- |
| 重建条目 | `<projectPath>/docs/product/library/**/*.md`（`status: rebuilt`） |
| 低置信草案 | `<projectPath>/docs/product/library-drafts/<id>.md`（不进分析上下文） |
| 报告与摘要 | `<recordsRoot>/projects/<project>/library-rebuild/<runId>/report.md`、`digest.jsonl` |

SQLite（沿用 `CREATE TABLE IF NOT EXISTS` + `ensureColumn`）：

```sql
CREATE TABLE IF NOT EXISTS library_rebuilds (
  run_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  stage TEXT NOT NULL,             -- collect | cluster | synthesize | validate | apply
  commits_total INTEGER NOT NULL,
  clusters_total INTEGER NOT NULL,
  clusters_done INTEGER NOT NULL,
  applied_total INTEGER NOT NULL,  -- 写为 rebuilt 的条目数
  drafts_total INTEGER NOT NULL,
  conflicts_total INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  last_commit TEXT NOT NULL,
  report_path TEXT NOT NULL,
  error TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
```

- 单项目同时只允许一次运行；重启把遗留 `running` 标为 `failed(interrupted)`。
- 水位 `last_commit`：一键默认增量；首次或手动“全量”时从头处理。

## 8. 端点

| 端点 | 类型 | 请求 | 响应 |
| --- | --- | --- | --- |
| `library-rebuild-run` | owner 写 | `{ mode?: 'incremental'\|'full' }` | `{ runId }` |
| `library-rebuild-status` | 只读 | `{ runId? }` | 状态、阶段、进度、已写入/草案/冲突数 |
| `library-rebuild-cancel` | owner 写 | `{ runId }` | `{ cancelled: true }` |
| `library-drafts` | 只读 | `{}` | 低置信草案列表（可展开看证据） |

拒绝语义：缺 `sessionId` → `session_required`；未绑定工作区 → `workspace_unbound`；
项目不是 Git 仓库或缺少可提取来源 → `400` 并说明；运行中重复启动 → `409`。

## 9. 页面

```
需求库                                            [一键重建]
上次重建：2026-11-16 14:20 · 975 提交 / 14 主题 / 已写入 12 条 / 草案 3 条
[采集] [聚类] [提炼 7/14] [写入]
```

- 按钮即启动，无二次确认；运行中显示阶段与进度，可取消。
- 完成后列表直接显示 `rebuilt` 条目（徽标“重建”），无需逐条操作。
- 低置信草案折叠在“草案（待确认）”区，不阻断使用；可在日后由回答取代。
- 中英文案新增 `product.rebuild.*`、`product.status.rebuilt` 约 10 个 key。

## 10. 提示词与模型

- 复用产品 Agent 角色（`AGENT_PRODUCT`），`tools: 'none'`，只给有界证据摘要。
- 新增 `LIBRARY_REBUILD_PROMPT_VERSION = 'library-rebuild-v2'`，与 `ANALYSIS_PROMPT_VERSION` 并列。
- 提示词纪律：只写可核实陈述；每条必须引用输入证据；不向用户提问、不输出澄清项；
  不写测试数字/版本号/耗时；不把“已实现”写成“已确认”；输出严格 JSON；每簇 0–3 条。
- 失败重试一次；仍失败则该簇只保留确定性提取器的结果。

## 11. 安全与限额

- 只读当前项目；Git 只读；不执行项目命令；不跨租户。
- 密钥/凭据/内网地址正则扫描，命中拒绝该条并记错误。
- 限额：提交 ≤2000、簇 ≤20、每簇证据 ≤60、每次写入 ≤24 条、单条正文 ≤4 KiB、
  单次调用超时 `agent.timeoutSeconds`、全库 ≤64 条。
- 审计：保留 run 输入摘要、模型、提示词版本、证据、报告路径与写入清单。

## 12. 冲突与取代

- `confirmed` 优先：重建遇到同主题已确认条目不覆盖，只记冲突。
- 两条重建条目互斥：保留证据更强者，另一条降为草案并记 `conflicts`。
- 所有者回答命中 `rebuilt` 主题：写入 `confirmed`，旧 `rebuilt` 置 `superseded`。
- 重跑时旧 `rebuilt` 直接替换（不保留 superseded 噪音），历史由 Git 保留。

## 13. 漂移维护（P2）

- 记录每条重建条目依赖的证据（测试文件、端点、表、文档小节）。
- 代码或测试变化命中依赖时，页面提示“可能过期”，并建议一键重建（不自动改内容）。

## 14. 分阶段实施

| 阶段 | 内容 | 一键可用性 | 主要文件 |
| --- | --- | --- | --- |
| **P0** | 确定性提取（tests/code-surface/schema/contracts）+ 聚类 + 写 `rebuilt` + 报告 + 页面按钮 | 点一次即得到能力/验收条目（**不调模型**） | `src/domain/library-rebuild.ts`、`src/runtime/library-extract.ts`、`board-route.ts`、`client.js`、测试 |
| **P1** | docs/git 提炼 `decision`/`goal` + 草案区 + `library_rebuilds` 表 | 同一次点击写出决策条目 | `src/runtime/library-rebuild.ts`、`src/records/library-rebuild-store.ts`、`db.ts`、`prompts.ts`、客户端、测试 |
| **P2** | 增量水位、漂移提示、`issues` 提取器 | 一键增量重建 | 同上 + 脚本与文档 |

P0 的前置是状态扩展：`LIBRARY_STATUSES` 增加 `rebuilt`、分析闸门把 `rebuilt` 计入覆盖、
客户端徽标与 `library-store` 状态校验、所有者回答可取代 `rebuilt`，以及相关测试，必须与
“写 `rebuilt`”同批完成，否则会出现“页面显示重建、分析却不认”的不一致。
P1 只增加 docs/git 的决策与目标提炼和 `library_rebuilds` 审计表。

## 15. 已定参数（不再询问）

| 项 | 取值 |
| --- | --- |
| 触发与生效 | 一键运行，直接写 `rebuilt`，无逐条确认 |
| 人工输入 | 无；不要求指定业务场景 |
| 低置信候选 | 写 `docs/product/library-drafts/`，不参与分析 |
| 首次范围 | 全量；之后按水位增量；可手动全量 |
| 模型默认 | 开启，单次运行 ≤24 次调用；失败仍保留确定性结果 |

## 16. 风险

- **自动生效的语义风险**：`rebuilt` 会抑制同类澄清，若重建结论错误，可能让分析少问一次。
  缓解：证据阈值、冲突降级、页面“重建”标识、所有者回答可取代、重跑可整体替换。
- **证据薄**：只有提交信息的项目会得到很少的决策条目，但能力/验收条目仍可用；不会空跑。
- **模型幻觉**：严格证据校验 + 确定性阈值 + 可回滚；但不能证明语义绝对正确。
- **成本**：簇数 × 调用次数；上限与失败回退兜底。
- **状态扩展的连带面**：新增 `rebuilt` 要同步解析、闸门、回写、记录校验、UI 与测试，
  漏一处会出现“页面显示重建、分析却不认”的不一致，必须同批完成。
