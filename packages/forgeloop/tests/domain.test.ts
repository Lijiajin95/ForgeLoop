import { describe, expect, it } from 'vitest'
import {
  authorizePlan,
  bindAuthorization,
  executionOrder,
  parseTaskPlanDraft,
  requireActionablePlan,
  type TaskPlan,
} from '../src/domain/task-plan.js'
import { ApprovalBook, type Approval } from '../src/domain/approval.js'
import { GrantLedger } from '../src/domain/counting.js'
import { ExecutionBudget } from '../src/domain/limits.js'
import { buildBinding, verifyBinding } from '../src/domain/delivery.js'
import { routeStage } from '../src/domain/work.js'
import { GrantExhaustedError, MalformedError, RuleViolationError } from '../src/domain/errors.js'

const context = {
  requirementId: 'req-1',
  project: 'forgeloop',
  planVersion: 1,
  requirementVersion: 1,
  now: '2026-10-22T00:00:00.000Z',
}

function planPayload() {
  return {
    tasks: [
      {
        task_id: 'a',
        goal: 'first',
        files: ['packages/forgeloop/src/a.ts'],
        acceptance: 'works',
        test_command: ['node', '--test'],
      },
      {
        task_id: 'b',
        goal: 'second',
        files: ['packages/forgeloop/src/b.ts'],
        acceptance: 'works',
        test_command: ['node', '--test'],
        depends_on: ['a'],
      },
    ],
  }
}

describe('task plan rules', () => {
  it('accepts an actionable plan and computes topological order', () => {
    const plan = parseTaskPlanDraft(planPayload(), context)
    expect(executionOrder(plan)).toEqual(['a', 'b'])
    expect(() => requireActionablePlan(plan)).not.toThrow()
  })

  it('rejects a single-task plan as not actionable', () => {
    const payload = { tasks: [planPayload().tasks[0]] }
    expect(() => parseTaskPlanDraft(payload, context)).toThrow(/至少/)
  })

  it('rejects a plan without any dependency', () => {
    const payload = { tasks: [planPayload().tasks[0], { ...planPayload().tasks[1], depends_on: [] }] }
    expect(() => parseTaskPlanDraft(payload, context)).toThrow(/依赖/)
  })

  it('rejects unknown dependencies and cycles', () => {
    const missing = planPayload()
    missing.tasks[1]!.depends_on = ['nope']
    expect(() => parseTaskPlanDraft(missing, context)).toThrow(/不存在/)

    const cyclic = planPayload()
    cyclic.tasks[0]!.depends_on = ['b']
    expect(() => parseTaskPlanDraft(cyclic, context)).toThrow(/环/)
  })

  it('rejects absolute or escaping file paths', () => {
    const absolute = planPayload()
    absolute.tasks[0]!.files = ['/etc/passwd']
    expect(() => parseTaskPlanDraft(absolute, context)).toThrow(/相对路径/)

    const escaping = planPayload()
    escaping.tasks[0]!.files = ['../outside.ts']
    expect(() => parseTaskPlanDraft(escaping, context)).toThrow(/越出/)
  })

  it('rejects a plan that carries its own authorization source', () => {
    const payload = planPayload()
    ;(payload.tasks[0] as Record<string, unknown>).authorization_source = 'plan-approval:fake'
    expect(() => parseTaskPlanDraft(payload, context)).toThrow(MalformedError)
  })

  it('binds only to a matching approval and derives the source', () => {
    const plan = parseTaskPlanDraft(planPayload(), context)
    expect(authorizePlan(plan, null).status).toBe('missing')
    expect(
      authorizePlan(plan, {
        requirementId: 'req-2',
        planVersion: 1,
        approvedBy: 'owner',
        approvedAt: 'now',
        source: 'cmd',
      }).status,
    ).toBe('stale')
    const approval = {
      requirementId: 'req-1',
      planVersion: 1,
      approvedBy: 'owner',
      approvedAt: 'now',
      source: 'cmd',
    }
    expect(authorizePlan(plan, approval).status).toBe('approved')
    const bound = bindAuthorization(plan, approval)
    expect(bound.tasks.every((task) => task.authorizationSource === 'plan-approval:req-1:v1:owner')).toBe(true)
    expect(() => bindAuthorization(plan, { ...approval, planVersion: 2 })).toThrow(RuleViolationError)
  })
})

const binding = buildBinding({
  candidateSha256: 'a'.repeat(64),
  testEvidenceSha256: 'b'.repeat(64),
  reviewSha256: 'c'.repeat(64),
  artifactSha256: 'd'.repeat(64),
  baselineCommit: 'abc1234',
})

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    taskId: 'task-1',
    planVersion: 1,
    stage: 'plan',
    decidedAt: 'now',
    binding: null,
    approvedBy: 'owner',
    source: 'cmd',
    ...overrides,
  }
}

