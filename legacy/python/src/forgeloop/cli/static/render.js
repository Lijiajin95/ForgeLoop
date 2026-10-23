/**
 * 进展快照的页面渲染入口（只写 DOM，不发请求、不调度）。
 *
 * 具体排版在 `records_render.ts`：索引只放身份与描述，指标与原文进档案。本模块负责
 * 计数、刷新说明、操作下拉框与写入口可见性，并把当前选择解析成仍存在的记录。
 */
import { formatTimestamp, refreshNote, text } from "./format.js";
import { buildIndex } from "./link.js";
import { renderRecordViews } from "./records_render.js";
import { EMPTY_SELECTION, resolveSelection, } from "./records.js";
/** 把一份进展快照画到页面上；返回刷新后仍然有效的选择。 */
export function renderProgress(elements, progress, navigation, selection = EMPTY_SELECTION, actions = {
    onSelect: () => undefined,
    onOperate: () => undefined,
}) {
    const index = buildIndex(progress);
    elements.refreshNote.textContent = refreshNote(progress.refresh_seconds, progress.refresh_source);
    elements.generatedAt.textContent = formatTimestamp(progress.generated_at);
    elements.recordsRoot.textContent = text(progress.records_root);
    renderRequirementOptions(elements, progress.requirements);
    elements.countRequirements.textContent = String(progress.counts.requirements);
    elements.countTasks.textContent = String(progress.counts.tasks);
    elements.countIssues.textContent = String(progress.counts.issues);
    const resolved = resolveSelection(index, progress, selection);
    renderRecordViews(elements, progress, index, resolved, navigation, actions);
    return resolved;
}
/** 显示读取失败：报错必须可见，不能把失败伪装成「没有记录」。 */
export function showError(elements, message) {
    elements.banner.textContent = message;
    elements.banner.style.display = "block";
}
/** 清除错误提示（下一次成功读取后调用）。 */
export function clearError(elements) {
    elements.banner.textContent = "";
    elements.banner.style.display = "none";
}
/* ------------------------------------------------------------------ *
 * 操作面板的渲染（写入口）：与三段页签共用同一份元素句柄。
 *
 * 只读渲染：不发起请求、不改业务状态；必填校验与判定都在服务端，页面只负责
 * 把缺项先说清楚、把服务端的拒绝原因原样显示。
 * ------------------------------------------------------------------ */
/**
 * 把需求清单灌进操作面板的下拉框：保留当前选择，未选中的新需求自动选第一条。
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
/** 操作面板可见性：只有拿到令牌（`serve` 下发）时才显示入口与抽屉。 */
export function renderOperationsAvailability(elements, available) {
    elements.operations.hidden = !available;
    elements.operationsOpen.hidden = !available;
    if (!available) {
        elements.operationsDrawer.hidden = true;
    }
}
