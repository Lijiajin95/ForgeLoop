<!-- library
{
  "id": "rules.data-scope-requires-restore-point",
  "title": "涉及数据的部署必须有可用恢复点",
  "status": "confirmed",
  "topics": [
    "deployment.data",
    "deployment.rollback",
    "deployment.preflight"
  ],
  "summary": "部署目标声明数据卷或数据迁移时，部署前检查必须给出可用的恢复点，否则不允许执行部署。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 涉及数据的部署必须有可用恢复点

## 业务目标
保证涉及数据的变更在失败时能回到一个已知状态。

## 用户与角色
- 所有者
- 部署工具
- 运维 Agent

## 触发与前提
部署目标声明了数据卷或数据迁移

## 预期行为
部署前检查未返回可用的快照或备份标识时，系统拒绝执行部署。

## 业务规则
- 数据范围只用标识与说明声明，不能写成命令。
- 没有恢复点不得执行部署。
- 回退与数据恢复由登记工具完成，系统只声明范围、记录证据并核对结果。

## 例外与边界
- 数据范围为空时不受此限制。
- 回退后由系统核对恢复结果，不代替工具执行恢复。

## 可观察验收
- 声明数据范围但部署前检查没有恢复点时，部署被拒绝并说明原因。

## 适用范围与版本
声明了数据范围的部署目标

## 证据
- [doc] docs/development/deployment-interface.md · §3 工具契约（数据范围）、§4 配置设计 · 2026-11-13

## 证据缺口与待澄清
- 真实数据库迁移与容器卷回退尚未验证。
