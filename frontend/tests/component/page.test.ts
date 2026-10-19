/**
 * 装配层的组件测试：用**真实页面 HTML** + 注入取数跑完整接线。
 *
 * 这是快速层里最接近真实页面的一条：元素解析、页签接线、首次读取、渲染、错误横幅、
 * 「立即刷新」按钮、倒计时与跨页签跳转都走真实函数，只把网络替换掉。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgressDocument } from "../../src/payload.js";
import type { ProgressFetcher } from "../../src/progress.js";
import { bootstrap } from "../../src/page.js";
import { activeTab, resolveTabs } from "../../src/tabs.js";
import { loadPageBody, sampleDocument } from "../fixtures/page.js";

function fetcherOf(responses: (ProgressDocument | Error)[]): ProgressFetcher {
  const queue = [...responses];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("测试没有准备更多响应"));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
}

beforeEach(() => {
  window.location.hash = "";
  loadPageBody();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("bootstrap", () => {
  it("首次读取后把进展渲染进真实页面", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });

    await client.pending;

    expect(document.getElementById("count-requirements")?.textContent).toBe("2");
    expect(document.getElementById("count-issues")?.textContent).toBe("2");
    expect(document.getElementById("refresh-note")?.textContent).toBe(
      "自动刷新: 每 60 秒（来源: 配置文件）",
    );
    expect(document.getElementById("countdown")?.textContent).toBe("60 秒后刷新");
    expect(document.querySelectorAll("#tasks-body tbody tr")).toHaveLength(3);
    expect(document.getElementById("banner")?.style.display).toBe("none");
  });

  it("读取失败时显示错误横幅，恢复后自动清除", async () => {
    const client = bootstrap(document, {
      fetcher: fetcherOf([new Error("读取进展失败: HTTP 503"), sampleDocument()]),
    });

    await client.pending;

    const banner = document.getElementById("banner");
    expect(banner?.style.display).toBe("block");
    expect(banner?.textContent).toBe("读取进展失败: HTTP 503");

    client.manualRefresh();
    await client.pending;

    expect(banner?.style.display).toBe("none");
    expect(banner?.textContent).toBe("");
  });

  it("点击「立即刷新」按钮会再取一次", async () => {
    const responses: ProgressDocument[] = [sampleDocument()];
    let calls = 0;
    const client = bootstrap(document, {
      fetcher: () => {
        calls += 1;
        const next = responses.shift();
        return next === undefined
          ? Promise.reject(new Error("测试没有准备更多响应"))
          : Promise.resolve(next);
      },
    });
    await client.pending;
    expect(calls).toBe(1);

    document.getElementById("refresh-button")?.click();
    await client.pending;

    expect(calls).toBe(2);
  });

  it("自动刷新重绘不会把用户踢回需求页签", async () => {
    const client = bootstrap(document, {
      fetcher: fetcherOf([sampleDocument(), sampleDocument()]),
    });
    await client.pending;

    const tabs = resolveTabs(document);
    tabs.buttons.get("issues")?.click();
    expect(activeTab(tabs)).toBe("issues");

    client.manualRefresh();
    await client.pending;

    expect(activeTab(tabs)).toBe("issues");
    expect(document.getElementById("panel-issues")?.hidden).toBe(false);
  });

  it("折叠选择在自动刷新重绘后仍然有效", async () => {
    const client = bootstrap(document, {
      fetcher: fetcherOf([sampleDocument(), sampleDocument()]),
    });
    await client.pending;

    const card = document.querySelector<HTMLElement>("#requirements-body article.card");
    card?.querySelector<HTMLButtonElement>(".collapse-toggle")?.click();
    expect(card?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(true);

    client.manualRefresh();
    await client.pending;

    const rebuilt = document.querySelector<HTMLElement>("#requirements-body article.card");
    expect(rebuilt?.querySelector<HTMLElement>(".card-body")?.hidden).toBe(true);
    expect(rebuilt?.querySelector<HTMLButtonElement>(".collapse-toggle")?.textContent).toBe("展开");
  });

  it("点击需求里的任务会切到任务页签并高亮那条任务", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    document
      .querySelector<HTMLButtonElement>(
        '#requirements-body tr[data-ref="task-blocked"] .link-button',
      )
      ?.click();

    expect(activeTab(resolveTabs(document))).toBe("tasks");
    expect(
      document
        .querySelector('#tasks-body tr[data-ref="task-blocked"]')
        ?.classList.contains("target"),
    ).toBe(true);
  });

  it("页面缺少元素时装配直接失败，不留下空页面", () => {
    document.body.innerHTML = "";

    expect(() => bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) })).toThrow(
      /缺少元素/,
    );
  });
});
