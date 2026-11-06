import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import {
  ANALYSIS_FAILED,
  AWAITING_CLARIFICATION,
  CANCELLED,
  SPECIFIED,
} from '../src/domain/status.js'
import {
  ANALYSIS_PROMPT_VERSION,
  BUSINESS_CONTEXT_DOC,
  MAX_AUTO_ANALYSIS_RETRIES,
  PRODUCT_TOOL_ALLOWLIST,
} from '../src/domain/analysis.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { SessionIntake } from '../src/session/intake.js'
import { structuredSpecOf } from './spec-fixture.js'

const SOURCE = 'dsh-session:sess-1:msg-1'
const BUSINESS = '# 业务背景\n\n行业：本地生活服务；业务目标：门店订单处理。\n'

const ANALYSIS = structuredSpecOf({
  goal: '门店按状态处理订单',
  scenarios: ['店长在订单列表按状态筛选'],
  business_rules: ['只有店长可以批量取消订单'],
  exceptions: ['支付回调延迟时订单保持待确认'],
  non_goals: ['不改造支付渠道'],
  acceptance_criteria: ['筛选后只显示匹配状态的订单'],
  clarifications: [],
})

const CLARIFY = structuredSpecOf({
  goal: '门店按状态处理订单',
  scenarios: ['店长在订单列表按状态筛选'],
  acceptance_criteria: ['筛选后只显示匹配状态的订单'],
  clarifications: ['退款是否需要店长二次确认？'],
})

const ANSWERED = structuredSpecOf({
  goal: '门店按状态处理订单',
  scenarios: ['店长在订单列表按状态筛选'],
  acceptance_criteria: ['筛选后只显示匹配状态的订单'],
  clarifications: [],
  clarification_updates: [
    {
      question_id: 'Q1-1',
      status: 'resolved',
      resolution: '退款需要店长二次确认',
    },
  ],
})

const PROBLEM = JSON.stringify({
  input_kind: 'problem',
  goal: '看板刷新后筛选条件丢失',
  scenarios: ['在需求页选择“进行中”后刷新，筛选回到“全部”'],
  acceptance_criteria: ['刷新后仍按当前筛选条件展示'],
  clarifications: [],
})

const PROBLEM_CLARIFY = JSON.stringify({
  input_kind: 'problem',
  goal: '看板刷新后筛选条件丢失',
  acceptance_criteria: ['刷新后仍按当前筛选条件展示'],
  clarifications: ['怎么复现？'],
})

const NEW_BUSINESS =
  '# 业务背景\n\n行业：本地生活服务；业务目标：门店订单处理。\n\n## 更新记录\n\n- 2026-11-02：补充门店结算术语。\n'

function analysisWithBusiness(document: string): string {
  return structuredSpecOf({
    goal: '门店按状态处理订单',
    scenarios: ['店长在订单列表按状态筛选'],
    business_rules: ['只有店长可以批量取消订单'],
    exceptions: ['支付回调延迟时订单保持待确认'],
    non_goals: ['不改造支付渠道'],
    acceptance_criteria: ['筛选后只显示匹配状态的订单'],
    clarifications: [],
    business_context: { changed: true, document, reason: '测试样本背景更新' },
  })
}

interface Script {
  status: 'completed' | 'error'
  text: string
  reason: string
  toolCalls: string[]
}

function script(text: string, overrides: Partial<Script> = {}): Script {
  return { status: 'completed', text, reason: '', toolCalls: [], ...overrides }
}

let project = ''
let runtime: ForgeLoopRuntime
let requests: AgentRunRequest[] = []
let next: Script

function runner(): AgentLike {
  return {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      requests.push(request)
      return {
        status: next.status,
        text: next.text,
        sessionId: 'session-fake-product',
        reason: next.reason,
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: next.toolCalls,
      }
    },
  }
}

function makeRuntime(options: { autoAdvance?: boolean } = {}): ForgeLoopRuntime {
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      autoAdvance: options.autoAdvance ?? true,
      agent: { provider: 'fake', model: 'fake-model', timeoutSeconds: 30 },
    },
    project,
  )
  return new ForgeLoopRuntime({ ctx: {}, config, runner: runner() })
}

function submit(text = '门店按状态处理订单'): string {
  const submitted = runtime.submit({ text, by: 'owner', source: SOURCE, analyze: false })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

/** 领取并执行当前排队的一条分析请求，模拟协调器的一次处理。 */
async function drain(reqId: string) {
  const now = new Date().toISOString()
  const claimed = runtime.repo.claimNextRequest('test-owner', now)
  expect(claimed, '应当有一条排队请求').not.toBeNull()
  expect(claimed!.reqId).toBe(reqId)
  expect(claimed!.action).toBe('analyze')
  const outcome = await runtime.executeRequest(claimed!, new AbortController().signal)
  runtime.repo.resolveRequest(claimed!.requestId, outcome.state, outcome.detail, now)
  return outcome
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'forgeloop-product-analysis-'))
  mkdirSync(join(project, 'docs/forgeloop'), { recursive: true })
  writeFileSync(join(project, BUSINESS_CONTEXT_DOC), BUSINESS)
  requests = []
  next = script(ANALYSIS, {
    toolCalls: ['forgeloop_web_search', 'forgeloop_write_project_doc'],
  })
  runtime = makeRuntime()
})

