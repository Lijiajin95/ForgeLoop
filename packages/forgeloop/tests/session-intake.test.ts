import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { SessionIntake, isForgeLoopSession } from '../src/session/intake.js'
import { installSessionSurface } from '../src/session/index.js'
import { appendSessionEvent } from '../src/session/events.js'
import { presetRegistryOf, registerForgeLoopPreset } from '../src/session/preset.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function configFor(root: string) {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
}

function runtimeWithQueue(
  root: string,
  responses: readonly string[],
  status: 'completed' | 'error' = 'completed',
) {
  let index = 0
  let lastAnalysis = { scenarios: ['按状态筛选需求与任务'], acceptanceCriteria: ['筛选后只显示匹配项'] }
  const planReviewFor = (analysis: typeof lastAnalysis) => {
    const items: Array<{ scenario: string; acceptance_criterion: string; method: string; required: boolean }> = []
    const seen = new Set<string>()
    const add = (scenario: string, criterion: string) => {
      if (!scenario || seen.has(scenario)) return
      seen.add(scenario)
      items.push({
        scenario,
        acceptance_criterion: criterion || scenario,
        method: '在独立候选上执行该场景并保留证据',
        required: true,
      })
    }
    for (const [position, scenario] of analysis.scenarios.entries()) {
      add(scenario, analysis.acceptanceCriteria[position] ?? analysis.acceptanceCriteria[0] ?? scenario)
    }
    for (const criterion of analysis.acceptanceCriteria) {
      add(`${criterion}（验收标准）`, criterion)
    }
    if (items.length === 0) add('按验收标准执行', '按验收标准执行')
    return JSON.stringify({
      verdict: 'pass',
      blocking: [],
      findings: [],
      summary: '任务包可进入实现',
      verification_plan: items,
    })
  }
  const runner: AgentLike = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      let text: string
      if (request.role === 'verify-plan') {
        text = planReviewFor(lastAnalysis)
      } else if (request.role === 'plan') {
        text = planText
      } else {
        text = responses[Math.min(index, responses.length - 1)] ?? ''
        index += 1
        if (request.role === 'analyze') {
          try {
            const draft = JSON.parse(text) as { scenarios?: string[]; acceptance_criteria?: string[] }
            lastAnalysis = {
              scenarios: Array.isArray(draft.scenarios) ? draft.scenarios : lastAnalysis.scenarios,
              acceptanceCriteria: Array.isArray(draft.acceptance_criteria)
                ? draft.acceptance_criteria
                : lastAnalysis.acceptanceCriteria,
            }
          } catch {
            // 分析本身畸形时沿用默认场景，让测试关注输入接管而不是评审夹具。
          }
        }
      }
      return {
        status,
        text,
        sessionId: 'session-requirement-agent',
        reason: status === 'completed' ? '' : 'fake failure',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  return new ForgeLoopRuntime({ ctx: {}, config: configFor(root), runner, now: () => new Date('2026-10-28T10:00:00.000Z') })
}

function runtimeFor(root: string, text: string, status: 'completed' | 'error' = 'completed') {
  return runtimeWithQueue(root, [text], status)
}

class FakeSession {
  readonly id = 'session-forgeloop-1'
  readonly header: Record<string, unknown>
  readonly events: Array<{ type: string; data: Record<string, unknown> }> = []
  readonly append = vi.fn((type: string, data: Record<string, unknown>) => {
    this.events.push({ type, data })
  })
  constructor(header: Record<string, unknown> = { agentPreset: 'forgeloop' }) {
    this.header = header
  }
}

function human(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

const analysisText = JSON.stringify({
  goal: '看板支持按状态过滤',
  scenarios: ['按状态筛选需求与任务'],
  acceptance_criteria: ['筛选后只显示匹配项'],
  clarifications: [],
})

const planText = JSON.stringify({
  technical_solution: {
    summary: '在现有 ForgeLoop 插件内增加过滤视图和查询参数',
    approach: ['先定义过滤参数与状态枚举', '再实现视图和测试'],
    risks: ['不要改变现有需求列表的默认行为'],
  },
  tasks: [
    {
      task_id: 'ui',
      goal: '增加过滤控件',
      files: ['docs/architecture.md'],
      acceptance: '控件可选择状态并更新列表',
      test_command: ['npm', 'run', 'check', '--workspace', 'forgeloop-dsh'],
      depends_on: [],
    },
    {
      task_id: 'test',
      goal: '补充过滤行为测试',
      files: ['docs/status.md'],
      acceptance: '测试覆盖过滤结果',
      test_command: ['npm', 'run', 'check', '--workspace', 'forgeloop-dsh'],
      depends_on: ['ui'],
    },
  ],
})

function makeIntake(root: string, text = analysisText, status: 'completed' | 'error' = 'completed') {
  const runtime = runtimeFor(root, text, status)
  const intake = new SessionIntake({ runtime, config: runtime.config })
  return { runtime, intake }
}

describe('ForgeLoop session input takeover', () => {
  it('takes human input in a forgeloop session, persists a requirement and shows the analysis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    const decision = await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-1', '给看板加状态过滤')], turn: 1 },
      next,
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
      'plugin:forgeloop/plan',
    ])
    const intakeEvent = session.events[0]!.data as Record<string, unknown>
    expect(intakeEvent).toMatchObject({
      reqId: expect.stringMatching(/^req-/),
      text: '给看板加状态过滤',
      sessionId: 'session-forgeloop-1',
      messageId: 'msg-1',
      status: 'accepted',
    })
    const analysisEvent = session.events[1]!.data as Record<string, unknown>
    expect(analysisEvent).toMatchObject({
      reqId: intakeEvent.reqId,
      goal: '看板支持按状态过滤',
      scenarios: ['按状态筛选需求与任务'],
      acceptanceCriteria: ['筛选后只显示匹配项'],
      clarifications: [],
    })

    expect(session.events[2]!.data).toMatchObject({
      technicalSolution: { summary: '在现有 ForgeLoop 插件内增加过滤视图和查询参数' },
      tasks: [{ taskId: 'ui' }, { taskId: 'test', dependsOn: ['ui'] }],
    })
    const requirement = runtime.repo.getRequirement(String(intakeEvent.reqId))
    expect(requirement?.versions[0]?.text).toBe('给看板加状态过滤')
    expect(requirement?.status).toBe('plan_proposed')
    expect(runtime.repo.latestAnalysis(String(intakeEvent.reqId))?.goal).toBe('看板支持按状态过滤')
    runtime.close()
  })

  it('does not take over ordinary sessions or subagent sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const ordinary = new FakeSession({})
    const subagent = new FakeSession({ agentPreset: 'forgeloop', origin: 'subagent' })
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    expect(await intake.handlePreStep({ agent: { session: ordinary }, messages: [human('m', '普通对话')], turn: 1 }, next)).toEqual({
      kind: 'enter',
      messages: [],
    })
    expect(await intake.handlePreStep({ agent: { session: subagent }, messages: [human('m2', '子 Agent')], turn: 1 }, next)).toEqual({
      kind: 'enter',
      messages: [],
    })
    expect(next).toHaveBeenCalledTimes(2)
    expect(ordinary.events).toEqual([])
    expect(subagent.events).toEqual([])
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })

  it('rejects synthetic context without treating it as a customer requirement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    const decision = await intake.handlePreStep(
      {
        agent: { session },
        messages: [{ id: 'ctx-1', role: 'user', content: [{ type: 'text', text: '系统上下文' }], source: { kind: 'runtime-context' } }],
        turn: 1,
      },
      next,
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(session.events).toEqual([])
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })

  it('is idempotent for the same session message and does not create two requirements', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    const payload = { agent: { session }, messages: [human('msg-same', '同一条输入')], turn: 1 }

    await intake.handlePreStep(payload, next)
    await intake.handlePreStep(payload, next)

    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)
    expect(session.events.filter((event) => event.type === 'plugin:forgeloop/intake')).toHaveLength(1)
    runtime.close()
  })

  it('shows an explicit error event when the requirement Agent fails, and still rejects normal chat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root, analysisText, 'error')
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    const decision = await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-fail', '会失败的需求')], turn: 1 },
      next,
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/intake', 'plugin:forgeloop/error'])
    expect((session.events[1]!.data as Record<string, unknown>).message).toContain('fake failure')
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)
    runtime.close()
  })
})

