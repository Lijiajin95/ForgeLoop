<!-- library
{
  "id": "rules.reliability-measurement-point",
  "title": "可靠性页指标绑定同一测量点",
  "status": "confirmed",
  "topics": [
    "reliability.measurement",
    "reliability.window",
    "reliability.display"
  ],
  "summary": "可靠性页以质量快照的生成时间为测量点，验证、部署、失败轮次与运维恢复均按该时点计算，之后发生的事件不回填成当时已发生。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 可靠性页指标绑定同一测量点

## 业务目标
让门禁结果与交付可靠性指标同属一个提交和时间，避免与当前状态混排

## 用户与角色
- 项目用户（查看）
- 系统（计算与展示）

## 触发与前提
打开可靠性视图或刷新时

## 预期行为
顶部状态条显示项目、分支、快照提交、快照时间与新鲜度；没有可用快照时退回当前时刻并标注未绑定；任务当前状态单独标注。

## 业务规则
- 质量门禁与运行指标使用同一测量点计算
- 测量点之后产生的验证、部署、失败轮次与运维恢复不进入本页，也不回填
- 任务当前状态不参与测量点计算，页面单独标注
- 未运行、未采集、过期、样本不足分别呈现，不显示为 0 或通过
- 样本少于 5 时标注样本不足，不据此下结论
- 关注线只是展示建议值，不成为新的硬门禁

## 例外与边界
- 快照落后当前提交时提示落后提交数，不静默展示旧数字

## 可观察验收
- 页面顶部显示快照提交与快照时间，指标可回查到对应来源
- 未运行的门禁显示为未运行而不是通过
- 快照落后时页面出现落后提示

## 适用范围与版本
天工「可靠性」视图，2026-11 版本

## 证据
- [doc] docs/product/reliability-dashboard.md · §2.3 页面区块与数据、§3.2 交付与运行可靠性 · 2026-11-16
- [git] 2acc6373c20398fe85bad3cd4dc205d4fe86ad9c · docs/verification/status.md · 2026-11-16
- [git] 862ed7159680c16dabb7e09e5a24c45cb7f88593 · docs/product/reliability-dashboard.md, packages/forgeloop/client.js · 2026-11-16
- [git] ab2f6cc6f49382859cfd5aff2ffa8b93ae43d4d8 · docs/verification/status.md · 2026-11-16

## 证据缺口与待澄清
- 质量快照是否在每次核对前重新生成，取决于实际运行，不由本规则保证
