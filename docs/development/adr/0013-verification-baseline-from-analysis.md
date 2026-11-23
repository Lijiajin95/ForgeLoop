# ADR 0013：验证基线改由需求分析生成

- 状态：已接受（2026-11-23，所有者要求“验证不关注研发阶段的自验结果”，选择移除验证侧的实现前评审前置）
- 依据：[产品方案 §5.2.1](../../product/product.md#521-研发阶段的人工评审与准出2026-11-23所有者已确认待实施)、[状态记录 §268](../../verification/status.md)、[ADR 0012](0012-single-verification-path.md)

## 背景

验证阶段（独立测试）此前从实现前评审记录 `planReview.report_json` 读取 `verification_plan`，并把评审必须 `pass` 作为进入验证的前置：`verificationInputs` 先查 `planReview`，再解析评审 JSON，最后把评审摘要写入 `verification.json` 的 `planReviewSha256`。这使验证阶段的输入依赖研发阶段的评审产物，和“验证只按需求与固定候选独立判断”的定位冲突，也让评审口径变化直接影响验证。

同时 `VerificationPipelineDeps` 里已有 `verificationBaseline(analysis)`（由产品分析的业务场景与验收标准生成 `PlanReview` 形状的基线，summary 明确“不构成对人类批准的替代”），但从未被调用。

## 决定

1. 验证阶段的基线改由 `verificationBaseline(analysis)` 生成：分析里的每个业务场景都是必过场景，验收标准按序对应；验证报告记录基线的 `verificationBaselineSha256`（原 `planReviewSha256` 字段退役）。
2. 验证阶段不再读取 `planReview` 记录，也不读取任务自验日志（`test_log_path`）与逐任务评审（`review_path`）。输入只剩：已授权任务包、需求与最新分析、逐任务交付候选 diff、工程快照与配置预算。
3. `verificationBaseline` 由死依赖变为活依赖；`VerificationPipelineDeps` 中未使用的 `openAgent` 删除。
4. 本决定只覆盖验证阶段。批准链路的“实现前评审”前置仍在（`approvePlan` 要求评审 `pass`），因此实际门禁未放宽；移除该前置属于研发阶段人工评审退役批次（见产品方案 §5.2.1），不在本 ADR 范围。

## 影响

- 行为：验证不再因评审缺失/阻断/畸形而拒绝；评审记录存在与否不影响判定。验证基线内容随分析版本变化，报告可比对基线摘要。
- 证据：`verification.json` 的 `planReviewSha256` 改为 `verificationBaselineSha256`；preflight 阻断报告同样记录。
- 测试：`coverage-pipeline-verification.test.ts` 增加“无评审记录也能验证”“阻断评审不影响判定”，并更新依赖桩；`mutation-gap-verify-deep.test.ts`、`verification-blackbox-path.test.ts` 同步。
- 不受影响：候选身份、工作区完整性与越界检查、命令执行、敏感性对照、失败分类、业务终审与下游构建门禁。
- 未完成：批准链路的评审前置、两条验证执行路径的收敛（ADR 0012）。

## 待确认

- 评审记录是否继续写入、是否保留在看板历史：本批未改动，规划流程与看板展示保持原样。
- 批准前置移除后，谁对“任务包可进入实现”负责：产品方案 §5.2.1 已记为待所有者确认，不在本 ADR 解决。
