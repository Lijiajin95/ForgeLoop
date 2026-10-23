/**
 * 会话面板渲染层（只把数据写进界面，不发请求、不调度）。
 *
 * 安全约束与 `render.ts` 相同：所有来自记录的内容一律走 `textContent`，绝不拼接 HTML
 * ——会话标题、Agent 回复、项目路径与阻断原因都是人或模型产出的文本。ESLint 的
 * `no-restricted-syntax` 同时禁用了 `innerHTML`/`insertAdjacentHTML`。
 *
 * 元素 id 与 `web_page.html` 一一对应，缺一个就明确失败（与 `render.ts` 同一口径）。
 */
import { EMPTY, formatTimestamp, text } from "./format.js";
import { mentionKindLabel } from "./mentions.js";
import { renderToolCalls } from "./panel_tools.js";
const ELEMENT_IDS = {
    panel: "panel",
    sessionsView: "panel-sessions-view",
    runtimeView: "panel-runtime-view",
    projectsView: "panel-projects-view",
    status: "panel-status",
    sessionList: "panel-session-list",
    sessionEmpty: "panel-session-empty",
    sessionMeta: "panel-session-meta",
    messages: "panel-messages",
    toolCalls: "panel-tools",
    toolsMeta: "panel-tools-meta",
    decisions: "panel-decisions",
    decisionText: "panel-decision-text",
    reason: "panel-reason",
    composer: "panel-composer",
    messageText: "panel-message-text",
    emptyHint: "panel-empty",
    mentionMenu: "mention-menu",
    chatUnavailable: "chat-unavailable",
    newSessionButton: "panel-new-session",
    newSessionForm: "panel-new-session-form",
    projectSelect: "panel-project-select",
    sessionTitle: "panel-session-title",
    createSessionButton: "panel-create-session",
    cancelSessionButton: "panel-cancel-session",
    terminateButton: "panel-terminate",
    refreshButton: "panel-refresh",
    runtimeSummary: "panel-runtime-summary",
    runtimeBody: "panel-runtime-body",
    runtimeEmpty: "panel-runtime-empty",
    projectsBody: "panel-projects-body",
    projectsEmpty: "panel-projects-empty",
    projectForm: "panel-project-form",
    projectName: "panel-project-name",
    projectPath: "panel-project-path",
    projectDescription: "panel-project-description",
    projectCommand: "panel-project-command",
    projectHome: "panel-project-home",
    projectSubmit: "panel-project-submit",
    projectReset: "panel-project-reset",
    projectSource: "panel-project-source",
};
/** 面板页签：会话 / 运行时 / 项目。 */
export const PANEL_TABS = ["sessions", "runtime", "projects"];
const TAB_BUTTON_IDS = {
    sessions: "panel-tab-sessions",
    runtime: "panel-tab-runtime",
    projects: "panel-tab-projects",
};
/** 会话状态 → 中文标签；未知状态原样显示，不猜测。 */
const SESSION_STATUS_LABELS = {
    active: "可对话",
    awaiting_human: "等待人工决定",
    terminated: "已终止",
};
/** 消息角色 → 中文标签。 */
const ROLE_LABELS = {
    human: "人工",
    agent: "Agent",
    system: "系统",
};
/** 决定种类 → 中文标签；未知种类原样显示。 */
const DECISION_KIND_LABELS = {
    agent_request: "Agent 请求人工决定",
    turn_failed: "这一轮未取得结果",
};
/** 决定状态 → 中文标签。 */
const DECISION_STATUS_LABELS = {
    pending: "待决定",
    approved: "已批准",
    rejected: "已拒绝",
};
/** 会话状态的可读文案。 */
export function sessionStatusLabel(status) {
    return SESSION_STATUS_LABELS[status] ?? text(status);
}
/** 决定种类的可读文案。 */
export function decisionKindLabel(kind) {
    return DECISION_KIND_LABELS[kind] ?? text(kind);
}
/** 项目来源的可读文案。 */
export function projectSourceLabel(source) {
    return source === "service" ? "手写配置（只读）" : "页面管理";
}
function requireElement(document, id) {
    const element = document.getElementById(id);
    if (element === null) {
        // 静默失败是最糟的结果：面板会永远空白且看不出原因。
        throw new Error(`页面缺少元素 #${id}；HTML 与脚本版本不一致`);
    }
    return element;
}
/** 解析面板元素句柄；任一缺失即抛错（不返回半初始化的句柄）。 */
export function resolvePanelElements(document) {
    const elements = {};
    for (const key of Object.keys(ELEMENT_IDS)) {
        elements[key] = requireElement(document, ELEMENT_IDS[key]);
    }
    return {
        ...elements,
        tabs: PANEL_TABS.map((tab) => requireElement(document, TAB_BUTTON_IDS[tab])),
    };
}
/** 切换页签：只显示当前视图，按钮状态与之一致（可访问性用 aria-pressed）。 */
export function renderPanelTab(elements, tab) {
    const views = {
        sessions: elements.sessionsView,
        runtime: elements.runtimeView,
        projects: elements.projectsView,
    };
    for (const name of PANEL_TABS) {
        views[name].hidden = name !== tab;
    }
    elements.tabs.forEach((button, index) => {
        button.setAttribute("aria-pressed", PANEL_TABS[index] === tab ? "true" : "false");
    });
}
/** 面板整体可见性：只有拿到令牌（`forgeloop web` / `forgeloop serve`）时才显示。 */
export function renderPanelAvailability(elements, available) {
    elements.panel.hidden = !available;
    elements.chatUnavailable.hidden = available;
}
/** 状态行：成功用普通色，失败用醒目色。 */
export function renderPanelStatus(elements, message, tone) {
    elements.status.textContent = message;
    elements.status.dataset["tone"] = tone;
}
function cell(row, value) {
    const td = row.ownerDocument.createElement("td");
    td.textContent = value;
    row.appendChild(td);
}
function tableRow(document, values) {
    const tr = document.createElement("tr");
    values.forEach((value) => {
        cell(tr, value);
    });
    return tr;
}
function fill(body, empty, rows) {
    body.replaceChildren(...rows);
    empty.style.display = rows.length === 0 ? "block" : "none";
}
/** 会话清单：会话身份挂在按钮上，选中态用 `aria-selected` 与样式共同表达。 */
function renderPanelSessions(elements, sessions, selected) {
    const document = elements.sessionList.ownerDocument;
    const items = sessions.map((session) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-item";
        button.dataset["sessionId"] = session.session_id;
        if (session.session_id === selected) {
            button.classList.add("is-selected");
            button.setAttribute("aria-current", "true");
        }
        const dot = document.createElement("span");
        dot.className = "session-dot";
        dot.dataset["status"] = session.status;
        const copy = document.createElement("span");
        copy.className = "session-copy";
        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = text(session.title);
        const meta = document.createElement("span");
        meta.className = "session-meta";
        meta.textContent = `${sessionStatusLabel(session.status)} · ${session.turn_count} 轮`;
        copy.append(title, meta);
        button.append(dot, copy);
        return button;
    });
    elements.sessionList.replaceChildren(...items);
    elements.sessionEmpty.hidden = sessions.length > 0;
}
/** `@` 引用菜单：候选项带种类、身份与一句说明；活动项只做视觉高亮。 */
export function renderMentionMenu(elements, items, active) {
    const document = elements.mentionMenu.ownerDocument;
    const buttons = items.map((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mention-item";
        button.id = `mention-option-${index}`;
        button.dataset["mentionIndex"] = String(index);
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === active));
        if (index === active) {
            button.classList.add("is-active");
        }
        const kind = document.createElement("span");
        kind.className = "mention-kind";
        kind.textContent = mentionKindLabel(item.kind);
        const copy = document.createElement("span");
        copy.className = "mention-copy";
        const title = document.createElement("span");
        title.className = "mention-title mono";
        title.textContent = item.title;
        const detail = document.createElement("span");
        detail.className = "mention-detail";
        detail.textContent = item.detail;
        copy.append(title, detail);
        button.append(kind, copy);
        return button;
    });
    elements.mentionMenu.replaceChildren(...buttons);
    elements.mentionMenu.hidden = buttons.length === 0;
    elements.messageText.setAttribute("aria-expanded", String(buttons.length > 0));
    if (buttons.length === 0) {
        elements.messageText.removeAttribute("aria-activedescendant");
    }
    else {
        elements.messageText.setAttribute("aria-activedescendant", `mention-option-${active}`);
    }
}
/** 项目下拉框（新建会话用）：只列运行时已就绪的项目。 */
function renderPanelProjectOptions(elements, projects) {
    const previous = elements.projectSelect.value;
    elements.projectSelect.replaceChildren();
    for (const project of projects.filter((item) => item.runtime.ready)) {
        const option = elements.projectSelect.ownerDocument.createElement("option");
        option.value = project.name;
        option.textContent =
            project.description === "" ? project.name : `${project.name}（${project.description}）`;
        elements.projectSelect.append(option);
    }
    const names = [...elements.projectSelect.options].map((option) => option.value);
    elements.projectSelect.value = names.includes(previous) ? previous : (names[0] ?? "");
    elements.newSessionButton.disabled = names.length === 0;
}
/** 运行时视图：每个项目一行就绪情况 + 全局占用摘要。 */
function renderPanelRuntime(elements, runtime, projects) {
    const document = elements.runtimeBody.ownerDocument;
    const rows = projects.map((project) => tableRow(document, [
        project.name,
        project.runtime.ready ? "就绪" : "未就绪",
        project.runtime.ready ? EMPTY : project.problems.join("；"),
        project.runtime.pi_command.join(" "),
        project.runtime.pi_home,
        String(project.runtime.running_turns),
    ]));
    fill(elements.runtimeBody, elements.runtimeEmpty, rows);
    elements.runtimeSummary.textContent =
        `并发上限 ${runtime.concurrency} 轮 · 进行中 ${runtime.running_turns} 轮 · ` +
            `排队 ${runtime.queued_turns} 轮 · 单轮超时 ${runtime.turn_timeout_seconds} 秒 · ` +
            `常驻会话 ${runtime.live_sessions} · 工具审批 ${runtime.tool_approval}`;
}
/** 项目视图：档案来源、仓库身份与就绪问题；可编辑的行带操作按钮。 */
function renderPanelProjects(elements, projects) {
    const document = elements.projectsBody.ownerDocument;
    const rows = projects.map((project) => {
        const tr = tableRow(document, [
            project.name,
            projectSourceLabel(project.source),
            project.path,
            project.is_git_repo ? "是" : "否",
            project.runtime.ready ? EMPTY : project.problems.join("；"),
            String(project.live_sessions),
        ]);
        const actions = document.createElement("td");
        if (project.editable) {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.textContent = "编辑";
            edit.dataset["project"] = project.name;
            edit.dataset["action"] = "edit";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "删除";
            remove.dataset["project"] = project.name;
            remove.dataset["action"] = "remove";
            actions.append(edit, remove);
        }
        else {
            actions.textContent = "改 config/service.toml";
        }
        tr.appendChild(actions);
        return tr;
    });
    fill(elements.projectsBody, elements.projectsEmpty, rows);
}
function messageNode(elements, message) {
    const item = elements.messages.ownerDocument.createElement("li");
    const streaming = message.state === "streaming";
    item.className =
        `msg msg-${message.role}` +
            (message.state === "error" ? " msg-error" : "") +
            (streaming ? " msg-streaming" : "");
    const document = elements.messages.ownerDocument;
    const rail = document.createElement("span");
    rail.className = "msg-rail";
    const role = document.createElement("span");
    role.className = "msg-role";
    role.textContent = ROLE_LABELS[message.role] ?? text(message.role);
    const time = document.createElement("time");
    time.className = "msg-time";
    time.textContent = formatTimestamp(message.created_at);
    rail.append(role, time);
    const body = document.createElement("div");
    body.className = "msg-body";
    const meta = document.createElement("span");
    meta.className = "msg-head";
    meta.textContent = (streaming ? "正在生成" : "") + contextModeNote(message);
    const paragraph = document.createElement("p");
    paragraph.textContent = message.content;
    body.append(meta, paragraph);
    item.append(rail, body);
    return item;
}
/**
 * 人工消息的上下文来源备注：冷启动回放了历史、暖进程续接，还是未记录。
 *
 * 只对人工消息显示——它是「这一轮的上下文从哪来」的现场事实，不是业务状态。
 */
