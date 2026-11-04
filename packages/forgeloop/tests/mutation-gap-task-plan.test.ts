import { describe, expect, it } from 'vitest'
import {
  authorizationSourceOf,
  authorizePlan,
  bindAuthorization,
  executionOrder,
  planLimitSeconds,
  requireActionablePlan,
  validateFiles,
  validateTask,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
  type TaskPlanApproval,
} from '../src/domain/task-plan.js'

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: 't1',
    goal: '做一件事',
    files: ['packages/a.ts'],
    acceptance: '验收',
    testCommand: ['npm', 'test'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
    ...overrides,
  }
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [task(), task({ taskId: 't2', dependsOn: ['t1'] })],
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('task plan limits and files', () => {
  it('sums finite limits and treats any unlimited task as unlimited', () => {
    expect(planLimitSeconds([])).toBe(0)
    expect(planLimitSeconds([task(), task({ taskId: 't2' })])).toBe(120)
    expect(
      planLimitSeconds([
        task(),
        task({ taskId: 't2', limits: { limitSeconds: -1, maxFailureRounds: 2 } }),
      ]),
    ).toBe(-1)
  })

  it('rejects absolute, empty-segment and parent-escaping files', () => {
    expect(() => validateFiles([])).toThrow('任务的准许修改文件清单不能为空')
    expect(() => validateFiles(['/etc/passwd'])).toThrow(
      '文件清单必须是项目内相对路径: /etc/passwd',
    )
    expect(() => validateFiles(['\\windows'])).toThrow('文件清单必须是项目内相对路径: \\windows')
    expect(() => validateFiles(['a/../b'])).toThrow('文件清单不得越出项目根: a/../b')
    expect(() => validateFiles(['a//b'])).not.toThrow()
    expect(() => validateFiles(['packages/forgeloop/src/a.ts'])).not.toThrow()
  })
})

describe('task validation', () => {
  it('requires identity, goal, acceptance and non-empty commands', () => {
    expect(() => validateTask(task({ taskId: ' ' }))).toThrow('任务包字段 task_id 必须是非空字符串')
    expect(() => validateTask(task({ goal: '' }))).toThrow('任务包字段 goal 必须是非空字符串')
    expect(() => validateTask(task({ acceptance: '  ' }))).toThrow(
      '任务包字段 acceptance 必须是非空字符串',
    )
    expect(() => validateTask(task({ testCommand: [] }))).toThrow(
      '任务必须给出可执行的正式测试命令',
    )
    expect(() => validateTask(task({ testCommand: ['npm', ' '] }))).toThrow(
      '任务包字段 test_command 必须是非空字符串',
    )
    expect(() =>
      validateTask(task({ limits: { limitSeconds: -1, maxFailureRounds: -1 } })),
    ).not.toThrow()
  })

  it('requires empty files for verification tasks', () => {
    expect(() => validateTask(task({ verification: true }))).toThrow(
      '验证任务不得声明准修改文件；files 必须为空',
    )
    expect(() => validateTask(task({ verification: true, files: [] }))).not.toThrow()
  })

  it('rejects self dependencies, duplicates and blank dependencies', () => {
    expect(() => validateTask(task({ dependsOn: ['t1'] }))).toThrow('任务不能依赖自身: t1')
    expect(() => validateTask(task({ files: ['a', 'a'] }))).toThrow(
      '任务的准许修改文件清单不能包含重复项',
    )
    expect(() => validateTask(task({ dependsOn: ['t2', 't2'] }))).toThrow('任务依赖不能包含重复项')
    expect(() => validateTask(task({ dependsOn: [' '] }))).toThrow(
      '任务包字段 depends_on 必须是非空字符串',
    )
  })

  it('validates execution and failure limits', () => {
    for (const limitSeconds of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateTask(task({ limits: { limitSeconds, maxFailureRounds: 2 } }))).toThrow(
        '任务执行限额必须为 -1 或正数（-1 表示不限）',
      )
    }
    for (const maxFailureRounds of [0, -2, 1.5]) {
      expect(() => validateTask(task({ limits: { limitSeconds: 60, maxFailureRounds } }))).toThrow(
        '任务失败轮次上限必须为 -1 或正整数（-1 表示不限）',
      )
    }
  })
})

