/**
 * 折叠行为的组件测试（jsdom，无网络、无页面 HTML）。
 *
 * 折叠状态必须能被单独持有：页面每 60 秒重绘一次内容，若状态只写在 DOM 上，用户
 * 展开／收起的选择会在下一次刷新时被抹掉。因此这里核对三件事——默认展开、点击
 * 切换时 DOM 与状态同步、以及用同一份状态重建（等价于重绘）后仍然保持收起。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { collapsible, createCollapseState, type CollapseState } from "../../src/dom.js";

const ID = "req-forgeloop-1";

function build(state: CollapseState) {
  const section = collapsible(document, ID, state);
  section.head.appendChild(document.createTextNode("卡片头"));
  section.body.appendChild(document.createTextNode("卡片内容"));
  document.body.append(section.head, section.body);
  return section;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createCollapseState", () => {
  it("默认全部展开", () => {
    const state = createCollapseState();

    expect(state.isCollapsed(ID)).toBe(false);
  });

  it("可以按给定身份初始折叠，并能改回来", () => {
    const state = createCollapseState([ID]);

    expect(state.isCollapsed(ID)).toBe(true);
    expect(state.isCollapsed("req-other")).toBe(false);

    state.setCollapsed(ID, false);

    expect(state.isCollapsed(ID)).toBe(false);
  });
});

describe("collapsible", () => {
  it("默认展开：内容可见、开关说明当前可收起", () => {
    const section = build(createCollapseState());

    expect(section.body.hidden).toBe(false);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(section.toggle.getAttribute("aria-controls")).toBe(section.body.id);
    expect(section.toggle.textContent).toBe("收起");
  });

  it("点击开关：内容藏起来、状态记为折叠、开关改说「展开」", () => {
    const state = createCollapseState();
    const section = build(state);

    section.toggle.click();

    expect(section.body.hidden).toBe(true);
    expect(state.isCollapsed(ID)).toBe(true);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section.toggle.textContent).toBe("展开");
  });

  it("再点一次恢复展开", () => {
    const state = createCollapseState();
    const section = build(state);

    section.toggle.click();
    section.toggle.click();

    expect(section.body.hidden).toBe(false);
    expect(state.isCollapsed(ID)).toBe(false);
    expect(section.toggle.textContent).toBe("收起");
  });

  it("用同一份状态重建（等价于自动刷新重绘）后仍是收起", () => {
    const state = createCollapseState();
    build(state).toggle.click();

    document.body.innerHTML = "";
    const rebuilt = build(state);

    expect(rebuilt.body.hidden).toBe(true);
    expect(rebuilt.toggle.textContent).toBe("展开");
  });
});
