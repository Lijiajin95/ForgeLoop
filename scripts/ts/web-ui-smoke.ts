#!/usr/bin/env node
/**
 * 浏览器 UI 冒烟：用本机会话 Cookie 打开真实 Web，进入「天工」并核对页脚运行身份。
 *
 * 这是部署后的只读自验证材料：不做批准/推进/验收，不修改业务记录。
 * 依赖 `make web-auth` 生成的 `.cache/web-auth/session.json`；截图落在同目录。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readSession } from './web-credential.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const DEFAULT_OUT = join(ROOT, '.cache/web-auth')
const require = createRequire(import.meta.url)

interface ChromiumLike {
  launch(options: { executablePath?: string; headless: boolean; args: string[] }): Promise<{
    newContext(options: Record<string, unknown>): Promise<{
      addCookies(cookies: Array<Record<string, unknown>>): Promise<void>
      newPage(): Promise<{
        goto(url: string, options: Record<string, unknown>): Promise<unknown>
        waitForTimeout(ms: number): Promise<void>
        locator(selector: string): {
          waitFor(options: Record<string, unknown>): Promise<void>
          innerText(): Promise<string>
          count(): Promise<number>
          nth(index: number): {
            innerText(): Promise<string>
            click(): Promise<void>
          }
          first(): {
            click(): Promise<void>
            innerText(): Promise<string>
            count(): Promise<number>
          }
        }
        getByText(
          text: string,
          options: Record<string, unknown>,
        ): {
          first(): {
            click(): Promise<void>
            count(): Promise<number>
            innerText(): Promise<string>
          }
        }
        screenshot(options: Record<string, unknown>): Promise<unknown>
        evaluate<T>(fn: () => T): Promise<T>
      }>
      close(): Promise<void>
    }>
    close(): Promise<void>
  }>
}

function chromium(): ChromiumLike {
  const loaded = require('playwright-core') as { chromium?: ChromiumLike }
  if (!loaded.chromium) throw new Error('未找到 playwright-core；请在仓库根安装依赖')
  return loaded.chromium
}

function executablePath(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((value) => existsSync(value))
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const outDir = resolve(option('--out') ?? DEFAULT_OUT)
  const sessionPath = option('--session') ?? join(outDir, 'session.json')
  const session = readSession(sessionPath)
  const requireSourceMatch = process.argv.includes('--require-source-match')
  const browser = await chromium().launch({
    ...(executablePath() ? { executablePath: executablePath() } : {}),
    headless: true,
    args: ['--no-sandbox'],
  })
  try {
    const url = new URL(session.baseUrl)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addCookies([
      {
        name: session.cookieName,
        value: session.cookieValue,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        expires: Math.floor(session.expiresAt / 1000),
      },
    ])
    const page = await context.newPage()
    await page.goto(session.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1500)

    if (!(await hasConversation(page))) await openConversation(page)
    const tab = page.getByText('天工', { exact: true }).first()
    if ((await tab.count()) === 0) throw new Error('会话视图里没有「天工」页签')
    await tab.click()
    await page.locator('.flb-root').first().waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(800)

    const buildText = await page.locator('.flb-footer').first().innerText()
    if (!/运行|Running/u.test(buildText)) {
      throw new Error(`页脚没有运行身份：「${buildText.slice(0, 160)}」`)
    }
    if (requireSourceMatch && !/与源码一致|matches source/u.test(buildText)) {
      throw new Error(`运行客户端与源码不一致：「${buildText.slice(0, 200)}」`)
    }

    mkdirSync(outDir, { recursive: true, mode: 0o700 })
    const screenshot = join(
      outDir,
      `ui-smoke-${new Date().toISOString().replace(/[:.]/gu, '-')}.png`,
    )
    await page.screenshot({ path: screenshot })
    await context.close()
    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: session.baseUrl,
          view: '天工',
          build: buildText,
          sourceMatches: /与源码一致|matches source/u.test(buildText),
          screenshot,
        },
        null,
        2,
      ),
    )
  } finally {
    await browser.close()
  }
}

async function hasConversation(page: {
  getByText(
    text: string,
    options: Record<string, unknown>,
  ): { first(): { count(): Promise<number> } }
}): Promise<boolean> {
  return (await page.getByText('天工', { exact: true }).first().count()) > 0
}

async function openConversation(page: {
  locator(selector: string): {
    count(): Promise<number>
    nth(index: number): { innerText(): Promise<string>; click(): Promise<void> }
  }
  waitForTimeout(ms: number): Promise<void>
}): Promise<void> {
  const rows = page.locator('[role="treeitem"]')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await rows.count()) > 0) break
    await page.waitForTimeout(500)
  }
  const total = Math.min(await rows.count(), 40)
  const withTime: number[] = []
  const withoutTime: number[] = []
  for (let index = 0; index < total; index += 1) {
    const text = await rows
      .nth(index)
      .innerText()
      .catch(() => '')
    if (/(分钟|小时|刚刚|天前|minutes? ago|hours? ago|days? ago)/iu.test(text)) withTime.push(index)
    else if (text.trim().length > 6 && !/新会话|New session/iu.test(text)) withoutTime.push(index)
  }
  for (const index of [...withTime, ...withoutTime]) {
    await rows
      .nth(index)
      .click()
      .catch(() => undefined)
    await page.waitForTimeout(1500)
    if (await hasConversation(page)) return
  }
  throw new Error('侧栏没有可打开的已有会话；请先用浏览器进入一次业务会话再运行冒烟')
}

main().catch((error: unknown) => {
  console.error(`[web-ui-smoke] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
