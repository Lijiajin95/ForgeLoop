/**
 * 状态页的真实浏览器用例：真实 Chromium + 真实 `forgeloop web` 进程 + 真实记录。
 *
 * 这一层只看用户能看到的结果：默认落在需求、索引与档案按身份对上、跨段跳转真的
 * 发生、地址栏片段与自动刷新保持当前段与选择、记录文本仍按纯文本渲染。
 */

import { expect, test } from "@playwright/test";

const CHAT_TAB = "#tab-chat";
const REQUIREMENTS_TAB = "#tab-requirements";
const TASKS_TAB = "#tab-tasks";
const ISSUES_TAB = "#tab-issues";

test("默认停在需求：索引只有身份与描述，档案带指标与任务", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#count-requirements")).toHaveText("1");
  await expect(page.locator("#count-tasks")).toHaveText("2");
  await expect(page.locator("#count-issues")).toHaveText("2");

  await expect(page.locator(REQUIREMENTS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-requirements")).toBeVisible();
  await expect(page.locator("#panel-tasks")).toBeHidden();

  const rows = page.locator("#requirements-body .record-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-ref", /^req-/);
  await expect(rows.first()).toContainText("状态页要在真实浏览器里显示进展");
  await expect(rows.first().locator("table")).toHaveCount(0);

  const detail = page.locator("#requirements-detail");
  await expect(detail.locator(".dossier-id")).toHaveText(/^req-/);
  await expect(detail.locator(".dossier-lead")).toContainText("状态页要在真实浏览器里显示进展");
  await expect(detail).toContainText("任务包 v1");
  await expect(detail).toContainText("1 / 2 已交付");
  await expect(detail.locator("tbody tr")).toHaveCount(2);
});

test("点需求档案里的任务跳到任务页签、选中并高亮", async ({ page }) => {
  await page.goto("/");

  await page.locator("#requirements-detail .task-link").first().click();

  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-tasks")).toBeVisible();
  await expect(page.locator("#tasks-detail .dossier-id")).toHaveText(/^task-/);
  await expect(page.locator("#tasks-body .record-row.target")).toHaveCount(1);
});

test("任务索引能换档案，档案能回到所属需求", async ({ page }) => {
  await page.goto("/#tasks");

  const rows = page.locator("#tasks-body .record-row");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();

  await expect(page.locator("#tasks-detail .dossier-id")).toHaveText(/^task-/);
  await expect(page.locator("#tasks-detail")).toContainText("blocked");
  await expect(rows.nth(1)).toHaveClass(/is-selected/);

  await page.getByRole("button", { name: "查看所属需求" }).click();
  await expect(page.locator(REQUIREMENTS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#requirements-body .record-row.target")).toHaveCount(1);
  await expect(page.locator("#requirements-detail .dossier-id")).toHaveText(/^req-/);
});

test("问题索引带对象与摘要，档案能跳回对象所在页签", async ({ page }) => {
  await page.goto("/#issues");

  const rows = page.locator("#issues-body .record-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-ref", /^task-/);
  await expect(rows.nth(0)).toContainText("任务阻断");
  await expect(page.locator("#issues-detail")).toContainText("任务执行被阻断");

  await page.locator("#issues-detail .button").click();
  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tasks-body .record-row.target")).toHaveCount(1);
});

test("地址栏片段直接落到某一段，刷新后仍停在原段", async ({ page }) => {
  await page.goto("/#issues");

  await expect(page.locator("#panel-issues")).toBeVisible();
  await expect(page.locator(ISSUES_TAB)).toHaveAttribute("aria-selected", "true");

  await page.reload();

  await expect(page.locator("#panel-issues")).toBeVisible();
  await expect(page.locator(ISSUES_TAB)).toHaveAttribute("aria-selected", "true");
});

test("手动改地址栏片段会在同一次加载里切段，未知片段不跳段", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#panel-requirements")).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#tasks";
  });
  await expect(page.locator("#panel-tasks")).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#nope";
  });
  await expect(page.locator("#panel-tasks")).toBeVisible();
  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
});

test("「刷新」重绘内容但保留页签与当前选择", async ({ page }) => {
  await page.goto("/#tasks");
  await expect(page.locator("#panel-tasks")).toBeVisible();
  const second = page.locator("#tasks-body .record-row").nth(1);
  await second.click();
  const selected = await page.locator("#tasks-detail .dossier-id").textContent();

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/progress"),
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tasks-detail .dossier-id")).toHaveText(selected ?? "");
});

test("刷新说明与倒计时来自服务端生效配置", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#refresh-note")).toContainText("每 60 秒");
  await expect(page.locator("#countdown")).toContainText("秒后刷新");
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("#generated-at")).not.toHaveText("—");
});

test("只读服务的会话页给出明确说明", async ({ page }) => {
  await page.goto("/#chat");

  await expect(page.locator(CHAT_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-chat")).toBeVisible();
  await expect(page.locator("#chat-unavailable")).toBeVisible();
  await expect(page.locator("#chat-unavailable")).toContainText("forgeloop serve");
});

test("记录文本按纯文本渲染，不执行注入内容", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#count-tasks")).toHaveText("2");

  const html = await page.locator("#requirements-detail").innerHTML();
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
});
