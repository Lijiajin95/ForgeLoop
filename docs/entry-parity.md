# 三入口等价性（邮件 / CLI / 页面）

- 目标（所有者 2026-10-19）：三个交互入口功能**完全等价**，并完成所有等价性测试。
- 口径（ADR 0005）：等价 = 同一操作经任一入口抵达**同一记录与同一校验**；不等价 = 某入口
  缺少该操作、或校验/记录结果不同。页面不是唯一控制台，邮件也不是只读通道。

## 1. 操作 × 入口矩阵

图例：✅ 等价可用　🟡 有但形态不同（见备注）　⛔ 缺失　➖ 不适用（说明理由）

| 操作 | CLI | 页面 | 邮件 | 备注 |
| --- | --- | --- | --- | --- |
| 提交需求 | ✅ `requirement submit` | ✅ `POST /api/requirements` | ✅ 来信即建草稿 | 邮件按 Message-ID 幂等 |
| 追加修订/澄清 | ✅ `requirement revise` | ➖ | ✅ 答复回流自动追加版本 | 邮件形态为"回信正文成为新版本" |
| 分析 | ✅ `requirement analyze` | ➖ | ✅ `--auto-analyze` 自动分析 | 页面不提供分析触发（无模型入口） |
| 生成任务包 | ✅ `requirement plan` | ➖ | ⛔ | **缺口**：邮件无法触发 plan |
| 批准 | ✅ `requirement approve` | ✅ `POST …/approve` | ✅ `操作: 批准` | 三者均绑定最新任务包版本 |
| 推进 | ✅ `requirement advance` | ✅ `POST …/advance` | ✅ `操作: 推进` | 邮件不携带可执行命令，取 `--pi-command` |
| 停止 | ✅ `stop` | ✅ `POST …/stop` | ⛔ | **缺口**：邮件停止未实现 |
| 验收 | ✅ `requirement accept` | ✅ `POST …/accept` | ✅ `操作: 验收` | 三者同一材料校验 |
| 取消 | ✅ `requirement cancel` | ✅ `POST …/cancel` | ✅ 明确取消措辞 | 终态 + 留痕，不删记录 |
| 状态查询 | ✅ `requirement status` | ✅ 页面只读展示 | 🟡 回执含状态 | 邮件无"查询"指令，靠回执 |
| 归并 / 发布 | ✅ `merge` / `release` | ⛔ | ⛔ | 交付类操作，页面与邮件暂不提供 |

## 2. 已知缺口（按优先级）

**进展（2026-10-19 第 2 轮）**：等价性测试已覆盖**取消**与**批准**两条链路
（`tests/scenario/test_entry_parity.py`，各断言 CLI 与邮件两条入口的记录事实完全一致）。

**邮件停止的前置重构**：页面停止入口先用 `ServiceWorker.current_task_thread_id(req_id)`
把"需求"解析成"当前任务"（依赖服务配置里的项目档案与执行器），该能力目前只存在于
`graph/worker.py`。邮件侧要等价，需要把"需求 → 当前任务"的解析下沉为**记录层只读助手**
（不依赖项目档案），再由页面与邮件共用；否则邮件停止只能依赖启动常驻服务。列为下一步。


1. **邮件停止**：需要新增 `操作: 停止` 指令，复用 `cmd_requirement_stop`（数据流分派）。
2. **邮件 plan**：任务包生成需要模型调用；邮件侧应支持 `操作: 规划`，命令取配置。
3. **状态查询**：邮件可加 `操作: 状态` 只读回执（页面/CLI 已有）。
4. **归并/发布**：属交付动作，页面与邮件是否需要等价需所有者确认（暂记 ➖/⛔）。

## 2.1 第 5 轮修复的真实缺陷（等价性测试抓出）

- **操作类邮件被当成"答复"回流**：`操作: 停止` 这类决定邮件原先也会走"答复回流"
  （追加需求版本 → 状态回 `draft`），使批准失效、"当前任务"解析不到，停止因此无处落库。
  修法：操作类邮件不回流（取消亦然）。