afterEach(() => {
  runtime.close()
  rmSync(project, { recursive: true, force: true })
})

describe('product analysis run', () => {
  it('runs the product Agent once per requirement version with docs and web tools only', async () => {
    const reqId = submit()
    const first = await runtime.analyzeRequirement(reqId)
    expect(first.ok, first.message).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      role: 'product',
      cwd: project,
      permission: 'workspace-write',
      tools: 'default',
      allowTools: PRODUCT_TOOL_ALLOWLIST,
    })
    expect(requests[0]!.prompt).toContain('行业：本地生活服务')
    expect(requests[0]!.prompt).toContain('禁止修改代码')

    // 再执行一次同一个需求版本：直接复用已有结论，不再调用模型。
    const again = await runtime.analyzeRequirement(reqId)
    expect(again.ok).toBe(true)
    expect(again.message).toContain('未重复调用模型')
    expect(requests).toHaveLength(1)
    expect(runtime.repo.analyses(reqId)).toHaveLength(1)
    expect(runtime.repo.analysisAttempts(reqId)).toHaveLength(1)
  })

  it('records model, prompt version, transcript and tool calls for every analysis', async () => {
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)

    const analysis = runtime.repo.latestAnalysis(reqId)!
    expect(analysis).toMatchObject({
      goal: '门店按状态处理订单',
      businessRules: ['只有店长可以批量取消订单'],
      exceptions: ['支付回调延迟时订单保持待确认'],
      nonGoals: ['不改造支付渠道'],
      model: 'fake-model',
      promptVersion: ANALYSIS_PROMPT_VERSION,
      toolCalls: ['forgeloop_web_search', 'forgeloop_write_project_doc'],
    })
    expect(analysis.transcriptPath).toContain(`${reqId}-v1-analyze-a1.jsonl`)

    const [attempt] = runtime.repo.analysisAttempts(reqId)
    expect(attempt).toMatchObject({
      attempt: 1,
      kind: 'initial',
      outcome: 'done',
      model: 'fake-model',
      promptVersion: ANALYSIS_PROMPT_VERSION,
      transcriptPath: analysis.transcriptPath,
      toolCalls: ['forgeloop_web_search', 'forgeloop_write_project_doc'],
    })
  })

  it('triages a problem and hands it straight to the development queue', async () => {
    next = script(PROBLEM)
    const reqId = submit('看板刷新后筛选条件丢失')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(runtime.repo.latestAnalysis(reqId)?.inputKind).toBe('problem')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(SPECIFIED)
    // 问题不等待产品澄清：分析通过后直接进入研发队列。
    const queued = runtime.analysisQueue.enqueue(reqId)
    expect(queued.ok, queued.message).toBe(true)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(reqId)
  })

  it('fails a problem triage that asks for product clarification instead of handing it to dev', async () => {
    next = script(PROBLEM_CLARIFY)
    const reqId = submit('看板刷新后筛选条件丢失')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(ANALYSIS_FAILED)
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.analysisAttempts(reqId).at(-1)?.detail).toContain('待澄清')
  })

  it('writes the business context document from the analysis result, not from a tool call', async () => {
    next = script(analysisWithBusiness(NEW_BUSINESS))
    const reqId = submit()
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok, outcome.message).toBe(true)
    expect(readFileSync(join(project, BUSINESS_CONTEXT_DOC), 'utf8')).toBe(NEW_BUSINESS)
    expect(runtime.repo.latestAnalysis(reqId)).not.toBeNull()
  })

  it('fails the analysis when the business context document cannot be written', async () => {
    // 超过 128 KiB 上限：写入失败必须让整次分析失败，而不是悄悄保留旧文档。
    next = script(analysisWithBusiness(`# 业务背景\n\n${'x'.repeat(128 * 1024)}`))
    const reqId = submit()
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(ANALYSIS_FAILED)
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    const [attempt] = runtime.repo.analysisAttempts(reqId)
    expect(attempt).toMatchObject({ kind: 'initial', outcome: 'failed' })
    expect(attempt!.detail).toContain('业务背景文档同步失败')
    expect(readFileSync(join(project, BUSINESS_CONTEXT_DOC), 'utf8')).toBe(BUSINESS)
  })

  it('does not queue a second analysis for a requirement that already has one', async () => {
    const submitted = runtime.submit({ text: '门店按状态处理订单', by: 'owner', source: SOURCE })
    const reqId = (submitted.data as { reqId: string }).reqId
    expect(runtime.repo.pendingRequests('demo').map((request) => request.action)).toEqual([
      'analyze',
    ])
    // 会话入口式的同步分析先落库；队列里那条分析请求执行时不再调用模型。
    await runtime.analyzeRequirement(reqId)
    const outcome = await drain(reqId)
    expect(outcome.state).toBe('done')
    expect(outcome.detail).toContain('未重复调用模型')
    expect(requests).toHaveLength(1)
    expect(runtime.repo.analyses(reqId)).toHaveLength(1)
  })
})

