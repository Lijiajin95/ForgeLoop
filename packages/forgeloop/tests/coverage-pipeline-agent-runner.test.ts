import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentRunner,
  sessionFromRunner,
  type AgentOpenRequest,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentSession,
} from '../src/runtime/agent-runner.js'

/**
 * 覆盖率门禁补充：Agent 执行器的会话形态与回合收口。
 * 这些用例只通过公开接口（open/resume/run/send/close 与宿主服务调用记录）观察行为：
 * 回合超时、停止、宿主异常、无文本、会话关闭后继续投递、宿主缺少工具或权限服务。
 */

function event(type: string, data: unknown) {
  return { type, seq: 0, time: 0, data }
}

const COMPLETED_EVENTS = [
  event('turn/start', { turn: 1 }),
  event('tool/call', { name: 'bash' }),
  event('assistant/message', { message: { content: [{ type: 'text', text: '完成' }] } }),
  event('turn/end', { reason: { kind: 'completed' } }),
]

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const path = dirs.pop()
    if (path) rmSync(path, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'forgeloop-agent-cov-'))
  dirs.push(path)
  return path
}

interface HostOptions {
  /** 回合结束时宿主的行为：正常结束、需要 cancel 才结束、延迟结束、直接抛错。 */
  behavior?: 'complete' | 'hang' | 'throw'
  /** 延迟多少毫秒后自行结束回合；用于让周期活动快照有机会触发。 */
  completeAfterMs?: number
  events?: () => unknown[]
  /** true 时宿主通过 ctx.get(name) 暴露服务，覆盖服务解析的另一条路径。 */
  getStyle?: boolean
  dispose?: 'ok' | 'hang' | 'throw'
  onDeny?: (deny: string[]) => void
  onMount?: (id: string) => void
  onPermission?: (preset: string) => void
  permissionThrows?: boolean
  dropPresets?: boolean
  dropTools?: boolean
  resume?: (options: Record<string, unknown>) => Promise<unknown>
}

function host(options: HostOptions = {}) {
  let cancelled = false
  const events = options.events ?? (() => COMPLETED_EVENTS)
  const agent = {
    id: 'session-fl-dev-test',
    session: { ownEvents: () => events() },
    followup: () => undefined,
    whenIdle: () => {
      if (options.behavior === 'throw') return Promise.reject(new Error('boom'))
      if (options.behavior === 'hang') {
        // 只有宿主收到 cancel 才结束，模拟真实回合被取消。
        return new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (cancelled) {
              clearInterval(interval)
              resolve()
            }
          }, 1)
          interval.unref?.()
        })
      }
      if (options.completeAfterMs) {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.completeAfterMs)
          timer.unref?.()
        })
      }
      return Promise.resolve()
    },
    cancel: () => {
      cancelled = true
    },
  }
  const dispose = async () => {
    if (options.dispose === 'throw') throw new Error('dispose failed')
    if (options.dispose === 'hang') return new Promise<void>(() => undefined)
    return undefined
  }
  const services: Record<string, unknown> = {
    agents: {
      create: async (createOptions: Record<string, unknown>) => {
        const setup = createOptions.setup as ((ctx: unknown) => unknown) | undefined
        await setup?.({
          tools: {
            restrict: (filter: { deny: string[] }) => {
              options.onDeny?.(filter.deny)
              return () => undefined
            },
          },
        })
        return { agent, dispose }
      },
      ...(options.resume ? { resume: options.resume } : {}),
    },
    tools: {
      schemas: () => [{ name: 'bash' }, { name: 'fs' }, { name: 'forgeloop_read_project_doc' }],
    },
    agentPresets: {
      mount: async (_ctx: unknown, id: string) => {
        options.onMount?.(id)
        return { id }
      },
    },
    permissionPresets: {
      set: (_session: unknown, preset: string) => {
        if (options.permissionThrows) throw new Error('session is gone')
        options.onPermission?.(preset)
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }
  if (options.dropPresets) delete services.agentPresets
  if (options.dropTools) delete services.tools
  // 宿主同时提供 ctx.get(name) 与直接属性：执行器两种服务解析路径都要能工作。
  const ctx = options.getStyle
    ? {
        ...services,
        get: (name: string) => services[name],
      }
    : services
  return { ctx, agent }
}

function runRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  const dir = tempDir()
  return {
    role: 'verify' as const,
    cwd: dir,
    prompt: 'p',
    permission: 'workspace-write' as const,
    timeoutMs: 5_000,
    transcriptPath: join(dir, 'transcript.jsonl'),
    ...overrides,
  }
}