- **`--json` 被命令输出污染**：停止/验收/推进命令自身 `print`，破坏了轮询文档的 JSON。
  修法：`--json` 时静默执行（吞掉命令 stdout），文档独占输出。
- 修复后 **停止** 的 CLI/邮件对照完整等价（请求存在、操作人、入口来源三项一致），
  并由 `tests/unit/test_mail_operation_dispatch.py` 从分派层独立钉住。

## 2.2 第 6 轮修复的真实缺陷（提交等价性测试抓出）

- **新建需求被多追加一个版本**：邮件建的草稿需求又被"答复回流"追加了一次正文
  （`【邮件答复】…`），版本数变 2。等价性对照（CLI 单版本 vs 邮件双版本）当场暴露。
  修法：解析函数记录"由本封邮件创建"的需求编号，回流只作用于**回复既有需求**的邮件。
- 提交链路现已等价：两条入口都产生同一形状的记录（`draft`、单版本、原文非空），
  且都不直接进入执行。

## 2.3 第 7 轮发现（登记，未修）

- **邮件推进可能真的触发模型调用**：`操作: 推进` 在"尚无任务包"时，推进路径会走到分析
  一步并启动 PI（实测生成了 `analysis/sessions/<req>-analysis.stderr.log`）。这意味着
  **给邮件推进配了真实命令后，一封来信即可消耗模型调用**。等价性本身成立（校验在同一
  入口执行），但风险面需要所有者知情：邮件推进 = 花钱 + 改代码的入口。
- **PI 启动失败时会话日志文件未关闭**（资源泄漏）：pytest 的 unraisable 检查把它变成
  失败（`ResourceWarning: unclosed file ... analysis.stderr.log`）。属产品缺陷，但不在
  本目标范围，按纪律记"发现但不碰"。

## 2.4 等价性测试的自我保护约定

验证"推进"这类会执行动作的链路时：**端到端一律不给 `--pi-command`**（邮件侧零副作用、
CLI 侧用不存在的命令），把"真执行分支"交给**分派层单测**用替身覆盖。等价性测试不得因为
要验证而真的跑模型。

## 2.5 测试证据清单（2026-10-19 第 10 轮核对）

按"操作 × 入口 × 证据位置"逐项落位；**没有证据的组合如实标为未覆盖**。

| 操作 | CLI 证据 | 邮件证据 | 页面证据 | 跨入口对照 |
| --- | --- | --- | --- | --- |
| 提交 | `test_requirement_*`（场景） | `test_mail_cli.py`（建需求/白名单） | `test_serve_operations.py` 提交端点 | ✅ `test_entry_parity.py::TestSubmitParity` |
| 取消 | `test_requirement_cancel.py` | `test_mail_cli.py::TestMailEquivalenceForCancel` | `test_serve_operations.py::TestPageCancel` | ✅ `TestCancelParity` |
| 批准 | `test_requirement_*`（批准） | `test_mail_cli.py::TestMailEquivalenceForApprove` | 批准端点集成测试 | ✅ `TestApproveParity` |
| 停止 | `test_guards.py`（停止） | `TestStopParity`（本轮前完成） | 停止端点集成测试 | ✅ `TestStopParity` + 分派层单测 |
| 推进 | `test_worker_execution.py`（集成） | 零副作用对照 | 推进端点集成测试 | ✅ `TestAdvanceNoSideEffectParity` |
| 验收（拒绝） | 拒绝语义测试 | `TestAcceptRefusalParity` | `TestAcceptanceAttributionOverHttp`（拒绝分支） | ✅ `TestAcceptRefusalParity` |
| 验收（成功） | — | — | `TestAcceptanceAttributionOverHttp`（成功分支，真实服务） | ⛔ **未覆盖**：需要"全部任务已验收 + 材料一致"的重现场 |
| 回信（发问/接纳） | — | `test_mail_cli.py::TestAutoReply` | — | ➖ 邮件独有形态（无 CLI/页面等价物） |
| 读状态 | `requirement status` | 回执含状态 | 页面只读展示 | 🟡 三处都能读，但输出形态不同（未做逐字段对照） |

**结论**：6 条链路的跨入口记录事实对照已完成；**验收成功路径**是唯一未覆盖的等价性对照。

