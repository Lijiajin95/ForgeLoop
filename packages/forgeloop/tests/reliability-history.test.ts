import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  parseReliabilitySample,
  parseReliabilitySnapshot,
  snapshotHistoryPoint,
  type ReliabilitySamplePayload,
} from '../src/domain/reliability.js'
import { ReliabilityDashboard } from '../src/runtime/reliability.js'

const PROJECT = 'forgeloop'
const NOW = new Date('2026-11-03T10:00:00.000Z')

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-reliability-history-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function payload(overrides: Partial<ReliabilitySamplePayload> = {}): ReliabilitySamplePayload {
  return {
    asOf: '2026-11-03T09:00:00.000Z',
    commit: 'abc123',
    verification: { pass: 1, total: 2, rate: 50 },
    firstPassVerification: { pass: 1, total: 1, rate: 100 },
    businessReview: { pass: 1, total: 1, rate: 100 },
    deployment: { pass: 1, total: 1, rate: 100 },
    failureRounds: { total: 2, requirements: 1 },
    tasks: { total: 1, delivered: 1, failed: 0, blocked: 0, awaitingUser: 0, running: 0 },
    ops: { opened: 1, closed: 1, recovered: 1, unresolved: 0, mttrSeconds: 3600 },
    candidateBuilds: 1,
    deploymentIntents: { verified: 1, failed: 0, rolledBack: 0, pending: 0 },
    ...overrides,
  }
}

function snapshotJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: PROJECT,
    generatedAt: '2026-11-02T09:00:00.000Z',
    git: { head: 'aaa111', branch: 'main', dirty: false },
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
        durationMs: 1000,
        at: '2026-11-02T08:59:00.000Z',
      },
      {
        id: 'mutation',
        label: '变异测试',
        status: 'not_run',
        command: 'make mutation',
        measured: null,
        unit: '% score',
        threshold: 80,
        durationMs: null,
        at: '',
      },
    ],
    tests: { files: 1, total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 100 },
    coverage: {
      lines: 91,
      statements: 91,
      functions: 96,
      branches: 85,
      thresholds: { lines: 90, statements: 90, functions: 93, branches: 84 },
      files: [],
    },
    mutation: {
      score: null,
      killed: 0,
      survived: 0,
      timeout: 0,
      noCoverage: 0,
      thresholds: { break: 80, low: 85, high: 95 },
    },
    budgets: {
      assertions: { current: 18, baseline: 18 },
      tokens: { fileLimit: 25000, overLimit: 0, maxFile: 'service.ts', maxTokens: 21000 },
    },
    suppressions: 0,
    artifacts: {},
    ...overrides,
  }
}

function writeHistory(name: string, value: unknown): void {
  const history = join(dir, 'reports', 'reliability', 'history')
  mkdirSync(history, { recursive: true })
  writeFileSync(
    join(history, name),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  )
}

function writeLatest(value: unknown): void {
  const latest = join(dir, 'reports', 'reliability', 'latest.json')
  mkdirSync(join(dir, 'reports', 'reliability'), { recursive: true })
  writeFileSync(latest, JSON.stringify(value), 'utf8')
}

function verification(reqId: string, verdict: 'pass' | 'block', at: string): void {
  repository.recordVerification({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: `candidate-${reqId}-${at}`,
    requirementVersion: 1,
    workspaceSha256: 'workspace',
    verdict,
    reportJson: '{}',
    reportPath: 'report.json',
    reportSha256: 'sha',
    evidenceDir: 'evidence',
    sessionId: 'session',
    verifiedAt: at,
  })
}

function dashboard(
  now: () => Date,
  options: {
    sampleLimit?: number
    snapshotHistoryLimit?: number
    sampleHeartbeatMs?: number
  } = {},
) {
  return new ReliabilityDashboard({
    repository,
    project: PROJECT,
    projectPath: dir,
    now,
    currentHead: () => 'abc123',
    ...options,
  })
}

