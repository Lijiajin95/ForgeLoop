<!-- library
{
  "id": "rules.business-context-change-traceable",
  "title": "业务背景变更须有可追溯原因",
  "status": "confirmed",
  "topics": [
    "business-context",
    "change.traceability",
    "change.rejection"
  ],
  "summary": "业务背景的每次变更都必须附带可追溯的原因，缺失原因的变更请求应被拒绝而不落库。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 业务背景变更须有可追溯原因

## 业务目标
让业务背景的演进可回溯，避免无声改写导致后续分析建立在错误前提上。

## 用户与角色
- 提出业务背景变更的人
- 依赖业务背景的需求分析者

## 触发与前提
提交业务背景变更时

## 预期行为
系统检查变更是否附带可追溯原因，缺失时拒绝该变更并保持原内容。

## 业务规则
- 每次业务背景变更都要有可追溯原因
- 无原因的变更不得被接受

## 例外与边界
- 缺少可追溯原因的变更被拒绝

## 可观察验收
- 提交无原因的变更会被拒绝
- 附带可追溯原因的变更可被接受

## 适用范围与版本
业务背景文档变更，2026-11 版本

## 证据
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L231 · 2026-11-15

## 证据缺口与待澄清
- 原因的表达形式与是否需要审批未在证据中确定
