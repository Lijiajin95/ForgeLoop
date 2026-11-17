<!-- library
{
  "id": "rules.self-verification-mode",
  "title": "研发按 diff 风险选择自验或独立测试",
  "status": "confirmed",
  "topics": [
    "dev.self-verification",
    "verification.mode"
  ],
  "summary": "研发 Agent 根据代码 diff 风险选择 independent 或 self；self 必须覆盖全部已交付任务，缺报告或任一任务选择 independent 时整份候选转独立测试；BUG 修复或高风险改动必须证明修复前失败、修复后通过，并引用真实命令、代码身份、退出码与日志。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 研发按 diff 风险选择自验或独立测试

## 业务目标
在低风险改动上减少重复验证，同时用强制证据守住关键行为

## 用户与角色
- 研发 Agent
- 运行时验证工具
- 测试 Agent

## 触发与前提
研发完成实现并形成候选后选择验证模式

## 预期行为
运行时只接受结构化自验报告；证据不足或覆盖不完整时保守转独立测试；研发不描述或指挥独立测试怎么做。

## 业务规则
- 运行时只接受结构化自验报告
- 自验不足时保守要求独立测试
- 研发不描述或指挥独立测试怎么做
- BUG 修复或高风险改动必须具备修复前失败、修复后通过证据

## 例外与边界
- 缺报告或任一任务选择 independent 时整份候选转独立测试

## 可观察验收
- 选择 self 的候选能看到覆盖全部任务的自验证据
- 证据不足时候选被转交独立测试而不是直接提交

## 适用范围与版本
研发自验证与模式选择，2026-11 版本

## 证据
- [doc] CONTEXT.md · 执行与证据／研发自验、自验证模式 · 2026-11-17
- [doc] docs/product/product.md · §5.2 五个 Agent 与自动交接 · 2026-11-17
