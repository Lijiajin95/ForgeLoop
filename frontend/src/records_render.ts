/**
 * 三段记录的索引与档案渲染（只写 DOM，不发请求、不取数）。
 *
 * 索引只回答「有哪些记录、它讲什么」：身份 + 一句描述 + 状态/归属；其余字段放进
 * 右侧档案。所有来自记录的内容仍走 `textContent`，不拼接 HTML。
 */

import {
  budgetText,
  deliveryProgress,
  failureText,
  issueKindLabel,
  latestVersion,
  nextStepText,
  planLabel,
  requirementIsBlocked,
  statusIsAbnormal,
  taskGoal,
} from "./format.js";
import { jumpButton, type Navigation, type PageElements } from "./dom.js";
import { issuesFor, requirementOfTask, tabOfRef, type ProgressIndex } from "./link.js";
import {
  issueKey,
  issueList,
  requirementList,
  taskDescription,
  taskList,
  type IssueListItem,
  type RecordSelection,
  type RecordTab,
  type RequirementListItem,
  type TaskListItem,
} from "./records.js";
import type { IssueEntry, ProgressDocument } from "./payload.js";

/** 索引点击与档案动作：装配层决定切页签、换选择或打开写入口。 */
export interface RecordViewCallbacks {
  readonly onSelect: (tab: RecordTab, key: string) => void;
  readonly onOperate: (reqId: string) => void;
}

/** 一段有身份的文本：`class` 只做排版，内容一律走 `textContent`。 */
function node<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  value?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) {
    element.textContent = value;
  }
  return element;
}

/** 状态点：颜色由 `data-status` 决定；异常态同时加一个语义类。 */
function statusDot(document: Document, status: string): HTMLSpanElement {
  const dot = node(document, "span", "status-dot");
  dot.dataset["status"] = status;
  if (statusIsAbnormal(status) || status === "blocked" || status === "interrupted") {
    dot.classList.add("is-abnormal");
  }
  return dot;
}

/** 状态点 + 状态词。 */
function statusInline(document: Document, status: string): HTMLElement {
  const wrap = node(document, "span", "status-inline");
  if (status === "") {
    wrap.textContent = "—";
    return wrap;
  }
  wrap.append(statusDot(document, status), node(document, "span", "status-word", status));
  return wrap;
}

/** 索引行：一个整行可点的按钮，身份与描述是主信息。 */
function recordRow(
  document: Document,
  tab: RecordTab,
  key: string,
  refId: string,
  selected: boolean,
  id: string,
  description: string,
  side: readonly HTMLElement[],
  onSelect: (tab: RecordTab, key: string) => void,
): HTMLButtonElement {
  const row = node(document, "button", "record-row");
  row.type = "button";
  row.dataset["ref"] = refId;
  row.dataset["key"] = key;
  row.setAttribute("aria-current", String(selected));
  if (selected) {
    row.classList.add("is-selected");
  }
  const main = node(document, "span", "record-main");
  main.append(
    node(document, "span", "record-id mono", id),
    node(document, "span", "record-desc", description),
  );
  const sideBox = node(document, "span", "record-side");
  sideBox.append(...side);
  row.append(main, sideBox);
  row.addEventListener("click", () => {
    onSelect(tab, key);
  });
  return row;
}

/** 需求索引。 */
function renderRequirementIndex(
  elements: PageElements,
  items: readonly RequirementListItem[],
  selection: RecordSelection,
  onSelect: (tab: RecordTab, key: string) => void,
): void {
  const document = elements.requirementsBody.ownerDocument;
  const rows = items.map((item) => {
    const side: HTMLElement[] = [statusInline(document, item.status)];
    side.push(
      node(
        document,
        "span",
        "record-count",
        item.taskCount === 0 ? "无任务" : `${item.taskCount} 任务`,
      ),
    );
    return recordRow(
      document,
      "requirements",
      item.id,
      item.id,
      item.id === selection.requirement,
      item.id,
      item.description,
      side,
      onSelect,
    );
  });
  elements.requirementsBody.replaceChildren(...rows);
  elements.requirementsEmpty.style.display = rows.length === 0 ? "block" : "none";
}

