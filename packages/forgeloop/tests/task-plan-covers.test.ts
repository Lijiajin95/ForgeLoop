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

  it('splits every separator shape the model emits', () => {
    const context2 = {
      requirementId: 'req-covers-2',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(
      JSON.stringify(planWith(['BP-1:BP-2：BP-3,BP-4，BP-5;BP-6；BP-7', ' BP-8 \t BP-9 '])),
      context2,
    )
    expect(plan.tasks[0]?.covers).toEqual([
      'BP-1',
      'BP-2',
      'BP-3',
      'BP-4',
      'BP-5',
      'BP-6',
      'BP-7',
      'BP-8',
      'BP-9',
    ])
  })

  it('drops acceptance ids wherever they appear and deduplicates points', () => {
    const context3 = {
      requirementId: 'req-covers-3',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(
      JSON.stringify(planWith(['AC-1', 'BP-2:AC-12', 'BP-2', 'BP-3'])),
      context3,
    )
    expect(plan.tasks[0]?.covers).toEqual(['BP-2', 'BP-3'])
  })

  it('keeps covers undefined when the draft omits the field', () => {
    const context4 = {
      requirementId: 'req-covers-4',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(undefined)), context4)
    expect(plan.tasks[0]?.covers).toBeUndefined()
  })

  it('rejects ids that merely contain a business point id', () => {
    const context6 = {
      requirementId: 'req-covers-6',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    // 只匹配前缀 / 后缀的编号都不是合法业务点，必须拒绝。
    for (const bad of ['xBP-1', 'BP-1x', 'BP-1 BP-2x', 'BPX-1']) {
      expect(() => parseTaskPlanDraft(JSON.stringify(planWith([bad])), context6)).toThrow(/BP-1/)
    }
  })

  it('separates explicit empty covers from an omitted field', () => {
    const context7 = {
      requirementId: 'req-covers-7',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const omitted = parseTaskPlanDraft(JSON.stringify(planWith(undefined)), context7)
    expect(omitted.tasks[0]?.covers).toBeUndefined()
    const empty = parseTaskPlanDraft(JSON.stringify(planWith([])), context7)
    expect(empty.tasks[0]?.covers).toEqual([])
  })

  it('rejects a covers list that repeats a point before normalization', () => {
    const context8 = {
      requirementId: 'req-covers-8',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    expect(() =>
      parseTaskPlanDraft(JSON.stringify(planWith(['BP-3', 'BP-1', 'BP-3'])), context8),
    ).toThrow('不能包含重复项')
  })

  it('rejects ids that match only the prefix or suffix of an acceptance id', () => {
    const contextA = {
      requirementId: 'req-covers-a',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    // 'AC-1x' 只匹配前缀、'xAC-1' 只匹配后缀：都不该被当作验收项丢弃，必须交给校验拒绝。
    for (const bad of ['AC-1x', 'xAC-1']) {
      expect(() => parseTaskPlanDraft(JSON.stringify(planWith([bad])), contextA)).toThrow(/BP-1/)
    }
  })

  it('accepts multi-digit business points and rejects non-digit suffixes', () => {
    const contextB = {
      requirementId: 'req-covers-b',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(['BP-12', 'BP-1'])), contextB)
    expect(plan.tasks[0]?.covers).toEqual(['BP-12', 'BP-1'])
    expect(() => parseTaskPlanDraft(JSON.stringify(planWith(['BP-1_'])), contextB)).toThrow(/BP-1/)
  })

  it('drops empty fragments produced by adjacent separators', () => {
    const contextC = {
      requirementId: 'req-covers-c',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(['BP-1::BP-2'])), contextC)
    expect(plan.tasks[0]?.covers).toEqual(['BP-1', 'BP-2'])
  })

  it('leaves the authorization source empty on a freshly parsed task', () => {
    const contextD = {
      requirementId: 'req-covers-d',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(['BP-1'])), contextD)
    expect(plan.tasks[0]?.authorizationSource).toBe('')
  })

  it('splits Chinese punctuation without surrounding spaces', () => {
    const contextE = {
      requirementId: 'req-covers-e',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(JSON.stringify(planWith(['BP-1：BP-2，BP-3；BP-4'])), contextE)
    expect(plan.tasks[0]?.covers).toEqual(['BP-1', 'BP-2', 'BP-3', 'BP-4'])

    // 顿号不在分隔符集合内：整段保留，交给校验拒绝，而不是被静默拆开。
    expect(() => parseTaskPlanDraft(JSON.stringify(planWith(['BP-1、BP-2'])), contextE)).toThrow(
      /BP-1/,
    )
  })

  it('drops acceptance ids and duplicates in the same pass', () => {
    const contextF = {
      requirementId: 'req-covers-f',
      project: 'p',
      planVersion: 1,
      requirementVersion: 1,
      now: '2026-11-08T00:00:00.000Z',
    }
    const plan = parseTaskPlanDraft(
      JSON.stringify(planWith(['AC-7:BP-1:BP-1', 'AC-8', 'BP-2'])),
      contextF,
    )
    expect(plan.tasks[0]?.covers).toEqual(['BP-1', 'BP-2'])
  })
})
