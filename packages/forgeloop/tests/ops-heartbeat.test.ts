import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { sendOpsHeartbeat } from '../src/runtime/ops-heartbeat.js'

let server: Server | null = null
let received: Array<{ method: string; body: string }> = []
const at = new Date('2026-11-02T10:00:00.000Z')

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
  received = []
})

async function listen(status: number, delayMs = 0): Promise<string> {
  const next = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      received.push({ method: request.method ?? '', body })
      setTimeout(() => {
        response.writeHead(status)
        response.end()
      }, delayMs)
    })
  })
  server = next
  await new Promise<void>((resolve) => next.listen(0, '127.0.0.1', resolve))
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  return `http://127.0.0.1:${address.port}/ping/abc`
}

function input(url: string, method: 'GET' | 'POST' = 'GET', timeoutSeconds = 2) {
  return {
    url,
    method,
    timeoutSeconds,
    project: 'forgeloop',
    at,
    status: 'healthy',
    issues: 0,
  }
}

describe('ops heartbeat', () => {
  it('reports a GET heartbeat without a body', async () => {
    const url = await listen(204)
    const outcome = await sendOpsHeartbeat(input(url))
    expect(outcome).toEqual({ ok: true, status: 204, error: '' })
    expect(received).toHaveLength(1)
    expect(received[0]?.method).toBe('GET')
    expect(received[0]?.body).toBe('')
  })

  it('reports a POST heartbeat with scan facts', async () => {
    const url = await listen(200)
    const outcome = await sendOpsHeartbeat(input(url, 'POST'))
    expect(outcome.ok).toBe(true)
    const body = JSON.parse(received[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.project).toBe('forgeloop')
    expect(body.status).toBe('healthy')
    expect(body.issues).toBe(0)
    expect(body.at).toBe(at.toISOString())
  })

  it('treats a non-2xx response as a failed heartbeat', async () => {
    const url = await listen(500)
    const outcome = await sendOpsHeartbeat(input(url))
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe(500)
    expect(outcome.error).toContain('HTTP 500')
  })

  it('records an unreachable heartbeat instead of throwing', async () => {
    const outcome = await sendOpsHeartbeat(input('http://127.0.0.1:1/ping/abc'))
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe(0)
    expect(outcome.error).toContain('心跳上报失败')
  })

  it('gives up after the configured timeout', async () => {
    const url = await listen(200, 300)
    const outcome = await sendOpsHeartbeat(input(url, 'GET', 0.05))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('心跳上报失败')
  })
})
