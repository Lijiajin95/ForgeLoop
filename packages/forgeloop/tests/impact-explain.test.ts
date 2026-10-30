import { describe, expect, it } from 'vitest'
import {
  explainImpact,
  explainImpactFacts,
  INFERENCE_DISCLAIMER,
  INFERENCE_NOT_REQUESTED_NOTICE,
  type ImpactExplainAgentRequest,
  type ImpactExplainAgentResponse,
  type ImpactFactsLike,
} from '../src/domain/impact-explain.js'
import * as impactExplainModule from '../src/domain/impact-explain.js'

interface FakeFacts extends ImpactFactsLike {
  readonly kind: 'facts'
  readonly reqId: string
  readonly latestRequirementVersion: number
  readonly requirementVersions: readonly {
    readonly version: number
    readonly createdAt: string
    readonly revisedBy: string
    readonly latest: boolean
  }[]
  readonly analyses: readonly {
    readonly analysisVersion: number
    readonly requirementVersion: number
    readonly stale: boolean
  }[]
  readonly summary: { readonly gaps: number; readonly pendingItems: number }
}

function facts(): FakeFacts {
  return {
    kind: 'facts',
    reqId: 'req-impact-explain-1',
    latestRequirementVersion: 2,
    requirementVersions: [
      {
        version: 1,
        createdAt: '2026-10-22T00:00:00.000Z',
        revisedBy: 'owner',
        latest: false,
      },
      {
        version: 2,
        createdAt: '2026-10-22T00:10:00.000Z',
        revisedBy: 'owner-revise',
        latest: true,
      },
    ],
    analyses: [
      { analysisVersion: 1, requirementVersion: 1, stale: true },
      { analysisVersion: 2, requirementVersion: 2, stale: false },
    ],
    summary: { gaps: 1, pendingItems: 2 },
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

interface RecordingAgent {
  readonly calls: ImpactExplainAgentRequest[]
  readonly agent: { run(request: ImpactExplainAgentRequest): Promise<ImpactExplainAgentResponse> }
}

function recordingAgent(response: ImpactExplainAgentResponse | Error): RecordingAgent {
  const calls: ImpactExplainAgentRequest[] = []
  return {
    calls,
    agent: {
      async run(request) {
        calls.push(request)
        if (response instanceof Error) throw response
        return response
      },
    },
  }
}

describe('impact explanation without --explain', () => {
  it('makes zero Agent calls and states that inference was not requested', async () => {
    const input = facts()
    const recorder = recordingAgent({
      status: 'completed',
      text: '这条推断不应被调用',
    })

    const result = await explainImpactFacts(input, { agent: recorder.agent })

    expect(recorder.calls).toEqual([])
    expect(result.explainRequested).toBe(false)
    expect(result.inference).toBeNull()
    expect(result.notice).toBe(INFERENCE_NOT_REQUESTED_NOTICE)
    expect(result.notice).toContain('未请求推断')
    expect(result.facts).toBe(input)
    expect(result.sections.map((section) => section.kind)).toEqual(['facts'])
    expect(result.sections[0]).toMatchObject({
      kind: 'facts',
      provenance: 'deterministic',
      facts: input,
    })
  })

  it('treats an explicit false as not requested and never touches the Agent', async () => {
    const recorder = recordingAgent({ status: 'completed', text: 'unused' })

    const result = await explainImpact({ ...facts(), reqId: 'req-false' }, {
      explain: false,
      agent: recorder.agent,
    })

    expect(recorder.calls).toEqual([])
    expect(result.reqId).toBe('req-false')
    expect(result.inference).toBeNull()
    expect(result.notice).toContain('未调用任何模型')
  })
})

describe('impact explanation with --explain', () => {
  it('calls the Agent once with tools disabled and separates facts from inference', async () => {
    const input = facts()
    const recorder = recordingAgent({
      status: 'completed',
      text: '分析 v1 已过期，建议优先重新分析；任务包 v1 可能返工。',
      sessionId: 'session-impact-1',
      toolCalls: [],
    })

    const result = await explainImpactFacts(input, {
      explain: true,
      agent: recorder.agent,
    })

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]).toMatchObject({ role: 'product', tools: 'none' })
    expect(recorder.calls[0]?.prompt).toContain(input.reqId)
    expect(recorder.calls[0]?.prompt).toContain('确定性事实 JSON')
    expect(recorder.calls[0]?.prompt).toContain('"latestRequirementVersion":2')

    expect(result.explainRequested).toBe(true)
    expect(result.facts).toBe(input)
    expect(result.inference).not.toBeNull()
    expect(result.inference).toMatchObject({
      kind: 'inference',
      provenance: 'model-inference',
      inference: true,
      status: 'completed',
      sessionId: 'session-impact-1',
      disclaimer: INFERENCE_DISCLAIMER,
    })
    expect(result.inference?.label).toContain('推断')
    expect(result.inference?.title).toContain('推断')
    expect(result.inference?.text).toContain('分析 v1 已过期')
    expect(result.notice).toContain('已请求推断')
    expect(result.notice).toContain(INFERENCE_DISCLAIMER)
    expect(result.sections.map((section) => section.kind)).toEqual(['facts', 'inference'])
    expect(result.sections[0]).toMatchObject({ kind: 'facts', facts: input })
    expect(result.sections[1]).toMatchObject({
      kind: 'inference',
      inference: true,
      provenance: 'model-inference',
    })
  })

  it('never lets model output rewrite the deterministic facts', async () => {
    const input = deepFreeze(facts())
    const snapshot = structuredClone(input)
    const recorder = recordingAgent({
      status: 'completed',
      text: '事实已改写：需求只有 v1，且批准已通过。',
    })

    const result = await explainImpactFacts(input, {
      explain: true,
      agent: recorder.agent,
    })

    expect(result.facts).toBe(input)
    expect(result.facts).toEqual(snapshot)
    expect(result.sections[0]).toMatchObject({ kind: 'facts', facts: input })
    expect(result.facts.requirementVersions.map((version) => version.version)).toEqual([1, 2])
    expect(result.facts.analyses[0]?.stale).toBe(true)
    expect(result.inference?.text).toContain('事实已改写')
    expect(result.inference?.provenance).toBe('model-inference')
  })

  it('preserves facts and reports a failed Agent response as declined inference', async () => {
    const input = facts()
    const recorder = recordingAgent({
      status: 'timeout',
      text: '',
      reason: 'Agent 回合超时',
    })

    const result = await explainImpactFacts(input, { explain: true, agent: recorder.agent })

    expect(result.facts).toBe(input)
    expect(result.inference).toMatchObject({ status: 'timeout', reason: 'Agent 回合超时' })
    expect(result.notice).toContain('结果不可用')
    expect(result.notice).toContain('确定事实保持不变')
  })

  it('rejects inference when the Agent reports tool calls', async () => {
    const recorder = recordingAgent({
      status: 'completed',
      text: 'inferred text',
      toolCalls: ['forgeloop_approve'],
    })

    const result = await explainImpactFacts(facts(), { explain: true, agent: recorder.agent })

    expect(result.inference?.status).toBe('error')
    expect(result.inference?.reason).toContain('违反无工具约束')
    expect(result.inference?.toolCalls).toEqual(['forgeloop_approve'])
    expect(result.notice).toContain('结果不可用')
  })

  it('turns a thrown Agent error into an inference failure without changing facts', async () => {
    const input = facts()
    const recorder = recordingAgent(new Error('model unavailable'))

    const result = await explainImpactFacts(input, { explain: true, agent: recorder.agent })

    expect(result.facts).toBe(input)
    expect(result.inference?.status).toBe('error')
    expect(result.inference?.reason).toContain('model unavailable')
    expect(result.sections.map((section) => section.kind)).toEqual(['facts', 'inference'])
  })

  it('returns an unavailable inference section when no Agent is configured', async () => {
    const input = facts()

    const result = await explainImpactFacts(input, { explain: true })

    expect(result.facts).toBe(input)
    expect(result.inference?.status).toBe('unavailable')
    expect(result.inference?.reason).toContain('未调用任何模型')
    expect(result.notice).toContain('结果不可用')
  })
})

describe('impact explanation module is read-only', () => {
  it('exposes no approve, advance, accept or record operation', () => {
    const exported = Object.keys(impactExplainModule)
    expect(exported).toContain('explainImpactFacts')
    for (const name of exported) {
      expect(name).not.toMatch(/approve|advance|accept|record|write|persist|save/i)
    }
    expect(typeof impactExplainModule.explainImpactFacts).toBe('function')
    expect(typeof impactExplainModule.explainImpact).toBe('function')
  })

  it('does not mutate deeply frozen facts on either path', async () => {
    const input = deepFreeze(facts())

    await expect(explainImpactFacts(input)).resolves.toMatchObject({ facts: input })
    await expect(
      explainImpactFacts(input, {
        explain: true,
        agent: recordingAgent({ status: 'completed', text: 'ok' }).agent,
      }),
    ).resolves.toMatchObject({ facts: input })
    expect(input).toEqual(facts())
  })
})