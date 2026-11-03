import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchWeb, searchWeb } from '../src/runtime/web-tools.js'

interface Call {
  path: string
  authorization: string
  body: Record<string, unknown>
}

let calls: Call[] = []
let handler: (call: Call, response: ServerResponse) => void = () => undefined
let server: ReturnType<typeof createServer>
let baseUrl = ''
const savedKey = process.env.DEEPSEEK_API_KEY
const savedBase = process.env.FORGELOOP_WEB_BASE_URL

function respond(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const call: Call = {
        path: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }
      calls.push(call)
      handler(call, response)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务没有监听端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = savedKey
  if (savedBase === undefined) delete process.env.FORGELOOP_WEB_BASE_URL
  else process.env.FORGELOOP_WEB_BASE_URL = savedBase
})

beforeEach(() => {
  calls = []
  handler = (_call, response) => respond(response, 200, {})
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.FORGELOOP_WEB_BASE_URL = baseUrl
})

describe('DeepSeek web search', () => {
  it('explains the key requirement and never calls the API without one', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const outcome = await searchWeb('本地生活服务')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('DEEPSEEK_API_KEY')
      expect(outcome.reason).toContain('不写入 DSH 配置或环境')
      expect(outcome.reason).toContain('未发出任何网络请求')
    }
    expect(calls).toHaveLength(0)
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('posts the query to the search endpoint and parses ranked results', async () => {
    handler = (_call, response) =>
      respond(response, 200, {
        results: [
          {
            rerank_score: 2.4,
            title: '门店结算规则',
            url: 'https://example.com/settle',
            snippet: '一句摘要',
            summary: '较长的摘要，供模型阅读。',
            content: '',
            site_name: '示例站点',
            site_icon: null,
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
          },
          // 没有 url 的条目不是可引用结果，直接丢弃。
          { title: '缺少地址' },
        ],
      })

    const outcome = await searchWeb('门店结算', 5)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.query).toBe('门店结算')
    expect(outcome.data.results).toEqual([
      {
        title: '门店结算规则',
        url: 'https://example.com/settle',
        snippet: '一句摘要',
        summary: '较长的摘要，供模型阅读。',
        publishedAt: '2026-06-01T00:00:00+00:00',
        siteName: '示例站点',
        authority: 3,
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v1/tools/search')
    expect(calls[0]!.authorization).toBe('Bearer test-key')
    expect(calls[0]!.body).toEqual({ query: '门店结算', count: 5, need_content: false })
    // 密钥只出现在请求头里：结果不带密钥，环境也不被改写。
    expect(JSON.stringify(outcome.data)).not.toContain('test-key')
    expect(process.env.DEEPSEEK_API_KEY).toBe('test-key')
  })

  it('clamps the result count and rejects empty or over-long queries before calling', async () => {
    handler = (_call, response) => respond(response, 200, { results: [] })
    await searchWeb('门店结算', 999)
    expect(calls[0]!.body.count).toBe(50)

    const empty = await searchWeb('   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('检索词不能为空')

    const tooLong = await searchWeb('x'.repeat(129))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toContain('128')
    expect(calls).toHaveLength(1)
  })

  it('maps provider errors to Chinese reasons instead of throwing', async () => {
    handler = (_call, response) =>
      respond(response, 429, { error: { message: 'Rate limit exceeded', type: 'rate_limit' } })
    const outcome = await searchWeb('门店结算')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('HTTP 429')
      expect(outcome.reason).toContain('频率限制')
      expect(outcome.reason).toContain('Rate limit exceeded')
    }
  })

  it('redacts the key if the provider echoes it in an error message', async () => {
    handler = (_call, response) =>
      respond(response, 401, { error: { message: 'invalid key: test-key' } })
    const outcome = await searchWeb('门店结算')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('****')
      expect(outcome.reason).not.toContain('test-key')
    }
  })
})

describe('DeepSeek web fetch', () => {
  it('fetches a page as Markdown and truncates very long content', async () => {
    const content = `# 标题\n\n${'x'.repeat(20_100)}`
    handler = (_call, response) => respond(response, 200, { title: '示例页面', content })

    const outcome = await fetchWeb('https://example.com/page')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.url).toBe('https://example.com/page')
    expect(outcome.data.title).toBe('示例页面')
    expect(outcome.data.truncated).toBe(true)
    expect(outcome.data.content).toHaveLength(20_000)
    expect(calls[0]!.path).toBe('/v1/tools/fetch')
    expect(calls[0]!.body).toEqual({ url: 'https://example.com/page' })

    handler = (_call, response) => respond(response, 200, { title: '', content: '# 短页面' })
    const short = await fetchWeb('https://example.com/short')
    expect(short.ok).toBe(true)
    if (short.ok) expect(short.data.truncated).toBe(false)
  })

  it('rejects non-http URLs, credentials and pages without readable content', async () => {
    const file = await fetchWeb('file:///etc/passwd')
    expect(file.ok).toBe(false)
    if (!file.ok) expect(file.reason).toContain('http 或 https')

    const credentials = await fetchWeb('https://user:pass@example.com/a')
    expect(credentials.ok).toBe(false)
    if (!credentials.ok) expect(credentials.reason).toContain('用户名或密码')
    expect(calls).toHaveLength(0)

    handler = (_call, response) => respond(response, 200, { title: '', content: '   ' })
    const empty = await fetchWeb('https://example.com/empty')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('没有可读正文')
  })
})

describe('web tool transport failures', () => {
  it('reports network failures and non-JSON bodies without throwing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    try {
      const failed = await searchWeb('门店结算')
      expect(failed.ok).toBe(false)
      if (!failed.ok) expect(failed.reason).toContain('联网请求失败：network down')
    } finally {
      vi.unstubAllGlobals()
    }

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('read failed')
      },
    }))
    try {
      const empty = await searchWeb('门店结算')
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.reason).toBe('联网接口返回的不是 JSON')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports an HTTP failure without a provider message', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '',
    }))
    try {
      const outcome = await fetchWeb('https://example.com/a')
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('联网请求失败（HTTP 502，请求失败）')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips malformed search results and normalises the count', async () => {
    handler = (_call, response) =>
      respond(response, 200, {
        results: [null, 'text', { title: '缺少地址' }, { url: 'https://example.com/ok' }],
      })
    const outcome = await searchWeb('门店结算', Number.NaN)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data.results).toHaveLength(1)
    expect(calls[0]?.body.count).toBe(10)
    await searchWeb('门店结算', 0)
    expect(calls[1]?.body.count).toBe(1)
  })

  it('rejects over-long and malformed page URLs before calling the API', async () => {
    const tooLong = await fetchWeb(`https://example.com/${'x'.repeat(9000)}`)
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toContain('不能超过 8192')
    const malformed = await fetchWeb('not a url')
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.reason).toContain('不是合法 URL')
    expect(calls).toHaveLength(0)
  })
})
