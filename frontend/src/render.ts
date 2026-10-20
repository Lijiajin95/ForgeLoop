/**
 * 三段页签的渲染（对应 Python 的视图侧：只把数据写进界面，不发请求、不调度）。
 *
 * 排版按「需求分解出任务、任务执行出现问题」组织，层级完全来自 `link.ts` 算好的身份
 * 关联，渲染层不再自己拼身份：
 *
 * - 需求页签：一条需求一张卡片，卡内列出它分解出的任务（未派发的如实写「未派发」）；
 * - 任务页签：按所属需求分组，组内是已派发的任务记录，未关联需求的单任务单独成组；
 * - 问题页签：每条问题带对象所在页签的跳转，点过去由 `tabs.ts` 定位并高亮。
 *
 * 元素原语与句柄解析在 `dom.ts`；记录文本一律经那些原语走 `textContent`。
 */

import {
  budgetText,
  deliveryProgress,
  EMPTY,
  excerpt,
  failureText,
  formatTimestamp,
  issueBadgeText,
  issueKindLabel,
  latestVersion,
  nextStepText,
  planLabel,
  refreshNote,
  requirementIsBlocked,
  statusIsAbnormal,
  taskGoal,
  taskStatusText,
  text,
} from "./format.js";
import {
  collapsible,
  description,
  fill,
  jumpButton,
  line,
  row,
  span,
  statusChip,
  table,
  type CollapseState,
  type Navigation,
  type PageElements,
} from "./dom.js";
import {
  buildIndex,
  issuesFor,
  requirementOfTask,
  tabOfRef,
  type LinkedTask,
  type ProgressIndex,
  type RequirementGroup,
} from "./link.js";
import type { IssueEntry, ProgressDocument, RequirementEntry, TaskEntry } from "./payload.js";

/** 问题行里对象描述的摘录长度：说明这条问题卡在什么事情上，不占满整行。 */
const OBJECT_NOTE_MAX = 140;

/** 问题徽标：有问题才渲染，点击跳到问题页签。 */
function issueBadge(
  document: Document,
  navigation: Navigation,
  ownerId: string,
  issues: readonly IssueEntry[],
): HTMLButtonElement | null {
  const label = issueBadgeText(issues.length);
  if (label === "") {
    return null;
  }
  return jumpButton(
    document,
    navigation,
    { tab: "issues", refId: ownerId },
    label,
    "chip issue-chip",
  );
}

/** 任务描述：任务包目标；没有目标时如实写缺值。 */
function goalText(entry: TaskEntry): string {
  const goal = taskGoal(entry.plan);
  return goal === "" ? EMPTY : goal;
}

/** 描述块：标题 + 内容，用于需求原文这类长文本。 */
function descriptionBlock(document: Document, label: string, value: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "description-block";
  block.appendChild(span(document, "label", label));
  block.appendChild(
    description(document, value === "" ? "description muted" : "description", value),
  );
  return block;
}

/** 问题单元格：有徽标就放徽标，没有就写缺值。 */
function issueCell(
  document: Document,
  navigation: Navigation,
  refId: string,
  issues: readonly IssueEntry[],
): HTMLElement {
  const badge = issueBadge(document, navigation, refId, issues);
  return badge ?? span(document, "muted", EMPTY);
}

/** 需求卡片的卡头：身份、项目、状态、任务包与交付进展。 */
function requirementHead(
  document: Document,
  group: RequirementGroup,
  navigation: Navigation,
  head: HTMLElement,
): void {
  const requirement = group.requirement;
  head.appendChild(span(document, "id mono", text(requirement.req_id)));
  head.appendChild(span(document, "chip", text(requirement.project)));
  head.appendChild(statusChip(document, requirement.requirement_status));
  head.appendChild(span(document, "chip", planLabel(requirement.plan)));
  head.appendChild(span(document, "chip", deliveryProgress(requirement.tasks)));
  const badge = issueBadge(document, navigation, requirement.req_id, group.issues);
  if (badge !== null) {
    head.appendChild(badge);
  }
}

