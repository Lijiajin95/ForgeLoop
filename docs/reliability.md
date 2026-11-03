# 进阶代码可靠性门禁

本文件说明 2026-11-03 引入的进阶可靠性门禁：清单、属性测试、状态机、P0 场景、稳定性、
增量变异与统一报告。它不重复 [架构说明](architecture.md) 的分层/依赖规则，也不替代
[Makefile](../Makefile)、[覆盖率配置](../packages/forgeloop/vitest.config.ts) 与
[Stryker 配置](../packages/forgeloop/stryker.config.json) 中的门槛数值。

## 1. 入口与产物

| 入口 | 作用 | 产物 |
| --- | --- | --- |
| `make reliability-registry` | 校验 `contracts/reliability.json` 结构、文件存在、门禁/NA、状态机闭包与 Stryker break 一致 | 控制台；失败非零退出 |
| `make stability` | 登记的关键测试串行独立运行 3 次（nightly 5 次），隔离 TMPDIR，固定 seed | `reports/stability.json` |
| `make mutation-incremental` | 只变异 `git diff BASE` 影响的源码及其直接依赖；`SCOPE=controlled` 跑清单受控范围 | `reports/mutation-incremental.json` |
| `make reliability-advanced` | 清单 + 稳定性 + 属性 + 状态机 + 场景 + 回归 + 增量变异 + 报告 | `reports/reliability-advanced.json` 与控制台 Markdown |

`reports/` 已被忽略，报告不进入版本库；机器可读结论、base/head SHA、registry sha256
与每项分母/范围/时间戳都在 JSON 中。状态只有 `PASS / FAIL / ERROR / NOT_APPLICABLE`：
工具没跑起来、报告缺失或 JSON 不可解析都记为 ERROR，绝不写成 PASS；N/A 必须带理由。

`make check-static` 已包含 `reliability-registry`，因此清单结构错误会在提交前被拦下。
修改 `contracts/reliability.json` 必须与对应测试同一 PR 显式出现，registry 的 sha256
会写入每份报告，便于审阅“清单是否被同步改动”。

## 2. 清单结构

`contracts/reliability.json` 只登记比架构契约更细的可靠性语义：

- `modules`：关键模块、是否 critical、对应测试；
- `invariants`：关键不变量、含义、模块、测试、`property_test`（文件/标题/最少运行次数）与适用门禁；
- `state_machines`：状态、初始/终态/冻结态、显式迁移边（含 `tested` 标记）、
  不可达状态理由、执行方式（`canTransition` 或入口守卫）与运行时缺口；
- `scenarios`：P0 边界/异常场景、对应测试标题；没有自动化测试时必须写 `na_reason`；
- `stability`：轮次、固定 seed、关键测试与理由；
- `mutation`：`break`（必须与 Stryker 一致，当前 80）、受控范围、关键文件、
  等价变异豁免（文件+行+mutator+理由）。

registry 会检查测试文件真实存在、属性测试标题能在文件中找到、每项 `min_runs >= 200`、
状态机终态无出边、冻结态只允许声明的例外、不可达状态必须有理由，并从源码抽取
`setStatus` 的字面量/常量，拒绝写入未登记的需求状态。

## 3. 属性测试与已知 flaky 修复

每项属性测试每次 PR 至少 200 次；nightly 通过 `FORGELOOP_PROPERTY_RUNS=1000` 放大。

固定 seed 复现：

```bash
cd packages/forgeloop
FORGELOOP_PROPERTY_SEED=61697261 FORGELOOP_PROPERTY_RUNS=200 \
  npx vitest run tests/property-invariants.test.ts
```

不设置 seed 时 fast-check 随机取种，失败信息会打印 `seed`、`path` 与 shrink 反例；
设置 `FORGELOOP_PROPERTY_VERBOSE=1` 可看到全部失败样本。

### 3.1 `property-invariants` seed 61697261 的复现与结论

修复前（2026-11-03 实测）用原 seed 运行的失败证据：

```text
Property failed after 33 tests
{ seed: 61697261, path: "32:0:0:0:0:0:0:0:0:0:0:0:0:0:13:13:0:...", endOnFailure: true }
Counterexample: [[{"goal":"!","files":["src/a.ts"],"acceptance":"!","test_command":["l","l"]},
                 {"goal":"!","files":["src/0.ts"],"acceptance":"!","test_command":["!"]}],1]
Shrunk 37 time(s)
Caused by: RuleViolationError: 任务包字段 test_command 不能包含重复项
```

结论：**测试假设错误，不是 round-trip 缺陷**。`parseTaskPlanDraft` 按领域规则拒绝
重复的 `test_command`（`src/domain/task-plan.ts` 的 `toStringList`）；原生成器用
`fc.array` 允许 `["l","l"]`，导致属性把非法输入当合法草稿。修复是把生成器改为
`fc.uniqueArray`，保留原有身份断言，不修改实现、不放宽断言。

修复后同一 seed 通过；`make stability` 与报告的 regression 段会用 seed 61697261
再跑一次作为回归证据。重复 `test_command` 的拒绝仍由 `tests/task-plan-rules.test.ts`
覆盖。

顺带确认：文件清单校验对连续分隔符按段归一化（`src//double.ts` 被接受且仍留在项目根内），
绝对路径、`..` 越界段、空清单与重复文件被拒绝；属性测试按实际语义断言，未放宽领域规则。

