import { describe, expect, it } from 'vitest'
import config from '../vitest.config.js'
import {
  KEY_COVERAGE_THRESHOLDS,
  deploymentFailures,
  deploymentRate,
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
} from '../src/domain/reliability.js'

const NOW = new Date('2026-11-03T10:00:00.000Z')
const FROM_30 = new Date('2026-10-04T10:00:00.000Z')

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    project: 'forgeloop',
    generatedAt: '2026-11-03T09:00:00.000Z',
    git: { head: 'abc123', branch: 'main', dirty: false },
    package: { name: 'forgeloop-dsh', version: '0.0.2' },
    gates: [
      {
        id: 'typecheck',
        label: '类型检查',
        status: 'pass',
        command: 'make typecheck',
        measured: 0,
        unit: 'errors',
        threshold: 0,
        durationMs: 1200,
        at: '2026-11-03T08:59:00.000Z',
      },
    ],
    tests: { files: 1, total: 3, passed: 2, failed: 0, skipped: 1, durationMs: 100 },
    coverage: {
      lines: 91.9,
      statements: 91.9,
      functions: 96.6,
      branches: 84.6,
      thresholds: { lines: 90, statements: 90, functions: 93, branches: 84 },
      files: [
        {
          path: 'packages/forgeloop/src/a.ts',
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 80,
        },
      ],
    },
    mutation: {
      score: 97.8,
      killed: 178,
      survived: 4,
      timeout: 0,
      noCoverage: 0,
      thresholds: { break: 80, low: 85, high: 95 },
    },
    budgets: {
      assertions: { current: 18, baseline: 18 },
      tokens: { fileLimit: 25000, overLimit: 0, maxFile: 'a.ts', maxTokens: 100 },
    },
    suppressions: 0,
    artifacts: { coverage: 'coverage.json' },
    ...overrides,
  }
}

describe('reliability window', () => {
  it('defaults to all and rejects unknown windows', () => {
    expect(parseReliabilityWindow(undefined)).toBe('all')
    expect(parseReliabilityWindow('30d')).toBe('30d')
    expect(parseReliabilityWindow('12h')).toBeNull()
    expect(parseReliabilityWindow(30)).toBeNull()
  })

  it('computes inclusive start boundaries and keeps all as unbounded', () => {
    expect(reliabilityWindowRange('7d', NOW).from?.toISOString()).toBe('2026-10-27T10:00:00.000Z')
    expect(reliabilityWindowRange('all', NOW).from).toBeNull()
  })
})

describe('rates', () => {
  it('returns null for an empty denominator instead of zero', () => {
    expect(rateOf(0, 0)).toEqual({ pass: 0, total: 0, rate: null })
    expect(rateOf(2, 3)).toEqual({ pass: 2, total: 3, rate: 66.7 })
  })

  it('counts only the earliest verification per requirement for first-pass rate', () => {
    const rate = firstPassVerificationRate(
      [
        { reqId: 'req-a', verdict: 'pass', verifiedAt: '2026-10-05T00:00:00.000Z' },
        { reqId: 'req-b', verdict: 'block', verifiedAt: '2026-10-06T00:00:00.000Z' },
        { reqId: 'req-b', verdict: 'pass', verifiedAt: '2026-10-07T00:00:00.000Z' },
        { reqId: 'req-c', verdict: 'block', verifiedAt: '2026-09-01T00:00:00.000Z' },
        { reqId: 'req-c', verdict: 'pass', verifiedAt: '2026-10-08T00:00:00.000Z' },
      ],
      FROM_30,
      NOW,
    )
    expect(rate).toEqual({ pass: 1, total: 3, rate: 33.3 })
  })

  it('rates reviews and deployments by their own timestamps', () => {
    expect(
      reviewRate(
        [
          { reqId: 'a', verdict: 'pass', reviewedAt: '2026-10-05T00:00:00.000Z' },
          { reqId: 'b', verdict: 'block', reviewedAt: '2026-09-01T00:00:00.000Z' },
        ],
        FROM_30,
        NOW,
      ),
    ).toEqual({ pass: 1, total: 1, rate: 100 })
    expect(
      deploymentRate(
        [
          { reqId: 'a', state: 'verified', recordedAt: '2026-10-05T00:00:00.000Z', checks: [] },
          { reqId: 'b', state: 'failed', recordedAt: '2026-10-06T00:00:00.000Z', checks: [] },
        ],
        FROM_30,
        NOW,
      ),
    ).toEqual({ pass: 1, total: 2, rate: 50 })
  })
})

