<!-- library
{
  "id": "rules.admission-rejection-reasons",
  "title": "准入拒绝原因须逐项可核对",
  "status": "confirmed",
  "topics": [
    "admission.rejection",
    "admission.transparency",
    "admission.reason"
  ],
  "summary": "每种准入拒绝条件都应返回各自且与触发原因一致的说明；禁用自治、项目缺失、来源不可信、所有者不匹配、分析陈旧等不得合并为笼统提示。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 准入拒绝原因须逐项可核对

## 业务目标
让提交者准确理解准入失败原因并据此修正。

## 用户与角色
- 需求提交者
- 项目所有者
- 准入流程

## 触发与前提
需求准入被拒绝时

## 预期行为
系统按实际失败条件返回独立、措辞一致且可区分的拒绝说明；多种条件同时失败时逐项呈现。

## 业务规则
- 每种拒绝条件须有独立说明
- 说明措辞须与触发条件保持一致
- 不同拒绝条件之间须可区分

## 例外与边界
- 多种拒绝条件同时出现
- 拒绝说明不得吞并其他已触发条件

## 可观察验收
- 触发不同拒绝条件时，提示文本与对应条件一致且彼此可区分。

## 适用范围与版本
需求准入阶段，适用范围待确认

## 证据
- [acceptance] packages/forgeloop/tests/admission.test.ts · L181 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L193 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L228 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L255 · 2026-11-09

## 证据缺口与待澄清
- 多条拒绝条件同时出现时的排序与合并规则待确认
