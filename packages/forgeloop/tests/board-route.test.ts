import { describe, expect, it } from 'vitest'
import { createBoardFetch } from '../src/runtime/board-route.js'
import type { Coordinator } from '../src/runtime/coordinator.js'
import type { ForgeLoopRuntime } from '../src/runtime/service.js'
import type { ForgeLoopConfig } from '../src/config.js'

function setup(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; input?: unknown }> = []
  const runtime = {
    requirementDetail: (reqId: string) => {
      calls.push({ method: 'requirementDetail', input: reqId })
      return { ok: true, data: { reqId } }
    },
    taskDetail: (reqId: string, taskId: string, planVersion?: number) => {
      calls.push({ method: 'taskDetail', input: { reqId, taskId, planVersion } })
      return { ok: true, data: {} }
    },
    taskExecution: (input: unknown) => {
      calls.push({ method: 'taskExecution', input })
      return { ok: true, data: {} }
    },
    sessionSummary: (sessionId: string) => {
      calls.push({ method: 'sessionSummary', input: sessionId })
      return { sessionId }
    },
    requestOperation: (input: unknown) => {
      calls.push({ method: 'requestOperation', input })
      return { ok: true, data: {} }
    },
    approvePlan: (input: unknown) => {
      calls.push({ method: 'approvePlan', input })
      return { ok: true, data: {} }
    },
    requeue: (input: unknown) => {
      calls.push({ method: 'requeue', input })
      return { ok: true, data: {} }
    },
    analysisQueue: {
      retry: (input: unknown) => {
        calls.push({ method: 'retryAnalysis', input })
        return { ok: true, data: {} }
      },
    },
    buildCandidate: (input: unknown) => {
      calls.push({ method: 'buildCandidate', input })
      return { ok: true, data: {} }
    },
    verifyDeployment: (input: unknown) => {
      calls.push({ method: 'verifyDeployment', input })
      return { ok: true, data: {} }
    },
    retryTask: (input: unknown) => {
      calls.push({ method: 'retryTask', input })
      return { ok: true, data: {} }
    },
    accept: (input: unknown) => {
      calls.push({ method: 'accept', input })
      return { ok: true, data: {} }
    },
    cancel: (input: unknown) => {
      calls.push({ method: 'cancel', input })
      return { ok: true, data: {} }
    },
    stop: (input: unknown) => {
      calls.push({ method: 'stop', input })
      return { ok: true, data: {} }
    },
    opsStatus: (eventId?: string) => {
      calls.push({ method: 'opsStatus', input: eventId })
      return { ok: true, data: {} }
    },
    opsDecide: (input: unknown) => {
      calls.push({ method: 'opsDecide', input })
      return { ok: true, data: {} }
    },
    opsClose: (input: unknown) => {
      calls.push({ method: 'opsClose', input })
      return { ok: true, data: {} }
    },
    opsRequestFix: (input: unknown) => {
      calls.push({ method: 'opsRequestFix', input })
      return { ok: true, data: {} }
    },
    statusBoard: (limit?: number, query?: string) => {
      calls.push({ method: 'statusBoard', input: { limit, query } })
      return { requirements: [] }
    },
    reliability: (window: string) => {
      calls.push({ method: 'reliability', input: window })
      return { window: { key: window } }
    },
    ...overrides,
  } as unknown as ForgeLoopRuntime
  let aborted = 0
  const coordinator = {
    abortRequirement: () => {
      aborted += 1
      return true
    },
  } as unknown as Coordinator
  const config = { owner: 'owner' } as ForgeLoopConfig
  return { fetch: createBoardFetch(runtime, config, coordinator), calls, aborted: () => aborted }
}

async function post(
  fetch: (request: Request) => Promise<Response>,
  body: unknown,
  raw = false,
): Promise<{ status: number; body: any }> {
  const request = new Request('http://127.0.0.1/board', {
    method: 'POST',
    body: raw ? String(body) : JSON.stringify(body),
  })
  const response = await fetch(request)
  return { status: response.status, body: await response.json() }
}

