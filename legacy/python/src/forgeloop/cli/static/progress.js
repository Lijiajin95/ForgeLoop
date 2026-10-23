/**
 * 轮询与调度（对应 Python 的 IO 边界侧：取数与节奏，不碰 DOM）。
 *
 * 刷新间隔来自服务端返回的 `refresh_seconds`（`0` 表示关闭自动刷新），页面不自己
 * 决定间隔——配置项是权威，页面只如实展示与执行。所有依赖（取数实现、时钟）都可
 * 注入，因此调度规则能在无浏览器、无网络的单元测试里被确定性地覆盖。
 */
import { countdownText } from "./format.js";
/** 倒计时刷新粒度：1 秒。 */
const TICK_MS = 1000;
/**
 * 首次读取成功前的重试节奏（秒）：与 ``domain.progress.DEFAULT_REFRESH_SECONDS``
 * 同值。配置还没读到就必须先失败一次时，页面按内建默认继续重试，而不是停摆或
 * 谎称「自动刷新已关闭」。
 */
const FALLBACK_REFRESH_SECONDS = 60;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
async function errorDetail(response) {
    try {
        const payload = await response.json();
        if (isRecord(payload) && typeof payload.detail === "string") {
            return payload.detail;
        }
    }
    catch {
        // 非 JSON 响应（网关、代理等）：按状态码报告，不伪造原因。
    }
    return `HTTP ${response.status}`;
}
/** 默认取数实现：真实 `fetch`，失败抛出带原因的 Error。 */
export async function defaultFetcher(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`读取进展失败: ${await errorDetail(response)}`);
    }
    return (await response.json());
}
/** 任何异常 → 可展示的文本。 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 进展客户端：按生效刷新间隔重复读取，并驱动倒计时文案。
 *
 * Promise 处理是显式的：`start`／`manualRefresh` 把进行中的读取记录在 `pending`
 * 上，不产生「未处理的 Promise」（ESLint `no-floating-promises` 禁止用 `void` 掩盖）。
 */
export class ProgressClient {
    #url;
    #fetcher;
    #now;
    #onDocument;
    #onError;
    #onCountdown;
    // undefined = 尚未成功读取过配置：既不是「已关闭」也不是某个具体间隔。
    #refreshSeconds;
    #nextRefreshAt = 0;
    #busy = false;
    #pending;
    constructor(options) {
        this.#url = options.url;
        this.#fetcher = options.fetcher ?? defaultFetcher;
        this.#now = options.now ?? Date.now;
        this.#onDocument = options.onDocument;
        this.#onError = options.onError;
        this.#onCountdown = options.onCountdown;
    }
    /** 生效刷新间隔（秒）；`0` 表示关闭自动刷新；`undefined` 表示尚未读到配置。 */
    get refreshSeconds() {
        return this.#refreshSeconds;
    }
    /** 自动刷新是否已按配置关闭（尚未读到配置时为 `false`）。 */
    get autoRefreshOff() {
        return this.#refreshSeconds === 0;
    }
    /** 进行中的读取；空闲时为 `undefined`（测试与调用方可等待它）。 */
    get pending() {
        return this.#pending;
    }
    /** 启动：立即读取一次，并每秒推进倒计时。 */
    start() {
        this.#pending = this.refresh();
        globalThis.setInterval(() => {
            this.tick();
        }, TICK_MS);
    }
    /** 手动刷新（「立即刷新」按钮）：与自动刷新同一路径。 */
    manualRefresh() {
        this.#pending = this.refresh();
    }
    /** 读取一次进展；错误在此处收敛为 `onError`，不向调用方抛。 */
    async refresh() {
        if (this.#busy) {
            return;
        }
        this.#busy = true;
        try {
            const document = await this.#fetcher(this.#url);
            this.#refreshSeconds = document.refresh_seconds;
            this.#onDocument(document);
        }
        catch (error) {
            this.#onError(errorMessage(error));
        }
        finally {
            this.#busy = false;
            this.#schedule();
            this.tick();
        }
    }
    /** 倒计时推进；到点即触发下一次读取。 */
    tick() {
        if (this.autoRefreshOff) {
            this.#nextRefreshAt = 0;
            this.#onCountdown(countdownText(0, true));
            return;
        }
        if (this.#nextRefreshAt === 0) {
            return;
        }
        const remaining = Math.ceil((this.#nextRefreshAt - this.#now()) / TICK_MS);
        if (remaining <= 0) {
            this.#onCountdown(countdownText(0, false));
            this.#pending = this.refresh();
            return;
        }
        this.#onCountdown(countdownText(remaining, false));
    }
    #schedule() {
        const seconds = this.#refreshSeconds ?? FALLBACK_REFRESH_SECONDS;
        this.#nextRefreshAt = seconds <= 0 ? 0 : this.#now() + seconds * TICK_MS;
    }
}
