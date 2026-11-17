<!-- library
{
  "id": "rules.reliability-trend-append-only",
  "title": "可靠性趋势只用追加型记录",
  "status": "confirmed",
  "topics": [
    "reliability.trend",
    "reliability.history"
  ],
  "summary": "可靠性页的交付趋势只使用追加型记录按事件时间归周，任务运行的当前状态只展示当前值，不用于回放历史或画趋势。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 可靠性趋势只用追加型记录

## 业务目标
避免用后来状态错误地回算过去，保持趋势可核对

## 用户与角色
- 项目用户（查看趋势）
- 系统（统计）

## 触发与前提
展示最近数周验证、失败与上线趋势或指标历史时

## 预期行为
趋势按事件时间归周；指标历史按版本变化追加采样，长期无变化时保留心跳；历史仅用于回答指标如何变化，不参与门禁判定。

## 业务规则
- 只有追加型表可以按时间窗口统计
- 每行只保留当前状态的表不能用于历史趋势
- 指标历史不参与门禁判定

## 例外与边界
- 样本不足时数字照常显示但标注仅供参考

## 可观察验收
- 趋势图与可展开表格的数字可按事件时间回查
- 页面不出现由当前任务状态推算的历史曲线

## 适用范围与版本
天工「可靠性」视图的趋势与历史区，2026-11 版本

## 证据
- [doc] docs/product/reliability-dashboard.md · §3.3 趋势、§3.5 指标历史与自动刷新 · 2026-11-16
- [git] 0375d798eb236ed36274bfa2010cd8f0a7ba1c1d · docs/verification/status.md · 2026-11-16
