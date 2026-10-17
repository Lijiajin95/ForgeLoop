/**
 * 渲染层的组件测试：在 jsdom 里把**真实页面 HTML** 交给渲染函数。
 *
 * 覆盖两件在浏览器里才会暴露的事：脚本要的元素 id 是否真的存在（缺一个就抛错，
 * 而不是静默空白），以及表格单元格是否写进了记录里的值。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { clearError, renderProgress, resolveElements, showError } from "../../src/render.js";
import {
  loadPageBody,
  sampleDocument,
  sampleIssue,
  sampleRequirement,
  sampleTask,
} from "../fixtures/page.js";

const EMPTY = "—";

function cellsOf(body: HTMLElement, rowIndex: number): string[] {
  const row = body.querySelectorAll("tr")[rowIndex];
  if (row === undefined) {
    throw new Error(`第 ${rowIndex} 行不存在`);
  }
  return [...row.querySelectorAll("td")].map((td) => td.textContent);
}

beforeEach(() => {
  loadPageBody();
});

describe("resolveElements", () => {
  it("在真实页面 HTML 上解析出全部句柄", () => {
    const elements = resolveElements(document);
    expect(elements.requirementsBody.tagName).toBe("TBODY");
    expect(elements.refreshButton.tagName).toBe("BUTTON");
    expect(elements.banner.id).toBe("banner");
  });

  it("缺元素时明确失败，不返回半初始化的句柄", () => {
    document.body.innerHTML = "<div></div>";
    expect(() => resolveElements(document)).toThrow(/页面缺少元素 #banner/);
  });
});

describe("renderProgress", () => {
  it("写入三段计数与刷新说明", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument());

    expect(elements.countRequirements.textContent).toBe("1");
    expect(elements.countTasks.textContent).toBe("1");
    expect(elements.countIssues.textContent).toBe("1");
    expect(elements.refreshNote.textContent).toBe("自动刷新: 每 60 秒（来源: 配置文件）");
    expect(elements.recordsRoot.textContent).toBe("/tmp/records");
  });

  it("需求行显示任务进展、任务包版本与阻断原因", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument());

    expect(cellsOf(elements.requirementsBody, 0)).toEqual([
      "req-forgeloop-1",
      "forgeloop",
      "plan_proposed",
      "v1",
      "1 / 2 已交付",
      "批准或重新生成任务包（人工）",
      "未找到该需求的任务包批准；未批准不执行",
    ]);
  });

  it("记录里有原始阻断原因时优先显示它", () => {
    const elements = resolveElements(document);

    renderProgress(
      elements,
      sampleDocument({
        requirements: [
          sampleRequirement({
            blocked_reason: "任务包校验失败: 臆造路径",
            blocked_reason_text: "派生文案",
          }),
        ],
      }),
    );

    expect(cellsOf(elements.requirementsBody, 0)[6]).toBe("任务包校验失败: 臆造路径");
  });

  it("没有任务包时版本列显示缺值", () => {
    const elements = resolveElements(document);

    renderProgress(
      elements,
      sampleDocument({ requirements: [sampleRequirement({ plan: null, tasks: [] })] }),
    );

    expect(cellsOf(elements.requirementsBody, 0)[3]).toBe(EMPTY);
    expect(cellsOf(elements.requirementsBody, 0)[4]).toBe(EMPTY);
  });

  it("阻断任务整行标红并显示失败轮次与工时", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument());

    expect(cellsOf(elements.tasksBody, 0)).toEqual([
      "task-blocked",
      "forgeloop",
      "blocked",
      "人工核对批准绑定（人工）",
      "1 累计；本次剩余 2",
      "2 分 5 秒 / 120 分",
      "任务需要人工核对现场（状态：blocked）",
    ]);
    expect(elements.tasksBody.querySelector("tr")?.className).toBe("issue");
  });

  it("正常流程状态不标红", () => {
    const elements = resolveElements(document);

    renderProgress(
      elements,
      sampleDocument({ tasks: [sampleTask({ status: "awaiting_plan_approval" })] }),
    );

    expect(elements.tasksBody.querySelector("tr")?.className).toBe("");
  });

  it("问题行把机器标签译成中文并标红", () => {
    const elements = resolveElements(document);

    renderProgress(
      elements,
      sampleDocument({
        issues: [sampleIssue(), sampleIssue({ kind: "slot_residue", ref_id: "req-1" })],
      }),
    );

    expect(cellsOf(elements.issuesBody, 0)[0]).toBe("任务阻断");
    expect(cellsOf(elements.issuesBody, 1)[0]).toBe("执行槽位残留");
    expect(elements.issuesBody.querySelectorAll("tr.issue")).toHaveLength(2);
  });

  it("记录文本一律写入 textContent，不解析成 HTML", () => {
    const elements = resolveElements(document);
    const injected = "<img src=x onerror=alert(1)>";

    renderProgress(
      elements,
      sampleDocument({ requirements: [sampleRequirement({ req_id: injected })] }),
    );

    const firstCell = elements.requirementsBody.querySelector("td");
    expect(firstCell?.textContent).toBe(injected);
    expect(firstCell?.querySelector("img")).toBeNull();
  });

  it("空数据时隐藏空态提示，有数据时显示", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument({ requirements: [], tasks: [], issues: [] }));

    expect(elements.requirementsEmpty.style.display).toBe("block");
    expect(elements.tasksEmpty.style.display).toBe("block");
    expect(elements.issuesEmpty.style.display).toBe("block");
    expect(elements.requirementsBody.querySelectorAll("tr")).toHaveLength(0);

    renderProgress(elements, sampleDocument());

    expect(elements.requirementsEmpty.style.display).toBe("none");
    expect(elements.tasksEmpty.style.display).toBe("none");
    expect(elements.issuesEmpty.style.display).toBe("none");
  });

  it("重复渲染不累积旧行", () => {
    const elements = resolveElements(document);

    renderProgress(elements, sampleDocument());
    renderProgress(elements, sampleDocument());

    expect(elements.tasksBody.querySelectorAll("tr")).toHaveLength(1);
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