describe('failure and task summaries', () => {
  it('counts stages and uses affected requirements as the per-requirement denominator', () => {
    expect(
      failureSummary([
        { reqId: 'a', stage: 'formal_test', occurredAt: '2026-10-05T00:00:00.000Z' },
        { reqId: 'a', stage: 'formal_test', occurredAt: '2026-10-06T00:00:00.000Z' },
        { reqId: 'b', stage: 'verification', occurredAt: '2026-10-07T00:00:00.000Z' },
      ]),
    ).toMatchObject({
      total: 3,
      requirements: 2,
      perRequirement: 1.5,
      byStage: { formal_test: 2, verification: 1 },
    })
  })

  it('sums current task states without inventing pending tasks', () => {
    expect(
      taskRunSummary([
        { reqId: 'a', state: 'delivered' },
        { reqId: 'a', state: 'failed' },
        { reqId: 'a', state: 'blocked' },
        { reqId: 'a', state: 'awaiting_user' },
        { reqId: 'a', state: 'running' },
      ]),
    ).toEqual({ total: 5, delivered: 1, failed: 1, blocked: 1, awaitingUser: 1, running: 1 })
  })
})

describe('ops recovery', () => {
  it('counts only events opened in the window and uses the median recovery time', () => {
    const summary = opsRecoverySummary(
      [
        {
          eventId: 'a',
          state: 'recovered',
          title: '事件 a',
          openedAt: '2026-10-05T00:00:00.000Z',
          recoveredAt: '2026-10-05T02:00:00.000Z',
        },
        {
          eventId: 'b',
          state: 'recovered',
          title: '事件 b',
          openedAt: '2026-10-06T00:00:00.000Z',
          recoveredAt: '2026-10-06T04:00:00.000Z',
        },
        {
          eventId: 'c',
          state: 'unresolved',
          title: '事件 c',
          openedAt: '2026-10-07T00:00:00.000Z',
          recoveredAt: '',
        },
        {
          eventId: 'd',
          state: 'open',
          title: '事件 d',
          openedAt: '2026-10-07T00:00:00.000Z',
          recoveredAt: '',
        },
        {
          eventId: 'old',
          state: 'recovered',
          title: '旧事件',
          openedAt: '2026-01-01T00:00:00.000Z',
          recoveredAt: '2026-01-01T01:00:00.000Z',
        },
      ],
      FROM_30,
      NOW,
    )
    expect(summary).toEqual({ opened: 4, closed: 3, recovered: 2, mttrSeconds: 10_800 })
    expect(medianSeconds([{ start: 'a', end: 'b' }])).toBeNull()
  })

  it('counts currently unresolved events across all time', () => {
    expect(
      unresolvedOpsCount([
        {
          eventId: 'a',
          state: 'open',
          title: '事件 a',
          openedAt: NOW.toISOString(),
          recoveredAt: '',
        },
        {
          eventId: 'b',
          state: 'unresolved',
          title: '事件 b',
          openedAt: NOW.toISOString(),
          recoveredAt: '',
        },
        {
          eventId: 'c',
          state: 'closed',
          title: '事件 c',
          openedAt: NOW.toISOString(),
          recoveredAt: '',
        },
        {
          eventId: 'd',
          state: 'recovered',
          title: '事件 d',
          openedAt: NOW.toISOString(),
          recoveredAt: NOW.toISOString(),
        },
      ]),
    ).toBe(2)
  })
})