describe('product analysis failure and retry', () => {
  it('enters analysis_failed with the failure kept as an attempt', async () => {
    next = script('', { status: 'error', reason: '模型超时' })
    const reqId = submit()
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(ANALYSIS_FAILED)
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    const [attempt] = runtime.repo.analysisAttempts(reqId)
    expect(attempt).toMatchObject({ kind: 'initial', outcome: 'failed' })
    expect(attempt!.detail).toContain('模型超时')

    // 失败需求给出重新分析的入口，而不是让页面自己猜。
    const view = runtime.statusBoard().requirements.find((item) => item.reqId === reqId)
    expect(view?.actions).toContain('retry-analysis')
  })

  it('stops automatic retries after three attempts and keeps every transcript', async () => {
    next = script('', { status: 'error', reason: '模型超时' })
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)

    for (let attempt = 0; attempt < MAX_AUTO_ANALYSIS_RETRIES; attempt += 1) {
      expect(runtime.analysisQueue.autoRetry()).toEqual([reqId])
      const outcome = await drain(reqId)
      expect(outcome.state).toBe('failed')
      expect(runtime.repo.getRequirement(reqId)?.status).toBe(ANALYSIS_FAILED)
    }
    expect(runtime.analysisQueue.autoRetry()).toEqual([])
    expect(runtime.repo.pendingRequests('demo')).toEqual([])

    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts.map((attempt) => attempt.kind)).toEqual(['initial', 'auto', 'auto', 'auto'])
    expect(attempts.every((attempt) => attempt.outcome === 'failed')).toBe(true)
    expect(new Set(attempts.map((attempt) => attempt.transcriptPath)).size).toBe(4)
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4])
  })

  it('retries nothing while a failure is still being processed', async () => {
    next = script('', { status: 'error', reason: '模型超时' })
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)
    expect(runtime.analysisQueue.autoRetry()).toEqual([reqId])
    // 已有一条待处理的分析请求：不叠加第二次重试。
    expect(runtime.analysisQueue.autoRetry()).toEqual([])
    expect(runtime.repo.pendingRequests('demo')).toHaveLength(1)
  })

  it('queues a manual retry after automatic retries are exhausted, without resetting attempts', async () => {
    next = script('', { status: 'error', reason: '模型超时' })
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)
    for (let attempt = 0; attempt < MAX_AUTO_ANALYSIS_RETRIES; attempt += 1) {
      runtime.analysisQueue.autoRetry()
      await drain(reqId)
    }
    expect(runtime.analysisQueue.autoRetry()).toEqual([])

    const queued = runtime.analysisQueue.retry({
      reqId,
      by: 'owner',
      source: 'web-decision:sess-1',
    })
    expect(queued.ok, queued.message).toBe(true)
    expect(runtime.repo.pendingRequests('demo').map((request) => request.source)).toEqual([
      'web-decision:sess-1:analysis-retry',
    ])

    next = script(ANALYSIS)
    const outcome = await drain(reqId)
    expect(outcome.state, outcome.detail).toBe('done')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(SPECIFIED)
    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts).toHaveLength(5)
    expect(attempts.at(-1)).toMatchObject({ attempt: 5, kind: 'manual', outcome: 'done' })
  })

  it('refuses a manual retry unless the analysis failed', async () => {
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)
    const refused = runtime.analysisQueue.retry({
      reqId,
      by: 'owner',
      source: 'web-decision:sess-1',
    })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('not_failed')
    expect(
      runtime.analysisQueue.retry({ reqId: 'req-missing', by: 'owner', source: 'x' }).code,
    ).toBe('not_found')
  })
})

