/**
 * 面板客户端（`panel.ts`）的单元测试：取数、轮询节奏、写操作 URL 与失败处理。
 *
 * 这一层把网络替换成记录型替身，因此钉的是「页面到底向哪个端点、发了什么请求体、
 * 失败时人看到什么」——正是页面最小职责里的两条（原样送、原样显示）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationFetcher } from "../../src/actions.js";
import { PanelClient, type PanelTone } from "../../src/panel.js";
import {
  PANEL_PROJECTS_URL,
  PANEL_SESSIONS_URL,
  PANEL_URL,
  type PanelDocument,
  type PanelSessionDetail,
} from "../../src/payload.js";
import { samplePanelDocument, sampleSession, sampleSessionDetail } from "../fixtures/page.js";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly token: string;
  readonly cache: string;
}

interface Reply {
  readonly status?: number;
  readonly payload?: unknown;
  readonly fail?: boolean;
}

/** 记录型取数替身：按 URL 路由回答，并把每次请求的 URL／方法／请求体／令牌记下来。
 *
 * 用路由而不是队列：面板一次写操作会连带刷新总览与详情，队列顺序会让用例变成
 * 「猜调用次数」；路由则只描述「这个端点回什么」。 */
interface Routes {
  readonly panel?: () => Reply;
  readonly detail?: () => Reply;
  readonly write?: () => Reply;
  readonly overrides?: Readonly<Record<string, () => Reply>>;
}

function recorder(routes: Routes = {}): { fetcher: OperationFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: OperationFetcher = (url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // 页面写请求体始终是 JSON 字符串；不是字符串时按空体记录，便于断言发现异常请求。
    const rawBody = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url,
      method,
      body: rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      token: headers["X-Forgeloop-Token"] ?? "",
      cache: (init as { cache?: string } | undefined)?.cache ?? "",
    });
    const override = routes.overrides?.[url];
    const next: Reply =
      override?.() ??
      (method === "POST"
        ? (routes.write?.() ?? { payload: { ok: true, detail: "受理成功" } })
        : url === PANEL_URL
          ? (routes.panel?.() ?? { payload: samplePanelDocument() })
          : (routes.detail?.() ?? { payload: sampleSessionDetail() }));
    if (next.fail === true) {
      return Promise.reject(new Error("网络不可用"));
    }
    const status = next.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(next.payload ?? {}),
    } as Response);
  };
  return { fetcher, calls };
}

interface Recorder {
  readonly documents: PanelDocument[];
  readonly details: PanelSessionDetail[];
  readonly statuses: { message: string; tone: PanelTone }[];
  readonly selected: string[];
}

function clientOf(
  routes: Routes = {},
  options: { readonly token?: string } = {},
): { client: PanelClient; calls: Call[]; seen: Recorder } {
  const { fetcher, calls } = recorder(routes);
  const seen: Recorder = { documents: [], details: [], statuses: [], selected: [] };
  const client = new PanelClient({
    token: options.token ?? "t0ken",
    fetcher,
    onDocument: (document) => seen.documents.push(document),
    onSession: (detail) => seen.details.push(detail),
    onStatus: (message, tone) => seen.statuses.push({ message, tone }),
    onSelected: (sessionId) => seen.selected.push(sessionId),
  });
  return { client, calls, seen };
}

