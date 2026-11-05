import { describe, expect, it } from 'vitest'
import { createBoardFetch } from '../src/runtime/board-route.js'
import type { Coordinator } from '../src/runtime/coordinator.js'
import type { ForgeLoopRuntime } from '../src/runtime/service.js'
import type { ForgeLoopConfig } from '../src/config.js'

interface Call {
  readonly method: string
  readonly input?: unknown
}

function setup(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const deploymentService = {
    rollouts: (limit: number) => {
      calls.push({ method: 'rollouts', input: limit })
      return { targets: [{ id: 'target' }], rollouts: [] }
    },
    rollout: (intentId: string) => {
      calls.push({ method: 'rollout', input: intentId })
      return intentId === 'dep-1' ? { intent: { intentId } } : null
    },
    request: async (input: unknown) => {
      calls.push({ method: 'request', input })
      return { ok: true, code: 'ok', message: 'ok', data: { intentId: 'dep-1' } }
    },
    approve: async (input: { intentId: string }) => {
      calls.push({ method: 'approve', input })
      if (input.intentId === 'forbidden') {
        return { ok: false, code: 'forbidden', message: '只有所有者可以执行部署决定' }
      }
      if (input.intentId === 'conflict') {
        return { ok: false, code: 'invalid_state', message: '状态不能批准' }
      }
      if (input.intentId === 'bad-request') {
        return { ok: false, code: 'bad_request', message: '参数不完整' }
      }
      return { ok: true, code: 'ok', message: 'approved', data: {} }
    },
    reject: (input: unknown) => {
      calls.push({ method: 'reject', input })
      return { ok: true, code: 'ok', message: 'rejected' }
    },
    verify: async (input: unknown) => {
      calls.push({ method: 'verify', input })
      return { ok: true, code: 'ok', message: 'verified' }
    },
    rollback: async (input: unknown) => {
      calls.push({ method: 'rollback', input })
      return { ok: true, code: 'ok', message: 'rolled back' }
    },
    ...overrides,
  }
  const runtime = { deploymentService }
  const config = { owner: 'owner' } as unknown as ForgeLoopConfig
  return {
    calls,
    fetch: createBoardFetch(runtime as unknown as ForgeLoopRuntime, config, {} as Coordinator),
  }
}

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/forgeloop/board', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('deployment board endpoints', () => {
  it('lists registered targets and rollouts', async () => {
    const { fetch, calls } = setup()
    const response = await fetch(post({ endpoint: 'deployments', limit: 5 }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { ok: boolean; value: unknown }
    expect(payload.ok).toBe(true)
    expect(calls[0]).toEqual({ method: 'rollouts', input: 5 })
  })

  it('returns 400 for a bad limit and 404 for unreadable details', async () => {
    const { fetch } = setup()
    expect((await fetch(post({ endpoint: 'deployments' }))).status).toBe(200)
    expect((await fetch(post({ endpoint: 'deployments', limit: 0 }))).status).toBe(400)
    expect((await fetch(post({ endpoint: 'deployments', limit: '5' }))).status).toBe(400)
    expect((await fetch(post({ endpoint: 'deployment' }))).status).toBe(400)
    expect((await fetch(post({ endpoint: 'deployment', intentId: 'dep-1' }))).status).toBe(200)
    expect((await fetch(post({ endpoint: 'deployment', intentId: 'missing' }))).status).toBe(404)
  })

  it('creates an intent with the configured owner as source of record', async () => {
    const { fetch, calls } = setup()
    const response = await fetch(
      post({ endpoint: 'deployment-intent', targetId: 'target', sessionId: 's1' }),
    )
    expect(response.status).toBe(200)
    expect(calls[0]?.method).toBe('request')
    expect(calls[0]?.input).toMatchObject({
      targetId: 'target',
      by: 'owner',
      source: 'web-decision:s1:deployment-intent',
    })
  })

  it('maps missing fields to 400 and conflicts to 409', async () => {
    const { fetch } = setup()
    expect((await fetch(post({ endpoint: 'deployment-intent' }))).status).toBe(400)
    expect((await fetch(post({ endpoint: 'deployment-approve' }))).status).toBe(400)
    expect(
      (await fetch(post({ endpoint: 'deployment-approve', intentId: 'conflict' }))).status,
    ).toBe(409)
  })

  it('passes an explicit requirement id to the deployment service', async () => {
    const { fetch, calls } = setup()
    const response = await fetch(
      post({
        endpoint: 'deployment-intent',
        targetId: 'target',
        reqId: 'req-9',
        sessionId: 's1',
      }),
    )
    expect(response.status).toBe(200)
    expect(calls[0]?.input).toMatchObject({ targetId: 'target', requirementId: 'req-9' })
  })

  it('maps a missing requirement to 400', async () => {
    const { fetch } = setup({
      request: async () => ({
        ok: false,
        code: 'requirement_required',
        message: '未指定部署所属需求',
      }),
    })
    const response = await fetch(post({ endpoint: 'deployment-intent', targetId: 'target' }))
    expect(response.status).toBe(400)
  })

  it('maps a coordinator bad_request to 400', async () => {
    const { fetch } = setup()
    expect(
      (await fetch(post({ endpoint: 'deployment-approve', intentId: 'bad-request' }))).status,
    ).toBe(400)
  })

  it('maps an owner refusal to 403', async () => {
    const { fetch } = setup()
    const response = await fetch(post({ endpoint: 'deployment-approve', intentId: 'forbidden' }))
    expect(response.status).toBe(403)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe('forbidden')
  })

  it('rejects a request without a session id but keeps a source', async () => {
    const { fetch, calls } = setup()
    await fetch(post({ endpoint: 'deployment-intent', targetId: 'target' }))
    expect(calls[0]?.input).toMatchObject({
      source: 'web-decision:unknown-session:deployment-intent',
    })
  })

  it('returns 400 for every deployment action without an intent id', async () => {
    const { fetch } = setup()
    for (const endpoint of [
      'deployment-approve',
      'deployment-reject',
      'deployment-verify',
      'deployment-rollback',
    ]) {
      expect((await fetch(post({ endpoint }))).status).toBe(400)
    }
  })

  it('supports reject, verify and rollback endpoints', async () => {
    const { fetch, calls } = setup()
    expect((await fetch(post({ endpoint: 'deployment-reject', intentId: 'dep-1' }))).status).toBe(
      200,
    )
    expect((await fetch(post({ endpoint: 'deployment-verify', intentId: 'dep-1' }))).status).toBe(
      200,
    )
    expect(
      (await fetch(post({ endpoint: 'deployment-rollback', intentId: 'dep-1', reason: '回退' })))
        .status,
    ).toBe(200)
    expect(calls.map((call) => call.method)).toEqual(['reject', 'verify', 'rollback'])
    expect(calls[2]?.input).toMatchObject({ by: 'owner', reason: '回退' })
  })
})
