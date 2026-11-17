<!-- library
{
  "id": "rules.workspace-tenant-lifecycle",
  "title": "工作区租户核对、释放与运维监控范围",
  "status": "confirmed",
  "topics": [
    "workspace.lifecycle",
    "tenant.reconcile",
    "ops.monitoring"
  ],
  "summary": "系统定时核对工作区注册表，按需创建租户，删除工作区时释放对应协调器与记录库；运维监控默认只在 legacy 租户运行，其他工作区需项目配置显式声明才开启。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 工作区租户核对、释放与运维监控范围

## 业务目标
保证工作区与租户资源保持一致，避免资源残留与非预期监控

## 用户与角色
- 工作区创建者与使用者
- 系统（核对与释放）

## 触发与前提
注册表新增或删除工作区；定时核对到达

## 预期行为
新增工作区时按需创建租户，删除时释放协调器与记录库；运维监控默认只在 legacy 租户运行，其他工作区需项目配置显式声明运维能力后才开启。

## 业务规则
- 定时核对只启动一次，重复停止安全
- 注册表删除工作区时释放其协调器与记录库
- 释放全部租户时逐项记录失败，不因单项失败中断
- 运维监控默认只在 legacy 租户运行
- 其他工作区需项目配置显式声明才运行运维监控

## 例外与边界
- 列表读取失败、停止或关闭失败、新工作区创建失败只记录不中断
- 未显式声明运维能力的工作区不运行运维监控

## 可观察验收
- 删除工作区后其协调器与记录库被释放
- 非 legacy 工作区默认没有运维监控，除非项目配置声明

## 适用范围与版本
多工作区宿主，当前实现

## 证据
- [git] 3ea456c7b8a235ebeea8465ccfaafdfa1f8fca05 · packages/forgeloop/src/runtime/workspace-tenants.ts · 2026-11-16
- [git] 9884c7bcaf231c4b90b57be35eeac10174e888de · packages/forgeloop/tests/workspace-tenants-reconcile.test.ts · 2026-11-16

## 证据缺口与待澄清
- 项目配置中声明运维能力的字段语义与默认值待确认