describe('session preset registration', () => {
  it('registers the forgeloop preset and installs the pre-step listener', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, analysisText)
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const disposed: string[] = []
    const registrations: Array<Record<string, unknown>> = []
    const ctx = {
      agentPresets: {
        register: async (definition: Record<string, unknown>) => {
          registrations.push(definition)
          return async () => {
            disposed.push('preset')
          }
        },
      },
      on: (event: string, handler: typeof listener) => {
        expect(event).toBe('agent/pre-step')
        listener = handler
        return () => disposed.push('listener')
      },
    }

    const surface = installSessionSurface(ctx as never, { runtime, config: runtime.config, log: () => undefined })
    const ready = await surface.ready
    expect(ready.ok).toBe(true)
    expect(registrations).toEqual([
      expect.objectContaining({ id: 'forgeloop', name: 'ForgeLoop 业务会话', plugins: [] }),
    ])
    expect(typeof listener).toBe('function')

    const session = new FakeSession()
    await expect(
      listener!(
        { agent: { session }, messages: [human('m-listener', '通过监听器进入')], turn: 1 },
        async () => ({ kind: 'enter', messages: [] }),
      ),
    ).resolves.toEqual({ kind: 'reject' })
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(1)

    await surface.dispose()
    expect(disposed.sort()).toEqual(['listener', 'preset'])
    runtime.close()
  })
})

