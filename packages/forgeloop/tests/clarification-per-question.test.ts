import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { SessionIntake } from '../src/session/intake.js'
import { resolveConfig } from '../src/config.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { structuredSpecOf, withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SESSION = 'session-clarify-per-question'

function analysisOf(overrides: Record<string, unknown> = {}): string {
  return structuredSpecOf({
    goal: '订单列表支持取消订单',
    scenarios: ['店长查看订单列表'],
    acceptance_criteria: ['取消订单按状态可见'],
    clarifications: [],
    ...overrides,
  })
}

const TWO_QUESTIONS = analysisOf({
  clarifications: ['是否包含已取消订单？', '取消订单是否按取消时间筛选？'],
})

const PARTIAL = analysisOf({
  clarification_updates: [
    { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
    { question_id: 'Q1-2', status: 'open', reason: '还没有回答时间字段' },
  ],
})

const WITH_NEW_QUESTION = analysisOf({
  clarifications: ['取消时间以哪个字段为准？'],
  clarification_updates: [
    { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
    { question_id: 'Q1-2', status: 'open', reason: '回答没有覆盖时间字段' },
  ],
})

const RESOLVE_SECOND = analysisOf({
  clarification_updates: [
    { question_id: 'Q1-2', status: 'resolved', resolution: '按取消时间筛选' },
  ],
})

const RESOLVED = analysisOf({
  clarification_updates: [
    { question_id: 'Q1-1', status: 'resolved', resolution: '包含已取消订单' },
    { question_id: 'Q1-2', status: 'resolved', resolution: '按取消时间筛选' },
  ],
})

const KEEP_OPEN = analysisOf({
  clarification_updates: [
    { question_id: 'Q1-1', status: 'open', reason: '回答还不能确定范围' },
    { question_id: 'Q1-2', status: 'open', reason: '还没有回答' },
  ],
})

const PARTIAL_Q2 = analysisOf({
  clarification_updates: [
    { question_id: 'Q1-1', status: 'open', reason: '还没有回答包含范围' },
    { question_id: 'Q1-2', status: 'resolved', resolution: '按取消时间筛选' },
  ],
})

interface Harness {
  runtime: ForgeLoopRuntime
  prompts: string[]
  responses: string[]
  root: string
}

function makeHarness(responses: readonly string[]): Harness {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-per-question-'))
  roots.push(root)
  const harness = { prompts: [], responses: [...responses] } as unknown as Harness
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
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake-model', timeoutSeconds: 30 },
    },
    root,
  )
  harness.root = root
  harness.runtime = new ForgeLoopRuntime({ ctx: {}, config, runner })
  return harness
}

