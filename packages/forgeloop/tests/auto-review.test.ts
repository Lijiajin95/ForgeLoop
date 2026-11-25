import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { structuredSpecOf, withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REVIEW = JSON.stringify({
  verdict: 'pass',
  summary: '可以进入研发',
  checks: [
    { check: 'goal', status: 'pass', detail: '' },
    { check: 'acceptance', status: 'pass', detail: '' },
    { check: 'evidence', status: 'pass', detail: '' },
    { check: 'samples', status: 'pass', detail: '' },
    { check: 'quality', status: 'na', detail: '没有非功能约束' },
    { check: 'data', status: 'na', detail: '没有数据变化' },
    { check: 'assumptions', status: 'pass', detail: '' },
    { check: 'discovery', status: 'na', detail: '没有发现层材料' },
  ],
})

function analysisText(extra: Record<string, unknown> = {}): string {
  return structuredSpecOf({
    goal: '门店订单列表支持按状态筛选',
    scenarios: ['店长在订单列表按状态筛选'],
    acceptance_criteria: ['筛选后只显示匹配状态的订单'],
    clarifications: [],
    ...extra,
  })
}

function makeRuntime(
  autoAdvance: boolean,
  responses: readonly string[],
  autoReview = true,
): { runtime: ForgeLoopRuntime; calls: () => number } {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-auto-review-'))
  roots.push(root)
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 3600,
      autoAdvance,
      autoReview,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
  let index = 0
  const runner: AgentLike = {
    async run(request) {
      const text = responses[Math.min(index, responses.length - 1)] ?? ''
      index += 1
      return {
        status: 'completed',
        text: withPromptRequirementSource(request.prompt, text),
        sessionId: `session-${index}`,
        reason: '',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  return {
    runtime: new ForgeLoopRuntime({ ctx: {}, config, runner }),
    calls: () => index,
  }
}

function submit(runtime: ForgeLoopRuntime): string {
  const submitted = runtime.submit({
    text: '门店订单列表支持按状态筛选',
    by: 'owner',
    source: 'test',
    analyze: false,
  })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

describe('automatic requirement review', () => {
  it('reviews automatically after a completed analysis when advancing', async () => {
    const { runtime, calls } = makeRuntime(true, [analysisText(), REVIEW])
    try {
      const reqId = submit(runtime)
      const outcome = await runtime.analyzeRequirement(reqId)
      expect(outcome.ok, outcome.message).toBe(true)
      expect(calls()).toBe(2)
      const review = runtime.repo.latestReview(reqId)
      expect(review?.verdict).toBe('pass')
      expect(review?.reviewer).toBe('agent:auto')
    } finally {
      runtime.close()
    }
  })

  it('does not review when autoReview is off', async () => {
    const { runtime, calls } = makeRuntime(true, [analysisText()], false)
    try {
      const reqId = submit(runtime)
      const outcome = await runtime.analyzeRequirement(reqId)
      expect(outcome.ok, outcome.message).toBe(true)
      expect(calls()).toBe(1)
      expect(runtime.repo.latestReview(reqId)).toBeNull()
    } finally {
      runtime.close()
    }
  })

  it('does not review while clarifications are open', async () => {
    const { runtime, calls } = makeRuntime(true, [
      analysisText({ clarifications: ['订单状态取值需要确认'] }),
    ])
    try {
      const reqId = submit(runtime)
      const outcome = await runtime.analyzeRequirement(reqId)
      expect(outcome.ok, outcome.message).toBe(true)
      expect(calls()).toBe(1)
      expect(runtime.repo.latestReview(reqId)).toBeNull()
    } finally {
      runtime.close()
    }
  })

  it('keeps the analysis when the automatic review output is unusable', async () => {
    const { runtime } = makeRuntime(true, [analysisText(), '不是评审 JSON'])
    try {
      const reqId = submit(runtime)
      const outcome = await runtime.analyzeRequirement(reqId)
      expect(outcome.ok, outcome.message).toBe(true)
      expect(outcome.message).toContain('自动评审未完成')
      expect(runtime.repo.latestReview(reqId)).toBeNull()
      expect(runtime.repo.latestAnalysis(reqId)).not.toBeNull()
    } finally {
      runtime.close()
    }
  })

  it('leaves manual analysis unreviewed', async () => {
    const { runtime, calls } = makeRuntime(false, [analysisText()])
    try {
      const reqId = submit(runtime)
      await runtime.analyzeRequirement(reqId)
      expect(calls()).toBe(1)
      expect(runtime.repo.latestReview(reqId)).toBeNull()
    } finally {
      runtime.close()
    }
  })
})
