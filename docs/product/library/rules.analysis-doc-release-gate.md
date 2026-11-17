<!-- library
{
  "id": "rules.analysis-doc-release-gate",
  "title": "需求分析正式文档的发布门禁",
  "status": "confirmed",
  "topics": [
    "analysis.document",
    "analysis.draft",
    "analysis.validation",
    "analysis.clarification"
  ],
  "summary": "需求分析只有在校验通过且澄清问题全部关闭后才写正式文档，并记录版本与依据；未通过或正式文档写入失败时只保留草稿。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 需求分析正式文档的发布门禁

## 业务目标
保证进入需求库的正式文档完整、可追溯，未定稿内容不污染正式材料。

## 用户与角色
- 需求分析执行者
- 需求负责人
- 下游需求分析引用者

## 触发与前提
分析产出准备落盘为正式文档时

## 预期行为
系统先校验分析结果并确认澄清项均已关闭；通过后写入正式文档并记录版本与依据；未通过或写入失败时保留草稿并如实报告该次分析失败。

## 业务规则
- 校验未通过时不得写正式文档
- 澄清问题未关闭时保持草稿状态
- 正式文档只能在校验通过后产生
- 正式文档需同时记录版本与依据
- 正式文档写入失败时整次分析失败且草稿不丢失

## 例外与边界
- 校验失败
- 澄清仍未关闭
- 正式文档目标不可写

## 可观察验收
- 校验失败后用户只能看到草稿，正式文档不存在
- 澄清未关闭时仍为草稿状态
- 校验通过后正式文档出现，且带版本与依据
- 正式文档写入失败时分析报失败，但草稿仍保留

## 适用范围与版本
需求分析文档写入流程，2026-11 版本

## 证据
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L129 · 2026-11-15
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L152 · 2026-11-15
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L186 · 2026-11-15
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L211 · 2026-11-15

## 证据缺口与待澄清
- 校验项清单与“依据”的具体载体未在证据中给出
