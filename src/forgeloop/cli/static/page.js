/**
 * 页面装配：把元素句柄、渲染与轮询接起来。
 *
 * 只做接线，不含业务规则（格式化在 format.ts、渲染在 render.ts、调度在
 * progress.ts）。把 `Document` 与取数实现作为参数传入，测试就能把**真实的页面
 * HTML** 交给它，从而在快速层核对「HTML 的元素 id 与脚本一致」这条契约。
 */
import { actionRequest, forgetSubmitKey, loadSubmitKey, newClientKey, operationsAvailable, rememberSubmitKey, performOperation, readToken, submitRequest, } from "./actions.js";
import { PROGRESS_URL } from "./payload.js";
import { ProgressClient } from "./progress.js";
import { clearError, renderOperationStatus, renderOperationsAvailability, renderProgress, resolveElements, showError, } from "./render.js";
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
    wireOperations(elements, client, options.operationFetcher);
    client.start();
    return client;
}
/** 需要理由的三类人工决定：与 `cli/serve.py` 的 `reason_required` 一致。 */
const REASON_REQUIRED = ["approve", "accept", "stop"];
/** action → 按钮元素，避免在事件回调里做字符串分支。 */
function actionButton(elements, action) {
    switch (action) {
        case "approve":
            return elements.actionApprove;
        case "advance":
            return elements.actionAdvance;
        case "accept":
            return elements.actionAccept;
        default:
            return elements.actionStop;
    }
}
/** 写请求期间禁用全部按钮：避免同一决定被连点两次。 */
function setBusy(elements, busy) {
    for (const button of [
        elements.submitButton,
        elements.actionApprove,
        elements.actionAdvance,
        elements.actionAccept,
        elements.actionStop,
    ]) {
        button.disabled = busy;
    }
}
/** 发一次写请求并把结果渲染成状态行；成功后回读一次进展。 */
async function dispatchOperation(elements, client, token, request, fetcher) {
    setBusy(elements, true);
    let outcome;
    try {
        outcome = await performOperation(request, token, fetcher);
    }
    finally {
        setBusy(elements, false);
    }
    renderOperationStatus(elements, outcome.message, outcome.ok ? "info" : "error");
    if (outcome.ok) {
        // 写成功后立刻回读一次，让人工看到自己那一步的结果，而不是等下一个刷新周期。
        elements.submitText.value = "";
        client.manualRefresh();
    }
    return outcome;
}
/** 会话存储：某些环境（沙箱 iframe、隐私模式）连读取属性都会抛错，因此包一层。 */
function sessionKeyStorage() {
    try {
        return globalThis.sessionStorage;
    }
    catch {
        return undefined;
    }
}
/** 提交表单接线：项目与正文都非空才发；幂等键在一次成功之前保持不变。 */
function wireSubmit(elements, client, token, fetcher) {
    const storage = sessionKeyStorage();
    // 刷新页面后复用同一个键：服务端因此不会把「重试」当成新提交。
    let submitKey = loadSubmitKey(storage) || newClientKey();
    rememberSubmitKey(storage, submitKey);
    elements.submitForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const project = elements.submitProject.value.trim();
        const text = elements.submitText.value.trim();
        if (project.length === 0 || text.length === 0) {
            renderOperationStatus(elements, "提交需求需要项目与正文。", "error");
            return;
        }
        dispatchOperation(elements, client, token, submitRequest(project, text, elements.operationsBy.value, elements.submitReason.value, submitKey), fetcher)
            .then((outcome) => {
            // 失败/重试复用同一个键（服务端按它去重），成功后才换新键。
            if (outcome.ok) {
                submitKey = newClientKey();
                rememberSubmitKey(storage, submitKey);
                forgetSubmitKey(storage);
            }
        })
            .catch(() => undefined); // dispatchOperation 内部已把失败渲染成状态行
    });
}
/**
 * 接上操作面板：只有拿到令牌时才显示，提交与四类动作都发同一种写请求。
 *
 * 页面能做的校验只有「必填项为空就先别发」——真正的判定（绑定、幂等、理由、范围）
 * 都在服务端，页面把拒绝原因原样显示，不自己解释成别的结论。
 */
function wireOperations(elements, client, fetcher) {
    const document = elements.operations.ownerDocument;
    const token = readToken(document);
    renderOperationsAvailability(elements, operationsAvailable(token));
    if (!operationsAvailable(token)) {
        return;
    }
    wireSubmit(elements, client, token, fetcher);
    for (const action of ["approve", "advance", "accept", "stop"]) {
        actionButton(elements, action).addEventListener("click", () => {
            const reqId = elements.actionReq.value;
            const reason = elements.actionReason.value.trim();
            if (reqId.length === 0) {
                renderOperationStatus(elements, "先选择一条需求。", "error");
                return;
            }
            if (REASON_REQUIRED.includes(action) && reason.length === 0) {
                renderOperationStatus(elements, `${action} 需要填写理由。`, "error");
                return;
            }
            dispatchOperation(elements, client, token, actionRequest(reqId, action, elements.operationsBy.value, reason), fetcher).catch(() => undefined);
        });
    }
}
