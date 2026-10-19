/**
 * 前端测试夹具：真实页面 HTML 与示例进展快照。
 *
 * 页面 HTML 直接读**随包分发的那一份**（`src/forgeloop/cli/web_page.html`），
 * 因此「脚本要的元素 id 是否真的存在」是在核对真实产物，而不是核对一份复制品。
 *
 * 示例快照按真实记录的关联形状构造：需求的任务包条目带 `task_id`（任务包内身份）
 * 与 `single_task_id`（单任务记录身份），问题用 `ref_id` 指向需求或任务；页面正是
 * 靠这两个身份把三段串起来。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  IssueEntry,
  ProgressDocument,
  ProjectEntry,
  RequirementEntry,
  RequirementTaskEntry,
  TaskEntry,
} from "../../src/payload.js";

/** 一段可辨认的需求原文（含换行与多段，核对「原文照原样展示」）。 */
export const REQUIREMENT_TEXT =
  "需求：状态页要把需求、任务、问题分成三个页签。\n\n背景：现在三段平铺在一页上，" +
  "需求分解出的任务与任务上的问题看不出层级，人工核对时要来回翻。\n\n要做的事：" +
  "① 三段各占一个页签；② 需求卡片里列出它分解出的任务；③ 任务上的问题可跳转。" +
  "这段文本故意写长一些，用来核对长原文在卡片里的展示与折叠行为是否仍然可读。";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 随包分发的页面 HTML 路径。 */
const PAGE_HTML_PATH = resolve(HERE, "../../../src/forgeloop/cli/web_page.html");

/**
 * 把真实页面的 `<body>` 装进当前 jsdom 文档；返回装好的 body 元素数。
 */
export function loadPageBody(): number {
  const html = readFileSync(PAGE_HTML_PATH, "utf8");
  const start = html.indexOf("<body>") + "<body>".length;
  const end = html.indexOf("</body>");
  document.body.innerHTML = html.slice(start, end);
  return document.body.querySelectorAll("*").length;
}

/** 需求任务包内的一条任务：默认已派发成单任务记录。 */
export function sampleRequirementTask(
  overrides: Partial<RequirementTaskEntry> = {},
): RequirementTaskEntry {
  return {
    task_id: "first",
    single_task_id: "task-first",
    state: "delivered",
    ...overrides,
  };
}

/** 一条需求：默认已批准任务包 v1，两个任务（一个已交付、一个被阻断）。 */
export function sampleRequirement(overrides: Partial<RequirementEntry> = {}): RequirementEntry {
  return {
    req_id: "req-forgeloop-1",
    project: "forgeloop",
    requirement_status: "plan_proposed",
    plan: { plan_version: 1 },
    versions: [
      { version: 1, text: "需求：状态页要分三个页签。" },
      { version: 2, text: REQUIREMENT_TEXT },
    ],
    tasks: [
      sampleRequirementTask(),
      sampleRequirementTask({
        task_id: "blocked",
        single_task_id: "task-blocked",
        state: "in_progress",
      }),
    ],
    next_step: { action: "批准或重新生成任务包", actor: "user" },
    blocked_reason: "",
    blocked_reason_text: "未找到该需求的任务包批准；未批准不执行",
    ...overrides,
  };
}

/** 第二条需求：默认还没有任务包（用于核对「尚无任务包」的展示）。 */
export function sampleDraftRequirement(
  overrides: Partial<RequirementEntry> = {},
): RequirementEntry {
  return sampleRequirement({
    req_id: "req-forgeloop-2",
    requirement_status: "draft",
    plan: null,
    tasks: [],
    next_step: { action: "生成或批准任务包", actor: "user" },
    blocked_reason_text: "还没有任务包；未批准不执行",
    ...overrides,
  });
}

/** 一条任务：默认为阻断态（会被页面标红并出现在问题段）。 */
export function sampleTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    task_id: "task-blocked",
    project: "forgeloop",
    status: "blocked",
    plan: { goal: "把三段拆成页签，并让任务与需求按身份对上" },
    next_action: { action: "人工核对批准绑定", actor: "user" },
    failures: {
      cumulative: 1,
      remaining_in_current_grant: 2,
      awaiting_grant_decision: false,
    },
    budget: { consumed_seconds: 125, limit_seconds: 7200 },
    blocked_reason_text: "任务需要人工核对现场（状态：blocked）",
    ...overrides,
  };
}

/** 一个已登记项目（多项目聚合时页面据此标注条目归属）。 */
function sampleProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    project_id: "forgeloop",
    name: "ForgeLoop",
    repo_path: "/tmp/forgeloop",
    records_root: "/tmp/records/projects/forgeloop",
    counts: { projects: 1, requirements: 2, tasks: 3, issues: 2 },
    ...overrides,
  };
}

/** 一条已交付任务（正常流程状态，不标红）。 */
export function sampleDeliveredTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return sampleTask({
    task_id: "task-first",
    status: "merged",
    plan: { goal: "先交付一个正常任务" },
    next_action: { action: "发布版本或结束任务", actor: "user" },
    failures: { cumulative: 0, remaining_in_current_grant: 3, awaiting_grant_decision: false },
    budget: { consumed_seconds: 600, limit_seconds: 7200 },
    blocked_reason_text: "任务已到达终态（merged），本轮已结束",
    ...overrides,
  });
}

/** 一条不属于任何需求的单任务记录（页面归入「未关联需求」）。 */
export function sampleOrphanTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return sampleTask({
    task_id: "task-orphan",
    status: "interrupted",
    plan: { goal: "核对一次中断任务的现场" },
    next_action: { action: "人工核对现场", actor: "user" },
    blocked_reason_text: "任务执行中，执行结果不明（状态：interrupted）",
    ...overrides,
  });
}

/** 一条问题项：默认指向那条被阻断的任务。 */
export function sampleIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    kind: "task_blocked",
    project: "forgeloop",
    ref_id: "task-blocked",
    summary: "任务执行被阻断，需人工核对后才能继续",
    detail: "任务需要人工核对现场（状态：blocked）",
    ...overrides,
  };
}

/** 一份进展快照：两条需求、三条任务（含一条未关联需求）与两条问题。 */
export function sampleDocument(overrides: Partial<ProgressDocument> = {}): ProgressDocument {
  const requirements = overrides.requirements ?? [sampleRequirement(), sampleDraftRequirement()];
  const tasks = overrides.tasks ?? [sampleTask(), sampleDeliveredTask(), sampleOrphanTask()];
  const issues = overrides.issues ?? [
    sampleIssue(),
    sampleIssue({
      kind: "requirement_blocked",
      ref_id: "req-forgeloop-2",
      summary: "需求推进被阻断，需人工核对后才能继续",
      detail: "还没有任务包；未批准不执行",
    }),
  ];
  const projects = overrides.projects ?? [sampleProject()];
  return {
    schema_version: 1,
    generated_at: "2026-10-17T04:00:00+00:00",
    records_root: "/tmp/records",
    refresh_seconds: 60,
    refresh_source: "config",
    projects,
    counts: {
      projects: projects.length,
      requirements: requirements.length,
      tasks: tasks.length,
      issues: issues.length,
    },
    requirements,
    tasks,
    issues,
    ...overrides,
  };
}