describe('board route', () => {
  it('rejects invalid JSON and unknown endpoints', async () => {
    const { fetch } = setup()
    expect((await post(fetch, 'not-json', true)).status).toBe(400)
    expect((await post(fetch, { endpoint: 'nope' })).body.error.code).toBe('not_found')
  })

  it('returns the default board and validates query/limit', async () => {
    const { fetch, calls } = setup()
    expect((await post(fetch, { endpoint: 'board' })).status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'statusBoard', input: { limit: undefined, query: '' } })
    expect((await post(fetch, { endpoint: 'board', query: 1 })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'board', limit: 0 })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'board', limit: 101 })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'board', limit: 2, query: ' x ' })).status).toBe(200)
  })

  it('dispatches the read-only reliability endpoint with a validated window', async () => {
    const { fetch, calls } = setup()
    expect((await post(fetch, { endpoint: 'reliability' })).status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'reliability', input: 'all' })
    expect((await post(fetch, { endpoint: 'reliability', window: '7d' })).status).toBe(200)
    expect(calls.at(-1)).toEqual({ method: 'reliability', input: '7d' })
    expect((await post(fetch, { endpoint: 'reliability', window: '12h' })).status).toBe(400)
  })

  it('validates read endpoint inputs and dispatches successes', async () => {
    const { fetch, calls } = setup()
    expect((await post(fetch, { endpoint: 'detail' })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'detail', reqId: 'r1' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'task', reqId: 'r1' })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'task', reqId: 'r1', taskId: 't1' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'execution', reqId: 'r1', taskId: 't1' })).status).toBe(
      200,
    )
    expect(
      (await post(fetch, { endpoint: 'execution', reqId: 'r1', taskId: 't1', limit: 0 })).status,
    ).toBe(400)
    expect((await post(fetch, { endpoint: 'session' })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'session', sessionId: 's1' })).status).toBe(200)
    expect(calls.some((call) => call.method === 'sessionSummary')).toBe(true)
  })

  it('dispatches write endpoints with owner and web-decision source', async () => {
    const { fetch, calls, aborted } = setup()
    const bodies = [
      { endpoint: 'plan', reqId: 'r1', sessionId: 's1' },
      { endpoint: 'approve', reqId: 'r1', planVersion: 1 },
      { endpoint: 'advance', reqId: 'r1' },
      { endpoint: 'verify', reqId: 'r1' },
      { endpoint: 'requeue', reqId: 'r1' },
      { endpoint: 'retry-analysis', reqId: 'r1', sessionId: 's1' },
      { endpoint: 'build', reqId: 'r1' },
      { endpoint: 'deploy', reqId: 'r1', targetProfile: 'p1' },
      { endpoint: 'retry', reqId: 'r1', taskId: 't1', planVersion: 1 },
      { endpoint: 'accept', reqId: 'r1' },
      { endpoint: 'cancel', reqId: 'r1' },
      { endpoint: 'stop', reqId: 'r1' },
    ]
    for (const body of bodies) {
      expect((await post(fetch, body)).status, JSON.stringify(body)).toBe(200)
    }
    expect(aborted()).toBe(2)
    expect(calls.some((call) => call.method === 'approvePlan')).toBe(true)
    expect(calls.find((call) => call.method === 'retryAnalysis')?.input).toMatchObject({
      reqId: 'r1',
      by: 'owner',
      source: 'web-decision:s1',
    })
    expect(calls.some((call) => call.method === 'verifyDeployment')).toBe(true)
  })

  it('rejects write endpoints missing required fields', async () => {
    const { fetch } = setup()
    for (const body of [
      { endpoint: 'plan' },
      { endpoint: 'approve', reqId: 'r1' },
      { endpoint: 'advance' },
      { endpoint: 'verify' },
      { endpoint: 'requeue' },
      { endpoint: 'retry-analysis' },
      { endpoint: 'build' },
      { endpoint: 'deploy', reqId: 'r1' },
      { endpoint: 'retry', reqId: 'r1', taskId: 't1' },
      { endpoint: 'accept' },
      { endpoint: 'cancel' },
      { endpoint: 'stop' },
    ]) {
      expect((await post(fetch, body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('dispatches ops endpoints and validates their inputs', async () => {
    const { fetch, calls } = setup()
    expect((await post(fetch, { endpoint: 'ops' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'ops-detail', eventId: 'e1' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'ops-detail' })).status).toBe(400)
    expect(
      (await post(fetch, { endpoint: 'ops-decide', eventId: 'e1', decision: 'approve' })).status,
    ).toBe(200)
    expect(
      (await post(fetch, { endpoint: 'ops-decide', eventId: 'e1', decision: 'x' })).status,
    ).toBe(400)
    expect((await post(fetch, { endpoint: 'ops-close', eventId: 'e1' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'ops-close' })).status).toBe(400)
    expect((await post(fetch, { endpoint: 'ops-request-fix', eventId: 'e1' })).status).toBe(200)
    expect((await post(fetch, { endpoint: 'ops-request-fix' })).status).toBe(400)
    expect(calls.some((call) => call.method === 'opsDecide')).toBe(true)
  })

  it('maps a thrown runtime error to an internal response', async () => {
    const { fetch } = setup({
      statusBoard: () => {
        throw new Error('boom')
      },
    })
    const response = await post(fetch, { endpoint: 'board' })
    expect(response.status).toBe(500)
    expect(response.body.error.message).toContain('boom')
  })
})
