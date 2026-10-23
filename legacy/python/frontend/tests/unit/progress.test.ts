/**
 * 轮询与调度的单元测试（无浏览器、无网络：取数与时钟都注入）。
 *
 * 放在单元层是因为 `progress.ts` 本身不碰 DOM：变异测试只选单元层用例
 * （与 mutmut 的 unit+property 口径一致），这个文件必须在其中才能判定调度逻辑。
 *
 * 刷新节奏是页面的关键行为：间隔来自服务端配置（0 表示关闭）、到点才再取、
 * 同一时刻只允许一次在途读取、失败必须报错且不静默停摆。
 */

import { describe, expect, it, vi } from "vitest";

import type { ProgressDocument } from "../../src/payload.js";
import { ProgressClient, errorMessage } from "../../src/progress.js";
import { sampleDocument } from "../fixtures/page.js";

/** 取出队首响应：Error 作为拒绝、文档作为成功，队列空则明确失败。 */
function nextResponse(queue: (ProgressDocument | Error)[]): Promise<ProgressDocument> {
  const next = queue.shift();
  if (next === undefined) {
    return Promise.reject(new Error("测试没有准备更多响应"));
  }
  if (next instanceof Error) {
    return Promise.reject(next);
  }
  return Promise.resolve(next);
}

interface Harness {
  readonly client: ProgressClient;
  readonly documents: ProgressDocument[];
  readonly errors: string[];
  readonly countdowns: string[];
  readonly calls: string[];
  advance(ms: number): void;
}

function harness(
  responses: (ProgressDocument | Error)[],
  options: { clock?: number } = {},
): Harness {
  let now = options.clock ?? 1000;
  const documents: ProgressDocument[] = [];
  const errors: string[] = [];
  const countdowns: string[] = [];
  const calls: string[] = [];
  const queue = [...responses];
  const client = new ProgressClient({
    url: "/api/progress",
    onDocument: (document) => {
      documents.push(document);
    },
    onError: (message) => {
      errors.push(message);
    },
    onCountdown: (message) => {
      countdowns.push(message);
    },
    fetcher: (url) => {
      calls.push(url);
      return nextResponse(queue);
    },
    now: () => now,
  });
  return {
    client,
    documents,
    errors,
    countdowns,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ProgressClient.refresh", () => {
  it("读取成功时交付文档并按配置安排下一次刷新", async () => {
    const test = harness([sampleDocument({ refresh_seconds: 30 })]);

    await test.client.refresh();

    expect(test.calls).toEqual(["/api/progress"]);
    expect(test.documents).toHaveLength(1);
    expect(test.client.refreshSeconds).toBe(30);
    expect(test.countdowns.at(-1)).toBe("30 秒后刷新");
  });

  it("读取失败时如实报错，并按内建默认继续重试而不是停摆", async () => {
    const test = harness([new Error("读取进展失败: HTTP 500")]);

    await test.client.refresh();

    expect(test.errors).toEqual(["读取进展失败: HTTP 500"]);
    expect(test.documents).toHaveLength(0);
    expect(test.client.refreshSeconds).toBeUndefined();
    expect(test.client.autoRefreshOff).toBe(false);
    // 未读到配置前按内建默认（60 秒）重试，且不谎称「已关闭」。
    expect(test.countdowns.at(-1)).toBe("60 秒后刷新");

    test.advance(60_000);
    test.client.tick();
    await test.client.pending;
    expect(test.calls).toHaveLength(2);
  });

  it("同一时刻只允许一次在途读取", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const client = new ProgressClient({
      url: "/api/progress",
      onDocument: () => undefined,
      onError: () => undefined,
      onCountdown: () => undefined,
      fetcher: (url) => {
        calls.push(url);
        return pending.then(() => sampleDocument());
      },
    });

    const first = client.refresh();
    const second = client.refresh();
    release?.();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
  });

  it("把进行中的读取挂在 pending 上（不产生未处理的 Promise）", () => {
    const test = harness([sampleDocument()]);

    expect(test.client.pending).toBeUndefined();
    test.client.manualRefresh();
    expect(test.client.pending).toBeInstanceOf(Promise);
  });
});

describe("ProgressClient.start", () => {
  it("启动后由定时器按秒推进倒计时（定时器被 mock）", async () => {
    vi.useFakeTimers();
    try {
      const countdowns: string[] = [];
      const client = new ProgressClient({
        url: "/api/progress",
        onDocument: () => undefined,
        onError: () => undefined,
        onCountdown: (message) => {
          countdowns.push(message);
        },
        fetcher: () => Promise.resolve(sampleDocument({ refresh_seconds: 5 })),
      });

      client.start();
      await client.pending;
      expect(countdowns.at(-1)).toBe("5 秒后刷新");

      vi.advanceTimersByTime(1000);
      expect(countdowns.at(-1)).toBe("4 秒后刷新");

      vi.advanceTimersByTime(4000);
      await client.pending;
      expect(countdowns.at(-1)).toBe("5 秒后刷新");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProgressClient.tick", () => {
  it("按剩余时间递减倒计时", async () => {
    const test = harness([sampleDocument({ refresh_seconds: 60 })]);
    await test.client.refresh();

    test.advance(30_000);
    test.client.tick();
    expect(test.countdowns.at(-1)).toBe("30 秒后刷新");

    test.advance(29_000);
    test.client.tick();
    expect(test.countdowns.at(-1)).toBe("1 秒后刷新");
  });

  it("到点触发下一次读取，并且不重复触发", async () => {
    const test = harness([sampleDocument({ refresh_seconds: 60 }), sampleDocument()]);
    await test.client.refresh();

    test.advance(60_000);
    test.client.tick();
    expect(test.countdowns.at(-1)).toBe("正在刷新…");
    await test.client.pending;
    expect(test.calls).toHaveLength(2);

    test.client.tick();
    await test.client.pending;
    expect(test.calls).toHaveLength(2);
  });

  it("首次读取完成前不触发读取", () => {
    const test = harness([sampleDocument()]);

    test.client.tick();

    expect(test.calls).toHaveLength(0);
  });

  it("配置为 0 时关闭自动刷新，倒计时固定且不再取数", async () => {
    const test = harness([sampleDocument({ refresh_seconds: 0 })]);
    await test.client.refresh();

    expect(test.client.autoRefreshOff).toBe(true);
    test.advance(600_000);
    test.client.tick();

    expect(test.countdowns.at(-1)).toBe("自动刷新已关闭");
    expect(test.calls).toHaveLength(1);
  });
});

describe("errorMessage", () => {
  it("Error 取消息，其他值转字符串", () => {
    expect(errorMessage(new Error("坏了"))).toBe("坏了");
    expect(errorMessage("坏了")).toBe("坏了");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
