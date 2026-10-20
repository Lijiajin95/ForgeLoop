/**
 * 渲染层的组件测试：在 jsdom 里把**真实页面 HTML** 交给渲染函数。
 *
 * 覆盖三件在浏览器里才会暴露的事：脚本要的元素 id 是否真的存在（缺一个就抛错，
 * 而不是静默空白）、页签内的层级是否按身份串起来（需求 → 它分解出的任务 → 任务
 * 上的问题）、以及跳转按钮是否把「哪一段的哪个对象」交给导航。
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { TabId } from "../../src/link.js";
import {
  createCollapseState,
  resolveElements,
  type CollapseState,
  type Navigation,
  type PageElements,
} from "../../src/dom.js";
import { clearError, renderProgress, showError } from "../../src/render.js";
import {
  loadPageBody,
  sampleDeliveredTask,
  sampleDocument,
  sampleDraftRequirement,
  sampleIssue,
  sampleOrphanTask,
  sampleRequirement,
  sampleRequirementTask,
  sampleTask,
  REQUIREMENT_TEXT,
} from "../fixtures/page.js";

type ProgressSnapshot = Parameters<typeof renderProgress>[1];

const EMPTY = "—";

/** 记录跳转的导航替身：渲染层只声明「去哪一段的哪个对象」。 */
function navigationSpy(): Navigation & { readonly calls: [TabId, string][] } {
  const calls: [TabId, string][] = [];
  return {
    calls,
    goTo: (tab: TabId, refId: string) => {
      calls.push([tab, refId]);
    },
  };
}

function render(
  navigation: Navigation & { readonly calls: [TabId, string][] } = navigationSpy(),
  snapshot: ProgressSnapshot = sampleDocument(),
  collapse: CollapseState = createCollapseState(),
): {
  elements: PageElements;
  navigation: Navigation & { readonly calls: [TabId, string][] };
  collapse: CollapseState;
} {
  const elements = resolveElements(document);
  renderProgress(elements, snapshot, navigation, collapse);
  return { elements, navigation, collapse };
}

function rows(container: Element | null): HTMLTableRowElement[] {
  // 只取表体行：表头行也是 tr，但不是记录行。
  return [...(container?.querySelectorAll("tbody tr") ?? [])] as HTMLTableRowElement[];
}

function texts(cells: Element | null | undefined): string[] {
  return [...(cells?.querySelectorAll("th,td") ?? [])].map((cell) => cell.textContent ?? "");
}

beforeEach(() => {
  loadPageBody();
});

