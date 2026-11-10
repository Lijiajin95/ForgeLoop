# ADR 0012：独立验证收敛到单一黑盒执行模型

- 状态：提议（2026-11-10，待所有者确认）
- 依据：[状态记录 §222](../status.md#222-独立复核-head-729d708门禁复跑与-217-结论更正2026-11-10-220x)、
  [状态记录 §217](../status.md#217-领域-7-边界结构核查2026-11-10-002x)、
  [统一方案 §14.2](../product.md)
- 承接：[ADR 0008](0008-typescript-native-dsh-plugin.md)（TypeScript 原生插件）

## 背景

当前有两条独立测试执行路径，判定规则已于 `7b54e0d` 合并到
`src/domain/verification-outcome.ts`，但**执行与证据模型仍是两套**：

1. **连续推进路径**（`runtime/legacy-verification.ts`）：研发前先开测试会话写验证方案，
   候选固定后会话只能用 `allowTools: [VERIFICATION_CHECK_TOOL, VERIFICATION_MATERIAL_TOOL]`
   执行方案里的命令并写 `verification/` 材料；程序读取注册表快照判定，再做敏感性对照与业务复审。
   黑盒边界由工具白名单保证，宿主无法限制工具时 fail-closed（`9803201`）。
2. **显式 verify 路径**（`runtime/verification-pipeline.ts`）：以 `tools: 'default'`、
   `permission: 'workspace-write'` 启动一次 verify Agent，让模型自己在候选工作区写
   `verification/commands.json`、`report.json`、`controls.json`；程序随后重跑声明的命令并复核输出。
   候选 diff 已不再进提示词（`ed70cff`），越界改动靠事后完整性判定阻断，但**读源码、执行任意命令、
   改写候选**没有事前拒绝。

产品要求“测试 Agent 只能调用公开产品接口，拒绝读取源码/候选 diff、改写候选和未授权工具”。
第二条路径目前只有提示词与事后阻断，机制上不满足；两条执行模型并存也让证据结构与失败分类难以统一。

## 决定（提议）

选定**单一执行模型**：两条入口都走“方案先定、工具受限执行、程序判定”的黑盒机制，
显式 verify 不再给模型标准编码工具面。

迁移方向二选一，由所有者定：

- **A（推荐）复用现有黑盒机制**：`executeVerification` 内部改为
  `legacyVerification.openVerification` → `verifyCandidate`；需要从记录组装
  `CandidateFile`（候选 diff、版本、snapshot），并保证业务复审只跑一次。
- **B 给 pipeline 注入注册表**：保留材料通道，但命令只能经 `VerificationCheckRegistry` 执行；
  需要两阶段 Agent 运行（先写方案、再执行）与注册表接线。

## 影响

- 两条入口共用同一工具白名单、同一 `verification.json` 结构与同一失败分类；
  领域 7 的“拒绝读源码/候选 diff、拒绝改写候选、拒绝未授权工具”从提示词约束变成机制约束。
- 需要改写 `verification.test.ts`、`coverage-pipeline-verification.test.ts` 等约 50+ 用例的
  假 runner（从“直接写材料”改为“经工具执行”或“断言工具边界”）；属于跨模块重构。
- 仓库内不产生新的外部依赖；`records` 层、持久化表与契约不变。
- 迁移期间必须保留两条入口的通过与拒绝证据，不得放宽现有门槛换取测试全绿。

## 实施顺序（确认后）

1. 接线改造 + 一条正向用例（显式 verify 走受限工具面仍能完成一次合法验证）；
2. 一条负向用例（越界工具调用被拒绝、候选被改写被阻断）；
3. 迁移存量用例，逐文件跑覆盖率门槛；
4. 更新 `docs/architecture.md` 的验证路径说明与 `docs/status.md` 的领域 7 状态；
5. 外部条件具备后再补真实模型复验（正常执行、越界拒绝、有界纠错、失败阻断）。

未确认前保持现状：领域 7 记“部分完成”，不以提示词层面的一致替代机制收口。
