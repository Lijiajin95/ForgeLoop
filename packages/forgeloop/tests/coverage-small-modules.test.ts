import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_IDENTITIES, agentLabel, isAgentIdentity } from '../src/domain/agents.js'
import { asRecord, parseJsonArray, parseJsonObject } from '../src/domain/json.js'
import { GrantLedger } from '../src/domain/counting.js'
import { buildAcceptanceBinding } from '../src/runtime/acceptance-binding.js'
import { SessionRouting } from '../src/runtime/session-routing.js'
import { verificationIntegrity, verificationVerdict } from '../src/runtime/verification-outcome.js'
import { runVerificationCommands } from '../src/runtime/execution-commands.js'
import { sendOpsHeartbeat } from '../src/runtime/ops-heartbeat.js'
import { appendSessionEvent } from '../src/session/events.js'
import { registerForgeLoopPreset } from '../src/session/preset.js'
import { installSessionSurface } from '../src/session/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent identity vocabulary', () => {
  it('accepts exactly the five identities and labels each one', () => {
    for (const identity of AGENT_IDENTITIES) {
      expect(isAgentIdentity(identity)).toBe(true)
      expect(agentLabel(identity)).toMatch(/Agent$/)
    }
    expect(isAgentIdentity('human')).toBe(false)
    expect(isAgentIdentity('')).toBe(false)
  })
})

describe('json helpers', () => {
  it('parses arrays and rejects non-array payloads', () => {
    expect(parseJsonArray('[1,"a"]')).toEqual([1, 'a'])
    expect(parseJsonArray('{"a":1}')).toEqual([])
    expect(parseJsonArray('null')).toEqual([])
  })

  it('narrows records and falls back to empty objects', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord([1])).toBeUndefined()
    expect(asRecord('x')).toBeUndefined()
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1]')).toEqual({})
    expect(parseJsonObject('null')).toEqual({})
  })
})

function round(roundId: string) {
  return {
    roundId,
    stage: 'verification' as const,
    summary: roundId,
    occurredAt: '2026-11-01T00:00:00.000Z',
  }
}

describe('grant ledger edge cases', () => {
  it('rejects an invalid per-grant limit', () => {
    expect(() => new GrantLedger(1, [], 0)).toThrow('每次授权的失败轮次上限必须为 -1 或正整数')
    expect(() => new GrantLedger(1, [], -2)).toThrow('每次授权的失败轮次上限必须为 -1 或正整数')
    expect(() => new GrantLedger(1, [], 1.5)).toThrow('每次授权的失败轮次上限必须为 -1 或正整数')
  })

  it('exposes the recorded rounds and per-grant consumption', () => {
    const ledger = new GrantLedger(1, [round('a'), round('b'), round('c')], 3)
    expect(ledger.roundsPerGrant).toBe(3)
    expect(ledger.roundList.map((item) => item.roundId)).toEqual(['a', 'b', 'c'])
    expect(ledger.consumedInCurrentGrant).toBe(3)
    ledger.appendGrant()
    expect(ledger.consumedInCurrentGrant).toBe(0)
  })

  it('treats an unlimited ledger as never exhausting its grant', () => {
    const ledger = new GrantLedger(1, [round('a'), round('b')], -1)
    expect(ledger.unlimited).toBe(true)
    expect(ledger.consumedInCurrentGrant).toBe(2)
    expect(ledger.remainingInCurrentGrant).toBe(Number.POSITIVE_INFINITY)
    expect(ledger.awaitingGrantDecision).toBe(false)
    expect(ledger.canRecordFailure).toBe(true)
  })
})

