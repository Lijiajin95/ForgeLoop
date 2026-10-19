/**
 * 面板渲染与装配的组件测试：用**真实页面 HTML** 跑真实渲染与事件接线。
 *
 * 这一层回答两个问题：① 脚本要的元素 id 是否真的在随包分发的页面里（缺一个就抛错）；
 * ② 人点下去之后，页面发的是不是正确的那一个写请求、本地校验失败时是否一个请求都不发。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OperationFetcher } from "../../src/actions.js";
import { bootstrapPanel } from "../../src/page.js";
import type { PanelClient } from "../../src/panel.js";
import {
  PANEL_PROJECTS_URL,
  PANEL_SESSIONS_URL,
  PANEL_URL,
  type PanelMessage,
} from "../../src/payload.js";
import {
  fillProjectForm,
  renderPanelDocument,
  renderPanelSessionDetail,
  renderPanelTab,
  renderPanelStatus,
  resolvePanelElements,
  sessionStatusLabel,
  decisionKindLabel,
  projectSourceLabel,
  type PanelElements,
} from "../../src/panel_render.js";
import {
  installTokenMeta,
  loadPageBody,
  sampleDecision,
  samplePanelDocument,
  sampleProject,
  sampleSession,
  sampleSessionDetail,
  sampleToolCall,
} from "../fixtures/page.js";

function sampleMessageRow(overrides: Partial<PanelMessage>): PanelMessage {
  return {
    message_id: 1,
    role: "human",
    content: "看一下测试为什么失败",
    state: "ok",
    created_at: "2026-10-18T12:00:30+00:00",
    author: "owner",
    context_mode: "",
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** 路由型取数替身：GET 面板／详情与 POST 写请求各自可注入回答。 */
function recorder(options: {
  readonly panel?: () => unknown;
  readonly detail?: () => unknown;
  readonly write?: () => { status?: number; payload?: unknown };
  readonly onCall?: (call: Call) => void;
}): OperationFetcher {
  return (url, init) => {
    const method = init?.method ?? "GET";
    // 页面写请求体始终是 JSON 字符串；不是字符串时按空体记录，便于断言发现异常请求。
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const call: Call = {
      url,
      method,
      body: rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
    };
    options.onCall?.(call);
    const reply =
      method === "POST"
        ? (options.write?.() ?? { status: 200, payload: { ok: true, detail: "受理成功" } })
        : {
            status: 200,
            payload:
              url === PANEL_URL
                ? (options.panel?.() ?? samplePanelDocument())
                : (options.detail?.() ?? sampleSessionDetail()),
          };
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.payload ?? {}),
    } as Response);
  };
}

