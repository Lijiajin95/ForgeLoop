/**
 * 浏览器入口：真实 `document` + 真实 `fetch` 调用装配函数。
 *
 * 本文件没有行为（与 EvidHist 的 `main.tsx` 同一口径），因此从覆盖率口径中排除；
 * 它在真实浏览器里的可用性由 Playwright 用例（tests/e2e）覆盖。
 */

import { bootstrap } from "./page.js";

bootstrap(document);