describe('acceptance binding', () => {
  const plan = { tasks: [{ taskId: 'a' }, { taskId: 'b' }] }
  const artifacts = [
    {
      taskId: 'a',
      testEvidenceSha256: 'test-a',
      reviewSha256: 'review-a',
      baselineCommit: '',
    },
    {
      taskId: 'b',
      testEvidenceSha256: 'test-b',
      reviewSha256: 'review-b',
      baselineCommit: 'base',
    },
  ]
  const verification = { reportSha256: 'verify', candidateSha256: 'candidate' }
  const businessReview = { reportSha256: 'business' }

  it('leaves optional hashes empty when the caller has none', () => {
    const binding = buildAcceptanceBinding({
      plan: plan as never,
      artifacts: artifacts as never,
      verification: verification as never,
      businessReview: businessReview as never,
      candidateSha256: 'candidate',
    })
    expect(binding.artifactSha256).toBe('')
    expect(binding.baselineCommit).toBe('')
    expect(binding.testEvidenceSha256).not.toBe('')
  })

  it('keeps the artifact hash when supplied', () => {
    const binding = buildAcceptanceBinding({
      plan: plan as never,
      artifacts: artifacts as never,
      verification: verification as never,
      businessReview: businessReview as never,
      artifactSha256: 'artifact',
      candidateSha256: 'candidate',
    })
    expect(binding.artifactSha256).toBe('artifact')
    expect(binding.baselineCommit).toBe('')
  })

  it('rejects a plan task without a delivered artifact', () => {
    expect(() =>
      buildAcceptanceBinding({
        plan: { tasks: [{ taskId: 'missing' }] } as never,
        artifacts: artifacts as never,
        verification: verification as never,
        businessReview: businessReview as never,
        candidateSha256: 'candidate',
      }),
    ).toThrow('任务 missing 缺少交付产物')
  })
})

describe('session routing', () => {
  function routing(repo: Record<string, unknown>, runner: Record<string, unknown>) {
    return new SessionRouting({
      config: {} as never,
      repo: repo as never,
      now: () => '2026-11-01T00:00:00.000Z',
      runner: runner as never,
      openAgent: async () => ({}) as never,
      executionDev: {} as never,
    })
  }

  it('does not reuse a requirement when it has no bound session', () => {
    const instance = routing(
      { requirementDevSession: () => null, devSession: () => undefined },
      { run: async () => ({}) },
    )
    expect(instance.idleForRequirement('req-1', 1)).toBe(false)
  })

  it('treats a binding without a live session as busy', () => {
    const instance = routing(
      { requirementDevSession: () => ({ sessionId: 's' }), devSession: () => undefined },
      { run: async () => ({}), resume: async () => ({}) },
    )
    expect(instance.idleForRequirement('req-1', 1)).toBe(false)
  })

  it('reuses a requirement only when its bound session is idle', () => {
    const instance = routing(
      { requirementDevSession: () => ({ sessionId: 's' }), devSession: () => ({ state: 'idle' }) },
      { run: async () => ({}), resume: async () => ({}) },
    )
    expect(instance.idleForRequirement('req-1', 1)).toBe(true)
  })
})

describe('verification outcome', () => {
  it('blocks when a scenario failed even if the report verdict says pass', () => {
    const outcome = verificationVerdict({
      report: { verdict: 'pass', scenarios: [{ status: 'fail' }], blocking: [] } as never,
      failedCommands: [],
      coverageIssues: [],
      evidenceIssues: [],
      integrityIssues: [],
    })
    expect(outcome.verdict).toBe('block')
    expect(outcome.blocking).toContain('报告存在未通过的测试场景')
  })

  it('fails closed when the workspace head moved during verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-outcome-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir })
      const result = verificationIntegrity(dir, 'deadbeef')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.detail).toContain('验证期间候选提交发生变化')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verification command runner', () => {
  it('derives a fallback label for an empty command label', async () => {
    const result = await runVerificationCommands({
      reqId: 'req-1',
      dir: '/tmp',
      commands: [{ label: '', argv: ['true'] }],
      run: async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        logPath: '/tmp/log',
        logSha256: 'sha',
        durationMs: 1,
        output: '',
      }),
      setBlocked: () => undefined,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.commandRuns[0]?.label).toBe('')
      expect(result.failedCommands).toEqual([])
    }
  })

  it('records timeouts and null exit codes as failed commands', async () => {
    let index = 0
    const result = await runVerificationCommands({
      reqId: 'req-1',
      dir: '/tmp',
      commands: [
        { label: 'slow', argv: ['true'] },
        { label: 'null', argv: ['true'] },
      ],
      run: async () => {
        index += 1
        return {
          exitCode: index === 1 ? null : null,
          timedOut: index === 1,
          aborted: false,
          logPath: `/tmp/${index}.log`,
          logSha256: 'sha',
          durationMs: 1,
          output: '',
        }
      },
      setBlocked: () => undefined,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.failedCommands).toEqual(['slow 超时', 'null 退出码 null'])
    }
  })

  it('stops at an aborted command and reports it as blocked', async () => {
    const blocked: string[] = []
    const result = await runVerificationCommands({
      reqId: 'req-1',
      dir: '/tmp',
      commands: [{ label: 'stop', argv: ['true'] }],
      run: async () => ({
        exitCode: null,
        timedOut: false,
        aborted: true,
        logPath: '/tmp/log',
        logSha256: 'sha',
        durationMs: 1,
        output: '',
      }),
      setBlocked: (message) => blocked.push(message),
    })
    expect(result.ok).toBe(false)
    expect(blocked).toEqual(['独立测试命令被停止；测试工作区可丢弃，可重新验证'])
  })
})

