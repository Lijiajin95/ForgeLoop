import { describe, expect, it } from 'vitest'
import {
  parseTaskPlanDraft,
  validateTask,
  validateTaskPlan,
  type PlannedTask,
} from '../src/domain/task-plan.js'

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: 't1',
    goal: '做一件事',
    files: ['packages/forgeloop/src/a.ts'],
    acceptance: '验收',
    testCommand: ['npm', 'test'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
    ...overrides,
  }
}

describe('task covers validation', () => {
  it('accepts absent or well-formed business point ids', () => {
    expect(() => validateTask(task())).not.toThrow()
    expect(() => validateTask(task({ covers: [] }))).not.toThrow()
    expect(() => validateTask(task({ covers: ['BP-1'] }))).not.toThrow()
    expect(() => validateTask(task({ covers: ['BP-1', 'BP-2', 'BP-10'] }))).not.toThrow()
  })

  it('rejects duplicate or malformed business point ids', () => {
    expect(() => validateTask(task({ covers: ['BP-1', 'BP-1'] }))).toThrow(
      '任务覆盖的业务要点不能重复',
    )
    for (const bad of ['BP-', 'bp-1', 'BP-1a', 'BP-x', '1', 'BP-1 ', 'BP--1', ' BP-1']) {
      expect(() => validateTask(task({ covers: [bad] }))).toThrow(
        `任务覆盖的业务要点编号必须形如 BP-1: ${bad}`,
      )
    }
  })

  it('parses covers from a draft and keeps it optional', () => {
    const context = {
      requirementId: 'req-1',
      project: 'demo',
      planVersion: 1,
      requirementVersion: 1,
    }
    const base = {
      tasks: [
        {
          task_id: 't1',
          goal: '做',
          files: ['packages/forgeloop/src/a.ts'],
          acceptance: '验收',
          test_command: ['npm', 'test'],
          depends_on: [],
          covers: ['BP-1', 'BP-2'],
        },
        {
          task_id: 't2',
          goal: '二',
          files: ['packages/forgeloop/src/b.ts'],
          acceptance: '验收二',
          test_command: ['npm', 'test'],
          depends_on: ['t1'],
        },
      ],
    }
    const parsed = parseTaskPlanDraft(JSON.stringify(base), context)
    expect(parsed.tasks[0]?.covers).toEqual(['BP-1', 'BP-2'])
    const withoutCovers = parseTaskPlanDraft(
      JSON.stringify({
        ...base,
        tasks: [{ ...base.tasks[0], covers: undefined }, base.tasks[1]],
      }),
      context,
    )
    expect(withoutCovers.tasks[0]?.covers).toBeUndefined()
    expect('covers' in (withoutCovers.tasks[0] ?? {})).toBe(false)
    expect(() =>
      parseTaskPlanDraft(
        JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], covers: ['nope'] }, base.tasks[1]] }),
        context,
      ),
    ).toThrow('任务覆盖的业务要点编号必须形如 BP-1: nope')
    for (const covers of [[1], 'BP-1', [''], null]) {
      expect(() =>
        parseTaskPlanDraft(
          JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], covers }, base.tasks[1]] }),
          context,
        ),
      ).toThrow('任务包字段 covers')
    }
    // 缺省 covers 时不写入该字段，也不因 undefined 走 toStringList。
    const absent = parseTaskPlanDraft(
      JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], covers: undefined }, base.tasks[1]] }),
      context,
    )
    expect(absent.tasks[0]?.covers).toBeUndefined()
    expect(absent.tasks[1]?.covers).toBeUndefined()
    expect(() => validateTaskPlan(absent)).not.toThrow()
    // covers 允许显式空数组（任务不引用业务要点），不能被当成非法。
    const empty = parseTaskPlanDraft(
      JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], covers: [] }, base.tasks[1]] }),
      context,
    )
    expect(empty.tasks[0]?.covers).toEqual([])
  })
})
