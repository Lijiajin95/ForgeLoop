import { describe, expect, it, vi } from 'vitest'
import { sendDeploymentAlert, type AlertFetch } from '../src/runtime/deployment-alerts.js'

function okFetch(): AlertFetch {
  return async () => ({ ok: true, status: 200 })
}

describe('deployment alerts', () => {
  it('posts one JSON body with the fixed method and headers', async () => {
    const calls: Array<{
      url: string
      init: { method: string; headers: Record<string, string>; body: string }
    }> = []
    const fetchImpl: AlertFetch = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    }
    const result = await sendDeploymentAlert(
      'https://example.com/hook',
      { kind: 'deployment', intentId: 'dep-1' },
      1,
      fetchImpl,
    )
    expect(result).toEqual({ ok: true, error: '' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({ kind: 'deployment', intentId: 'dep-1' })
  })

  it('retries once after a non-2xx response and then succeeds', async () => {
    let attempts = 0
    const fetchImpl: AlertFetch = async () => {
      attempts += 1
      return attempts === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 }
    }
    const result = await sendDeploymentAlert(
      'https://example.com/hook',
      { at: 'now' },
      1,
      fetchImpl,
    )
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
  })

  it('returns a failure summary when both attempts fail', async () => {
    const fetchImpl: AlertFetch = async () => ({ ok: false, status: 500 })
    const result = await sendDeploymentAlert(
      'https://example.com/hook',
      { at: 'now' },
      1,
      fetchImpl,
    )
    expect(result).toEqual({ ok: false, error: 'HTTP 500' })
  })

  it('aborts a hanging request and never throws', async () => {
    const fetchImpl: AlertFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    const result = await sendDeploymentAlert(
      'https://example.com/hook',
      { at: 'now' },
      1,
      fetchImpl,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('请求超时')
  }, 10_000)

  it('reports network errors without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as AlertFetch
    const result = await sendDeploymentAlert('https://example.com/hook', {}, 1, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ECONNREFUSED')
  })

  it('succeeds with the default fetch implementation contract', async () => {
    const result = await sendDeploymentAlert('https://127.0.0.1:1/unreachable', {}, 1, okFetch())
    expect(result.ok).toBe(true)
  })

  it('uses the global fetch when no implementation is injected', async () => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return { ok: true, status: 200 }
    }) as typeof fetch
    try {
      const result = await sendDeploymentAlert('https://example.com/default', { at: 'now' }, 1)
      expect(result).toEqual({ ok: true, error: '' })
      expect(calls).toEqual(['https://example.com/default'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('falls back to a readable failure when the thrown value is empty', async () => {
    const fetchImpl = (async () => {
      throw ''
    }) as unknown as AlertFetch
    const result = await sendDeploymentAlert('https://example.com/hook', {}, 1, fetchImpl)
    expect(result).toEqual({ ok: false, error: '告警发送失败' })
  })
})