/** 需求分解出的一条任务在卡片里的行：计划身份 + 已派发时的执行事实。 */
function subtaskRow(
  document: Document,
  task: LinkedTask,
  index: ProgressIndex,
  navigation: Navigation,
): HTMLTableRowElement {
  const record: TaskEntry | null = task.task;
  const ids = document.createElement("div");
  ids.appendChild(span(document, "mono", text(task.task_id)));
  ids.appendChild(span(document, "muted mono", text(task.single_task_id)));
  if (record !== null) {
    ids.appendChild(description(document, "goal", goalText(record)));
  }
  const actions =
    record === null
      ? span(document, "muted", EMPTY)
      : jumpButton(
          document,
          navigation,
          { tab: "tasks", refId: task.single_task_id },
          "查看任务",
          "link-button",
        );
  const element = row(document, record !== null && statusIsAbnormal(record.status) ? "issue" : "", [
    ids,
    text(task.state),
    taskStatusText(record),
    record === null ? EMPTY : failureText(record.failures),
    record === null ? EMPTY : budgetText(record.budget),
    issueCell(document, navigation, task.single_task_id, issuesFor(index, task.single_task_id)),
    actions,
  ]);
  element.dataset.ref = task.single_task_id;
  return element;
}

/** 需求卡片正文：需求原文、下一步／阻断说明与它分解出的任务表。 */
function fillRequirementBody(
  document: Document,
  group: RequirementGroup,
  index: ProgressIndex,
  navigation: Navigation,
  body: HTMLElement,
): void {
  const requirement: RequirementEntry = group.requirement;
  const latest = latestVersion(requirement.versions);
  body.appendChild(
    descriptionBlock(
      document,
      latest === null ? "需求原文" : `需求原文 v${latest.version}`,
      latest === null ? "尚无需求原文。" : latest.text,
    ),
  );
  body.appendChild(line(document, "next", `下一步：${nextStepText(requirement.next_step)}`));
  const reason =
    requirement.blocked_reason === ""
      ? requirement.blocked_reason_text
      : requirement.blocked_reason;
  if (reason !== "") {
    // 真正阻断才用告警样式；正常终态的收尾文案（如「需求整体验收已完成」）只作说明。
    const blocked = requirementIsBlocked(
      requirement.requirement_status,
      requirement.blocked_reason,
    );
    body.appendChild(
      line(document, blocked ? "blocked" : "note", `${blocked ? "阻断原因" : "说明"}：${reason}`),
    );
  }
  if (group.tasks.length === 0) {
    body.appendChild(line(document, "empty-inline", "尚无任务包。"));
    return;
  }
  const tasks = table(document, ["任务", "推进", "执行", "失败轮次", "工时", "问题", ""]);
  const rows = tasks.querySelector("tbody");
  group.tasks.forEach((task) => {
    rows?.appendChild(subtaskRow(document, task, index, navigation));
  });
  body.appendChild(tasks);
}

/** 需求卡片：可折叠的卡头 + 正文（原文、说明与任务表）。 */
function requirementCard(
  document: Document,
  group: RequirementGroup,
  index: ProgressIndex,
  navigation: Navigation,
  collapse: CollapseState,
): HTMLElement {
  const requirement: RequirementEntry = group.requirement;
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.ref = requirement.req_id;
  const section = collapsible(document, requirement.req_id, collapse);
  requirementHead(document, group, navigation, section.head);
  section.head.appendChild(section.toggle);
  fillRequirementBody(document, group, index, navigation, section.body);
  card.appendChild(section.head);
  card.appendChild(section.body);
  return card;
}

/** 任务页签里一个需求分组的组头：所属需求可点回需求页签。 */
function taskGroupHead(
  document: Document,
  group: RequirementGroup,
  count: number,
  navigation: Navigation,
  head: HTMLElement,
): void {
  const requirement = group.requirement;
  head.appendChild(
    jumpButton(
      document,
      navigation,
      { tab: "requirements", refId: requirement.req_id },
      text(requirement.req_id),
      "id-link mono",
    ),
  );
  head.appendChild(span(document, "chip", text(requirement.project)));
  head.appendChild(statusChip(document, requirement.requirement_status));
  head.appendChild(span(document, "chip", planLabel(requirement.plan)));
  head.appendChild(span(document, "muted", `${count} 个任务`));
}