/** 任务索引。 */
function renderTaskIndex(
  elements: PageElements,
  items: readonly TaskListItem[],
  selection: RecordSelection,
  onSelect: (tab: RecordTab, key: string) => void,
): void {
  const document = elements.tasksBody.ownerDocument;
  const rows = items.map((item) => {
    const side: HTMLElement[] = [statusInline(document, item.status)];
    side.push(
      node(
        document,
        "span",
        "record-count mono",
        item.requirementId === "" ? "未关联需求" : item.requirementId,
      ),
    );
    return recordRow(
      document,
      "tasks",
      item.id,
      item.id,
      item.id === selection.task,
      item.id,
      item.goal,
      side,
      onSelect,
    );
  });
  elements.tasksBody.replaceChildren(...rows);
  elements.tasksEmpty.style.display = rows.length === 0 ? "block" : "none";
}

/** 问题索引。 */
function renderIssueIndex(
  elements: PageElements,
  items: readonly IssueListItem[],
  selection: RecordSelection,
  onSelect: (tab: RecordTab, key: string) => void,
): void {
  const document = elements.issuesBody.ownerDocument;
  const rows = items.map((item) => {
    const side: HTMLElement[] = [node(document, "span", "record-kind", issueKindLabel(item.kind))];
    if (item.status !== "") {
      side.push(statusInline(document, item.status));
    }
    return recordRow(
      document,
      "issues",
      item.key,
      item.refId,
      item.key === selection.issue,
      item.refId,
      item.summary,
      side,
      onSelect,
    );
  });
  elements.issuesBody.replaceChildren(...rows);
  elements.issuesEmpty.style.display = rows.length === 0 ? "block" : "none";
}

/** 档案头部：种类、身份、一段可执行的入口。 */
function dossierHead(
  document: Document,
  kind: string,
  id: string,
  actions: readonly HTMLElement[],
): HTMLElement {
  const head = node(document, "header", "dossier-head");
  const copy = node(document, "div", "dossier-head-copy");
  copy.append(
    node(document, "p", "dossier-kind", kind),
    node(document, "h2", "dossier-id mono", id),
  );
  const actionBox = node(document, "div", "dossier-actions");
  actionBox.append(...actions);
  head.append(copy, actionBox);
  return head;
}

/** 档案导语：需求原文 / 任务目标 / 问题摘要。 */
function dossierLead(document: Document, value: string): HTMLElement {
  return node(document, "p", "dossier-lead", value);
}

/** 指标一格；`wide` 用于阻断原因这类长文本。 */
function metric(document: Document, label: string, value: string): HTMLElement {
  const cell = node(document, "div", "metric");
  cell.append(
    node(document, "dt", "metric-label", label),
    node(document, "dd", "metric-value", value),
  );
  return cell;
}

/** 指标区：定义列表保证读屏能读出字段名与值。 */
function metricGrid(
  document: Document,
  entries: readonly (readonly [string, string])[],
): HTMLElement {
  const list = node(document, "dl", "metric-grid");
  entries.forEach(([label, value]) => {
    list.appendChild(metric(document, label, value));
  });
  return list;
}

/** 说明/告警段落。 */
function callout(document: Document, tone: "note" | "alert", value: string): HTMLElement {
  return node(document, "p", `callout callout-${tone}`, value);
}

/** 小节标题。 */
function section(document: Document, title: string): HTMLElement {
  const box = node(document, "section", "dossier-section");
  box.appendChild(node(document, "h3", "section-title", title));
  return box;
}

/** 空态：不编造内容，明确告诉人下一步做什么。 */
function emptyBox(document: Document, title: string, detail: string): HTMLElement {
  const box = node(document, "div", "dossier-empty");
  box.append(node(document, "p", "dossier-empty-title", title), node(document, "p", "", detail));
  return box;
}

/** 问题列表：每条都回到问题页签，点过去由页签层选中对象。 */
function issueListBox(
  document: Document,
  issues: readonly IssueEntry[],
  navigation: Navigation,
): HTMLElement {
  const list = node(document, "ul", "issue-list");
  if (issues.length === 0) {
    list.appendChild(node(document, "li", "issue-empty", "没有挂在这里的问题。"));
    return list;
  }
  issues.forEach((issue) => {
    const item = node(document, "li", "issue-line");
    const link = jumpButton(
      document,
      navigation,
      { tab: "issues", refId: issue.ref_id },
      issueKindLabel(issue.kind),
      "issue-link",
    );
    item.append(link, node(document, "span", "issue-summary", issue.summary));
    list.appendChild(item);
  });
  return list;
}

