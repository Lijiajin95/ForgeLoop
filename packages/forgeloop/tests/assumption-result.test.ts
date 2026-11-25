import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeLoopRuntime } from '../src/runtime/service.js'
import { resolveConfig } from '../src/config.js'
import { assertAssumptionResult } from '../src/domain/assumption-result.js'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRuntime(): ForgeLoopRuntime {
  const root = mkdtempSync(join(tmpdir(), 'forgeloop-assumption-'))
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
  return new ForgeLoopRuntime({ ctx: {}, config })
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
      assumptions: [
        {
          id: 'AS-1',
          statement: '店长愿意用筛选替代手工查找',
          basis: 'inference',
          source: '历史工单',
          impact: '价值不足',
          needsConfirmation: false,
          category: 'desirability',
          testMethod: '访谈 5 位店长',
          successThreshold: '至少 4 人选择新流程',
        },
      ],
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
      createdAt: new Date().toISOString(),
    },
    { questions: [], updates: [] },
  )
  return reqId
}

describe('assumption results', () => {
  it('validates id, status and evidence before recording', () => {
    expect(() =>
      assertAssumptionResult({
        assumptionId: 'AS-1',
        status: 'validated',
        evidence: '访谈记录 3 条',
      }),
    ).not.toThrow()
    expect(() =>
      assertAssumptionResult({ assumptionId: 'as1', status: 'validated', evidence: '证据' }),
    ).toThrow('AS-1')
    expect(() =>
      assertAssumptionResult({ assumptionId: 'AS-1', status: 'unknown', evidence: '证据' }),
    ).toThrow('validated 或 invalidated')
    expect(() =>
      assertAssumptionResult({ assumptionId: 'AS-1', status: 'validated', evidence: '无' }),
    ).toThrow('证据说明')
  })

  it('records a result bound to the latest analysis and overwrites on re-record', () => {
    const runtime = makeRuntime()
    try {
      const reqId = seed(runtime)
      const first = runtime.recordAssumptionResult({
        reqId,
        assumptionId: 'AS-1',
        status: 'validated',
        evidence: '访谈 5 位店长，4 人选择新流程',
        by: 'owner',
      })
      expect(first.ok, first.message).toBe(true)
      const second = runtime.recordAssumptionResult({
        reqId,
        assumptionId: 'AS-1',
        status: 'invalidated',
        evidence: '灰度一周后取消率上升 20%',
        by: 'owner',
      })
      expect(second.ok, second.message).toBe(true)
      const results = runtime.repo.assumptionResults(reqId)
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        assumptionId: 'AS-1',
        status: 'invalidated',
        analysisVersion: 1,
      })
    } finally {
      runtime.close()
    }
  })

  it('rejects unknown assumptions and stale analyses', () => {
    const runtime = makeRuntime()
    try {
      const reqId = seed(runtime)
      const unknown = runtime.recordAssumptionResult({
        reqId,
        assumptionId: 'AS-9',
        status: 'validated',
        evidence: '访谈记录',
        by: 'owner',
      })
      expect(unknown.ok).toBe(false)
      expect(unknown.code).toBe('not_found')
      runtime.revise({ reqId, text: '第二版', by: 'owner', source: 'test' })
      const stale = runtime.recordAssumptionResult({
        reqId,
        assumptionId: 'AS-1',
        status: 'validated',
        evidence: '访谈记录',
        by: 'owner',
      })
      expect(stale.ok).toBe(false)
      expect(stale.code).toBe('analysis_stale')
    } finally {
      runtime.close()
    }
  })

  it('round-trips results through the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forgeloop-assumption-store-'))
    const database = Database.open(join(dir, 'records.sqlite'))
    try {
      const repository = new Repository(database)
      repository.recordAssumptionResult({
        reqId: 'req-1',
        analysisVersion: 2,
        assumptionId: 'AS-1',
        status: 'validated',
        evidence: '访谈记录',
        recordedBy: 'owner',
        createdAt: '2026-11-25T00:00:00.000Z',
      })
      expect(repository.assumptionResults('req-1')[0]).toMatchObject({
        status: 'validated',
        evidence: '访谈记录',
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
