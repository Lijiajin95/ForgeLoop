/**
 * 状态页的真实浏览器用例：真实 Chromium + 真实 `forgeloop web` 进程 + 真实记录。
 *
 * 这一层补的是快速层补不了的东西：模块能否被浏览器加载、样式布局下元素是否可见、
 * 真实 fetch 与倒计时是否工作。断言只看用户能看到的结果，不碰内部实现。
 */

import { expect, test } from "@playwright/test";

test("页面加载后显示记录里的需求、任务与问题", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#count-requirements")).toHaveText("1");
  await expect(page.locator("#count-tasks")).toHaveText("1");
  await expect(page.locator("#count-issues")).toHaveText("2");

  const requirementRow = page.locator("#requirements-body tr").first();
  await expect(requirementRow.locator("td").nth(1)).toHaveText("forgeloop");

  const taskRow = page.locator("#tasks-body tr").first();
  await expect(taskRow.locator("td").first()).toHaveText("task-e2e-blocked");
  await expect(taskRow.locator("td").nth(2)).toHaveText("blocked");
  await expect(taskRow).toHaveClass(/issue/);

  const issueKinds = page.locator("#issues-body tr td:first-child");
  await expect(issueKinds).toHaveCount(2);
  await expect(issueKinds.first()).toHaveText("任务阻断");
  await expect(issueKinds.nth(1)).toHaveText("执行槽位残留");
});

test("刷新说明与倒计时来自服务端生效配置", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#refresh-note")).toContainText("每 60 秒");
  await expect(page.locator("#countdown")).toContainText("秒后刷新");
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("#generated-at")).not.toHaveText("—");
});

test("点击「立即刷新」会再读一次进展接口", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#count-tasks")).toHaveText("1");

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/progress"),
  );
  await page.getByRole("button", { name: "立即刷新" }).click();

  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.locator("#banner")).toBeHidden();
});

test("记录文本按纯文本渲染，不执行注入内容", async ({ page }) => {
  await page.goto("/");

  // 页面只写 textContent：DOM 里既没有脚本元素，也没有来自记录的事件属性。
  const html = await page.locator("#tasks-body").innerHTML();
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
});
