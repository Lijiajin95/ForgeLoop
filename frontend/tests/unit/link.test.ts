/**
 * 关联规则的单元测试（纯函数，无 DOM）。
 *
 * 三段记录靠身份串起来：需求的任务包条目用 `single_task_id` 指向任务段，问题用
 * `ref_id` 指向需求或任务。页面按这些身份做页签内的层级与跳转，因此规则本身必须
 * 先被独立钉死：错一条，界面上的层级与跳转就会指错对象。
 */

import { describe, expect, it } from "vitest";

import { buildIndex, issuesFor, requirementOfTask, tabOfRef, TAB_IDS } from "../../src/link.js";
import {
  sampleDeliveredTask,
  sampleDocument,
  sampleIssue,
  sampleRequirement,
  sampleRequirementTask,
  sampleTask,
} from "../fixtures/page.js";

describe("buildIndex", () => {
  it("按 single_task_id 把需求分解出的任务与任务记录对上", () => {
    const index = buildIndex(sampleDocument());

    const group = index.groupByRequirement.get("req-forgeloop-1");
    expect(group?.tasks.map((task) => task.task_id)).toEqual(["first", "blocked"]);
    expect(group?.tasks[0]?.task?.status).toBe("merged");
    expect(group?.tasks[1]?.task?.status).toBe("blocked");
    expect(group?.tasks[0]?.single_task_id).toBe("task-first");
  });

  it("计划里还没派发的任务不编造任务记录", () => {
    const index = buildIndex(
      sampleDocument({
        requirements: [
          sampleRequirement({
            tasks: [sampleRequirementTask({ task_id: "later", single_task_id: "task-later" })],
          }),
        ],
        tasks: [sampleTask()],
      }),
    );

    const group = index.groupByRequirement.get("req-forgeloop-1");
    expect(group?.tasks).toEqual([
      { task_id: "later", single_task_id: "task-later", state: "delivered", task: null },
    ]);
  });

  it("没有任务包的需求保留空任务清单", () => {
    const index = buildIndex(sampleDocument());

    expect(index.groupByRequirement.get("req-forgeloop-2")?.tasks).toEqual([]);
    expect(index.groupByRequirement.get("req-forgeloop-2")?.requirement.plan).toBeNull();
  });

  it("未关联需求的单任务单独成组，不被丢进任一需求", () => {
    const index = buildIndex(sampleDocument());

    expect(index.orphanTasks.map((task) => task.task_id)).toEqual(["task-orphan"]);
    expect(index.groupByRequirement.get("req-forgeloop-1")?.tasks).toHaveLength(2);
  });

  it("同一任务记录被两个任务包声明时只归第一个需求（顺序确定）", () => {
    const index = buildIndex(
      sampleDocument({
        requirements: [
          sampleRequirement({ req_id: "req-a", tasks: [sampleRequirementTask()] }),
          sampleRequirement({ req_id: "req-b", tasks: [sampleRequirementTask()] }),
        ],
        tasks: [sampleDeliveredTask()],
        issues: [],
      }),
    );

    expect(index.groupByRequirement.get("req-a")?.tasks[0]?.task?.task_id).toBe("task-first");
    expect(index.groupByRequirement.get("req-b")?.tasks[0]?.task).toBeNull();
    expect(requirementOfTask(index, "task-first")?.req_id).toBe("req-a");
    expect(index.orphanTasks).toEqual([]);
  });

  it("问题按 ref_id 归到对象上，并按所属需求汇总", () => {
    const index = buildIndex(
      sampleDocument({
        issues: [
          sampleIssue(),
          sampleIssue({ kind: "slot_residue", ref_id: "req-forgeloop-2" }),
          sampleIssue({ kind: "task_interrupted", ref_id: "task-nowhere" }),
        ],
      }),
    );

    expect(index.issuesByRef.get("task-blocked")?.map((issue) => issue.kind)).toEqual([
      "task_blocked",
    ]);
    expect(index.issuesByRef.get("task-nowhere")?.map((issue) => issue.kind)).toEqual([
      "task_interrupted",
    ]);
    // 需求的问题 = 需求自身的 + 它分解出的任务的（roll-up）。
    expect(
      index.groupByRequirement.get("req-forgeloop-1")?.issues.map((issue) => issue.kind),
    ).toEqual(["task_blocked"]);
    expect(
      index.groupByRequirement.get("req-forgeloop-2")?.issues.map((issue) => issue.kind),
    ).toEqual(["slot_residue"]);
    // 对不上任何记录的问题不归给任何需求，但仍在问题段里保留。
    expect(index.unknownIssues.map((issue) => issue.ref_id)).toEqual(["task-nowhere"]);
  });

  it("同一对象的多条问题保持记录顺序", () => {
    const index = buildIndex(
      sampleDocument({
        issues: [sampleIssue({ detail: "第一条" }), sampleIssue({ detail: "第二条" })],
      }),
    );

    expect(index.issuesByRef.get("task-blocked")?.map((issue) => issue.detail)).toEqual([
      "第一条",
      "第二条",
    ]);
  });

  it("空快照得到空索引", () => {
    const index = buildIndex(sampleDocument({ requirements: [], tasks: [], issues: [] }));

    expect(index.groupByRequirement.size).toBe(0);
    expect(index.orphanTasks).toEqual([]);
    expect(index.unknownIssues).toEqual([]);
  });
});

describe("requirementOfTask", () => {
  it("由任务身份找回它所属的需求", () => {
    const index = buildIndex(sampleDocument());

    expect(requirementOfTask(index, "task-blocked")?.req_id).toBe("req-forgeloop-1");
  });

  it("未关联需求的任务返回 null，不猜归属", () => {
    const index = buildIndex(sampleDocument());

    expect(requirementOfTask(index, "task-orphan")).toBeNull();
    expect(requirementOfTask(index, "task-not-in-records")).toBeNull();
  });
});

describe("tabOfRef", () => {
  it("需求身份指向需求页签、任务身份指向任务页签", () => {
    const index = buildIndex(sampleDocument());

    expect(tabOfRef(index, "req-forgeloop-1")).toBe("requirements");
    expect(tabOfRef(index, "task-blocked")).toBe("tasks");
  });

  it("对不上的对象返回 null（页面显示为纯文本，不做假链接）", () => {
    const index = buildIndex(sampleDocument({ tasks: [sampleDeliveredTask()] }));

    expect(tabOfRef(index, "task-orphan")).toBeNull();
  });

  it("页签身份集合固定为三段，且与页面容器一一对应", () => {
    expect(TAB_IDS).toEqual(["requirements", "tasks", "issues"]);
  });
});

describe("issuesFor", () => {
  it("返回对象上的问题，没有时返回空数组而不是 undefined", () => {
    const index = buildIndex(sampleDocument());

    expect(issuesFor(index, "task-blocked").map((issue) => issue.kind)).toEqual(["task_blocked"]);
    expect(issuesFor(index, "task-first")).toEqual([]);
    expect(issuesFor(index, "task-not-in-records")).toEqual([]);
  });
});