function elements(): PanelElements {
  return resolvePanelElements(document);
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let clients: PanelClient[] = [];

function startPanel(fetcher: OperationFetcher, token = "panel-token"): PanelClient {
  installTokenMeta(token);
  const client = bootstrapPanel(document, { operationFetcher: fetcher });
  expect(client).toBeDefined();
  const started = client as PanelClient;
  clients.push(started);
  return started;
}

beforeEach(() => {
  loadPageBody();
  clients = [];
});

afterEach(() => {
  clients.forEach((client) => {
    client.stop();
  });
});

describe("元素契约", () => {
  it("真实页面里有全部面板元素", () => {
    const panel = elements();
    expect(panel.panel.id).toBe("panel");
    expect(panel.tabs).toHaveLength(3);
    expect(panel.sessionList.tagName).toBe("SELECT");
    expect(panel.composer.tagName).toBe("FORM");
  });

  it("缺元素时明确失败，而不是半初始化", () => {
    document.getElementById("panel-project-home")?.remove();
    expect(() => resolvePanelElements(document)).toThrow(/panel-project-home/);
  });
});

describe("渲染", () => {
  it("没有令牌时整块面板隐藏（只读服务）", () => {
    const client = bootstrapPanel(document, { operationFetcher: recorder({}) });

    expect(client).toBeUndefined();
    expect(elements().panel.hidden).toBe(true);
  });

  it("页签切换只显示当前视图", () => {
    const panel = elements();

    renderPanelTab(panel, "runtime");
    expect(panel.runtimeView.hidden).toBe(false);
    expect(panel.sessionsView.hidden).toBe(true);
    expect(panel.tabs[1]?.getAttribute("aria-pressed")).toBe("true");

    renderPanelTab(panel, "projects");
    expect(panel.projectsView.hidden).toBe(false);
    expect(panel.runtimeView.hidden).toBe(true);
    expect(panel.tabs[0]?.getAttribute("aria-pressed")).toBe("false");
  });

  it("状态行区分成功与失败", () => {
    const panel = elements();

    renderPanelStatus(panel, "已发送", "info");
    expect(panel.status.textContent).toBe("已发送");
    expect(panel.status.dataset["tone"]).toBe("info");

    renderPanelStatus(panel, "必须先选择会话", "error");
    expect(panel.status.dataset["tone"]).toBe("error");
  });

  it("会话清单保留下拉选择并给出占位项", () => {
    const panel = elements();
    const first = sampleSession({ session_id: "cs-1", title: "第一" });
    const second = sampleSession({ session_id: "cs-2", title: "第二" });

    renderPanelDocument(panel, samplePanelDocument({ sessions: [first, second] }), "cs-2");
    expect(panel.sessionList.value).toBe("cs-2");
    expect([...panel.sessionList.options].map((option) => option.textContent)).toEqual([
      "第一（可对话·1 轮）",
      "第二（可对话·1 轮）",
    ]);

    renderPanelDocument(panel, samplePanelDocument({ sessions: [] }), "cs-2");
    expect(panel.sessionList.value).toBe("");
    expect(panel.sessionList.options[0]?.textContent).toBe("还没有会话");
  });

  it("项目下拉只列就绪项目，没有就绪项目时禁用新建", () => {
    const panel = elements();
    const ready = sampleProject({ name: "ready" });
    const broken = sampleProject({
      name: "broken",
      problems: ["缺少模型配置"],
      runtime: {
        ready: false,
        problems: ["缺少模型配置"],
        pi_command: ["pi"],
        pi_home: "/home/broken",
        running_turns: 0,
      },
    });

    renderPanelDocument(panel, samplePanelDocument({ projects: [ready, broken] }), "");
    expect([...panel.projectSelect.options].map((option) => option.value)).toEqual(["ready"]);
    expect(panel.newSessionButton.disabled).toBe(false);

    renderPanelDocument(panel, samplePanelDocument({ projects: [broken] }), "");
    expect(panel.projectSelect.options).toHaveLength(0);
    expect(panel.newSessionButton.disabled).toBe(true);
  });

  it("运行时视图显示就绪情况与占用摘要", () => {
    const panel = elements();
    const broken = sampleProject({
      name: "broken",
      description: "坏项目",
      problems: ["缺少模型配置 /home/x/.pi/agent/models.json"],
      runtime: {
        ready: false,
        problems: ["缺少模型配置 /home/x/.pi/agent/models.json"],
        pi_command: ["pi", "--mode", "rpc"],
        pi_home: "/home/x",
        running_turns: 0,
      },
    });

    renderPanelDocument(
      panel,
      samplePanelDocument({
        projects: [sampleProject({ name: "ready" }), broken],
        runtime: {
          concurrency: 3,
          turn_timeout_seconds: 600,
          running_turns: 1,
          queued_turns: 2,
          tool_approval: "write",
          live_sessions: 1,
        },
      }),
      "",
    );

    const rows = [...panel.runtimeBody.querySelectorAll("tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelectorAll("td")[1]?.textContent).toBe("就绪");
    expect(rows[1]?.querySelectorAll("td")[2]?.textContent).toContain("缺少模型配置");
    expect(panel.runtimeSummary.textContent).toBe(
      "并发上限 3 轮 · 进行中 1 轮 · 排队 2 轮 · 单轮超时 600 秒 · 常驻会话 1 · 工具审批 write",
    );
    expect(panel.runtimeEmpty.style.display).toBe("none");
  });

  it("项目视图区分可编辑与手写配置", () => {
    const panel = elements();
    const service = sampleProject({
      name: "svc",
      source: "service",
      editable: false,
      description: "",
    });

    renderPanelDocument(panel, samplePanelDocument({ projects: [sampleProject(), service] }), "");

    const rows = [...panel.projectsBody.querySelectorAll("tr")];
    expect(rows[0]?.querySelectorAll("td")[1]?.textContent).toBe("页面管理");
    expect(rows[0]?.querySelector("button[data-action='edit']")).not.toBeNull();
    expect(rows[1]?.querySelectorAll("td")[1]?.textContent).toBe("手写配置（只读）");
    expect(rows[1]?.textContent).toContain("改 config/service.toml");
    expect(rows[1]?.querySelector("button")).toBeNull();
    expect(panel.projectsEmpty.style.display).toBe("none");
  });

  it("会话详情渲染消息、待决定与终止信息", () => {
    const panel = elements();
    renderPanelSessionDetail(
      panel,
      sampleSessionDetail({
        session: sampleSession({
          status: "awaiting_human",
          running: true,
          last_error: "PI timeout",
          pending_decisions: 1,
        }),
        decisions: [sampleDecision()],
      }),
    );

    expect(panel.emptyHint.hidden).toBe(true);
    expect(panel.sessionMeta.textContent).toContain("等待人工决定");
    expect(panel.sessionMeta.textContent).toContain("正在执行");
    expect(panel.sessionMeta.textContent).toContain("最近问题：PI timeout");
    expect(panel.messages.querySelectorAll("li")).toHaveLength(2);
    expect(panel.messages.querySelector("li.msg-human")?.textContent).toContain(
      "看一下测试为什么失败",
    );
    const decisionButtons = [...panel.decisions.querySelectorAll("button")];
    expect(decisionButtons.map((button) => button.textContent)).toEqual([
      "批准并继续",
      "拒绝并终止",
    ]);
    expect(decisionButtons[0]?.dataset["decision"]).toBe(sampleDecision().decision_id);
    expect(decisionButtons[1]?.dataset["choice"]).toBe("reject");
    expect(panel.composer.hidden).toBe(false);

    renderPanelSessionDetail(
      panel,
      sampleSessionDetail({
        session: sampleSession({ status: "terminated", terminate_reason: "不需要了" }),
        decisions: [sampleDecision({ status: "rejected", decided_by: "owner", reason: "不做" })],
      }),
    );
    expect(panel.sessionMeta.textContent).toContain("终止原因：不需要了");
    expect(panel.decisions.textContent).toContain("owner：不做");
    expect(panel.composer.hidden).toBe(true);
  });

  it("未选择会话时回到空态", () => {
    const panel = elements();
    renderPanelSessionDetail(panel, undefined);

    expect(panel.sessionMeta.textContent).toBe("未选择会话");
    expect(panel.emptyHint.hidden).toBe(false);
    expect(panel.messages.children).toHaveLength(0);
  });

  it("表单回填与清空", () => {
    const panel = elements();
    fillProjectForm(panel, sampleProject());
    expect(panel.projectName.value).toBe("forgeloop");
    expect(panel.projectCommand.value).toBe('["pi","--mode","rpc","--no-session"]');
    expect(panel.projectSubmit.textContent).toBe("保存修改");
    expect(panel.projectSubmit.dataset["editing"]).toBe("forgeloop");

    fillProjectForm(panel, undefined);
    expect(panel.projectName.value).toBe("");
    expect(panel.projectSubmit.textContent).toBe("新增项目");
    expect(panel.projectSubmit.dataset["editing"]).toBe("");
  });

  it("标签函数对未知取值原样显示", () => {
    expect(sessionStatusLabel("active")).toBe("可对话");
    expect(sessionStatusLabel("weird")).toBe("weird");
    expect(decisionKindLabel("turn_failed")).toBe("这一轮未取得结果");
    expect(decisionKindLabel("other")).toBe("other");
    expect(projectSourceLabel("service")).toBe("手写配置（只读）");
    expect(projectSourceLabel("panel")).toBe("页面管理");
  });
});

describe("装配与写操作", () => {
  it("启动后渲染面板总览", async () => {
    const document_ = samplePanelDocument({
      projects: [sampleProject()],
      sessions: [sampleSession()],
    });
    const client = startPanel(recorder({ panel: () => document_ }));

    await client.pending;

    expect(elements().panel.hidden).toBe(false);
    expect(elements().projectsBody.querySelectorAll("tr")).toHaveLength(1);
    // 未选中会话时第一项是占位项，真实会话跟在后面，下拉值保持为空。
    expect([...elements().sessionList.options].map((option) => option.textContent)).toEqual([
      "选择一个会话",
      "排查构建失败（可对话·1 轮）",
    ]);
    expect(elements().sessionList.value).toBe("");
  });

  it("新建会话：本地必填校验不发请求，成功后自动选中", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        write: () => ({ status: 201, payload: { ok: true, detail: "已新建会话" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.newSessionButton.click();
    expect(panel.newSessionForm.hidden).toBe(false);

    panel.sessionTitle.value = "";
    panel.createSessionButton.click();
    await flush();
    expect(calls).toEqual([]);
    expect(panel.status.dataset["tone"]).toBe("error");

    panel.sessionTitle.value = "新的会话";
    panel.createSessionButton.click();
    await flush();
    await flush();

    expect(calls.some((call) => call.url === PANEL_SESSIONS_URL && call.method === "POST")).toBe(
      true,
    );
    expect(panel.newSessionForm.hidden).toBe(true);
    expect(client.selectedSessionId).toBe(sampleSession().session_id);
    expect(panel.messages.querySelectorAll("li")).toHaveLength(2);
  });

  it("发送消息：成功后清空输入并追详情", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        write: () => ({
          status: 202,
          payload: { ok: true, detail: "已受理，一轮执行在常驻进程内进行" },
        }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    await client.openSession(sampleSession().session_id);
    calls.length = 0;

    const panel = elements();
    panel.messageText.value = "";
    panel.composer.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls).toEqual([]);
    expect(panel.status.textContent).toBe("消息内容不能为空。");

    panel.messageText.value = "再跑一次";
    panel.composer.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    await flush();

    const sent = calls.find((call) => call.url.endsWith("/messages"));
    expect(sent?.body).toEqual({ by: "owner", text: "再跑一次" });
    expect(panel.messageText.value).toBe("");
  });

  it("终止会话必须有理由", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        write: () => ({ status: 200, payload: { ok: true, detail: "会话已终止" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    await client.openSession(sampleSession().session_id);
    calls.length = 0;

    const panel = elements();
    panel.reason.value = "";
    panel.terminateButton.click();
    await flush();
    expect(calls).toEqual([]);
    expect(panel.status.textContent).toBe("终止会话必须填写理由。");

    panel.reason.value = "不需要了";
    panel.terminateButton.click();
    await flush();
    expect(calls.find((call) => call.url.endsWith("/terminate"))?.body).toEqual({
      by: "owner",
      reason: "不需要了",
    });
  });

  it("人工决定：按钮带 data 属性，理由取表单输入", async () => {
    const calls: Call[] = [];
    const pending = sampleDecision();
    const client = startPanel(
      recorder({
        detail: () => sampleSessionDetail({ decisions: [pending] }),
        write: () => ({ status: 200, payload: { ok: true, detail: "已作出决定" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    await client.openSession(sampleSession().session_id);
    calls.length = 0;

    const panel = elements();
    const approve = panel.decisions.querySelector<HTMLButtonElement>(
      "button[data-choice='approve']",
    );
    expect(approve).not.toBeNull();

    panel.reason.value = "";
    approve?.click();
    await flush();
    expect(calls).toEqual([]);

    panel.reason.value = "按方案 B 继续";
    panel.decisionText.value = "改用方案 B";
    approve?.click();
    await flush();

    expect(calls.find((call) => call.url.includes("/decisions/"))?.body).toEqual({
      by: "owner",
      decision: "approve",
      reason: "按方案 B 继续",
      text: "改用方案 B",
    });
    expect(panel.decisionText.value).toBe("");
  });

  it("项目行：编辑回填表单，删除要理由", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        panel: () => samplePanelDocument({ projects: [sampleProject()] }),
        write: () => ({ status: 200, payload: { ok: true, detail: "已删除项目" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.projectsBody.querySelector<HTMLButtonElement>("button[data-action='edit']")?.click();
    expect(panel.projectName.value).toBe("forgeloop");
    expect(panel.projectSubmit.dataset["editing"]).toBe("forgeloop");

    panel.reason.value = "";
    panel.projectsBody.querySelector<HTMLButtonElement>("button[data-action='remove']")?.click();
    await flush();
    expect(calls).toEqual([]);
    expect(panel.status.textContent).toContain("删除项目必须填写理由");

    panel.reason.value = "清理";
    panel.projectsBody.querySelector<HTMLButtonElement>("button[data-action='remove']")?.click();
    await flush();
    expect(
      calls.find((call) => call.url === `${PANEL_PROJECTS_URL}/forgeloop/remove`)?.body,
    ).toEqual({
      by: "owner",
      reason: "清理",
    });
  });

  it("项目表单：命令不是 JSON 数组时不发请求", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        write: () => ({ status: 201, payload: { ok: true, detail: "已新增项目" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.projectName.value = "demo";
    panel.projectPath.value = "/srv/demo";
    panel.projectHome.value = "/home/demo/pi-home";
    panel.projectCommand.value = "pi --mode rpc";
    panel.projectForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls).toEqual([]);
    expect(panel.status.textContent).toContain("JSON 字符串数组");

    panel.projectCommand.value = '["pi","--mode","rpc"]';
    panel.projectForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    await flush();
    const created = calls.find((call) => call.url === PANEL_PROJECTS_URL && call.method === "POST");
    expect(created?.body).toEqual({
      by: "owner",
      name: "demo",
      path: "/srv/demo",
      description: "",
      pi_command: ["pi", "--mode", "rpc"],
      pi_home: "/home/demo/pi-home",
    });
    expect(panel.projectName.value).toBe("");
  });

  it("编辑保存打到 update 端点", async () => {
    const calls: Call[] = [];
    const client = startPanel(
      recorder({
        write: () => ({ status: 200, payload: { ok: true, detail: "已更新项目" } }),
        onCall: (call) => calls.push(call),
      }),
    );
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.projectsBody.querySelector<HTMLButtonElement>("button[data-action='edit']")?.click();
    panel.projectDescription.value = "改过的说明";
    panel.projectForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    await flush();

    const updated = calls.find((call) => call.url.endsWith("/update"));
    expect(updated?.url).toBe(`${PANEL_PROJECTS_URL}/forgeloop/update`);
    expect(updated?.body["description"]).toBe("改过的说明");
  });

  it("选择会话与刷新按钮都读到对应端点", async () => {
    const calls: Call[] = [];
    const client = startPanel(recorder({ onCall: (call) => calls.push(call) }));
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.sessionList.value = sampleSession().session_id;
    panel.sessionList.dispatchEvent(new Event("change"));
    await flush();
    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/${sampleSession().session_id}`);

    calls.length = 0;
    panel.refreshButton.click();
    await flush();
    expect(calls.some((call) => call.url === PANEL_URL)).toBe(true);
  });

  it("流式消息带「正在生成」标记，人工消息注明上下文来源", () => {
    const panel = elements();
    renderPanelSessionDetail(
      panel,
      sampleSessionDetail({
        session: sampleSession({ compaction_count: 2 }),
        messages: [
          sampleMessageRow({ context_mode: "warm" }),
          sampleMessageRow({
            message_id: 2,
            role: "agent",
            content: "正在写的半句",
            state: "streaming",
          }),
        ],
      }),
    );

    const items = [...panel.messages.querySelectorAll("li")];
    expect(items[0]?.querySelector(".msg-head")?.textContent).toContain("续接常驻会话");
    expect(items[1]?.className).toContain("msg-streaming");
    expect(items[1]?.querySelector(".msg-head")?.textContent).toContain("正在生成");
    expect(panel.sessionMeta.textContent).toContain("已压缩上下文 2 次");
  });

  it("冷启动与无记录的人工消息各有各的说明", () => {
    const panel = elements();
    renderPanelSessionDetail(
      panel,
      sampleSessionDetail({
        messages: [
          sampleMessageRow({ context_mode: "cold" }),
          sampleMessageRow({ message_id: 2, context_mode: "" }),
        ],
      }),
    );

    const heads = [...panel.messages.querySelectorAll("li .msg-head")].map(
      (node) => node.textContent ?? "",
    );
    expect(heads[0]).toContain("冷启动（回放历史）");
    expect(heads[1]).not.toContain("冷启动");
    expect(heads[1]).not.toContain("续接");
  });

  it("工具调用逐次可见：风险、状态、耗时、审批与摘要", () => {
    const panel = elements();
    renderPanelSessionDetail(
      panel,
      sampleSessionDetail({
        tool_calls: [
          sampleToolCall(),
          sampleToolCall({
            tool_call_id: "call-2",
            tool_name: "read",
            args_excerpt: "",
            result_excerpt: "",
            risk: "read",
            status: "error",
            duration_ms: 3,
            requires_approval: false,
            approval_status: "none",
          }),
          sampleToolCall({
            tool_call_id: "call-3",
            tool_name: "custom_browser",
            risk: "made-up",
            status: "running",
            approval_status: "weird",
            requires_approval: true,
          }),
        ],
      }),
    );

    const items = [...panel.toolCalls.querySelectorAll("li")];
    expect(items).toHaveLength(3);
    expect(panel.toolCalls.hidden).toBe(false);
    expect(panel.toolsMeta.hidden).toBe(false);
    expect(panel.toolsMeta.textContent).toBe(
      "本轮工具调用 3 次（需人工确认 2 次）：PI 在轮次内自行执行工具，审批发生在轮次边界。",
    );
    expect(items[0]?.className).toBe("tool-approval");
    const first = items[0]?.querySelector(".msg-head")?.textContent ?? "";
    expect(first).toContain("bash");
    expect(first).toContain("执行命令");
    expect(first).toContain("成功");
    expect(first).toContain("8 ms");
    expect(first).toContain("待审批");
    expect(items[0]?.querySelector("p")?.textContent).toContain("参数：");
    expect(items[0]?.querySelector("p")?.textContent).toContain("结果：");
    // 未登记标签的取值原样显示，不假装认识它。
    const third = items[2]?.querySelector(".msg-head")?.textContent ?? "";
    expect(third).toContain("made-up");
    expect(third).toContain("执行中");
    expect(third).toContain("weird");
    expect(items[1]?.querySelector("p")?.textContent).toBe("");
    expect(items[1]?.querySelector(".msg-head")?.textContent).toContain("只读");
    expect(items[1]?.querySelector(".msg-head")?.textContent).toContain("失败");
    expect(items[1]?.querySelector(".msg-head")?.textContent).toContain("无需审批");
  });

  it("没有工具调用时列表整体隐藏，未选择会话时清空", () => {
    const panel = elements();
    renderPanelSessionDetail(panel, sampleSessionDetail({ tool_calls: [sampleToolCall()] }));
    expect(panel.toolCalls.hidden).toBe(false);

    renderPanelSessionDetail(panel, sampleSessionDetail({ tool_calls: [] }));
    expect(panel.toolCalls.hidden).toBe(true);
    expect(panel.toolsMeta.hidden).toBe(true);
    expect(panel.toolCalls.children).toHaveLength(0);

    renderPanelSessionDetail(panel, undefined);
    expect(panel.toolCalls.hidden).toBe(true);
    expect(panel.toolsMeta.hidden).toBe(true);
  });

  it("未选择会话时点发送不发请求", async () => {
    const calls: Call[] = [];
    const client = startPanel(recorder({ onCall: (call) => calls.push(call) }));
    await client.pending;
    calls.length = 0;

    const panel = elements();
    panel.messageText.value = "你好";
    panel.composer.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(calls).toEqual([]);
    expect(panel.status.textContent).toBe("先选择一个会话。");
  });
});
