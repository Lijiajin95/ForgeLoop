import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const PROJECT = 'forgeloop'
const NOW = '2026-11-03T10:00:00.000Z'

let dir = ''
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-reliability-'))
  repository = new Repository(Database.open(join(dir, 'records.sqlite')))
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function plan(reqId: string, version = 1): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}-${version}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: version,
    requirementVersion: 1,
    createdAt: NOW,
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

function review(reqId: string, verdict: 'pass' | 'block', at: string): void {
  repository.recordBusinessReview({
    requirementId: reqId,
    planVersion: 1,
    candidateSha256: `candidate-${reqId}-${at}`,
    requirementVersion: 1,
    verificationSha256: 'verification',
    verdict,
    reportJson: '{}',
    reportPath: 'report.json',
    reportSha256: 'sha',
    sessionId: 'session',
    reviewedAt: at,
  })
}

function deployment(
  reqId: string,
  state: 'verified' | 'failed',
  at: string,
  checks: unknown[],
): void {
  repository.recordDeployment({
    reqId,
    planVersion: 1,
    candidateSha256: `candidate-${reqId}-${at}`,
    packageVersion: '0.0.2',
    targetProfile: 'web',
    artifactSha256: 'artifact',
    runtimeVersion: '0.0.2',
    state,
    checks,
    evidenceDir: 'evidence',
    recordedBy: 'owner',
    source: 'test',
    recordedAt: at,
  })
}

describe('reliability records', () => {
  it('projects verification and business review facts in chronological order', () => {
    verification('req-a', 'block', '2026-10-05T00:00:00.000Z')
    verification('req-a', 'pass', '2026-10-06T00:00:00.000Z')
    review('req-a', 'pass', '2026-10-07T00:00:00.000Z')

    expect(repository.reliabilityVerifications()).toEqual([
      { reqId: 'req-a', verdict: 'block', verifiedAt: '2026-10-05T00:00:00.000Z' },
      { reqId: 'req-a', verdict: 'pass', verifiedAt: '2026-10-06T00:00:00.000Z' },
    ])
    expect(repository.reliabilityBusinessReviews()).toEqual([
      { reqId: 'req-a', verdict: 'pass', reviewedAt: '2026-10-07T00:00:00.000Z' },
    ])
  })

  it('projects deployment checks and counts only latest-plan task runs', () => {
    repository.recordTaskPlan(plan('req-a', 1))
    repository.recordTaskPlan(plan('req-a', 2))
    repository.recordTaskRun({
      requirementId: 'req-a',
      planVersion: 1,
      taskId: 'old',
      state: 'failed',
      reason: '',
      executedSeconds: 0,
      updatedAt: NOW,
    })
    repository.recordTaskRun({
      requirementId: 'req-a',
      planVersion: 2,
      taskId: 't1',
      state: 'delivered',
      reason: '',
      executedSeconds: 0,
      updatedAt: NOW,
    })
    deployment('req-a', 'failed', '2026-10-05T00:00:00.000Z', [
      { id: 'board', ok: false },
      { id: 'plugin', ok: true },
    ])

    expect(repository.reliabilityTaskRuns()).toEqual([{ reqId: 'req-a', state: 'delivered' }])
    expect(repository.reliabilityDeployments()).toEqual([
      {
        reqId: 'req-a',
        state: 'failed',
        recordedAt: '2026-10-05T00:00:00.000Z',
        checks: [
          { id: 'board', ok: false },
          { id: 'plugin', ok: true },
        ],
      },
    ])
  })

  it('projects failure rounds, ops events and candidate builds', () => {
    repository.recordFailureRound('req-a', {
      roundId: 'round-1',
      stage: 'formal_test',
      summary: '测试失败',
      occurredAt: NOW,
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
      openedAt: NOW,
      updatedAt: NOW,
    })
    repository.updateOpsEvent('ops-1', {
      state: 'recovered',
      recoveredAt: NOW,
      updatedAt: NOW,
    })
    repository.recordCandidateBuild({
      reqId: 'req-a',
      planVersion: 1,
      candidateSha256: 'candidate',
      verificationSha256: 'verification',
      packageVersion: '0.0.2',
      artifactSha256: 'artifact',
      tarball: 'candidate.tgz',
      files: ['a.ts'],
      gitHead: 'abc123',
      builtAt: NOW,
      evidenceDir: 'evidence',
    })

    expect(repository.reliabilityFailureRounds()).toEqual([
      { reqId: 'req-a', stage: 'formal_test', occurredAt: NOW },
    ])
    expect(repository.reliabilityOpsEvents(PROJECT)).toEqual([
      {
        eventId: 'ops-1',
        state: 'recovered',
        title: '页面不可用',
        openedAt: NOW,
        recoveredAt: NOW,
      },
    ])
    expect(repository.reliabilityCandidateBuilds()).toEqual([{ reqId: 'req-a', builtAt: NOW }])
  })
})
