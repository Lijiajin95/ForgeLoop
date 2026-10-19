/**
 * 页签与跳转（对应 Python 的视图侧：只操作 DOM 状态，不发请求、不取数）。
 *
 * 页面把需求、任务、问题分成三段展示，层级靠 `link.ts` 的身份关联决定；本模块只管
 * 「现在看哪一段」与「跳到某个对象并把它标出来」这两件事：
 *
 * - 页签状态写在 DOM 上（`aria-selected` + 面板 `hidden`），并同步到地址栏 `#片段`，
 *   因此刷新后仍停在原段、链接可以直接指向某一段；
 * - 跳转只认元素上的 `data-ref` / `data-owner`（渲染层写上的身份），不拼接选择器，
 *   记录里的文本不会被当成 CSS 或 HTML 解析；
 * - 高亮是暂时的：到点自动撤掉，避免页面上留下一个说不清来由的标记。
 */

import { TAB_IDS, type TabId } from "./link.js";

/** 跳转高亮的持续时间（毫秒）。 */
const HIGHLIGHT_MS = 3000;

/** 页签元素句柄：按钮与面板按身份成对出现。 */
export interface TabView {
  readonly buttons: ReadonlyMap<TabId, HTMLButtonElement>;
  readonly panels: ReadonlyMap<TabId, HTMLElement>;
}

function requireElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    // 与渲染层同一口径：缺元素就明确失败，不留一个永远空白的页面。
    throw new Error(`页面缺少元素 #${id}；HTML 与脚本版本不一致`);
  }
  return element as T;
}

/** 解析三段页签的按钮与面板；任一缺失即抛错。 */
export function resolveTabs(document: Document): TabView {
  const buttons = new Map<TabId, HTMLButtonElement>();
  const panels = new Map<TabId, HTMLElement>();
  TAB_IDS.forEach((id) => {
    buttons.set(id, requireElement<HTMLButtonElement>(document, `tab-${id}`));
    panels.set(id, requireElement<HTMLElement>(document, `panel-${id}`));
  });
  return { buttons, panels };
}

/** 地址栏片段 → 页签身份；空片段与未知片段返回 `null`（由调用方回退默认段）。 */
export function tabFromHash(hash: string): TabId | null {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  return TAB_IDS.find((id) => id === name) ?? null;
}

/** 当前选中的页签；尚未接线时回退到第一段（需求）。 */
export function activeTab(view: TabView): TabId {
  const selected = TAB_IDS.find(
    (id) => view.buttons.get(id)?.getAttribute("aria-selected") === "true",
  );
  return selected ?? TAB_IDS[0];
}

/** 切换页签：选中态、面板显隐与地址栏片段一起更新。 */
export function activateTab(view: TabView, id: TabId): void {
  view.buttons.forEach((button, candidate) => {
    button.setAttribute("aria-selected", String(candidate === id));
  });
  view.panels.forEach((panel, candidate) => {
    panel.hidden = candidate !== id;
  });
  globalThis.location.hash = id;
}

/** 环形移动：左右方向键在首尾之间循环。 */
function neighbour(id: TabId, step: number): TabId {
  const at = TAB_IDS.indexOf(id);
  return TAB_IDS[(at + step + TAB_IDS.length) % TAB_IDS.length] as TabId;
}

/** 接上点击、左右方向键与地址栏片段变化，并按地址栏片段决定初始页签。 */
export function wireTabs(view: TabView): void {
  activateTab(view, tabFromHash(globalThis.location.hash) ?? TAB_IDS[0]);
  view.buttons.forEach((button, id) => {
    button.addEventListener("click", () => {
      activateTab(view, id);
    });
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        activateTab(view, neighbour(id, step));
      }
    });
  });
  // 手动改地址栏、点站内链接或前进／后退都会换片段：页面要跟着换段，否则地址栏
  // 说的和看到的不是一回事。片段认不出来时保持当前页签，不跳到无意义的位置。
  globalThis.addEventListener("hashchange", () => {
    const id = tabFromHash(globalThis.location.hash);
    if (id !== null) {
      activateTab(view, id);
    }
  });
}

/** 在面板里按身份找对象：只比较 `data-ref` / `data-owner` 的字面值。 */
function findTarget(panel: HTMLElement, refId: string): HTMLElement | null {
  const candidates = panel.querySelectorAll<HTMLElement>("[data-ref], [data-owner]");
  for (const candidate of candidates) {
    if (candidate.dataset.ref === refId || candidate.dataset.owner === refId) {
      return candidate;
    }
  }
  return null;
}

/**
 * 跳到对象所在的那一段并高亮它。
 *
 * 对象不在这段（记录刚变、已经消失）时只切页签：跳转让位于如实展示，不报错也不
 * 编一个空标记。
 */
export function focusTarget(view: TabView, id: TabId, refId: string): void {
  activateTab(view, id);
  const panel = view.panels.get(id);
  const target = panel === undefined ? null : findTarget(panel, refId);
  if (target === null) {
    return;
  }
  target.classList.add("target");
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center" });
  }
  globalThis.setTimeout(() => {
    target.classList.remove("target");
  }, HIGHLIGHT_MS);
}
