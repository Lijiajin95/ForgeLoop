/**
 * 记录索引/档案视图模型的单元测试：列表条目、选择回退与身份跳转都在纯函数里。
 */

import { describe, expect, it } from "vitest";

import { buildIndex } from "../../src/link.js";
import {
  EMPTY_SELECTION,
  issueKey,
  issueList,
  ownerOfRef,
  objectStatus,
  requirementDescription,
  requirementGroupOf,
  requirementList,
  resolveSelection,
  selectRecord,
  selectRef,
  taskDescription,
  taskList,
} from "../../src/records.js";
import {
  sampleDeliveredTask,
  sampleDocument,
  sampleIssue,
  sampleRequirement,
  sampleTask,
} from "../fixtures/page.js";

const snapshot = sampleDocument();
const index = buildIndex(snapshot);

describe("列表条目", () => {
  it("需求索引带最新原文、任务数与问题数", () => {
    const items = requirementList(index);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "req-forgeloop-1",
      status: "plan_proposed",
      project: "forgeloop",
      taskCount: 2,
      issueCount: 1,
    });
    expect(items[0]?.description).toContain("三个页签");
    expect(items[1]?.status).toBe("draft");
    expect(items[1]?.taskCount).toBe(0);
  });

  it("任务索引先按需求分组，再列未关联需求的单任务", () => {
    const items = taskList(index);
    expect(items.map((item) => item.id)).toEqual(["task-first", "task-blocked", "task-orphan"]);
    expect(items[0]?.requirementId).toBe("req-forgeloop-1");
    expect(items[2]?.requirementId).toBe("");
    expect(items[1]?.issueCount).toBe(1);
  });

  it("问题索引带种类、对象状态与所属需求", () => {
    const items = issueList(snapshot, index);
    expect(items).toHaveLength(2);
    expect(items[0]?.key).toBe("task_blocked:task-blocked");
    expect(items[0]?.status).toBe("blocked");
    expect(items[0]?.owner).toBe("req-forgeloop-1");
    expect(items[1]?.owner).toBe("req-forgeloop-2");
  });
});

describe("描述与空态", () => {
  it("需求没有原文时给出可读空态", () => {
    expect(requirementDescription(sampleRequirement({ versions: [] }))).toBe("尚无需求原文。");
  });

  it("任务没有目标时给出可读空态", () => {
    expect(taskDescription(sampleTask({ plan: null }))).toBe("尚无任务目标。");
  });

  it("对象状态与归属对不上记录时为空", () => {
    expect(objectStatus(index, "missing")).toBe("");
    expect(ownerOfRef(index, "missing")).toBe("");
  });
});

describe("选择", () => {
  it("初次选择落第一条", () => {
    expect(resolveSelection(index, snapshot, EMPTY_SELECTION)).toEqual({
      requirement: "req-forgeloop-1",
      task: "task-first",
      issue: "task_blocked:task-blocked",
    });
  });

  it("仍存在的选择保持不动，消失的回到第一条", () => {
    expect(
      resolveSelection(index, snapshot, {
        requirement: "req-forgeloop-2",
        task: "task-orphan",
        issue: "requirement_blocked:req-forgeloop-2",
      }),
    ).toEqual({
      requirement: "req-forgeloop-2",
      task: "task-orphan",
      issue: "requirement_blocked:req-forgeloop-2",
    });

    expect(
      resolveSelection(index, snapshot, {
        requirement: "gone",
        task: "gone",
        issue: "gone",
      }),
    ).toEqual({
      requirement: "req-forgeloop-1",
      task: "task-first",
      issue: "task_blocked:task-blocked",
    });
  });

  it("点索引只替换对应那一段", () => {
    const base = resolveSelection(index, snapshot, EMPTY_SELECTION);
    expect(selectRecord(base, "requirements", "req-forgeloop-2").requirement).toBe(
      "req-forgeloop-2",
    );
    expect(selectRecord(base, "tasks", "task-orphan").task).toBe("task-orphan");
    expect(selectRecord(base, "issues", "requirement_blocked:req-forgeloop-2").issue).toBe(
      "requirement_blocked:req-forgeloop-2",
    );
  });

  it("按对象身份跳转时同步对应记录", () => {
    const base = EMPTY_SELECTION;
    expect(selectRef(index, snapshot, base, "requirements", "req-forgeloop-2").requirement).toBe(
      "req-forgeloop-2",
    );
    expect(selectRef(index, snapshot, base, "tasks", "task-blocked").task).toBe("task-blocked");
    expect(selectRef(index, snapshot, base, "issues", "req-forgeloop-2").issue).toBe(
      "requirement_blocked:req-forgeloop-2",
    );
    expect(selectRef(index, snapshot, base, "tasks", "missing")).toBe(base);
  });

  it("需求分组可按身份取回", () => {
    expect(requirementGroupOf(index, "req-forgeloop-1")?.tasks).toHaveLength(2);
    expect(requirementGroupOf(index, "missing")).toBeNull();
  });
});

describe("问题身份", () => {
  it("同一对象上的不同种类问题有不同键", () => {
    const first = sampleIssue({ kind: "task_blocked", ref_id: "task-1" });
    const second = sampleIssue({ kind: "task_interrupted", ref_id: "task-1" });
    expect(issueKey(first)).not.toBe(issueKey(second));
  });

  it("任务条目与问题计数来自同一份快照", () => {
    expect(taskList(index).find((item) => item.id === "task-first")?.issueCount).toBe(0);
    expect(sampleDeliveredTask().task_id).toBe("task-first");
  });
});
