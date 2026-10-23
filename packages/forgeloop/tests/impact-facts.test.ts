import { describe, expect, it } from 'vitest'
import {
  buildImpactFacts,
  type ImpactInput,
} from '../src/domain/impact.js'
import type { Requirement, RequirementAnalysis, RequirementVersion } from '../src/domain/requirement.js'
import type { PlannedTask, TaskPlan, TaskPlanApproval } from '../src/domain/task-plan.js'
import type { TaskArtifact } from '../src/domain/work.js'
import * as impact from '../src/domain/impact.js'

const T0 = '2026-10-22T00:00:00.000Z'
const T1 = '2026-10-22T00:10:00.000Z'

function version(n: number, source = 'test'): RequirementVersion {
  return {
    version: n,
    text: `requirement text v${n}`,
    createdAt: n === 1 ? T0 : T1,
    revisedBy: n === 1 ? 'owner' : 'owner-revise',
    source,
  }
}

function requirement(versions: RequirementVersion[], status = 'draft'): Requirement {
  return {
    reqId: 'req-impact-1',
    project: 'forgeloop',
    status,
    blockedReason: '',
    versions,
    submittedBy: 'owner',
    source: 'test',
  }
}

function task(taskId: string, dependsOn: string[] = []): PlannedTask {
  return {
    taskId,
    goal: `goal-${taskId}`,
    files: [`packages/forgeloop/src/${taskId}.ts`],
    acceptance: `accept-${taskId}`,
    testCommand: ['npm', 'run', 'check', '--workspace', 'forgeloop-dsh'],
    dependsOn,
    limits: { limitSeconds: 7200, maxFailureRounds: 3 },
    authorizationSource: '',
  }
}

function plan(planVersion: number, requirementVersion: number, tasks: PlannedTask[]): TaskPlan {
  return {
    taskPlanId: `plan-req-impact-1-${planVersion}`,
    requirementId: 'req-impact-1',
    project: 'forgeloop',
    planVersion,
    requirementVersion,
    tasks,
    createdAt: T0,
  }
}

function analysis(analysisVersion: number, requirementVersion: number): RequirementAnalysis {
  return {
    analysisVersion,
    requirementVersion,
    goal: `goal-v${analysisVersion}`,
    scenarios: ['scenario'],
    acceptanceCriteria: ['acceptance'],
    clarifications: [],
    createdAt: T0,
  }
}

function approval(planVersion: number): TaskPlanApproval {
  return {
    requirementId: 'req-impact-1',
    planVersion,
    approvedBy: 'owner',
    approvedAt: T1,
    source: 'dsh-command:test',
  }
}

function artifact(planVersion: number, taskId: string, overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return {
    requirementId: 'req-impact-1',
    planVersion,
    taskId,
    candidateSha256: 'a'.repeat(64),
    testEvidenceSha256: 'b'.repeat(64),
    reviewSha256: 'c'.repeat(64),
    acceptance: 'accepted',
    authorizationSource: `plan-approval:req-impact-1:v${planVersion}:owner`,
    recordedAt: T1,
    baselineCommit: 'abc1234',
    ...overrides,
  }
}

