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
import { actionRequest, forgetSubmitKey, loadSubmitKey, newClientKey, operationsAvailable, rememberSubmitKey, performOperation, readToken, reviseRequest, submitRequest, } from "./actions.js";
import { buildIndex } from "./link.js";
import { filterMentions, insertMention, mentionQuery } from "./mentions.js";
import { PanelClient } from "./panel.js";
import { PANEL_TABS, fillProjectForm, renderMentionMenu, renderPanelAvailability, renderPanelDocument, renderPanelSessionDetail, renderPanelStatus, renderPanelTab, resolvePanelElements, } from "./panel_render.js";
import { EMPTY_SELECTION, selectRecord, selectRef, } from "./records.js";
import { PROGRESS_URL, } from "./payload.js";
import { ProgressClient } from "./progress.js";
import { resolveElements } from "./dom.js";
import { clearError, renderOperationStatus, renderOperationsAvailability, renderProgress, showError, } from "./render.js";
import { focusTarget, resolveTabs, wireTabs } from "./tabs.js";
/** 打开写入口抽屉；有目标需求时顺手把动作下拉框对到它。 */
function openOperations(elements, reqId = "") {
    if (elements.operations.hidden) {
        return;
    }
    if (reqId !== "") {
        elements.actionReq.value = reqId;
    }
    elements.operationsDrawer.hidden = false;
    elements.submitProject.focus();
}
/** 关闭写入口抽屉，把焦点还给入口按钮。 */
function closeOperations(elements) {
    elements.operationsDrawer.hidden = true;
    if (!elements.operationsOpen.hidden) {
        elements.operationsOpen.focus();
    }
}
/** 抽屉开合：入口、关闭、遮罩与 Escape 都走同一对函数。 */
function wireOperationsDrawer(elements) {
    elements.operationsOpen.addEventListener("click", () => {
        openOperations(elements);
    });
    elements.operationsClose.addEventListener("click", () => {
        closeOperations(elements);
    });
    elements.operationsDrawer.addEventListener("click", (event) => {
        const target = event.target;
        if (target.dataset["operationsClose"] !== undefined) {
            closeOperations(elements);
        }
    });
    elements.operationsDrawer.ownerDocument.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !elements.operationsDrawer.hidden) {
            closeOperations(elements);
        }
    });
}
/** 解析元素、接上页签与事件并启动轮询；返回客户端供测试等待与断言。 */
export function bootstrap(document, options = {}) {
    const elements = resolveElements(document);
    const tabs = resolveTabs(document);
    const chatAvailable = operationsAvailable(readToken(document));
    let latest;
    let selection = EMPTY_SELECTION;
    const navigation = {
        goTo: (tab, refId) => {
            if (latest === undefined) {
                return;
            }
            selection = selectRef(buildIndex(latest), latest, selection, tab, refId);
            redraw(latest);
            focusTarget(tabs, tab, refId);
        },
    };
    function redraw(progress) {
        selection = renderProgress(elements, progress, navigation, selection, {
            onSelect: (tab, key) => {
                selection = selectRecord(selection, tab, key);
                redraw(progress);
            },
            onOperate: (reqId) => {
                openOperations(elements, reqId);
            },
        });
    }
    const client = new ProgressClient({
        url: PROGRESS_URL,
        onDocument: (progress) => {
            latest = progress;
            clearError(elements);
            redraw(progress);
            options.onProgress?.(progress);
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
    wireTabs(tabs, chatAvailable ? "chat" : "requirements");
    wireOperationsDrawer(elements);
    wireOperations(elements, client, options.operationFetcher);
    client.start();
    return client;
}
/**
 * 装配右侧对话框面板：元素解析、可见性、事件接线与轮询启动。
 *
 * 与 `bootstrap` 分开装配：进展视图与对话框面板互不依赖，真实入口（`app.ts`）两个都装，
 * 测试可以只装其中一个而不被另一个的取数打扰。
 *
 * 返回 `undefined` 表示当前入口不提供写权限（没有注入页面令牌），
 * 此时面板整体隐藏——页面不去发一个必然被拒的请求。
 */
export function bootstrapPanel(document, options = {}) {
    const elements = resolvePanelElements(document);
    const token = readToken(document);
    const available = operationsAvailable(token);
    renderPanelAvailability(elements, available);
    if (!available) {
        return undefined;
    }
    let latest;
    const client = new PanelClient({
        token,
        ...(options.operationFetcher === undefined ? {} : { fetcher: options.operationFetcher }),
        onDocument: (panelDocument) => {
            latest = panelDocument;
            renderPanelDocument(elements, panelDocument, client.selectedSessionId);
            // 会话优先：第一次拿到清单时自动打开最近一条，页面打开就是可读的对话。
            if (client.selectedSessionId === "") {
                const first = panelDocument.sessions[0];
                if (first !== undefined) {
                    client.openSession(first.session_id).catch(() => undefined);
                }
            }
        },
        onSession: (detail) => {
            renderPanelSessionDetail(elements, detail);
        },
        onStatus: (message, tone) => {
            renderPanelStatus(elements, message, tone);
        },
        onSelected: (sessionId) => {
            if (sessionId === "") {
                renderPanelSessionDetail(elements, undefined);
            }
            if (latest !== undefined) {
                renderPanelDocument(elements, latest, sessionId);
            }
        },
    });
    wirePanel(elements, client, () => latest, options.mentionItems ?? (() => []));
    client.start();
    return client;
}
/** 面板状态提示：本地校验失败（缺理由、命令不是 JSON 数组）也走同一行。 */
function panelNotice(elements, message) {
    renderPanelStatus(elements, message, "error");
}
/** 页签按钮接线：点击切换视图（按钮与页签一一对应，取不到就忽略）。 */
function wirePanelTabs(elements) {
    elements.tabs.forEach((button, index) => {
        const tab = PANEL_TABS[index];
        button.addEventListener("click", () => {
            if (tab !== undefined) {
                renderPanelTab(elements, tab);
            }
        });
    });
}
/** 新建会话：先校验必填，再调用写入口。 */
function wireNewSession(elements, client) {
    elements.newSessionButton.addEventListener("click", () => {
        elements.newSessionForm.hidden = false;
        elements.sessionTitle.focus();
    });
    elements.cancelSessionButton.addEventListener("click", () => {
        elements.newSessionForm.hidden = true;
    });
    elements.createSessionButton.addEventListener("click", () => {
        const project = elements.projectSelect.value;
        const title = elements.sessionTitle.value.trim();
        if (project === "" || title === "") {
            panelNotice(elements, "新建会话需要项目与标题。");
            return;
        }
        client
            .createSession(project, title)
            .then((outcome) => {
            if (outcome.ok) {
                elements.sessionTitle.value = "";
                elements.newSessionForm.hidden = true;
            }
        })
            .catch(() => undefined); // 失败已渲染成状态行
    });
}
/** 发送与终止：都要求选中会话；终止还要求理由（理由会写进记录）。 */
function wireComposer(elements, client) {
    elements.composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = elements.messageText.value.trim();
        if (text === "") {
            panelNotice(elements, "消息内容不能为空。");
            return;
        }
        client
            .send(text)
            .then((outcome) => {
            if (outcome.ok) {
                elements.messageText.value = "";
            }
        })
            .catch(() => undefined);
    });
    elements.terminateButton.addEventListener("click", () => {
        const reason = elements.reason.value.trim();
        if (reason === "") {
            panelNotice(elements, "终止会话必须填写理由。");
            return;
        }
        client.terminate(reason).catch(() => undefined);
    });
}
/**
 * `@` 引用的交互：从进展快照取候选，在光标处插入。
 *
 * 菜单只在输入框有引用查询时出现；方向键移动，Enter/Tab 选中，Escape 收起。
 * 插入的是记录身份本身，不改变消息的服务端语义。
 */
function wireMentions(elements, source) {
    let items = [];
    let active = 0;
    let current = null;
    const close = () => {
        current = null;
        items = [];
        active = 0;
        elements.mentionMenu.hidden = true;
        elements.mentionMenu.replaceChildren();
        elements.messageText.setAttribute("aria-expanded", "false");
        elements.messageText.removeAttribute("aria-activedescendant");
    };
    const choose = (index) => {
        const item = items[index];
        if (item === undefined || current === null) {
            return;
        }
        const inserted = insertMention(elements.messageText.value, current, item);
        elements.messageText.value = inserted.value;
        elements.messageText.setSelectionRange(inserted.caret, inserted.caret);
        close();
        elements.messageText.focus();
    };
    const refresh = () => {
        const query = mentionQuery(elements.messageText.value, elements.messageText.selectionStart);
        if (query === null) {
            close();
            return;
        }
        const matches = filterMentions(source(), query.query);
        if (matches.length === 0) {
            close();
            return;
        }
        current = query;
        items = matches;
        active = 0;
        renderMentionMenu(elements, items, active);
    };
    elements.messageText.addEventListener("input", refresh);
    elements.messageText.addEventListener("click", refresh);
    elements.messageText.addEventListener("keydown", (event) => {
        if (current === null) {
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            active = (active + step + items.length) % items.length;
            renderMentionMenu(elements, items, active);
            return;
        }
        if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
            event.preventDefault();
            choose(active);
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
    });
    elements.mentionMenu.addEventListener("mousedown", (event) => {
        event.preventDefault();
    });
    elements.mentionMenu.addEventListener("click", (event) => {
        const button = event.target.closest("[data-mention-index]");
        const raw = button?.dataset["mentionIndex"];
        if (raw === undefined) {
            return;
        }
        const index = Number(raw);
        if (Number.isInteger(index)) {
            choose(index);
        }
    });
    elements.composer.addEventListener("submit", close);
}
/** 待人工决定：按钮带 data-decision／data-choice，理由与补充指令取表单输入。 */
function wireDecisions(elements, client) {
    elements.decisions.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        const decisionId = button?.dataset["decision"] ?? "";
        const choice = button?.dataset["choice"] ?? "";
        if (decisionId === "" || (choice !== "approve" && choice !== "reject")) {
            return;
        }
        const reason = elements.reason.value.trim();
        if (reason === "") {
            panelNotice(elements, "作出人工决定必须填写理由。");
            return;
        }
        client
            .decide(decisionId, choice, reason, elements.decisionText.value.trim())
            .then((outcome) => {
            if (outcome.ok) {
                elements.decisionText.value = "";
            }
        })
            .catch(() => undefined);
    });
}
/** 把表单里的 PI 命令解析成 argv 数组；不合法就明确报错，不猜怎么拆词。 */
function parseCommand(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        return undefined;
    }
    const items = [];
    for (const item of parsed) {
        if (typeof item !== "string") {
            return undefined;
        }
        items.push(item);
    }
    return items;
}
/** 从表单读出一份项目草稿；必填缺失或命令不是 argv 数组时返回 `undefined`。 */
function readProjectDraft(elements) {
    const command = parseCommand(elements.projectCommand.value.trim());
    const draft = {
        name: elements.projectName.value.trim(),
        path: elements.projectPath.value.trim(),
        description: elements.projectDescription.value.trim(),
        piCommand: command ?? [],
        piHome: elements.projectHome.value.trim(),
    };
    if (draft.name === "" || draft.path === "" || draft.piHome === "" || command === undefined) {
        return undefined;
    }
    return draft;
}
/** 项目表单：新增或保存修改（编辑目标记在提交按钮的 dataset 上）。 */
function wireProjectForm(elements, client) {
    elements.projectReset.addEventListener("click", () => {
        fillProjectForm(elements, undefined);
    });
    elements.projectForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const draft = readProjectDraft(elements);
        if (draft === undefined) {
            panelNotice(elements, '项目名、路径、隔离 HOME 必填；PI 命令必须是 JSON 字符串数组（例如 ["pi","--mode","rpc"]）。');
            return;
        }
        const editing = elements.projectSubmit.dataset["editing"] ?? "";
        const action = editing === "" ? client.createProject(draft) : client.updateProject(editing, draft);
        action
            .then((outcome) => {
            if (outcome.ok) {
                fillProjectForm(elements, undefined);
            }
        })
            .catch(() => undefined);
    });
}
/** 项目表：行内「编辑」回填表单，「删除」要求理由（进行中会话会被服务端拒绝）。 */
function wireProjectRows(elements, client, latestDocument) {
    const editProject = (name) => {
        const project = latestDocument()?.projects.find((item) => item.name === name);
        if (project !== undefined) {
            fillProjectForm(elements, project);
        }
    };
    const removeProject = (name) => {
        const reason = elements.reason.value.trim();
        if (reason === "") {
            panelNotice(elements, "删除项目必须填写理由（写在表单的「理由」输入框）。");
            return;
        }
        client.removeProject(name, reason).catch(() => undefined);
    };
    elements.projectsBody.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        const name = button?.dataset["project"] ?? "";
        const action = button?.dataset["action"] ?? "";
        if (name === "") {
            return;
        }
        if (action === "edit") {
            editProject(name);
            return;
        }
        if (action === "remove") {
            removeProject(name);
        }
    });
}
/** 面板事件总装：页签、会话选择与刷新、新建会话、发送/终止、决定、项目增删改。 */
function wirePanel(elements, client, latestDocument, mentionSource) {
    wirePanelTabs(elements);
    wireNewSession(elements, client);
    wireComposer(elements, client);
    wireMentions(elements, mentionSource);
    wireDecisions(elements, client);
    wireProjectForm(elements, client);
    wireProjectRows(elements, client, latestDocument);
    elements.refreshButton.addEventListener("click", () => {
        client.refreshPanel().catch(() => undefined);
    });
    elements.sessionList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-session-id]");
        const sessionId = button?.dataset["sessionId"] ?? "";
        if (sessionId !== "") {
            client.openSession(sessionId).catch(() => undefined);
        }
    });
}
/** 需要理由的三类人工决定：与 `cli/serve.py` 的 `reason_required` 一致。 */
const REASON_REQUIRED = ["approve", "accept", "stop", "cancel"];
/** action → 按钮元素，避免在事件回调里做字符串分支。 */
function actionButton(elements, action) {
    switch (action) {
        case "approve":
            return elements.actionApprove;
        case "advance":
            return elements.actionAdvance;
        case "analyze":
            return elements.actionAnalyze;
        case "plan":
            return elements.actionPlan;
        case "accept":
            return elements.actionAccept;
        case "cancel":
            return elements.actionCancel;
        case "revise":
            return elements.actionRevise;
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
        elements.actionCancel,
        elements.actionAnalyze,
        elements.actionPlan,
        elements.actionRevise,
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
    for (const action of [
        "approve",
        "advance",
        "analyze",
        "plan",
        "accept",
        "stop",
        "cancel",
    ]) {
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
    elements.actionRevise.addEventListener("click", () => {
        const reqId = elements.actionReq.value;
        const text = elements.reviseText.value.trim();
        if (reqId.length === 0) {
            renderOperationStatus(elements, "先选择一条需求。", "error");
            return;
        }
        if (text.length === 0) {
            renderOperationStatus(elements, "修订正文不能为空。", "error");
            return;
        }
        dispatchOperation(elements, client, token, reviseRequest(reqId, text, elements.operationsBy.value, elements.actionReason.value), fetcher)
            .then((outcome) => {
            if (outcome.ok) {
                elements.reviseText.value = "";
            }
        })
            .catch(() => undefined);
    });
}
