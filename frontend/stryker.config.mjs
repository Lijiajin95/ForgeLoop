/**
 * Stryker 变异配置（对应 Python 的 mutmut）。
 *
 * 变异范围只取**纯规则与调度逻辑**（`format.ts`、`progress.ts`、`link.ts`——需求／
 * 任务／问题的身份关联规则，页面层级全靠它，错一条就会把对象挂到别处），与
 * `pyproject.toml` 的 `only_mutate` 只纳入核心领域规则同一口径：DOM 管线
 * （`render.ts`）的变异大多是等价变异或展示细节，噪声高、收益低，不纳入本批。
 *
 * 运行节奏与 Python 变异一致：不进白天高频路径，由夜间作业
 * `.github/workflows/mutation-nightly.yml` 在凌晨跑（03:00 Asia/Shanghai）。
 */

import thresholds from "./quality-thresholds.json" with { type: "json" };

export default {
  testRunner: "vitest",
  coverageAnalysis: "off",
  // 变异只由单元层用例判定（见 vitest.mutation.config.ts，与 mutmut 同口径）。
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  mutate: ["src/format.ts", "src/progress.ts", "src/link.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../reports/frontend-mutation.json" },
  thresholds: {
    high: thresholds.mutation.high,
    low: thresholds.mutation.low,
    break: thresholds.mutation.killedMin,
  },
  timeoutMS: 5000,
  timeoutFactor: 1.5,
  concurrency: 2,
  tempDirName: ".stryker-tmp",
  fileLogLevel: "warn",
};
