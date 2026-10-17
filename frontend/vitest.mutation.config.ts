import { defineConfig } from "vitest/config";

// 变异测试专用的 Vitest 配置：只跑**单元层**用例（纯规则与调度），不跑需要读取
// 页面 HTML 的组件用例——与 Python 侧 mutmut 的 `pytest_add_cli_args_test_selection =
// ["tests/unit/", "tests/property/"]` 同一口径：变异由稳定的单元测试判定，避免把
// 沙箱内不可达的夹具（页面 HTML 在 frontend/ 之外）算成「测试失败」。
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 5000,
    passWithNoTests: false,
  },
});
