import { describe, expect, it } from 'vitest'
import {
  KEY_COVERAGE_THRESHOLDS,
  RELIABILITY_WINDOWS,
  RELIABILITY_WINDOW_DAYS,
  SNAPSHOT_MAX_AGE_DAYS,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_GATES,
  deploymentFailures,
  deploymentRate,
  failureStageCounts,
  failureSummary,
  firstPassVerificationRate,
  keyCoverage,
  medianSeconds,
  opsRecoverySummary,
  parseReliabilitySnapshot,
  parseReliabilityWindow,
  rateOf,
  reliabilityWindowRange,
  reviewRate,
  snapshotStaleness,
  taskRunSummary,
  unresolvedOpsCount,
  weeklyReliability,
  withinWindow,
} from '../src/domain/reliability.js'

const NOW = new Date('2026-11-04T12:00:00.000Z')
const DAY = 86_400_000

function gate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'coverage', status: 'pass', ...overrides }
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: 'demo',
    generatedAt: NOW.toISOString(),
    git: { head: 'abc', branch: 'main', dirty: false },
    package: { name: 'forgeloop-dsh', version: '0.0.2' },
    gates: [gate({ id: 'coverage' })],
    suppressions: 0,
    ...overrides,
  }
}

describe('reliability constants and windows', () => {
  it('pins the public constants', () => {
    expect(RELIABILITY_WINDOWS).toEqual(['7d', '30d', '90d', 'all'])
    expect(RELIABILITY_WINDOW_DAYS).toEqual({ '7d': 7, '30d': 30, '90d': 90 })
    expect(SNAPSHOT_MAX_AGE_DAYS).toBe(7)
    expect(SNAPSHOT_MAX_BYTES).toBe(256 * 1024)
    expect(SNAPSHOT_MAX_GATES).toBe(32)
    expect(SNAPSHOT_MAX_FILES).toBe(200)
    expect(KEY_COVERAGE_THRESHOLDS['src/domain/verification.ts']).toEqual({
      lines: 94,
      functions: 99,
      branches: 88,
    })
  })

  it('parses only declared windows and defaults to all', () => {
    expect(parseReliabilityWindow(undefined)).toBe('all')
    for (const value of RELIABILITY_WINDOWS) expect(parseReliabilityWindow(value)).toBe(value)
    expect(parseReliabilityWindow('1d')).toBeNull()
    expect(parseReliabilityWindow(7)).toBeNull()
    expect(parseReliabilityWindow(null)).toBeNull()
    expect(reliabilityWindowRange('all', NOW)).toEqual({ from: null, to: NOW })
    expect(reliabilityWindowRange('7d', NOW)).toEqual({
      from: new Date(NOW.getTime() - 7 * DAY),
      to: NOW,
    })
    expect(reliabilityWindowRange('90d', NOW).from?.getTime()).toBe(NOW.getTime() - 90 * DAY)
  })

  it('treats window edges, invalid timestamps and counts correctly', () => {
    const from = new Date(NOW.getTime() - DAY)
    expect(withinWindow(NOW.toISOString(), from, NOW)).toBe(true)
    expect(withinWindow(from.toISOString(), from, NOW)).toBe(true)
    expect(withinWindow(new Date(from.getTime() - 1).toISOString(), from, NOW)).toBe(false)
    expect(withinWindow(new Date(NOW.getTime() + 1).toISOString(), from, NOW)).toBe(false)
    expect(withinWindow('not-a-date', from, NOW)).toBe(false)
    expect(rateOf(0, 0)).toEqual({ pass: 0, total: 0, rate: null })
    expect(rateOf(1, 3).rate).toBe(33.3)
    expect(rateOf(2, 3).rate).toBe(66.7)
  })
})