describe('reliability metric samples', () => {
  it('round-trips every recorded rate and count', () => {
    const parsed = parseReliabilitySample(JSON.parse(JSON.stringify(payload())))
    expect(parsed).toEqual(payload())
  })

  it('rejects malformed payloads instead of inventing zero values', () => {
    expect(() => parseReliabilitySample({})).toThrow()
    expect(() =>
      parseReliabilitySample({ ...payload(), verification: { pass: 2, total: 1 } }),
    ).toThrow()
    expect(() => parseReliabilitySample({ ...payload(), ops: { opened: 'x' } })).toThrow()
  })

  it('summarizes a quality snapshot into a compact history point', () => {
    const point = snapshotHistoryPoint(parseReliabilitySnapshot(snapshotJson()))
    expect(point.gates).toEqual({ pass: 1, fail: 0, skipped: 0, notRun: 1 })
    expect(point.tests).toEqual({ passed: 2, total: 2, failed: 0, skipped: 0 })
    expect(point.coverage).toEqual({ lines: 91, functions: 96, branches: 85 })
    expect(point.mutation).toEqual({ score: null })
    expect(point.commit).toBe('aaa111')
  })

  it('keeps snapshot history usable when optional sections are missing', () => {
    const point = snapshotHistoryPoint(
      parseReliabilitySnapshot(
        snapshotJson({
          gates: [
            {
              id: 'lint',
              label: 'ESLint',
              status: 'fail',
              command: 'make lint',
              measured: 2,
              unit: 'errors',
              threshold: 0,
              durationMs: 1000,
              at: '',
            },
            {
              id: 'format',
              label: '格式',
              status: 'skipped',
              command: 'make format',
              measured: null,
              unit: 'files',
              threshold: 0,
              durationMs: null,
              at: '',
            },
          ],
          tests: null,
          coverage: null,
          mutation: null,
          artifacts: undefined,
        }),
      ),
    )
    expect(point.gates).toEqual({ pass: 0, fail: 1, skipped: 1, notRun: 0 })
    expect(point.tests).toBeNull()
    expect(point.coverage).toBeNull()
    expect(point.mutation).toBeNull()
  })

  it('keeps zero-sample rates explicit instead of coercing them', () => {
    const parsed = parseReliabilitySample(
      payload({
        verification: { pass: 0, total: 0, rate: null },
        ops: { opened: 0, closed: 0, recovered: 0, unresolved: 0, mttrSeconds: null },
      }),
    )
    expect(parsed.verification).toEqual({ pass: 0, total: 0, rate: null })
    expect(parsed.ops.mttrSeconds).toBeNull()
  })

  it('rejects non-integer sample counts', () => {
    expect(() => parseReliabilitySample({ ...payload(), candidateBuilds: 1.5 })).toThrow()
    expect(() => parseReliabilitySample({ ...payload(), candidateBuilds: -1 })).toThrow()
  })
})

describe('reliability history records', () => {
  it('appends samples per project and returns the newest first', () => {
    repository.recordReliabilitySample({
      project: 'a',
      sampledAt: '2026-11-03T10:00:00.000Z',
      revision: 'r1',
      payload: payload(),
    })
    repository.recordReliabilitySample({
      project: 'a',
      sampledAt: '2026-11-03T10:05:00.000Z',
      revision: 'r2',
      payload: payload({ candidateBuilds: 2 }),
    })
    repository.recordReliabilitySample({
      project: 'b',
      sampledAt: '2026-11-03T10:06:00.000Z',
      revision: 'r3',
      payload: payload(),
    })

    const samples = repository.reliabilitySamples('a')
    expect(samples.map((sample) => sample.sampledAt)).toEqual([
      '2026-11-03T10:05:00.000Z',
      '2026-11-03T10:00:00.000Z',
    ])
    expect(samples[0]).toMatchObject({ revision: 'r2', project: 'a', candidateBuilds: 2 })
    expect(samples[0].sampleId).toBeGreaterThan(samples[0].sampleId - 1)
    expect(repository.latestReliabilitySample('b')?.revision).toBe('r3')
  })

  it('honours the history limit and reports no sample for an unknown project', () => {
    for (let index = 0; index < 4; index += 1) {
      repository.recordReliabilitySample({
        project: 'a',
        sampledAt: `2026-11-03T10:0${index}:00.000Z`,
        revision: `r${index}`,
        payload: payload(),
      })
    }
    expect(repository.reliabilitySamples('a', 2)).toHaveLength(2)
    expect(repository.latestReliabilitySample('a')?.revision).toBe('r3')
    expect(repository.latestReliabilitySample('missing')).toBeNull()
  })

  it('skips a corrupt payload row instead of showing zero metrics', () => {
    repository.recordReliabilitySample({
      project: 'a',
      sampledAt: '2026-11-03T10:00:00.000Z',
      revision: 'r1',
      payload: payload(),
    })
    repository.db
      .prepare(
        `INSERT INTO reliability_metric_samples (project, sampled_at, revision, payload_json)
         VALUES ('a', '2026-11-03T10:05:00.000Z', 'broken', '{oops')`,
      )
      .run()

    const samples = repository.reliabilitySamples('a')
    expect(samples).toHaveLength(1)
    expect(samples[0].revision).toBe('r1')
    // 最新一行损坏时按“没有可用样本”处理，采样器会补写一条，而不是拿旧值冒充最新。
    expect(repository.latestReliabilitySample('a')).toBeNull()
  })
})