describe("resolveElements", () => {
  it("在真实页面 HTML 上解析出全部句柄", () => {
    const elements = resolveElements(document);
    expect(elements.requirementsBody.id).toBe("requirements-body");
    expect(elements.refreshButton.tagName).toBe("BUTTON");
    expect(elements.banner.id).toBe("banner");
  });

  it("缺元素时明确失败，不返回半初始化的句柄", () => {
    document.body.innerHTML = "<div></div>";
    expect(() => resolveElements(document)).toThrow(/页面缺少元素 #banner/);
  });
});

describe("renderProgress：计数与页头", () => {
  it("把三段计数写进页签、刷新说明与记录根", () => {
    const { elements } = render();

    expect(elements.countRequirements.textContent).toBe("2");
    expect(elements.countTasks.textContent).toBe("3");
    expect(elements.countIssues.textContent).toBe("2");
    expect(elements.refreshNote.textContent).toBe("自动刷新: 每 60 秒（来源: 配置文件）");
    expect(elements.recordsRoot.textContent).toBe("/tmp/records");
  });
});

describe("renderProgress：需求页签", () => {
  it("每条需求一张卡片，卡头带项目、状态、任务包与交付进展", () => {
    const { elements } = render();

    const cards = elements.requirementsBody.querySelectorAll("article.card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("data-ref")).toBe("req-forgeloop-1");

    const head = cards[0]?.querySelector(".card-head");
    expect(head?.textContent).toContain("req-forgeloop-1");
    expect(head?.textContent).toContain("forgeloop");
    expect(head?.textContent).toContain("plan_proposed");
    expect(head?.textContent).toContain("任务包 v1");
    expect(head?.textContent).toContain("1 / 2 已交付");
  });

  it("需求卡片按身份列出它分解出的任务，并标出是否已派发", () => {
    const { elements } = render();

    const subtasks = rows(elements.requirementsBody.querySelector("article.card table"));
    expect(subtasks.map((row) => row.getAttribute("data-ref"))).toEqual([
      "task-first",
      "task-blocked",
    ]);
    expect(texts(subtasks[0])[0]).toContain("first");
    expect(texts(subtasks[0])[1]).toBe("delivered");
    expect(texts(subtasks[0])[2]).toBe("merged");
    expect(texts(subtasks[1])[2]).toBe("blocked");
    // 失败轮次与工时来自任务记录。
    expect(texts(subtasks[1])[3]).toBe("1 累计；本次剩余 2");
    expect(texts(subtasks[1])[4]).toBe("2 分 5 秒 / 120 分");
  });

  it("计划里还没派发的任务显示「未派发」，不显示执行事实", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        requirements: [
          sampleRequirement({
            tasks: [sampleRequirementTask({ task_id: "later", single_task_id: "task-later" })],
          }),
        ],
        tasks: [sampleTask()],
      }),
    );

    const subtask = rows(elements.requirementsBody.querySelector("article.card table"))[0];
    expect(texts(subtask)[2]).toBe("未派发");
    expect(texts(subtask)[3]).toBe(EMPTY);
    expect(texts(subtask)[4]).toBe(EMPTY);
    expect(subtask?.querySelector("button")).toBeNull();
  });

  it("被阻断的任务在需求卡片里也标红", () => {
    const { elements } = render();

    const subtasks = rows(elements.requirementsBody.querySelector("article.card table"));
    expect(subtasks[0]?.className).toBe("");
    expect(subtasks[1]?.className).toBe("issue");
  });

  it("没有任务包的需求明确写「尚无任务包」", () => {
    const { elements } = render();

    const cards = elements.requirementsBody.querySelectorAll("article.card");
    expect(cards[1]?.textContent).toContain("任务包 —");
    expect(cards[1]?.textContent).toContain("尚无任务包");
    expect(cards[1]?.querySelector("table")).toBeNull();
  });

  it("记录里有原始阻断原因时优先显示它", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        requirements: [
          sampleRequirement({
            blocked_reason: "任务包校验失败: 臆造路径",
            blocked_reason_text: "派生文案",
          }),
        ],
      }),
    );

    const blocked = elements.requirementsBody.querySelector(".blocked");
    expect(blocked?.textContent).toContain("阻断原因：任务包校验失败: 臆造路径");
    expect(blocked?.textContent).not.toContain("派生文案");
  });

  it("已验收需求的收尾文案只作说明，不标红成阻断", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        requirements: [
          sampleRequirement({
            requirement_status: "accepted",
            blocked_reason: "",
            blocked_reason_text: "需求整体验收已完成",
          }),
        ],
        tasks: [],
        issues: [],
      }),
    );

    const note = elements.requirementsBody.querySelector(".note");
    expect(note?.textContent).toContain("说明：需求整体验收已完成");
    expect(elements.requirementsBody.querySelector(".blocked")).toBeNull();
  });

  it("卡片带需求原文：显示最新一版与版本标签，旧版本不再展示", () => {
    const { elements } = render();

    const card = elements.requirementsBody.querySelector("article.card");
    expect(card?.querySelector(".description")?.textContent).toBe(REQUIREMENT_TEXT);
    expect(card?.textContent).toContain("需求原文 v2");
    expect(card?.querySelector(".description")?.textContent).not.toContain(
      "需求：状态页要分三个页签。",
    );
  });

  it("没有需求原文时如实说明，不留空白", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({ requirements: [sampleRequirement({ versions: [] })] }),
    );

    expect(elements.requirementsBody.querySelector(".description")?.textContent).toContain(
      "尚无需求原文",
    );
  });

  it("卡片默认展开；点「收起」把正文藏起来，重绘后仍然收起", () => {
    const { elements, collapse } = render();
    const card = elements.requirementsBody.querySelector<HTMLElement>("article.card");
    const toggle = card?.querySelector<HTMLButtonElement>(".collapse-toggle");

    expect(toggle?.textContent).toBe("收起");
    expect(card?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(false);

    toggle?.click();
    expect(card?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(true);
    expect(collapse.isCollapsed("req-forgeloop-1")).toBe(true);

    render(navigationSpy(), sampleDocument(), collapse);

    const rebuilt = elements.requirementsBody.querySelector<HTMLElement>("article.card");
    expect(rebuilt?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(true);
    expect(rebuilt?.querySelector<HTMLButtonElement>(".collapse-toggle")?.textContent).toBe("展开");
  });

  it("有问题的需求显示问题徽标，点击跳到问题页签并指向该需求", () => {
    const { elements, navigation } = render();

    const badge = elements.requirementsBody.querySelector<HTMLButtonElement>(
      "article.card .issue-chip",
    );
    expect(badge?.textContent).toContain("问题 1");

    badge?.click();
    expect(navigation.calls).toEqual([["issues", "req-forgeloop-1"]]);
  });

  it("点击需求里的任务跳到任务页签并指向该任务记录", () => {
    const { elements, navigation } = render();

    const jump = elements.requirementsBody.querySelector<HTMLButtonElement>(
      'tr[data-ref="task-blocked"] .link-button',
    );
    jump?.click();

    expect(navigation.calls).toEqual([["tasks", "task-blocked"]]);
  });
});

describe("renderProgress：任务页签", () => {
  it("按需求分组：组头是所属需求，组内是该需求分解出的任务", () => {
    const { elements } = render();

    const groups = elements.tasksBody.querySelectorAll("section.group");
    expect([...groups].map((group) => group.getAttribute("data-ref"))).toEqual([
      "req-forgeloop-1",
      "__orphan__:forgeloop",
    ]);
    expect(groups[0]?.querySelector(".group-head")?.textContent).toContain("req-forgeloop-1");
    expect(
      rows(groups[0]?.querySelector("table") ?? null).map((row) => row.getAttribute("data-ref")),
    ).toEqual(["task-first", "task-blocked"]);
  });

  it("任务行显示状态、下一步、失败轮次、工时与阻断原因", () => {
    const { elements } = render();

    const taskRow = rows(elements.tasksBody.querySelector("section.group table"))[1];
    expect(texts(taskRow)[0]).toContain("task-blocked");
    expect(texts(taskRow).slice(1)).toEqual([
      "blocked",
      "人工核对批准绑定（人工）",
      "1 累计；本次剩余 2",
      "2 分 5 秒 / 120 分",
      "任务需要人工核对现场（状态：blocked）",
      "问题 1",
    ]);
    expect(taskRow?.className).toBe("task issue");
  });

  it("正常流程状态不标红", () => {
    const { elements } = render();

    const first = rows(elements.tasksBody.querySelector("section.group table"))[0];
    expect(first?.className).toBe("task");
  });

  it("未关联需求的单任务归入单独的组，并标出所属项目", () => {
    const { elements } = render();

    const groups = elements.tasksBody.querySelectorAll("section.group");
    const orphan = groups[1];
    expect(orphan?.querySelector(".group-head")?.textContent).toContain("未关联需求");
    expect(orphan?.querySelector(".group-head")?.textContent).toContain("forgeloop");
    expect(
      rows(orphan?.querySelector("table") ?? null).map((row) => row.getAttribute("data-ref")),
    ).toEqual(["task-orphan"]);
  });

  it("跨项目的未关联任务按项目分成不同的组，不混在一个组里", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        requirements: [],
        tasks: [
          sampleOrphanTask(),
          sampleOrphanTask({ task_id: "task-other", project: "another" }),
        ],
        issues: [],
      }),
    );

    const groups = elements.tasksBody.querySelectorAll("section.group");
    expect([...groups].map((group) => group.getAttribute("data-ref"))).toEqual([
      "__orphan__:forgeloop",
      "__orphan__:another",
    ]);
    expect(rows(groups[1]?.querySelector("table") ?? null)).toHaveLength(1);
  });

  it("组头可以跳回需求页签并指向该需求", () => {
    const { elements, navigation } = render();

    elements.tasksBody
      .querySelector<HTMLButtonElement>("section.group .group-head button")
      ?.click();

    expect(navigation.calls).toEqual([["requirements", "req-forgeloop-1"]]);
  });

  it("任务行带任务目标；没有任务包时显示缺值", () => {
    const { elements } = render();

    const taskRow = rows(elements.tasksBody.querySelector("section.group table"))[1];
    expect(taskRow?.querySelector(".goal")?.textContent).toBe(
      "把三段拆成页签，并让任务与需求按身份对上",
    );

    render(
      navigationSpy(),
      sampleDocument({ tasks: [sampleTask({ plan: null })] }),
      createCollapseState(),
    );
    expect(
      rows(elements.tasksBody.querySelector("section.group table"))[0]?.querySelector(".goal")
        ?.textContent,
    ).toBe(EMPTY);
  });

  it("任务分组也能折叠，且与需求卡片的折叠互不影响", () => {
    const { elements, collapse } = render();
    const group = elements.tasksBody.querySelector<HTMLElement>("section.group");
    const toggle = group?.querySelector<HTMLButtonElement>(".collapse-toggle");

    toggle?.click();

    expect(group?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(true);
    expect(collapse.isCollapsed("group:req-forgeloop-1")).toBe(true);
    expect(collapse.isCollapsed("req-forgeloop-1")).toBe(false);
  });

  it("任务上的问题徽标跳到问题页签并指向该任务", () => {
    const { elements, navigation } = render();

    elements.tasksBody
      .querySelector<HTMLButtonElement>('tr[data-ref="task-blocked"] .issue-chip')
      ?.click();

    expect(navigation.calls).toEqual([["issues", "task-blocked"]]);
  });
});

