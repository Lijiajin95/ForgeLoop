/**
 * 页签行为的组件测试（真实页面 HTML + jsdom）。
 *
 * 覆盖用户能看到的页签契约：默认停在需求页签、地址栏 `#` 片段能直接落到某一段、
 * 点击与左右方向键切换、跳转到对象所在的页签并高亮，以及缺元素时明确失败。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateTab,
  activeTab,
  focusTarget,
  resolveTabs,
  tabFromHash,
  wireTabs,
} from "../../src/tabs.js";
import { loadPageBody } from "../fixtures/page.js";

beforeEach(() => {
  window.location.hash = "";
  loadPageBody();
});

function stubScrollIntoView(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  Element.prototype.scrollIntoView = spy;
  return spy;
}

describe("tabFromHash", () => {
  it("认识三段页签的片段", () => {
    expect(tabFromHash("#requirements")).toBe("requirements");
    expect(tabFromHash("#tasks")).toBe("tasks");
    expect(tabFromHash("#issues")).toBe("issues");
  });

  it("空片段与未知片段不给页签（由调用方回退默认段）", () => {
    expect(tabFromHash("")).toBeNull();
    expect(tabFromHash("#")).toBeNull();
    expect(tabFromHash("#nope")).toBeNull();
  });
});

describe("resolveTabs", () => {
  it("在真实页面 HTML 上解析出三个页签按钮与三个面板", () => {
    const tabs = resolveTabs(document);

    expect([...tabs.buttons.keys()]).toEqual(["requirements", "tasks", "issues"]);
    expect([...tabs.panels.keys()]).toEqual(["requirements", "tasks", "issues"]);
    expect(tabs.buttons.get("tasks")?.getAttribute("role")).toBe("tab");
    expect(tabs.panels.get("tasks")?.getAttribute("role")).toBe("tabpanel");
  });

  it("缺页签元素时明确失败", () => {
    document.body.innerHTML = "<div></div>";

    expect(() => resolveTabs(document)).toThrow(/页面缺少元素 #tab-requirements/);
  });
});

describe("activateTab", () => {
  it("只让一个页签选中，其余面板隐藏", () => {
    const tabs = resolveTabs(document);

    activateTab(tabs, "tasks");

    expect(activeTab(tabs)).toBe("tasks");
    expect(tabs.buttons.get("tasks")?.getAttribute("aria-selected")).toBe("true");
    expect(tabs.buttons.get("requirements")?.getAttribute("aria-selected")).toBe("false");
    expect(tabs.panels.get("tasks")?.hidden).toBe(false);
    expect(tabs.panels.get("requirements")?.hidden).toBe(true);
    expect(tabs.panels.get("issues")?.hidden).toBe(true);
    expect(window.location.hash).toBe("#tasks");
  });
});

describe("wireTabs", () => {
  it("按地址栏片段决定初始页签，缺省停在需求", () => {
    const tabs = resolveTabs(document);

    wireTabs(tabs);
    expect(activeTab(tabs)).toBe("requirements");

    window.location.hash = "#issues";
    const other = resolveTabs(document);
    wireTabs(other);
    expect(activeTab(other)).toBe("issues");
  });

  it("点击页签按钮切换面板", () => {
    const tabs = resolveTabs(document);
    wireTabs(tabs);

    tabs.buttons.get("issues")?.click();

    expect(activeTab(tabs)).toBe("issues");
    expect(tabs.panels.get("issues")?.hidden).toBe(false);
  });

  it("地址栏片段变化（手动改地址或前进后退）会切到对应页签", () => {
    const tabs = resolveTabs(document);
    wireTabs(tabs);
    expect(activeTab(tabs)).toBe("requirements");

    window.location.hash = "#issues";
    window.dispatchEvent(new Event("hashchange"));
    expect(activeTab(tabs)).toBe("issues");
    expect(tabs.panels.get("issues")?.hidden).toBe(false);

    window.location.hash = "#nope";
    window.dispatchEvent(new Event("hashchange"));
    expect(activeTab(tabs)).toBe("issues");
  });

  it("左右方向键在页签之间移动", () => {
    const tabs = resolveTabs(document);
    wireTabs(tabs);

    tabs.buttons
      .get("requirements")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(activeTab(tabs)).toBe("tasks");

    tabs.buttons
      .get("tasks")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(activeTab(tabs)).toBe("requirements");
  });
});

describe("focusTarget", () => {
  it("跳到对象所在页签并高亮它", () => {
    const tabs = resolveTabs(document);
    wireTabs(tabs);
    const scroll = stubScrollIntoView();
    // 注入的是页面真实结构：表格行必须在表格里，否则 HTML 解析会丢掉它。
    document.getElementById("panel-tasks")!.innerHTML =
      '<table><tbody><tr data-ref="task-blocked" id="row-task"></tr></tbody></table>';

    focusTarget(tabs, "tasks", "task-blocked");

    const row = document.getElementById("row-task");
    expect(activeTab(tabs)).toBe("tasks");
    expect(row?.classList.contains("target")).toBe(true);
    expect(scroll).toHaveBeenCalled();
  });

  it("高亮是暂时的：到点自动撤掉", () => {
    vi.useFakeTimers();
    try {
      const tabs = resolveTabs(document);
      wireTabs(tabs);
      stubScrollIntoView();
      document.getElementById("panel-issues")!.innerHTML =
        '<table><tbody><tr data-ref="req-forgeloop-1" id="row-issue"></tr></tbody></table>';

      focusTarget(tabs, "issues", "req-forgeloop-1");
      expect(document.getElementById("row-issue")?.classList.contains("target")).toBe(true);

      vi.advanceTimersByTime(3000);
      expect(document.getElementById("row-issue")?.classList.contains("target")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("对象不在页面上时只切页签，不抛错", () => {
    const tabs = resolveTabs(document);
    wireTabs(tabs);

    expect(() => {
      focusTarget(tabs, "tasks", "task-missing");
    }).not.toThrow();
    expect(activeTab(tabs)).toBe("tasks");
  });
});
