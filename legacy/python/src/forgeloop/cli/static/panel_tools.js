/**
 * 工具调用列表渲染（面板「会话」页签里，对话流水下方的逐次事实）。
 *
 * 与 `panel_render.ts` 分开的原因很直接：面板渲染已经接近单文件行数上限，而工具列表
 * 是一个自洽的小块——风险、状态、审批状态三张标签表 + 一次列表填充。这里只做 DOM，
 * 不做取数，也不改任何状态。
 */
import { text } from "./format.js";
/** 风险级别的人读标签（与 `domain.conversation.ToolRisk` 一一对应）。 */
const RISK_LABELS = {
    read: "只读",
    write: "写文件",
    execute: "执行命令",
    unknown: "未知工具",
};
/** 工具执行状态的人读标签。 */
const TOOL_STATUS_LABELS = {
    running: "执行中",
    ok: "成功",
    error: "失败",
};
/** 审批状态的人读标签。 */
const APPROVAL_LABELS = {
    none: "无需审批",
    pending: "待审批",
    approved: "已批准",
    rejected: "已拒绝",
};
/**
 * 渲染逐次工具调用：名称、风险、状态、耗时、审批状态，以及参数与结果摘要。
 *
 * 需人工确认的调用用 `tool-approval` 类标出（样式上左侧竖线换色），列表为空时整体隐藏。
 */
export function renderToolCalls(list, meta, calls) {
    const ownerDocument = list.ownerDocument;
    list.replaceChildren(...calls.map((call) => {
        const item = ownerDocument.createElement("li");
        item.className = call.requires_approval ? "tool-approval" : "";
        const head = ownerDocument.createElement("span");
        head.className = "msg-head";
        head.textContent =
            `${call.tool_name} · ${RISK_LABELS[call.risk] ?? text(call.risk)} · ` +
                `${TOOL_STATUS_LABELS[call.status] ?? text(call.status)} · ${call.duration_ms} ms · ` +
                `${APPROVAL_LABELS[call.approval_status] ?? text(call.approval_status)}`;
        const body = ownerDocument.createElement("p");
        body.textContent = [
            call.args_excerpt === "" ? "" : `参数：${call.args_excerpt}`,
            call.result_excerpt === "" ? "" : `结果：${call.result_excerpt}`,
        ]
            .filter((line) => line !== "")
            .join("\n");
        item.append(head, body);
        return item;
    }));
    list.hidden = calls.length === 0;
    meta.hidden = calls.length === 0;
    if (calls.length > 0) {
        const needsReview = calls.filter((call) => call.requires_approval).length;
        meta.textContent =
            `本轮工具调用 ${calls.length} 次（需人工确认 ${needsReview} 次）` +
                "：PI 在轮次内自行执行工具，审批发生在轮次边界。";
    }
}