function openRequest(overrides: Partial<AgentOpenRequest> = {}): AgentOpenRequest {
  return {
    role: 'dev' as const,
    cwd: tempDir(),
    permission: 'workspace-write' as const,
    ...overrides,
  }
}

function runnerOf(ctx: Record<string, unknown>, extra: Record<string, unknown> = {}): AgentRunner {
  return new AgentRunner({
    ctx: ctx as never,
    agent: { provider: 'p', model: 'm', timeoutSeconds: 60 },
    ...extra,
  } as never)
}

function turnOf(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'p',
    timeoutMs: 5_000,
    transcriptPath: join(dir, 'turn.jsonl'),
    ...overrides,
  }
}

describe('sessionFromRunner fallback session', () => {
  const baseRun = (request: AgentRunRequest): AgentRunResult => ({
    status: 'completed',
    text: 'ok',
    sessionId: `session-fl-${request.role}-fallback`,
    reason: '',
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  })

  it('delegates each turn to the single-turn runner with the session settings', async () => {
    const calls: AgentRunRequest[] = []
    const session = sessionFromRunner(
      {
        async run(request) {
          calls.push(request)
          return baseRun(request)
        },
      },
      {
        role: 'dev',
        cwd: '/workspace',
        permission: 'workspace-write',
        tools: 'default',
        allowTools: ['bash'],
      },
    )
    expect(session.sessionId).toBe('session-fl-dev-fallback')

    const controller = new AbortController()
    const activities: number[] = []
    const result = await session.send({
      prompt: '做这个',
      timeoutMs: 1234,
      transcriptPath: '/tmp/x.jsonl',
      signal: controller.signal,
      onActivity: (events) => activities.push(events.length),
    })
    expect(result.status).toBe('completed')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      role: 'dev',
      cwd: '/workspace',
      prompt: '做这个',
      permission: 'workspace-write',
      timeoutMs: 1234,
      transcriptPath: '/tmp/x.jsonl',
      tools: 'default',
    })
    expect(calls[0]?.signal).toBe(controller.signal)
    expect(typeof calls[0]?.onActivity).toBe('function')

    // 不传可选字段时不把 undefined 透传给宿主。
    await session.send({ prompt: '第二轮', transcriptPath: '/tmp/y.jsonl' })
    expect(calls[1]).not.toHaveProperty('signal')
    expect(calls[1]).not.toHaveProperty('onActivity')
    // 会话级设置（工具策略）在两轮里都沿用。
    expect(calls[1]?.tools).toBe('default')
  })

  it('does not forward a tool policy when the session has none', async () => {
    const calls: AgentRunRequest[] = []
    const session = sessionFromRunner(
      {
        async run(request) {
          calls.push(request)
          return baseRun(request)
        },
      },
      { role: 'dev', cwd: '/workspace', permission: 'workspace-write' },
    )
    await session.send({ prompt: '一', transcriptPath: '/tmp/one.jsonl' })
    expect(calls[0]).not.toHaveProperty('tools')
    expect(calls[0]).not.toHaveProperty('signal')
  })

  it('refuses further turns after the fallback session is closed', async () => {
    let runs = 0
    const session = sessionFromRunner(
      {
        async run(request) {
          runs += 1
          return baseRun(request)
        },
      },
      { role: 'dev', cwd: '/workspace', permission: 'workspace-write' },
    )
    await session.send({ prompt: '一', transcriptPath: '/tmp/one.jsonl' })
    await session.close()

    const refused = await session.send({ prompt: '二', transcriptPath: '/tmp/two.jsonl' })
    expect(refused.status).toBe('error')
    expect(refused.reason).toBe('会话已关闭')
    expect(refused.text).toBe('')
    expect(refused.sessionId).toBe('session-fl-dev-fallback')
    expect(refused.transcriptPath).toBe('/tmp/two.jsonl')
    expect(runs).toBe(1)
  })
})

