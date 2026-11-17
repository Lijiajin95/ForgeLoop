<!-- library
{
  "id": "rules.business-context-doc-configurable-path",
  "title": "业务背景文档位置按项目配置确定",
  "status": "confirmed",
  "topics": [
    "business-context",
    "project.config",
    "document.path"
  ],
  "summary": "业务背景文档的位置由全局或项目级配置决定，默认位于项目的产品文档路径；分析提示、分析结束写入与文档写操作拦截均使用同一路径。",
  "source": "owner-confirm:web-decision:session-3d5143a6-e5d5-41cb-9493-d5ecaf5b0ccb",
  "updatedAt": "2026-11-17"
}
-->

# 业务背景文档位置按项目配置确定

## 业务目标
让不同项目的业务背景文档各归其位，避免分析读写落到错误位置。

## 用户与角色
- 项目配置维护者
- 需求分析流程

## 触发与前提
分析业务背景，或分析结束时写入业务背景文档

## 预期行为
系统按项目级优先、全局次之的顺序确定业务背景文档位置，未配置时使用默认路径，并让提示、写入与拦截三处保持一致。

## 业务规则
- 项目级配置优先于全局配置
- 未配置时使用默认的业务背景文档路径
- 分析提示、结束写入与写操作拦截必须使用同一路径

## 例外与边界
- 配置缺失时回落到默认路径

## 可观察验收
- 配置自定义路径后，业务背景写入落在该路径
- 未配置时业务背景写入落在默认路径

## 适用范围与版本
支持项目级配置的项目，2026-11 版本

## 证据
- [acceptance] packages/forgeloop/tests/analysis-doc-writes.test.ts · L170 · 2026-11-15
- [git] 5a000a69e20290dbe87689402dad1f77d649460e · packages/forgeloop/src/config.ts, packages/forgeloop/src/runtime/execution-plan.ts · 2026-11-15

## 证据缺口与待澄清
- 默认路径的确切值需以项目配置说明为准
