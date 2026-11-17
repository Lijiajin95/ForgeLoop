<!-- library
{
  "id": "autonomy.current-artifact-deployment",
  "title": "仅当前产物的已验证部署计入自主交付",
  "status": "confirmed",
  "topics": [
    "autonomy.deployment",
    "autonomy.artifact",
    "delivery.verification",
    "metrics.autonomy"
  ],
  "summary": "自主交付统计只承认当前产物已完成构建、部署并通过验证的部署；旧产物、未验证产物、无构建或无部署均不计入。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 仅当前产物的已验证部署计入自主交付

## 业务目标
避免用历史成果或未验证产物虚增自主交付。

## 用户与角色
- 自主执行 Agent
- 系统所有者
- 交付看板使用者

## 触发与前提
统计或展示自主部署完成情况时。

## 预期行为
系统比对当前产物、部署记录和验证状态；只有当前产物同时满足已构建、已部署、已验证，才计为一次自主交付部署。

## 业务规则
- 部署必须对应当前产物。
- 当前产物必须已经构建。
- 当前产物必须通过验证。
- 旧产物的验证状态不能转移给新产物。

## 例外与边界
- 旧产物已验证但当前产物未验证，不计入。
- 当前产物已构建但未部署或未验证，不计入。
- 没有构建或没有部署，不计入。

## 可观察验收
- 看板仅在当前产物已构建、已部署且已验证时标记为自主交付；其他情况均不增加计数。

## 适用范围与版本
自主性部署完成度统计。

## 证据
- [acceptance] packages/forgeloop/tests/autonomy-deployment.test.ts · L11 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-deployment.test.ts · L17 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-deployment.test.ts · L29 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-deployment.test.ts · L38 · 2026-11-10
- [acceptance] packages/forgeloop/tests/autonomy-deployment.test.ts · L7 · 2026-11-10

## 证据缺口与待澄清
- 验证通过的具体标准与验证主体未在证据中展开。