describe("读取", () => {
  it("读总览时用 no-store 并回调文档", async () => {
    const { client, calls, seen } = clientOf();

    await client.refreshPanel();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(PANEL_URL);
    expect(calls[0]?.method).toBe("GET");
    // 进展快照会被服务端现算，必须绕开浏览器缓存，否则人看到的是旧事实。
    expect(calls[0]?.cache).toBe("no-store");
    expect(seen.documents[0]?.sessions[0]?.title).toBe("排查构建失败");
    expect(seen.statuses).toEqual([]);
  });

  it("读取失败把服务端原因显示在状态行", async () => {
    const { client, seen } = clientOf({
      panel: () => ({
        status: 500,
        payload: { error: "panel_failed", detail: "面板项目档案解析失败" },
      }),
    });

    await client.refreshPanel();

    expect(seen.statuses).toEqual([
      { message: "读取面板失败：Error: 面板项目档案解析失败", tone: "error" },
    ]);
    expect(seen.documents).toEqual([]);
  });

  it("网络异常不会被当成成功", async () => {
    const { client, seen } = clientOf({ panel: () => ({ fail: true }) });

    await client.refreshPanel();

    expect(seen.statuses[0]?.tone).toBe("error");
    expect(seen.statuses[0]?.message).toContain("网络不可用");
  });

  it("非 JSON 失败响应退回状态码，不臆造原因", async () => {
    const { client, seen } = clientOf({ panel: () => ({ status: 502, payload: "gateway" }) });

    await client.refreshPanel();

    expect(seen.statuses[0]?.message).toBe("读取面板失败：Error: HTTP 502");
  });

  it("detail 不是非空字符串时同样退回状态码", async () => {
    const { client, seen } = clientOf({ panel: () => ({ status: 500, payload: { detail: "" } }) });

    await client.refreshPanel();

    expect(seen.statuses[0]?.message).toBe("读取面板失败：Error: HTTP 500");
  });

  it("pending 指向进行中的读取，可等待它完成", async () => {
    const { client, seen } = clientOf();

    expect(client.pending).toBeUndefined();
    client.start();
    const started = client.pending;
    expect(started).toBeInstanceOf(Promise);

    await started;

    expect(seen.documents).toHaveLength(1);
  });

  it("总览里会话还在时刷新详情，而不是清掉选择", async () => {
    const { client, calls, seen } = clientOf();
    await client.openSession(sampleSession().session_id);
    calls.length = 0;
    seen.selected.length = 0;

    await client.refreshPanel();

    expect(client.selectedSessionId).toBe(sampleSession().session_id);
    expect(seen.selected).toEqual([]);
    expect(
      calls.some((call) => call.url === `${PANEL_SESSIONS_URL}/${sampleSession().session_id}`),
    ).toBe(true);
  });

  it("详情读取同样绕开缓存", async () => {
    const { client, calls } = clientOf();

    await client.openSession("cs-1");

    expect(calls[0]?.cache).toBe("no-store");
  });

  it("打开会话记住选择并读详情", async () => {
    const { client, calls, seen } = clientOf();

    await client.openSession("cs-1");

    expect(client.selectedSessionId).toBe("cs-1");
    expect(seen.selected).toEqual(["cs-1"]);
    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/cs-1`);
    expect(seen.details[0]?.session.session_id).toBe(sampleSession().session_id);
  });

  it("会话身份在 URL 里被转义", async () => {
    const { client, calls } = clientOf();

    await client.openSession("cs/../evil");

    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/cs%2F..%2Fevil`);
  });

  it("详情读取失败也走状态行", async () => {
    const { client, seen } = clientOf({
      detail: () => ({
        status: 404,
        payload: { error: "session_not_found", detail: "会话不存在: cs-1" },
      }),
    });

    await client.openSession("cs-1");

    expect(seen.statuses[0]).toEqual({
      message: "读取会话失败：Error: 会话不存在: cs-1",
      tone: "error",
    });
  });

  it("未选择会话时读详情是空操作", async () => {
    const { client, calls } = clientOf();

    await client.refreshSelected();

    expect(calls).toEqual([]);
  });

  it("没有选中会话时刷新总览不会误报选择变化", async () => {
    const { client, seen } = clientOf();

    await client.refreshPanel();

    expect(seen.selected).toEqual([]);
  });

  it("未注入 onSelected 时也能工作（可选回调）", async () => {
    const { fetcher } = recorder();
    const documents: PanelDocument[] = [];
    const client = new PanelClient({
      token: "t",
      fetcher,
      onDocument: (document) => documents.push(document),
      onSession: () => undefined,
      onStatus: () => undefined,
    });

    await client.refreshPanel();
    await client.openSession("cs-1");

    expect(documents).toHaveLength(1);
  });
});

