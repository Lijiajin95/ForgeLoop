/**
 * 纯格式化规则（对应 Python 的 domain 层：无 DOM、无网络、无时钟）。
 *
 * 页面显示什么文字、缺值怎么标注、状态词怎么翻译都在这里决定，渲染层只负责把
 * 结果写进 DOM。这样这些规则可以被单元测试与变异测试直接覆盖，不需要浏览器。
 */
/** 缺值与空值的统一写法。 */
export const EMPTY = "—";
/** 问题种类 → 中文标签；未知种类原样显示，不猜测。 */
const ISSUE_KIND_LABELS = {
    task_blocked: "任务阻断",
    task_interrupted: "任务中断",
    task_grant_required: "等待追加授权",
    task_time_exhausted: "工时耗尽",
    task_stop_requested: "待确认停止",
    requirement_blocked: "需求阻断",
    slot_residue: "执行槽位残留",
    outstanding_action: "未核对动作",
};
/** 刷新间隔来源 → 中文说明。 */
const REFRESH_SOURCE_LABELS = {
    cli: "--refresh-seconds",
    config: "配置文件",
    default: "内建默认 60 秒",
};
/**
 * 展示文本；空串、null、undefined 统一为 `—`。
 *
 * 入参收窄为可安全字符串化的类型：对象/数组不属于接口契约（契约快照守住形状），
 * 收窄后 `String()` 不会静默产出 `[object Object]`。
 */
export function text(value) {
    if (value === null || value === undefined || value === "") {
        return EMPTY;
    }
    return String(value);
}
/** 秒数 → 中文时长；非有限数显示缺值。 */
export function formatSeconds(value) {
    const seconds = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(seconds)) {
        return EMPTY;
    }
    const rounded = Math.round(seconds);
    if (rounded < 60) {
        return `${rounded} 秒`;
    }
    const minutes = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}
/** ISO 时间戳 → 浏览器本地时间；无法解析时原样显示，不伪造时间。 */
export function formatTimestamp(value) {
    if (typeof value !== "string" || value === "") {
        return EMPTY;
    }
    const moment = new Date(value);
    if (Number.isNaN(moment.getTime())) {
        return value;
    }
    return moment.toLocaleString("zh-CN", { hour12: false });
}
/** 下一步动作 → 「动作（主体）」；缺失显示缺值。 */
export function nextStepText(section) {
    if (section === null || section === undefined || section.action === "") {
        return EMPTY;
    }
    return `${section.action}（${section.actor === "user" ? "人工" : "自动"}）`;
}
/** 刷新设置说明：0 表示关闭自动刷新。 */
export function refreshNote(seconds, source) {
    if (seconds <= 0) {
        return "自动刷新: 已关闭（可用「立即刷新」）";
    }
    return `自动刷新: 每 ${seconds} 秒（来源: ${refreshSourceLabel(source)}）`;
}
/** 问题种类标签；未知种类原样返回。 */
export function issueKindLabel(kind) {
    return ISSUE_KIND_LABELS[kind] ?? text(kind);
}
/** 刷新来源标签；未知来源原样返回。 */
export function refreshSourceLabel(source) {
    return REFRESH_SOURCE_LABELS[source] ?? text(source);
}
/** 需求任务进展：已交付数 / 任务总数（无任务包时显示缺值）。 */
export function deliveryProgress(tasks) {
    if (tasks.length === 0) {
        return EMPTY;
    }
    const delivered = tasks.filter((task) => task.state === "delivered").length;
    return `${delivered} / ${tasks.length} 已交付`;
}
/** 失败轮次说明：累计、本次授权剩余或额度用尽。 */
export function failureText(failures) {
    const cumulative = `${failures.cumulative} 累计`;
    if (failures.awaiting_grant_decision) {
        return `${cumulative}；额度用尽`;
    }
    return `${cumulative}；本次剩余 ${failures.remaining_in_current_grant}`;
}
/** 工时说明：已消耗 / 限额。 */
export function budgetText(budget) {
    return `${formatSeconds(budget.consumed_seconds)} / ${formatSeconds(budget.limit_seconds)}`;
}
/** 倒计时说明；关闭自动刷新时给出固定文案。 */
export function countdownText(remainingSeconds, autoRefreshOff) {
    if (autoRefreshOff) {
        return "自动刷新已关闭";
    }
    if (remainingSeconds <= 0) {
        return "正在刷新…";
    }
    return `${remainingSeconds} 秒后刷新`;
}
