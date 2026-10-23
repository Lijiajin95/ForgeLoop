/**
 * 页面写入口的真实浏览器用例（R3）：真实 Chromium + 真实 `forgeloop serve` + 真实记录。
 *
 * 这一层补的是快速层补不了的东西：真浏览器里点表单、真跨进程写请求（页面令牌 + 同源）、
 * 真常驻进程在写完之后自动接续推进。服务端边界由 `tests/integration/test_serve_operations.py`
 * 与 `tests/system/test_serve_operations_process.py` 覆盖，这里只看「人在浏览器里点得动、
 * 点了之后权威记录真的变了」。
 *
 * 现场由 `tests/fixtures/seed_serve_operations_e2e.py` 造：一条已规划未批准的需求 +
 * `auto_advance = true` 的 serve（假 PI）。单任务验收这一步当前只能走 CLI（页面只做需求
 * 整体验收），因此用例里用子进程扮演人工的那一步。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const OPERATIONS_URL = "http://127.0.0.1:8714";
const RECORDS_ROOT = ".cache/frontend-e2e-operations/records";
const run = promisify(execFile);

test.use({ baseURL: OPERATIONS_URL });

/** 写入口收在抽屉里：打开后才填表单，和真实操作一致。 */
async function openOperations(page: Page): Promise<void> {
  await page.locator("#operations-open").click();
  await expect(page.locator("#operations-drawer")).toBeVisible();
}

interface ProgressTask {
  readonly task_id: string;
  readonly status: string;
}

interface ProgressEntry {
  readonly req_id: string;
  readonly requirement_status: string;
  readonly tasks: readonly unknown[];
}

async function requirementRow(page: Page, reqId: string): Promise<string> {
  // 需求页签是索引 + 档案：按身份定位索引行。
  const row = page.locator(`#requirements-body .record-row[data-ref="${reqId}"]`).first();
  await expect(row).toBeVisible();
  return (await row.textContent()) ?? "";
}

async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${OPERATIONS_URL}/api/progress`);
        const document = (await response.json()) as { tasks: readonly ProgressTask[] };
        return document.tasks.find((task) => task.task_id === taskId)?.status ?? "missing";
      },
      { timeout: 30_000 },
    )
    .toBe(expected);
}

test("服务端已建需求但响应丢失时，刷新重试不会重复建需求", async ({ page, request }) => {
  test.setTimeout(60_000);
  const operationsUrl = OPERATIONS_URL;
  const countRequirements = async (): Promise<number> => {
    const response = await request.get(`${operationsUrl}/api/progress`);
    const document = (await response.json()) as { requirements: readonly unknown[] };
    return document.requirements.length;
  };

  await page.goto(`${operationsUrl}/`);
  await openOperations(page);
  const before = await countRequirements();
  const text = `幂等刷新重试用例-${Date.now()}`;

  // 第一次提交：请求**真的发给服务端**（route.fetch 会建需求），但客户端拿不到响应
  // （route.abort）——这正是幂等键要挡住的场景：网络抖动后的重试。
  await page.route("**/api/requirements", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.fill("#submit-project", "ForgeLoop");
  await page.fill("#submit-text", text);
  await page.click("#submit-button");
  await expect(page.locator("#operations-status")).toContainText("请求失败");
  const pendingKey = await page.evaluate(() => sessionStorage.getItem("forgeloop:submit-key"));
  expect(pendingKey).toBeTruthy();

  // 刷新页面：提交键仍在（跨刷新复用），再提交同一个内容。
  await page.unroute("**/api/requirements");
  await page.reload();
  expect(await page.evaluate(() => sessionStorage.getItem("forgeloop:submit-key"))).toBe(
    pendingKey,
  );
  await openOperations(page);
  await page.fill("#submit-project", "ForgeLoop");
  await page.fill("#submit-text", text);
  await page.click("#submit-button");
  await expect(page.locator("#operations-status")).toContainText("已受理");

  // 权威记录只多了一条：第二次提交命中了第一次留下的幂等键。
  await expect.poll(countRequirements, { timeout: 15_000 }).toBe(before + 1);
});

test("页面提交、批准、自动推进与整体验收", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto(`${OPERATIONS_URL}/`);
  await openOperations(page);

  // 令牌已注入：操作面板可见（只读的 web 服务不会显示它）。
  await expect(page.locator("#operations")).toBeVisible();

  // 1) 页面提交一条需求
  await page.fill("#submit-project", "ForgeLoop");
  await page.fill("#submit-text", "浏览器提交的需求");
  await page.click("#submit-button");
  await expect(page.locator("#operations-status")).toContainText("已受理");
  const submitted = (await page.locator("#operations-status").textContent())?.split("：")[1] ?? "";
  expect(submitted.startsWith("req-")).toBe(true);

  // 2) 推进与停止按钮在真实浏览器里也要能用：对刚提交（还没有任务包）的需求点一次，
  //    页面必须把服务端的拒绝原因显示出来，而不是静默无反应或谎称成功。
  await page.selectOption("#action-req", submitted);
  await page.fill("#action-reason", "");
  await page.click("#action-advance");
  await expect(page.locator("#operations-status")).toContainText("任务包");

  await page.fill("#action-reason", "浏览器用例：尝试停止");
  await page.click("#action-stop");
  await expect(page.locator("#operations-status")).toContainText("任务包");

  // 3) 批准种子需求：下拉里除刚提交那条之外的唯一一条（不依赖排序假设）
  const values = await page
    .locator("#action-req option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const seeded = values.find((value) => value !== submitted);
  expect(seeded).toBeTruthy();
  await page.selectOption("#action-req", seeded as string);
  await page.fill("#action-reason", "浏览器用例：批准任务包");
  await page.click("#action-approve");
  await expect(page.locator("#operations-status")).toContainText("已批准");

  // 4) 常驻进程自动接续：不做任何推进调用，等单任务跑到验收门
  const taskId = `task-${seeded}-v1-first`;
  await waitForTaskStatus(request, taskId, "awaiting_acceptance");

  // 5) 单任务验收由人工在 CLI 侧作出（页面只做需求整体验收）
  await run(
    ".venv/bin/python",
    [
      "-m",
      "forgeloop",
      "approve",
      taskId,
      "--stage",
      "acceptance",
      "--decision",
      "approved",
      "--records-root",
      RECORDS_ROOT,
    ],
    { cwd: "..", timeout: 60_000 },
  );
  await waitForTaskStatus(request, taskId, "delivered");

  // 6) 页面整体验收：先收起抽屉刷新，再打开写入口。
  await page.click("#operations-close");
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/progress"));
  await page.click("#refresh-button");
  await refreshed;
  await openOperations(page);
  await page.selectOption("#action-req", seeded as string);
  await page.fill("#action-reason", "浏览器用例：整体验收");
  await page.click("#action-accept");
  await expect(page.locator("#operations-status")).toContainText("整体验收通过");

  // 权威记录里确实变成了 accepted
  await expect
    .poll(
      async () => {
        const response = await request.get(`${OPERATIONS_URL}/api/progress`);
        const document = (await response.json()) as { requirements: readonly ProgressEntry[] };
        const entry = document.requirements.find((item) => item.req_id === seeded);
        return entry?.requirement_status ?? "missing";
      },
      { timeout: 15_000 },
    )
    .toBe("accepted");
  await page.click("#operations-close");
  await page.click("#tab-requirements");
  expect(await requirementRow(page, seeded as string)).toContain("accepted");
});
