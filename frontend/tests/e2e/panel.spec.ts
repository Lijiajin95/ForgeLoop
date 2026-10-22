/**
 * 会话面板的真实浏览器用例：真实 Chromium + 真实 `forgeloop serve` + 真实假 PI 子进程。
 *
 * 这一层补的是快速层补不了的东西：编译产物在浏览器里真的加载、右栏面板的可见性与布局、
 * 跨进程写请求（页面令牌 + 同源）、以及那一轮真的驱动了一个子进程并把回复写回记录。
 * 服务端边界（状态码、闸门、失败关闭）由 `tests/integration/test_serve_panel.py` 与
 * `tests/system/test_serve_panel_process.py` 覆盖，这里只看「人在浏览器里点得动、
 * 点了之后面板上真的出现结果」。
 *
 * 现场由 `tests/fixtures/seed_panel_e2e.py` 造：三个页面项目各带一种假 PI 模式
 * （HITL 往返、工具调用与轮次边界审批、放慢的流式输出）。
 */

import { rmSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const PANEL_URL = "http://127.0.0.1:8716";
// 假 PI 的 chat-hitl-first 用状态文件记住「首轮已请求过人工决定」；这一层是跨轮次的外部
// 现场，因此需要它的用例先显式清掉，保证每个用例都从「首轮请求决定」开始。
const FAKE_PI_STATE = "../.cache/frontend-e2e-panel/fake-pi-state.json";

test.use({ baseURL: PANEL_URL });

function resetFakePiState(): void {
  rmSync(FAKE_PI_STATE, { force: true });
}

/** 打开「人工决定与终止」折叠区：理由/补充指令默认收在 composer 里。 */
async function openComposerOptions(page: Page): Promise<void> {
  const details = page.locator("#panel-composer details");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
}

/** 新建一个会话并等它被自动选中（面板刷新后消息区出现空态提示）。 */
async function newSession(page: Page, title: string, project = "demo"): Promise<void> {
  await page.locator("#panel-new-session").click();
  await expect(page.locator("#panel-new-session-form")).toBeVisible();
  await page.locator("#panel-project-select").selectOption(project);
  await page.locator("#panel-session-title").fill(title);
  await page.locator("#panel-create-session").click();
  await expect(page.locator("#panel-session-meta")).toContainText("可对话");
}

test("面板显示项目与运行时就绪，并能新建会话", async ({ page }) => {
  await page.goto("/");

  // 有令牌时默认落在会话：进展页签仍可见，会话工作区同时可见。
  await expect(page.locator("#tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#count-requirements")).toBeVisible();
  await expect(page.locator("#panel")).toBeVisible();
  await expect(page.locator("#panel-status")).toHaveText("");

  await page.locator("#panel-tab-projects").click();
  const projectRow = page.locator("#panel-projects-body tr").first();
  await expect(projectRow.locator("td").first()).toHaveText("demo");
  await expect(projectRow.locator("td").nth(1)).toHaveText("页面管理");
  await expect(projectRow.locator("td").nth(3)).toHaveText("是");
  await expect(projectRow.locator("td").nth(4)).toHaveText("—");

  await page.locator("#panel-tab-runtime").click();
  await expect(page.locator("#panel-runtime-summary")).toContainText("并发上限 1 轮");
  await expect(page.locator("#panel-runtime-body tr").first().locator("td").nth(1)).toHaveText(
    "就绪",
  );

  await page.locator("#panel-tab-sessions").click();
  await newSession(page, "浏览器用例会话");
  await expect(
    page.locator('#panel-session-list .session-item[aria-current="true"]'),
  ).toHaveAttribute("data-session-id", /^cs-/);
});

test("一轮消息真的驱动 PI 并显示回复，HITL 决定后继续", async ({ page }) => {
  resetFakePiState();
  await page.goto("/");
  await newSession(page, "HITL 往返");

  await page.locator("#panel-message-text").fill("看一下仓库状态");
  await page.locator("#panel-send").click();

  // 首轮：Agent 显式请求人工决定，面板停在「等待人工决定」并给出两个按钮。
  await expect(page.locator("#panel-decisions button[data-choice='approve']")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("#panel-session-meta")).toContainText("等待人工决定");
  await expect(page.locator("#panel-messages li.msg-agent").last()).toContainText("需要人工确认");

  // 没填理由不能作出决定：只提示，不发请求。
  await openComposerOptions(page);
  await page.locator("#panel-decision-text").fill("改用方案 B");
  await page.locator("#panel-decisions button[data-choice='approve']").click();
  await expect(page.locator("#panel-status")).toHaveText("作出人工决定必须填写理由。");

  await page.locator("#panel-reason").fill("按方案 B 继续");
  await page.locator("#panel-decisions button[data-choice='approve']").click();

  // 第二轮按人工指令正常回复：会话回到可对话，补充指令作为一条人工消息留痕。
  await expect(page.locator("#panel-session-meta")).toContainText("可对话", { timeout: 30_000 });
  await expect(page.locator("#panel-messages li.msg-agent").last()).toContainText(
    "已按人工决定继续",
  );
  await expect(page.locator("#panel-messages li.msg-human").last()).toContainText("改用方案 B");
});

test("终止会话需要理由，终止后面板不再接受新消息", async ({ page }) => {
  resetFakePiState();
  await page.goto("/");
  await newSession(page, "终止用例");
  await page.locator("#panel-message-text").fill("开始干活");
  await page.locator("#panel-send").click();
  await expect(page.locator("#panel-decisions button[data-choice='reject']")).toBeVisible({
    timeout: 30_000,
  });

  await openComposerOptions(page);
  await page.locator("#panel-terminate").click();
  await expect(page.locator("#panel-status")).toHaveText("终止会话必须填写理由。");

  await page.locator("#panel-reason").fill("不需要了");
  await page.locator("#panel-terminate").click();

  await expect(page.locator("#panel-session-meta")).toContainText("已终止", { timeout: 30_000 });
  await expect(page.locator("#panel-session-meta")).toContainText("终止原因：不需要了");
  // 终止后输入区整体隐藏：不再给人一个必然被拒的入口。
  await expect(page.locator("#panel-composer")).toBeHidden();
});

test("流式输出：整轮结束前就能看到文字在增长，结束后标记消失", async ({ page }) => {
  await page.goto("/");
  await newSession(page, "流式用例", "stream");
  await page.locator("#panel-message-text").fill("说说你看到的仓库结构");
  await page.locator("#panel-composer button[type=submit]").click();

  // 增量每 500ms 一段：先看到「正在生成」，再看到同一行内容真的变长。
  const agentMessage = page.locator("#panel-messages li.msg-agent").last();
  await expect(page.locator("#panel-messages li.msg-streaming")).toBeVisible({ timeout: 15_000 });
  await expect(agentMessage.locator(".msg-head")).toContainText("正在生成");

  // 收集若干次读数：出现两个不同的非空正文即证明「文字在增长」（比单次比较更抗时序）。
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 60 && seen.size < 2; attempt += 1) {
    const current = (await agentMessage.locator("p").textContent()) ?? "";
    if (current !== "") {
      seen.add(current);
    }
    await page.waitForTimeout(120);
  }
  expect(seen.size).toBeGreaterThan(1);

  // 整轮结束后流式标记消失，正文落在记录里。
  await expect(page.locator("#panel-messages li.msg-streaming")).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(agentMessage.locator("p")).toContainText("整理改动方案");
  await expect(page.locator("#panel-session-meta")).toContainText("可对话");
});

