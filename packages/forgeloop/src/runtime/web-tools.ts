/**
 * 联网检索的宿主实现：调用 DeepSeek Search & Fetch API
 * （`POST /v1/tools/search`、`POST /v1/tools/fetch`）。
 *
 * 取舍：
 * - 密钥只从环境变量 `DEEPSEEK_API_KEY` 读取，不落库、不进提示词、不出现在工具输出里；
 * - `FORGELOOP_WEB_BASE_URL` 可覆盖 base URL，测试用本地 HTTP 服务，不触网；
 * - 工具是只读的：检索结果只是材料，改状态仍由程序与人类入口决定；
 * - 错误按 HTTP 状态码映射成中文原因，调用方据此决定是否重试。
 */

import { asRecord } from '../domain/json.js'
import { errorMessage } from '../domain/errors.js'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_QUERY_CHARS = 128
const MAX_COUNT = 50
const MAX_FETCH_CHARS = 20_000
const MAX_URL_CHARS = 8192

/** 按状态码给出的固定原因；接口约定的错误码都在这里，未知码走通用文案。 */
const STATUS_REASONS: Readonly<Record<number, string>> = {
  400: '请求参数不合法',
  401: 'API 密钥缺失或无效',
  402: '账户余额不足',
  403: '请求被安全策略拒绝',
  404: '无法读取页面内容',
  408: '请求体读取超时',
  413: '请求体过大',
  429: '触发频率限制',
  500: '服务端错误',
  504: '上游请求超时',
}

export type WebResponse<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string }

export interface SearchHit {
  readonly title: string
  readonly url: string
  readonly snippet: string
  readonly summary: string
  readonly publishedAt: string
  readonly siteName: string
  readonly authority: number
}

export interface SearchData {
  readonly query: string
  readonly results: readonly SearchHit[]
}

export interface FetchData {
  readonly url: string
  readonly title: string
  readonly content: string
  readonly truncated: boolean
}

function baseUrl(): string {
  const configured = process.env.FORGELOOP_WEB_BASE_URL?.trim()
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function providerMessage(payload: unknown): string {
  const record = asRecord(payload)
  if (!record) return ''
  const error = asRecord(record.error)
  return error ? stringField(error, 'message').trim() : ''
}

async function postJson(
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<WebResponse<unknown>> {
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  if (!key) return { ok: false, reason: '未配置 DEEPSEEK_API_KEY，联网检索不可用' }
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, reason: `联网请求失败：${errorMessage(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const label = STATUS_REASONS[response.status] ?? '请求失败'
    const detail = providerMessage(payload)
    return {
      ok: false,
      reason: `联网请求失败（HTTP ${response.status}，${label}）${detail ? `：${detail}` : ''}`,
    }
  }
  if (payload === null) return { ok: false, reason: '联网接口返回的不是 JSON' }
  return { ok: true, data: payload }
}

function toHit(value: unknown): SearchHit | null {
  const record = asRecord(value)
  if (!record) return null
  const url = stringField(record, 'url').trim()
  if (!url) return null
  return {
    title: stringField(record, 'title').trim(),
    url,
    snippet: stringField(record, 'snippet').trim(),
    summary: stringField(record, 'summary').trim(),
    publishedAt: stringField(record, 'date').trim(),
    siteName: stringField(record, 'site_name').trim(),
    authority: numberField(record, 'authority'),
  }
}

/** 检索公共网页；返回按相关度排序的结构化结果，摘要可直接进模型上下文。 */
export async function searchWeb(query: string, count?: number): Promise<WebResponse<SearchData>> {
  const normalized = query.trim()
  if (!normalized) return { ok: false, reason: '检索词不能为空' }
  if (normalized.length > MAX_QUERY_CHARS) {
    return { ok: false, reason: `检索词不能超过 ${MAX_QUERY_CHARS} 个字符` }
  }
  const requested = count === undefined || !Number.isFinite(count) ? 10 : Math.trunc(count)
  const limit = Math.min(MAX_COUNT, Math.max(1, requested))
  const outcome = await postJson('/v1/tools/search', {
    query: normalized,
    count: limit,
    need_content: false,
  })
  if (!outcome.ok) return outcome
  const record = asRecord(outcome.data) ?? {}
  const rawResults = Array.isArray(record.results) ? record.results : []
  const results: SearchHit[] = []
  for (const item of rawResults) {
    const hit = toHit(item)
    if (hit) results.push(hit)
  }
  return { ok: true, data: { query: normalized, results } }
}

function validUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  const value = input.trim()
  if (!value) return { ok: false, reason: '页面地址不能为空' }
  if (value.length > MAX_URL_CHARS) {
    return { ok: false, reason: `页面地址不能超过 ${MAX_URL_CHARS} 个字符` }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: '页面地址不是合法 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '页面地址必须是 http 或 https' }
  }
  if (!parsed.hostname) return { ok: false, reason: '页面地址必须包含主机名' }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: '页面地址不能包含用户名或密码' }
  }
  return { ok: true, url: parsed.toString() }
}

/** 抓取单个页面并转成 Markdown；超出上限时截断并标记，避免撑爆上下文。 */
export async function fetchWeb(input: string): Promise<WebResponse<FetchData>> {
  const target = validUrl(input)
  if (!target.ok) return target
  const outcome = await postJson('/v1/tools/fetch', { url: target.url })
  if (!outcome.ok) return outcome
  const record = asRecord(outcome.data) ?? {}
  const content = stringField(record, 'content')
  if (!content.trim()) return { ok: false, reason: `页面没有可读正文：${target.url}` }
  const truncated = content.length > MAX_FETCH_CHARS
  return {
    ok: true,
    data: {
      url: target.url,
      title: stringField(record, 'title').trim(),
      content: truncated ? content.slice(0, MAX_FETCH_CHARS) : content,
      truncated,
    },
  }
}
