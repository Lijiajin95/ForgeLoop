/**
 * 操作面板的组件测试：真实页面 HTML + 真实接线 + 注入写请求替身。
 *
 * 核对的是「页面到底发了什么、显示了什么」：没有令牌时面板不可见；有令牌时提交与
 * 四类动作都发同一种写请求；缺理由时先拦下不发；服务端拒绝时把原因显示为错误而不是
 * 成功。真实 HTTP 边界在 `tests/integration/test_serve_operations.py`，真实浏览器在
 * Playwright 用例里。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationFetcher } from "../../src/actions.js";
import { TOKEN_HEADER } from "../../src/payload.js";
import { bootstrap } from "../../src/page.js";
import { installTokenMeta, loadPageBody, sampleDocument } from "../fixtures/page.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fetcherOf(responses: Response[]): { fetcher: OperationFetcher; calls: Call[] } {
  const queue = [...responses];
  const calls: Call[] = [];
  const fetcher: OperationFetcher = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    return next === undefined
      ? Promise.reject(new Error("测试没有准备更多响应"))
      : Promise.resolve(next);
  };
  return { fetcher, calls };
}

function ok(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function injectToken(token: string): void {
  installTokenMeta(token);
}

function progressFetcher() {
  return () => Promise.resolve(sampleDocument());
}

function click(id: string): void {
  document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function submit(): void {
  document
    .getElementById("submit-form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function statusText(): string {
  return document.getElementById("operations-status")?.textContent ?? "";
}

function setValue(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = value;
  }
}

beforeEach(() => {
  loadPageBody();
});

describe("操作面板可见性", () => {
  it("只读服务（占位令牌）不显示面板，也不发任何写请求", async () => {
    const { fetcher, calls } = fetcherOf([]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;

    const panel = document.getElementById("operations");
    expect(panel?.hidden).toBe(true);
    // 只读服务（web）不下发令牌：面板隐藏，点击也不发写请求。
    click("action-approve");
    expect(calls).toHaveLength(0);
  });

  it("注入令牌后显示面板", async () => {
    injectToken("tok-1");
    const client = bootstrap(document, { fetcher: progressFetcher() });
    await client.pending;

    expect(document.getElementById("operations")?.hidden).toBe(false);
  });
});

describe("提交需求", () => {
  it("填好表单后 POST 到需求端点并显示受理结果", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([ok({ ok: true, req_id: "req-42" }, 201)]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("submit-project", "ForgeLoop");
    setValue("submit-text", "页面提交的需求");
    setValue("operations-by", "owner");

    submit();
    await vi.waitFor(() => {
      expect(statusText()).toContain("req-42");
    });

    expect(calls[0]?.url).toBe("/api/requirements");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[TOKEN_HEADER]).toBe("tok-1");
    const rawBody = calls[0]?.init.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<string, string>;
    expect(body["project"]).toBe("ForgeLoop");
    expect(body["text"]).toBe("页面提交的需求");
    expect(body["by"]).toBe("owner");
    expect(document.getElementById("operations-status")?.dataset["tone"]).toBe("info");
  });

  it("项目或正文为空时先拦下，不发请求", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("submit-project", "ForgeLoop");

    submit();
    await vi.waitFor(() => {
      expect(statusText()).toContain("项目与正文");
    });

    expect(calls).toHaveLength(0);
  });
});

describe("分析与规划", () => {
  it("分析不需要理由，POST 到 analyze 并显示受理", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([
      ok({ ok: true, operation: "analyze", req_id: "req-1", queued: true }),
    ]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;

    click("action-analyze");
    await vi.waitFor(() => {
      expect(statusText()).toContain("已受理分析");
    });

    const selected = document.getElementById("action-req");
    const reqId = selected instanceof HTMLSelectElement ? selected.value : "";
    expect(calls[0]?.url).toBe(`/api/requirements/${reqId}/analyze`);
  });

  it("规划不需要理由，POST 到 plan", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([
      ok({ ok: true, operation: "plan", req_id: "req-1", queued: true }),
    ]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;

    click("action-plan");
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const selected = document.getElementById("action-req");
    const reqId = selected instanceof HTMLSelectElement ? selected.value : "";
    expect(calls[0]?.url).toBe(`/api/requirements/${reqId}/plan`);
  });
});

describe("修订需求", () => {
  it("修订正文进 text 字段、POST 到 revise，成功后清空", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([
      ok({ ok: true, operation: "revise", output: "需求已修订: 版本 2" }),
    ]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("revise-text", "新的需求正文");
    setValue("action-reason", "补充细节");

    click("action-revise");
    await vi.waitFor(() => {
      expect(statusText()).toContain("版本 2");
    });

    const selected = document.getElementById("action-req");
    const reqId = selected instanceof HTMLSelectElement ? selected.value : "";
    expect(calls[0]?.url).toBe(`/api/requirements/${reqId}/revise`);
    const rawBody = calls[0]?.init.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<string, string>;
    expect(body["text"]).toBe("新的需求正文");
    expect(body["reason"]).toBe("补充细节");
    expect((document.getElementById("revise-text") as HTMLTextAreaElement).value).toBe("");
  });

  it("修订正文为空时不发请求", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("revise-text", "   ");

    click("action-revise");
    await vi.waitFor(() => {
      expect(statusText()).toContain("修订正文不能为空");
    });

    expect(calls).toHaveLength(0);
  });
});

describe("需求动作", () => {
  it("批准带上理由并 POST 到批准端点", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([
      ok({ ok: true, operation: "approve", output: "已批准" }),
    ]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    expect(document.getElementById("action-req")).not.toBeNull();
    setValue("action-reason", "页面批准");

    click("action-approve");
    await vi.waitFor(() => {
      expect(statusText()).toContain("已批准");
    });

    const selected = document.getElementById("action-req");
    const reqId = selected instanceof HTMLSelectElement ? selected.value : "";
    expect(reqId).not.toBe("");
    expect(calls[0]?.url).toBe(`/api/requirements/${reqId}/approve`);
    const rawBody = calls[0]?.init.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<string, string>;
    expect(body["reason"]).toBe("页面批准");
    expect(body["by"]).toBe("owner");
  });

  it("批准缺理由时不发请求并提示", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("action-reason", "");

    click("action-approve");
    await vi.waitFor(() => {
      expect(statusText()).toContain("需要填写理由");
    });

    expect(calls).toHaveLength(0);
  });

  it("推进可以不填理由", async () => {
    injectToken("tok-1");
    const { fetcher, calls } = fetcherOf([ok({ ok: true, operation: "advance" })]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;

    click("action-advance");
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const selected = document.getElementById("action-req");
    const reqId = selected instanceof HTMLSelectElement ? selected.value : "";
    expect(calls[0]?.url).toBe(`/api/requirements/${reqId}/advance`);
  });

  it("服务端拒绝时显示原因并用错误色调", async () => {
    injectToken("tok-1");
    const { fetcher } = fetcherOf([
      ok({ error: "refused", detail: "该需求当前不可自动推进" }, 409),
    ]);
    const client = bootstrap(document, { fetcher: progressFetcher(), operationFetcher: fetcher });
    await client.pending;
    setValue("action-reason", "试试推进");

    click("action-approve");
    await vi.waitFor(() => {
      expect(statusText()).toBe("该需求当前不可自动推进");
    });

    expect(document.getElementById("operations-status")?.dataset["tone"]).toBe("error");
  });
});