describe('impact facts: requirement revision is stale', () => {
  it('marks analyses, plans, approvals and deliveries based on an older requirement version as stale', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1, 'dsh-command:submit'), version(2, 'dsh-command:revise')]),
      analyses: [analysis(1, 1)],
      plans: [plan(1, 1, [task('a'), task('b', ['a'])])],
      approvals: [approval(1)],
      deliveries: [artifact(1, 'a')],
      requests: [
        {
          requestId: 'rq-unknown',
          action: 'advance',
          state: 'unknown',
          planVersion: 1,
          createdAt: T1,
        },
      ],
    })

    expect(facts.kind).toBe('facts')
    expect(facts.latestRequirementVersion).toBe(2)
    expect(facts.requirementVersions).toEqual([
      { version: 1, createdAt: T0, revisedBy: 'owner', source: 'dsh-command:submit', latest: false },
      { version: 2, createdAt: T1, revisedBy: 'owner-revise', source: 'dsh-command:revise', latest: true },
    ])

    expect(facts.analyses[0]).toMatchObject({
      analysisVersion: 1,
      requirementVersion: 1,
      stale: true,
      latest: true,
    })
    expect(facts.analyses[0]?.staleReasons.map((item) => item.code)).toContain(
      'analysis_requirement_stale',
    )

    expect(facts.plans[0]).toMatchObject({
      planVersion: 1,
      requirementVersion: 1,
      stale: true,
      latest: true,
    })
    expect(facts.plans[0]?.tasks.map((item) => item.taskId)).toEqual(['a', 'b'])
    expect(facts.plans[0]?.tasks[0]).toMatchObject({ delivered: true, stale: true })
    expect(facts.plans[0]?.tasks[1]).toMatchObject({ delivered: false, stale: true, pending: true })
    expect(facts.plans[0]?.tasks[1]?.pendingReasons.map((item) => item.code)).toContain(
      'task_not_delivered',
    )

    expect(facts.currentApproval).toMatchObject({
      planVersion: 1,
      requirementVersion: 1,
      current: true,
      stale: true,
    })
    expect(facts.currentApprovalPlanVersion).toBe(1)

    expect(facts.deliveries).toHaveLength(1)
    expect(facts.deliveries[0]).toMatchObject({ planVersion: 1, taskId: 'a', stale: true })
    expect(facts.deliveries[0]?.material).toMatchObject({
      candidateSha256: 'a'.repeat(64),
      testEvidenceSha256: 'b'.repeat(64),
      reviewSha256: 'c'.repeat(64),
      baselineCommit: 'abc1234',
    })

    expect(facts.requests[0]).toMatchObject({
      requestId: 'rq-unknown',
      requestState: 'unknown',
      pending: true,
    })
    expect(facts.requests[0]?.pendingReasons.map((item) => item.code)).toContain(
      'request_result_unknown',
    )

    expect(facts.stale).toBe(true)
    expect(facts.pending).toBe(true)
    expect(facts.state).toBe('stale_pending')
    expect(facts.pendingReasons.map((item) => item.code)).toEqual(
      expect.arrayContaining(['request_result_unknown', 'unknown_requests_pending']),
    )
  })

  it('keeps an old but fully delivered and approved version stale without marking it pending', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1), version(2)]),
      analyses: [analysis(1, 1)],
      plans: [plan(1, 1, [task('a'), task('b', ['a'])])],
      approvals: [approval(1)],
      deliveries: [artifact(1, 'a'), artifact(1, 'b')],
    })

    expect(facts.stale).toBe(true)
    expect(facts.pending).toBe(false)
    expect(facts.state).toBe('stale')
    expect(facts.pendingReasons).toEqual([])
    expect(facts.analyses.every((item) => item.stale && !item.pending)).toBe(true)
    expect(facts.plans.every((item) => item.stale && !item.pending)).toBe(true)
    expect(facts.currentApproval).toMatchObject({ stale: true, pending: false })
    expect(facts.deliveries.every((item) => item.stale && !item.pending)).toBe(true)
  })

  it('does not treat undelivered tasks of a superseded plan as current pending work', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1), version(2)]),
      analyses: [analysis(1, 1), analysis(2, 2)],
      plans: [plan(1, 1, [task('old')]), plan(2, 2, [task('a'), task('b', ['a'])])],
      approvals: [approval(2)],
      deliveries: [artifact(2, 'a'), artifact(2, 'b')],
    })

    const oldPlan = facts.plans.find((item) => item.planVersion === 1)
    expect(oldPlan?.stale).toBe(true)
    expect(oldPlan?.tasks[0]).toMatchObject({ delivered: false, stale: true, pending: false })
    expect(facts.stale).toBe(true)
    expect(facts.pending).toBe(false)
    expect(facts.coverage.fullyDelivered).toBe(true)
  })
})

describe('impact facts: requirement is still valid', () => {
  it('reports a fully delivered, fully consistent requirement as current without stale or pending items', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1), version(2)], 'accepted'),
      analyses: [analysis(2, 2)],
      plans: [plan(2, 2, [task('a'), task('b', ['a'])])],
      approvals: [approval(2)],
      deliveries: [artifact(2, 'a'), artifact(2, 'b')],
      requests: [
        { requestId: 'rq-done', action: 'advance', state: 'done', planVersion: 2, createdAt: T1 },
      ],
    })

    expect(facts.latestRequirementVersion).toBe(2)
    expect(facts.stale).toBe(false)
    expect(facts.pending).toBe(false)
    expect(facts.state).toBe('current')
    expect(facts.staleReasons).toEqual([])
    expect(facts.pendingReasons).toEqual([])

    expect(facts.coverage).toEqual({
      analyzed: true,
      planned: true,
      approved: true,
      fullyDelivered: true,
    })
    expect(facts.currentApproval).toMatchObject({
      planVersion: 2,
      requirementVersion: 2,
      current: true,
      stale: false,
      pending: false,
    })
    expect(facts.plans[0]?.tasks.every((item) => item.delivered && item.state === 'current')).toBe(true)
    expect(facts.deliveries.every((item) => item.state === 'current')).toBe(true)
    expect(facts.requests[0]?.state).toBe('current')
  })
})

