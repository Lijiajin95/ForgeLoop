/**
 * 记录索引与档案的组件测试：在 jsdom 里把**真实页面 HTML** 交给渲染函数。
 *
 * 覆盖四件事：脚本要的元素 id 是否真的存在、索引是否以身份+描述为主、档案是否
 * 带齐指标与关联、以及跳转按钮是否把「哪一段的哪个对象」交给导航。
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { TabId } from "../../src/link.js";
import { resolveElements, type Navigation, type PageElements } from "../../src/dom.js";
import { EMPTY_SELECTION, type RecordSelection, type RecordTab } from "../../src/records.js";
import { clearError, renderProgress, showError, type ProgressActions } from "../../src/render.js";
import {
  loadPageBody,
  sampleDocument,
  sampleIssue,
  sampleRequirement,
  sampleTask,
  REQUIREMENT_TEXT,
} from "../fixtures/page.js";

type ProgressSnapshot = Parameters<typeof renderProgress>[1];

function navigationSpy(): Navigation & { readonly calls: [TabId, string][] } {
  const calls: [TabId, string][] = [];
  return {
    calls,
    goTo: (tab: TabId, refId: string) => {
      calls.push([tab, refId]);
    },
  };
}

function actionSpy(): ProgressActions & {
  readonly selected: [RecordTab, string][];
  readonly operated: string[];
} {
  const selected: [RecordTab, string][] = [];
  const operated: string[] = [];
  return {
    selected,
    operated,
    onSelect: (tab, key) => {
      selected.push([tab, key]);
    },
    onOperate: (reqId) => {
      operated.push(reqId);
    },
  };
}

function render(
  navigation: Navigation & { readonly calls: [TabId, string][] } = navigationSpy(),
  snapshot: ProgressSnapshot = sampleDocument(),
  selection: RecordSelection = EMPTY_SELECTION,
  actions: ProgressActions = actionSpy(),
): {
  elements: PageElements;
  navigation: Navigation & { readonly calls: [TabId, string][] };
  actions: ProgressActions;
  selection: RecordSelection;
} {
  const elements = resolveElements(document);
  const resolved = renderProgress(elements, snapshot, navigation, selection, actions);
  return { elements, navigation, actions, selection: resolved };
}

function rows(container: Element | null): HTMLTableRowElement[] {
  return [...(container?.querySelectorAll("tbody tr") ?? [])] as HTMLTableRowElement[];
}

beforeEach(() => {
  loadPageBody();
});

describe("resolveElements", () => {
  it("在真实页面 HTML 上解析出全部句柄", () => {
    const elements = resolveElements(document);
    expect(elements.requirementsBody.id).toBe("requirements-body");
    expect(elements.requirementsDetail.id).toBe("requirements-detail");
    expect(elements.operationsOpen.id).toBe("operations-open");
    expect(elements.refreshButton.tagName).toBe("BUTTON");
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

  it("默认选中第一条需求，并返回解析后的选择", () => {
    const { selection } = render();
    expect(selection.requirement).toBe("req-forgeloop-1");
    expect(selection.task).toBe("task-first");
    expect(selection.issue).toBe("task_blocked:task-blocked");
  });
});

describe("需求索引与档案", () => {
  it("索引以 ID + 最新原文为主，不铺开指标", () => {
    const { elements } = render();
    const items = [...elements.requirementsBody.querySelectorAll<HTMLButtonElement>(".record-row")];

    expect(items).toHaveLength(2);
    expect(items[0]?.dataset["ref"]).toBe("req-forgeloop-1");
    expect(items[0]?.classList.contains("is-selected")).toBe(true);
    expect(items[0]?.textContent).toContain("req-forgeloop-1");
    expect(items[0]?.textContent).toContain("状态页要把需求、任务、问题分成三个页签");
    expect(items[0]?.textContent).toContain("2 任务");
    expect(items[0]?.querySelector("table")).toBeNull();
  });

  it("档案展示完整原文、指标、任务与问题", () => {
    const { elements } = render();
    const detail = elements.requirementsDetail;

    expect(detail.querySelector(".dossier-id")?.textContent).toBe("req-forgeloop-1");
    expect(detail.querySelector(".dossier-lead")?.textContent).toContain(REQUIREMENT_TEXT);
    expect(detail.textContent).toContain("任务包 v1");
    expect(detail.textContent).toContain("1 / 2 已交付");
    expect(rows(detail.querySelector("table"))).toHaveLength(2);
    expect(detail.textContent).toContain("任务执行被阻断");
  });

  it("点索引行把身份交给装配层，不自己切详情", () => {
    const actions = actionSpy();
    const { elements } = render(navigationSpy(), sampleDocument(), EMPTY_SELECTION, actions);
    elements.requirementsBody.querySelectorAll<HTMLButtonElement>(".record-row")[1]?.click();
    expect(actions.selected).toEqual([["requirements", "req-forgeloop-2"]]);
  });

  it("档案里的任务链接回到任务页签", () => {
    const navigation = navigationSpy();
    const { elements } = render(navigation);
    elements.requirementsDetail.querySelector<HTMLButtonElement>(".task-link")?.click();
    expect(navigation.calls).toEqual([["tasks", "task-first"]]);
  });

  it("档案里的「处理这条需求」打开写入口", () => {
    const actions = actionSpy();
    const { elements } = render(navigationSpy(), sampleDocument(), EMPTY_SELECTION, actions);
    [...elements.requirementsDetail.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "处理这条需求")
      ?.click();
    expect(actions.operated).toEqual(["req-forgeloop-1"]);
  });
});

describe("任务索引与档案", () => {
  it("索引列出已派发任务与未关联需求的单任务", () => {
    const { elements } = render();
    const items = [...elements.tasksBody.querySelectorAll<HTMLButtonElement>(".record-row")];
    expect(items.map((item) => item.dataset["ref"])).toEqual([
      "task-first",
      "task-blocked",
      "task-orphan",
    ]);
    expect(items[0]?.textContent).toContain("先交付一个正常任务");
    expect(items[2]?.textContent).toContain("未关联需求");
  });

  it("档案展示目标、状态、失败轮次、工时与归属", () => {
    const { elements } = render();
    const detail = elements.tasksDetail;
    expect(detail.querySelector(".dossier-id")?.textContent).toBe("task-first");
    expect(detail.querySelector(".dossier-lead")?.textContent).toBe("先交付一个正常任务");
    expect(detail.textContent).toContain("merged");
    expect(detail.textContent).toContain("0 累计");
    expect(detail.textContent).toContain("10 分 / 120 分");
    expect(detail.textContent).toContain("req-forgeloop-1");
  });

  it("点任务索引行只交任务身份", () => {
    const actions = actionSpy();
    const { elements } = render(navigationSpy(), sampleDocument(), EMPTY_SELECTION, actions);
    elements.tasksBody.querySelectorAll<HTMLButtonElement>(".record-row")[1]?.click();
    expect(actions.selected).toEqual([["tasks", "task-blocked"]]);
  });

  it("任务档案的「查看所属需求」回到需求页签", () => {
    const navigation = navigationSpy();
    const { elements } = render(navigation);
    [...elements.tasksDetail.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "查看所属需求")
      ?.click();
    expect(navigation.calls).toEqual([["requirements", "req-forgeloop-1"]]);
  });
});

describe("问题索引与档案", () => {
  it("索引以对象身份 + 摘要为主，并标出种类", () => {
    const { elements } = render();
    const items = [...elements.issuesBody.querySelectorAll<HTMLButtonElement>(".record-row")];
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset["ref"]).toBe("task-blocked");
    expect(items[0]?.textContent).toContain("任务阻断");
    expect(items[0]?.textContent).toContain("任务执行被阻断");
  });

  it("档案展示依据、对象状态、所属需求与对象入口", () => {
    const { elements } = render();
    const detail = elements.issuesDetail;
    expect(detail.querySelector(".dossier-id")?.textContent).toBe("task-blocked");
    expect(detail.textContent).toContain("任务执行被阻断");
    expect(detail.textContent).toContain("blocked");
    expect(detail.textContent).toContain("req-forgeloop-1");
    expect(detail.querySelector(".dossier-body")?.textContent).toContain("人工核对");
  });

  it("问题的对象入口跳到对象所在页签", () => {
    const navigation = navigationSpy();
    const { elements } = render(navigation);
    elements.issuesDetail.querySelector<HTMLButtonElement>(".button")?.click();
    expect(navigation.calls).toEqual([["tasks", "task-blocked"]]);
  });
});

describe("空态与选择回退", () => {
  it("没有记录时索引与档案显示明确空态", () => {
    const empty = sampleDocument({
      requirements: [],
      tasks: [],
      issues: [],
      counts: { projects: 1, requirements: 0, tasks: 0, issues: 0 },
    });
    const { elements, selection } = render(navigationSpy(), empty);
    expect(selection).toEqual(EMPTY_SELECTION);
    expect(elements.requirementsEmpty.style.display).toBe("block");
    expect(elements.tasksEmpty.style.display).toBe("block");
    expect(elements.issuesEmpty.style.display).toBe("block");
    expect(elements.requirementsDetail.textContent).toContain("没有可展示的需求");
    expect(elements.issuesDetail.textContent).toContain("没有待处理问题");
  });

  it("原选择消失时回退到仍存在的记录", () => {
    const snapshot = sampleDocument({
      requirements: [sampleRequirement({ req_id: "req-new" })],
      tasks: [sampleTask({ task_id: "task-new" })],
      issues: [sampleIssue({ ref_id: "task-new" })],
      counts: { projects: 1, requirements: 1, tasks: 1, issues: 1 },
    });
    const { selection } = render(navigationSpy(), snapshot, {
      requirement: "req-gone",
      task: "task-gone",
      issue: "kind:gone",
    });
    expect(selection.requirement).toBe("req-new");
    expect(selection.task).toBe("task-new");
    expect(selection.issue).toBe("task_blocked:task-new");
  });
});

describe("错误横幅", () => {
  it("显示与清除走同一对函数", () => {
    const elements = resolveElements(document);
    showError(elements, "读取失败");
    expect(elements.banner.style.display).toBe("block");
    expect(elements.banner.textContent).toBe("读取失败");
    clearError(elements);
    expect(elements.banner.style.display).toBe("none");
  });
});

describe("档案边缘状态", () => {
  it("阻断原因用告警样式，正常终态用说明样式", () => {
    const blocked = sampleDocument({
      requirements: [
        sampleRequirement({
          requirement_status: "blocked",
          blocked_reason: "等待人工核对批准绑定",
        }),
      ],
      tasks: [],
      issues: [],
      counts: { projects: 1, requirements: 1, tasks: 0, issues: 0 },
    });
    let rendered = render(navigationSpy(), blocked);
    expect(rendered.elements.requirementsDetail.querySelector(".callout-alert")).not.toBeNull();

    const normal = sampleDocument({
      requirements: [
        sampleRequirement({ requirement_status: "accepted", blocked_reason_text: "" }),
      ],
      tasks: [],
      issues: [],
      counts: { projects: 1, requirements: 1, tasks: 0, issues: 0 },
    });
    rendered = render(navigationSpy(), normal);
    expect(rendered.elements.requirementsDetail.querySelector(".callout")).toBeNull();
  });

  it("没有任务的需求显示空态，未关联需求的任务不显示归属按钮", () => {
    const snapshot = sampleDocument();
    const withDraft = render(navigationSpy(), snapshot, {
      ...EMPTY_SELECTION,
      requirement: "req-forgeloop-2",
    });
    expect(withDraft.elements.requirementsDetail.textContent).toContain("尚无任务包。");

    const orphan = render(navigationSpy(), snapshot, { ...EMPTY_SELECTION, task: "task-orphan" });
    expect(orphan.elements.tasksDetail.textContent).toContain("未关联需求");
    expect(
      [...orphan.elements.tasksDetail.querySelectorAll("button")].some(
        (button) => button.textContent === "查看所属需求",
      ),
    ).toBe(false);
  });

  it("对不上记录的问题只显示纯文本，不伪造对象入口", () => {
    const snapshot = sampleDocument({
      issues: [sampleIssue({ ref_id: "slot-missing", kind: "slot_residue" })],
      counts: { projects: 1, requirements: 2, tasks: 3, issues: 1 },
    });
    const { elements } = render(navigationSpy(), snapshot);
    expect(elements.issuesDetail.textContent).toContain("执行槽位残留");
    expect(elements.issuesDetail.textContent).toContain("—");
    expect(
      [...elements.issuesDetail.querySelectorAll("button")].some(
        (button) => button.textContent === "查看对象",
      ),
    ).toBe(false);
  });

  it("renderProgress 的默认选择与动作可省略", () => {
    const elements = resolveElements(document);
    const selection = renderProgress(elements, sampleDocument(), navigationSpy());
    expect(selection.requirement).toBe("req-forgeloop-1");
  });
});
