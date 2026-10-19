/**
 * 三段记录的关联规则（对应 Python 的 domain 层：无 DOM、无网络、无时钟）。
 *
 * 页面按「需求分解出任务、任务执行出现问题」组织排版，而这个层级不是靠列表顺序
 * 猜出来的，是靠记录里的身份串起来的：
 *
 * - 需求的任务包条目用 `single_task_id` 指向任务段的单任务记录（未派发时指向的
 *   记录还不存在，此时如实标为未派发，不编造执行事实）；
 * - 问题用 `ref_id` 指向需求或任务，页面据此把它挂到对象上、并按所属需求汇总。
 *
 * 规则全部是纯函数：渲染层只消费这里算好的索引，不再自己拼身份。同一条任务记录
 * 被两个任务包声明时按需求顺序归第一个（确定性），不被任何需求声明的单任务归入
 * 「未关联需求」。
 */

import type {
  IssueEntry,
  ProgressDocument,
  RequirementEntry,
  RequirementTaskEntry,
  TaskEntry,
} from "./payload.js";

/** 页面页签身份；与 `web_page.html` 的 `#tab-*` / `#panel-*` 一一对应。 */
export const TAB_IDS = ["requirements", "tasks", "issues"] as const;

export type TabId = (typeof TAB_IDS)[number];

/** 需求分解出的一条任务：计划身份 + 已派发时的任务记录。 */
export interface LinkedTask {
  readonly task_id: string;
  readonly single_task_id: string;
  readonly state: string;
  readonly task: TaskEntry | null;
}

/** 一条需求及其分解出的任务、以及挂在这条需求线上的问题。 */
export interface RequirementGroup {
  readonly requirement: RequirementEntry;
  readonly tasks: readonly LinkedTask[];
  readonly issues: readonly IssueEntry[];
}

/** 一次快照的关联索引：页面渲染与跳转只读它。 */
export interface ProgressIndex {
  readonly requirementById: ReadonlyMap<string, RequirementEntry>;
  readonly taskById: ReadonlyMap<string, TaskEntry>;
  readonly requirementByTaskId: ReadonlyMap<string, RequirementEntry>;
  readonly groups: readonly RequirementGroup[];
  readonly groupByRequirement: ReadonlyMap<string, RequirementGroup>;
  readonly orphanTasks: readonly TaskEntry[];
  readonly issuesByRef: ReadonlyMap<string, readonly IssueEntry[]>;
  readonly unknownIssues: readonly IssueEntry[];
}

const NO_ISSUES: readonly IssueEntry[] = [];

/**
 * 按 `single_task_id` 把需求的任务包条目挂到任务记录上。
 *
 * 认领在计划条目上发生（而不是等到有任务记录）：一条需求只要在自己的任务包里
 * 声明了某个单任务身份，这个身份就归它，后声明的需求不再重复挂同一份记录；
 * 计划里还没派发的身份同样被认领，因此不会把它们算成「未关联需求」。
 */
function linkTasks(
  tasks: readonly RequirementTaskEntry[],
  taskById: ReadonlyMap<string, TaskEntry>,
  claimed: Set<string>,
): readonly LinkedTask[] {
  return tasks.map((entry) => {
    const task = claimed.has(entry.single_task_id)
      ? null
      : (taskById.get(entry.single_task_id) ?? null);
    claimed.add(entry.single_task_id);
    return {
      task_id: entry.task_id,
      single_task_id: entry.single_task_id,
      state: entry.state,
      task,
    };
  });
}

/** 问题按 `ref_id` 分桶，保持记录顺序。 */
function groupIssues(issues: readonly IssueEntry[]): Map<string, IssueEntry[]> {
  const grouped = new Map<string, IssueEntry[]>();
  issues.forEach((issue) => {
    const bucket = grouped.get(issue.ref_id);
    if (bucket === undefined) {
      grouped.set(issue.ref_id, [issue]);
    } else {
      bucket.push(issue);
    }
  });
  return grouped;
}

/** 挂在这条需求线上的问题：需求自身的 + 它分解出的任务上的。 */
function issuesOfRequirement(
  requirement: RequirementEntry,
  issues: readonly IssueEntry[],
): readonly IssueEntry[] {
  const mine = new Set<string>([requirement.req_id]);
  requirement.tasks.forEach((task) => mine.add(task.single_task_id));
  return issues.filter((issue) => mine.has(issue.ref_id));
}

function buildGroups(
  requirements: readonly RequirementEntry[],
  taskById: ReadonlyMap<string, TaskEntry>,
  claimed: Set<string>,
  issues: readonly IssueEntry[],
): readonly RequirementGroup[] {
  return requirements.map((requirement) => ({
    requirement,
    tasks: linkTasks(requirement.tasks, taskById, claimed),
    issues: issuesOfRequirement(requirement, issues),
  }));
}

/** 问题是否指向一条存在的记录（需求或任务）；对不上的如实留在问题段。 */
function isKnownRef(
  refId: string,
  requirementById: ReadonlyMap<string, RequirementEntry>,
  taskById: ReadonlyMap<string, TaskEntry>,
): boolean {
  return requirementById.has(refId) || taskById.has(refId);
}

/** 建立一次快照的关联索引。 */
export function buildIndex(progress: ProgressDocument): ProgressIndex {
  const requirementById = new Map(progress.requirements.map((item) => [item.req_id, item]));
  const taskById = new Map(progress.tasks.map((item) => [item.task_id, item]));
  const issuesByRef = groupIssues(progress.issues);
  const claimed = new Set<string>();
  const groups = buildGroups(progress.requirements, taskById, claimed, progress.issues);
  const requirementByTaskId = new Map<string, RequirementEntry>();
  groups.forEach((group) => {
    group.tasks.forEach((task) => {
      if (!requirementByTaskId.has(task.single_task_id)) {
        requirementByTaskId.set(task.single_task_id, group.requirement);
      }
    });
  });
  return {
    requirementById,
    taskById,
    requirementByTaskId,
    groups,
    groupByRequirement: new Map(groups.map((group) => [group.requirement.req_id, group])),
    orphanTasks: progress.tasks.filter((task) => !claimed.has(task.task_id)),
    issuesByRef,
    unknownIssues: progress.issues.filter(
      (issue) => !isKnownRef(issue.ref_id, requirementById, taskById),
    ),
  };
}

/** 某个对象的直接问题（没有则为空数组，不返回 undefined）。 */
export function issuesFor(index: ProgressIndex, refId: string): readonly IssueEntry[] {
  return index.issuesByRef.get(refId) ?? NO_ISSUES;
}

/** 由任务身份找回它所属的需求；未被任何需求声明时为 `null`（不猜归属）。 */
export function requirementOfTask(index: ProgressIndex, taskId: string): RequirementEntry | null {
  return index.requirementByTaskId.get(taskId) ?? null;
}

/** 对象在哪一段：需求在需求页签、任务在任务页签；对不上记录时为 `null`。 */
export function tabOfRef(index: ProgressIndex, refId: string): TabId | null {
  if (index.requirementById.has(refId)) {
    return "requirements";
  }
  if (index.taskById.has(refId)) {
    return "tasks";
  }
  return null;
}