/** 需求档案：原文、指标、任务表与问题。 */
function renderRequirementDetail(
  elements: PageElements,
  index: ProgressIndex,
  reqId: string,
  navigation: Navigation,
  callbacks: RecordViewCallbacks,
): void {
  const document = elements.requirementsDetail.ownerDocument;
  const group = index.groupByRequirement.get(reqId);
  if (group === undefined) {
    elements.requirementsDetail.replaceChildren(
      emptyBox(document, "没有可展示的需求", "刷新后会重新读取记录；如果仍然为空，检查记录根。"),
    );
    return;
  }
  const requirement = group.requirement;
  const latest = latestVersion(requirement.versions);
  const operate = node(document, "button", "button button-small", "处理这条需求");
  operate.type = "button";
  operate.addEventListener("click", () => {
    callbacks.onOperate(requirement.req_id);
  });
  const body: HTMLElement[] = [
    dossierHead(document, "需求", requirement.req_id, [operate]),
    dossierLead(
      document,
      latest === null || latest.text.trim() === "" ? "尚无需求原文。" : latest.text,
    ),
    metricGrid(document, [
      ["项目", requirement.project],
      ["状态", requirement.requirement_status],
      ["任务包", planLabel(requirement.plan)],
      ["任务进展", deliveryProgress(requirement.tasks)],
      ["下一步", nextStepText(requirement.next_step)],
      ["问题", group.issues.length === 0 ? "没有待处理问题" : `${group.issues.length} 条`],
    ]),
  ];
  const reason =
    requirement.blocked_reason === ""
      ? requirement.blocked_reason_text
      : requirement.blocked_reason;
  if (reason !== "") {
    const blocked = requirementIsBlocked(
      requirement.requirement_status,
      requirement.blocked_reason,
    );
    body.push(callout(document, blocked ? "alert" : "note", reason));
  }
  const tasks = section(document, "分解出的任务");
  if (group.tasks.length === 0) {
    tasks.appendChild(node(document, "p", "section-empty", "尚无任务包。"));
  } else {
    const table = node(document, "table", "detail-table");
    const head = node(document, "thead", "");
    const headRow = node(document, "tr", "");
    ["任务", "推进", "执行", "失败轮次", "工时", "问题"].forEach((label) => {
      const th = node(document, "th", "", label);
      th.setAttribute("scope", "col");
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    const tbody = node(document, "tbody", "");
    group.tasks.forEach((linked) => {
      const row = node(document, "tr", linked.task === null ? "" : "task-row");
      const first = node(document, "td", "task-cell");
      first.appendChild(
        jumpButton(
          document,
          navigation,
          { tab: "tasks", refId: linked.single_task_id },
          linked.task_id,
          "task-link mono",
        ),
      );
      if (linked.task !== null) {
        first.appendChild(node(document, "p", "record-desc", taskDescription(linked.task)));
      }
      row.appendChild(first);
      row.appendChild(node(document, "td", "", linked.state));
      row.appendChild(
        node(document, "td", "", linked.task === null ? "未派发" : linked.task.status),
      );
      row.appendChild(
        node(document, "td", "", linked.task === null ? "—" : failureText(linked.task.failures)),
      );
      row.appendChild(
        node(document, "td", "", linked.task === null ? "—" : budgetText(linked.task.budget)),
      );
      const issueCount = issuesFor(index, linked.single_task_id).length;
      row.appendChild(node(document, "td", "", issueCount === 0 ? "—" : `${issueCount} 条`));
      tbody.appendChild(row);
    });
    table.append(head, tbody);
    tasks.appendChild(table);
  }
  body.push(tasks);
  const issues = section(document, "问题");
  issues.appendChild(issueListBox(document, group.issues, navigation));
  body.push(issues);
  elements.requirementsDetail.replaceChildren(...body);
}

/** 任务档案：目标、执行指标、归属需求与问题。 */
function renderTaskDetail(
  elements: PageElements,
  index: ProgressIndex,
  taskId: string,
  navigation: Navigation,
): void {
  const document = elements.tasksDetail.ownerDocument;
  const task = index.taskById.get(taskId);
  if (task === undefined) {
    elements.tasksDetail.replaceChildren(
      emptyBox(document, "没有可展示的任务", "任务可能还没有派发，或记录已经被新快照替换。"),
    );
    return;
  }
  const requirement = requirementOfTask(index, task.task_id);
  const actions: HTMLElement[] = [];
  if (requirement !== null) {
    actions.push(
      jumpButton(
        document,
        navigation,
        { tab: "requirements", refId: requirement.req_id },
        "查看所属需求",
        "button button-small",
      ),
    );
  }
  const body: HTMLElement[] = [
    dossierHead(document, "任务", task.task_id, actions),
    dossierLead(document, taskGoal(task.plan) === "" ? "尚无任务目标。" : taskGoal(task.plan)),
    metricGrid(document, [
      ["项目", task.project],
      ["状态", task.status],
      ["下一步", nextStepText(task.next_action)],
      ["失败轮次", failureText(task.failures)],
      ["工时", budgetText(task.budget)],
      ["所属需求", requirement === null ? "未关联需求" : requirement.req_id],
    ]),
  ];
  if (task.blocked_reason_text !== "") {
    body.push(
      callout(document, statusIsAbnormal(task.status) ? "alert" : "note", task.blocked_reason_text),
    );
  }
  const issues = section(document, "问题");
  issues.appendChild(issueListBox(document, issuesFor(index, task.task_id), navigation));
  body.push(issues);
  elements.tasksDetail.replaceChildren(...body);
}

/** 问题档案：摘要、依据、对象与所属需求。 */
function renderIssueDetail(
  elements: PageElements,
  index: ProgressIndex,
  issue: IssueEntry,
  navigation: Navigation,
): void {
  const document = elements.issuesDetail.ownerDocument;
  const tab = tabOfRef(index, issue.ref_id);
  const actions: HTMLElement[] = [];
  if (tab !== null) {
    actions.push(
      jumpButton(
        document,
        navigation,
        { tab, refId: issue.ref_id },
        "查看对象",
        "button button-small",
      ),
    );
  }
  const requirement = requirementOfTask(index, issue.ref_id);
  const owner = index.requirementById.get(issue.ref_id) ?? requirement;
  const body: HTMLElement[] = [
    dossierHead(document, `问题 · ${issueKindLabel(issue.kind)}`, issue.ref_id, actions),
    dossierLead(document, issue.summary),
    metricGrid(document, [
      ["对象状态", index.taskById.get(issue.ref_id)?.status ?? owner?.requirement_status ?? "—"],
      ["所属需求", owner === null || owner === undefined ? "—" : owner.req_id],
      ["项目", issue.project],
    ]),
    node(document, "p", "dossier-body", issue.detail),
  ];
  elements.issuesDetail.replaceChildren(...body);
}

/** 把三段索引与当前选择对应的档案一次画出来。 */
export function renderRecordViews(
  elements: PageElements,
  progress: ProgressDocument,
  index: ProgressIndex,
  selection: RecordSelection,
  navigation: Navigation,
  callbacks: RecordViewCallbacks,
): void {
  renderRequirementIndex(elements, requirementList(index), selection, callbacks.onSelect);
  renderTaskIndex(elements, taskList(index), selection, callbacks.onSelect);
  renderIssueIndex(elements, issueList(progress, index), selection, callbacks.onSelect);
  renderRequirementDetail(elements, index, selection.requirement, navigation, callbacks);
  renderTaskDetail(elements, index, selection.task, navigation);
  const issue =
    progress.issues.find((item) => issueKey(item) === selection.issue) ?? progress.issues[0];
  if (issue === undefined) {
    const document = elements.issuesDetail.ownerDocument;
    elements.issuesDetail.replaceChildren(
      emptyBox(document, "没有待处理问题", "当前快照里没有阻断、中断或等待授权的事项。"),
    );
  } else {
    renderIssueDetail(elements, index, issue, navigation);
  }
}