describe('deployment checks', () => {
  it('counts only failed checks from failed deployments in the window', () => {
    expect(
      deploymentFailures(
        [
          {
            reqId: 'a',
            state: 'failed',
            recordedAt: '2026-10-05T00:00:00.000Z',
            checks: [
              { id: 'board', ok: false },
              { id: 'plugin', ok: true },
            ],
          },
          {
            reqId: 'b',
            state: 'failed',
            recordedAt: '2026-10-06T00:00:00.000Z',
            checks: [{ id: 'board', ok: false }],
          },
          {
            reqId: 'c',
            state: 'verified',
            recordedAt: '2026-10-07T00:00:00.000Z',
            checks: [{ id: 'board', ok: false }],
          },
        ],
        FROM_30,
        NOW,
      ),
    ).toEqual([{ checkId: 'board', count: 2 }])
  })
})

describe('weekly trend', () => {
  it('buckets append-only facts into UTC weeks and labels the current partial week', () => {
    const weeks = weeklyReliability({
      verifications: [
        { reqId: 'a', verdict: 'pass', verifiedAt: '2026-11-02T00:00:00.000Z' },
        { reqId: 'b', verdict: 'block', verifiedAt: '2026-10-28T00:00:00.000Z' },
      ],
      failureRounds: [{ reqId: 'a', stage: 'formal_test', occurredAt: '2026-11-02T00:00:00.000Z' }],
      deployments: [],
      now: NOW,
      weeks: 2,
    })
    expect(weeks).toHaveLength(2)
    expect(weeks[0]).toMatchObject({ weekStart: '2026-10-26T00:00:00.000Z', verificationBlock: 1 })
    expect(weeks[1]).toMatchObject({
      weekStart: '2026-11-02T00:00:00.000Z',
      verificationPass: 1,
      failureRounds: 1,
    })
  })
})

describe('failure stage coverage', () => {
  it('counts every failure stage and ignores an unknown stage', () => {
    const facts = [
      'planning',
      'implementation_review',
      'formal_test',
      'interrupted',
      'verification',
      'business_review',
      'user_acceptance',
    ].map((stage) => ({ reqId: 'a', stage, occurredAt: '2026-11-01T00:00:00.000Z' }))
    facts.push({ reqId: 'a', stage: 'unknown' as never, occurredAt: '2026-11-01T00:00:00.000Z' })
    const summary = failureSummary(facts as never)
    expect(summary.total).toBe(8)
    expect(summary.byStage).toMatchObject({
      planning: 1,
      implementation_review: 1,
      formal_test: 1,
      interrupted: 1,
      verification: 1,
      business_review: 1,
      user_acceptance: 1,
    })
  })
})

describe('snapshot freshness', () => {
  it('is stale on head mismatch, dirty tree, old age or unknown head', () => {
    expect(snapshotStaleness(snapshot() as never, 'abc123', NOW).stale).toBe(false)
    expect(snapshotStaleness(snapshot() as never, 'def456', NOW).reasons).toContain(
      '快照提交与当前 HEAD 不一致',
    )
    expect(
      snapshotStaleness(
        snapshot({ git: { head: 'abc123', branch: 'main', dirty: true } }) as never,
        'abc123',
        NOW,
      ).reasons,
    ).toContain('快照生成时工作树有未提交改动')
    expect(snapshotStaleness(snapshot() as never, null, NOW).reasons).toContain(
      '无法读取当前 HEAD，按过期处理',
    )
    const old = snapshot({ generatedAt: '2026-10-01T00:00:00.000Z' })
    expect(snapshotStaleness(old as never, 'abc123', NOW).reasons).toContain('快照已超过 7 天')
  })
})

describe('snapshot freshness invalid timestamps', () => {
  it('marks an unparseable generatedAt as stale', () => {
    const result = snapshotStaleness(
      snapshot({ generatedAt: 'not-a-date' }) as never,
      'abc123',
      NOW,
    )
    expect(result.stale).toBe(true)
    expect(result.ageSeconds).toBeNull()
    expect(result.reasons).toContain('快照生成时间无效')
  })
})

