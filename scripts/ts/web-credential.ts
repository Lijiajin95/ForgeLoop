#!/usr/bin/env node
/**
 * 本机 Web 浏览器凭据：从 DSH 持久化的 `client-connection/browser-session`
 * 签名密钥派生一个与本机 Web 同源的会话 Cookie，供部署后的无头核对使用。
 *
 * 约束：
 * - 只读本机 `$DSH_HOME/.credentials.yaml`，不打印密钥或 Cookie；
 * - 产物写入 `.cache/web-auth`（目录 0700、文件 0600），不进入 Git；
 * - Cookie 有效期默认 7 天、最多 30 天；与浏览器登录态一样，拿到文件即可访问该 Web；
 * - 这是本机自动化凭据，不替代客户批准，也不改变 Web 的鉴权边界。
 */
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const DEFAULT_OUT = join(ROOT, '.cache/web-auth')
const DAY = 86_400_000
const COOKIE_PREFIX = 'dsh-auth-'

export interface WebSession {
  readonly baseUrl: string
  readonly authority: string
  readonly cookieName: string
  readonly cookieValue: string
  readonly expiresAt: number
  readonly generatedAt: string
  readonly build?: {
    readonly version: string
    readonly sourceMatches: boolean | null
  }
}

export interface MintedCookie {
  readonly authority: string
  readonly cookieName: string
  readonly cookieValue: string
  readonly expiresAt: number
}

function base64url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return base64url(decoded) === value ? decoded : null
}

/**
 * 从 DSH 凭据 YAML 中只取 browser-session 的 secret。
 * 不引入 YAML 依赖：格式固定，读到其它顶层键即退出该块；缺失时给出可操作提示。
 */
export function readBrowserSecret(credentialsPath: string): string {
  const text = readFileSync(credentialsPath, 'utf8')
  let inRecords = false
  let inSession = false
  let secret = ''
  for (const line of text.split(/\r?\n/u)) {
    if (/^records:\s*$/u.test(line)) {
      inRecords = true
      continue
    }
    if (/^\S/u.test(line)) {
      inRecords = false
      inSession = false
      continue
    }
    if (!inRecords) continue
    if (/^\s{2}client-connection\/browser-session:\s*$/u.test(line)) {
      inSession = true
      continue
    }
    if (inSession && /^\s{2}\S/u.test(line)) {
      inSession = false
      continue
    }
    if (!inSession) continue
    const match = /^\s+secret:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/u.exec(line)
    if (match?.[1]) secret = match[1]
  }
  if (!secret) {
    throw new Error(
      `未在 ${credentialsPath} 找到 client-connection/browser-session 的 secret；` +
        '请先在浏览器里打开一次带启动 token 的 dsh web 地址，让宿主创建该凭据记录',
    )
  }
  if (decodeBase64url(secret)?.byteLength !== 32) {
    throw new Error('browser-session secret 不是 32 字节的 base64url；拒绝使用无法验证的凭据')
  }
  return secret
}

