/**
 * DOM 渲染层（对应 Python 的视图侧：只把数据写进界面，不发请求、不调度）。
 *
 * 安全约束：所有来自记录的内容一律走 `textContent`，绝不拼接 HTML——需求原文、
 * 阻断原因与问题详情都是用户或模型产出的文本。ESLint 的 `no-restricted-syntax`
 * 也禁用了 `innerHTML`/`insertAdjacentHTML`（见 eslint.config.js）。
 */

import {
  budgetText,
  deliveryProgress,
  EMPTY,
  failureText,
  formatTimestamp,
  issueKindLabel,
  nextStepText,
  refreshNote,
  text,
} from "./format.js";
import type { IssueEntry, ProgressDocument, RequirementEntry, TaskEntry } from "./payload.js";

/** 页面元素句柄：id 与 `web_page.html` 一一对应，缺一个就明确失败。 */
export interface PageElements {
  readonly banner: HTMLElement;
  readonly refreshButton: HTMLButtonElement;
  readonly refreshNote: HTMLElement;
  readonly countdown: HTMLElement;
  readonly generatedAt: HTMLElement;
  readonly recordsRoot: HTMLElement;
  readonly countRequirements: HTMLElement;
  readonly countTasks: HTMLElement;
  readonly countIssues: HTMLElement;
  readonly requirementsBody: HTMLElement;
  readonly requirementsEmpty: HTMLElement;
  readonly tasksBody: HTMLElement;
  readonly tasksEmpty: HTMLElement;
  readonly issuesBody: HTMLElement;
  readonly issuesEmpty: HTMLElement;
}

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
} as const satisfies Record<keyof PageElements, string>;

function requireElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    // 静默失败是最糟的结果：页面会永远空白且看不出原因。
    throw new Error(`页面缺少元素 #${id}；HTML 与脚本版本不一致`);
  }
  return element as T;
}

/**
 * 解析全部元素句柄；任一缺失即抛错（不返回半初始化的句柄）。
 */
export function resolveElements(document: Document): PageElements {
  const elements = {} as Record<keyof PageElements, HTMLElement>;
  for (const key of Object.keys(ELEMENT_IDS) as (keyof PageElements)[]) {
    elements[key] = requireElement(document, ELEMENT_IDS[key]);
  }
  return elements as unknown as PageElements;
}

function cell(row: HTMLTableRowElement, value: string, wrap = false): void {
  const td = row.ownerDocument.createElement("td");
  if (wrap) {
    td.className = "wrap";
  }
  td.textContent = value;
  row.appendChild(td);
}

function row(document: Document, values: readonly string[], className = ""): HTMLTableRowElement {
  const tr = document.createElement("tr");
  if (className !== "") {
    tr.className = className;
  }
  values.forEach((value, index) => {
    cell(tr, value, index === values.length - 1);
  });
  return tr;
}

function fill(body: HTMLElement, empty: HTMLElement, rows: readonly HTMLTableRowElement[]): void {
  body.textContent = "";
  rows.forEach((item) => {
    body.appendChild(item);
  });
  empty.style.display = rows.length === 0 ? "block" : "none";
}

function requirementRow(document: Document, entry: RequirementEntry): HTMLTableRowElement {
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

function taskRow(document: Document, entry: TaskEntry): HTMLTableRowElement {
  const abnormal = entry.status === "blocked" || entry.status === "interrupted";
  return row(
    document,
    [
      text(entry.task_id),
      text(entry.project),
      text(entry.status),
      nextStepText(entry.next_action),
      failureText(entry.failures),
      budgetText(entry.budget),
      text(entry.blocked_reason_text),
    ],
    abnormal ? "issue" : "",
  );
}

function issueRow(document: Document, entry: IssueEntry): HTMLTableRowElement {
  return row(
    document,
    [issueKindLabel(entry.kind), text(entry.ref_id), text(entry.summary), text(entry.detail)],
    "issue",
  );
}

/**
 * 把一份进展快照渲染到页面：计数、刷新说明、时间与三张表。
 */
export function renderProgress(elements: PageElements, progress: ProgressDocument): void {
  const document = elements.banner.ownerDocument;
  elements.refreshNote.textContent = refreshNote(progress.refresh_seconds, progress.refresh_source);
  elements.generatedAt.textContent = formatTimestamp(progress.generated_at);
  elements.recordsRoot.textContent = text(progress.records_root);
  elements.countRequirements.textContent = String(progress.counts.requirements);
  elements.countTasks.textContent = String(progress.counts.tasks);
  elements.countIssues.textContent = String(progress.counts.issues);
  fill(
    elements.requirementsBody,
    elements.requirementsEmpty,
    progress.requirements.map((entry) => requirementRow(document, entry)),
  );
  fill(
    elements.tasksBody,
    elements.tasksEmpty,
    progress.tasks.map((entry) => taskRow(document, entry)),
  );
  fill(
    elements.issuesBody,
    elements.issuesEmpty,
    progress.issues.map((entry) => issueRow(document, entry)),
  );
}

/** 显示读取失败：报错必须可见，不能把失败伪装成「没有记录」。 */
export function showError(elements: PageElements, message: string): void {
  elements.banner.textContent = message;
  elements.banner.style.display = "block";
}

/** 清除错误提示（下一次成功读取后调用）。 */
export function clearError(elements: PageElements): void {
  elements.banner.textContent = "";
  elements.banner.style.display = "none";
}
