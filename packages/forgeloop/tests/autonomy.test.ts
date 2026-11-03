import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/records/db.js'
import { Repository } from '../src/records/repository.js'
import {
  computeAutonomyStats,
  EMPTY_AUTONOMY_STATS,
  opsAutonomousSuccess,
  requirementAutonomousSuccess,
  requirementHumanInvolved,
  type RequirementAutonomyFacts,
} from '../src/domain/autonomy.js'
import { buildAutonomyStats } from '../src/runtime/autonomy-stats.js'
import { buildStatusBoard } from '../src/runtime/board.js'
import { extendWorkBudget } from '../src/runtime/budget.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

const PROJECT = 'forgeloop'
const NOW = '2026-11-03T10:00:00.000Z'

function facts(overrides: Partial<RequirementAutonomyFacts> = {}): RequirementAutonomyFacts {
  return {
    status: 'executing',
    versionCount: 1,
    grants: 1,
    budgetExtensions: 0,
    stopped: false,
    cancelled: false,
    humanRequests: 0,
    committed: false,
    verificationPassed: false,
    ...overrides,
  }
}

function plan(reqId: string): TaskPlan {
  return {
    taskPlanId: `plan-${reqId}`,
    requirementId: reqId,
    project: PROJECT,
    planVersion: 1,
    requirementVersion: 1,
    createdAt: NOW,
    tasks: [
      {
        taskId: 't1',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: 'a 存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: -1, maxFailureRounds: -1 },
        authorizationSource: '',
      },
    ],
  }
}

describe('autonomy domain', () => {
  it('returns null rates when there is no sample', () => {
    expect(EMPTY_AUTONOMY_STATS.requirements.involvementRate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
    })
    expect(EMPTY_AUTONOMY_STATS.ops.autonomousSuccessRate.rate).toBeNull()
  })

  it('treats a first-version requirement with no owner action as autonomous', () => {
    expect(requirementHumanInvolved(facts())).toBe(false)
  })

  it.each([
    ['修订版本', { versionCount: 2 }],
    ['追加授权', { grants: 2 }],
    ['延长工时', { budgetExtensions: 1 }],
    ['请求停止', { stopped: true }],
    ['取消需求', { cancelled: true }],
    ['人工请求', { humanRequests: 1 }],
  ])('%s counts as human involvement', (_label, overrides) => {
    expect(requirementHumanInvolved(facts(overrides))).toBe(true)
  })

  it('requires a commit and a passing verification for autonomous success', () => {
    expect(requirementAutonomousSuccess(facts({ committed: true }))).toBe(false)
    expect(requirementAutonomousSuccess(facts({ committed: true, verificationPassed: true }))).toBe(
      true,
    )
    expect(
      requirementAutonomousSuccess(facts({ committed: true, verificationPassed: true, grants: 2 })),
    ).toBe(false)
  })

  it('counts only recovered or closed ops events without human involvement', () => {
    expect(opsAutonomousSuccess({ state: 'recovered', humanInvolved: false })).toBe(true)
    expect(opsAutonomousSuccess({ state: 'closed', humanInvolved: false })).toBe(true)
    expect(opsAutonomousSuccess({ state: 'open', humanInvolved: false })).toBe(false)
    expect(opsAutonomousSuccess({ state: 'recovered', humanInvolved: true })).toBe(false)
  })

  it('computes mixed requirement and ops samples', () => {
    const stats = computeAutonomyStats(
      [
        facts({ status: 'committed', committed: true, verificationPassed: true }),
        facts({ grants: 2 }),
      ],
      [
        { state: 'recovered', humanInvolved: false },
        { state: 'closed', humanInvolved: true },
      ],
    )
    expect(stats.requirements.involvementRate.rate).toBe(0.5)
    expect(stats.requirements.autonomousSuccessRate).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    })
    expect(stats.ops.involvementRate.rate).toBe(0.5)
    expect(stats.ops.autonomousSuccessRate.rate).toBe(0.5)
  })
})

