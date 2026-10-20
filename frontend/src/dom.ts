/**
 * DOM 原语与页面句柄（对应 Python 的视图侧：只造元素、只解析句柄，不读记录）。
 *
 * 这里不含业务判断：每个函数只把给定的文本或元素放进 DOM。页签内容怎么组织由
 * `render.ts` 决定、身份关联由 `link.ts` 决定，因此这些原语可以放心复用，不会把
 * 业务规则藏进 DOM 操作里。
 *
 * 安全约束：所有来自记录的内容一律走 `textContent`，绝不拼接 HTML——需求原文、
 * 阻断原因与问题详情都是用户或模型产出的文本。ESLint 的 `no-restricted-syntax`
 * 也禁用了 `innerHTML`/`insertAdjacentHTML`（见 eslint.config.js）。
 */

import { text } from "./format.js";
import type { TabId } from "./link.js";

/** 跨段跳转：渲染层只声明「去哪一段的哪个对象」，怎么切由 `tabs.ts` 决定。 */
export interface Navigation {
  readonly goTo: (tab: TabId, refId: string) => void;
}

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
  readonly operations: HTMLElement;
  readonly submitForm: HTMLFormElement;
  readonly submitProject: HTMLInputElement;
  readonly submitText: HTMLTextAreaElement;
  readonly operationsBy: HTMLInputElement;
  readonly submitReason: HTMLInputElement;
  readonly submitButton: HTMLButtonElement;
  readonly actionReq: HTMLSelectElement;
  readonly actionReason: HTMLInputElement;
  readonly actionApprove: HTMLButtonElement;
  readonly actionAdvance: HTMLButtonElement;
  readonly actionAccept: HTMLButtonElement;
  readonly actionStop: HTMLButtonElement;
  readonly actionCancel: HTMLButtonElement;
  readonly operationsStatus: HTMLElement;
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
  operations: "operations",
  submitForm: "submit-form",
  submitProject: "submit-project",
  submitText: "submit-text",
  operationsBy: "operations-by",
  submitReason: "submit-reason",
  submitButton: "submit-button",
  actionReq: "action-req",
  actionReason: "action-reason",
  actionApprove: "action-approve",
  actionAdvance: "action-advance",
  actionAccept: "action-accept",
  actionStop: "action-stop",
  actionCancel: "action-cancel",
  operationsStatus: "operations-status",
} as const satisfies Record<keyof PageElements, string>;

/** 一个单元格的内容：纯文本（来自记录）或已经建好的元素（标签、按钮）。 */
type CellContent = string | HTMLElement;

/** 跳转目标：哪一段的哪个对象。 */
interface JumpTarget {
  readonly tab: TabId;
  readonly refId: string;
}

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

/** 一段纯文本元素（记录里的文本一律经这里进入 DOM）。 */
export function span(document: Document, className: string, value: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = value;
  return element;
}

/** 状态标签：机器状态原样显示，另用 `data-status` 供样式区分异常态。 */
export function statusChip(document: Document, status: string, abnormal = false): HTMLSpanElement {
  const chip = span(document, abnormal ? "chip status abnormal" : "chip status", text(status));
  chip.dataset.status = status;
  return chip;
}

/** 说明行（下一步、阻断原因）。 */
export function line(document: Document, className: string, value: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.className = `line ${className}`;
  paragraph.textContent = value;
  return paragraph;
}

/** 可点击的跳转按钮：身份写在 `data-*` 上，行为交给导航。 */
export function jumpButton(
  document: Document,
  navigation: Navigation,
  target: JumpTarget,
  label: string,
  className: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.tab = target.tab;
  button.dataset.ref = target.refId;
  button.addEventListener("click", () => {
    navigation.goTo(target.tab, target.refId);
  });
  return button;
}

/** 表格行：单元格按内容类型写入文本或元素。 */
export function row(
  document: Document,
  className: string,
  cells: readonly CellContent[],
): HTMLTableRowElement {
  const element = document.createElement("tr");
  element.className = className;
  cells.forEach((value) => {
    const cell = document.createElement("td");
    if (typeof value === "string") {
      cell.textContent = value;
    } else {
      cell.appendChild(value);
    }
    element.appendChild(cell);
  });
  return element;
}

/** 建一张带表头的表（表体由调用方填充）；表头用 `th` 并声明列范围。 */
export function table(document: Document, headers: readonly string[]): HTMLTableElement {
  const element = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((label) => {
    const cell = document.createElement("th");
    cell.setAttribute("scope", "col");
    cell.textContent = label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  element.appendChild(head);
  element.appendChild(document.createElement("tbody"));
  return element;
}

/** 填充一段内容：清空旧的、追加新的，并切换空态提示。 */
export function fill(
  container: HTMLElement,
  empty: HTMLElement,
  children: readonly HTMLElement[],
): void {
  container.textContent = "";
  children.forEach((child) => {
    container.appendChild(child);
  });
  empty.style.display = children.length === 0 ? "block" : "none";
}

/** 折叠状态：按对象身份记住，页面重绘后仍然生效。 */
export interface CollapseState {
  isCollapsed(id: string): boolean;
  setCollapsed(id: string, collapsed: boolean): void;
}

/** 建立一份折叠状态；可给初始就收起的身份清单。 */
export function createCollapseState(collapsed: readonly string[] = []): CollapseState {
  const collapsedIds = new Set(collapsed);
  return {
    isCollapsed: (id) => collapsedIds.has(id),
    setCollapsed: (id, value) => {
      if (value) {
        collapsedIds.add(id);
      } else {
        collapsedIds.delete(id);
      }
    },
  };
}

/** 可折叠区块：头、正文与开关分开返回，调用方把内容放进去。 */
export interface CollapsibleSection {
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly toggle: HTMLButtonElement;
}

/**
 * 建一个可折叠区块。
 *
 * 折叠状态由调用方持有（见 :func:`createCollapseState`），DOM 只是它的投影：
 * 因此自动刷新重绘后，用户收起／展开的选择仍然有效。开关自己带 `aria-expanded`
 * 与 `aria-controls`，键盘与读屏都能用；正文用 `hidden` 属性隐藏而不是靠样式，
 * 隐藏时不会被读屏读到。
 */
export function collapsible(
  document: Document,
  id: string,
  state: CollapseState,
  headClassName = "card-head",
): CollapsibleSection {
  const head = document.createElement("header");
  head.className = headClassName;
  const body = document.createElement("div");
  body.className = "card-body";
  body.id = `body-${id}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "collapse-toggle";
  toggle.setAttribute("aria-controls", body.id);
  const sync = (collapsed: boolean): void => {
    body.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "展开" : "收起";
  };
  sync(state.isCollapsed(id));
  toggle.addEventListener("click", () => {
    const collapsed = !state.isCollapsed(id);
    state.setCollapsed(id, collapsed);
    sync(collapsed);
  });
  return { head, body, toggle };
}

/** 一段说明文本（需求原文、任务目标、对象描述都用它）。 */
export function description(
  document: Document,
  className: string,
  value: string,
): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = value;
  return element;
}
