<!-- library
{
  "id": "tools.fail-closed-allowlist",
  "title": "工具白名单失败关闭",
  "status": "confirmed",
  "topics": [
    "tools.allowlist",
    "security.fail-closed",
    "agent.permissions",
    "host.capability"
  ],
  "summary": "Agent 工具调用必须遵循显式白名单：宿主无法限制工具时拒绝运行，未提供白名单时拒绝全部工具，白名单之外的工具一律拒绝。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 工具白名单失败关闭

## 业务目标
防止 Agent 在无法约束权限时获得未授权工具能力。

## 用户与角色
- 系统所有者
- Agent 运行时
- 工具提供方

## 触发与前提
Agent 请求调用工具，或宿主声明工具限制能力时。

## 预期行为
系统在执行前校验宿主限制能力与白名单；不能限制就拒绝运行，没有白名单就视为空集，只有白名单内工具可以执行。

## 业务规则
- 宿主无法限制工具时，系统必须拒绝运行，不得降级为全量放行。
- 未提供白名单时，默认拒绝所有工具。
- 白名单是唯一授权来源，白名单外工具不得执行。

## 例外与边界
- 宿主不支持工具限制能力。
- 白名单缺失或为空。
- 请求调用的工具不在白名单内。

## 可观察验收
- 在无法限制工具的宿主上启动 Agent，用户看到明确拒绝，而不是所有工具都可用。
- 未配置白名单时，任何工具调用都被拒绝并给出原因。
- 调用白名单外工具时被拒绝，白名单内工具正常执行。

## 适用范围与版本
Agent 工具执行与宿主能力协商场景。

## 证据
- [acceptance] packages/forgeloop/tests/agent-tool-allowlist.test.ts · L18 · 2026-11-10
- [acceptance] packages/forgeloop/tests/agent-tool-allowlist.test.ts · L24 · 2026-11-10
- [acceptance] packages/forgeloop/tests/agent-tool-allowlist.test.ts · L9 · 2026-11-10

## 证据缺口与待澄清
- 白名单的配置主体、审批流程和变更审计要求未在证据中说明。
