<!-- library
{
  "id": "rules.admission-analysis-ready",
  "title": "分析与澄清未就绪的需求不得准入",
  "status": "confirmed",
  "topics": [
    "admission.analysis",
    "admission.clarification",
    "admission.freshness"
  ],
  "summary": "需求准入要求分析结果未过期且澄清事项已处理；存在陈旧分析或待澄清时拒绝，并在拒绝信息中给出澄清数量。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 分析与澄清未就绪的需求不得准入

## 业务目标
避免基于过期或未澄清的信息启动实现，降低返工风险。

## 用户与角色
- 需求提交者
- 需求分析者
- 项目所有者
- 准入流程

## 触发与前提
提交已完成分析的需求申请准入时

## 预期行为
系统检查分析时效与澄清状态；任一未满足即阻止准入，并返回对应原因与澄清数量。

## 业务规则
- 分析结果必须处于当前有效状态
- 待澄清事项必须已关闭才可准入
- 存在澄清事项时须报告澄清数量

## 例外与边界
- 分析结果已陈旧
- 仍存在未关闭的澄清事项
- 分析陈旧且同时存在澄清事项

## 可观察验收
- 存在陈旧分析或待澄清事项的需求被拒绝，响应中可见澄清数量与对应原因。

## 适用范围与版本
需求准入阶段，适用范围待确认

## 证据
- [acceptance] packages/forgeloop/tests/admission.test.ts · L102 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L228 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L255 · 2026-11-09

## 证据缺口与待澄清
- 分析“陈旧”的判定时限与澄清关闭口径待确认
