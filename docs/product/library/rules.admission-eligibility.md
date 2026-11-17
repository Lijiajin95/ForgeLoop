<!-- library
{
  "id": "rules.admission-eligibility",
  "title": "自治、项目与需求状态构成准入前置条件",
  "status": "confirmed",
  "topics": [
    "admission.autonomy",
    "admission.project",
    "admission.state"
  ],
  "summary": "需求仅在自治已启用、所属项目存在且需求未处于终态时可准入；任一条件不满足都应阻止并说明具体原因。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 自治、项目与需求状态构成准入前置条件

## 业务目标
防止在不可执行或已经结束的上下文中启动需求处理。

## 用户与角色
- 项目所有者
- 系统操作者
- 准入流程

## 触发与前提
需求准入前执行前置条件校验时

## 预期行为
系统逐项校验自治开关、项目存在性和需求状态；任一条件不满足即阻止准入并返回对应说明。

## 业务规则
- 自治未启用时不得准入
- 所属项目不存在时不得准入
- 需求已处于终态时不得准入
- 不同终态须分别给出对应说明

## 例外与边界
- 自治被关闭
- 所属项目缺失
- 需求处于任一终态

## 可观察验收
- 自治关闭、项目缺失或需求处于任一终态时均不能准入，且提示对应状态。

## 适用范围与版本
需求准入阶段，适用范围待确认

## 证据
- [acceptance] packages/forgeloop/tests/admission.test.ts · L160 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L181 · 2026-11-09
- [acceptance] packages/forgeloop/tests/admission.test.ts · L193 · 2026-11-09

## 证据缺口与待澄清
- “终态”覆盖的状态集合以何处为准待确认
