/**
 * 页面装配：把元素句柄、页签、渲染与轮询接起来。
 *
 * 只做接线，不含业务规则（格式化在 format.ts、身份关联在 link.ts、渲染在
 * render.ts、页签与跳转在 tabs.ts、调度在 progress.ts）。把 `Document` 与取数实现
 * 作为参数传入，测试就能把**真实的页面 HTML** 交给它，从而在快速层核对
 * 「HTML 的元素 id 与脚本一致」这条契约。
 *
 * 跨段跳转也在这里合拢：渲染层只声明「去哪一段的哪个对象」，实际切换与高亮由
 * `tabs.ts` 落到 DOM 上；自动刷新重绘内容不会重置当前页签。
 */

import { PROGRESS_URL } from "./payload.js";
import { ProgressClient, type ProgressFetcher } from "./progress.js";
import { createCollapseState, resolveElements } from "./dom.js";
import { clearError, renderProgress, showError } from "./render.js";
import { focusTarget, resolveTabs, wireTabs } from "./tabs.js";

/** 装配依赖：默认用真实 fetch 与真实时钟，测试可注入。 */
export interface BootstrapOptions {
  readonly fetcher?: ProgressFetcher;
  readonly now?: () => number;
}

/** 解析元素、接上页签与事件并启动轮询；返回客户端供测试等待与断言。 */
export function bootstrap(document: Document, options: BootstrapOptions = {}): ProgressClient {
  const elements = resolveElements(document);
  const tabs = resolveTabs(document);
  // 折叠状态随装配建立一次：自动刷新重绘内容不会把用户的展开／收起选择抹掉。
  const collapse = createCollapseState();
  const client = new ProgressClient({
    url: PROGRESS_URL,
    onDocument: (progress) => {
      clearError(elements);
      renderProgress(
        elements,
        progress,
        {
          goTo: (tab, refId) => {
            focusTarget(tabs, tab, refId);
          },
        },
        collapse,
      );
    },
    onError: (message) => {
      showError(elements, message);
    },
    onCountdown: (message) => {
      elements.countdown.textContent = message;
    },
    ...options,
  });
  elements.refreshButton.addEventListener("click", () => {
    client.manualRefresh();
  });
  wireTabs(tabs);
  client.start();
  return client;
}
