/**
 * DOM 渲染层（对应 Python 的视图侧：只把数据写进界面，不发请求、不调度）。
 *
 * 安全约束：所有来自记录的内容一律走 `textContent`，绝不拼接 HTML——需求原文、
 * 阻断原因与问题详情都是用户或模型产出的文本。ESLint 的 `no-restricted-syntax`
 * 也禁用了 `innerHTML`/`insertAdjacentHTML`（见 eslint.config.js）。
 */
import { budgetText, deliveryProgress, EMPTY, failureText, formatTimestamp, issueKindLabel, nextStepText, refreshNote, text, } from "./format.js";
const ELEMENT_IDS = {
    banner: "banner",
    refreshButton: "refresh-button",
    refreshNote: "refresh-note",
    countdown: "countdown",
    generatedAt: "generated-at",
    recordsRoot: "records-root",
    countRequirements: "count-requirements",
    countTasks: "count-tasks",
    countIssues: "count-issues",
    requirementsBody: "requirements-body",
    requirementsEmpty: "requirements-empty",
    tasksBody: "tasks-body",
    tasksEmpty: "tasks-empty",
    issuesBody: "issues-body",
    issuesEmpty: "issues-empty",
    operations: "operations",
    submitForm: "submit-form",
    submitProject: "submit-project",
    submitText: "submit-text",
    operationsBy: "operations-by",
    submitReason: "submit-reason",
    submitButton: "submit-button",
    actionReq: "action-req",
    actionReason: "action-reason",
    actionApprove: "action-approve",
    actionAdvance: "action-advance",
    actionAccept: "action-accept",
    actionStop: "action-stop",
    actionCancel: "action-cancel",
    operationsStatus: "operations-status",
};
function requireElement(document, id) {
    const element = document.getElementById(id);
    if (element === null) {
        // 静默失败是最糟的结果：页面会永远空白且看不出原因。
        throw new Error(`页面缺少元素 #${id}；HTML 与脚本版本不一致`);
    }
    return element;
}
/**
 * 解析全部元素句柄；任一缺失即抛错（不返回半初始化的句柄）。
 */
export function resolveElements(document) {
    const elements = {};
    for (const key of Object.keys(ELEMENT_IDS)) {
        elements[key] = requireElement(document, ELEMENT_IDS[key]);
    }
    return elements;
}
function cell(row, value, wrap = false) {
    const td = row.ownerDocument.createElement("td");
    if (wrap) {
        td.className = "wrap";
    }
    td.textContent = value;
    row.appendChild(td);
}
function row(document, values, className = "") {
    const tr = document.createElement("tr");
    if (className !== "") {
        tr.className = className;
    }
    values.forEach((value, index) => {
        cell(tr, value, index === values.length - 1);
    });
    return tr;
}
function fill(body, empty, rows) {
    body.textContent = "";
    rows.forEach((item) => {
        body.appendChild(item);
    });
    empty.style.display = rows.length === 0 ? "block" : "none";
}
function requirementRow(document, entry) {
    return row(document, [
        text(entry.req_id),
        text(entry.project),
        text(entry.requirement_status),
        entry.plan === null ? EMPTY : `v${entry.plan.plan_version}`,
        deliveryProgress(entry.tasks),
        nextStepText(entry.next_step),
        text(entry.blocked_reason === "" ? entry.blocked_reason_text : entry.blocked_reason),
    ]);
}
function taskRow(document, entry) {
    const abnormal = entry.status === "blocked" || entry.status === "interrupted";
    return row(document, [
        text(entry.task_id),
        text(entry.project),
        text(entry.status),
        nextStepText(entry.next_action),
        failureText(entry.failures),
        budgetText(entry.budget),
        text(entry.blocked_reason_text),
    ], abnormal ? "issue" : "");
}
function issueRow(document, entry) {
    return row(document, [issueKindLabel(entry.kind), text(entry.ref_id), text(entry.summary), text(entry.detail)], "issue");
}
/**
 * 把一份进展快照渲染到页面：计数、刷新说明、时间与三张表。
 */
export function renderProgress(elements, progress) {
    renderRequirementOptions(elements, progress.requirements);
    const document = elements.banner.ownerDocument;
    elements.refreshNote.textContent = refreshNote(progress.refresh_seconds, progress.refresh_source);
    elements.generatedAt.textContent = formatTimestamp(progress.generated_at);
    elements.recordsRoot.textContent = text(progress.records_root);
    elements.countRequirements.textContent = String(progress.counts.requirements);
    elements.countTasks.textContent = String(progress.counts.tasks);
    elements.countIssues.textContent = String(progress.counts.issues);
    fill(elements.requirementsBody, elements.requirementsEmpty, progress.requirements.map((entry) => requirementRow(document, entry)));
    fill(elements.tasksBody, elements.tasksEmpty, progress.tasks.map((entry) => taskRow(document, entry)));
    fill(elements.issuesBody, elements.issuesEmpty, progress.issues.map((entry) => issueRow(document, entry)));
}
/** 显示读取失败：报错必须可见，不能把失败伪装成「没有记录」。 */
/**
 * 把需求清单灌进操作面板的下拉框：保留当前选择，未选中的新需求自动选第一条。
 *
 * 只读渲染：不发起请求、不改业务状态；空清单时下拉框为空并禁用动作按钮由调用方处理。
 */
function renderRequirementOptions(elements, requirements) {
    const previous = elements.actionReq.value;
    elements.actionReq.replaceChildren();
    for (const requirement of requirements) {
        const option = elements.actionReq.ownerDocument.createElement("option");
        option.value = requirement.req_id;
        option.textContent = `${requirement.req_id}（${requirement.requirement_status}）`;
        elements.actionReq.append(option);
    }
    const stillThere = requirements.some((item) => item.req_id === previous);
    if (stillThere) {
        elements.actionReq.value = previous;
    }
    else if (requirements.length > 0) {
        elements.actionReq.value = requirements[0]?.req_id ?? "";
    }
}
/** 写操作结果：空文本清空状态；失败用醒目色，成功用普通色。 */
export function renderOperationStatus(elements, message, tone) {
    elements.operationsStatus.textContent = message;
    elements.operationsStatus.dataset["tone"] = tone;
}
/** 操作面板可见性：只有拿到令牌（`serve` 下发）时才显示。 */
export function renderOperationsAvailability(elements, available) {
    elements.operations.hidden = !available;
}
export function showError(elements, message) {
    elements.banner.textContent = message;
    elements.banner.style.display = "block";
}
/** 清除错误提示（下一次成功读取后调用）。 */
export function clearError(elements) {
    elements.banner.textContent = "";
    elements.banner.style.display = "none";
}
