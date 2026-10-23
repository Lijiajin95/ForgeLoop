/**
 * `@` 引用规则的单元测试：查询识别、候选过滤、插入与身份格式都在纯函数里。
 */

import { describe, expect, it } from "vitest";

import {
  filterMentions,
  insertMention,
  mentionItems,
  mentionKindLabel,
  mentionQuery,
} from "../../src/mentions.js";
import { sampleDocument } from "../fixtures/page.js";

const items = mentionItems(sampleDocument());

describe("mentionItems", () => {
  it("摊平需求、任务与问题，身份可直接插入", () => {
    expect(items).toHaveLength(7);
    expect(items[0]?.kind).toBe("requirement");
    expect(items[0]?.id).toBe("req-forgeloop-1");
    expect(items[0]?.detail).toContain("状态页");
    expect(items[2]?.kind).toBe("task");
    expect(items[2]?.id).toBe("task-blocked");
    expect(items[3]?.id).toBe("task-first");
    expect(items[5]?.kind).toBe("issue");
    expect(items[5]?.id).toBe("issue:task_blocked:task-blocked");
    expect(items[5]?.title).toContain("任务阻断");
  });

  it("没有原文/目标/摘要时给出可读空态", () => {
    const sparse = mentionItems(
      sampleDocument({
        requirements: [
          {
            req_id: "req-empty",
            project: "forgeloop",
            requirement_status: "draft",
            plan: null,
            versions: [],
            tasks: [],
            next_step: null,
            blocked_reason: "",
            blocked_reason_text: "",
          },
        ],
        tasks: [
          {
            task_id: "task-empty",
            project: "forgeloop",
            status: "queued",
            plan: null,
            next_action: null,
            failures: {
              cumulative: 0,
              remaining_in_current_grant: 0,
              awaiting_grant_decision: false,
            },
            budget: { consumed_seconds: 0, limit_seconds: 0 },
            blocked_reason_text: "",
          },
        ],
        issues: [
          {
            kind: "other",
            project: "forgeloop",
            ref_id: "req-empty",
            summary: "",
            detail: "",
          },
        ],
        counts: { projects: 1, requirements: 1, tasks: 1, issues: 1 },
      }),
    );
    expect(sparse[0]?.detail).toBe("尚无需求原文。");
    expect(sparse[1]?.detail).toBe("尚无任务目标。");
    expect(sparse[2]?.title).toContain("other");
  });

  it("空记录也能安全摊平", () => {
    expect(
      mentionItems(
        sampleDocument({
          requirements: [],
          tasks: [],
          issues: [],
          counts: { projects: 1, requirements: 0, tasks: 0, issues: 0 },
        }),
      ),
    ).toEqual([]);
  });
});

describe("mentionQuery", () => {
  it("识别开头或分隔符后的 @ 查询", () => {
    expect(mentionQuery("@task", 5)).toEqual({ start: 0, end: 5, query: "task" });
    expect(mentionQuery("看看 @req-1", 9)).toEqual({ start: 3, end: 9, query: "req-1" });
    expect(mentionQuery("，@任务", 4)).toEqual({ start: 1, end: 4, query: "任务" });
  });

  it("不把邮箱里的 @、空白后的内容当成引用", () => {
    expect(mentionQuery("a@b.com", 7)).toBeNull();
    expect(mentionQuery("@task more", 10)).toBeNull();
    expect(mentionQuery("no mention", 10)).toBeNull();
  });

  it("光标位置决定查询终点", () => {
    expect(mentionQuery("@task rest", 5)).toEqual({ start: 0, end: 5, query: "task" });
    expect(mentionQuery("@task rest", 8)).toBeNull();
  });
});

describe("filterMentions", () => {
  it("空查询保持记录顺序并受上限约束", () => {
    expect(filterMentions(items, "").map((item) => item.id)).toEqual(
      items.slice(0, 12).map((item) => item.id),
    );
    expect(filterMentions(items, "", 2)).toHaveLength(2);
  });

  it("身份前缀优先，其次身份包含，最后说明命中", () => {
    expect(filterMentions(items, "task-blocked")[0]?.id).toBe("task-blocked");
    expect(filterMentions(items, "req-forgeloop-2")[0]?.id).toBe("req-forgeloop-2");
    expect(filterMentions(items, "阻断").every((item) => item.kind === "issue")).toBe(true);
  });

  it("没有命中返回空数组", () => {
    expect(filterMentions(items, "不存在的记录")).toEqual([]);
  });
});

describe("insertMention", () => {
  it("替换查询片段、补空格并移动光标", () => {
    const query = mentionQuery("看看 @task", 8);
    expect(query).not.toBeNull();
    if (query === null) {
      return;
    }
    const result = insertMention(
      "看看 @task",
      query,
      items.find((item) => item.id === "task-first")!,
    );
    expect(result.value).toBe("看看 @task-first ");
    expect(result.caret).toBe(result.value.length);
  });

  it("保留查询后面的文本", () => {
    const query = mentionQuery("@task 后面", 5);
    if (query === null) {
      throw new Error("测试查询应当有效");
    }
    const result = insertMention(
      "@task 后面",
      query,
      items.find((item) => item.id === "task-first")!,
    );
    expect(result.value).toBe("@task-first  后面");
  });
});

describe("mentionKindLabel", () => {
  it("三种记录都有中文标签", () => {
    expect(mentionKindLabel("requirement")).toBe("需求");
    expect(mentionKindLabel("task")).toBe("任务");
    expect(mentionKindLabel("issue")).toBe("问题");
  });
});
