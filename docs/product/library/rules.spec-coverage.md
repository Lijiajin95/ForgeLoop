<!-- library
{
  "id": "rules.spec-coverage",
  "title": "业务要点必须有验收且被任务覆盖",
  "status": "confirmed",
  "topics": [
    "spec.business-point",
    "spec.acceptance-item",
    "task-plan.coverage"
  ],
  "summary": "每条业务要点至少有一个验收项，缺项由程序拒绝；验收项用 point_ids 引用要点并以 given／when／then 描述可观察结果；任务包每个任务用 covers 列出覆盖的要点编号，未覆盖或引用不存在的要点按不合规退回重规。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 业务要点必须有验收且被任务覆盖

## 业务目标
让需求意图可逐条追溯到可观察验收与实际研发任务

## 用户与角色
- 产品 Agent
- 研发 Agent
- 运行时规格校验

## 触发与前提
分析产出业务要点与验收项，或研发生成任务包

## 预期行为
缺验收的要点被程序拒绝；任务包存在未覆盖或无效引用的要点时退回重新规划。

## 业务规则
- 模型推断只能进假设，不能写成业务要点
- 验收项不得是“功能正常／优化体验”式自评
- 任务数量不是验收覆盖的替代

## 例外与边界
- 验收项引用不存在的要点按不合规处理
- 假设仍需确认时不能进入研发

## 可观察验收
- 缺少验收项的要点会被程序拒绝
- 任务包存在未覆盖要点时被退回重新规划

## 适用范围与版本
需求说明与任务包覆盖，2026-11 版本

## 证据
- [doc] CONTEXT.md · 工作对象／业务要点、验收项、需求条目 · 2026-11-17
- [doc] docs/development/architecture.md · §4.1 ForgeLoop 业务会话（任务包 covers） · 2026-11-17
- [doc] docs/product/product.md · §5.2 五个 Agent 与自动交接 · 2026-11-17