describe('AgentRunner host services', () => {
  it('opens a coding session, mounts the standard preset and applies the permission preset', async () => {
    const mounted: string[] = []
    const permissions: string[] = []
    const { ctx } = host({
      getStyle: true,
      onMount: (id) => mounted.push(id),
      onPermission: (preset) => permissions.push(preset),
    })
    const session = await runnerOf(ctx).open(openRequest({ sessionId: 'session-fl-dev-fixed' }))
    expect(session.sessionId).toBe('session-fl-dev-fixed')
    expect(mounted).toEqual(['standard'])
    expect(permissions).toEqual(['workspace-write'])
  })

  it('keeps only allowlisted tools for a narrow session without the coding preset', async () => {
    const mounted: string[] = []
    const denied: string[][] = []
    const { ctx } = host({
      onMount: (id) => mounted.push(id),
      onDeny: (names) => denied.push(names),
    })
    await runnerOf(ctx).open(
      openRequest({ tools: 'default', allowTools: ['forgeloop_read_project_doc'] }),
    )
    expect(mounted).toEqual([])
    expect(denied).toEqual([['bash', 'fs']])
  })

  it('denies every tool for a reasoning session', async () => {
    const denied: string[][] = []
    const { ctx } = host({ onDeny: (names) => denied.push(names) })
    await runnerOf(ctx).open(openRequest({ role: 'product', tools: 'none' }))
    expect(denied).toEqual([['bash', 'fs', 'forgeloop_read_project_doc']])
  })

  it('does not call restrict when every host tool is allowlisted', async () => {
    const denied: string[][] = []
    const { ctx } = host({ onDeny: (names) => denied.push(names) })
    await runnerOf(ctx).open(
      openRequest({
        tools: 'default',
        allowTools: ['bash', 'fs', 'forgeloop_read_project_doc'],
      }),
    )
    expect(denied).toEqual([])
  })

  it('rejects a coding session when the host cannot mount the coding preset', async () => {
    const { ctx } = host({ dropPresets: true })
    await expect(runnerOf(ctx).open(openRequest())).rejects.toThrow('agentPresets.mount')
  })

  it('opens without a setup hook when neither tools nor a coding preset apply', async () => {
    const { ctx } = host({ dropTools: true })
    const session = await runnerOf(ctx).open(openRequest({ tools: 'none' }))
    expect(session.sessionId).toMatch(/^session-fl-dev-/)
  })

  it('resumes a persisted session and reapplies the permission preset', async () => {
    const permissions: string[] = []
    const { ctx } = host({
      getStyle: true,
      onPermission: (preset) => permissions.push(preset),
      resume: async () => ({
        agent: {
          id: 's',
          session: {},
          followup() {},
          whenIdle: async () => undefined,
          cancel() {},
        },
        dispose: async () => undefined,
      }),
    })
    const session = await runnerOf(ctx).resume({
      role: 'dev',
      sessionId: 'session-fl-dev-resumed',
      permission: 'workspace-write',
      tools: 'none',
    })
    expect(session.sessionId).toBe('session-fl-dev-resumed')
    expect(permissions).toEqual(['workspace-write'])
  })

  it('refuses a resumed handle whose session cannot take a permission preset', async () => {
    const { ctx } = host({
      permissionThrows: true,
      resume: async () => ({
        agent: {
          id: 's',
          session: {},
          followup() {},
          whenIdle: async () => undefined,
          cancel() {},
        },
        dispose: async () => undefined,
      }),
    })
    await expect(
      runnerOf(ctx).resume({
        role: 'dev',
        sessionId: 'session-fl-dev-broken',
        permission: 'workspace-write',
      }),
    ).rejects.toThrow('句柄不可用：session is gone；拒绝继续')
  })
})

