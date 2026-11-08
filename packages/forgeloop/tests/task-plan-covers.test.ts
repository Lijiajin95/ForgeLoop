import { describe, expect, it } from 'vitest'
import { parseTaskPlanDraft } from '../src/domain/task-plan.js'

function planWith(covers: unknown): unknown {
  return {
    tasks: [
      {
        task_id: 't1',
        goal: 'g',
        files: ['a.ts'],
        acceptance: 'a',
        test_command: ['node', '-e', 'process.exit(0)'],
        depends_on: [],
        limits: { limit_seconds: 60, max_failure_rounds: 2 },
        covers,
      },
    ],
    technical_solution: { summary: 's', approach: ['a'], risks: [] },
  }
}

describe('covers normalization', () => {
  const context = {
    requirementId: 'req-covers',
    project: 'p',
    planVersion: 1,
    requirementVersion: 1,
    now: '2026-11-08T00:00:00.000Z',
  }

  it('splits concatenated ids and keeps business point ids', () => {
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(['BP-1: BP-1: AC-1', 'BP-2'])), context)
    expect(plan.tasks[0]?.covers).toEqual(['BP-1', 'BP-2'])
  })

  it('still rejects unknown id shapes that are not business points', () => {
    expect(() => parseTaskPlanDraft(JSON.stringify(planWith(['XX-1'])), context)).toThrow(/BP-1/)
  })
})