describe('session event helper', () => {
  it('fails closed when a session cannot append and reports the reason', () => {
    const log = vi.fn()
    expect(appendSessionEvent({}, 'plugin:forgeloop/intake', {}, log)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('没有 append'))

    const broken = {
      append() {
        throw new Error('append rejected')
      },
    }
    expect(appendSessionEvent(broken, 'plugin:forgeloop/intake', {}, log)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('append rejected'))

    const append = vi.fn()
    expect(appendSessionEvent({ append }, 'plugin:forgeloop/intake', { a: 1 })).toBe(true)
    expect(append).toHaveBeenCalledWith('plugin:forgeloop/intake', { a: 1 })
  })
})

describe('session preset registration', () => {
  it('reports a missing registry and a failed registration without throwing', async () => {
    const log = vi.fn()
    expect(await registerForgeLoopPreset({}, log)).toMatchObject({ ok: false })

    const failed = {
      agentPresets: {
        register: async () => {
          throw new Error('duplicate preset')
        },
      },
    }
    expect(await registerForgeLoopPreset(failed, log)).toMatchObject({
      ok: false,
      reason: 'duplicate preset',
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate preset'))
  })

  it('reads the registry through ctx.get and registers a successful definition', async () => {
    const registry = { register: vi.fn(async () => async () => undefined) }
    const ctx = { get: (name: string) => (name === 'agentPresets' ? registry : undefined) }
    expect(presetRegistryOf(ctx)).toBe(registry)
    const result = await registerForgeLoopPreset(ctx)
    expect(result.ok).toBe(true)
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'forgeloop', name: 'ForgeLoop 业务会话', plugins: [] }),
    )
    expect(await result.dispose?.()).toBeUndefined()
  })
})

describe('session surface fallback paths', () => {
  it('does not install a listener when the host has no ctx.on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, analysisText)
    const surface = installSessionSurface({}, { runtime, config: runtime.config, log: () => undefined })
    expect(await surface.ready).toMatchObject({ ok: false })
    await surface.dispose()
    runtime.close()
  })

  it('tolerates a listener registration that returns no disposer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, analysisText)
    const ctx = {
      on: () => undefined,
      agentPresets: { register: async () => async () => undefined },
    }
    const surface = installSessionSurface(ctx as never, { runtime, config: runtime.config, log: () => undefined })
    expect((await surface.ready).ok).toBe(true)
    await surface.dispose()
    runtime.close()
  })
})