/** 任务行：状态、下一步、失败轮次、工时、阻断原因与它自己的问题。 */
function taskRow(
  document: Document,
  entry: TaskEntry,
  index: ProgressIndex,
  navigation: Navigation,
): HTMLTableRowElement {
  const ids = document.createElement("div");
  ids.appendChild(span(document, "mono", text(entry.task_id)));
  ids.appendChild(description(document, "goal", goalText(entry)));
  const element = row(document, statusIsAbnormal(entry.status) ? "task issue" : "task", [
    ids,
    statusChip(document, entry.status, statusIsAbnormal(entry.status)),
    nextStepText(entry.next_action),
    failureText(entry.failures),
    budgetText(entry.budget),
    text(entry.blocked_reason_text),
    issueCell(document, navigation, entry.task_id, issuesFor(index, entry.task_id)),
  ]);
  element.dataset.ref = entry.task_id;
  return element;
}

/** 一组任务（同一需求下的，或未关联需求的单任务）。 */
interface TaskGroupSpec {
  readonly refId: string;
  readonly tasks: readonly TaskEntry[];
  readonly fillHead: (head: HTMLElement) => void;
}

function taskGroup(
  document: Document,
  navigation: Navigation,
  index: ProgressIndex,
  collapse: CollapseState,
  spec: TaskGroupSpec,
): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = "group";
  wrapper.dataset.ref = spec.refId;
  const section = collapsible(document, `group:${spec.refId}`, collapse, "group-head");
  spec.fillHead(section.head);
  section.head.appendChild(section.toggle);
  wrapper.appendChild(section.head);
  const element = table(document, [
    "任务",
    "状态",
    "下一步",
    "失败轮次",
    "工时",
    "阻断原因",
    "问题",
  ]);
  const body = element.querySelector("tbody");
  spec.tasks.forEach((task) => {
    body?.appendChild(taskRow(document, task, index, navigation));
  });
  section.body.appendChild(element);
  wrapper.appendChild(section.body);
  return wrapper;
}

/** 未关联需求的单任务组：不把它们混进任何需求。 */
function orphanGroup(
  document: Document,
  tasks: readonly TaskEntry[],
  project: string,
  index: ProgressIndex,
  navigation: Navigation,
  collapse: CollapseState,
): HTMLElement {
  return taskGroup(document, navigation, index, collapse, {
    refId: `__orphan__:${project}`,
    tasks,
    fillHead: (head: HTMLElement) => {
      head.appendChild(span(document, "id mono", "未关联需求"));
      head.appendChild(span(document, "chip", text(project)));
      head.appendChild(span(document, "muted", `${tasks.length} 个任务`));
    },
  });
}

/** 未关联需求的单任务按项目分桶，桶的顺序取记录里的首次出现顺序。 */
function orphanGroups(
  document: Document,
  index: ProgressIndex,
  navigation: Navigation,
  collapse: CollapseState,
): readonly HTMLElement[] {
  const byProject = new Map<string, TaskEntry[]>();
  index.orphanTasks.forEach((task) => {
    const bucket = byProject.get(task.project);
    if (bucket === undefined) {
      byProject.set(task.project, [task]);
    } else {
      bucket.push(task);
    }
  });
  return [...byProject.entries()].map(([project, tasks]) =>
    orphanGroup(document, tasks, project, index, navigation, collapse),
  );
}

/** 任务页签的全部内容：按需求分组 + 未关联需求的单任务。 */
function taskGroups(
  document: Document,
  index: ProgressIndex,
  navigation: Navigation,
  collapse: CollapseState,
): readonly HTMLElement[] {
  const groups: HTMLElement[] = [];
  index.groups.forEach((group) => {
    const dispatched = group.tasks
      .map((task) => task.task)
      .filter((task): task is TaskEntry => task !== null);
    if (dispatched.length === 0) {
      return;
    }
    groups.push(
      taskGroup(document, navigation, index, collapse, {
        refId: group.requirement.req_id,
        tasks: dispatched,
        fillHead: (head) => {
          taskGroupHead(document, group, dispatched.length, navigation, head);
        },
      }),
    );
  });
  if (index.orphanTasks.length > 0) {
    groups.push(...orphanGroups(document, index, navigation, collapse));
  }
  return groups;
}

/** 问题对象状态：需求给需求状态，任务给任务状态；对不上记录时不写。 */
function objectStatus(index: ProgressIndex, refId: string): string {
  const requirement = index.requirementById.get(refId);
  if (requirement !== undefined) {
    return requirement.requirement_status;
  }
  return index.taskById.get(refId)?.status ?? "";
}

/** 问题的所属需求：对象是需求就是它自己，是任务就找它所属的需求。 */
function ownerOfRef(index: ProgressIndex, refId: string): string {
  if (index.requirementById.has(refId)) {
    return refId;
  }
  return requirementOfTask(index, refId)?.req_id ?? "";
}

