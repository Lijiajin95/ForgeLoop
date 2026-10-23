import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentRunner } from '../src/runtime/agent-runner.js'

function event(type: string, data: unknown) {
  return { type, seq: 0, time: 0, data }
}

function fakeContext(options: {
  events: unknown[]
  behavior?: 'complete' | 'hang' | 'throw'
  onCancel?: () => void
}) {
  let cancelled = false
  const agent = {
    id: 'session-fake',
    session: { ownEvents: () => options.events },
    followup: vi.fn(),
    whenIdle: () => {
      if (options.behavior === 'throw') return Promise.reject(new Error('boom'))
      if (options.behavior === 'hang') {
        return new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 60_000).unref?.()
          const interval = setInterval(() => {
            if (cancelled) {
              clearInterval(interval)
              resolve()
            }
          }, 1)
          interval.unref?.()
        })
      }
      return Promise.resolve()
    },
    cancel: () => {
      cancelled = true
      options.onCancel?.()
    },
  }
  return {
    ctx: {
      agents: { create: async () => ({ agent, dispose: async () => undefined }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
    agent,
  }
}

function request(overrides: Partial<Parameters<AgentRunner['run']>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-agent-'))
  return {
    role: 'review' as const,
    cwd: dir,
    prompt: 'p',
    permission: 'workspace-write' as const,
    timeoutMs: 5_000,
    transcriptPath: join(dir, 'transcript.jsonl'),
    ...overrides,
  }
}

describe('AgentRunner result extraction', () => {
  it('returns the assistant text and turn reason for a completed turn', async () => {
    const { ctx } = fakeContext({
      events: [
        event('turn/start', { turn: 1 }),
        event('tool/call', { name: 'bash' }),
        event('assistant/message', {
          message: { content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'done' }] },
        }),
        event('turn/end', { reason: { kind: 'completed' } }),
      ],
    })
    const runner = new AgentRunner({ ctx: ctx as never, agent: { provider: '', model: '', timeoutSeconds: 60 } })
    const result = await runner.run(request())
    expect(result.status).toBe('completed')
    expect(result.text).toBe('done')
    expect(result.toolCalls).toEqual(['bash'])
    expect(readFileSync(result.transcriptPath, 'utf8')).toContain('assistant/message')
  })

  it('maps a provider error to error with its message', async () => {
    const { ctx } = fakeContext({
      events: [
        event('assistant/message', { message: { content: [{ type: 'text', text: 'partial' }] } }),
        event('turn/end', { reason: { kind: 'error', error: { message: 'provider down' } } }),
      ],
    })
    const runner = new AgentRunner({ ctx: ctx as never, agent: { provider: '', model: '', timeoutSeconds: 60 } })
    const result = await runner.run(request())
    expect(result.status).toBe('error')
    expect(result.reason).toContain('provider down')
  })

  it('treats a completed turn with no text as an error, not success', async () => {
    const { ctx } = fakeContext({
      events: [event('turn/end', { reason: { kind: 'completed' } })],
    })
    const runner = new AgentRunner({ ctx: ctx as never, agent: { provider: '', model: '', timeoutSeconds: 60 } })
    const result = await runner.run(request())
    expect(result.status).toBe('error')
    expect(result.reason).toContain('没有产出可用文本')
  })

  it('cancels and reports timeout instead of hanging forever', async () => {
    const { ctx } = fakeContext({
      events: [event('turn/end', { reason: { kind: 'aborted' } })],
      behavior: 'hang',
    })
    const runner = new AgentRunner({ ctx: ctx as never, agent: { provider: '', model: '', timeoutSeconds: 60 } })
    const result = await runner.run(request({ timeoutMs: 20 }))
    expect(result.status).toBe('timeout')
    expect(result.reason).toContain('已取消')
  })

  it('surfaces a whenIdle failure as error', async () => {
    const { ctx } = fakeContext({ events: [], behavior: 'throw' })
    const runner = new AgentRunner({ ctx: ctx as never, agent: { provider: '', model: '', timeoutSeconds: 60 } })
    const result = await runner.run(request())
    expect(result.status).toBe('error')
    expect(result.reason).toContain('boom')
  })

  it('requires an explicit selection or a host default model', () => {
    const runner = new AgentRunner({
      ctx: {} as never,
      agent: { provider: '', model: '', timeoutSeconds: 60 },
    })
    expect(() => runner.resolveSelection()).toThrow(/模型选择/)
    expect(
      new AgentRunner({
        ctx: {} as never,
        agent: { provider: 'x', model: 'y', timeoutSeconds: 60 },
      }).resolveSelection(),
    ).toEqual({ provider: 'x', model: 'y' })
  })
})