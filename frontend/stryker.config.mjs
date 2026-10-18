/**
 * Stryker 变异配置（对应 Python 的 mutmut）。
 *
 * 变异范围取**纯规则、调度与请求构建逻辑**（`format.ts`、`progress.ts`、`actions.ts`），与
 * `pyproject.toml` 的 `only_mutate` 只纳入核心领域规则同一口径：DOM 管线
 * （`render.ts`）的变异大多是等价变异或展示细节，噪声高、收益低，不纳入本批。
 *
 * `actions.ts`（R3 页面写入口的请求构建与结果解读）2026-10-18 纳入：实跑 122 个变异体得
 * 90.16%（全量 93.45%，break 阈值 90），幸存者逐项登记在 `config/quality-policy.toml`
 * 的 `[[frontend.reviewed_survivors]]`（与 `progress.ts` 同一判定流程）。
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
  mutate: ["src/format.ts", "src/progress.ts", "src/actions.ts"],
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
