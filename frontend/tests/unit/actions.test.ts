/**
 * 写入口模块的单元测试（R3）：令牌读取、请求拼装与结果解读。
 *
 * 只测确定性逻辑：真实网络、真实服务端与真实浏览器分别在组件层、集成层与
 * Playwright 用例里覆盖；这里用替身 `fetch` 钉住「页面到底发了什么」与
 * 「失败绝不显示成成功」。
 */

import { describe, expect, it } from "vitest";

import {
  actionRequest,
  forgetSubmitKey,
  loadSubmitKey,
  newClientKey,
  operationsAvailable,
  rememberSubmitKey,
  performOperation,
  readToken,
  submitRequest,
  type OperationFetcher,
} from "../../src/actions.js";
import { TOKEN_HEADER, TOKEN_PLACEHOLDER } from "../../src/payload.js";

function documentWithToken(content: string | null): Document {
  const document = globalThis.document.implementation.createHTMLDocument("t");
  if (content !== null) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "forgeloop-token");
    meta.setAttribute("content", content);
    document.head.append(meta);
  }
  return document;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readToken", () => {
  it("注入后的令牌被读出来", () => {
    expect(readToken(documentWithToken("tok-123"))).toBe("tok-123");
  });

  it("占位符视为没有令牌（只读 web 服务）", () => {
    expect(readToken(documentWithToken(TOKEN_PLACEHOLDER))).toBe("");
  });

  it("没有 meta 时视为没有令牌", () => {
    expect(readToken(documentWithToken(null))).toBe("");
  });

  it("meta 存在但没有 content 属性时视为没有令牌", () => {
    const document = globalThis.document.implementation.createHTMLDocument("t");
    const meta = document.createElement("meta");
    meta.setAttribute("name", "forgeloop-token");
    document.head.append(meta);

    expect(readToken(document)).toBe("");
  });

  it("空白令牌视为没有令牌", () => {
    expect(readToken(documentWithToken("   "))).toBe("");
  });
});

describe("operationsAvailable", () => {
  it("空令牌不可用，非空可用", () => {
    expect(operationsAvailable("")).toBe(false);
    expect(operationsAvailable("tok")).toBe(true);
  });
});

describe("submitRequest", () => {
  it("提交请求带 by/project/text，并去掉首尾空白", () => {
    const request = submitRequest(" ForgeLoop ", " 加邮箱 ", " owner ", " 页面提交 ");
    expect(request.url).toBe("/api/requirements");
    expect(request.body).toEqual({
      by: "owner",
      project: "ForgeLoop",
      text: "加邮箱",
      reason: "页面提交",
    });
  });
});

describe("newClientKey", () => {
  it("优先用 Web Crypto 的 UUID", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
      configurable: true,
    });
    try {
      expect(newClientKey()).toBe("11111111-2222-3333-4444-555555555555");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });

  it("环境没有 randomUUID 时退回时间戳 + 随机串，且两次不同", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      const first = newClientKey();
      const second = newClientKey();
      expect(first.startsWith("k-")).toBe(true);
      expect(first).not.toBe(second);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("提交键的会话暂存", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
      removeItem: (key: string) => {
        delete data[key];
      },
      snapshot: () => ({ ...data }),
    };
  }

  it("写入后能读回，清掉后读不到", () => {
    const storage = fakeStorage();
    expect(loadSubmitKey(storage)).toBe("");
    rememberSubmitKey(storage, "key-1");
    expect(loadSubmitKey(storage)).toBe("key-1");
    forgetSubmitKey(storage);
    expect(loadSubmitKey(storage)).toBe("");
  });

  it("没有存储时读回空串且写入不抛错", () => {
    expect(loadSubmitKey(undefined)).toBe("");
    expect(() => rememberSubmitKey(undefined, "key-1")).not.toThrow();
    expect(() => forgetSubmitKey(undefined)).not.toThrow();
  });

  it("存储本身抛错（隐私模式/沙箱）时静默退化", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSubmitKey(hostile)).toBe("");
    expect(() => rememberSubmitKey(hostile, "k")).not.toThrow();
    expect(() => forgetSubmitKey(hostile)).not.toThrow();
  });

  it("首尾空白的暂存键视为没有键", () => {
    expect(loadSubmitKey(fakeStorage({ "forgeloop:submit-key": "   " }))).toBe("");
  });
});

describe("submitRequest 的幂等键", () => {
  it("给出键时进请求体并去掉首尾空白", () => {
    const request = submitRequest("P", "t", "owner", "", "  key-1  ");
    expect(request.body.key).toBe("key-1");
  });

  it("没有键时不带 key 字段（服务端保持历史行为）", () => {
    const request = submitRequest("P", "t", "owner", "", "   ");
    expect("key" in request.body).toBe(false);
  });
});

describe("actionRequest", () => {
  it("动作 URL 与请求体：需求身份做 URL 编码", () => {
    const request = actionRequest("req-1", "approve", "owner", "页面批准");
    expect(request.url).toBe("/api/requirements/req-1/approve");
    expect(request.body).toEqual({ by: "owner", reason: "页面批准" });
  });

  it("需求身份里的特殊字符被编码，不会拼出别的路径", () => {
    const request = actionRequest("req/../x", "stop", "owner", "r");
    expect(request.url).toBe("/api/requirements/req%2F..%2Fx/stop");
  });

  it("动作请求也去掉 by 与理由的首尾空白", () => {
    const request = actionRequest("req-1", "approve", "  owner  ", "  页面批准  ");
    expect(request.body).toEqual({ by: "owner", reason: "页面批准" });
  });

  it("推进可以不带理由", () => {
    expect(actionRequest("req-1", "advance", "owner", "").body.reason).toBe("");
  });
});

