/**
 * 浏览器入口：真实 `document` + 真实 `fetch` 调用装配函数。
 *
 * 本文件没有行为（与 EvidHist 的 `main.tsx` 同一口径），因此从覆盖率口径中排除；
 * 它在真实浏览器里的可用性由 Playwright 用例（tests/e2e）覆盖。
 *
 * 两个装配相互独立：进展视图（`bootstrap`）与右侧对话框面板（`bootstrapPanel`）。
 * 面板只在服务端下发令牌时显示（`forgeloop serve`），只读的 `forgeloop web` 下整块隐藏。
 */

import { bootstrap, bootstrapPanel } from "./page.js";

bootstrap(document);
bootstrapPanel(document);