describe("renderProgress：问题页签", () => {
  it("问题行把机器标签译成中文，并给出对象所在页签的跳转", () => {
    const { elements, navigation } = render();

    const issues = rows(elements.issuesBody);
    expect(issues).toHaveLength(2);
    expect(texts(issues[0])[0]).toBe("任务阻断");
    expect(issues[0]?.getAttribute("data-ref")).toBe("task-blocked");
    expect(issues[0]?.getAttribute("data-owner")).toBe("req-forgeloop-1");
    expect(issues.map((row) => row.className)).toEqual(["issue", "issue"]);

    issues[0]?.querySelector<HTMLButtonElement>("button")?.click();
    expect(navigation.calls).toEqual([["tasks", "task-blocked"]]);
  });

  it("对象对不上记录时显示为纯文本，不造假链接", () => {
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        issues: [sampleIssue({ kind: "slot_residue", ref_id: "slot-nowhere" })],
      }),
    );

    const cell = rows(elements.issuesBody)[0]?.querySelectorAll("td")[1];
    expect(cell?.textContent).toContain("slot-nowhere");
    expect(cell?.querySelector("button")).toBeNull();
  });

  it("问题行给出对象描述：说明这条问题卡在什么事情上", () => {
    const { elements } = render();

    const cell = rows(elements.issuesBody)[0]?.querySelectorAll("td")[1];
    expect(cell?.querySelector(".object-note")?.textContent).toContain(
      "把三段拆成页签，并让任务与需求按身份对上",
    );
  });

  it("问题行保留对象当前状态，便于判断这条问题还成不成立", () => {
    const { elements } = render();

    const cell = rows(elements.issuesBody)[0]?.querySelectorAll("td")[1];
    expect(cell?.textContent).toContain("blocked");
  });
});

