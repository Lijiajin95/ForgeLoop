import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import { ReliabilityDashboard, reliabilityReport } from '../src/runtime/reliability.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const PROJECT = 'forgeloop'
const NOW = new Date('2026-11-03T10:00:00.000Z')

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-reliability-runtime-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    tasks: [
      {
        taskId: 't1',
        goal: '目标',
        files: ['docs/a.md'],
        acceptance: '完成',
        testCommand: ['node', '-e', '0'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
  }
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

function deployment(reqId: string, state: 'verified' | 'failed', at: string): void {
  repository.recordDeployment({
    reqId,
    planVersion: 1,
    candidateSha256: `candidate-${reqId}-${at}`,
    packageVersion: '0.0.2',
    targetProfile: 'web',
    artifactSha256: 'artifact',
    runtimeVersion: '0.0.2',
    state,
    checks: [
      { id: 'board', ok: state === 'verified' },
      { id: 'plugin', ok: true },
    ],
    evidenceDir: 'evidence',
    recordedBy: 'owner',
    source: 'test',
    recordedAt: at,
  })
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const keyFiles = [
    'src/runtime/service.ts',
    'src/runtime/coordinator.ts',
    'src/records/repository.ts',
    'src/domain/verification.ts',
    'src/domain/admission.ts',
    'src/domain/retry-policy.ts',
  ].map((path) => ({
    path: `packages/forgeloop/${path}`,
    lines: 100,
    statements: 100,
    functions: 100,
    branches: 100,
  }))
  return {
    schemaVersion: 1,
    project: PROJECT,
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
        durationMs: 1000,
        at: '2026-11-03T08:59:00.000Z',
      },
    ],
    tests: { files: 1, total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
    coverage: {
      lines: 91,
      statements: 91,
      functions: 96,
      branches: 85,
      thresholds: { lines: 90, statements: 90, functions: 93, branches: 84 },
      files: keyFiles,
    },
    mutation: {
      score: 98,
      killed: 100,
      survived: 2,
      timeout: 0,
      noCoverage: 0,
      thresholds: { break: 80, low: 85, high: 95 },
    },
    budgets: {
      assertions: { current: 18, baseline: 18 },
      tokens: { fileLimit: 25000, overLimit: 0, maxFile: 'service.ts', maxTokens: 21000 },
    },
    suppressions: 0,
    artifacts: { coverage: 'coverage-summary.json' },
    ...overrides,
  }
}

function dashboard(options: { snapshot?: unknown; head?: string | null } = {}) {
  if (options.snapshot !== undefined) {
    const path = join(dir, 'reports', 'reliability', 'latest.json')
    mkdirSync(join(dir, 'reports', 'reliability'), { recursive: true })
    writeFileSync(path, JSON.stringify(options.snapshot), 'utf8')
  }
  return new ReliabilityDashboard({
    repository,
    project: PROJECT,
    projectPath: dir,
    now: () => NOW,
    currentHead: () => (options.head === undefined ? 'abc123' : options.head),
  })
}

function seed(): void {
  repository.recordTaskPlan(plan('req-a'))
  repository.recordTaskRun({
    requirementId: 'req-a',
    planVersion: 1,
    taskId: 't1',
    state: 'delivered',
    reason: '',
    executedSeconds: 1,
    updatedAt: NOW.toISOString(),
  })
  verification('req-a', 'pass', '2026-10-20T00:00:00.000Z')
  verification('req-b', 'block', '2026-10-21T00:00:00.000Z')
  verification('req-b', 'pass', '2026-10-22T00:00:00.000Z')
  repository.recordBusinessReview({
    requirementId: 'req-a',
    planVersion: 1,
    candidateSha256: 'candidate-a',
    requirementVersion: 1,
    verificationSha256: 'verification',
    verdict: 'pass',
    reportJson: '{}',
    reportPath: 'report.json',
    reportSha256: 'sha',
    sessionId: 'session',
    reviewedAt: '2026-10-20T00:00:00.000Z',
  })
  deployment('req-a', 'verified', '2026-10-20T00:00:00.000Z')
  deployment('req-b', 'failed', '2026-10-21T00:00:00.000Z')
  repository.recordFailureRound('req-a', {
    roundId: 'round-1',
    stage: 'formal_test',
    summary: '测试失败',
    occurredAt: '2026-10-20T00:00:00.000Z',
  })
  repository.createOpsEvent({
    eventId: 'ops-1',
    project: PROJECT,
    resourceId: 'web',
    checkId: 'health',
    signature: 'web/health/1',
    severity: 'major',
    state: 'open',
    title: '页面不可用',
    openedAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  })
  repository.updateOpsEvent('ops-1', {
    state: 'recovered',
    recoveredAt: '2026-10-20T01:00:00.000Z',
    updatedAt: '2026-10-20T01:00:00.000Z',
  })
  repository.createOpsEvent({
    eventId: 'ops-2',
    project: PROJECT,
    resourceId: 'web',
    checkId: 'health',
    signature: 'web/health/2',
    severity: 'major',
    state: 'unresolved',
    title: '页面仍不可用',
    openedAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  })
  repository.recordCandidateBuild({
    reqId: 'req-a',
    planVersion: 1,
    candidateSha256: 'candidate-a',
    verificationSha256: 'verification',
    packageVersion: '0.0.2',
    artifactSha256: 'artifact',
    tarball: 'candidate.tgz',
    files: ['a.ts'],
    gitHead: 'abc123',
    builtAt: '2026-10-20T02:00:00.000Z',
    evidenceDir: 'evidence',
  })
}

describe('reliability dashboard', () => {
  it('combines a fresh snapshot with windowed runtime records', () => {
    seed()
    const report = dashboard({ snapshot: snapshot() }).report('30d')

    expect(report.snapshot.availability).toBe('fresh')
    expect(report.snapshot.keyCoverage).toMatchObject({ total: 6, passed: 6 })
    expect(report.runtime.verification).toEqual({ pass: 2, total: 3, rate: 66.7 })
    expect(report.runtime.firstPassVerification).toEqual({ pass: 1, total: 2, rate: 50 })
    expect(report.runtime.businessReview.rate).toBe(100)
    expect(report.runtime.deployment).toEqual({ pass: 1, total: 2, rate: 50 })
    expect(report.runtime.failureRounds).toMatchObject({
      total: 1,
      requirements: 1,
      perRequirement: 1,
    })
    expect(report.runtime.tasks).toMatchObject({ total: 1, delivered: 1 })
    expect(report.runtime.ops).toMatchObject({ opened: 2, closed: 2, recovered: 1, unresolved: 1 })
    expect(report.runtime.ops.mttrSeconds).toBe(3600)
    expect(report.runtime.candidateBuilds).toBe(1)
    expect(report.runtime.deploymentFailures).toEqual([{ checkId: 'board', count: 1 }])
    expect(report.runtime.trend).toHaveLength(8)
    expect(report.runtime.recentEvents.map((event) => event.kind)).toContain('verification')
    expect(report.runtime.recentEvents.map((event) => event.kind)).toContain('deployment')
    expect(report.runtime.recentEvents.map((event) => event.kind)).toContain('ops')
  })

  it('reuses the head and snapshot caches across reports', () => {
    const instance = dashboard({ snapshot: snapshot() })
    const first = instance.report('30d')
    const second = instance.report('30d')
    expect(first.snapshot.availability).toBe('fresh')
    expect(second.snapshot.commit).toBe('abc123')
    expect(second.runtime.verification.total).toBe(0)
  })

  it('counts commits behind the snapshot using the real project history', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: dir })
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    writeFileSync(join(dir, 'a.txt'), 'b\n')
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: dir })
    const path = join(dir, 'reports', 'reliability', 'latest.json')
    mkdirSync(join(dir, 'reports', 'reliability'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(snapshot({ git: { head: first, branch: 'main', dirty: false } })),
    )
    const instance = new ReliabilityDashboard({
      repository,
      project: PROJECT,
      projectPath: dir,
      now: () => NOW,
    })
    expect(instance.report('30d').snapshot.behindCommits).toBe(1)

    writeFileSync(
      path,
      JSON.stringify(snapshot({ git: { head: 'deadbeef', branch: 'main', dirty: false } })),
    )
    const unknown = new ReliabilityDashboard({
      repository,
      project: PROJECT,
      projectPath: dir,
      now: () => NOW,
    })
    expect(unknown.report('30d').snapshot.behindCommits).toBeNull()
  })

  it('rejects an oversized snapshot and reuses one dashboard per repository', () => {
    const path = join(dir, 'reports', 'reliability', 'latest.json')
    mkdirSync(join(dir, 'reports', 'reliability'), { recursive: true })
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024))
    const instance = new ReliabilityDashboard({
      repository,
      project: PROJECT,
      projectPath: dir,
      now: () => NOW,
      currentHead: () => 'abc123',
    })
    const report = instance.report('30d')
    expect(report.snapshot.availability).toBe('invalid')
    expect(report.snapshot.error).toContain('超过')

    const config = {
      project: PROJECT,
      projectPath: dir,
      agent: { provider: 'fake', model: 'fake' },
      autoAdvance: false,
    } as never
    const first = reliabilityReport(repository, config, () => NOW, '30d')
    const second = reliabilityReport(repository, config, () => NOW, '30d')
    expect(first.project).toBe(PROJECT)
    expect(second.generatedAt).toBe(NOW.toISOString())
  })

  it('returns null rates when the selected window has no records', () => {
    seed()
    const report = dashboard({ snapshot: snapshot() }).report('7d')
    expect(report.runtime.verification.rate).toBeNull()
    expect(report.runtime.firstPassVerification.rate).toBeNull()
    expect(report.runtime.businessReview.rate).toBeNull()
    expect(report.runtime.deployment.rate).toBeNull()
    expect(report.runtime.ops).toMatchObject({ opened: 0, closed: 0, recovered: 0 })
  })

  it('reports missing, invalid and stale snapshots without failing the runtime section', () => {
    seed()
    const missing = dashboard().report('30d')
    expect(missing.snapshot.availability).toBe('missing')
    expect(missing.snapshot.gates).toEqual([])
    expect(missing.runtime.verification.total).toBe(3)
    expect(missing.warnings.join(' ')).toContain('未找到质量快照')

    const invalid = dashboard({ snapshot: { schemaVersion: 99 } }).report('30d')
    expect(invalid.snapshot.availability).toBe('invalid')
    expect(invalid.snapshot.error).toContain('schemaVersion')
    expect(invalid.runtime.verification.total).toBe(3)

    const stale = dashboard({
      snapshot: snapshot({ git: { head: 'abc123', branch: 'main', dirty: true } }),
    }).report('30d')
    expect(stale.snapshot.availability).toBe('stale')
    expect(stale.snapshot.warnings.join(' ')).toContain('未提交改动')
    expect(stale.warnings.join(' ')).toContain('质量快照已过期')
  })
})