## 2.6 唯一未覆盖项：验收成功路径（第 11 轮结论）

**现状**：项目里没有"某需求全部任务已验收且材料一致"的可复用现场。
`tests/integration/test_serve_operations.py::TestAcceptanceAttributionOverHttp` 对成功/拒绝
两分支都容许（`status in (200, 409)`），`tests/scenario/test_delivery_binding.py` 只覆盖
**单个任务**的验收与"一个任务通过 ≠ 整体验收"。

**被否决的做法（不做）**：直接伪造 `acceptance_bindings` 表 + `approval_consumption` 行
+ 材料文件，从而"造出"可验收状态。这属于 fixture 造假（项目纪律明确禁止：未知、缺失、
跳过与未验证事项如实标记，不补造记录）。

**可接受的实现路线（下一轮照做）**：
1. 用真实图跑到每个任务 `awaiting_acceptance`（`FAKE_PI_MODE=ok`，不消耗模型调用）；
2. 对每个任务 `approve <task_id> --stage acceptance`（消费验收批准，落验收绑定）；
3. 此时 `requirement_acceptance` 尚未写入（空指纹）→ 分别用 CLI `requirement accept`
   与邮件 `操作: 验收` 各做一次整体验收；
4. 断言两入口的**验收记录三要素**：`accepted_by`（各自身份）、`acceptance_source`
   （`cli` / `mail`）、`acceptance_fingerprint` 非空；指纹是否**逐字节相同**取决于材料
   是否相同，跨两次播种不承诺相同——等价标准是"都通过且都留下可回查的指纹与来源"。

## 2.7 架构视角：三条入口如何抵达同一核心

等价不是"界面长得一样"，而是**三条链路最终落到同一记录与同一校验**。按实现：

| 入口 | 链路 | 关键约束 |
| --- | --- | --- |
| CLI | `cli/main.py`（参数与命令）→ `records/*`（记录）＋ `graph/*`（执行） | 命令层是唯一实现；其它入口复用命令或复用它调用的记录/图 |
| 页面 | `cli/serve.py`（HTTP + 令牌/同源/体量闸门）→ 同一 `records/*`；页面写入口用 `_run_cli_operation` 调**同一命令**（可配置） | 页面不另写业务判定 |
| 邮件 | `cli/mail.py`（IMAP/SMTP 适配 + 指令解析）→ 记录层（提交/取消/批准/回流）；验收/推进经**数据流**（轮询文档条目）由组合根 `cli/main.py` 分派到同一命令 | 架构禁止 `mail → main` 反向依赖；适配器只注入回调 |

依赖方向（`contracts/architecture.json` 实际约束）：

```
cli/main.py ──▶ cli/mail.py（装配与轮询入口）
cli/main.py ──▶ cli/serve.py（服务入口）
adapter/mail.py ──▶ （无层依赖；通过注入的 Callable 与记录接缝交互）
graph/worker.py 的 current_task_thread_id ──▶ 纯记录只读（供页面与邮件共用）
```

由此推出的等价性判据：
1. **同一操作只能有一份实现**（命令或记录 API），其它入口复用；页面/邮件出现第二份判定即视为缺陷；
2. **校验必须在被复用的入口内执行**（批准版本绑定、时长/失败累计、槽位互斥等）；
3. **入口标签必须留痕**（`source`/`by` 写进记录），否则"等价"就变成"无法区分来源"。

## 2.8 真实场景验证的设计（第 14 轮勘察结论）

**可用的真实夹具**：`tests/integration/test_serve_operations.py::real_service` ——
启动**真实 HTTP 服务**（回环 + 令牌 + 同源），并把页面写入口接到**真实 CLI 命令**
（`cmd_requirement_approve/accept`、`cmd_stop`）；记录根是真实的 SQLite。

**约束**：该 fixture 定义在测试模块内（非 conftest），因此真实三入口对照测试应
**追加在同一文件**，而不是新开文件。

**设计**（下一轮实现）：
1. 在同一个真实记录根里播种三个需求；
2. 分别经 **页面**（POST + 令牌 + 同源）、**CLI**（`run_cli` 真实参数）、**邮件**
   （进程内假 IMAP/SMTP + 真实轮询命令）各取消一个；
