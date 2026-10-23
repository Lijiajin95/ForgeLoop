/**
 * 默认取数实现（真实 `fetch` 边界）的单元测试。
 *
 * `fetch` 是这条代码唯一的浏览器边界，因此在这里用替身固定「成功 / 非 2xx 带
 * detail / 非 JSON 响应 / detail 类型不对」四种形态；真正的网络与浏览器行为由
 * Playwright 用例对真实服务核对（tests/e2e）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultFetcher } from "../../src/progress.js";
import { sampleDocument } from "../fixtures/page.js";

function responseLike(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultFetcher", () => {
  it("请求进展接口并返回文档，且禁用缓存", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(responseLike(sampleDocument())));
    vi.stubGlobal("fetch", fetchMock);

    const progress = await defaultFetcher("/api/progress");

    expect(progress.refresh_seconds).toBe(60);
    expect(fetchMock).toHaveBeenCalledWith("/api/progress", { cache: "no-store" });
  });

  it("非 2xx 时抛出服务端给出的原因", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        responseLike(
          { error: "progress_failed", detail: "记录库损坏" },
          { ok: false, status: 500 },
        ),
      ),
    );

    await expect(defaultFetcher("/api/progress")).rejects.toThrow("读取进展失败: 记录库损坏");
  });

  it("响应不是 JSON 时按状态码报告，不伪造原因", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response),
    );

    await expect(defaultFetcher("/api/progress")).rejects.toThrow("读取进展失败: HTTP 502");
  });

  it("detail 不是字符串时按状态码报告", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(responseLike({ detail: 42 }, { ok: false, status: 503 })),
    );

    await expect(defaultFetcher("/api/progress")).rejects.toThrow("HTTP 503");
  });

  it.each([
    ["字符串响应体", "服务不可用"],
    ["数字响应体", 42],
    ["null 响应体", null],
    ["数组响应体", ["a"]],
  ])("响应体不是对象时（%s）按状态码报告", async (_label, body) => {
    vi.stubGlobal("fetch", () => Promise.resolve(responseLike(body, { ok: false, status: 502 })));

    await expect(defaultFetcher("/api/progress")).rejects.toThrow("HTTP 502");
  });
});
