/**
 * 浏览器入口：真实 `document` + 真实 `fetch` 调用装配函数。
 *
 * 本文件没有行为（与 EvidHist 的 `main.tsx` 同一口径），因此从覆盖率口径中排除；
 * 它在真实浏览器里的可用性由 Playwright 用例（tests/e2e）覆盖。
 *
 * 两个装配相互独立：进展视图（`bootstrap`）与会话工作区（`bootstrapPanel`）。
 * 会话只在服务端下发令牌时显示（`forgeloop web` / `forgeloop serve`），没有令牌的
 * 下显示一段说明，并把默认视图落到需求。
 */

import { mentionItems } from "./mentions.js";
import { bootstrap, bootstrapPanel } from "./page.js";
import type { ProgressDocument } from "./payload.js";

let latestProgress: ProgressDocument | undefined;

bootstrap(document, {
  onProgress: (progress) => {
    latestProgress = progress;
  },
});
bootstrapPanel(document, {
  mentionItems: () => (latestProgress === undefined ? [] : mentionItems(latestProgress)),
});