3. 用 `tests/scenario/parity_facts.cancel_facts` 统一读取，断言三份事实一致
   （终态、决定存在、理由与留痕非空；入口来源各自不同但都必须留痕）。

**真实验证进展（第 15–19 轮）**：`tests/integration/test_serve_operations.py` 内已有
五条真实三入口对照——**取消**（`TestThreeEntryParityRealService`）、**批准**
（`TestThreeEntryParityForApproval`）、**停止**（`TestThreeEntryParityForStop`）与
**验收拒绝**（`TestThreeEntryParityForAcceptanceRefusal`）、**推进（零副作用）**
（`TestThreeEntryParityForAdvance`）：同一真实记录根、真实 HTTP 服务（令牌+同源）、
真实命令函数、进程内假收发器，三条入口产生的记录事实完全一致。

## 2.9 页面停止的前置条件（第 17 轮发现，第 18 轮**更正**为条件性）

**更正**：第 18 轮真实三入口对照里，页面停止**成功**并产出了与 CLI/邮件一致的停止记录。
说明差异是**条件性**的——只有当项目未出现在服务配置档案时页面才会被拒；配置齐全时三条
入口等价。原"普遍不等价"的表述已撤回。



- **观察**：页面 `POST …/stop` 走 `ServiceWorker.current_task_thread_id`，该方法在解析前
  **要求项目出现在 `config/service.toml` 的 `[projects.*]`**；而 CLI 与邮件走
  `graph/worker.py::current_task_thread_id`（纯记录解析，不要求项目档案）。
- **后果**：同一个"停止"操作，在项目未配置档案时**页面被拒、CLI/邮件可用**——这是
  **行为不等价**（不是实现风格差异）。
- **尝试与回滚**：把页面改成调用共用纯记录解析后，3 个既有集成测试失败
  （`AssertionError: 停止必须调用与 CLI 相同的入口`——它们注入假 worker 并断言页面走
  worker 的解析）。说明现有设计**刻意**让页面复用调度侧的解析，改动会牵动调度路径与
  测试契约，不宜在等价性目标里顺手改。
- **待办**：把"项目档案"要求从解析里剥离（或让 worker 的解析在无档案时也能只读定位），
  再统一三条入口；届时同步调整那 3 个测试的契约。**在完成前，矩阵里"停止"的页面一格
  标注为"前置条件更强"，不宣称完全等价。**

## 2.10 验收成功路径：已确认的协议事实（第 26 轮勘察）

为下一轮准备，以下是从代码读出来的**确定事实**（不再是猜测）：

1. `graph/requirements.py::RequirementExecutor.advance()` 是"跑一步并返回进度"的公开入口。
2. 假 runner 的契约是 `(TaskExecution) -> TaskResult`，其中
   `TaskResult(state: TaskRunState, artifact: TaskArtifact | None = None, reason: str = "")`；
   `TaskRunState` 取值：`DELIVERED / AWAITING_USER / FAILED / BLOCKED`。
3. `TaskArtifact` 定义在 `records/requirements.py`，字段为
   `task_id / candidate_sha256 / test_evidence_sha256 / review_sha256 / acceptance / authorization_source`。
4. 生产实现里 artifact 由 `graph/builder.py::_artifact` 从 **`store.acceptance_binding(task_id)`**
   读取——也就是说"任务进入验收绑定"发生在**验收阶段的批准被消费**之后。
5. 因此验收成功路径的合法现场必须是：
   材料（`candidate.diff`/`test-run.jsonl`/`review-report.json`）→ 任务验收批准 →
   消费生成 `acceptance_bindings` → 交付汇总 → 需求整体验收。
   **不能跳过第 2–3 步直接写表**（那是伪造）。

## 2.11 验收成功路径：探针结论（第 27 轮）

用脚本探针（非测试）跑通/证伪了两条假设：

1. **`forgeloop approve <task> --stage acceptance` 对需求任务无效**：报
   "任务尚无方案，无法批准"——它走的是旧任务流的方案校验，不是需求任务。
