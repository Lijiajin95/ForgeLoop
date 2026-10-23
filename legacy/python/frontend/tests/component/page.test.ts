/**
 * 装配层的组件测试：用**真实页面 HTML** + 注入取数跑完整接线。
 *
 * 这是快速层里最接近真实页面的一条：元素解析、页签接线、首次读取、索引/档案、
 * 错误横幅、刷新按钮、跨页签跳转与写入口抽屉都走真实函数，只把网络替换掉。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgressDocument } from "../../src/payload.js";
import type { ProgressFetcher } from "../../src/progress.js";
import { bootstrap, bootstrapPanel } from "../../src/page.js";
import { activeTab, resolveTabs } from "../../src/tabs.js";
import { installTokenMeta, loadPageBody, sampleDocument } from "../fixtures/page.js";

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

function selectedDetail(id: string): void {
  const rows = document.querySelectorAll<HTMLButtonElement>("#requirements-body .record-row");
  const row = [...rows].find((item) => item.dataset["ref"] === id);
  row?.click();
}

beforeEach(() => {
  window.location.hash = "";
  document.head.querySelector('meta[name="forgeloop-token"]')?.remove();
  loadPageBody();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("bootstrap：只读模式", () => {
  it("没有令牌时默认落在需求，并把索引与档案渲染出来", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    const tabs = resolveTabs(document);
    expect(activeTab(tabs)).toBe("requirements");
    expect(document.getElementById("count-requirements")?.textContent).toBe("2");
    expect(document.querySelectorAll("#requirements-body .record-row")).toHaveLength(2);
    expect(document.querySelector("#requirements-detail .dossier-id")?.textContent).toBe(
      "req-forgeloop-1",
    );
    expect(document.getElementById("panel")?.hidden).toBe(true);
    bootstrapPanel(document);
    expect(document.getElementById("chat-unavailable")?.hidden).toBe(false);
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
  });

  it("点击「刷新」按钮会再取一次", async () => {
    let calls = 0;
    const client = bootstrap(document, {
      fetcher: () => {
        calls += 1;
        return Promise.resolve(sampleDocument());
      },
    });
    await client.pending;
    expect(calls).toBe(1);

    document.getElementById("refresh-button")?.click();
    await client.pending;
    expect(calls).toBe(2);
  });
});

describe("bootstrap：有令牌时默认会话", () => {
  it("写入口可见、默认视图是会话，并打开抽屉", async () => {
    installTokenMeta("page-token");
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    expect(activeTab(resolveTabs(document))).toBe("chat");
    expect(document.getElementById("panel-chat")?.hidden).toBe(false);
    expect(document.getElementById("operations-open")?.hidden).toBe(false);

    const drawer = document.getElementById("operations-drawer");
    expect(drawer?.hidden).toBe(true);
    document.getElementById("operations-open")?.click();
    expect(drawer?.hidden).toBe(false);
    document.getElementById("operations-close")?.click();
    expect(drawer?.hidden).toBe(true);
  });
});

describe("选择与跳转", () => {
  it("点需求索引行会把档案换成该需求", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    selectedDetail("req-forgeloop-2");
    expect(document.querySelector("#requirements-detail .dossier-id")?.textContent).toBe(
      "req-forgeloop-2",
    );
    expect(
      document
        .querySelector('#requirements-body .record-row[data-ref="req-forgeloop-2"]')
        ?.classList.contains("is-selected"),
    ).toBe(true);
  });

  it("自动刷新重绘不会把用户踢回需求，也不丢选择", async () => {
    const client = bootstrap(document, {
      fetcher: fetcherOf([sampleDocument(), sampleDocument()]),
    });
    await client.pending;

    const tabs = resolveTabs(document);
    tabs.buttons.get("issues")?.click();
    selectedDetail("req-forgeloop-2");

    client.manualRefresh();
    await client.pending;

    expect(activeTab(tabs)).toBe("issues");
    expect(document.getElementById("panel-issues")?.hidden).toBe(false);
    expect(document.querySelector("#requirements-detail .dossier-id")?.textContent).toBe(
      "req-forgeloop-2",
    );
  });

  it("点档案里的任务会切到任务页签、选中并高亮那条任务", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    document.querySelector<HTMLButtonElement>("#requirements-detail .task-link")?.click();

    expect(activeTab(resolveTabs(document))).toBe("tasks");
    expect(document.querySelector("#tasks-detail .dossier-id")?.textContent).toBe("task-first");
    expect(
      document
        .querySelector('#tasks-body .record-row[data-ref="task-first"]')
        ?.classList.contains("target"),
    ).toBe(true);
  });

  it("从问题档案跳到对象所在任务", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    document.getElementById("tab-issues")?.click();
    document.querySelector<HTMLButtonElement>("#issues-detail .button")?.click();

    expect(activeTab(resolveTabs(document))).toBe("tasks");
    expect(document.querySelector("#tasks-detail .dossier-id")?.textContent).toBe("task-blocked");
  });

  it("「处理这条需求」会把动作下拉框预填成当前需求", async () => {
    installTokenMeta("page-token");
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    selectedDetail("req-forgeloop-2");
    const operate = [
      ...document.querySelectorAll<HTMLButtonElement>("#requirements-detail button"),
    ].find((button) => button.textContent === "处理这条需求");
    operate?.click();

    expect(document.getElementById("operations-drawer")?.hidden).toBe(false);
    expect((document.getElementById("action-req") as HTMLSelectElement | null)?.value).toBe(
      "req-forgeloop-2",
    );
  });
});

describe("写入口抽屉的边界", () => {
  it("遮罩与 Escape 都能关闭抽屉", async () => {
    installTokenMeta("page-token");
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;
    const drawer = document.getElementById("operations-drawer");
    const open = document.getElementById("operations-open");

    open?.click();
    expect(drawer?.hidden).toBe(false);
    document.querySelector<HTMLElement>(".drawer-scrim")?.click();
    expect(drawer?.hidden).toBe(true);

    open?.click();
    expect(drawer?.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer?.hidden).toBe(true);
  });

  it("没有令牌时入口隐藏，点击也不会打开抽屉", async () => {
    const client = bootstrap(document, { fetcher: fetcherOf([sampleDocument()]) });
    await client.pending;

    expect(document.getElementById("operations-open")?.hidden).toBe(true);
    document.getElementById("operations-open")?.click();
    expect(document.getElementById("operations-drawer")?.hidden).toBe(true);
  });
});
