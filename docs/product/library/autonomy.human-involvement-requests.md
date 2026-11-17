<!-- library
{
  "id": "autonomy.human-involvement-requests",
  "title": "人类介入按所有者与网页决策请求计数",
  "status": "confirmed",
  "topics": [
    "autonomy.human-involvement",
    "autonomy.requests",
    "metrics.autonomy",
    "owner.identity"
  ],
  "summary": "自主性统计中，网页决策请求视为人类介入；配置所有者后，所有者请求即使没有指定前缀也计入；未配置所有者时，非所有者 Agent 请求不计入。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 人类介入按所有者与网页决策请求计数

## 业务目标
准确衡量自主运行中的人类介入程度，避免把代理请求误计为人类决策。

## 用户与角色
- 系统所有者
- 自主执行 Agent
- 指标使用者

## 触发与前提
自主运行产生需要人类决策的请求，或统计人类介入次数时。

## 预期行为
系统按请求来源与所有者配置判定是否属于人类介入：网页决策请求计入；所有者发起的请求计入；未配置所有者时，非所有者 Agent 的请求不计入。

## 业务规则
- 网页决策请求属于人类介入。
- 已配置所有者时，所有者身份优先于请求前缀标记。
- 未配置所有者时，非所有者 Agent 请求不得计为人类介入。

## 例外与边界
- 未配置所有者且请求来自非所有者 Agent，不计入。
- 所有者请求未带常规前缀，仍计入。

## 可观察验收
- 指标中，网页决策请求和所有者请求体现为人类介入；未配置所有者时，非所有者 Agent 请求不增加人类介入计数。

## 适用范围与版本
自主性人类介入指标统计。

## 证据
- [acceptance] packages/forgeloop/tests/autonomy-human-requests.test.ts · L48 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-human-requests.test.ts · L54 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-human-requests.test.ts · L60 · 2026-11-10

## 证据缺口与待澄清
- 所有者身份的配置方式与多所有者场景未说明。
- 带前缀但非所有者的请求如何计数未说明。
