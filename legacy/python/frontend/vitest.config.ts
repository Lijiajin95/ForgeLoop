import { defineConfig } from "vitest/config";

import thresholds from "./quality-thresholds.json" with { type: "json" };

// 前端快速层：jsdom 里的单元与组件用例（真实浏览器用例在 tests/e2e，由 Playwright 跑）。
// 覆盖阈值取自 quality-thresholds.json（与 config/quality-policy.toml 的 [frontend] 同值）。
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "tests/component/**/*.test.ts"],
    testTimeout: 5000,
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // app.ts 是入口（把真实 document 交给装配函数），本身没有行为：
      // 它在真实浏览器里的可用性由 tests/e2e 覆盖。
      exclude: ["src/app.ts"],
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "../reports/frontend-coverage",
      thresholds: { ...thresholds.coverage },
    },
  },
});
