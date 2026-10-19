import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// 真实浏览器用例：Playwright 自己起一个真实 `forgeloop web` 进程（先用真实记录
// 播种），因此核对的是「记录 → 服务端 → 编译产物 → DOM」整条链。
// 端口与高频测试用的不同，避免与开发中的服务互相占用。
const PORT = 8711;
const RECORDS_ROOT = ".cache/frontend-e2e/records";
const baseURL = `http://127.0.0.1:${PORT}`;
// 页面写入口（R3）需要真实 `forgeloop serve`：注入令牌、auto_advance 打开、假 PI 执行。
const OPERATIONS_PORT = 8714;
const OPERATIONS_ROOT = ".cache/frontend-e2e-operations";
const operationsBaseURL = `http://127.0.0.1:${OPERATIONS_PORT}`;
// 对话框面板（会话/HITL/终止）需要自己的现场与端口：假 PI 用有状态的 chat-hitl-first
// （首轮请求人工决定、之后正常回复），因此状态文件与现场目录都独立。
const PANEL_PORT = 8716;
const PANEL_ROOT = ".cache/frontend-e2e-panel";
const panelBaseURL = `http://127.0.0.1:${PANEL_PORT}`;
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
  webServer: [
    {
      command:
        `bash -c 'rm -rf ${OPERATIONS_ROOT} &&` +
        ` .venv/bin/python tests/fixtures/seed_serve_operations_e2e.py ${OPERATIONS_ROOT} &&` +
        ` HOME=$PWD/${OPERATIONS_ROOT}/pi-home FAKE_PI_MODE=ok PATH=$PWD/.venv/bin:$PATH` +
        ` .venv/bin/python -m forgeloop serve --port ${OPERATIONS_PORT}` +
        ` --records-root ${OPERATIONS_ROOT}/records --service-config ${OPERATIONS_ROOT}/service.toml'`,
      url: `${operationsBaseURL}/api/service`,
      cwd: "..",
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command:
        `bash -c 'rm -rf ${PANEL_ROOT} &&` +
        ` .venv/bin/python tests/fixtures/seed_panel_e2e.py ${PANEL_ROOT} &&` +
        ` HOME=$PWD/${PANEL_ROOT}/pi-home FAKE_PI_MODE=chat-hitl-first` +
        ` FAKE_PI_STATE=$PWD/${PANEL_ROOT}/fake-pi-state.json PATH=$PWD/.venv/bin:$PATH` +
        ` .venv/bin/python -m forgeloop serve --port ${PANEL_PORT}` +
        ` --records-root ${PANEL_ROOT}/records --service-config ${PANEL_ROOT}/service.toml` +
        ` --projects-file ${PANEL_ROOT}/projects.toml'`,
      url: `${panelBaseURL}/api/panel`,
      cwd: "..",
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      command:
        `bash -c 'rm -rf .cache/frontend-e2e &&` +
        ` .venv/bin/python tests/fixtures/seed_web_e2e.py ${RECORDS_ROOT} &&` +
        ` .venv/bin/python -m forgeloop web --port ${PORT} --records-root ${RECORDS_ROOT}'`,
      url: `${baseURL}/api/progress`,
      cwd: "..",
      reuseExistingServer: !ci,
      timeout: 30_000,
    },
  ],
});