describe("performOperation", () => {
  it("成功时带令牌头并返回需求身份", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: OperationFetcher = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(201, { ok: true, req_id: "req-9" }));
    };

    const outcome = await performOperation(submitRequest("P", "t", "owner", ""), "tok", fetcher);

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("req-9");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[TOKEN_HEADER]).toBe("tok");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ by: "owner", project: "P", text: "t", reason: "" }),
    );
  });

  it("服务端拒绝时把 detail 原样显示", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(409, { error: "refused", detail: "该需求当前不可自动推进" }));

    const outcome = await performOperation(
      actionRequest("r", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("该需求当前不可自动推进");
  });

  it("只有机器标签时显示标签，不编造原因", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(403, { error: "token_required" }));

    const outcome = await performOperation(
      actionRequest("r", "approve", "owner", "x"),
      "bad",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("token_required");
  });

  it("非 JSON 错误体退回状态码，不显示成功", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(new Response("<html>500</html>", { status: 500 }));

    const outcome = await performOperation(
      actionRequest("r", "accept", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("HTTP 500");
  });

  it("网络失败返回失败原因", async () => {
    const fetcher: OperationFetcher = () => Promise.reject(new Error("网络断了"));

    const outcome = await performOperation(
      actionRequest("r", "stop", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("网络断了");
  });

  it("批准类响应带 req_id 时仍显示服务端 output（不是「已受理」）", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          operation: "approve",
          req_id: "req-1",
          output: "任务包 v1 已批准（授权来源 web:owner）。",
        }),
      );

    const outcome = await performOperation(
      actionRequest("req-1", "approve", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("任务包 v1 已批准");
    expect(outcome.message).not.toContain("已受理");
  });

  it("推进受理（202 queued）说清是排队而不是已完成", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(
        jsonResponse(202, {
          ok: true,
          operation: "advance",
          req_id: "req-1",
          queued: true,
          detail: "已受理，常驻进程将在下一次心跳执行",
        }),
      );

    const outcome = await performOperation(
      actionRequest("req-1", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("已受理推进");
    expect(outcome.message).toContain("心跳");
    expect(outcome.message).not.toContain("已完成");
  });

  it("output 为空串时回退到「已受理」（空串不算内容）", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(200, { ok: true, req_id: "req-7", output: "" }));

    const outcome = await performOperation(
      actionRequest("req-7", "approve", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.message).toBe("已受理：req-7");
  });

  it("既无 output 也无 req_id 时给中性完成文案", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(jsonResponse(200, { ok: true }));

    const outcome = await performOperation(
      actionRequest("req-7", "stop", "owner", "r"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("操作已完成。");
  });

  it("成功响应不是 JSON 时仍算成功并给中性文案", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(new Response("ok", { status: 200 }));

    const outcome = await performOperation(
      actionRequest("req-7", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("操作已完成。");
  });

  it("错误响应只带空 detail 时退回机器标签", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(409, { error: "refused", detail: "" }));

    const outcome = await performOperation(
      actionRequest("req-7", "accept", "owner", "r"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("refused");
  });

  it("错误响应是标量 JSON 时退回状态码，不臆造原因", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(jsonResponse(409, 42));

    const outcome = await performOperation(
      actionRequest("r", "approve", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("HTTP 409");
  });

  it("错误体既无 detail 也无 machine code 时退回状态码", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(500, { error: "", detail: "" }));

    const outcome = await performOperation(
      actionRequest("r", "accept", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("HTTP 500");
  });

  it("成功响应是字符串标量时给中性文案", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(jsonResponse(200, "done"));

    const outcome = await performOperation(
      actionRequest("r", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("操作已完成。");
  });

  it("成功响应是 null 时给中性文案（不把 null 当对象读字段）", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(jsonResponse(200, null));

    const outcome = await performOperation(
      actionRequest("r", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("操作已完成。");
  });

  it("错误响应是 null 时退回状态码（读取被 try/catch 收敛）", async () => {
    const fetcher: OperationFetcher = () => Promise.resolve(jsonResponse(409, null));

    const outcome = await performOperation(
      actionRequest("r", "approve", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("HTTP 409");
  });

  it("受理标记为真但缺需求身份时不硬拼文案", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(202, { ok: true, queued: true }));

    const outcome = await performOperation(
      actionRequest("r", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.message).toBe("操作已完成。");
  });

  it("受理标记为真但身份是空串时不硬拼文案", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(202, { ok: true, queued: true, req_id: "" }));

    const outcome = await performOperation(
      actionRequest("r", "advance", "owner", ""),
      "tok",
      fetcher,
    );

    expect(outcome.message).toBe("操作已完成。");
  });

  it("身份是空串且没有 output 时给中性文案", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(jsonResponse(200, { ok: true, req_id: "" }));

    const outcome = await performOperation(
      actionRequest("r", "approve", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.message).toBe("操作已完成。");
  });

  it("请求头固定为 JSON 且带令牌", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetcher: OperationFetcher = (_url, init) => {
      calls.push({ init });
      return Promise.resolve(jsonResponse(200, { ok: true }));
    };

    await performOperation(submitRequest("P", "t", "owner", ""), "tok-9", fetcher);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[TOKEN_HEADER]).toBe("tok-9");
  });

  it("验收成功的文本来自 output", async () => {
    const fetcher: OperationFetcher = () =>
      Promise.resolve(
        jsonResponse(200, { ok: true, operation: "accept", output: "需求整体验收通过" }),
      );

    const outcome = await performOperation(
      actionRequest("r", "accept", "owner", "x"),
      "tok",
      fetcher,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("需求整体验收通过");
  });
});
