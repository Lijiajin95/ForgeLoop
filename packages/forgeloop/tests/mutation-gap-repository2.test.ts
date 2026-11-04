import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import type { TaskPlan, TaskPlanApproval } from '../src/domain/task-plan.js'
import type { CodeCandidateRecord } from '../src/records/rows.js'

let dir = ''
let database: Database
let repository: Repository

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-repo-gap2-'))
  database = Database.open(join(dir, 'records.sqlite'))
  repository = new Repository(database)
  repository.submit({
    reqId: 'req-1',
    project: 'demo',
    text: '原文',
    submittedBy: 'owner',
    source: 'test',
    now: '2026-11-04T00:00:00.000Z',
  })
})

afterEach(() => {
  repository.close()
  rmSync(dir, { recursive: true, force: true })
})

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 't1',
        goal: '做',
        files: ['packages/a.ts'],
        acceptance: '验收',
        testCommand: ['npm', 'test'],
        dependsOn: [],
        limits: { limitSeconds: 60, maxFailureRounds: 2 },
        authorizationSource: '',
      },
    ],
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

function approval(overrides: Partial<TaskPlanApproval> = {}): TaskPlanApproval {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: '2026-11-04T00:00:00.000Z',
    source: 'test',
    ...overrides,
  }
}

function candidate(overrides: Partial<CodeCandidateRecord> = {}): CodeCandidateRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath: '/tmp/diff',
    diffSha256: 'd'.repeat(64),
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('task plans and approvals', () => {
  it('round-trips plans, rejects invalid plans and reports latest', () => {
    expect(repository.nextPlanVersion('req-1')).toBe(1)
    expect(repository.latestTaskPlan('req-1')).toBeNull()
    expect(repository.taskPlan('req-1', 1)).toBeNull()
    repository.recordTaskPlan(plan())
    repository.recordTaskPlan(plan({ planVersion: 2, taskPlanId: 'plan-2' }))
    expect(repository.nextPlanVersion('req-1')).toBe(3)
    expect(repository.taskPlans('req-1').map((item) => item.planVersion)).toEqual([1, 2])
    expect(repository.latestTaskPlan('req-1')?.taskPlanId).toBe('plan-2')
    expect(repository.taskPlan('req-1', 1)?.tasks[0]?.taskId).toBe('t1')
    expect(() => repository.recordTaskPlan(plan({ tasks: [] }))).toThrow('任务包至少要有一个任务')
  })

  it('upserts approvals and returns the latest by plan version', () => {
    expect(repository.planApproval('req-1', 1)).toBeNull()
    expect(repository.latestPlanApproval('req-1')).toBeNull()
    repository.recordPlanApproval(approval())
    repository.recordPlanApproval(approval({ approvedBy: 'admin', source: 'cli' }))
    expect(repository.planApproval('req-1', 1)).toMatchObject({
      approvedBy: 'admin',
      source: 'cli',
    })
    repository.recordPlanApproval(approval({ planVersion: 2, approvedBy: 'owner' }))
    expect(repository.latestPlanApproval('req-1')?.planVersion).toBe(2)
    expect(repository.planApproval('req-1', 9)).toBeNull()
  })
})

describe('admissions', () => {
  const basis = {
    policyVersion: 'v1',
    source: 'test',
    submittedBy: 'owner',
    owner: 'owner',
    project: 'demo',
    projectPath: '/tmp/demo',
    requirementVersion: 1,
    analysisVersion: 1,
    trustedSource: true,
    allowAnySource: false,
    requireOwner: true,
    codeCommitAllowed: true,
  }

  it('stores admit/block decisions and selects the latest by version', () => {
    const admitted = repository.recordAdmission({
      requirementId: 'req-1',
      requirementVersion: 1,
      decision: { admit: true, code: 'ok', reason: '允许', basis },
      decidedBy: 'system',
      createdAt: '2026-11-04T00:00:00.000Z',
    })
    expect(admitted).toMatchObject({ decision: 'admit', code: 'ok', policyVersion: 'v1' })
    repository.recordAdmission({
      requirementId: 'req-1',
      requirementVersion: 2,
      decision: {
        admit: false,
        code: 'blocked',
        reason: '拒绝',
        basis: { ...basis, requirementVersion: 2 },
      },
      decidedBy: 'system',
      createdAt: '2026-11-04T00:01:00.000Z',
    })
    expect(repository.admissionsFor('req-1').map((item) => item.decision)).toEqual([
      'admit',
      'block',
    ])
    expect(repository.latestAdmission('req-1')?.requirementVersion).toBe(2)
    expect(repository.latestAdmission('req-1', 1)?.decision).toBe('admit')
    expect(repository.latestAdmission('missing')).toBeNull()
    expect(repository.admissionsFor('missing')).toEqual([])
  })
})

describe('stops', () => {
  it('records, settles and resumes a stop', () => {
    expect(repository.stop('req-1')).toBeNull()
    expect(repository.activeStop('req-1')).toBeNull()
    const stop = repository.recordStop({
      requirementId: 'req-1',
      requestedBy: 'owner',
      reason: '暂停',
      requestedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(stop).toMatchObject({
      requestedBy: 'owner',
      reason: '暂停',
      settledAt: '',
      resumedAt: '',
    })
    repository.markStopSettled('req-1', '2026-11-04T00:01:00.000Z')
    expect(repository.stop('req-1')?.settledAt).toBe('2026-11-04T00:01:00.000Z')
    expect(repository.activeStop('req-1')?.settledAt).toBe('2026-11-04T00:01:00.000Z')
    repository.resumeStop({
      requirementId: 'req-1',
      resumedBy: 'owner',
      reason: '继续',
      resumedAt: '2026-11-04T00:02:00.000Z',
    })
    expect(repository.activeStop('req-1')).toBeNull()
    repository.recordStop({
      requirementId: 'req-1',
      requestedBy: 'owner',
      reason: '再停',
      requestedAt: '2026-11-04T00:03:00.000Z',
    })
    expect(repository.activeStop('req-1')).toMatchObject({
      reason: '再停',
      settledAt: '',
      resumedAt: '',
    })
  })
})

describe('code candidates', () => {
  it('records and selects candidates by version and digest', () => {
    expect(repository.codeCandidates('req-1', 1)).toEqual([])
    expect(repository.latestCodeCandidate('req-1', 1)).toBeNull()
    repository.recordCodeCandidate(candidate())
    repository.recordCodeCandidate(
      candidate({ candidateVersion: 2, candidateSha256: 'e'.repeat(64) }),
    )
    expect(repository.codeCandidates('req-1', 1).map((item) => item.candidateVersion)).toEqual([
      1, 2,
    ])
    expect(repository.latestCodeCandidate('req-1', 1)?.candidateSha256).toBe('e'.repeat(64))
    expect(repository.codeCandidate('req-1', 1, 'c'.repeat(64))?.candidateVersion).toBe(1)
    expect(repository.codeCandidate('req-1', 1, 'f'.repeat(64))).toBeNull()
    expect(repository.codeCandidates('req-1', 2)).toEqual([])
  })
})
