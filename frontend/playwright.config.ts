import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// 真实浏览器用例：Playwright 自己起一个真实 `forgeloop web` 进程（先用真实记录
// 播种），因此核对的是「记录 → 服务端 → 编译产物 → DOM」整条链。
// 端口与高频测试用的不同，避免与开发中的服务互相占用。
const PORT = 8711;
const RECORDS_ROOT = ".cache/frontend-e2e/records";
const baseURL = `http://127.0.0.1:${PORT}`;
const ci = process.env.CI === "true";

// CI 额外约束（禁止 only、失败重试、单 worker）：本地不设这些键，避免
// exactOptionalPropertyTypes 下显式传 undefined。
const ciOverrides: PlaywrightTestConfig = ci
  ? { forbidOnly: true, retries: 1, workers: 1, reporter: [["list"], ["html", { open: "never" }]] }
  : { forbidOnly: false, retries: 0, reporter: [["list"]] };

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: "test-results",
  ...ciOverrides,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      `bash -c 'rm -rf .cache/frontend-e2e &&` +
      ` .venv/bin/python tests/fixtures/seed_web_e2e.py ${RECORDS_ROOT} &&` +
      ` .venv/bin/python -m forgeloop web --port ${PORT} --records-root ${RECORDS_ROOT}'`,
    url: `${baseURL}/api/progress`,
    cwd: "..",
    reuseExistingServer: !ci,
    timeout: 30_000,
  },
});