describe('plan validation and ordering', () => {
  it('orders by dependencies and rejects cycles', () => {
    expect(executionOrder({ tasks: [task(), task({ taskId: 't2', dependsOn: ['t1'] })] })).toEqual([
      't1',
      't2',
    ])
    expect(executionOrder({ tasks: [task({ taskId: 'a' }), task({ taskId: 'b' })] })).toEqual([
      'a',
      'b',
    ])
    expect(() =>
      executionOrder({
        tasks: [task({ taskId: 'a', dependsOn: ['b'] }), task({ taskId: 'b', dependsOn: ['a'] })],
      }),
    ).toThrow('任务包依赖存在环，无法形成执行顺序')
  })

  it('validates plan identity, technical solution, versions, ids and dependencies', () => {
    expect(() => validateTaskPlan(plan({ taskPlanId: ' ' }))).toThrow(
      '任务包字段 task_plan_id 必须是非空字符串',
    )
    expect(() =>
      validateTaskPlan(plan({ technicalSolution: { summary: '', approach: ['a'], risks: [] } })),
    ).toThrow('任务包字段 technical_solution.summary 必须是非空字符串')
    expect(() =>
      validateTaskPlan(plan({ technicalSolution: { summary: 's', approach: [], risks: [] } })),
    ).toThrow('任务包字段 technical_solution.approach 不能为空')
    expect(() =>
      validateTaskPlan(
        plan({ technicalSolution: { summary: 's', approach: ['a', 'a'], risks: [] } }),
      ),
    ).toThrow('任务包字段 technical_solution.approach 不能包含重复项')
    expect(() => validateTaskPlan(plan({ planVersion: 0 }))).toThrow('任务包版本号必须从 1 开始')
    expect(() => validateTaskPlan(plan({ requirementVersion: 0 }))).toThrow(
      '任务包必须绑定一个需求版本',
    )
    expect(() => validateTaskPlan(plan({ tasks: [] }))).toThrow('任务包至少要有一个任务')
    expect(() => validateTaskPlan(plan({ tasks: [task(), task()] }))).toThrow(
      '同一任务包内 task_id 必须唯一',
    )
    expect(() => validateTaskPlan(plan({ tasks: [task({ dependsOn: ['missing'] })] }))).toThrow(
      '任务 t1 依赖不存在的任务: missing',
    )
    expect(() => validateTaskPlan(plan())).not.toThrow()
  })

  it('requires an actionable plan: two tasks and at least one dependency', () => {
    expect(() => requireActionablePlan(plan({ tasks: [task()] }))).toThrow(
      '可批准的任务包至少要包含两个任务',
    )
    expect(() => requireActionablePlan(plan({ tasks: [task(), task({ taskId: 't2' })] }))).toThrow(
      '可批准的任务包至少要有一条任务依赖',
    )
    expect(() => requireActionablePlan(plan())).not.toThrow()
  })
})

describe('plan authorization', () => {
  const approval: TaskPlanApproval = {
    requirementId: 'req-1',
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: '2026-11-04T00:00:00.000Z',
    source: 'test',
  }

  it('classifies missing, stale and approved bindings', () => {
    expect(authorizePlan(plan(), null)).toEqual({
      status: 'missing',
      approval: null,
      reason: '未找到该需求的任务包批准；未批准不执行',
    })
    expect(authorizePlan(plan(), { ...approval, requirementId: 'other' })).toMatchObject({
      status: 'stale',
      reason: '批准不绑定该需求；不能驱动本任务包',
    })
    expect(authorizePlan(plan(), { ...approval, planVersion: 2 })).toMatchObject({
      status: 'stale',
      reason: '批准绑定任务包 v2，当前任务包 v1；旧版本批准不能驱动新任务包',
    })
    expect(authorizePlan(plan(), approval)).toEqual({ status: 'approved', approval, reason: '' })
    expect(authorizationSourceOf(approval)).toBe('plan-approval:req-1:v1:owner')
  })

  it('binds authorization to every task and refuses mismatch', () => {
    const bound = bindAuthorization(plan(), approval)
    expect(bound.tasks.map((item) => item.authorizationSource)).toEqual([
      'plan-approval:req-1:v1:owner',
      'plan-approval:req-1:v1:owner',
    ])
    expect(() => bindAuthorization(plan(), { ...approval, planVersion: 2 })).toThrow(
      '批准绑定任务包 v2，当前任务包 v1；旧版本批准不能驱动新任务包',
    )
  })
})
