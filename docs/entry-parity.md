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

1. **邮件停止**：需要新增 `操作: 停止` 指令，复用 `cmd_requirement_stop`（数据流分派）。
2. **邮件 plan**：任务包生成需要模型调用；邮件侧应支持 `操作: 规划`，命令取配置。
3. **状态查询**：邮件可加 `操作: 状态` 只读回执（页面/CLI 已有）。
4. **归并/发布**：属交付动作，页面与邮件是否需要等价需所有者确认（暂记 ➖/⛔）。

## 3. 等价性测试分层

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 单元 | 三入口各自的动作解析（CLI 参数、页面请求体、邮件指令行） | `tests/unit` |
| 场景 | 同一操作经 CLI 与邮件后**记录一致** | `tests/scenario/test_entry_parity.py` |
| 集成 | 同一操作经页面 HTTP 后记录一致（真实服务进程） | `tests/integration/test_serve_operations.py` |
| 真实验证 | 真实邮箱 + 真实服务进程 + 真实 CLI 三方对照 | 见 `docs/resident-service-acceptance.md` |

对比断言统一为**记录事实**（状态、批准/决定/验收记录的关键字段），而非 HTTP 状态码或输出文案；
入口标签（`source`、`by`）允许不同，但必须如实记录来源。