## 4. 状态机与执行方式

| 状态机 | 执行方式 | 测试覆盖 |
| --- | --- | --- |
| 部署 attempt | `canTransition` 是唯一判定，`Deployments.transition` 写库前校验并持久化 | 13 状态全 169 对穷举：合法边 19/19、非法边 150/150、终态 3×13；运行时批准/核对/拒绝/预检失败/工具失败路径与持久化一致 |
| 需求状态 | 词表与终态在 `domain/status.ts`；分析/规划/推进/修订/取消/停止/授权入口先查 `isTerminal` | 34/48 条声明边由 `revise/cancel/stop/grant` 入口逐条驱动；终态+冻结态 4 个 × 7 个操作全部拒绝且持久化不变；中断恢复断为 blocked；`rejected` 无写入入口（见 §6） |
| 任务运行结果 | 编译期联合类型；`recordTaskRun` 以 (req,plan,task) upsert，重试覆盖上一次事实 | 5×5=25 种结果写入/读回全部一致；心跳不隐式插入；未知状态从数据库读回时 fail-closed |
| 运维事件 | 入口守卫：`decide` 只接受 awaiting_decision，`close` 拒绝已关闭/动作运行中，`requestFix` 只接受三个状态；`OpsStore.updateOpsEvent` 本身不做状态机校验 | 7 状态 × 3 入口 = 21 组允许/拒绝判定；拒绝决定 → unresolved；重复关闭；运行中动作中断 → interrupted + unresolved 且不重放 |

未逐边断言的 14 条需求状态边（分析失败、待澄清、准入、规划、批准后执行、验证/提交等）
需要完整 Agent 流水线才能产生，已标记 `tested: false` 并由既有
`continuous-flow / verification / requirement-gate` 用例在流程级覆盖；报告如实展示
`34/48`，不写成 100%。

## 5. 增量变异

- 范围：`git diff BASE` 中 `packages/forgeloop/src` 的变更 + 各自直接 `import` 的本地源码（一跳）；
  没有受影响源码时记为 `NOT_APPLICABLE` 并写理由。
- 受控范围：清单 `mutation.controlled_scope`（domain/delivery/deployment/retry-policy/status/task-plan
  与 `runtime/acceptance-binding`），不含排除业务源码的豁免。
- 有效变异：`Killed` / `Timeout` / `Survived` / `NoCoverage` 计入分母；
  `CompileError` / `RuntimeError` / `Ignored` 计入 `excluded`，不冲抵得分。
- 得分 = (Killed + Timeout) / 分母；必须 ≥ `break`（80，与 `stryker.config.json` 一致，不允许用环境变量改）。
- 关键文件（retry-policy/status/task-plan/deployment）不允许存活变异；等价变异只能在清单登记
  `equivalent_mutants`（文件+行+mutator+理由），报告单列 `exemptedSurvivors`。
- 存活清单（文件:行 + mutator + replacement）写入 `reports/mutation-incremental.json`。
- 全量 92 个源文件的变异仍低于 80（2026-11 实测 56.28%），本批没有下调 break、没有排除源码；
  nightly 全量分片仍会如实变红，等待所有者决定补测试或批准基线。

变异执行器使用 `packages/forgeloop/vitest.mutation.config.ts`：它排除
`tests/monitor.test.ts` 的宿主进程聚合用例（Stryker worker 沙箱里 `ps` 采集返回空表，
初始测试假失败会让整轮变异无法开始）。该用例仍在 `make test` / `make coverage` 中运行，
monitor 源码仍在全量变异范围内；这里只调整变异执行器的测试选择，不排除业务源码。

## 6. 已知不一致与未落实（发现但不碰）

- `domain/status.ts` 声明了 `rejected` 终态，但当前运行时没有任何入口写入该状态；
  清单登记为 `unreachable` 并写理由，未擅自补业务入口。
- 部署状态机声明了 `rolling_back / rolled_back`，但 `Deployments` 没有回退执行入口；
  状态机与 `canTransition` 已覆盖，运行时可达性等待部署接口后续批次。
- `ForgeLoopRuntime.grant` 只追加授权、不校验终态/阻塞态，也不迁移到 approved；
  当前工具与工作台入口使用 `runtime/grants.ts` 的 `grantFailureRounds`（有守卫）。
  `grant` 未被工具/页面引用，登记为发现项，未改动。
- `Database.close()` 原实现对重复关闭抛 “database is not open”；本次以回归测试先红后绿，
  改为幂等释放（关闭后的读写仍然失败）。

## 7. CI 映射

- PR / push：`quality.yml` 的 `reliability-advanced` 作业运行 `make reliability-advanced`
  （增量变异，不做全量）；`make check-fast` 内置 registry 校验。
- nightly：`nightly.yml` 新增进阶作业（属性 1000 次、稳定性 5 轮、seed 取 run number），
  并保留全量覆盖率、8 分片变异与 `mutation-merge`。
- release：保持 real-host E2E（`make verify-plugin` / `make verify-e2e`），本批未改动。

## 8. 复现命令

```bash
make reliability-registry
make stability
make mutation-incremental SCOPE=controlled
make reliability-advanced
# 覆盖率单独门禁（报告在存在且不超过 24h 时才引用）
make coverage
```