describe("轮询节奏", () => {
  it("没有选中会话时每拍刷新总览", async () => {
    const { client, calls } = clientOf();

    client.tick();
    await client.pending;
    client.tick();
    await client.pending;

    expect(calls.map((call) => call.url)).toEqual([PANEL_URL, PANEL_URL]);
  });

  it("选中会话后每拍追详情，每四拍额外刷新总览", async () => {
    const { client, calls } = clientOf();
    await client.openSession("cs-1");
    calls.length = 0;

    for (let tick = 0; tick < 4; tick += 1) {
      client.tick();
      await client.pending;
    }

    expect(calls.filter((call) => call.url === `${PANEL_SESSIONS_URL}/cs-1`)).toHaveLength(4);
    expect(calls.filter((call) => call.url === PANEL_URL)).toHaveLength(1);
  });

  it("总览里会话消失时清掉选择，避免显示过期内容", async () => {
    const { client, seen } = clientOf({
      panel: () => ({ payload: samplePanelDocument({ sessions: [] }) }),
    });

    await client.openSession("cs-gone");
    seen.selected.length = 0;
    seen.details.length = 0;
    await client.refreshPanel();

    expect(client.selectedSessionId).toBe("");
    expect(seen.selected).toEqual([""]);
    expect(seen.details).toEqual([]);
  });

  it("start 会立刻读一次，并按间隔继续取数", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf();
      client.start();
      await client.pending;
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toHaveLength(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("有轮次在跑时缩短间隔：600ms 就能取到下一拍", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf({
        panel: () => ({
          payload: samplePanelDocument({
            runtime: {
              concurrency: 2,
              turn_timeout_seconds: 900,
              running_turns: 1,
              queued_turns: 0,
              tool_approval: "write",
              live_sessions: 1,
            },
          }),
        }),
      });
      client.start();
      await client.pending;
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("详情里有流式消息时也缩短间隔", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf({
        detail: () => ({
          payload: sampleSessionDetail({
            messages: [
              {
                message_id: 1,
                role: "human",
                content: "问一句",
                state: "ok",
                created_at: "2026-10-18T12:00:00+00:00",
                author: "owner",
                context_mode: "warm",
              },
              {
                message_id: 2,
                role: "agent",
                content: "正在写的半句",
                state: "streaming",
                created_at: "2026-10-18T12:00:30+00:00",
                author: "",
                context_mode: "",
              },
            ],
          }),
        }),
      });
      // 选中会话后启动轮询：每一拍读详情，因此 streaming 状态直接决定下一拍间隔。
      await client.openSession("cs-1");
      client.start();
      await client.pending;
      const seen = calls.length;

      await vi.advanceTimersByTimeAsync(600);
      expect(calls.length).toBeGreaterThan(seen);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("排队中有轮次时同样缩短间隔", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf({
        panel: () => ({
          payload: samplePanelDocument({
            runtime: {
              concurrency: 1,
              turn_timeout_seconds: 900,
              running_turns: 0,
              queued_turns: 2,
              tool_approval: "off",
              live_sessions: 0,
            },
            sessions: [sampleSession({ running: false })],
          }),
        }),
      });
      client.start();
      await client.pending;

      // 只有「排队中」这一条为真：running_turns 为 0、会话也没在跑。
      await vi.advanceTimersByTimeAsync(600);
      expect(calls.length).toBeGreaterThan(1);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("清单里有正在跑的会话时同样缩短间隔", async () => {
    vi.useFakeTimers();
    try {
      // 计数为 0，只有清单里那一条 running=true：some 与 every 在这里给出不同答案。
      const { client, calls } = clientOf({
        panel: () => ({
          payload: samplePanelDocument({ sessions: [sampleSession({ running: true })] }),
        }),
      });
      client.start();
      await client.pending;

      await vi.advanceTimersByTimeAsync(600);
      expect(calls.length).toBeGreaterThan(1);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("清单里只有部分会话在跑时也算忙", async () => {
    vi.useFakeTimers();
    try {
      // 两条会话、只有一条在跑：some 判定为真，every 会判成假（间隔就不会缩短）。
      const { client, calls } = clientOf({
        panel: () => ({
          payload: samplePanelDocument({
            sessions: [sampleSession({ running: false }), sampleSession({ running: true })],
          }),
        }),
      });
      client.start();
      await client.pending;

      await vi.advanceTimersByTimeAsync(600);
      expect(calls.length).toBeGreaterThan(1);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("空闲时回到长间隔：600ms 不再取数，1500ms 才取", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf();
      client.start();
      await client.pending;
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900);
      expect(calls).toHaveLength(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("详情没有在跑也没有流式时回到长间隔", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf();
      await client.openSession("cs-1");
      client.start();
      await client.pending;
      const seen = calls.length;

      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(seen);
      await vi.advanceTimersByTimeAsync(900);
      expect(calls.length).toBeGreaterThan(seen);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("请求在途时 stop：落地后不再安排下一拍", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recorded = recorder();
      const fetcher: OperationFetcher = async (url, init) => {
        await gate;
        return recorded.fetcher(url, init);
      };
      const client = new PanelClient({
        token: "t0ken",
        fetcher,
        onDocument: () => undefined,
        onSession: () => undefined,
        onStatus: () => undefined,
      });
      client.start();
      // 第一拍还挂在网络上时人点了停止：在途那一拍落地后不许再安排下一拍。
      client.stop();
      release?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recorded.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop 之后不再取数，重复 stop 也不报错", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = clientOf();
      client.stop(); // 尚未 start：清定时器是空操作
      client.start();
      await client.pending;
      client.stop();
      const seen = calls.length;

      await vi.advanceTimersByTimeAsync(5000);

      expect(calls).toHaveLength(seen);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("写操作", () => {
  let seen: Recorder;

  beforeEach(() => {
    seen = { documents: [], details: [], statuses: [], selected: [] };
  });

  function writes(routes: Routes = {}): { client: PanelClient; calls: Call[] } {
    // 断言对象必须是客户端回调真正写入的那一个：不能另建一份「看起来一样」的。
    const created = clientOf(routes);
    seen = created.seen;
    return { client: created.client, calls: created.calls };
  }

  it("发送消息带令牌与正文，成功后提示并刷新", async () => {
    const { client, calls } = writes({
      write: () => ({
        status: 202,
        payload: { ok: true, detail: "已受理，一轮执行在常驻进程内进行" },
      }),
    });
    await client.openSession("cs-1");
    calls.length = 0;

    const outcome = await client.send("看一下");

    expect(outcome).toEqual({ ok: true, message: "已受理，一轮执行在常驻进程内进行" });
    expect(seen.statuses[0]).toEqual({
      message: "已发送：已受理，一轮执行在常驻进程内进行",
      tone: "info",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/cs-1/messages`);
    expect(calls[0]?.body).toEqual({ by: "owner", text: "看一下" });
    expect(calls[0]?.token).toBe("t0ken");
    expect(calls.map((call) => call.url)).toContain(PANEL_URL);
  });

  it("失败响应把 detail 当作人读原因，且不触发成功提示", async () => {
    const { client } = writes({
      write: () => ({
        status: 409,
        payload: { error: "refused", detail: "有未处理的待人工决定；先批准或拒绝它" },
      }),
    });
    await client.openSession("cs-1");

    const outcome = await client.send("再看一句");

    expect(outcome).toEqual({ ok: false, message: "有未处理的待人工决定；先批准或拒绝它" });
    expect(seen.statuses).toEqual([
      { message: "有未处理的待人工决定；先批准或拒绝它", tone: "error" },
    ]);
  });

  it("成功响应但 detail 为空时回落到中性文案", async () => {
    const { client } = writes({
      write: () => ({ status: 200, payload: { ok: true, detail: "" } }),
    });
    await client.openSession("cs-1");

    const outcome = await client.send("你好");

    expect(outcome).toEqual({ ok: true, message: "操作已完成。" });
    expect(seen.statuses[0]?.message).toBe("已发送：操作已完成。");
  });

  it("写失败不触发总览刷新（不把失败当成功去回读）", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 409, payload: { error: "refused", detail: "会话已终止" } }),
    });
    await client.openSession("cs-1");
    calls.length = 0;

    await client.send("再说一句");

    expect(calls.filter((call) => call.url === PANEL_URL)).toEqual([]);
  });

  it("终止会话必须带理由", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 200, payload: { ok: true, detail: "会话已终止" } }),
    });
    await client.openSession("cs-1");
    calls.length = 0;

    await client.terminate("不需要了");

    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/cs-1/terminate`);
    expect(calls[0]?.body).toEqual({ by: "owner", reason: "不需要了" });
    expect(seen.statuses[0]?.message).toBe("已请求终止：会话已终止");
  });

  it("人工决定带上补充指令", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 202, payload: { ok: true, detail: "已批准并重新发起一轮执行" } }),
    });
    await client.openSession("cs-1");
    calls.length = 0;

    await client.decide("dc-1", "approve", "按方案 B", "改用方案 B");

    expect(calls[0]?.url).toBe(`${PANEL_SESSIONS_URL}/cs-1/decisions/dc-1`);
    expect(calls[0]?.body).toEqual({
      by: "owner",
      decision: "approve",
      reason: "按方案 B",
      text: "改用方案 B",
    });
    expect(seen.statuses[0]?.message).toBe("已作出决定：已批准并重新发起一轮执行");
  });

  it("没有补充指令时不发空字段", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 200, payload: { ok: true, detail: "已批准" } }),
    });
    await client.openSession("cs-1");
    calls.length = 0;

    await client.decide("dc-1", "reject", "不做");

    expect(calls[0]?.body).toEqual({ by: "owner", decision: "reject", reason: "不做" });
  });

  it("未选中会话就发消息：明确拒绝，不发请求", async () => {
    const { client, calls } = writes();

    const outcome = await client.send("你好");

    expect(outcome).toEqual({ ok: false, message: "先选择一个会话。" });
    expect(seen.statuses).toEqual([{ message: "先选择一个会话。", tone: "error" }]);
    expect(calls).toEqual([]);
  });

  it("新建会话后自动选中最新的一条", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 201, payload: { ok: true, detail: "已新建会话" } }),
    });

    const outcome = await client.createSession("forgeloop", "新的会话");

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.url).toBe(PANEL_SESSIONS_URL);
    expect(calls[0]?.body).toEqual({ by: "owner", project: "forgeloop", title: "新的会话" });
    expect(seen.statuses[0]?.message).toBe("已新建会话：已新建会话");
    expect(client.selectedSessionId).toBe(sampleSession().session_id);
  });

  it("新建会话成功但清单里没有会话时不误选", async () => {
    const { client } = writes({
      write: () => ({ status: 201, payload: { ok: true, detail: "已新建会话" } }),
      panel: () => ({ payload: samplePanelDocument({ sessions: [] }) }),
    });

    const outcome = await client.createSession("forgeloop", "新的会话");

    expect(outcome.ok).toBe(true);
    expect(client.selectedSessionId).toBe("");
  });

  it("写成功但总览刷新失败时不误选一个不存在的会话", async () => {
    let panelCalls = 0;
    const { client } = writes({
      write: () => ({ status: 201, payload: { ok: true, detail: "已新建会话" } }),
      panel: () => {
        panelCalls += 1;
        return { status: 500, payload: { error: "panel_failed", detail: "面板不可读" } };
      },
    });

    const outcome = await client.createSession("forgeloop", "新的会话");

    expect(outcome.ok).toBe(true);
    expect(panelCalls).toBe(1);
    expect(client.selectedSessionId).toBe("");
  });

  it("新建会话失败时不改变选择", async () => {
    const { client } = writes({
      write: () => ({
        status: 409,
        payload: { error: "runtime_not_ready", detail: "项目 forgeloop 的运行时未就绪" },
      }),
    });

    await client.createSession("forgeloop", "新的会话");

    expect(client.selectedSessionId).toBe("");
  });

  it("项目档案增删改都打到对应端点", async () => {
    const { client, calls } = writes({
      write: () => ({ status: 200, payload: { ok: true, detail: "已保存" } }),
    });
    const draft = {
      name: "demo",
      path: "/srv/demo",
      description: "演示",
      piCommand: ["pi", "--mode", "rpc"],
      piHome: "/home/demo/pi-home",
    };

    await client.createProject(draft);
    await client.updateProject("demo", draft);
    await client.removeProject("demo", "清理");

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url)).toEqual([
      PANEL_PROJECTS_URL,
      `${PANEL_PROJECTS_URL}/demo/update`,
      `${PANEL_PROJECTS_URL}/demo/remove`,
    ]);
    const archive = {
      by: "owner",
      name: "demo",
      path: "/srv/demo",
      description: "演示",
      pi_command: ["pi", "--mode", "rpc"],
      pi_home: "/home/demo/pi-home",
    };
    expect(posts[0]?.body).toEqual(archive);
    expect(posts[1]?.body).toEqual(archive);
    expect(posts[2]?.body).toEqual({ by: "owner", reason: "清理" });
    expect(seen.statuses.map((entry) => entry.message)).toEqual([
      "已新增项目：已保存",
      "已更新项目：已保存",
      "已删除项目：已保存",
    ]);
  });
});
