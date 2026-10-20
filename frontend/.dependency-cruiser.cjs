/**
 * 前端模块边界（对应 Python 的 import-linter 分层契约）。
 *
 * 页面按「纯规则 → 渲染 → 轮询 → 装配」分层，与 `src/forgeloop` 的
 * domain／adapter 分层同构：
 *
 *   payload（类型与端点常量，不依赖任何本地模块）
 *     ↑
 *   format（纯格式化规则，不碰 DOM、不发请求）
 *     ↑
 *   render（三段页签的渲染，不发请求）  tabs（页签与跳转，不取数、不渲染内容）
 *     ↑
 *   panel_render（会话面板的渲染，不发请求）
 *     ↑
 *   actions（写请求构建与发送）
 *     ↑
 *   progress／panel（轮询与调度，只依赖类型与请求构建）
 *     ↑
 *   page → app（装配与入口）
 *
 * 只检查编译前的源码依赖（`tsPreCompilationDeps: false`）：仅类型导入不算运行时边，
 * 与 Python 侧「纯类型依赖另用报告观察」同一口径。
 */

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "模块之间不得出现循环依赖（对应架构契约的环检查）。",
      from: {},
      to: { circular: true },
    },
    {
      name: "payload-is-a-leaf",
      severity: "error",
      comment: "payload.ts 只放类型与端点常量，不得依赖任何本地模块。",
      from: { path: "^src/payload\\.ts$" },
      to: { path: "^src/", pathNot: "^src/payload\\.ts$" },
    },
    {
      name: "format-is-pure",
      severity: "error",
      comment: "format.ts 是纯规则：不得依赖渲染、页签、关联、轮询或入口模块。",
      from: { path: "^src/format\\.ts$" },
      to: { path: "^src/(link|render|tabs|progress|page|app)\\.ts$" },
    },
    {
      name: "link-is-pure",
      severity: "error",
      comment: "link.ts 只算身份关联：不得依赖渲染、页签、轮询或入口模块。",
      from: { path: "^src/link\\.ts$" },
      to: { path: "^src/(render|tabs|progress|page|app)\\.ts$" },
    },
    {
      name: "dom-is-a-primitive",
      severity: "error",
      comment: "dom.ts 只造元素与解析句柄：不得依赖渲染、页签、关联之外的页面模块。",
      from: { path: "^src/dom\\.ts$" },
      to: { path: "^src/(render|tabs|progress|page|app)\\.ts$" },
    },
    {
      name: "render-does-not-fetch",
      severity: "error",
      comment: "render.ts 只画 DOM：不得依赖轮询或入口模块。",
      from: { path: "^src/render\\.ts$" },
      to: { path: "^src/(progress|page|app)\\.ts$" },
    },
    {
      name: "tabs-do-not-fetch",
      severity: "error",
      comment: "tabs.ts 只管页签与跳转：不得依赖渲染内容、轮询或入口模块。",
      from: { path: "^src/tabs\\.ts$" },
      to: { path: "^src/(render|progress|page|app)\\.ts$" },
    },
    {
      name: "actions-is-a-leaf-above-payload",
      severity: "error",
      comment:
        "actions.ts 只拼写请求与发请求：不得依赖渲染、轮询、格式化或装配模块，业务判定全在服务端。",
      from: { path: "^src/actions\\.ts$" },
      to: { path: "^src/(format|render|panel|panel_render|progress|page|app)\\.ts$" },
    },
    {
      name: "panel-is-a-client",
      severity: "error",
      comment:
        "panel.ts 只取数、调度与拼写面板写请求：不得依赖渲染、格式化或装配模块（写请求复用 actions.ts）。",
      from: { path: "^src/panel\\.ts$" },
      to: { path: "^src/(format|render|panel_render|progress|page|app)\\.ts$" },
    },
    {
      name: "panel-render-does-not-fetch",
      severity: "error",
      comment: "panel_render.ts 只画 DOM：不得依赖取数与装配模块。",
      from: { path: "^src/panel_render\\.ts$" },
      to: { path: "^src/(panel|progress|page|app)\\.ts$" },
    },
    {
      name: "progress-does-not-render",
      severity: "error",
      comment: "progress.ts 只管取数与调度：不得依赖渲染、页签或入口模块。",
      from: { path: "^src/progress\\.ts$" },
      to: { path: "^src/(render|tabs|page|app)\\.ts$" },
    },
  ],
  options: {
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    includeOnly: "^src/|^tests/",
    reporterOptions: { dot: { collapsePattern: "node_modules/[^/]+" } },
  },
};
