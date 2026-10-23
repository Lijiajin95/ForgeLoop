/**
 * `@` 引用的纯规则（对应 Python 的 domain 层：无 DOM、无网络、无时钟）。
 *
 * 输入框里输入 `@` 后，页面从当前进展快照里找需求、任务与问题，按身份插入一段
 * 可读的引用文本。这里只决定「当前光标前是不是一个引用查询」「有哪些候选」「插入
 * 后光标在哪」，真正的弹层与键盘操作由装配层落地。
 *
 * 引用文本就是记录身份本身（`@req-…`、`@task-…`、`@issue:<kind>:<ref>`），不额外
 * 编码一套只有页面认识的语法；服务端与 Agent 看到的仍是普通消息文本。
 */
import { excerpt, issueKindLabel, latestVersion, taskGoal } from "./format.js";
/** 一次最多展示的候选数：足够覆盖常用记录，又不把弹层撑满。 */
const MENTION_LIMIT = 12;
/** `@` 前必须是开头或分隔符，避免把邮箱、账号名里的 `@` 当成引用。 */
const SEPARATOR = /[\s，。；：、,.;:(（[【]/u;
/** 引用候选的展示排序：需求 → 任务 → 问题；同类保持记录顺序。 */
const KIND_ORDER = {
    requirement: 0,
    task: 1,
    issue: 2,
};
function searchable(...parts) {
    return parts.join(" ").toLowerCase();
}
/**
 * 把一份进展快照摊平成引用候选。
 *
 * 需求用最新一版原文做说明，任务用任务包目标，问题用摘要；没有说明时如实写缺值，
 * 不编造内容。问题的身份带 kind，因为同一个对象上可能同时挂着不同类型的问题。
 */
export function mentionItems(progress) {
    const requirements = progress.requirements.map((requirement) => {
        const latest = latestVersion(requirement.versions);
        const body = latest === null ? "" : latest.text;
        return {
            kind: "requirement",
            id: requirement.req_id,
            title: requirement.req_id,
            detail: body === "" ? "尚无需求原文。" : excerpt(body, 96),
            search: searchable(requirement.req_id, requirement.project, requirement.requirement_status, body),
        };
    });
    const tasks = progress.tasks.map((task) => {
        const goal = taskGoal(task.plan);
        return {
            kind: "task",
            id: task.task_id,
            title: task.task_id,
            detail: goal === "" ? "尚无任务目标。" : excerpt(goal, 96),
            search: searchable(task.task_id, task.project, task.status, goal, task.blocked_reason_text),
        };
    });
    const issues = progress.issues.map((issue) => ({
        kind: "issue",
        id: `issue:${issue.kind}:${issue.ref_id}`,
        title: `${issueKindLabel(issue.kind)} · ${issue.ref_id}`,
        detail: excerpt(issue.summary, 96),
        search: searchable(issue.kind, issue.ref_id, issue.summary, issue.detail, issue.project),
    }));
    return [...requirements, ...tasks, ...issues];
}
/**
 * 找出光标前的引用查询；不是引用语境时返回 `null`。
 *
 * 查询里一旦出现空白就结束：`@需求 正文` 只引用 `@需求`，后面的文字回到普通输入。
 */
export function mentionQuery(value, caret) {
    const end = Math.max(0, Math.min(caret, value.length));
    const before = value.slice(0, end);
    const start = before.lastIndexOf("@");
    if (start < 0) {
        return null;
    }
    if (start > 0) {
        const previous = before.charAt(start - 1);
        if (!SEPARATOR.test(previous)) {
            return null;
        }
    }
    const query = before.slice(start + 1);
    if (/\s/u.test(query) || query.includes("@")) {
        return null;
    }
    return { start, end, query };
}
/** 候选过滤：身份前缀优先，其次身份包含，最后是说明命中；空查询保持记录顺序。 */
export function filterMentions(items, query, limit = MENTION_LIMIT) {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
        return items.slice(0, limit);
    }
    const scored = [];
    items.forEach((item, at) => {
        const id = item.id.toLowerCase();
        const score = id.startsWith(needle)
            ? 0
            : id.includes(needle)
                ? 1
                : item.search.includes(needle)
                    ? 2
                    : -1;
        if (score >= 0) {
            scored.push({ item, score, at });
        }
    });
    scored.sort((left, right) => {
        if (left.score !== right.score) {
            return left.score - right.score;
        }
        if (KIND_ORDER[left.item.kind] !== KIND_ORDER[right.item.kind]) {
            return KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind];
        }
        return left.at - right.at;
    });
    return scored.slice(0, limit).map((entry) => entry.item);
}
/** 用选中的候选替换查询片段；后面补一个空格，方便继续输入。 */
export function insertMention(value, query, item) {
    const inserted = `@${item.id} `;
    return {
        value: value.slice(0, query.start) + inserted + value.slice(query.end),
        caret: query.start + inserted.length,
    };
}
/** 候选列表里的种类标签。 */
export function mentionKindLabel(kind) {
    if (kind === "requirement") {
        return "需求";
    }
    return kind === "task" ? "任务" : "问题";
}