describe('autonomy records', () => {
  let dir = ''
  let database: Database
  let repository: Repository

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forgeloop-autonomy-'))
    database = Database.open(join(dir, 'records.sqlite'))
    repository = new Repository(database)
  })

  afterEach(() => {
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function submit(reqId: string): string {
    repository.submit({
      reqId,
      project: PROJECT,
      text: '自主率统计',
      submittedBy: 'owner',
      source: 'test',
      now: NOW,
    })
    return reqId
  }

  function markCommitted(reqId: string): void {
    repository.recordTaskPlan(plan(reqId))
    repository.recordVerification({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: `candidate-${reqId}`,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: '{}',
      reportPath: join(dir, 'verification.json'),
      reportSha256: 'report',
      evidenceDir: dir,
      sessionId: 'session-verification',
      verifiedAt: NOW,
    })
    repository.recordCommit({
      requirementId: reqId,
      planVersion: 1,
      candidateSha256: `candidate-${reqId}`,
      commitSha: 'abc123',
      commitMessage: 'feat: demo',
      checkCommand: ['make', 'check'],
      checkLogPath: join(dir, 'check.log'),
      checkSha256: 'check',
      files: ['docs/a.md'],
      committedAt: NOW,
    })
    repository.setStatus(reqId, 'committed')
  }

  it('counts a verified committed requirement as autonomous success', () => {
    const reqId = submit('req-autonomous')
    markCommitted(reqId)
    const stats = buildAutonomyStats(repository, PROJECT, 'owner')
    expect(stats.requirements.total).toBe(1)
    expect(stats.requirements.autonomousSuccess).toBe(1)
    expect(stats.requirements.involvementRate.rate).toBe(0)
    expect(stats.requirements.autonomousSuccessRate.rate).toBe(1)
  })

  it('records budget extensions and counts them as human involvement', () => {
    const reqId = submit('req-extended')
    const result = extendWorkBudget(repository, {
      reqId,
      seconds: -1,
      by: 'owner',
      source: 'web:extend-budget',
      now: NOW,
    })
    expect(result.ok).toBe(true)
    expect(repository.budget(reqId).limitSeconds).toBe(-1)
    expect(repository.budgetExtensions(reqId)).toEqual([
      {
        seconds: -1,
        extendedBy: 'owner',
        source: 'web:extend-budget',
        extendedAt: NOW,
      },
    ])
    const stats = buildAutonomyStats(repository, PROJECT, 'owner')
    expect(stats.requirements.humanInvolved).toBe(1)
    expect(stats.requirements.involvementRate.rate).toBe(1)
  })

  it('counts owner requests and human web decisions as involvement', () => {
    const ownerReq = submit('req-owner-request')
    repository.recordRequest({
      requestId: 'request-owner',
      reqId: ownerReq,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'owner',
      source: 'service',
      now: NOW,
    })
    const webReq = submit('req-web-request')
    repository.recordRequest({
      requestId: 'request-web',
      reqId: webReq,
      project: PROJECT,
      planVersion: 1,
      action: 'advance',
      requestedBy: 'forgeloop',
      source: 'web-decision:approve',
      now: NOW,
    })
    const stats = buildAutonomyStats(repository, PROJECT, 'owner')
    expect(stats.requirements.humanInvolved).toBe(2)
  })

  it('counts and exposes ops autonomy through the status board', () => {
    const reqId = submit('req-board')
    markCommitted(reqId)
    submit('req-human')
    repository.recordStop({
      requirementId: 'req-human',
      requestedBy: 'owner',
      reason: '人工停止',
      requestedAt: NOW,
    })
    repository.createOpsEvent({
      eventId: 'ops-1',
      project: PROJECT,
      resourceId: 'local',
      checkId: 'disk',
      signature: 'disk-full',
      severity: 'minor',
      state: 'open',
      title: '磁盘告警',
      openedAt: NOW,
      updatedAt: NOW,
    })
    repository.updateOpsEvent('ops-1', { state: 'recovered', recoveredAt: NOW, updatedAt: NOW })
    repository.createOpsEvent({
      eventId: 'ops-2',
      project: PROJECT,
      resourceId: 'local',
      checkId: 'memory',
      signature: 'memory-high',
      severity: 'minor',
      state: 'open',
      title: '内存告警',
      openedAt: NOW,
      updatedAt: NOW,
    })
    repository.updateOpsEvent('ops-2', {
      state: 'closed',
      closedAt: NOW,
      humanInvolved: true,
      humanReason: '所有者手动关闭',
      updatedAt: NOW,
    })

    const board = buildStatusBoard({
      repository,
      project: PROJECT,
      now: NOW,
      owner: 'owner',
    })
    expect(board.autonomy.requirements.total).toBe(2)
    expect(board.autonomy.requirements.autonomousSuccess).toBe(1)
    expect(board.autonomy.requirements.involvementRate).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    })
    expect(board.autonomy.ops.total).toBe(2)
    expect(board.autonomy.ops.autonomousSuccess).toBe(1)
    expect(board.autonomy.ops.involvementRate.rate).toBe(0.5)
  })
})