test("工具调用逐次可见，轮次边界审批后可以继续", async ({ page }) => {
  await page.goto("/");
  await newSession(page, "工具用例", "tools");
  await page.locator("#panel-message-text").fill("看一下目录里有什么");
  await page.locator("#panel-composer button[type=submit]").click();

  // 工具留痕：执行类工具标出「待审批」，只读工具标出「无需审批」。
  const tools = page.locator("#panel-tools li");
  await expect(page.locator("#panel-tools-meta")).toContainText("本轮工具调用 2 次", {
    timeout: 20_000,
  });
  await expect(tools.filter({ hasText: "bash" })).toContainText("执行命令");
  await expect(tools.filter({ hasText: "bash" })).toContainText("待审批");
  await expect(tools.filter({ hasText: "read" })).toContainText("只读");
  await expect(tools.filter({ hasText: "read" })).toContainText("无需审批");

  // 审批闸门：会话停在待人工决定，文案说清「工具已经跑过、审批在轮次边界」。
  const decision = page.locator("#panel-decisions .decision");
  await expect(decision).toContainText("轮次边界");
  await expect(decision).toContainText("bash");
  await openComposerOptions(page);
  await page.locator("#panel-reason").fill("这台机器上的 ls 可以跑");
  await decision.locator('button[data-choice="approve"]').click();

  await expect(page.locator("#panel-decisions .decision")).toContainText("已批准", {
    timeout: 20_000,
  });
  await expect(tools.filter({ hasText: "bash" })).toContainText("已批准");
  await expect(page.locator("#panel-session-meta")).toContainText("可对话");
});