function submit(
  runtime: ForgeLoopRuntime,
  messageId = 'msg-1',
  text = '订单列表支持取消订单',
): string {
  const submitted = runtime.submit({
    text,
    by: 'owner',
    source: `dsh-session:${SESSION}:${messageId}`,
    clientKey: `dsh-session:${SESSION}:${messageId}`,
    analyze: false,
  })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function human(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function fakeSession() {
  return {
    id: SESSION,
    header: { agentPreset: 'forgeloop' },
    events: [] as Array<{ type: string; data: Record<string, unknown> }>,
    append(type: string, data: Record<string, unknown>) {
      this.events.push({ type, data })
    },
  }
}

describe('per-question clarification binding', () => {
  it('binds an answer to one question and keeps the other open', async () => {
    const harness = makeHarness([TWO_QUESTIONS, PARTIAL, RESOLVE_SECOND])
    const runtime = harness.runtime
    const reqId = submit(runtime)
    await runtime.analyzeRequirement(reqId)
    expect(runtime.repo.openClarifications(reqId).map((q) => q.questionId)).toEqual([
      'Q1-1',
      'Q1-2',
    ])

    const partial = await runtime.answerClarifications({
      reqId,
      answer: '需要包含已取消订单',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-2`,
      questionIds: ['Q1-1'],
    })
    expect(partial.ok, partial.message).toBe(true)
    expect(partial.answeredQuestionIds).toEqual(['Q1-1'])

    const answers = runtime.repo.clarificationAnswers(reqId)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({
      questionId: 'Q1-1',
      answerSeq: 1,
      answer: '需要包含已取消订单',
      requirementVersion: 1,
      answeredVersion: 2,
    })
    const prompt = harness.prompts[1] ?? ''
    expect(prompt).toContain('Q1-1')
    expect(prompt).toContain('所有者回答 1')
    expect(prompt).toContain('Q1-2')
    expect(prompt).toContain('（尚无回答）')

    // 只回答一部分：另一道题仍开放，准入与状态继续阻断。
    expect(runtime.repo.openClarifications(reqId).map((q) => q.questionId)).toEqual(['Q1-2'])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')
    expect(
      runtime.repo.admissionsFor(reqId).find((row) => row.decision === 'admit'),
    ).toBeUndefined()

    const rest = await runtime.answerClarifications({
      reqId,
      answer: '按取消时间筛选',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-3`,
      questionIds: ['Q1-2'],
    })
    expect(rest.ok, rest.message).toBe(true)
    expect(runtime.repo.openClarifications(reqId)).toEqual([])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('specified')
    runtime.close()
  })

  it('keeps every answer for the same question instead of overwriting it', async () => {
    const harness = makeHarness([TWO_QUESTIONS, KEEP_OPEN, RESOLVED])
    const runtime = harness.runtime
    const reqId = submit(runtime)
    await runtime.analyzeRequirement(reqId)

    const first = await runtime.answerClarifications({
      reqId,
      answer: '先按默认时间字段',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-2`,
      questionIds: ['Q1-1'],
    })
    expect(first.ok, first.message).toBe(true)
    const second = await runtime.answerClarifications({
      reqId,
      answer: '包含已取消订单，按取消时间',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-3`,
      questionIds: ['Q1-1'],
    })
    expect(second.ok, second.message).toBe(true)

    const answers = runtime.repo
      .clarificationAnswers(reqId)
      .filter((answer) => answer.questionId === 'Q1-1')
    expect(answers.map((answer) => answer.answerSeq)).toEqual([1, 2])
    expect(answers.map((answer) => answer.answer)).toEqual([
      '先按默认时间字段',
      '包含已取消订单，按取消时间',
    ])
    const prompt = harness.prompts[2] ?? ''
    expect(prompt).toContain('所有者回答 1')
    expect(prompt).toContain('先按默认时间字段')
    expect(prompt).toContain('所有者回答 2')
    expect(prompt).toContain('包含已取消订单，按取消时间')
    runtime.close()
  })

  it('refuses a question id that is not currently open', async () => {
    const harness = makeHarness([TWO_QUESTIONS])
    const runtime = harness.runtime
    const reqId = submit(runtime)
    await runtime.analyzeRequirement(reqId)

    const outcome = await runtime.answerClarifications({
      reqId,
      answer: '需要',
      by: 'owner',
      source: 'test:unknown',
      questionIds: ['Q9-9'],
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('invalid_question')
    expect(runtime.repo.getRequirement(reqId)?.versions).toHaveLength(1)
    expect(runtime.repo.clarificationAnswers(reqId)).toEqual([])
    runtime.close()
  })

  it('answers only the explicitly targeted question from the session directive', async () => {
    const harness = makeHarness([TWO_QUESTIONS, PARTIAL_Q2, RESOLVED])
    const runtime = harness.runtime
    const reqId = submit(runtime)
    await runtime.analyzeRequirement(reqId)
    const intake = new SessionIntake({ runtime, config: runtime.config })
    const session = fakeSession()

    await intake.handlePreStep(
      {
        agent: { session },
        messages: [human('msg-target', `回答 ${reqId} [Q1-2]：按取消时间筛选`)],
        turn: 2,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    const answers = runtime.repo.clarificationAnswers(reqId)
    expect(answers.map((answer) => answer.questionId)).toEqual(['Q1-2'])
    expect(runtime.repo.openClarifications(reqId).map((q) => q.questionId)).toEqual(['Q1-1'])
    expect(session.events.map((event) => event.type)).toContain(
      'plugin:forgeloop/clarification-answer',
    )
    runtime.close()
  })

  it('keeps original unanswered questions blocking when a later analysis adds a new one', async () => {
    const harness = makeHarness([TWO_QUESTIONS, WITH_NEW_QUESTION])
    const runtime = harness.runtime
    const reqId = submit(runtime)
    await runtime.analyzeRequirement(reqId)

    const answered = await runtime.answerClarifications({
      reqId,
      answer: '需要包含已取消订单',
      by: 'owner',
      source: `dsh-session:${SESSION}:msg-2`,
      questionIds: ['Q1-1'],
    })
    expect(answered.ok, answered.message).toBe(true)

    const open = runtime.repo.openClarifications(reqId)
    expect(open.map((q) => q.questionId)).toEqual(['Q1-2', 'Q2-1'])
    const analysis = runtime.repo.latestAnalysis(reqId)!
    expect(analysis.clarifications).toEqual([
      '取消订单是否按取消时间筛选？',
      '取消时间以哪个字段为准？',
    ])
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('awaiting_clarification')
    const admission = runtime.requirementDetail(reqId).data as {
      admission: { decision?: string } | null
    }
    expect(admission.admission?.decision).not.toBe('admit')
    runtime.close()
  })
})
