import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ForgeLoopRuntime, type AgentLike } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { parseReviewDraft } from '../src/domain/review.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const PASSING = JSON.stringify({
  verdict: 'pass',
  summary: '可以直接进入研发',
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

function makeRuntime(reviewText: string): { runtime: ForgeLoopRuntime; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-review-'))
  roots.push(root)
  const config = resolveConfig(
    {
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 3600,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
    },
    root,
  )
  const runner: AgentLike = {
    async run(request) {
      return {
        status: 'completed',
        text: reviewText,
        sessionId: 'session-review',
        reason: '',
        transcriptPath: request.transcriptPath,
        durationMs: 1,
        toolCalls: [],
      }
    },
  }
  return { runtime: new ForgeLoopRuntime({ ctx: {}, config, runner }), root }
}

function seed(runtime: ForgeLoopRuntime): string {
  const submitted = runtime.submit({
    text: '门店订单列表支持按状态筛选',
    by: 'owner',
    source: 'test',
    analyze: false,
  })
  expect(submitted.ok, submitted.message).toBe(true)
  const reqId = (submitted.data as { reqId: string }).reqId
  runtime.repo.recordAnalysis(
    {
      reqId,
      analysisVersion: 1,
      requirementVersion: 1,
      inputKind: 'requirement',
      goal: '订单筛选',
      scenarios: [],
      businessRules: [],
      exceptions: [],
      nonGoals: [],
      acceptanceCriteria: [],
      businessPoints: [],
      acceptanceItems: [],
      assumptions: [],
      conflicts: [],
      references: [],
      uiMap: [],
      samples: [],
      quality: [],
      data: [],
      opportunities: [],
      solutions: [],
      clarifications: [],
      model: 'fake',
      promptVersion: 'analysis-v9',
      transcriptPath: '',
      toolCalls: [],
      createdAt: runtime.config ? new Date().toISOString() : '',
    },
    { questions: [], updates: [] },
  )
  return reqId
}

describe('requirement review', () => {
  it('parses a complete checklist and rejects incomplete or inconsistent ones', () => {
    expect(parseReviewDraft(PASSING).verdict).toBe('pass')
    expect(() =>
      parseReviewDraft(
        JSON.stringify({
          verdict: 'pass',
          summary: '缺项',
          checks: [{ check: 'goal', status: 'pass', detail: '' }],
        }),
      ),
    ).toThrow('缺少检查项')
    expect(() =>
      parseReviewDraft(
        JSON.stringify({
          verdict: 'pass',
          summary: '未知项',
          checks: [{ check: 'unknown', status: 'pass', detail: '' }],
        }),
      ),
    ).toThrow('check 必须是')
    expect(() =>
      parseReviewDraft(
        JSON.stringify({
          verdict: 'pass',
          summary: '重复项',
          checks: [
            { check: 'goal', status: 'pass', detail: '' },
            { check: 'goal', status: 'pass', detail: '' },
          ],
        }),
      ),
    ).toThrow('重复')
    expect(() =>
      parseReviewDraft(
        JSON.stringify({
          verdict: 'pass',
          summary: '矛盾',
          checks: JSON.parse(PASSING).checks.map((check: { check: string }) =>
            check.check === 'goal' ? { ...check, status: 'fail', detail: '目标不清' } : check,
          ),
        }),
      ),
    ).toThrow('不能有 fail')
    expect(() =>
      parseReviewDraft(
        JSON.stringify({
          verdict: 'fail',
          summary: '失败',
          checks: JSON.parse(PASSING).checks.map((check: { check: string }) =>
            check.check === 'goal' ? { ...check, status: 'fail', detail: '' } : check,
          ),
        }),
      ),
    ).toThrow('必须说明理由')
  })

  it('records a passing review bound to the analysis version', async () => {
    const { runtime } = makeRuntime(PASSING)
    try {
      const reqId = seed(runtime)
      const outcome = await runtime.reviewRequirement({ reqId, by: 'reviewer' })
      expect(outcome.ok, outcome.message).toBe(true)
      const review = runtime.repo.latestReview(reqId)
      expect(review?.verdict).toBe('pass')
      expect(review?.analysisVersion).toBe(1)
      expect(review?.reviewer).toBe('agent:reviewer')
      expect(review?.checks).toHaveLength(8)
      expect(runtime.repo.nextReviewVersion(reqId)).toBe(2)
    } finally {
      runtime.close()
    }
  })

  it('rejects a malformed review output and does not record it', async () => {
    const { runtime } = makeRuntime('{"verdict":"maybe"}')
    try {
      const reqId = seed(runtime)
      const outcome = await runtime.reviewRequirement({ reqId, by: 'reviewer' })
      expect(outcome.ok).toBe(false)
      expect(outcome.code).toBe('review_invalid')
      expect(runtime.repo.latestReview(reqId)).toBeNull()
    } finally {
      runtime.close()
    }
  })

  it('refuses to review a requirement whose analysis is stale', async () => {
    const { runtime } = makeRuntime(PASSING)
    try {
      const reqId = seed(runtime)
      runtime.revise({ reqId, text: '第二版需求', by: 'owner', source: 'test' })
      const outcome = await runtime.reviewRequirement({ reqId, by: 'reviewer' })
      expect(outcome.ok).toBe(false)
      expect(outcome.code).toBe('analysis_stale')
    } finally {
      runtime.close()
    }
  })

  it('round-trips reviews through the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-review-store-'))
    const database = Database.open(join(dir, 'records.sqlite'))
    try {
      const repository = new Repository(database)
      repository.recordReview({
        reqId: 'req-1',
        reviewVersion: 1,
        analysisVersion: 2,
        reviewer: 'agent:reviewer',
        verdict: 'fail',
        summary: '样例缺失',
        checks: [{ check: 'samples', status: 'fail', detail: '缺少反例' }],
        promptVersion: 'review-v1',
        createdAt: '2026-11-24T00:00:00.000Z',
      })
      const latest = repository.latestReview('req-1')
      expect(latest?.verdict).toBe('fail')
      expect(latest?.checks[0]?.detail).toBe('缺少反例')
      expect(repository.nextReviewVersion('req-1')).toBe(2)
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