describe('reliability rates and summaries', () => {
  it('counts first verification per requirement only inside the window', () => {
    const facts = [
      { reqId: 'a', verdict: 'block' as const, verifiedAt: '2026-11-01T00:00:00.000Z' },
      { reqId: 'a', verdict: 'pass' as const, verifiedAt: '2026-11-02T00:00:00.000Z' },
      { reqId: 'b', verdict: 'pass' as const, verifiedAt: '2026-11-03T00:00:00.000Z' },
      { reqId: 'c', verdict: 'pass' as const, verifiedAt: '2026-09-01T00:00:00.000Z' },
      { reqId: 'c', verdict: 'pass' as const, verifiedAt: '2026-11-03T00:00:00.000Z' },
    ]
    const from = new Date('2026-10-01T00:00:00.000Z')
    expect(firstPassVerificationRate(facts, from, NOW)).toEqual({
      pass: 1,
      total: 3,
      rate: 33.3,
    })
    expect(firstPassVerificationRate([], null, NOW)).toEqual({ pass: 0, total: 0, rate: null })
  })

  it('summarizes reviews, deployments, failures and task runs', () => {
    const from = new Date('2026-11-01T00:00:00.000Z')
    expect(
      reviewRate(
        [
          { reqId: 'a', verdict: 'pass', reviewedAt: '2026-11-02T00:00:00.000Z' },
          { reqId: 'b', verdict: 'block', reviewedAt: '2026-11-02T00:00:00.000Z' },
          { reqId: 'c', verdict: 'pass', reviewedAt: '2026-10-01T00:00:00.000Z' },
        ],
        from,
        NOW,
      ),
    ).toEqual({ pass: 1, total: 2, rate: 50 })
    expect(
      deploymentRate(
        [
          { reqId: 'a', state: 'verified', recordedAt: '2026-11-02T00:00:00.000Z', checks: [] },
          { reqId: 'b', state: 'failed', recordedAt: '2026-11-02T00:00:00.000Z', checks: [] },
        ],
        from,
        NOW,
      ),
    ).toEqual({ pass: 1, total: 2, rate: 50 })
  })

  it('counts every failure stage and unknown stages are ignored', () => {
    const stages = [
      'planning',
      'implementation_review',
      'formal_test',
      'interrupted',
      'verification',
      'business_review',
      'user_acceptance',
    ]
    const facts = [
      ...stages.map((stage, index) => ({
        reqId: index % 2 === 0 ? 'a' : 'b',
        stage,
        occurredAt: NOW.toISOString(),
      })),
      { reqId: 'a', stage: 'unknown', occurredAt: NOW.toISOString() },
    ]
    expect(failureStageCounts(facts)).toEqual({
      planning: 1,
      implementation_review: 1,
      formal_test: 1,
      interrupted: 1,
      verification: 1,
      business_review: 1,
      user_acceptance: 1,
    })
    expect(failureSummary(facts)).toEqual({
      total: 8,
      requirements: 2,
      perRequirement: 4,
      byStage: failureStageCounts(facts),
    })
    expect(failureSummary([])).toEqual({
      total: 0,
      requirements: 0,
      perRequirement: null,
      byStage: failureStageCounts([]),
    })
    expect(
      taskRunSummary([
        { reqId: 'a', state: 'delivered' },
        { reqId: 'a', state: 'failed' },
        { reqId: 'a', state: 'blocked' },
        { reqId: 'a', state: 'awaiting_user' },
        { reqId: 'a', state: 'running' },
        { reqId: 'a', state: 'other' },
      ]),
    ).toEqual({ total: 6, delivered: 1, failed: 1, blocked: 1, awaitingUser: 1, running: 1 })
  })

  it('summarizes ops recovery and medians', () => {
    const facts = [
      {
        eventId: 'a',
        state: 'recovered',
        title: 't',
        openedAt: '2026-11-01T00:00:00.000Z',
        recoveredAt: '2026-11-01T00:00:10.000Z',
      },
      {
        eventId: 'b',
        state: 'closed',
        title: 't',
        openedAt: '2026-11-01T00:00:00.000Z',
        recoveredAt: '',
      },
      {
        eventId: 'c',
        state: 'open',
        title: 't',
        openedAt: '2026-11-01T00:00:00.000Z',
        recoveredAt: '',
      },
      {
        eventId: 'd',
        state: 'recovered',
        title: 't',
        openedAt: '2026-10-01T00:00:00.000Z',
        recoveredAt: '2026-10-01T00:00:20.000Z',
      },
    ]
    expect(opsRecoverySummary(facts, new Date('2026-11-01T00:00:00.000Z'), NOW)).toEqual({
      opened: 3,
      closed: 2,
      recovered: 1,
      mttrSeconds: 10,
    })
    expect(unresolvedOpsCount(facts)).toBe(1)
    expect(medianSeconds([])).toBeNull()
    expect(medianSeconds([{ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:10Z' }])).toBe(10)
    expect(
      medianSeconds([
        { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:10Z' },
        { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:20Z' },
      ]),
    ).toBe(15)
    expect(
      medianSeconds([
        { start: '2026-01-01T00:00:10Z', end: '2026-01-01T00:00:00Z' },
        { start: 'invalid', end: '2026-01-01T00:00:00Z' },
      ]),
    ).toBeNull()
  })

  it('counts failed deployment checks with sorting and top five', () => {
    const facts = [
      {
        reqId: 'a',
        state: 'failed',
        recordedAt: '2026-11-02T00:00:00.000Z',
        checks: [
          { id: 'b', ok: false },
          { id: 'a', ok: false },
          { id: 'b', ok: false },
          { id: 'ignored', ok: true },
          { id: '  ', ok: false },
          null,
        ],
      },
      {
        reqId: 'b',
        state: 'verified',
        recordedAt: '2026-11-02T00:00:00.000Z',
        checks: [{ id: 'c', ok: false }],
      },
      {
        reqId: 'c',
        state: 'failed',
        recordedAt: '2026-10-01T00:00:00.000Z',
        checks: [{ id: 'd', ok: false }],
      },
    ]
    expect(deploymentFailures(facts, new Date('2026-11-01T00:00:00.000Z'), NOW)).toEqual([
      { checkId: 'b', count: 2 },
      { checkId: 'a', count: 1 },
    ])
  })

  it('builds weekly buckets with stable UTC week starts', () => {
    const weeks = weeklyReliability({
      verifications: [
        { reqId: 'a', verdict: 'pass', verifiedAt: '2026-11-02T00:00:00.000Z' },
        { reqId: 'b', verdict: 'block', verifiedAt: '2026-11-02T00:00:00.000Z' },
        { reqId: 'c', verdict: 'pass', verifiedAt: '2026-10-26T00:00:00.000Z' },
      ],
      failureRounds: [{ reqId: 'a', stage: 'planning', occurredAt: '2026-11-02T00:00:00.000Z' }],
      deployments: [
        { reqId: 'a', state: 'verified', recordedAt: '2026-11-02T00:00:00.000Z', checks: [] },
        { reqId: 'b', state: 'failed', recordedAt: '2026-11-02T00:00:00.000Z', checks: [] },
      ],
      now: NOW,
      weeks: 2,
    })
    expect(weeks).toHaveLength(2)
    expect(weeks[0]?.weekStart).toBe('2026-10-26T00:00:00.000Z')
    expect(weeks[0]).toMatchObject({ verificationPass: 1, verificationBlock: 0 })
    expect(weeks[1]).toMatchObject({
      weekStart: '2026-11-02T00:00:00.000Z',
      verificationPass: 1,
      verificationBlock: 1,
      failureRounds: 1,
      deploymentsVerified: 1,
      deploymentsFailed: 1,
    })
    expect(
      weeklyReliability({ verifications: [], failureRounds: [], deployments: [], now: NOW }),
    ).toHaveLength(8)
  })
})

describe('snapshot freshness and coverage', () => {
  const snapshotBase = {
    generatedAt: NOW.toISOString(),
    git: { head: 'abc', dirty: false },
  }

  it('reports every staleness reason and clamps negative age', () => {
    expect(snapshotStaleness(snapshotBase, 'abc', NOW)).toEqual({
      stale: false,
      reasons: [],
      ageSeconds: 0,
    })
    expect(
      snapshotStaleness({ generatedAt: 'invalid', git: { head: 'abc', dirty: false } }, 'abc', NOW),
    ).toMatchObject({ stale: true, ageSeconds: null })
    expect(
      snapshotStaleness(
        {
          generatedAt: new Date(NOW.getTime() - 8 * DAY).toISOString(),
          git: { head: 'abc', dirty: true },
        },
        'other',
        NOW,
      ),
    ).toMatchObject({
      stale: true,
      reasons: [
        `快照已超过 ${SNAPSHOT_MAX_AGE_DAYS} 天`,
        '快照提交与当前 HEAD 不一致',
        '快照生成时工作树有未提交改动',
      ],
    })
    expect(snapshotStaleness(snapshotBase, null, NOW).reasons).toEqual([
      '无法读取当前 HEAD，按过期处理',
    ])
    expect(
      snapshotStaleness(
        {
          generatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
          git: { head: 'abc', dirty: false },
        },
        'abc',
        NOW,
      ).ageSeconds,
    ).toBe(0)
  })

  it('checks key coverage files against thresholds', () => {
    const files = Object.entries(KEY_COVERAGE_THRESHOLDS).map(([path, thresholds]) => ({
      path,
      lines: thresholds.lines,
      statements: thresholds.lines,
      functions: thresholds.functions,
      branches: thresholds.branches,
    }))
    expect(keyCoverage(files)).toMatchObject({ total: 6, passed: 6 })
    const failed = keyCoverage([
      { path: 'src/domain/verification.ts', lines: 0, statements: 0, functions: 0, branches: 0 },
    ])
    expect(failed.files.find((file) => file.path === 'src/domain/verification.ts')?.passed).toBe(
      false,
    )
    expect(failed.files.find((file) => file.path === 'src/domain/admission.ts')?.present).toBe(
      false,
    )
  })
})

describe('snapshot parsing', () => {
  it('parses a minimal snapshot with defaults', () => {
    const parsed = parseReliabilitySnapshot(snapshot())
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      project: 'demo',
      generatedAt: NOW.toISOString(),
      git: { head: 'abc', branch: 'main', dirty: false },
      package: { name: 'forgeloop-dsh', version: '0.0.2' },
      suppressions: 0,
      artifacts: {},
    })
    expect(parsed.gates).toEqual([
      {
        id: 'coverage',
        label: 'coverage',
        status: 'pass',
        command: '',
        measured: null,
        unit: '',
        threshold: null,
        durationMs: null,
        at: '',
      },
    ])
    expect(parsed.tests).toBeNull()
    expect(parsed.coverage).toBeNull()
    expect(parsed.mutation).toBeNull()
    expect(parsed.budgets).toBeNull()
  })

  it('rejects structural errors with stable messages', () => {
    expect(() => parseReliabilitySnapshot(null)).toThrow('可靠性快照字段 root 必须是对象')
    expect(() => parseReliabilitySnapshot(snapshot({ schemaVersion: 2 }))).toThrow(
      '可靠性快照 schemaVersion 必须为 1',
    )
    expect(() => parseReliabilitySnapshot(snapshot({ gates: [] }))).toThrow(
      '可靠性快照必须包含至少一项门禁',
    )
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({ gates: Array.from({ length: SNAPSHOT_MAX_GATES + 1 }, () => gate()) }),
      ),
    ).toThrow(`可靠性快照门禁数超过 ${SNAPSHOT_MAX_GATES} 项`)
    expect(() => parseReliabilitySnapshot(snapshot({ gates: [gate({ status: 'x' })] }))).toThrow(
      '可靠性快照 gates[0].status 取值非法',
    )
    expect(() => parseReliabilitySnapshot(snapshot({ gates: [gate({ id: ' ' })] }))).toThrow(
      '可靠性快照字段 gates[0].id 必须是非空字符串',
    )
    expect(() => parseReliabilitySnapshot(snapshot({ gates: [gate({ measured: 'x' })] }))).toThrow(
      '可靠性快照字段 gates[0].measured 必须是有限数字',
    )
    expect(() => parseReliabilitySnapshot(snapshot({ generatedAt: '' }))).toThrow(
      '可靠性快照字段 generatedAt 必须是非空字符串',
    )
    expect(parseReliabilitySnapshot(snapshot({ artifacts: { a: 1 } })).artifacts).toEqual({
      a: '',
    })
  })

  it('parses tests, coverage, mutation and budgets with defaults and bounds', () => {
    const parsed = parseReliabilitySnapshot(
      snapshot({
        tests: { files: 1, total: 2 },
        coverage: {
          lines: 90,
          thresholds: { lines: 90 },
          files: [{ path: 'src/a.ts', lines: 100 }],
        },
        mutation: { score: 80, thresholds: { break: 80 } },
        budgets: { assertions: {}, tokens: {} },
      }),
    )
    expect(parsed.tests).toEqual({
      files: 1,
      total: 2,
      passed: null,
      failed: null,
      skipped: null,
      durationMs: null,
    })
    expect(parsed.coverage).toMatchObject({
      lines: 90,
      statements: null,
      thresholds: { lines: 90, statements: 0, functions: 0, branches: 0 },
      files: [{ path: 'src/a.ts', lines: 100 }],
    })
    expect(parsed.mutation).toEqual({
      score: 80,
      killed: 0,
      survived: 0,
      timeout: 0,
      noCoverage: 0,
      thresholds: { break: 80, low: 0, high: 0 },
    })
    expect(parsed.budgets).toEqual({
      assertions: { current: 0, baseline: 0 },
      tokens: { fileLimit: 25_000, overLimit: 0, maxFile: '', maxTokens: null },
    })
    expect(() =>
      parseReliabilitySnapshot(snapshot({ coverage: { lines: 101, thresholds: {} } })),
    ).toThrow('可靠性快照字段 coverage.lines 必须在 0..100 之间')
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({
          coverage: {
            thresholds: {},
            files: Array.from({ length: SNAPSHOT_MAX_FILES + 1 }, () => ({ path: 'x' })),
          },
        }),
      ),
    ).toThrow(`可靠性快照 coverage.files 超过 ${SNAPSHOT_MAX_FILES} 项`)
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({
          artifacts: Object.fromEntries(Array.from({ length: 21 }, (_v, i) => [`a${i}`, 'x'])),
        }),
      ),
    ).toThrow('可靠性快照 artifacts 超过 20 项')
  })
})
