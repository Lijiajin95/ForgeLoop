/**
 * 页面写入口（R3）：读令牌、拼请求、发请求、把结果说清楚。
 *
 * 分层位置：与 `progress.ts` 同层（取数与调度，不渲染），只依赖 `payload.ts` 的类型
 * 与端点常量。**不含任何业务判定**：批准绑定、幂等、槽位互斥、理由校验都在服务端与
 * 领域层，页面只负责把人工输入原样送到与 CLI 相同的入口，并把拒绝原因显示出来。
 *
 * 三道服务端闸门（令牌、同源、请求体）里，页面能负责的只有令牌：没有注入令牌时
 * 整个操作面板保持隐藏（`forgeloop web` 与 `forgeloop serve` 都会注入）。
 */
import { REQUIREMENTS_URL, SUBMIT_KEY_STORAGE, TOKEN_HEADER, TOKEN_META_NAME, TOKEN_PLACEHOLDER, requirementActionUrl, } from "./payload.js";
/** 读取页面令牌；未注入或仍是占位时返回空串。 */
export function readToken(document) {
    const meta = document.querySelector(`meta[name="${TOKEN_META_NAME}"]`);
    const value = meta?.getAttribute("content")?.trim() ?? "";
    return value === TOKEN_PLACEHOLDER ? "" : value;
}
/** 是否具备写入口（令牌已注入）。 */
export function operationsAvailable(token) {
    return token.length > 0;
}
/**
 * 客户端幂等键：优先用 Web Crypto 的 UUID，环境没有时退回时间戳 + 随机串。
 *
 * 它不是业务状态，只是「同一次提交重试」的身份：服务端按它去重，因此网络抖动导致
 * 的重复点击不会建出两条需求。
 */
export function newClientKey() {
    const source = globalThis.crypto;
    if (source && typeof source.randomUUID === "function") {
        return source.randomUUID();
    }
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/** 读取暂存的提交键；存储不可用（隐私模式、沙箱 iframe）时按「没有」处理。 */
export function loadSubmitKey(storage) {
    try {
        return storage?.getItem(SUBMIT_KEY_STORAGE)?.trim() ?? "";
    }
    catch {
        return "";
    }
}
/** 暂存提交键：失败不抛错——退化为「只在内存里保持」，不影响提交本身。 */
export function rememberSubmitKey(storage, key) {
    try {
        storage?.setItem(SUBMIT_KEY_STORAGE, key);
    }
    catch {
        // 存储不可用：本次会话内仍由内存变量保证重试复用同一个键。
    }
}
/** 提交成功后清掉暂存的键：下一次提交是一次新的意图，应当用新键。 */
export function forgetSubmitKey(storage) {
    try {
        storage?.removeItem(SUBMIT_KEY_STORAGE);
    }
    catch {
        // 同上：清理失败不影响业务。
    }
}
/** 提交需求：正文与项目必填；`key` 给出时服务端按它幂等去重。 */
export function submitRequest(project, text, by, note, key = "") {
    const body = {
        by: by.trim(),
        project: project.trim(),
        text: text.trim(),
        reason: note.trim(),
    };
    const trimmedKey = key.trim();
    return trimmedKey.length > 0
        ? { url: REQUIREMENTS_URL, body: { ...body, key: trimmedKey } }
        : { url: REQUIREMENTS_URL, body };
}
/** 单需求动作：批准/验收/停止/取消带理由；推进/分析/规划可不带。 */
export function actionRequest(reqId, action, by, reason) {
    return {
        url: requirementActionUrl(reqId, action),
        body: { by: by.trim(), reason: reason.trim() },
    };
}
/** 修订需求：追加一个版本（历史原文保留），正文必填。 */
export function reviseRequest(reqId, text, by, note) {
    return {
        url: requirementActionUrl(reqId, "revise"),
        body: { by: by.trim(), reason: note.trim(), text: text.trim() },
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
async function failureDetail(response) {
    try {
        const payload = await response.json();
        if (isRecord(payload)) {
            const detail = payload.detail;
            if (typeof detail === "string" && detail.length > 0) {
                return detail;
            }
            const code = payload.error;
            if (typeof code === "string" && code.length > 0) {
                return code;
            }
        }
    }
    catch {
        // 非 JSON 响应：退回状态码文本，不臆造原因。
    }
    return `HTTP ${response.status}`;
}
/**
 * 成功信息：优先用服务端返回的 `output`（CLI 入口自己的话，例如「任务包 v1 已批准…」），
 * 没有 `output` 时才是提交类的「已受理：<需求身份>」。
 *
 * 顺序不能反：批准/验收/停止的响应同样带 `req_id`，先看它会把这些结果显示成「已受理」——
 * 2026-10-18 的真实浏览器用例就是这样发现并钉住这条规则（记录已批准、页面却说已受理）。
 */
function successMessage(payload) {
    if (typeof payload.output === "string" && payload.output.length > 0) {
        return payload.output;
    }
    if (payload.queued === true && typeof payload.req_id === "string" && payload.req_id.length > 0) {
        // 推进/分析/规划都是受理而不是完成：说清「已经排队、由心跳执行」，不谎称做完。
        const label = payload.operation === "analyze" ? "分析" : payload.operation === "plan" ? "规划" : "推进";
        return `已受理${label}：${payload.req_id}（常驻进程将在下一次心跳执行）`;
    }
    if (typeof payload.req_id === "string" && payload.req_id.length > 0) {
        return `已受理：${payload.req_id}`;
    }
    // 面板写端点用 `detail` 报人读结果（例如「已受理，一轮执行在常驻进程内进行」）。
    return payload.detail !== undefined && payload.detail !== "" ? payload.detail : "操作已完成。";
}
/**
 * 发送一次写请求：带令牌与同源（浏览器自动带 Origin），返回可展示结果。
 *
 * 网络失败与 HTTP 失败都返回 `ok: false` 并给出原因——页面绝不把失败显示成成功。
 */
export async function performOperation(request, token, fetcher = fetch) {
    let response;
    try {
        response = await fetcher(request.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
            body: JSON.stringify(request.body),
        });
    }
    catch (error) {
        return { ok: false, message: `请求失败：${String(error)}` };
    }
    if (!response.ok) {
        return { ok: false, message: await failureDetail(response) };
    }
    const payload = await response.json().catch(() => ({}));
    return { ok: true, message: successMessage(isRecord(payload) ? payload : {}) };
}