/** 生成与 BrowserAuth 相同的 v1 Cookie：payload 签名，authority 绑定 Host。 */
export function mintSessionCookie(input: {
  readonly baseUrl: string
  readonly secret: string
  readonly days?: number
  readonly now?: number
}): MintedCookie {
  const days = input.days ?? 7
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error(`Cookie 有效期必须是 1–30 天，收到 ${String(days)}`)
  }
  const url = new URL(input.baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Web URL 必须是 http(s)，收到 ${input.baseUrl}`)
  }
  const authority = url.host
  const key = decodeBase64url(input.secret)
  if (!key) throw new Error('browser-session secret 无法解码')
  const issuedAt = input.now ?? Date.now()
  const expiresAt = issuedAt + days * DAY
  const body = base64url(
    Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'),
  )
  const signature = base64url(createHmac('sha256', key).update(body).digest())
  return {
    authority,
    cookieName: COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest()),
    cookieValue: `v1.${body}.${signature}`,
    expiresAt,
  }
}

export function readSession(path: string): WebSession {
  const session = JSON.parse(readFileSync(path, 'utf8')) as WebSession
  if (
    typeof session.baseUrl !== 'string' ||
    typeof session.cookieName !== 'string' ||
    typeof session.cookieValue !== 'string' ||
    typeof session.expiresAt !== 'number'
  ) {
    throw new Error(`会话文件格式不正确：${path}`)
  }
  if (session.expiresAt <= Date.now()) {
    throw new Error(
      `浏览器凭据已于 ${new Date(session.expiresAt).toISOString()} 过期，请重新运行 make web-auth`,
    )
  }
  return session
}

export interface WebCheck {
  readonly indexStatus: number
  readonly boardStatus: number
  readonly build: WebSession['build']
}

/** 用 Cookie 实打实访问首页与看板端点：只读，不提交任何动作。 */
export async function checkWebSession(session: WebSession): Promise<WebCheck> {
  const origin = new URL(session.baseUrl).origin
  const headers = { cookie: `${session.cookieName}=${session.cookieValue}` }
  const index = await fetch(new URL('/', session.baseUrl), {
    headers,
    redirect: 'manual',
  })
  if (index.status !== 200) {
    throw new Error(
      `首页返回 HTTP ${index.status}。Cookie 可能已过期或 DSH_HOME/authority 不匹配；重新运行 make web-auth`,
    )
  }
  const response = await fetch(new URL('/api/forgeloop/board', session.baseUrl), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', origin },
    body: JSON.stringify({ endpoint: 'board', limit: 1 }),
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown
    value?: { build?: WebSession['build'] }
    error?: { message?: string }
  } | null
  if (response.status !== 200 || payload?.ok !== true) {
    throw new Error(
      `看板返回 HTTP ${response.status}：${payload?.error?.message ?? '响应不可读'}；` +
        '请确认目标 profile 已加载 forgeloop-dsh',
    )
  }
  return {
    indexStatus: index.status,
    boardStatus: response.status,
    build: payload.value?.build,
  }
}

function writeSession(outDir: string, session: WebSession): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  chmodSync(outDir, 0o700)
  const sessionPath = join(outDir, 'session.json')
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  chmodSync(sessionPath, 0o600)
  const cookiePath = join(outDir, 'cookie.txt')
  writeFileSync(cookiePath, `${session.cookieName}=${session.cookieValue}\n`, { mode: 0o600 })
  chmodSync(cookiePath, 0o600)
  return sessionPath
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function defaultCredentialsPath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

async function main(): Promise<void> {
  const baseUrl = option('--url') ?? process.env.DSH_WEB_URL?.trim() ?? 'http://127.0.0.1:3080'
  const outDir = resolve(option('--out') ?? DEFAULT_OUT)
  const credentialsPath = resolve(option('--credentials') ?? defaultCredentialsPath())
  const days = Number(option('--days') ?? 7)
  const checkOnly = process.argv.includes('--check')

  const sessionPath = join(outDir, 'session.json')
  let session: WebSession
  if (checkOnly) {
    session = readSession(sessionPath)
    if (new URL(session.baseUrl).origin !== new URL(baseUrl).origin) {
      throw new Error(`已保存的会话属于 ${session.baseUrl}，与 --url ${baseUrl} 不一致`)
    }
  } else {
    if (!existsSync(credentialsPath)) {
      throw new Error(`凭据文件不存在：${credentialsPath}；请设置 DSH_HOME 或 --credentials`)
    }
    const minted = mintSessionCookie({
      baseUrl,
      secret: readBrowserSecret(credentialsPath),
      days,
    })
    session = {
      baseUrl,
      authority: minted.authority,
      cookieName: minted.cookieName,
      cookieValue: minted.cookieValue,
      expiresAt: minted.expiresAt,
      generatedAt: new Date().toISOString(),
    }
  }

  const check = await checkWebSession(session)
  session = { ...session, build: check.build }
  writeSession(outDir, session)
  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        authority: session.authority,
        expiresAt: new Date(session.expiresAt).toISOString(),
        sessionPath,
        indexStatus: check.indexStatus,
        boardStatus: check.boardStatus,
        build: check.build ?? null,
      },
      null,
      2,
    ),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(
      `[web-credential] 失败：${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