describe('requirement enqueue after the first analysis', () => {
  it('refuses a missing or terminal requirement without queuing anything', () => {
    expect(runtime.analysisQueue.enqueue('req-missing')).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    const reqId = submit()
    runtime.repo.setStatus(reqId, CANCELLED, '测试取消')
    expect(runtime.analysisQueue.enqueue(reqId)).toMatchObject({ ok: false, code: 'terminal' })
    expect(
      runtime.analysisQueue.retry({ reqId, by: 'owner', source: 'web-decision:sess-1' }),
    ).toMatchObject({ ok: false, code: 'terminal' })
    expect(runtime.repo.pendingRequests('demo')).toEqual([])
  })

  it('refuses to enqueue without a current analysis or with open clarifications', async () => {
    const reqId = submit()
    expect(runtime.analysisQueue.enqueue(reqId).code).toBe('analysis_missing')

    next = script(CLARIFY)
    await runtime.analyzeRequirement(reqId)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(AWAITING_CLARIFICATION)
    const refused = runtime.analysisQueue.enqueue(reqId)
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('clarification_required')
  })

  it('keeps first-attempt transcripts separate for each requirement version', async () => {
    next = script(CLARIFY)
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)

    next = script(ANSWERED)
    const answered = await runtime.answerClarifications({
      reqId,
      answer: '退款需要店长二次确认',
      by: 'owner',
      source: 'dsh-session:sess-1:msg-2',
    })
    expect(answered.ok, answered.message).toBe(true)

    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts.map((attempt) => attempt.requirementVersion)).toEqual([1, 2])
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 1])
    const paths = attempts.map((attempt) => attempt.transcriptPath)
    expect(paths[0]).toContain(`${reqId}-v1-analyze-a1.jsonl`)
    expect(paths[1]).toContain(`${reqId}-v2-analyze-a1.jsonl`)
    expect(new Set(paths).size).toBe(2)
  })

  it('enqueues once the clarification is answered and does not queue a second analysis', async () => {
    next = script(CLARIFY)
    const reqId = submit()
    await runtime.analyzeRequirement(reqId)

    next = script(ANSWERED)
    const answered = await runtime.answerClarifications({
      reqId,
      answer: '退款需要店长二次确认',
      by: 'owner',
      source: 'dsh-session:sess-1:msg-2',
    })
    expect(answered.ok, answered.message).toBe(true)

    const enqueued = runtime.analysisQueue.enqueue(reqId)
    expect(enqueued.ok, enqueued.message).toBe(true)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(reqId)
    expect(
      runtime.repo.pendingRequests('demo').filter((request) => request.action === 'analyze'),
    ).toEqual([])
    expect(runtime.repo.analyses(reqId)).toHaveLength(2)
  })
})

describe('session intake analysis', () => {
  class FakeSession {
    readonly id = 'sess-1'
    readonly header = { agentPreset: 'forgeloop' }
    readonly events: Array<{ type: string; data: Record<string, unknown> }> = []
    readonly append = (type: string, data: Record<string, unknown>) => {
      this.events.push({ type, data })
    }
  }

  it('analyses once before queueing, then hands the requirement to the dev slot', async () => {
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    const decision = await intake.handlePreStep(
      {
        agent: { session },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: '门店按状态处理订单' }],
            source: { kind: 'user' },
          },
        ],
        turn: 1,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision).toEqual({ kind: 'reject' })
    expect(requests).toHaveLength(1)

    const analysisEvent = session.events.find((event) => event.type === 'plugin:forgeloop/analysis')
    expect(analysisEvent?.data).toMatchObject({
      inputKind: 'requirement',
      businessRules: ['只有店长可以批量取消订单'],
      exceptions: ['支付回调延迟时订单保持待确认'],
      nonGoals: ['不改造支付渠道'],
      model: 'fake-model',
      promptVersion: ANALYSIS_PROMPT_VERSION,
      toolCalls: ['forgeloop_web_search', 'forgeloop_write_project_doc'],
    })
    const reqId = String(analysisEvent?.data.reqId)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(SPECIFIED)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(reqId)
    expect(
      runtime.repo.pendingRequests('demo').filter((request) => request.action === 'analyze'),
    ).toEqual([])
  })

  it('marks a problem input in the session event and never asks the owner to clarify', async () => {
    next = script(PROBLEM)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = new FakeSession()
    await intake.handlePreStep(
      {
        agent: { session },
        messages: [
          {
            id: 'msg-2',
            role: 'user',
            content: [{ type: 'text', text: '看板刷新后筛选条件丢失' }],
            source: { kind: 'user' },
          },
        ],
        turn: 1,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(session.events.map((event) => event.type)).toEqual([
      'plugin:forgeloop/intake',
      'plugin:forgeloop/analysis',
    ])
    const analysisEvent = session.events.find((event) => event.type === 'plugin:forgeloop/analysis')
    expect(analysisEvent?.data).toMatchObject({
      inputKind: 'problem',
      goal: '看板刷新后筛选条件丢失',
      acceptanceCriteria: ['刷新后仍按当前筛选条件展示'],
      clarifications: [],
    })
    const reqId = String(analysisEvent?.data.reqId)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe(SPECIFIED)
    expect(runtime.requirementQueue.inFlight()?.requirementId).toBe(reqId)
  })
})
