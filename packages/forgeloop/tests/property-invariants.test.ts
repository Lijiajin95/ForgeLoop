import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { retryDecision, type RetryFacts } from '../src/domain/retry-policy.js'
import { parseTaskPlanDraft } from '../src/domain/task-plan.js'

const RETRYABLE = new Set(['approved', 'executing', 'blocked'])
const HARD_BLOCKS = ['额度已用尽', '工时已用尽', '需要追加授权', '终态']

const facts = fc.record<RetryFacts>({
  status: fc.constantFrom(
    'draft',
    'analyzing',
    'approved',
    'executing',
    'blocked',
    'accepted',
    'cancelled',
  ),
  blockedReason: fc.oneof(fc.constant(''), fc.constantFrom(...HARD_BLOCKS), fc.string()),
  remainingRounds: fc.integer({ min: 0, max: 5 }),
  activeRequest: fc.boolean(),
  runningTasks: fc.integer({ min: 0, max: 3 }),
  awaitingInputTasks: fc.integer({ min: 0, max: 3 }),
  planApproved: fc.boolean(),
  delivered: fc.integer({ min: 0, max: 5 }),
  total: fc.integer({ min: 0, max: 5 }),
})

describe('property invariants', () => {
  it('only allows retry when every blocking fact is clear', () => {
    fc.assert(
      fc.property(facts, (input) => {
        const decision = retryDecision(input)
        if (!decision.allowed) return
        expect(RETRYABLE.has(input.status)).toBe(true)
        expect(input.planApproved).toBe(true)
        expect(input.total).toBeGreaterThan(0)
        expect(input.delivered).toBeLessThan(input.total)
        expect(input.activeRequest).toBe(false)
        expect(input.runningTasks).toBe(0)
        expect(input.awaitingInputTasks).toBe(0)
        expect(input.remainingRounds).toBeGreaterThan(0)
        expect(HARD_BLOCKS.some((text) => input.blockedReason.includes(text))).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('is deterministic for the same facts', () => {
    fc.assert(
      fc.property(facts, (input) => {
        expect(retryDecision(input)).toEqual(retryDecision({ ...input }))
      }),
      { numRuns: 50 },
    )
  })

  it('round-trips a serialized plan without losing task identity', () => {
    const body = fc.record({
      goal: fc.stringMatching(/^\S.{0,39}$/),
      files: fc
        .uniqueArray(fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/), { minLength: 1, maxLength: 3 })
        .map((names) => names.map((name) => `src/${name}.ts`)),
      acceptance: fc.stringMatching(/^\S.{0,39}$/),
      test_command: fc.array(fc.stringMatching(/^\S{1,20}$/), { minLength: 1, maxLength: 2 }),
    })
    fc.assert(
      fc.property(
        fc.array(body, { minLength: 2, maxLength: 4 }),
        fc.integer({ min: 1, max: 99 }),
        (bodies, planVersion) => {
          const tasks = bodies.map((item, index) => ({
            task_id: `t${index}`,
            ...item,
            depends_on: index === 0 ? [] : [`t${index - 1}`],
          }))
          const draft = {
            plan_version: planVersion,
            requirement_version: 1,
            project: 'proj',
            tasks,
          }
          const parsed = parseTaskPlanDraft(draft, {
            requirementId: 'req-1',
            project: 'proj',
            planVersion,
            requirementVersion: 1,
            now: '2026-11-01T00:00:00.000Z',
          })
          expect(parsed.planVersion).toBe(planVersion)
          expect(parsed.tasks.map((item) => item.taskId)).toEqual(tasks.map((item) => item.task_id))
          expect(
            parsed.tasks.every((item) => item.files.every((file) => typeof file === 'string')),
          ).toBe(true)
        },
      ),
      { numRuns: 50 },
    )
  })
})
