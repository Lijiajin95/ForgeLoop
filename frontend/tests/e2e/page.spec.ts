/**
 * 状态页的真实浏览器用例：真实 Chromium + 真实 `forgeloop web` 进程 + 真实记录。
 *
 * 这一层补的是快速层补不了的东西：模块能否被浏览器加载、三段页签在真实布局下是否
 * 可见、按身份跳转与高亮是否真的发生、地址栏片段与自动刷新重绘是否保持原段。
 * 断言只看用户能看到的结果，不碰内部实现。
 */

import { expect, test } from "@playwright/test";

const REQUIREMENTS_TAB = "#tab-requirements";
const TASKS_TAB = "#tab-tasks";
const ISSUES_TAB = "#tab-issues";

test("默认停在需求页签：一条需求，卡内是它分解出的任务", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#count-requirements")).toHaveText("1");
  await expect(page.locator("#count-tasks")).toHaveText("2");
  await expect(page.locator("#count-issues")).toHaveText("2");

  await expect(page.locator(REQUIREMENTS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-requirements")).toBeVisible();
  await expect(page.locator("#panel-tasks")).toBeHidden();

  const card = page.locator("#requirements-body article.card").first();
  await expect(card).toHaveAttribute("data-ref", /^req-/);
  await expect(card).toContainText("任务包 v1");
  await expect(card).toContainText("1 / 2 已交付");

  const tasks = card.locator("tbody tr");
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toContainText("first");
  await expect(tasks.nth(0).locator("td").nth(2)).toHaveText("merged");
  await expect(tasks.nth(1).locator("td").nth(2)).toHaveText("blocked");
  await expect(tasks.nth(1)).toHaveClass(/issue/);
});

test("点需求里的任务跳到任务页签并高亮那条任务", async ({ page }) => {
  await page.goto("/");

  const card = page.locator("#requirements-body article.card").first();
  await card.locator("tbody tr.issue .link-button").click();

  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-tasks")).toBeVisible();
  await expect(page.locator("#tasks-body tbody tr.issue")).toHaveClass(/target/);
  await expect(page.locator("#tasks-body .group-head")).toContainText("req-");
});

test("任务页签按需求分组，组头能跳回需求并高亮那张卡片", async ({ page }) => {
  await page.goto("/#tasks");

  const group = page.locator("#tasks-body section.group").first();
  await expect(group.locator("tbody tr")).toHaveCount(2);
  const groupRef = await group.getAttribute("data-ref");
  expect(groupRef).toMatch(/^req-/);

  await group.locator(".group-head .id-link").click();

  await expect(page.locator(REQUIREMENTS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#requirements-body article.card[data-ref="${groupRef}"]`)).toHaveClass(
    /target/,
  );
});

test("卡片可折叠：收起后自动刷新仍是收起，展开可恢复", async ({ page }) => {
  await page.goto("/");

  const card = page.locator("#requirements-body article.card").first();
  await expect(card.locator(".description-block .label")).toHaveText("需求原文 v1");
  await expect(card.locator(".description")).toContainText("状态页要在真实浏览器里显示进展");
  await expect(card.locator(".card-body")).toBeVisible();

  await card.locator(".collapse-toggle").click();
  await expect(card.locator(".card-body")).toBeHidden();
  await expect(card.locator(".collapse-toggle")).toHaveText("展开");

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/progress"),
  );
  await page.getByRole("button", { name: "立即刷新" }).click();
  await responsePromise;

  await expect(card.locator(".card-body")).toBeHidden();
  await expect(card.locator(".collapse-toggle")).toHaveText("展开");

  await card.locator(".collapse-toggle").click();
  await expect(card.locator(".card-body")).toBeVisible();
});

test("任务页签显示任务目标且分组可折叠", async ({ page }) => {
  await page.goto("/#tasks");

  const group = page.locator("#tasks-body section.group").first();
  await expect(group.locator("tbody tr").first().locator(".goal")).toHaveText("先交付一个正常任务");
  await expect(group.locator(".card-body")).toBeVisible();

  await group.locator(".collapse-toggle").click();
  await expect(group.locator(".card-body")).toBeHidden();
});

test("问题页签把对象链回它所在的那一段，对不上的对象只显示纯文本", async ({ page }) => {
  await page.goto("/#issues");

  const rows = page.locator("#issues-body tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toHaveText("任务阻断");
  await expect(rows.nth(0)).toHaveAttribute("data-ref", /^task-/);

  await rows.nth(0).locator("td").nth(1).locator("button").click();
  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tasks-body tbody tr.issue")).toHaveClass(/target/);

  await expect(rows.nth(1).locator("td").first()).toHaveText("执行槽位残留");
  await expect(rows.nth(0).locator(".object-note")).toContainText("再留下一个被阻断的任务");
  await expect(rows.nth(1).locator("td").nth(1)).toContainText("req-forgeloop-e2e");
  await expect(rows.nth(1).locator("td").nth(1).locator("button")).toHaveCount(0);
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

test("「立即刷新」重绘内容但不把用户踢回需求页签", async ({ page }) => {
  await page.goto("/#tasks");
  await expect(page.locator("#panel-tasks")).toBeVisible();

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/progress"),
  );
  await page.getByRole("button", { name: "立即刷新" }).click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  await expect(page.locator(TASKS_TAB)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-tasks")).toBeVisible();
  await expect(page.locator("#banner")).toBeHidden();
});

test("刷新说明与倒计时来自服务端生效配置", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#refresh-note")).toContainText("每 60 秒");
  await expect(page.locator("#countdown")).toContainText("秒后刷新");
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("#generated-at")).not.toHaveText("—");
});

test("记录文本按纯文本渲染，不执行注入内容", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#count-tasks")).toHaveText("2");

  // 页面只写 textContent：DOM 里既没有脚本元素，也没有来自记录的事件属性。
  const html = await page.locator("#tasks-body").innerHTML();
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
});
