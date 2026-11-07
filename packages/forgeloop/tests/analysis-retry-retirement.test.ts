import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  runtime: ForgeLoopRuntime
  prompts: string[]
  responses: string[]
}

function makeHarness(responses: readonly string[]): Harness {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-retry-'))
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
      agent: { provider: 'fake', model: 'fake-model', timeoutSeconds: 30 },
    },
    root,
  )
  harness.runtime = new ForgeLoopRuntime({ ctx: {}, config, runner })
  return harness
}

function submit(runtime: ForgeLoopRuntime, text: string): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test:source', analyze: false })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

function point(id: string, behavior: string): Record<string, unknown> {
  return {
    id,
    basis: 'user_requirement',
    source: '（由夹具按提示词原文覆盖）',
    actor: '店长',
    trigger: '打开列表时',
    behavior,
    rules: [],
    exceptions: { status: 'not_applicable', items: [], reason: '无' },
  }
}

function acceptance(id: string, pointIds: string[]): Record<string, unknown> {
  return { id, point_ids: pointIds, given: '有数据', when: '操作', then: '可观察结果' }
}

function analysis(points: Array<[string, string]>, criteria: Array<[string, string[]]>): string {
  return JSON.stringify({
    input_kind: 'requirement',
    goal: '门店订单列表',
    scenarios: ['店长操作'],
    business_points: points.map(([id, behavior]) => point(id, behavior)),
    acceptance_criteria: criteria.map(([id, ids]) => acceptance(id, ids)),
    assumptions: [],
    conflicts: [],
    clarifications: [],
  })
}

describe('format retry', () => {
  it('carries the first validation error into the retry and records both attempts', async () => {
    const harness = makeHarness(['{"goal":""}', '{"goal":""}'])
    const runtime = harness.runtime
    const reqId = submit(runtime, '门店订单列表支持按状态筛选')
    const outcome = await runtime.analyzeRequirement(reqId)
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('analysis_failed')
    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts).toHaveLength(2)
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'failed'])
    expect(attempts[0]?.detail).toContain('校验未通过，准备重试')
    expect(harness.prompts[1]).toContain('上一次尝试未通过程序校验')
    expect(harness.prompts[1]).toContain('分析缺少非空目标')
    expect(new Set(attempts.map((attempt) => attempt.transcriptPath)).size).toBe(2)
    runtime.close()
  })
})

describe('retired spec ids', () => {
  it('never reuses a business point id that a historical analysis already used', async () => {
    const harness = makeHarness([
      analysis(
        [
          ['BP-1', '按状态筛选'],
          ['BP-2', '导出列表'],
        ],
        [
          ['AC-1', ['BP-1']],
          ['AC-2', ['BP-2']],
        ],
      ),
      analysis([['BP-1', '按状态筛选']], [['AC-1', ['BP-1']]]),
      analysis(
        [
          ['BP-1', '按状态筛选'],
          ['BP-2', '恢复已退役的导出能力'],
        ],
        [
          ['AC-1', ['BP-1']],
          ['AC-2', ['BP-2']],
        ],
      ),
      analysis(
        [
          ['BP-1', '按状态筛选'],
          ['BP-2', '恢复已退役的导出能力'],
        ],
        [
          ['AC-1', ['BP-1']],
          ['AC-2', ['BP-2']],
        ],
      ),
      analysis(
        [
          ['BP-1', '按状态筛选'],
          ['BP-3', '新增导出能力'],
        ],
        [
          ['AC-1', ['BP-1']],
          ['AC-3', ['BP-3']],
        ],
      ),
    ])
    const runtime = harness.runtime
    const reqId = submit(runtime, '第一版：门店订单列表')
    expect((await runtime.analyzeRequirement(reqId)).ok).toBe(true)
    expect(
      runtime.revise({ reqId, text: '第二版：只保留筛选', by: 'owner', source: 'test' }).ok,
    ).toBe(true)
    expect((await runtime.analyzeRequirement(reqId)).ok).toBe(true)
    expect(
      runtime.revise({ reqId, text: '第三版：重新加入导出', by: 'owner', source: 'test' }).ok,
    ).toBe(true)

    const rejected = await runtime.analyzeRequirement(reqId)
    expect(rejected.ok).toBe(false)
    expect(rejected.message).toContain('退役后不能复用')
    expect(runtime.repo.latestAnalysis(reqId)?.requirementVersion).toBe(2)

    const accepted = await runtime.analyzeRequirement(reqId)
    expect(accepted.ok, accepted.message).toBe(true)
    expect(runtime.repo.latestAnalysis(reqId)?.businessPoints?.map((item) => item.id)).toEqual([
      'BP-1',
      'BP-3',
    ])
    runtime.close()
  })
})

describe('revision invalidation', () => {
  it('records that the old analysis is stale and no longer drives admission', async () => {
    const harness = makeHarness([analysis([['BP-1', '按状态筛选']], [['AC-1', ['BP-1']]])])
    const runtime = harness.runtime
    const reqId = submit(runtime, '门店订单列表支持按状态筛选')
    const analyzed = await runtime.analyzeRequirement(reqId)
    expect(analyzed.ok, analyzed.message).toBe(true)
    const before = runtime.requirementDetail(reqId).data as { analysisInvalidations: unknown[] }
    expect(before.analysisInvalidations).toEqual([])

    expect(
      runtime.revise({
        reqId,
        text: '门店订单列表支持按状态和时间筛选',
        by: 'owner',
        source: 'test',
      }).ok,
    ).toBe(true)
    const detail = runtime.requirementDetail(reqId).data as {
      analysisInvalidations: Array<{
        analysisVersion: number
        fromRequirementVersion: number
        toRequirementVersion: number
        reason: string
      }>
      admission: { decision?: string } | null
      status: string
    }
    expect(detail.analysisInvalidations).toMatchObject([
      {
        analysisVersion: 1,
        fromRequirementVersion: 1,
        toRequirementVersion: 2,
        reason: '需求修订：旧分析基于 v1',
      },
    ])
    expect(runtime.repo.analyses(reqId)).toHaveLength(1)
    expect(detail.status).toBe('draft')
    expect(detail.admission?.decision).not.toBe('admit')
    runtime.close()
  })
})
