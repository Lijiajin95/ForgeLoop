<!-- library
{
  "id": "rules.clarification-open-questions-block",
  "title": "未回答的澄清问题保持开放并阻断准入",
  "status": "confirmed",
  "topics": [
    "requirement.clarification",
    "requirement.gate",
    "requirement.traceability"
  ],
  "summary": "需求分析提出的澄清问题逐条记录；只回答其中一部分时，其余问题继续开放并使需求停在待澄清，后续追问不会丢弃旧问题。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 未回答的澄清问题保持开放并阻断准入

## 业务目标
保证关键问题未决时，需求不会带着空白进入实现。

## 用户与角色
- 产品 Agent
- 需求提出者
- 所有者

## 触发与前提
需求分析产生澄清问题，或提出者只回答了其中一部分

## 预期行为
每个问题分别记录回答与回答顺序；仍有未答问题时需求保持待澄清并阻断准入；新一轮分析新增追问时，旧问题继续保留。

## 业务规则
- 回答只作用于被回答的问题。
- 未答问题不能被静默丢弃。
- 所有阻断性问题关闭后，需求才能进入已明确状态。

## 例外与边界
- 分析失败或超时不等于已回答，问题保持开放。

## 可观察验收
- 只回答部分问题时，界面仍显示其余问题开放，且需求不能进入下一阶段。

## 适用范围与版本
需求分析与准入阶段

## 证据
- [doc] docs/verification/evidence/2026-11-07-requirement-stage/README.md · 场景 A：连续部分回答 · 2026-11-13

## 证据缺口与待澄清
- 全部答完并完成准入的完成态尚未取得样本。
