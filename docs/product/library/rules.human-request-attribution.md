<!-- library
{
  "id": "rules.human-request-attribution",
  "title": "人工请求的认定条件",
  "status": "confirmed",
  "topics": [
    "autonomy.human-request",
    "requirement.facts",
    "autonomy.stats"
  ],
  "summary": "只有配置了需求负责人且请求人与之一致，或请求带有 web-decision 前缀时，才把请求认定为人工请求；负责人为空时，即使请求人字段匹配也不认定为人工请求。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 人工请求的认定条件

## 业务目标
避免把非人工来源或配置缺失的场景误计为人工请求，保证自主性统计口径可信。

## 用户与角色
- 需求负责人
- 提交请求的操作者
- 自主性指标使用方

## 触发与前提
对需求事实进行人工请求判定时。

## 预期行为
系统应依据负责人配置与请求来源前缀识别人工请求；负责人未配置、或请求人为空且负责人为空的场景都应判定为非人工请求。

## 业务规则
- 请求人与需求负责人一致时，该请求计入人工请求。
- 带有 web-decision 前缀的请求计入人工请求。
- 需求负责人为空时，即使请求人字段与负责人看起来匹配，也不认定为人工请求。
- 请求人为空且负责人为空时，不误计为人工请求。

## 例外与边界
- 无负责人配置的自主运行场景不计入人工请求。
- 请求人缺失且负责人缺失时按非人工处理，而不是按默认人工处理。

## 可观察验收
- 需求负责人为空时，可核对到该请求未被标记为人工请求。
- 存在负责人且请求人一致时，可核对到该请求被计为人工请求。

## 适用范围与版本
自主性统计中的需求事实判定，2026-11 版本

## 证据
- [acceptance] packages/forgeloop/tests/autonomy-human-requests.test.ts · L66 · 2026-11-10
- [git] 45293eb5ee363d68645d677d7a060431bdef1667 · packages/forgeloop/tests/autonomy-human-requests.test.ts · 2026-11-10