describe("renderProgress：安全与空态", () => {
  it("记录文本一律写入 textContent，不解析成 HTML", () => {
    const injected = "<img src=x onerror=alert(1)>";
    const { elements } = render(
      navigationSpy(),
      sampleDocument({
        requirements: [sampleRequirement({ req_id: injected, tasks: [] })],
        tasks: [],
        issues: [],
      }),
    );

    const card = elements.requirementsBody.querySelector("article.card");
    expect(card?.textContent).toContain(injected);
    expect(elements.requirementsBody.querySelector("img")).toBeNull();
  });

  it("空数据时显示空态提示，有数据时隐藏", () => {
    const elements = resolveElements(document);

    renderProgress(
      elements,
      sampleDocument({ requirements: [], tasks: [], issues: [] }),
      navigationSpy(),
      createCollapseState(),
    );

    expect(elements.requirementsEmpty.style.display).toBe("block");
    expect(elements.tasksEmpty.style.display).toBe("block");
    expect(elements.issuesEmpty.style.display).toBe("block");
    expect(elements.requirementsBody.querySelectorAll("article.card")).toHaveLength(0);

    renderProgress(elements, sampleDocument(), navigationSpy(), createCollapseState());

    expect(elements.requirementsEmpty.style.display).toBe("none");
    expect(elements.tasksEmpty.style.display).toBe("none");
    expect(elements.issuesEmpty.style.display).toBe("none");
  });

  it("重复渲染不累积旧行", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument(), navigationSpy(), createCollapseState());
    renderProgress(elements, sampleDocument(), navigationSpy(), createCollapseState());

    expect(elements.tasksBody.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(elements.requirementsBody.querySelectorAll("article.card")).toHaveLength(2);
  });
});

describe("showError / clearError", () => {
  it("错误可见，并在恢复后清除", () => {
    const elements = resolveElements(document);

    showError(elements, "读取进展失败: HTTP 500");
    expect(elements.banner.style.display).toBe("block");
    expect(elements.banner.textContent).toBe("读取进展失败: HTTP 500");

    clearError(elements);
    expect(elements.banner.style.display).toBe("none");
    expect(elements.banner.textContent).toBe("");
  });
});

describe("夹具自检", () => {
  it("导出的任务与需求都带身份，层级才串得起来", () => {
    expect(sampleDeliveredTask().task_id).toBe("task-first");
    expect(sampleOrphanTask().task_id).toBe("task-orphan");
    expect(sampleDraftRequirement().tasks).toEqual([]);
  });
});
