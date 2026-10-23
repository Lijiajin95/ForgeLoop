/**
 * 三段记录的列表/详情视图模型（纯规则：无 DOM、无网络、无时钟）。
 *
 * 页面把「需求 / 任务 / 问题」当作可检索的档案，而不是三张把所有字段都铺开的表：
 * 索引只保留身份与一句描述，其余状态、轮次、工时、依据放进右侧档案。这里负责把
 * `ProgressIndex` 摊平成索引条目、解析当前选择，并在刷新后把选择落到仍存在的记录上。
 */
import { excerpt, latestVersion, taskGoal } from "./format.js";
import { issuesFor, requirementOfTask } from "./link.js";
/** 初始选择：没有记录时全部为空。 */
export const EMPTY_SELECTION = {
    requirement: "",
    task: "",
    issue: "",
};
/** 问题没有独立 ID：用种类 + 对象身份组成稳定键，选择与高亮都用它。 */
export function issueKey(issue) {
    return `${issue.kind}:${issue.ref_id}`;
}
/** 需求最新一版的原文摘录；没有原文时给出可读的空态。 */
export function requirementDescription(requirement) {
    const latest = latestVersion(requirement.versions);
    if (latest === null || latest.text.trim() === "") {
        return "尚无需求原文。";
    }
    return excerpt(latest.text, 140);
}
/** 任务目标摘录；没有任务包或目标时给出可读的空态。 */
export function taskDescription(task) {
    const goal = taskGoal(task.plan);
    return goal.trim() === "" ? "尚无任务目标。" : excerpt(goal, 140);
}
/** 需求索引：保持记录顺序。 */
export function requirementList(index) {
    return index.groups.map((group) => ({
        id: group.requirement.req_id,
        description: requirementDescription(group.requirement),
        status: group.requirement.requirement_status,
        project: group.requirement.project,
        taskCount: group.tasks.length,
        issueCount: group.issues.length,
    }));
}
/** 任务索引：先按需求分组顺序，再列未关联需求的单任务。 */
export function taskList(index) {
    const items = [];
    index.groups.forEach((group) => {
        group.tasks.forEach((linked) => {
            if (linked.task === null) {
                return;
            }
            items.push({
                id: linked.task.task_id,
                goal: taskDescription(linked.task),
                status: linked.task.status,
                project: linked.task.project,
                requirementId: group.requirement.req_id,
                issueCount: issuesFor(index, linked.task.task_id).length,
            });
        });
    });
    index.orphanTasks.forEach((task) => {
        items.push({
            id: task.task_id,
            goal: taskDescription(task),
            status: task.status,
            project: task.project,
            requirementId: "",
            issueCount: issuesFor(index, task.task_id).length,
        });
    });
    return items;
}
/** 问题对象状态：需求给需求状态，任务给任务状态；对不上记录时为空。 */
export function objectStatus(index, refId) {
    const requirement = index.requirementById.get(refId);
    if (requirement !== undefined) {
        return requirement.requirement_status;
    }
    return index.taskById.get(refId)?.status ?? "";
}
/** 问题的所属需求：对象是需求就是它自己，是任务就找它所属的需求。 */
export function ownerOfRef(index, refId) {
    if (index.requirementById.has(refId)) {
        return refId;
    }
    return requirementOfTask(index, refId)?.req_id ?? "";
}
/** 问题索引：保持记录顺序。 */
export function issueList(progress, index) {
    return progress.issues.map((issue) => ({
        key: issueKey(issue),
        refId: issue.ref_id,
        kind: issue.kind,
        summary: issue.summary,
        detail: issue.detail,
        status: objectStatus(index, issue.ref_id),
        owner: ownerOfRef(index, issue.ref_id),
    }));
}
function firstRequirement(index) {
    return index.groups[0]?.requirement.req_id ?? "";
}
function firstTask(index) {
    return taskList(index)[0]?.id ?? "";
}
function firstIssue(progress, index) {
    return issueList(progress, index)[0]?.key ?? "";
}
/** 刷新后把选择落到仍存在的记录上；原来的记录消失时回退到第一条。 */
export function resolveSelection(index, progress, selection) {
    const requirement = index.requirementById.has(selection.requirement)
        ? selection.requirement
        : firstRequirement(index);
    const task = index.taskById.has(selection.task) ? selection.task : firstTask(index);
    const keys = new Set(issueList(progress, index).map((item) => item.key));
    const issue = keys.has(selection.issue) ? selection.issue : firstIssue(progress, index);
    return { requirement, task, issue };
}
/** 点索引行：只替换对应那一段的选择，另外两段保持不动。 */
export function selectRecord(selection, tab, key) {
    if (tab === "requirements") {
        return { ...selection, requirement: key };
    }
    if (tab === "tasks") {
        return { ...selection, task: key };
    }
    return { ...selection, issue: key };
}
/**
 * 从记录身份跳到某一段时同步选择。
 *
 * 问题的对象身份可能对应多条问题（同一对象上不同种类），此时选该对象的第一条；
 * 需求/任务则直接选中身份本身。
 */
export function selectRef(index, progress, selection, tab, refId) {
    if (tab === "requirements") {
        if (!index.requirementById.has(refId)) {
            return selection;
        }
        return { ...selection, requirement: refId };
    }
    if (tab === "tasks") {
        if (!index.taskById.has(refId)) {
            return selection;
        }
        return { ...selection, task: refId };
    }
    const match = progress.issues.find((issue) => issue.ref_id === refId);
    if (match === undefined) {
        return selection;
    }
    return { ...selection, issue: issueKey(match) };
}
/** 当前需求分组；找不到时返回 `null`（详情据此显示空态）。 */
export function requirementGroupOf(index, reqId) {
    return index.groupByRequirement.get(reqId) ?? null;
}