describe('session intake failure paths', () => {
  it('writes an error event for empty text and never creates a requirement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    await intake.handlePreStep(
      { agent: { session }, messages: [human('empty-msg', '')], turn: 1 },
      next,
    )
    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/error'])
    expect(runtime.repo.listRequirements('testproj')).toEqual([])
    runtime.close()
  })

  it('writes an error event when submit throws or when the requirement has no identity', async () => {
    const throwingRuntime = {
      pendingClarifications: () => [],
      submit: () => {
        throw new Error('submit failed')
      },
      analyzeRequirement: async () => {
        throw new Error('never called')
      },
    }
    const throwingIntake = new SessionIntake({
      runtime: throwingRuntime as never,
      config: { owner: 'owner' } as never,
    })
    const throwingSession = new FakeSession()
    await throwingIntake.handlePreStep(
      { agent: { session: throwingSession }, messages: [human('m-throw', '内容')], turn: 1 },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )
    expect(throwingSession.events.map((event) => event.type)).toEqual(['plugin:forgeloop/error'])
    expect((throwingSession.events[0]!.data as Record<string, unknown>).message).toContain('submit failed')

    const noIdRuntime = {
      pendingClarifications: () => [],
      submit: () => ({ ok: true, code: 'ok', message: '', data: {} }),
      analyzeRequirement: async () => {
        throw new Error('never called')
      },
    }
    const noIdIntake = new SessionIntake({ runtime: noIdRuntime as never, config: { owner: 'owner' } as never })
    const noIdSession = new FakeSession()
    await noIdIntake.handlePreStep(
      { agent: { session: noIdSession }, messages: [human('m-noid', '内容')], turn: 1 },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )
    expect((noIdSession.events[0]!.data as Record<string, unknown>).message).toContain('没有返回身份')
  })

  it('writes an error event when the requirement Agent throws', async () => {
    const runtime = {
      pendingClarifications: () => [],
      submit: () => ({ ok: true, code: 'ok', message: '', data: { reqId: 'req-throw' } }),
      analyzeRequirement: async () => {
        throw new Error('agent crashed')
      },
    }
    const intake = new SessionIntake({ runtime: runtime as never, config: { owner: 'owner' } as never })
    const session = new FakeSession()
    await intake.handlePreStep(
      { agent: { session }, messages: [human('m-agent-throw', '内容')], turn: 1 },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )
    expect(session.events.map((event) => event.type)).toEqual(['plugin:forgeloop/intake', 'plugin:forgeloop/error'])
    expect((session.events[1]!.data as Record<string, unknown>).message).toContain('agent crashed')
  })

  it('falls back to a deterministic message id and ignores malformed sessions', () => {
    expect(isForgeLoopSession(undefined)).toBe(false)
    expect(isForgeLoopSession({ session: { header: undefined } })).toBe(false)
    expect(isForgeLoopSession({ session: { header: { agentPreset: 'forgeloop', parentSession: 'parent' } } })).toBe(false)
  })

  it('uses the live preset selection rather than the session creation header', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const { runtime, intake } = makeIntake(root)
    const session = new FakeSession({ agentPreset: 'standard' })
    const selected = new SessionIntake({
      runtime,
      config: runtime.config,
      presetOf: () => 'forgeloop',
    })
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    expect(
      await selected.handlePreStep(
        { agent: { session, ctx: {} }, messages: [human('switched', '切换后输入')], turn: 1 },
        next,
      ),
    ).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
      'plugin:forgeloop/plan',
    ])

    const standard = new SessionIntake({ runtime, config: runtime.config, presetOf: () => 'standard' })
    const nextStandard = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    expect(
      await standard.handlePreStep(
        { agent: { session: new FakeSession({ agentPreset: 'forgeloop' }), ctx: {} }, messages: [human('m2', 'x')], turn: 1 },
        nextStandard,
      ),
    ).toEqual({ kind: 'enter', messages: [] })
    expect(nextStandard).toHaveBeenCalledTimes(1)
    runtime.close()
  })
})

const clarificationAnalysis = JSON.stringify({
  goal: '增加状态过滤',
  scenarios: ['按状态筛选需求'],
  acceptance_criteria: ['筛选后只显示匹配状态'],
  clarifications: ['状态字段有哪些？', '是否支持多选？'],
})

const answeredAnalysis = JSON.stringify({
  goal: '增加状态过滤',
  scenarios: ['按状态筛选需求'],
  acceptance_criteria: ['筛选后只显示匹配状态'],
  clarifications: [],
})

describe('clarification loop', () => {
  it('turns the next human message into an answer instead of a new requirement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeWithQueue(root, [clarificationAnalysis, answeredAnalysis])
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    await intake.handlePreStep(
      { agent: { session }, messages: [human('first', '给看板加状态过滤')], turn: 1 },
      next,
    )
    const firstReq = runtime.repo.listRequirements('testproj')[0]!
    expect(firstReq.status).toBe('awaiting_clarification')
    expect(runtime.pendingClarifications('session-forgeloop-1')).toHaveLength(1)

    await intake.handlePreStep(
      {
        agent: { session },
        messages: [human('answer-1', '状态值有 draft/approved；默认单选')],
        turn: 2,
      },
      next,
    )

    const requirements = runtime.repo.listRequirements('testproj')
    expect(requirements).toHaveLength(1)
    expect(requirements[0]!.reqId).toBe(firstReq.reqId)
    expect(requirements[0]!.versions).toHaveLength(2)
    expect(requirements[0]!.versions[1]!.text).toContain('澄清回答')
    expect(requirements[0]!.status).toBe('plan_proposed')
    expect(runtime.pendingClarifications('session-forgeloop-1')).toEqual([])
    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
      'plugin:forgeloop/clarification-request',
      'plugin:forgeloop/clarification-answer',
      'plugin:forgeloop/analysis',
      'plugin:forgeloop/plan',
    ])
    expect((session.events[3]!.data as Record<string, unknown>).answer).toContain('draft/approved')
    runtime.close()
  })

  it('does not create a new requirement when multiple clarifications are pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeWithQueue(root, [clarificationAnalysis, clarificationAnalysis, answeredAnalysis])
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))

    for (const [index, reqId] of ['req-one', 'req-two'].entries()) {
      runtime.submit({
        text: `第 ${index + 1} 个需求`,
        by: 'owner',
        source: `dsh-session:session-forgeloop-1:msg-${index}`,
        clientKey: `dsh-session:session-forgeloop-1:msg-${index}`,
      })
      await runtime.analyzeRequirement(reqId === 'req-one' ? runtime.repo.listRequirements('testproj')[0]!.reqId : runtime.repo.listRequirements('testproj')[1]!.reqId)
    }
    expect(runtime.pendingClarifications('session-forgeloop-1')).toHaveLength(2)

    await intake.handlePreStep({ agent: { session }, messages: [human('three', '随便回答')], turn: 3 }, next)
    expect(runtime.repo.listRequirements('testproj')).toHaveLength(2)
    expect(session.events.at(-1)!.type).toBe('plugin:forgeloop/error')
    expect((session.events.at(-1)!.data as Record<string, unknown>).message).toContain('2 条需求等待澄清')
    runtime.close()
  })
})