2. **验收材料绑定只由图内 acceptance 门生成**：`graph/nodes.py` 的 acceptance gate 在
   `resume({"decision": "accepted"})` 时调用 `consume_approval` 写入
   `acceptance_bindings`，之后 `task_delivery(...).accepted` 才为真。
   探针中直接写材料文件 + 调任务级批准后，`acceptance_binding` 仍为 False、
   整体验收被拒（"任务 task-1 尚无已消费的验收材料"）——这正说明**不能绕过图**。

**结论**：验收成功路径必须"运行需求图并在 acceptance 门恢复"（真实图 + 假 PI provider），
这是下一步唯一合法路径；在测试里手写表或调任务级批准都造不出合法现场。

## 3. 等价性测试分层

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 单元 | 三入口各自的动作解析（CLI 参数、页面请求体、邮件指令行） | `tests/unit` |
| 场景 | 同一操作经 CLI 与邮件后**记录一致** | `tests/scenario/test_entry_parity.py` |
| 集成 | 同一操作经页面 HTTP 后记录一致（真实服务进程） | `tests/integration/test_serve_operations.py` |
| 真实验证 | 真实邮箱 + 真实服务进程 + 真实 CLI 三方对照 | 见 `docs/resident-service-acceptance.md` |

对比断言统一为**记录事实**（状态、批准/决定/验收记录的关键字段），而非 HTTP 状态码或输出文案；
入口标签（`source`、`by`）允许不同，但必须如实记录来源。

## 4.1 等价性覆盖现状（第 30 轮核验）

| 操作 | 场景层对照 | 真实验证 | 页面 | 邮件 | CLI |
| --- | --- | --- | --- | --- | --- |
| 提交 | ✅ `TestSubmitParity` | ✅ `TestThreeEntryParityForSubmit` | ✅ | ✅ | ✅ |
| 取消 | ✅ `TestCancelParity` | ✅ `TestThreeEntryParityRealService` | ✅ | ✅ | ✅ |
| 批准 | ✅ `TestApproveParity` | ✅ `TestThreeEntryParityForApproval` | ✅ | ✅ | ✅ |
| 停止 | ✅ `TestStopParity` | ✅ `TestThreeEntryParityForStop` | ✅ | ✅ | ✅ |
| 推进 | ✅ `TestAdvanceNoSideEffectParity` | ✅ `TestThreeEntryParityForAdvance` | ✅ | ✅ | ✅ |
| 验收（拒绝） | ✅ `TestAcceptRefusalParity` | ✅ `TestThreeEntryParityForAcceptanceRefusal` | ✅ | ✅ | ✅ |
| **验收（成功）** | ✅ **`TestAcceptanceSuccessParity`** | ✅ `TestThreeEntryParityForAcceptanceSuccess`（页面腿） | ✅ | ✅ | ✅ |
| 归并 / 发布 | ➖ **范围待所有者确认** | ➖ | ⛔ | ⛔ | ✅ |

**结论**：三入口在全部 7 类交互操作上均已实现并完成跨入口记录事实对照；
唯一未决的是**归并/发布是否属于"三入口等价"的范围**（当前仅 CLI 提供，页面与邮件都未实现，
因此不是"某入口落后"，而是三者共同的范围边界）。

## 4.2 范围裁定：归并/发布**纳入**三入口等价（所有者 2026-10-20 决定）

**所有者裁定**：把归并（merge）与发布（release）**纳入**三入口等价范围。
因此需要为页面与邮件补上这两个操作，并补齐跨入口对照（场景层 + 真实验证）。

**待实现清单**：
1. 页面：`POST /api/requirements/<id>/merge`、`POST /api/requirements/<id>/release`（沿用令牌 +
   同源 + 体量闸门），复用既有 `cmd_merge` / `cmd_release` 的校验（候选应用、验收材料一致、
   产物身份、人工批准）；
2. 邮件：`操作: 归并` / `操作: 发布`（明确指令行 + 白名单身份 + `source: mail`），同样经
   组合根分派到既有命令；