describe('key coverage', () => {
  it('keeps the same per-file thresholds as the vitest configuration', () => {
    const thresholds = config.test?.coverage?.thresholds as Record<
      string,
      { lines?: number; functions?: number; branches?: number }
    >
    for (const [path, expected] of Object.entries(KEY_COVERAGE_THRESHOLDS)) {
      expect(thresholds[path]).toMatchObject(expected)
    }
  })

  it('requires every key file to be present and above all three thresholds', () => {
    const files = Object.entries(KEY_COVERAGE_THRESHOLDS).map(([path, thresholds]) => ({
      path: `packages/forgeloop/${path}`,
      lines: thresholds.lines,
      statements: thresholds.lines,
      functions: thresholds.functions,
      branches: thresholds.branches,
    }))
    expect(keyCoverage(files)).toMatchObject({ total: 6, passed: 6 })
    files[0] = { ...files[0]!, functions: 0 }
    expect(keyCoverage(files)).toMatchObject({ total: 6, passed: 5 })
  })
})

describe('key coverage gaps', () => {
  it('reports a missing key file and null metrics as not passed', () => {
    const summary = keyCoverage([])
    expect(summary.total).toBeGreaterThan(0)
    expect(summary.passed).toBe(0)
    expect(summary.files[0]?.present).toBe(false)
    expect(summary.files[0]?.lines).toBeNull()
  })

  it('reports a file with null metrics as not passed', () => {
    const [path, thresholds] = Object.entries(KEY_COVERAGE_THRESHOLDS)[0]!
    const summary = keyCoverage([
      {
        path: `packages/forgeloop/${path}`,
        lines: null,
        statements: null,
        functions: thresholds.functions,
        branches: thresholds.branches,
      },
    ])
    expect(summary.files[0]?.present).toBe(true)
    expect(summary.passed).toBe(0)
  })
})

describe('snapshot parsing', () => {
  it('parses a complete snapshot and preserves null measurements', () => {
    const parsed = parseReliabilitySnapshot(snapshot())
    expect(parsed.gates[0]?.status).toBe('pass')
    expect(parsed.tests?.skipped).toBe(1)
    const missing = snapshot({
      gates: [
        { ...((snapshot().gates as unknown[])[0] as object), measured: null, threshold: null },
      ],
    })
    expect(parseReliabilitySnapshot(missing).gates[0]?.measured).toBeNull()
  })

  it('rejects empty strings and non-finite numbers in snapshot fields', () => {
    expect(() => parseReliabilitySnapshot(snapshot({ project: '' }))).toThrow(
      '可靠性快照字段 project 必须是非空字符串',
    )
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({ tests: { ...(snapshot().tests as object), total: Number.POSITIVE_INFINITY } }),
      ),
    ).toThrow('必须是有限数字')
    expect(() => parseReliabilitySnapshot(snapshot({ coverage: 'none' }))).toThrow(
      'coverage 必须是对象',
    )
  })

  it('rejects oversized coverage, gates and artifacts lists', () => {
    const gates = Array.from({ length: 51 }, (_, index) => ({
      ...((snapshot().gates as unknown[])[0] as object),
      id: `gate-${index}`,
    }))
    expect(() => parseReliabilitySnapshot(snapshot({ gates }))).toThrow('门禁数超过')
    const files = Array.from({ length: 201 }, (_, index) => ({
      path: `src/${index}.ts`,
      lines: 1,
      statements: 1,
      functions: 1,
      branches: 1,
    }))
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({ coverage: { ...(snapshot().coverage as object), files } }),
      ),
    ).toThrow('coverage.files 超过')
    const artifacts = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`a${index}`, 'x']),
    )
    expect(() => parseReliabilitySnapshot(snapshot({ artifacts }))).toThrow('artifacts 超过 20 项')
  })

  it('rejects an invalid gate status, empty gates and percentages outside 0..100', () => {
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({ gates: [{ ...((snapshot().gates as unknown[])[0] as object), status: 'ok' }] }),
      ),
    ).toThrow('status')
    expect(() => parseReliabilitySnapshot(snapshot({ gates: [] }))).toThrow('至少一项门禁')
    expect(() =>
      parseReliabilitySnapshot(
        snapshot({ coverage: { ...(snapshot().coverage as object), lines: 101 } }),
      ),
    ).toThrow('0..100')
  })
})
