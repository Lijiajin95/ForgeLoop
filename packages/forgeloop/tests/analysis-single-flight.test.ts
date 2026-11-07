import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { BUSINESS_CONTEXT_DOC } from '../src/domain/analysis.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import { structuredSpecOf, withPromptRequirementSource } from './spec-fixture.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REQUIREMENT = '门店订单列表支持按状态筛选'

function analysisText(overrides: Record<string, unknown> = {}): string {
  return structuredSpecOf({
    goal: '门店订单列表支持按状态筛选',
    scenarios: ['店长在订单列表按状态筛选'],
    acceptance_criteria: ['筛选后只显示匹配状态的订单'],
    clarifications: [],
    ...overrides,
  })
}

interface Pending {
  readonly request: AgentRunRequest
  readonly resolve: (text: string) => void
}

/** 可外部控制的执行器：记录每次模型调用，由测试决定何时返回。 */
function controlledRunner(pending: Pending[]): AgentLike {
  return {
    run(request: AgentRunRequest): Promise<AgentRunResult> {
      return new Promise((resolve) => {
        pending.push({
          request,
          resolve: (text: string) =>
            resolve({
              status: 'completed',
              text: withPromptRequirementSource(request.prompt, text),
              sessionId: 'session-product-test',
              reason: '',
              transcriptPath: request.transcriptPath,
              durationMs: 1,
              toolCalls: [],
            }),
        })
      })
    },
  }
}

function makeRuntime(runner: AgentLike): { runtime: ForgeLoopRuntime; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-single-flight-'))
  roots.push(root)
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
  return { runtime: new ForgeLoopRuntime({ ctx: {}, config, runner }), root }
}

function submit(runtime: ForgeLoopRuntime, text = REQUIREMENT): string {
  const submitted = runtime.submit({ text, by: 'owner', source: 'test:source', analyze: false })
  expect(submitted.ok, submitted.message).toBe(true)
  return (submitted.data as { reqId: string }).reqId
}

/** 等到执行器真的收到模型调用。 */
async function waitForCall(pending: Pending[]): Promise<Pending> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const first = pending[0]
    if (first) return first
    await new Promise((done) => setTimeout(done, 1))
  }
  throw new Error('模型调用没有在预期时间内开始')
}

describe('analysis single flight', () => {
  it('starts one model call for concurrent requests of the same requirement version', async () => {
    const pending: Pending[] = []
    const { runtime } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)

    const first = runtime.analyzeRequirement(reqId)
    const second = runtime.analyzeRequirement(reqId)
    const call = await waitForCall(pending)
    expect(pending).toHaveLength(1)
    expect(call.request.transcriptPath).toContain(`${reqId}-v1-analyze-a1.jsonl`)

    call.resolve(analysisText())
    const results = await Promise.all([first, second])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(runtime.repo.analysisAttempts(reqId)).toHaveLength(1)
    expect(runtime.repo.latestAnalysis(reqId)?.goal).toBe('门店订单列表支持按状态筛选')
    runtime.close()
  })

  it('discards a late result after the requirement was revised and keeps it as audit only', async () => {
    const pending: Pending[] = []
    const { runtime, root } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)

    const running = runtime.analyzeRequirement(reqId)
    const call = await waitForCall(pending)
    const revised = runtime.revise({
      reqId,
      text: '门店订单列表支持按状态与时间筛选',
      by: 'owner',
      source: 'test:revise',
    })
    expect(revised.ok, revised.message).toBe(true)

    call.resolve(
      analysisText({
        business_context: {
          changed: true,
          document: '# 业务背景\n\n迟到的结果不应写入正式文档。\n',
          reason: '迟到的模型输出',
        },
      }),
    )
    const outcome = await running
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('analysis_stale')
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('draft')
    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ outcome: 'stale', attempt: 1 })
    expect(attempts[0]?.detail).toContain('修订')
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    runtime.close()
  })

  it('discards a late result after a stop request instead of overwriting the blocked status', async () => {
    const pending: Pending[] = []
    const { runtime } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)

    const running = runtime.analyzeRequirement(reqId)
    const call = await waitForCall(pending)
    expect(runtime.stop({ reqId, by: 'owner', reason: '不再需要' }).ok).toBe(true)

    call.resolve(analysisText())
    const outcome = await running
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('analysis_stale')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('blocked')
    expect(runtime.repo.getRequirement(reqId)?.blockedReason).toContain('停止请求')
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.analysisAttempts(reqId)[0]).toMatchObject({ outcome: 'stale' })
    runtime.close()
  })

  it('discards a late result after cancellation and never records an admission', async () => {
    const pending: Pending[] = []
    const { runtime } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)

    const running = runtime.analyzeRequirement(reqId)
    const call = await waitForCall(pending)
    expect(runtime.cancel({ reqId, by: 'owner', reason: '取消' }).ok).toBe(true)

    call.resolve(analysisText())
    const outcome = await running
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('analysis_stale')
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('cancelled')
    expect(runtime.repo.latestAnalysis(reqId)).toBeNull()
    expect(runtime.repo.admissionsFor(reqId)).toEqual([])
    runtime.close()
  })

  it('records each real attempt with its own transcript when a format retry happens', async () => {
    const pending: Pending[] = []
    const { runtime } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)

    const running = runtime.analyzeRequirement(reqId)
    const first = await waitForCall(pending)
    first.resolve('{"goal": ""}')
    // 等第一次失败收口后再重试同一版本。
    await running
    expect(runtime.repo.getRequirement(reqId)?.status).toBe('analysis_failed')

    const retry = runtime.analyzeRequirement(reqId)
    const second = await waitForCall(pending.slice(1))
    second.resolve(analysisText())
    expect((await retry).ok).toBe(true)

    const attempts = runtime.repo.analysisAttempts(reqId)
    expect(attempts).toHaveLength(2)
    const paths = attempts.map((attempt) => attempt.transcriptPath)
    expect(new Set(paths).size).toBe(2)
    expect(paths[0]).toContain(`${reqId}-v1-analyze-a1.jsonl`)
    expect(paths[1]).toContain(`${reqId}-v1-analyze-a2.jsonl`)
    runtime.close()
  })
})

describe('business context is not written for a stale result', () => {
  it('keeps the official business context untouched when the result is discarded', async () => {
    const pending: Pending[] = []
    const { runtime, root } = makeRuntime(controlledRunner(pending))
    const reqId = submit(runtime)
    const running = runtime.analyzeRequirement(reqId)
    const call = await waitForCall(pending)
    runtime.cancel({ reqId, by: 'owner', reason: '取消' })
    call.resolve(
      analysisText({
        business_context: { changed: true, document: '# 业务背景\n\n不存在。\n', reason: '迟到' },
      }),
    )
    await running
    expect(existsSync(join(root, BUSINESS_CONTEXT_DOC))).toBe(false)
    const requirement = runtime.repo.getRequirement(reqId)
    expect(requirement?.status).toBe('cancelled')
    runtime.close()
  })
})