describe('session requirement summary', () => {
  it('returns only requirements from the addressed session, newest first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeWithQueue(root, [answeredAnalysis])
    const first = runtime.submit({
      text: '本会话需求',
      by: 'owner',
      source: 'dsh-session:session-a:msg-1',
      clientKey: 'dsh-session:session-a:msg-1',
    })
    const firstView = first.data as { reqId: string }
    await runtime.analyzeRequirement(firstView.reqId)
    runtime.submit({
      text: '别的会话需求',
      by: 'owner',
      source: 'dsh-session:session-b:msg-2',
      clientKey: 'dsh-session:session-b:msg-2',
    })

    const summary = runtime.sessionSummary('session-a')
    expect(summary.requirements.map((item) => item.reqId)).toEqual([firstView.reqId])
    expect(summary.requirements[0]).toMatchObject({
      goal: '增加状态过滤',
      clarifications: [],
    })
    expect(runtime.sessionSummary('session-missing').requirements).toEqual([])
    runtime.close()
  })
})

describe('clarification guard paths', () => {
  it('rejects missing requirements, empty answers and requirements without pending clarifications', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, answeredAnalysis)
    const base = { by: 'owner', source: 'test' }

    await expect(runtime.answerClarifications({ ...base, reqId: 'missing', answer: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    })

    const submitted = runtime.submit({ text: '没有澄清', by: 'owner', source: 'test' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await expect(runtime.answerClarifications({ ...base, reqId, answer: '  ' })).resolves.toMatchObject({
      ok: false,
      code: 'empty_answer',
    })
    await expect(runtime.answerClarifications({ ...base, reqId, answer: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'no_clarification',
    })
    await runtime.analyzeRequirement(reqId)
    await expect(runtime.answerClarifications({ ...base, reqId, answer: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'no_clarification',
    })
    expect(runtime.pendingClarifications('other-session')).toEqual([])
    runtime.close()
  })

  it('ignores a stale analysis when the requirement has a newer version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, clarificationAnalysis)
    const submitted = runtime.submit({ text: '待澄清需求', by: 'owner', source: 'dsh-session:s:1' })
    const reqId = (submitted.data as { reqId: string }).reqId
    await runtime.analyzeRequirement(reqId)
    expect(runtime.pendingClarifications('s')).toHaveLength(1)
    runtime.revise({ reqId, text: '待澄清需求（新版本）', by: 'owner', source: 'test' })
    expect(runtime.pendingClarifications('s')).toEqual([])
    await expect(
      runtime.answerClarifications({ reqId, answer: 'x', by: 'owner', source: 'test' }),
    ).resolves.toMatchObject({ ok: false, code: 'no_clarification' })
    runtime.close()
  })

  it('summarizes requirements that have no analysis yet with an empty goal', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-intake-'))
    roots.push(root)
    const runtime = runtimeFor(root, answeredAnalysis)
    runtime.submit({ text: '未分析需求', by: 'owner', source: 'dsh-session:s:9' })
    const summary = runtime.sessionSummary('s')
    expect(summary.requirements).toHaveLength(1)
    expect(summary.requirements[0]).toMatchObject({ goal: '', scenarios: [], acceptanceCriteria: [], clarifications: [] })
    runtime.close()
  })
})