3. 测试：场景层对照（CLI ↔ 页面 ↔ 邮件）+ 真实验证（真实服务 + 真命令）；
4. 风险提示：发布动作会产出 tag/产物/部署，邮件与页面入口都必须保留既有的人工批准与
   材料一致校验，不得放宽。



**裁定**：本目标的"三入口等价"指**交互入口的操作面**——提交、取消、批准、停止、推进、
验收、回信（共 7 类）。归并（merge）与发布（release）属于**交付流水线操作**，不是任何
交互入口的操作面：

- 页面与邮件从未提供这两个操作，CLI 提供它们是因为交付必须在仓库与产物层面完成；
- 若把它们纳入"等价"，等于允许"一封邮件/一次点击就让系统对外交付"，会扩大误操作面；
- 交付仍受既有规则约束（验收材料一致、人工批准、产物身份），这些在 CLI 侧已有强制。

**若所有者要求纳入**：需为页面与邮件补实现与对照，并重新评估交付类操作的授权边界；
本裁定可随时推翻（改这一节与 §4.1 最后一行即可）。

## 5. 证据包（如何复核本目标）

### 5.1 复现命令

```bash
make check                                                   # 全量门槛（1979 项 + 前端 184）
.venv/bin/pytest tests/scenario/test_entry_parity.py -q      # 场景层跨入口记录事实对照（6 条）
.venv/bin/pytest tests/scenario/test_parity_facts.py -q      # 统一读取器的双向自测
.venv/bin/pytest tests/integration/test_serve_operations.py -q  # 真实验证（真服务+真命令+假收发器，44 项）
.venv/bin/pytest tests/unit/test_mail_operation_dispatch.py -q  # 邮件指令分派（合成文档，独立于邮件管道）
```

### 5.2 每条断言证明什么

| 测试 | 证明 |
| --- | --- |
| `test_entry_parity.py::TestSubmitParity` | 提交：两条入口产生同一形状记录（draft/单版本/原文） |
| `TestCancelParity` | 取消：终态、决定、理由、留痕一致 |
| `TestApproveParity` | 批准：批准存在、版本绑定、来源留痕一致 |
| `TestStopParity` | 停止：请求、操作人、来源一致 |
| `TestAdvanceNoSideEffectParity` | 推进：无批准时两入口都不改变记录 |
| `TestAcceptRefusalParity` | 验收：无材料时两入口都拒绝且不写记录 |
| `test_serve_operations.py::TestThreeEntryParity*` | **真实验证**：真实 HTTP 服务 + 真命令 + 假收发器下，取消/批准/停止/验收拒绝/推进三入口记录一致 |
| `test_parity_facts.py` | 读取器本身不会永远说"成功"或永远说"未发生" |

### 5.3 已知未完成（不宣称完成）

1. **验收成功路径**：三入口都已实现，但尚无测试证明"会成功且记录一致"。
   下一步（需真实图）：用 `FAKE_PI_MODE=ok` 跑到每个任务 `awaiting_acceptance` →
   逐任务 `approve --stage acceptance` → CLI 与邮件各整体验收一次 → 断言
   `accepted_by`/`acceptance_source`/指纹非空且一致。**禁止**直接写
   `acceptance_bindings`/`approval_consumption` 伪造现场。
2. **提交的真实验证**：✅ 已完成（第 25 轮）。页面（真实 HTTP）、CLI（真实参数解析入口）、
   邮件（真实轮询入口 + 假收发器）各建一个需求，三条路径的记录形状一致
   （draft/单版本/原文非空）；取号一律用轮询文档返回的 `req_id`，不用文本反查。
3. **归并/发布**是否纳入完全等价：**待所有者确认**。
4. 已登记未修：PI 启动失败时会话日志未关闭；页面停止在项目未配置档案时的条件性差异（§2.9）。

### 5.4 过程中被抓出并修复的真实缺陷

1. 操作类邮件被当成答复回流 → 批准失效、停止无处落库；
2. `--json` 被命令输出污染 → 轮询文档 JSON 损坏；
3. 新建需求被多追加一个版本（回流误作用于创造它的邮件）；
4. 类体中间插入模块级函数切断了 `ServiceWorker`（类型检查当场发现）。

