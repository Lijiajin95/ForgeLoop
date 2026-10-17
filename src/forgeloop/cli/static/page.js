/**
 * 页面装配：把元素句柄、渲染与轮询接起来。
 *
 * 只做接线，不含业务规则（格式化在 format.ts、渲染在 render.ts、调度在
 * progress.ts）。把 `Document` 与取数实现作为参数传入，测试就能把**真实的页面
 * HTML** 交给它，从而在快速层核对「HTML 的元素 id 与脚本一致」这条契约。
 */
import { PROGRESS_URL } from "./payload.js";
import { ProgressClient } from "./progress.js";
import { clearError, renderProgress, resolveElements, showError } from "./render.js";
/** 解析元素、接上事件并启动轮询；返回客户端供测试等待与断言。 */
export function bootstrap(document, options = {}) {
    const elements = resolveElements(document);
    const client = new ProgressClient({
        url: PROGRESS_URL,
        onDocument: (progress) => {
            clearError(elements);
            renderProgress(elements, progress);
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
    client.start();
    return client;
}