describe('ops heartbeat edge cases', () => {
  it('reports an invalid URL without leaking it', async () => {
    const outcome = await sendOpsHeartbeat({
      url: 'not a url',
      method: 'GET',
      timeoutSeconds: 1,
      project: 'forgeloop',
      at: new Date('2026-11-01T00:00:00.000Z'),
      status: 'healthy',
      issues: 0,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('invalid-url')
  })

  it('honours a caller abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await sendOpsHeartbeat({
      url: 'http://127.0.0.1:1/ping',
      method: 'GET',
      timeoutSeconds: 5,
      project: 'forgeloop',
      at: new Date('2026-11-01T00:00:00.000Z'),
      status: 'healthy',
      issues: 0,
      signal: controller.signal,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('心跳上报失败')
  })

  it('ignores a response body that cannot be cancelled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error('cancel failed')
          },
        })
        return new Response(body, { status: 200 })
      }),
    )
    const outcome = await sendOpsHeartbeat({
      url: 'http://127.0.0.1:9/ping',
      method: 'GET',
      timeoutSeconds: 5,
      project: 'forgeloop',
      at: new Date('2026-11-01T00:00:00.000Z'),
      status: 'healthy',
      issues: 0,
    })
    expect(outcome).toEqual({ ok: true, status: 200, error: '' })
  })
})

describe('session event append fallbacks', () => {
  it('appends through a session that exposes append', () => {
    const written: Array<{ type: string; data: Record<string, unknown> }> = []
    const session = {
      append(type: string, data: Record<string, unknown>) {
        written.push({ type, data })
        return true
      },
    }
    expect(appendSessionEvent(session, 'plugin:test', { a: 1 })).toBe(true)
    expect(written).toEqual([{ type: 'plugin:test', data: { a: 1 } }])
  })

  it('reports a session without append instead of throwing', () => {
    const messages: string[] = []
    expect(
      appendSessionEvent({}, 'plugin:test', { a: 1 }, (message) => messages.push(message)),
    ).toBe(false)
    expect(messages[0]).toContain('会话没有 append 能力')
  })

  it('reports an append failure instead of throwing', () => {
    const messages: string[] = []
    const session = {
      append() {
        throw new Error('disk full')
      },
    }
    expect(
      appendSessionEvent(session, 'plugin:test', { a: 1 }, (message) => messages.push(message)),
    ).toBe(false)
    expect(messages[0]).toContain('写入会话事件 plugin:test 失败：disk full')
  })

  it('normalises non-object event data to an empty record', () => {
    const written: unknown[] = []
    const session = {
      append(_type: string, data: unknown) {
        written.push(data)
      },
    }
    expect(appendSessionEvent(session, 'plugin:test', null as never)).toBe(true)
    expect(written).toEqual([{}])
  })
})

