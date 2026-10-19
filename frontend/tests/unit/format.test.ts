/**
 * 纯格式化规则的单元测试（对应 Python 的 domain 层测试）。
 *
 * 这些规则决定页面显示什么文字，是变异测试的主要对象：边界值（59/60/61 秒、
 * 缺值、0、未知标签）必须钉死，不能靠渲染层顺带验证。
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY,
  budgetText,
  countdownText,
  deliveryProgress,
  excerpt,
  failureText,
  formatSeconds,
  formatTimestamp,
  issueBadgeText,
  issueKindLabel,
  latestVersion,
  nextStepText,
  planLabel,
  refreshNote,
  refreshSourceLabel,
  requirementIsBlocked,
  statusIsAbnormal,
  taskGoal,
  taskStatusText,
  text,
} from "../../src/format.js";

describe("text", () => {
  it("缺值标记就是页面契约里的破折号", () => {
    // 直接钉字面量：用常量做期望值会让常量自身的变异逃过测试（条 tautology）。
    expect(EMPTY).toBe("—");
  });

  it("把空值统一显示为缺值", () => {
    expect(text(null)).toBe("—");
    expect(text(undefined)).toBe("—");
    expect(text("")).toBe("—");
  });

  it("保留 0 与 false 这样的合法值", () => {
    expect(text(0)).toBe("0");
    expect(text(false)).toBe("false");
    expect(text("值")).toBe("值");
  });
});

describe("formatSeconds", () => {
  it("不足一分钟按秒显示，并四舍五入", () => {
    expect(formatSeconds(0)).toBe("0 秒");
    expect(formatSeconds(59)).toBe("59 秒");
    expect(formatSeconds(59.4)).toBe("59 秒");
  });

  it("整分钟不带秒", () => {
    expect(formatSeconds(60)).toBe("1 分");
    expect(formatSeconds(120)).toBe("2 分");
  });

  it("非整分钟显示分与秒", () => {
    expect(formatSeconds(61)).toBe("1 分 1 秒");
    expect(formatSeconds(125)).toBe("2 分 5 秒");
  });

  it("无法解析的输入显示缺值，不显示 NaN", () => {
    expect(formatSeconds("abc")).toBe(EMPTY);
    expect(formatSeconds(undefined)).toBe(EMPTY);
    expect(formatSeconds(Number.NaN)).toBe(EMPTY);
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe(EMPTY);
  });

  it("接受数字字符串（记录里可能以文本存秒数）", () => {
    expect(formatSeconds("90")).toBe("1 分 30 秒");
  });
});

describe("formatTimestamp", () => {
  it("ISO 时间转成本地时间文本（24 小时制、无上下午标记）", () => {
    const formatted = formatTimestamp("2026-10-17T04:00:00+00:00");

    expect(formatted).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
    expect(formatted).not.toContain("上午");
    expect(formatted).not.toContain("下午");
  });

  it("无法解析的时间原样显示，不伪造时间", () => {
    expect(formatTimestamp("不是时间")).toBe("不是时间");
  });

  it("非字符串与空串显示缺值", () => {
    expect(formatTimestamp("")).toBe(EMPTY);
    expect(formatTimestamp(null)).toBe(EMPTY);
    expect(formatTimestamp(1234)).toBe(EMPTY);
  });
});

describe("nextStepText", () => {
  it("标出动作主体", () => {
    expect(nextStepText({ action: "批准方案", actor: "user" })).toBe("批准方案（人工）");
    expect(nextStepText({ action: "继续实现", actor: "agent" })).toBe("继续实现（自动）");
  });

  it("缺失或空动作显示缺值", () => {
    expect(nextStepText(null)).toBe(EMPTY);
    expect(nextStepText(undefined)).toBe(EMPTY);
    expect(nextStepText({ action: "", actor: "user" })).toBe(EMPTY);
  });
});

describe("refreshNote", () => {
  it("关闭自动刷新时给出固定文案", () => {
    expect(refreshNote(0, "cli")).toBe("自动刷新: 已关闭（可用「立即刷新」）");
  });

  it("标注生效间隔与来源", () => {
    expect(refreshNote(60, "default")).toBe("自动刷新: 每 60 秒（来源: 内建默认 60 秒）");
    expect(refreshNote(120, "config")).toBe("自动刷新: 每 120 秒（来源: 配置文件）");
    expect(refreshNote(5, "cli")).toBe("自动刷新: 每 5 秒（来源: --refresh-seconds）");
  });
});

describe("label 翻译", () => {
  it.each([
    ["task_blocked", "任务阻断"],
    ["task_interrupted", "任务中断"],
    ["task_grant_required", "等待追加授权"],
    ["task_time_exhausted", "工时耗尽"],
    ["task_stop_requested", "待确认停止"],
    ["requirement_blocked", "需求阻断"],
    ["slot_residue", "执行槽位残留"],
  ])("问题种类 %s 译为 %s", (kind, label) => {
    expect(issueKindLabel(kind)).toBe(label);
  });

  it("未知种类原样显示，不猜测也不丢字段", () => {
    expect(issueKindLabel("brand_new_kind")).toBe("brand_new_kind");
    expect(issueKindLabel("")).toBe(EMPTY);
  });

  it("已知刷新来源译为中文，未知来源原样显示", () => {
    expect(refreshSourceLabel("config")).toBe("配置文件");
    expect(refreshSourceLabel("mystery")).toBe("mystery");
  });
});

describe("deliveryProgress", () => {
  const task = (state: string, id = "t") => ({
    task_id: id,
    single_task_id: `task-${id}`,
    state,
  });

  it("统计已交付任务数", () => {
    expect(deliveryProgress([task("delivered", "a"), task("awaiting_user", "b")])).toBe(
      "1 / 2 已交付",
    );
  });

  it("全部交付与全部未交付都能读出", () => {
    expect(deliveryProgress([task("delivered")])).toBe("1 / 1 已交付");
    expect(deliveryProgress([task("pending")])).toBe("0 / 1 已交付");
  });

  it("没有任务包时显示缺值", () => {
    expect(deliveryProgress([])).toBe(EMPTY);
  });
});

describe("failureText", () => {
  it("未用尽额度时显示本次剩余", () => {
    expect(
      failureText({ cumulative: 1, remaining_in_current_grant: 2, awaiting_grant_decision: false }),
    ).toBe("1 累计；本次剩余 2");
  });

  it("额度用尽时明确标出", () => {
    expect(
      failureText({ cumulative: 3, remaining_in_current_grant: 0, awaiting_grant_decision: true }),
    ).toBe("3 累计；额度用尽");
  });
});

describe("budgetText", () => {
  it("显示已消耗与限额", () => {
    expect(budgetText({ consumed_seconds: 125, limit_seconds: 7200 })).toBe("2 分 5 秒 / 120 分");
  });
});

describe("countdownText", () => {
  it("关闭自动刷新时固定文案", () => {
    expect(countdownText(0, true)).toBe("自动刷新已关闭");
    expect(countdownText(42, true)).toBe("自动刷新已关闭");
  });

  it("到点显示正在刷新", () => {
    expect(countdownText(0, false)).toBe("正在刷新…");
    expect(countdownText(-1, false)).toBe("正在刷新…");
  });

  it("其余情况显示剩余秒数", () => {
    expect(countdownText(1, false)).toBe("1 秒后刷新");
    expect(countdownText(60, false)).toBe("60 秒后刷新");
  });
});

describe("statusIsAbnormal", () => {
  it("阻断、中断与工时耗尽需要人工关注", () => {
    expect(statusIsAbnormal("blocked")).toBe(true);
    expect(statusIsAbnormal("interrupted")).toBe(true);
    expect(statusIsAbnormal("time_exhausted")).toBe(true);
  });

  it("正常推进与终态不标红", () => {
    expect(statusIsAbnormal("awaiting_plan_approval")).toBe(false);
    expect(statusIsAbnormal("merged")).toBe(false);
    expect(statusIsAbnormal("")).toBe(false);
  });
});

describe("planLabel", () => {
  it("有任务包时写出版本号", () => {
    expect(planLabel({ plan_version: 1 })).toBe("任务包 v1");
    expect(planLabel({ plan_version: 12 })).toBe("任务包 v12");
  });

  it("没有任务包时写缺值，不假装有任务包", () => {
    expect(planLabel(null)).toBe(`任务包 ${EMPTY}`);
  });
});

describe("taskStatusText", () => {
  const dispatched = {
    task_id: "task-1",
    project: "forgeloop",
    status: "blocked",
    plan: { goal: "把三段拆成页签" },
    next_action: null,
    failures: { cumulative: 0, remaining_in_current_grant: 3, awaiting_grant_decision: false },
    budget: { consumed_seconds: 0, limit_seconds: 100 },
    blocked_reason_text: "",
  };

  it("已派发的任务显示执行状态", () => {
    expect(taskStatusText(dispatched)).toBe("blocked");
  });

  it("没有任务记录时如实写「未派发」", () => {
    expect(taskStatusText(null)).toBe("未派发");
  });
});

describe("issueBadgeText", () => {
  it("有问题时给出条数", () => {
    expect(issueBadgeText(1)).toBe("问题 1");
    expect(issueBadgeText(7)).toBe("问题 7");
  });

  it("没有问题时不渲染徽标（空串）", () => {
    expect(issueBadgeText(0)).toBe("");
  });
});

describe("requirementIsBlocked", () => {
  it("记录里有阻断原因就是阻断", () => {
    expect(requirementIsBlocked("executing", "等待人工决定: halted prerequiste_blocked")).toBe(
      true,
    );
    expect(requirementIsBlocked("blocked", "time_exhausted")).toBe(true);
  });

  it("阻断态即使没有原因文案也算阻断", () => {
    expect(requirementIsBlocked("blocked", "")).toBe(true);
    expect(requirementIsBlocked("interrupted", "")).toBe(true);
  });

  it("已验收与草稿的派生文案只是说明，不是阻断", () => {
    expect(requirementIsBlocked("accepted", "")).toBe(false);
    expect(requirementIsBlocked("draft", "")).toBe(false);
  });
});

describe("latestVersion", () => {
  it("取版本号最大的一版原文", () => {
    expect(
      latestVersion([
        { version: 1, text: "第一版" },
        { version: 3, text: "第三版" },
        { version: 2, text: "第二版" },
      ]),
    ).toEqual({ version: 3, text: "第三版" });
  });

  it("版本号相同（异常记录）时保留先出现的一版，结果确定", () => {
    expect(
      latestVersion([
        { version: 2, text: "先出现的" },
        { version: 2, text: "后出现的" },
      ]),
    ).toEqual({ version: 2, text: "先出现的" });
  });

  it("没有需求原文时返回 null，不编造内容", () => {
    expect(latestVersion([])).toBeNull();
  });
});

describe("excerpt", () => {
  it("短文本原样返回", () => {
    expect(excerpt("任务执行被阻断", 20)).toBe("任务执行被阻断");
  });

  it("把换行与连续空白压成单空格，便于放进一行说明", () => {
    expect(excerpt("需求：分页签\n\n  背景：看不清层级", 40)).toBe("需求：分页签 背景：看不清层级");
  });

  it("超长文本按字数截断并标出省略", () => {
    expect(excerpt("一二三四五六七八九十", 4)).toBe("一二三四…");
  });

  it("恰好等于上限时不截断，也不多出一个省略号", () => {
    expect(excerpt("一二三四", 4)).toBe("一二三四");
  });

  it("空文本与缺值都是空串（由调用方决定怎么显示缺值）", () => {
    expect(excerpt("", 10)).toBe("");
    expect(excerpt("   \n ", 10)).toBe("");
  });
});

describe("taskGoal", () => {
  it("有任务包时给出目标", () => {
    expect(taskGoal({ goal: "把三段拆成页签" })).toBe("把三段拆成页签");
  });

  it("没有任务包或目标为空时给出空串", () => {
    expect(taskGoal(null)).toBe("");
    expect(taskGoal({ goal: "" })).toBe("");
  });
});