/** 问题对象的描述：需求给最新原文摘录，任务给目标摘录；对不上记录时为空。 */
function objectDescription(index: ProgressIndex, refId: string): string {
  const requirement = index.requirementById.get(refId);
  if (requirement !== undefined) {
    const latest = latestVersion(requirement.versions);
    return latest === null ? "" : excerpt(latest.text, OBJECT_NOTE_MAX);
  }
  const task = index.taskById.get(refId);
  return task === undefined ? "" : excerpt(taskGoal(task.plan), OBJECT_NOTE_MAX);
}

/** 问题行：对象可点则给出跳转，对不上记录时显示为纯文本（不造假链接）。 */
function issueRow(
  document: Document,
  issue: IssueEntry,
  index: ProgressIndex,
  navigation: Navigation,
): HTMLTableRowElement {
  const tab = tabOfRef(index, issue.ref_id);
  const object =
    tab === null
      ? span(document, "mono", text(issue.ref_id))
      : jumpButton(
          document,
          navigation,
          { tab, refId: issue.ref_id },
          text(issue.ref_id),
          "id-link mono",
        );
  const status = objectStatus(index, issue.ref_id);
  if (status !== "") {
    object.appendChild(statusChip(document, status, statusIsAbnormal(status)));
  }
  const note = objectDescription(index, issue.ref_id);
  if (note !== "") {
    object.appendChild(description(document, "object-note muted", note));
  }
  const element = row(document, "issue", [
    issueKindLabel(issue.kind),
    object,
    text(issue.summary),
    text(issue.detail),
  ]);
  element.dataset.ref = issue.ref_id;
  const owner = ownerOfRef(index, issue.ref_id);
  if (owner !== "") {
    element.dataset.owner = owner;
  }
  return element;
}

/**
 * 把一份进展快照渲染到三个页签：计数、刷新说明、时间与三段内容。
 */
export function renderProgress(
  elements: PageElements,
  progress: ProgressDocument,
  navigation: Navigation,
  collapse: CollapseState,
): void {
  const document = elements.banner.ownerDocument;
  const index = buildIndex(progress);
  elements.refreshNote.textContent = refreshNote(progress.refresh_seconds, progress.refresh_source);
  elements.generatedAt.textContent = formatTimestamp(progress.generated_at);
  elements.recordsRoot.textContent = text(progress.records_root);
  renderRequirementOptions(elements, progress.requirements);
  elements.countRequirements.textContent = String(progress.counts.requirements);
  elements.countTasks.textContent = String(progress.counts.tasks);
  elements.countIssues.textContent = String(progress.counts.issues);
  fill(
    elements.requirementsBody,
    elements.requirementsEmpty,
    index.groups.map((group) => requirementCard(document, group, index, navigation, collapse)),
  );
  fill(elements.tasksBody, elements.tasksEmpty, taskGroups(document, index, navigation, collapse));
  fill(
    elements.issuesBody,
    elements.issuesEmpty,
    progress.issues.map((issue) => issueRow(document, issue, index, navigation)),
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

/* ------------------------------------------------------------------ *
 * 操作面板的渲染（写入口）：与三段页签共用同一份元素句柄。
 *
 * 只读渲染：不发起请求、不改业务状态；必填校验与判定都在服务端，页面只负责
 * 把缺项先说清楚、把服务端的拒绝原因原样显示。
 * ------------------------------------------------------------------ */

/**
 * 把需求清单灌进操作面板的下拉框：保留当前选择，未选中的新需求自动选第一条。
 */
function renderRequirementOptions(
  elements: PageElements,
  requirements: readonly RequirementEntry[],
): void {
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
  } else if (requirements.length > 0) {
    elements.actionReq.value = requirements[0]?.req_id ?? "";
  }
}

/** 写操作结果：空文本清空状态；失败用醒目色，成功用普通色。 */
export function renderOperationStatus(
  elements: PageElements,
  message: string,
  tone: "info" | "error",
): void {
  elements.operationsStatus.textContent = message;
  elements.operationsStatus.dataset["tone"] = tone;
}

/** 操作面板可见性：只有拿到令牌（`serve` 下发）时才显示。 */
export function renderOperationsAvailability(elements: PageElements, available: boolean): void {
  elements.operations.hidden = !available;
}