describe('impact facts: requirement was never planned', () => {
  it('returns empty analysis/plan/approval/delivery facts and marks the gaps as pending instead of failing', () => {
    const facts = buildImpactFacts({ requirement: requirement([version(1)]) })

    expect(facts.latestRequirementVersion).toBe(1)
    expect(facts.requirementVersions).toHaveLength(1)
    expect(facts.analyses).toEqual([])
    expect(facts.plans).toEqual([])
    expect(facts.approvals).toEqual([])
    expect(facts.deliveries).toEqual([])
    expect(facts.requests).toEqual([])
    expect(facts.currentApproval).toBeNull()
    expect(facts.latestAnalysisVersion).toBeNull()
    expect(facts.latestPlanVersion).toBeNull()
    expect(facts.currentApprovalPlanVersion).toBeNull()

    expect(facts.coverage).toEqual({
      analyzed: false,
      planned: false,
      approved: false,
      fullyDelivered: false,
    })
    expect(facts.stale).toBe(false)
    expect(facts.pending).toBe(true)
    expect(facts.state).toBe('pending')
    expect(facts.pendingReasons.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'requirement_analysis_missing',
        'requirement_plan_missing',
        'requirement_approval_missing',
      ]),
    )
    expect(facts.summary).toMatchObject({
      requirementVersions: 1,
      analyses: 0,
      plans: 0,
      approvals: 0,
      deliveredTasks: 0,
    })
  })
})

describe('impact facts: inconsistent versions and unknown requests need review', () => {
  it('marks mismatched analysis/plan/approval versions and unknown requests as pending without inventing stale versions', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1), version(2)]),
      analyses: [analysis(2, 2)],
      plans: [plan(2, 2, [task('a')])],
      approvals: [approval(1)],
      deliveries: [artifact(2, 'a')],
      requests: [
        { requestId: 'rq-unknown', action: 'advance', state: 'unknown', planVersion: 2, createdAt: T1 },
      ],
    })

    expect(facts.stale).toBe(false)
    expect(facts.pending).toBe(true)
    expect(facts.state).toBe('pending')

    expect(facts.approvals[0]).toMatchObject({
      planVersion: 1,
      requirementVersion: null,
      current: true,
      pending: true,
    })
    expect(facts.approvals[0]?.pendingReasons.map((item) => item.code)).toEqual(
      expect.arrayContaining(['approval_plan_missing', 'approval_plan_version_mismatch']),
    )
    expect(facts.plans[0]?.pendingReasons.map((item) => item.code)).toContain(
      'plan_approval_missing',
    )
    expect(facts.requests[0]?.pending).toBe(true)
    expect(facts.pendingReasons.map((item) => item.code)).toEqual(
      expect.arrayContaining(['unknown_requests_pending', 'latest_plan_approval_missing']),
    )
  })

  it('marks analysis/plan requirement-version disagreement as pending on both sides', () => {
    const facts = buildImpactFacts({
      requirement: requirement([version(1), version(2)]),
      analyses: [analysis(2, 2)],
      plans: [plan(1, 1, [task('a')])],
      approvals: [approval(1)],
      deliveries: [artifact(1, 'a')],
    })

    expect(facts.stale).toBe(true)
    expect(facts.pending).toBe(true)
    expect(facts.plans[0]?.stale).toBe(true)
    expect(facts.plans[0]?.pendingReasons.map((item) => item.code)).toContain(
      'analysis_plan_requirement_mismatch',
    )
    expect(facts.analyses[0]?.pendingReasons.map((item) => item.code)).toContain(
      'analysis_plan_requirement_mismatch',
    )
  })
})

describe('impact facts: read-only surface', () => {
  it('only exposes the fact builder and no approve/advance/accept mutation entry points', () => {
    const exports = Object.keys(impact)
    expect(exports).toContain('buildImpactFacts')
    for (const name of exports) {
      expect(name).not.toMatch(/^(approve|advance|accept|submit|revise|cancel|stop|grant|recover|record|write)/i)
    }
    const input: ImpactInput = { requirement: requirement([version(1)]) }
    expect(() => buildImpactFacts(input)).not.toThrow()
  })
})