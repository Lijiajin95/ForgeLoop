<!-- library
{
  "id": "rules.analysis-single-flight",
  "title": "同一需求版本只执行一次分析",
  "status": "confirmed",
  "topics": [
    "analysis.single-flight",
    "analysis.retry",
    "analysis.attempt"
  ],
  "summary": "同一需求版本只执行一次产品分析，重复请求不会新增模型调用；失败时同一版本有限次自动重试，之后可由客户手动重新分析，每次真正执行都保留尝试、模型、提示词版本、轨迹与工具调用，且不覆盖历史结论。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 同一需求版本只执行一次分析

## 业务目标
保证分析结论唯一、可审计，并让失败可恢复但不重复消耗

## 用户与角色
- 产品 Agent
- 运行时协调器
- 业务用户

## 触发与前提
需求版本首次分析、失败后自动重试或客户在看板发起重新分析

## 预期行为
分析结论绑定需求版本写入；尝试记录按需求版本与 attempt 唯一留痕，失败原因、模型、提示词版本、轨迹与工具调用全部保留。

## 业务规则
- 一次需求版本只有一次有效分析结论
- 失败尝试按需求版本与 attempt 唯一留痕，同一路径不覆盖
- 自动重试用完后仍可由客户人工重试

## 例外与边界
- 已有分析时返回未重复调用模型
- 分析失败的需求进入 analysis_failed，由协调器自动重试

## 可观察验收
- 对同一版本重复触发分析不会产生第二次模型调用
- 看板能看到各次尝试与失败原因，并可手动重新分析

## 适用范围与版本
产品分析，2026-11 版本

## 证据
- [doc] CONTEXT.md · 工作对象／产品分析尝试、单飞分析 · 2026-11-17
- [doc] docs/development/architecture.md · §4.1 ForgeLoop 业务会话（产品分析只执行一次） · 2026-11-17
- [doc] docs/product/product.md · §5.2 五个 Agent 与自动交接 · 2026-11-17