describe('preset registration failures', () => {
  it('reports a host without a preset registry', async () => {
    const result = await registerForgeLoopPreset({})
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('宿主没有 agentPresets 服务')
  })

  it('reports a registry that rejects registration and logs the reason', async () => {
    const logged: string[] = []
    const result = await registerForgeLoopPreset(
      {
        agentPresets: {
          register: async () => {
            throw new Error('registry offline')
          },
        },
      },
      (message) => logged.push(message),
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('registry offline')
    expect(logged[0]).toContain('注册 ForgeLoop 业务会话 preset 失败：registry offline')
  })

  it('uses the default logger when registration fails without one', async () => {
    const result = await registerForgeLoopPreset({
      agentPresets: {
        register: async () => {
          throw new Error('no logger')
        },
      },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no logger')
  })

  it('returns the dispose function of a registered preset', async () => {
    let disposed = 0
    const result = await registerForgeLoopPreset({
      get: (name: string) =>
        name === 'agentPresets'
          ? {
              register: async () => async () => {
                disposed += 1
              },
            }
          : undefined,
    })
    expect(result.ok).toBe(true)
    await result.dispose?.()
    expect(disposed).toBe(1)
  })
})

describe('session surface wiring', () => {
  it('installs without a listener and reports a failed preset registration', async () => {
    const logged: string[] = []
    const surface = installSessionSurface(
      {
        agentPresets: {
          register: async () => {
            throw new Error('no preset')
          },
        },
      },
      { runtime: {} as never, config: {} as never, log: (message) => logged.push(message) },
    )
    const ready = await surface.ready
    expect(ready.ok).toBe(false)
    expect(logged.some((message) => message.includes('宿主没有 ctx.on'))).toBe(true)
    await surface.dispose()
  })

  it('uses the default console logger when no log is supplied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const surface = installSessionSurface(
      { agentPresets: { register: async () => async () => undefined } },
      { runtime: {} as never, config: {} as never },
    )
    expect((await surface.ready).ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      '[forgeloop] 宿主没有 ctx.on，无法安装 agent/pre-step 输入接管',
    )
    await surface.dispose()
    warn.mockRestore()
  })

  it('turns a thrown logger into a failed preset registration', async () => {
    const surface = installSessionSurface(
      {
        on: () => () => undefined,
        agentPresets: {
          register: async () => {
            throw new Error('rejected')
          },
        },
      },
      {
        runtime: {} as never,
        config: {} as never,
        log: () => {
          throw new Error('logger down')
        },
      },
    )
    const ready = await surface.ready
    expect(ready.ok).toBe(false)
    if (!ready.ok) expect(ready.reason).toContain('preset 注册异常：logger down')
    await surface.dispose()
  })

  it('tolerates a listener disposer that throws', async () => {
    const surface = installSessionSurface(
      {
        on: () => () => {
          throw new Error('dispose failed')
        },
        agentPresets: { register: async () => async () => undefined },
      },
      { runtime: {} as never, config: {} as never, log: () => undefined },
    )
    await surface.ready
    await expect(surface.dispose()).resolves.toBeUndefined()
  })

  it('disposes a preset that registers after the surface was already disposed', async () => {
    let release: (() => void) | undefined
    let disposed = 0
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const surface = installSessionSurface(
      {
        on: () => () => undefined,
        agentPresets: {
          register: async () => {
            await gate
            return async () => {
              disposed += 1
            }
          },
        },
      },
      { runtime: {} as never, config: {} as never, log: () => undefined },
    )
    const disposing = surface.dispose()
    release?.()
    await disposing
    expect(disposed).toBe(1)
  })

  it('uses the live composed preset and releases listeners and presets', async () => {
    let unsubscribed = 0
    let disposed = 0
    const surface = installSessionSurface(
      {
        on: () => () => {
          unsubscribed += 1
        },
        agentPresets: {
          register: async () => async () => {
            disposed += 1
          },
          composedPreset: () => 'forgeloop',
        },
      },
      { runtime: {} as never, config: {} as never },
    )
    expect((await surface.ready).ok).toBe(true)
    const decision = await surface.intake!.handlePreStep(
      {
        agent: { session: { header: { agentPreset: 'other' } }, ctx: {} },
        messages: [],
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'reject' })
    await surface.dispose()
    expect(unsubscribed).toBe(1)
    expect(disposed).toBe(1)
  })
})