describe('reliability sampling', () => {
  it('records the first sample immediately and then only when metrics change', () => {
    let now = new Date(NOW)
    const instance = dashboard(() => now)

    expect(instance.recordSampleIfDue()).toBe(true)
    expect(repository.reliabilitySamples(PROJECT)).toHaveLength(1)
    expect(repository.reliabilitySamples(PROJECT)[0].verification.total).toBe(0)

    expect(instance.recordSampleIfDue()).toBe(false)

    verification('req-a', 'pass', '2026-11-03T10:00:20.000Z')
    now = new Date('2026-11-03T10:00:30.000Z')
    // 变化立刻可见，但两次采样至少间隔 1 分钟，避免每个请求都写一行。
    expect(instance.recordSampleIfDue()).toBe(false)

    now = new Date('2026-11-03T10:01:05.000Z')
    expect(instance.recordSampleIfDue()).toBe(true)
    expect(repository.reliabilitySamples(PROJECT)).toHaveLength(2)
    expect(repository.reliabilitySamples(PROJECT)[0].verification).toEqual({
      pass: 1,
      total: 1,
      rate: 100,
    })
  })

  it('pins each sample to the snapshot measurement point', () => {
    writeLatest(
      snapshotJson({
        generatedAt: '2026-11-03T09:00:00.000Z',
        git: { head: 'abc123', branch: 'main', dirty: false },
      }),
    )
    let now = new Date(NOW)
    const instance = dashboard(() => now)
    // 测量点之后产生的记录不进入样本，也不改变整页版本。
    verification('req-late', 'pass', '2026-11-03T09:30:00.000Z')

    expect(instance.recordSampleIfDue()).toBe(true)
    const sample = repository.reliabilitySamples(PROJECT)[0]
    expect(sample).toMatchObject({ asOf: '2026-11-03T09:00:00.000Z', commit: 'abc123' })
    expect(sample.verification.total).toBe(0)

    now = new Date(now.getTime() + 30_000)
    expect(instance.recordSampleIfDue()).toBe(false)
  })

  it('keeps a heartbeat sample when nothing changed for the heartbeat window', () => {
    let now = new Date(NOW)
    const instance = dashboard(() => now, { sampleHeartbeatMs: 60 * 60 * 1000 })
    expect(instance.recordSampleIfDue()).toBe(true)

    now = new Date(now.getTime() + 30 * 60 * 1000)
    expect(instance.recordSampleIfDue()).toBe(false)

    now = new Date(now.getTime() + 31 * 60 * 1000)
    expect(instance.recordSampleIfDue()).toBe(true)
    expect(repository.reliabilitySamples(PROJECT)).toHaveLength(2)
  })

  it('reports a stable revision until the underlying facts change', () => {
    const instance = dashboard(() => NOW)
    const first = instance.report('all')
    expect(instance.report('all').revision).toBe(first.revision)

    verification('req-a', 'pass', '2026-11-03T10:00:00.000Z')
    const changed = instance.report('all')
    expect(changed.revision).not.toBe(first.revision)
    expect(changed.runtime.verification.total).toBe(1)
  })

  it('returns recorded samples and compact snapshot history with the report', () => {
    repository.recordReliabilitySample({
      project: PROJECT,
      sampledAt: '2026-11-03T10:00:00.000Z',
      revision: 'r1',
      payload: payload(),
    })
    writeHistory('2026-11-02T09-00-00-000Z-aaa111.json', snapshotJson())
    writeHistory(
      '2026-11-03T09-00-00-000Z-bbb222.json',
      snapshotJson({
        generatedAt: '2026-11-03T09:00:00.000Z',
        git: { head: 'bbb222', branch: 'main', dirty: false },
      }),
    )
    writeHistory('broken.json', '{oops')

    const instance = dashboard(() => NOW)
    const report = instance.report('all')
    expect(report.history.samples).toHaveLength(1)
    expect(report.history.samples[0].revision).toBe('r1')
    expect(report.history.snapshots).toHaveLength(2)
    expect(report.history.snapshots[0].generatedAt).toBe('2026-11-03T09:00:00.000Z')
    expect(report.history.snapshots[0].commit).toBe('bbb222')
    expect(report.history.snapshots[0].gates.pass).toBe(1)
    expect(report.history.snapshots[1].generatedAt).toBe('2026-11-02T09:00:00.000Z')
    expect(report.history.sampleLimit).toBeGreaterThan(0)
    expect(report.history.snapshotHistoryLimit).toBeGreaterThan(0)

    // 第二次读取复用历史缓存，结果一致。
    expect(instance.report('all').history.snapshots).toEqual(report.history.snapshots)
  })

  it('limits the snapshot history to the newest entries', () => {
    for (let index = 1; index <= 3; index += 1) {
      writeHistory(
        `2026-11-0${index}T09-00-00-000Z-c${index}.json`,
        snapshotJson({
          generatedAt: `2026-11-0${index}T09:00:00.000Z`,
          git: { head: `c${index}`, branch: 'main', dirty: false },
        }),
      )
    }
    const report = dashboard(() => NOW, { snapshotHistoryLimit: 2 }).report('all')
    expect(report.history.snapshots.map((point) => point.commit)).toEqual(['c3', 'c2'])
  })
})