describe('AgentRunner session turn outcomes', () => {
  async function openSession(options: HostOptions = {}): Promise<{
    session: AgentSession
    agent: ReturnType<typeof host>['agent']
    dir: string
  }> {
    const { ctx, agent } = host(options)
    const dir = tempDir()
    const session = await runnerOf(ctx).open({
      role: 'dev',
      cwd: dir,
      sessionId: 'session-fl-dev-test',
      permission: 'workspace-write',
    })
    return { session, agent, dir }
  }

  it('returns the assistant text and writes the session transcript', async () => {
    const { session, dir } = await openSession()
    const result = await session.send(turnOf(dir))
    expect(result.status).toBe('completed')
    expect(result.text).toBe('完成')
    expect(result.toolCalls).toEqual(['bash'])
    expect(result.sessionId).toBe('session-fl-dev-test')
    expect(readFileSync(join(dir, 'turn.jsonl'), 'utf8')).toContain('assistant/message')
  })

  it('times out a session turn that exceeds the turn limit and then refuses more turns', async () => {
    const { session, dir } = await openSession({ behavior: 'hang' })
    const result = await session.send(turnOf(dir, { timeoutMs: 25 }))
    expect(result.status).toBe('timeout')
    expect(result.reason).toContain('上限，已取消')

    const refused = await session.send(turnOf(dir, { transcriptPath: join(dir, 'again.jsonl') }))
    expect(refused.status).toBe('error')
    expect(refused.reason).toBe('会话已结束，不能继续投递回合')
  })

  it('stops a session turn when the caller aborts and marks the session dead', async () => {
    const { session, dir } = await openSession({ behavior: 'hang' })
    const controller = new AbortController()
    const pending = session.send(turnOf(dir, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 20)
    const result = await pending
    expect(result.status).toBe('aborted')
    expect(result.reason).toBe('Agent 回合因停止请求被取消；回合未正常完成')

    const refused = await session.send(turnOf(dir))
    expect(refused.status).toBe('error')
    expect(refused.reason).toBe('会话已结束，不能继续投递回合')
  })

  it('reports a host failure during the turn and closes the session', async () => {
    const { session, dir } = await openSession({ behavior: 'throw' })
    const result = await session.send(turnOf(dir))
    expect(result.status).toBe('error')
    expect(result.reason).toBe('Agent 回合失败：boom')

    const refused = await session.send(turnOf(dir))
    expect(refused.status).toBe('error')
    expect(refused.reason).toBe('会话已结束，不能继续投递回合')
  })

  it('maps a host-side aborted turn end to aborted and an error end with its detail', async () => {
    const aborted = await openSession({
      events: () => [
        event('assistant/message', { message: { content: 'not-array' } }),
        event('turn/end', { reason: { kind: 'aborted' } }),
      ],
    })
    const abortedResult = await aborted.session.send(turnOf(aborted.dir))
    expect(abortedResult.status).toBe('aborted')
    expect(abortedResult.reason).toContain('未正常完成：aborted')
    expect(abortedResult.text).toBe('')

    const failed = await openSession({
      events: () => [
        event('assistant/message', { message: { content: [{ type: 'text', text: 'partial' }] } }),
        event('turn/end', { reason: { kind: 'error', error: { message: 'provider down' } } }),
      ],
    })
    const failedResult = await failed.session.send(turnOf(failed.dir))
    expect(failedResult.status).toBe('error')
    expect(failedResult.reason).toBe('Agent 回合未正常完成：error（provider down）')
    expect(failedResult.text).toBe('partial')
  })

  it('reports a completed turn without usable text as an error but keeps the session usable', async () => {
    const completedWithoutText = await openSession({
      events: () => [event('turn/end', { reason: { kind: 'completed' } })],
    })
    const result = await completedWithoutText.session.send(turnOf(completedWithoutText.dir))
    expect(result.status).toBe('error')
    expect(result.reason).toBe('Agent 回合完成但没有产出可用文本')

    const usable = await openSession()
    const second = await usable.session.send(turnOf(usable.dir))
    expect(second.status).toBe('completed')
  })

  it('reports a missing turn reason instead of claiming success', async () => {
    const { session, dir } = await openSession({
      events: () => [
        event('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }),
      ],
    })
    const result = await session.send(turnOf(dir))
    expect(result.status).toBe('error')
    expect(result.reason).toBe('Agent 回合未正常完成：未给出结束原因（回合未给出结束原因）')
  })

  it('flushes activity snapshots during a long turn and survives a failing activity sink', async () => {
    let count = 0
    const { session, dir } = await openSession({
      completeAfterMs: 1_800,
      events: () => {
        // 每读一次就多露出两段事件，证明活动快照按事件数增长重置无进展计时。
        count = Math.min(count + 2, COMPLETED_EVENTS.length)
        return COMPLETED_EVENTS.slice(0, count)
      },
    })
    const snapshots: number[] = []
    const result = await session.send(
      turnOf(dir, {
        timeoutMs: 10_000,
        onActivity: (events) => {
          snapshots.push(events.length)
          throw new Error('activity sink unavailable')
        },
      }),
    )
    await session.close()
    expect(snapshots.length).toBeGreaterThan(0)
    expect(result.status).toBe('completed')
    expect(readFileSync(join(dir, 'turn.jsonl'), 'utf8')).toContain('turn/end')
  })

  it('closes once, tolerates a failing host dispose and severs the session', async () => {
    const failing = await openSession({ dispose: 'throw' })
    await failing.session.close()
    await failing.session.close()
    const refused = await failing.session.send(turnOf(failing.dir))
    expect(refused.status).toBe('error')
    expect(refused.reason).toBe('会话已结束，不能继续投递回合')
  })

  it('bounds a host dispose that never returns', async () => {
    const { session, dir } = await openSession({ dispose: 'hang' })
    await session.send(turnOf(dir))
    const started = Date.now()
    await session.close()
    expect(Date.now() - started).toBeLessThan(7_000)
  })
})

describe('AgentRunner single-turn extras', () => {
  it('runs a reasoning turn on a host without a tools service', async () => {
    const { ctx } = host({ dropTools: true })
    const result = await runnerOf(ctx).run(runRequest({ role: 'product', tools: 'none' }))
    expect(result.status).toBe('completed')
    expect(result.text).toBe('完成')
  })

  it('keeps the turn alive when the activity sink throws', async () => {
    let count = 0
    const { ctx } = host({
      completeAfterMs: 1_800,
      events: () => {
        // 每读一次就多露出两段事件，证明活动快照按事件数增长重置无进展计时。
        count = Math.min(count + 2, COMPLETED_EVENTS.length)
        return COMPLETED_EVENTS.slice(0, count)
      },
    })
    const snapshots: number[] = []
    const result = await runnerOf(ctx).run(
      runRequest({
        role: 'dev',
        timeoutMs: 10_000,
        onActivity: (events) => {
          snapshots.push(events.length)
          throw new Error('activity sink unavailable')
        },
      }),
    )
    expect(snapshots.length).toBeGreaterThan(0)
    expect(result.status).toBe('completed')
  })

  it('reports an aborted turn when the caller stops it', async () => {
    const { ctx } = host({ behavior: 'hang' })
    const controller = new AbortController()
    const pending = runnerOf(ctx).run(runRequest({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 20)
    const result = await pending
    expect(result.status).toBe('aborted')
    expect(result.reason).toBe('Agent 回合因停止请求被取消；回合未正常完成')
  })

  it('times out a hanging single turn at the turn limit', async () => {
    const { ctx } = host({ behavior: 'hang' })
    const result = await runnerOf(ctx).run(runRequest({ timeoutMs: 30 }))
    expect(result.status).toBe('timeout')
    expect(result.reason).toContain('上限，已取消')
  })

  it('times out a single turn that makes no progress for the idle limit', async () => {
    const { ctx } = host({ behavior: 'hang' })
    const runner = new AgentRunner({
      ctx: ctx as never,
      agent: { provider: 'p', model: 'm', timeoutSeconds: 60, idleTimeoutSeconds: 1 },
    })
    const result = await runner.run(runRequest({ timeoutMs: 10_000 }))
    expect(result.status).toBe('timeout')
    expect(result.reason).toBe('Agent 回合连续 1 秒没有新进展，已取消')
  })
})