describe('approval consumption', () => {
  it('rejects missing, stale and repeated decisions', () => {
    const empty = new ApprovalBook()
    expect(empty.consume('task-1', 1, 'plan').status).toBe('missing')

    const book = new ApprovalBook([approval()])
    expect(book.consume('task-1', 2, 'plan').status).toBe('stale')
    expect(book.consume('task-1', 1, 'plan').status).toBe('ok')
    book.markConsumed('task-1', 1, 'plan')
    expect(book.consume('task-1', 1, 'plan').status).toBe('already_used')
  })

  it('invalidates acceptance once any bound material changes', () => {
    const book = new ApprovalBook([approval({ stage: 'acceptance', binding })])
    expect(book.consume('task-1', 1, 'acceptance', binding).status).toBe('ok')
    const changed = { ...binding, candidateSha256: 'e'.repeat(64) }
    expect(book.consume('task-1', 1, 'acceptance', changed).status).toBe('material_changed')
    expect(book.consume('task-1', 1, 'acceptance', null).status).toBe('material_changed')
  })

  it('never lets a newer approval be replaced by an older version', () => {
    const book = new ApprovalBook([approval({ planVersion: 2 })])
    expect(() => book.record(approval({ planVersion: 1 }))).toThrow(/更旧/)
  })

  it('verifies each non-empty binding field', () => {
    expect(verifyBinding(binding, binding).valid).toBe(true)
    expect(verifyBinding(binding, { ...binding, reviewSha256: 'f'.repeat(64) }).valid).toBe(false)
  })
})

describe('failure rounds and grants', () => {
  const round = (id: string) => ({
    roundId: id,
    stage: 'formal_test' as const,
    summary: 'failed',
    occurredAt: 'now',
  })

  it('counts each round once and stops at the grant quota', () => {
    const ledger = new GrantLedger(1)
    expect(ledger.recordFailure(round('r1')).recorded).toBe(true)
    expect(ledger.recordFailure(round('r1')).recorded).toBe(false)
    ledger.recordFailure(round('r2'))
    ledger.recordFailure(round('r3'))
    expect(ledger.awaitingGrantDecision).toBe(true)
    expect(() => ledger.recordFailure(round('r4'))).toThrow(GrantExhaustedError)

    ledger.appendGrant()
    expect(ledger.grantCount).toBe(2)
    expect(ledger.cumulativeFailures).toBe(3)
    expect(ledger.recordFailure(round('r4')).recorded).toBe(true)
  })

  it('rejects a ledger whose failures exceed its grants', () => {
    expect(() => new GrantLedger(1, [round('a'), round('b'), round('c'), round('d')])).toThrow(
      /超过/,
    )
  })
})

describe('execution budget', () => {
  it('charges only execution time and stops starting new actions when exhausted', () => {
    const budget = new ExecutionBudget(10)
    expect(budget.canStartAction()).toBe(true)
    budget.charge(10)
    expect(budget.exhausted).toBe(true)
    expect(budget.canStartAction()).toBe(false)
    expect(() => budget.charge(-1)).toThrow(RuleViolationError)
    budget.extend(20)
    expect(budget.canStartAction()).toBe(true)
  })

  it('rejects an extension that does not exceed consumed time', () => {
    const budget = new ExecutionBudget(10, 8)
    expect(() => budget.extend(8)).toThrow(/必须大于/)
  })
})

describe('stage routing', () => {
  it('routes a blocking review back to dev and a failing test to retry while quota remains', () => {
    expect(
      routeStage({ stage: 'review', passed: true, blockingReview: true, attempts: 1, maxAttempts: 3, grantAvailable: true, stopped: false }).next,
    ).toBe('retry_dev')
    expect(
      routeStage({ stage: 'test', passed: false, blockingReview: false, attempts: 1, maxAttempts: 3, grantAvailable: true, stopped: false }).next,
    ).toBe('retry_dev')
    expect(
      routeStage({ stage: 'test', passed: false, blockingReview: false, attempts: 1, maxAttempts: 3, grantAvailable: false, stopped: false }).state,
    ).toBe('awaiting_user')
  })

  it('stops immediately when a stop was requested', () => {
    expect(
      routeStage({ stage: 'dev', passed: true, blockingReview: false, attempts: 0, maxAttempts: 3, grantAvailable: true, stopped: true }).state,
    ).toBe('awaiting_user')
  })
})

export type { TaskPlan }