/**
 * 会话面板客户端（对应 Python 的 IO 边界侧：取数与调度，不碰 DOM）。
 *
 * 分工与 `progress.ts` 一致：读模型来自服务端（`GET /api/panel` 与单会话详情），
 * 本模块只负责取数、轮询节奏与把写操作送到与 CLI 等价的入口；写请求经由
 * `actions.ts` 的 `performOperation`，因此令牌、同源与失败文案与其他写入口完全一致。
 *
 * 轮询规则（不给服务端加负担，也不假装实时）：
 * - 一轮执行期间追会话详情（人要看的是「这一轮什么时候结束」与「文字还在不在长」）；
 * - 有轮次在跑、有会话在排队、或详情里有 `streaming` 消息时，间隔缩短到
 *   `STREAM_POLL_MS`（流式输出要看得见增长）；空闲时回到 `POLL_MS`；
 * - 空闲时每 `PANEL_REFRESH_TICKS` 拍刷新一次面板总览（项目就绪、运行时占用、会话清单）。
 */
import { performOperation } from "./actions.js";
import { PANEL_PROJECTS_URL, PANEL_SESSIONS_URL, PANEL_URL, panelDecisionUrl, panelMessageUrl, panelProjectRemoveUrl, panelProjectUpdateUrl, panelSessionUrl, panelTerminateUrl, } from "./payload.js";
/** 一轮执行期间追详情的间隔（毫秒）。 */
const POLL_MS = 1500;
/** 有轮次在跑或正在流式输出时的间隔（毫秒）：让人看到文字在增长。 */
const STREAM_POLL_MS = 600;
/** 空闲时每几拍刷新一次面板总览（约 6 秒）。 */
const PANEL_REFRESH_TICKS = 4;
/** 操作人：本机单用户面板，写入口固定记为 owner（与页面写入口一致的口径）。 */
const OPERATOR = "owner";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
async function failureDetail(response) {
    try {
        const payload = await response.json();
        if (isRecord(payload) && typeof payload.detail === "string" && payload.detail.length > 0) {
            return payload.detail;
        }
    }
    catch {
        // 非 JSON 响应：退回状态码文本，不臆造原因。
    }
    return `HTTP ${response.status}`;
}
export class PanelClient {
    #token;
    #fetcher;
    #onDocument;
    #onSession;
    #onStatus;
    #onSelected;
    #selected = "";
    #sessions = [];
    #ticks = 0;
    #timer;
    #busy = false;
    #stopped = false;
    #pending;
    constructor(options) {
        this.#token = options.token;
        this.#fetcher = options.fetcher ?? fetch;
        this.#onDocument = options.onDocument;
        this.#onSession = options.onSession;
        this.#onStatus = options.onStatus;
        this.#onSelected = options.onSelected ?? (() => undefined);
    }
    /** 当前选中的会话身份（空串表示尚未选择）。 */
    get selectedSessionId() {
        return this.#selected;
    }
    /** 进行中的读取；空闲时为 `undefined`（测试与调用方可等待它）。 */
    get pending() {
        return this.#pending;
    }
    /** 启动：立刻读一次面板总览，然后按自适应间隔继续（在跑就快、空闲就慢）。 */
    start() {
        this.#stopped = false;
        this.#pending = this.#loop();
    }
    stop() {
        if (this.#timer !== undefined) {
            globalThis.clearTimeout(this.#timer);
            this.#timer = undefined;
        }
        this.#stopped = true;
    }
    /** 一次「读一拍 + 安排下一拍」；停止后不再安排。 */
    async #loop() {
        this.tick();
        const pending = this.#pending;
        if (pending !== undefined) {
            await pending;
        }
        if (this.#stopped) {
            return;
        }
        this.#timer = globalThis.setTimeout(() => {
            this.#loop().catch(() => undefined);
        }, this.#nextDelay());
    }
    /** 下一拍间隔：有活干就快，空闲就慢。 */
    #nextDelay() {
        return this.#busy ? STREAM_POLL_MS : POLL_MS;
    }
    /**
     * 一拍：有选中的会话就追它的详情（人正在看的东西优先），否则刷新面板总览。
     *
     * 详情每拍都读：一轮执行的结束时刻只有服务端知道，页面用「详情里的 running 变 false」
     * 作为判据，而不是猜一个等待时长。
     */
    tick() {
        this.#ticks += 1;
        if (this.#selected.length > 0) {
            this.#pending = this.refreshSelected();
            if (this.#ticks % PANEL_REFRESH_TICKS !== 0) {
                return;
            }
        }
        this.#pending = this.refreshPanel();
    }
    /** 读取面板总览；失败走状态行，不抛给调用方。 */
    async refreshPanel() {
        try {
            const response = await this.#request(PANEL_URL, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(await failureDetail(response));
            }
            const document = (await response.json());
            this.#sessions = document.sessions;
            this.#busy =
                document.runtime.running_turns > 0 ||
                    document.runtime.queued_turns > 0 ||
                    document.sessions.some((item) => item.running);
            this.#onDocument(document);
            await this.#syncSelected(document);
        }
        catch (error) {
            this.#onStatus(`读取面板失败：${String(error)}`, "error");
        }
    }
    /** 打开一个会话：读它的详情并记住选择。 */
    async openSession(sessionId) {
        this.#selected = sessionId;
        this.#onSelected(sessionId);
        await this.refreshSelected();
    }
    /** 读取当前选中会话的详情；未选择时是空操作。 */
    async refreshSelected() {
        if (this.#selected.length === 0) {
            return;
        }
        try {
            const response = await this.#request(panelSessionUrl(this.#selected), { cache: "no-store" });
            if (!response.ok) {
                throw new Error(await failureDetail(response));
            }
            const detail = (await response.json());
            this.#busy =
                detail.session.running || detail.messages.some((item) => item.state === "streaming");
            this.#onSession(detail);
        }
        catch (error) {
            this.#onStatus(`读取会话失败：${String(error)}`, "error");
        }
    }
    /** 选中的会话若已不在清单里（被删或换了现场），清掉选择，避免显示过期内容。 */
    async #syncSelected(document) {
        if (this.#selected.length === 0) {
            return;
        }
        const exists = document.sessions.some((item) => item.session_id === this.#selected);
        if (!exists) {
            this.#selected = "";
            this.#onSelected("");
            return;
        }
        await this.refreshSelected();
    }
    async #write(url, body, success) {
        const outcome = await performOperation({ url, body }, this.#token, this.#fetcher);
        this.#onStatus(outcome.ok ? `${success}：${outcome.message}` : outcome.message, outcome.ok ? "info" : "error");
        if (outcome.ok) {
            await this.refreshPanel();
        }
        return outcome;
    }
    /** 需要选中会话的写操作：没有选中就明确拒绝，不去拼一个必然被拒的 URL。 */
    async #sessionWrite(build, body, success) {
        if (this.#selected.length === 0) {
            const outcome = { ok: false, message: "先选择一个会话。" };
            this.#onStatus(outcome.message, "error");
            return outcome;
        }
        return this.#write(build(this.#selected), body, success);
    }
    /** 新建会话：成功后自动选中最新的一条（清单按更新时间倒序，新的在第一）。 */
    async createSession(project, title) {
        const outcome = await this.#write(PANEL_SESSIONS_URL, { by: OPERATOR, project, title }, "已新建会话");
        const newest = this.#sessions[0];
        if (outcome.ok && newest !== undefined) {
            await this.openSession(newest.session_id);
        }
        return outcome;
    }
    async send(text) {
        return this.#sessionWrite((sessionId) => panelMessageUrl(sessionId), { by: OPERATOR, text }, "已发送");
    }
    async terminate(reason) {
        return this.#sessionWrite((sessionId) => panelTerminateUrl(sessionId), { by: OPERATOR, reason }, "已请求终止");
    }
    async decide(decisionId, decision, reason, text = "") {
        const body = text.length > 0
            ? { by: OPERATOR, decision, reason, text }
            : { by: OPERATOR, decision, reason };
        return this.#sessionWrite((sessionId) => panelDecisionUrl(sessionId, decisionId), body, "已作出决定");
    }
    async createProject(draft) {
        return this.#write(PANEL_PROJECTS_URL, projectBody(draft), "已新增项目");
    }
    async updateProject(name, draft) {
        return this.#write(panelProjectUpdateUrl(name), projectBody(draft), "已更新项目");
    }
    async removeProject(name, reason) {
        return this.#write(panelProjectRemoveUrl(name), { by: OPERATOR, reason }, "已删除项目");
    }
    /**
     * 以**普通调用**形式取数。
     *
     * 浏览器的 `fetch` 要求接收者是 `window`；写成 `this.#fetcher(...)`（方法调用）会把
     * 面板实例当接收者，Chrome 直接抛 `TypeError: Illegal invocation`——真实浏览器用例
     * 实测发现（快速层的 jsdom 与注入替身都看不出这个问题）。
     */
    async #request(url, init) {
        const fetcher = this.#fetcher;
        return fetcher(url, init);
    }
}
/** 项目档案请求体：页面表单字段 → 服务端字段名。 */
function projectBody(draft) {
    return {
        by: OPERATOR,
        name: draft.name,
        path: draft.path,
        description: draft.description,
        pi_command: draft.piCommand,
        pi_home: draft.piHome,
    };
}
