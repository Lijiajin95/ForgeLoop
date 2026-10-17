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
 *   render（DOM 渲染，不发请求）
 *     ↑
 *   progress（轮询与调度，只依赖类型）
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
      comment: "format.ts 是纯规则：不得依赖渲染、轮询或入口模块。",
      from: { path: "^src/format\\.ts$" },
      to: { path: "^src/(render|progress|page|app)\\.ts$" },
    },
    {
      name: "render-does-not-fetch",
      severity: "error",
      comment: "render.ts 只画 DOM：不得依赖轮询或入口模块。",
      from: { path: "^src/render\\.ts$" },
      to: { path: "^src/(progress|app)\\.ts$" },
    },
    {
      name: "progress-does-not-render",
      severity: "error",
      comment: "progress.ts 只管取数与调度：不得依赖渲染或入口模块。",
      from: { path: "^src/progress\\.ts$" },
      to: { path: "^src/(render|app)\\.ts$" },
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
