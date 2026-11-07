import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { SessionIntake } from '../src/session/intake.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { structuredSpecOf, withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SESSION = 'session-clarify-1'

const QUESTIONS = structuredSpecOf({
  goal: '订单列表支持取消订单',
  scenarios: ['店长查看订单列表'],
  acceptance_criteria: ['取消订单按状态可见'],
  clarifications: ['是否包含已取消订单？', '取消订单是否按取消时间筛选？'],
})

const PARTIAL = structuredSpecOf({
  goal: '订单列表支持取消订单',
  scenarios: ['店长查看订单列表'],
  acceptance_criteria: ['取消订单按状态可见'],
  clarifications: [],
  clarification_updates: [
    { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
    {
      question_id: 'Q1-2',
      status: 'open',
      reason: '回答只说明包含，没有说明按什么时间字段筛选',
    },
  ],
})

const RESOLVED = structuredSpecOf({
  goal: '订单列表支持取消订单',
  scenarios: ['店长查看订单列表'],
  acceptance_criteria: ['取消订单按状态可见，并按取消时间筛选'],
  clarifications: [],
  clarification_updates: [
    { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
    { question_id: 'Q1-2', status: 'resolved', resolution: '按取消时间筛选' },
  ],
})

const FINAL = structuredSpecOf({
  goal: '订单列表支持取消订单',
  scenarios: ['店长查看订单列表'],
  acceptance_criteria: ['取消订单按状态可见，并按取消时间筛选'],
  clarifications: [],
  clarification_updates: [
    { question_id: 'Q1-2', status: 'resolved', resolution: '按取消时间筛选' },
  ],
})

const PLAIN = structuredSpecOf({
  goal: '导出订单列表',
  scenarios: ['店长导出订单列表'],
  acceptance_criteria: ['导出文件包含当前筛选结果'],
  clarifications: [],
})

interface Harness {
  runtime: ForgeLoopRuntime
  prompts: string[]
  responses: string[]
}

function makeHarness(root: string, initial: readonly string[]): Harness {
  const harness: Harness = {
    runtime: undefined as unknown as ForgeLoopRuntime,
    prompts: [],
    responses: [...initial],
  }
  const runner: AgentLike = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      harness.prompts.push(request.prompt)
      const text = harness.responses.shift()
      if (text === undefined) throw new Error('测试响应已用尽')
      return {
        status: 'completed',
        text: withPromptRequirementSource(request.prompt, text),
        sessionId: 'session-product',
        reason: '',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  const config = resolveConfig(
    {
      project: 'testproj',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
  harness.runtime = new ForgeLoopRuntime({ ctx: {}, config, runner })
  return harness
}

function submit(runtime: ForgeLoopRuntime, text: string, messageId: string): string {
  const result = runtime.submit({
    text,
    by: 'owner',
    source: `dsh-session:${SESSION}:${messageId}`,
    clientKey: `dsh-session:${SESSION}:${messageId}`,
    analyze: false,
  })
  expect(result.ok, result.message).toBe(true)
  return (result.data as { reqId: string }).reqId
}

function human(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

describe('clarification context across re-analysis', () => {
  it('passes question text, identity, answer and prior conclusions into the next analysis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-clarify-'))
    roots.push(root)
    const harness = makeHarness(root, [QUESTIONS, PARTIAL, FINAL])
    const runtime = harness.runtime
    const reqId = submit(runtime, '订单列表支持取消订单', 'msg-1')
    await runtime.analyzeRequirement(reqId)
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')

    const answered = await runtime.answerClarifications({
      reqId,
      answer: '需要包含已取消订单',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-2`,
    })
    expect(answered.ok, answered.message).toBe(true)

    const secondPrompt = harness.prompts[1] ?? ''
    expect(secondPrompt).toContain('Q1-1')
    expect(secondPrompt).toContain('Q1-2')
    expect(secondPrompt).toContain('是否包含已取消订单？')
    expect(secondPrompt).toContain('需要包含已取消订单')
    expect(secondPrompt).toContain('仍未解决')
    // 只回答了一部分：另一个问题由程序保留，不能因为模型没有重抄就消失。
    expect(runtime.repo.latestAnalysis(reqId)?.clarifications).toEqual([
      '取消订单是否按取消时间筛选？',
    ])
    expect(runtime.repo.openClarifications(reqId).map((question) => question.questionId)).toEqual([
      'Q1-2',
    ])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')
    expect(runtime.repo.clarificationAnswers(reqId)).toMatchObject([
      { questionId: 'Q1-1', answerSeq: 1, answer: '需要包含已取消订单' },
      { questionId: 'Q1-2', answerSeq: 1, answer: '需要包含已取消订单' },
    ])

    const target = runtime.pendingClarifications(SESSION)[0]!
    expect(target.reqId).toBe(reqId)
    expect(target.questionIds).toEqual(['Q1-2'])
    const third = await runtime.answerClarifications({
      reqId,
      answer: '按取消时间筛选',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-3`,
    })
    expect(third.ok, third.message).toBe(true)
    const thirdPrompt = harness.prompts[2] ?? ''
    expect(thirdPrompt).toContain('取消订单是否按取消时间筛选？')
    expect(thirdPrompt).toContain('按取消时间筛选')
    expect(thirdPrompt).toContain('已解决')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
    expect(runtime.repo.openClarifications(reqId)).toEqual([])

    const paths = runtime.repo.analysisAttempts(reqId).map((attempt) => attempt.transcriptPath)
    expect(paths).toEqual([
      expect.stringContaining(`${reqId}-v1-analyze-a1.jsonl`),
      expect.stringContaining(`${reqId}-v2-analyze-a1.jsonl`),
      expect.stringContaining(`${reqId}-v3-analyze-a1.jsonl`),
    ])
    expect(new Set(paths).size).toBe(3)
  })

  it('fails closed when re-analysis silently drops an unresolved question', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-clarify-'))
    roots.push(root)
    const harness = makeHarness(root, [QUESTIONS, PLAIN, PLAIN])
    const runtime = harness.runtime
    const reqId = submit(runtime, '订单列表支持取消订单', 'msg-1')
    await runtime.analyzeRequirement(reqId)

    const outcome = await runtime.answerClarifications({
      reqId,
      answer: '需要',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-2`,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('遗漏了未解决问题')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')
    // 回答与问题都保留，重试时仍能回查。
    expect(runtime.repo.clarificationAnswers(reqId)).toHaveLength(2)
    expect(runtime.repo.openClarifications(reqId)).toHaveLength(2)
  })
})

describe('intake routing with pending clarifications', () => {
  it('submits an explicitly marked new requirement instead of folding it into the answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-clarify-'))
    roots.push(root)
    const harness = makeHarness(root, [QUESTIONS, PLAIN])
    const runtime = harness.runtime
    const first = submit(runtime, '订单列表支持取消订单', 'msg-1')
    await runtime.analyzeRequirement(first)

    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = {
      id: SESSION,
      header: { agentPreset: 'forgeloop' },
      events: [] as Array<{ type: string; data: Record<string, unknown> }>,
      append(type: string, data: Record<string, unknown>) {
        this.events.push({ type, data })
      },
    }
    await intake.handlePreStep(
      {
        agent: { session },
        messages: [human('msg-new', '新需求：导出订单列表')],
        turn: 2,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    const requirements = runtime.repo.listRequirements('testproj')
    expect(requirements).toHaveLength(2)
    expect(requirements.find((item) => item.reqId === first)?.status).toBe('awaiting_clarification')
    expect(requirements.find((item) => item.reqId === first)?.versions).toHaveLength(1)
    expect(requirements.find((item) => item.reqId !== first)?.versions[0]?.text).toBe(
      '导出订单列表',
    )
    expect(runtime.pendingClarifications(SESSION)).toHaveLength(1)
    expect(session.events.map((event) => event.type)).toContain('plugin:forgeloop/intake')
  })

  it('answers an explicitly targeted pending requirement when several are waiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-clarify-'))
    roots.push(root)
    const harness = makeHarness(root, [QUESTIONS, QUESTIONS, RESOLVED])
    const runtime = harness.runtime
    const first = submit(runtime, '订单列表支持取消订单', 'msg-1')
    await runtime.analyzeRequirement(first)
    const second = submit(runtime, '订单列表支持退款', 'msg-2')
    await runtime.analyzeRequirement(second)
    expect(runtime.pendingClarifications(SESSION)).toHaveLength(2)

    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = {
      id: SESSION,
      header: { agentPreset: 'forgeloop' },
      events: [] as Array<{ type: string; data: Record<string, unknown> }>,
      append(type: string, data: Record<string, unknown>) {
        this.events.push({ type, data })
      },
    }
    await intake.handlePreStep(
      {
        agent: { session },
        messages: [human('msg-3', `回答 ${first}：需要，按取消时间筛选`)],
        turn: 3,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(runtime.repo.getRequirement(first)?.status).toBe('specified')
    expect(runtime.repo.getRequirement(second)?.status).toBe('awaiting_clarification')
    expect(runtime.repo.getRequirement(second)?.versions).toHaveLength(1)
    expect(runtime.pendingClarifications(SESSION).map((item) => item.reqId)).toEqual([second])
    expect(session.events.map((event) => event.type)).toContain(
      'plugin:forgeloop/clarification-answer',
    )
  })

  it('does not guess ownership when several are pending and no target is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeloop-clarify-'))
    roots.push(root)
    const harness = makeHarness(root, [QUESTIONS, QUESTIONS])
    const runtime = harness.runtime
    const first = submit(runtime, '订单列表支持取消订单', 'msg-1')
    await runtime.analyzeRequirement(first)
    const second = submit(runtime, '订单列表支持退款', 'msg-2')
    await runtime.analyzeRequirement(second)

    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = {
      id: SESSION,
      header: { agentPreset: 'forgeloop' },
      events: [] as Array<{ type: string; data: Record<string, unknown> }>,
      append(type: string, data: Record<string, unknown>) {
        this.events.push({ type, data })
      },
    }
    await intake.handlePreStep(
      { agent: { session }, messages: [human('msg-3', '需要')], turn: 3 },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(runtime.repo.listRequirements('testproj')).toHaveLength(2)
    expect(session.events.at(-1)?.type).toBe('plugin:forgeloop/error')
    expect(String(session.events.at(-1)?.data.message)).toContain('回答 <需求编号>')
  })
})