function contextModeNote(message) {
    if (message.role !== "human") {
        return "";
    }
    if (message.context_mode === "cold") {
        return " · 冷启动（回放历史）";
    }
    if (message.context_mode === "warm") {
        return " · 续接常驻会话";
    }
    return "";
}
function decisionNode(elements, decision) {
    const item = elements.messages.ownerDocument.createElement("div");
    item.className = "decision";
    const head = elements.messages.ownerDocument.createElement("p");
    head.className = "meta";
    head.textContent = `${decisionKindLabel(decision.kind)} · ${DECISION_STATUS_LABELS[decision.status] ?? text(decision.status)}`;
    const question = elements.messages.ownerDocument.createElement("p");
    question.textContent = decision.question;
    item.append(head, question);
    if (decision.status === "pending") {
        for (const [choice, label] of [
            ["approve", "批准并继续"],
            ["reject", "拒绝并终止"],
        ]) {
            const button = elements.messages.ownerDocument.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.dataset["decision"] = decision.decision_id;
            button.dataset["choice"] = choice;
            item.appendChild(button);
        }
    }
    else {
        const decided = elements.messages.ownerDocument.createElement("p");
        decided.className = "meta";
        decided.textContent = `${decision.decided_by === "" ? EMPTY : decision.decided_by}：${decision.reason === "" ? EMPTY : decision.reason}`;
        item.appendChild(decided);
    }
    return item;
}
/** 会话详情：标题栏、消息流水与待人工决定。 */
export function renderPanelSessionDetail(elements, detail) {
    if (detail === undefined) {
        elements.sessionMeta.textContent = "未选择会话";
        elements.messages.replaceChildren();
        renderToolCalls(elements.toolCalls, elements.toolsMeta, []);
        elements.decisions.replaceChildren();
        elements.emptyHint.hidden = false;
        elements.composer.hidden = true;
        return;
    }
    const session = detail.session;
    elements.emptyHint.hidden = true;
    elements.sessionMeta.textContent =
        `${session.project} · ${sessionStatusLabel(session.status)} · ${session.turn_count} 轮 · ` +
            `更新 ${formatTimestamp(session.updated_at)}` +
            (session.running ? " · 正在执行" : "") +
            (session.compaction_count === 0 ? "" : ` · 已压缩上下文 ${session.compaction_count} 次`) +
            (session.last_error === "" ? "" : ` · 最近问题：${session.last_error}`) +
            (session.terminate_reason === "" ? "" : ` · 终止原因：${session.terminate_reason}`);
    elements.messages.replaceChildren(...detail.messages.map((item) => messageNode(elements, item)));
    renderToolCalls(elements.toolCalls, elements.toolsMeta, detail.tool_calls);
    const pending = detail.decisions.filter((item) => item.status === "pending");
    const shown = pending.length > 0 ? pending : detail.decisions.slice(-1);
    elements.decisions.replaceChildren(...shown.map((item) => decisionNode(elements, item)));
    elements.composer.hidden = session.status === "terminated";
}
/** 面板总览：会话清单 + 项目下拉 + 运行时 + 项目表，一次渲染到位。 */
export function renderPanelDocument(elements, document_, selected) {
    renderPanelSessions(elements, document_.sessions, selected);
    renderPanelProjectOptions(elements, document_.projects);
    renderPanelRuntime(elements, document_.runtime, document_.projects);
    renderPanelProjects(elements, document_.projects);
}
/** 用一份项目档案回填表单（编辑）或清空表单（新建）。 */
export function fillProjectForm(elements, project) {
    const fields = project === undefined
        ? { name: "", path: "", description: "", command: "", home: "" }
        : {
            name: project.name,
            path: project.path,
            description: project.description,
            command: JSON.stringify(project.runtime.pi_command),
            home: project.runtime.pi_home,
        };
    elements.projectName.value = fields.name;
    elements.projectPath.value = fields.path;
    elements.projectDescription.value = fields.description;
    elements.projectCommand.value = fields.command;
    elements.projectHome.value = fields.home;
    elements.projectSubmit.textContent = project === undefined ? "新增项目" : "保存修改";
    elements.projectSource.textContent =
        project === undefined
            ? "新增页面管理项目：路径、PI 命令与隔离 HOME 都会在保存前校验。"
            : `正在编辑 ${project.name}（${projectSourceLabel(project.source)}）。`;
    elements.projectSubmit.dataset["editing"] = project?.name ?? "";
}
