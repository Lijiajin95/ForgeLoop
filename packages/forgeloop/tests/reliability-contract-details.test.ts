import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  DEFAULT_MAX_FAILURE_ROUNDS,
  DEFAULT_TASK_LIMIT_SECONDS,
  DEFAULT_TASK_LIMITS,
  ancestorTaskIds,
  authorizePlan,
  executionOrder,
  findTask,
  parseTaskPlanDraft,
  planLimitSeconds,
  requireActionablePlan,
  validateFiles,
  validateTask,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
} from '../src/domain/task-plan.js'
import {
  DEPLOYMENT_CAPABILITIES,
  DEPLOYMENT_OPERATIONS,
  DEPLOYMENT_STATES,
  DEPLOYMENT_TOOL_VERSION,
  canTransition,
  parseDeploymentToolResult,
} from '../src/domain/deployment.js'
import { sha256OfBytes, sha256OfText } from '../src/domain/delivery.js'
import {
  ACTION_ADVANCE,
  ACTION_ANALYZE,
  ACTION_PLAN,
  ACTION_VERIFY,
  ACTOR_AGENT,
  ACTOR_USER,
  ANALYSIS_FAILED,
  AWAITING_CLARIFICATION,
  AWAITING_DEV_SESSION,
  ACCEPTED,
  APPROVED,
  AUTO_ADVANCE_STATUSES,
  BLOCKED,
  CANCELLED,
  COMMITTED,
  DEVELOPING,
  DRAFT,
  EXECUTING,
  PLAN_PROPOSED,
  REJECTED,
  REQUEST_FAILED,
  SPECIFIED,
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
  TERMINAL_STATUSES,
  VERIFYING,
} from '../src/domain/status.js'
import { buildAcceptanceBinding } from '../src/runtime/acceptance-binding.js'
import type { TaskArtifact } from '../src/domain/work.js'
import type { BusinessReviewRecord, VerificationRecord } from '../src/records/rows.js'

const CONTEXT = {
  requirementId: 'req-1',
  project: 'proj',
  planVersion: 1,
  requirementVersion: 1,
  now: '2026-11-01T00:00:00.000Z',
}

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: 't0',
    goal: '实现',
    files: ['src/a.ts'],
    acceptance: '可验证',
    testCommand: ['npm', 'test'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
    ...overrides,
  }
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  const base: TaskPlan = {
    taskPlanId: 'plan-req-1-1',
    requirementId: 'req-1',
    project: 'proj',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [task(), task({ taskId: 't1', dependsOn: ['t0'] })],
    createdAt: CONTEXT.now,
  }
  return { ...base, ...overrides }
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [
      {
        task_id: 't0',
        goal: '实现',
        files: ['src/a.ts'],
        acceptance: '可验证',
        test_command: ['npm', 'test'],
      },
      {
        task_id: 't1',
        goal: '补测试',
        files: ['src/b.ts'],
        acceptance: '可验证',
        test_command: ['npm', 'test'],
        depends_on: ['t0'],
      },
    ],
    ...overrides,
  }
}

describe('status vocabulary literals', () => {
  it('keeps the persisted vocabulary stable and observable', () => {
    expect([
      DRAFT,
      ANALYSIS_FAILED,
      AWAITING_CLARIFICATION,
      BLOCKED,
      SPECIFIED,
      PLAN_PROPOSED,
      APPROVED,
      DEVELOPING,
      EXECUTING,
      VERIFYING,
      AWAITING_DEV_SESSION,
      COMMITTED,
      ACCEPTED,
      REJECTED,
      CANCELLED,
    ]).toEqual([
      'draft',
      'analysis_failed',
      'awaiting_clarification',
      'blocked',
      'specified',
      'plan_proposed',
      'approved',
      'developing',
      'executing',
      'verifying',
      'awaiting_dev_session',
      'committed',
      'accepted',
      'rejected',
      'cancelled',
    ])
    expect([...AUTO_ADVANCE_STATUSES].sort()).toEqual(
      [
        'approved',
        'awaiting_dev_session',
        'developing',
        'executing',
        'specified',
        'verifying',
      ].sort(),
    )
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['accepted', 'cancelled', 'committed', 'rejected'].sort(),
    )
    expect([
      TASK_RUN_RUNNING,
      TASK_RUN_DELIVERED,
      TASK_RUN_AWAITING_USER,
      TASK_RUN_FAILED,
      TASK_RUN_BLOCKED,
    ]).toEqual(['running', 'delivered', 'awaiting_user', 'failed', 'blocked'])
    expect([REQUEST_FAILED, ACTION_ANALYZE, ACTION_PLAN, ACTION_ADVANCE, ACTION_VERIFY]).toEqual([
      'failed',
      'analyze',
      'plan',
      'advance',
      'verify',
    ])
    expect([ACTOR_USER, ACTOR_AGENT]).toEqual(['user', 'agent'])
  })
})

describe('delivery hashing contract', () => {
  it('produces the standard SHA-256 values', () => {
    // 固定已知答案：摘要算法或编码被替换时（例如空编码/空算法）立刻失败。
    expect(sha256OfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256OfBytes(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256OfText('中文')).toHaveLength(64)
    expect(sha256OfText('a')).not.toBe(sha256OfText('b'))
  })
})

describe('task plan validation messages', () => {
  it('rejects empty identity, goal and acceptance with named fields', () => {
    expect(() => validateTask(task({ taskId: '  ' }))).toThrow(
      '任务包字段 task_id 必须是非空字符串',
    )
    expect(() => validateTask(task({ goal: '' }))).toThrow('任务包字段 goal 必须是非空字符串')
    expect(() => validateTask(task({ acceptance: '' }))).toThrow(
      '任务包字段 acceptance 必须是非空字符串',
    )
    expect(() => validateTask(task({ taskId: 7 as never }))).toThrow(
      '任务包字段 task_id 必须是非空字符串',
    )
    expect(() => validateTaskPlan(plan({ taskPlanId: '' }))).toThrow(
      '任务包字段 task_plan_id 必须是非空字符串',
    )
    expect(() => validateTaskPlan(plan({ requirementId: '' }))).toThrow(
      '任务包字段 requirement_id 必须是非空字符串',
    )
    expect(() => validateTaskPlan(plan({ project: '' }))).toThrow(
      '任务包字段 project 必须是非空字符串',
    )
  })

  it('rejects malformed file lists and keeps accepted paths trimmed', () => {
    expect(() => validateFiles([])).toThrow('任务的准许修改文件清单不能为空')
    expect(() => validateFiles(['/abs.ts'])).toThrow('文件清单必须是项目内相对路径: /abs.ts')
    expect(() => validateFiles(['\\abs\\a.ts'])).toThrow('文件清单必须是项目内相对路径')
    expect(() => validateFiles(['src/../escape.ts'])).toThrow('文件清单不得越出项目根')
    expect(() => validateFiles(['src/a/'])).toThrow('文件清单不得越出项目根: src/a/')
    expect(() => validateTask(task({ files: ['src/a.ts', 'src/a.ts'] }))).toThrow(
      '任务的准许修改文件清单不能包含重复项',
    )
    const parsed = parseTaskPlanDraft(
      draft({
        tasks: [
          {
            task_id: ' t0 ',
            goal: ' 实现 ',
            files: ['  src/a.ts  '],
            acceptance: ' 可验证 ',
            test_command: [' npm ', ' test '],
          },
          {
            task_id: 't1',
            goal: '补测试',
            files: ['src/b.ts'],
            acceptance: '可验证',
            test_command: ['npm', 'test'],
            depends_on: ['t0'],
          },
        ],
      }),
      CONTEXT,
    )
    expect(parsed.tasks[0]).toMatchObject({
      taskId: 't0',
      goal: '实现',
      files: ['src/a.ts'],
      acceptance: '可验证',
      testCommand: ['npm', 'test'],
    })
  })

  it('rejects malformed dependency, command and limit values with messages', () => {
    expect(() => validateTask(task({ testCommand: [] }))).toThrow(
      '任务必须给出可执行的正式测试命令',
    )
    expect(() => validateTask(task({ testCommand: [' '] }))).toThrow(
      '任务包字段 test_command 必须是非空字符串',
    )
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), files: ['x', 7] }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 files 只能包含非空字符串')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), files: ['x', '   '] }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 files 只能包含非空字符串')
    expect(() => validateTask(task({ dependsOn: ['t0'] }))).toThrow('任务不能依赖自身: t0')
    expect(() => validateTask(task({ dependsOn: ['a', 'a'] }))).toThrow('任务依赖不能包含重复项')
    expect(() => validateTask(task({ dependsOn: ['  '] }))).toThrow(
      '任务包字段 depends_on 必须是非空字符串',
    )
    expect(() => validateTask(task({ limits: { limitSeconds: 0, maxFailureRounds: 1 } }))).toThrow(
      '任务执行限额必须为 -1 或正数（-1 表示不限）',
    )
    expect(() =>
      validateTask(
        task({ limits: { limitSeconds: Number.POSITIVE_INFINITY, maxFailureRounds: 1 } }),
      ),
    ).toThrow('任务执行限额必须为 -1 或正数（-1 表示不限）')
    expect(() => validateTask(task({ limits: { limitSeconds: 60, maxFailureRounds: 0 } }))).toThrow(
      '任务失败轮次上限必须为 -1 或正整数（-1 表示不限）',
    )
    expect(() =>
      validateTask(task({ limits: { limitSeconds: 60, maxFailureRounds: 1.5 } })),
    ).toThrow('任务失败轮次上限必须为 -1 或正整数（-1 表示不限）')
    // 验证任务可以没有 files，但不能声明准修改文件。
    expect(() => validateTask(task({ verification: true, files: ['src/a.ts'] }))).toThrow(
      '验证任务不得声明准修改文件；files 必须为空',
    )
    expect(() => validateTask(task({ verification: true, files: [] }))).not.toThrow()
  })

  it('validates plan-level identity, versions, task ids and dependencies', () => {
    expect(() => validateTaskPlan(plan({ planVersion: 0 }))).toThrow('任务包版本号必须从 1 开始')
    expect(() => validateTaskPlan(plan({ requirementVersion: 0 }))).toThrow(
      '任务包必须绑定一个需求版本',
    )
    expect(() => validateTaskPlan(plan({ tasks: [] }))).toThrow('任务包至少要有一个任务')
    expect(() =>
      validateTaskPlan(plan({ tasks: [task(), task({ taskId: 't0', files: ['src/b.ts'] })] })),
    ).toThrow('同一任务包内 task_id 必须唯一')
    expect(() =>
      validateTaskPlan(plan({ tasks: [task(), task({ taskId: 't1', dependsOn: ['missing'] })] })),
    ).toThrow('任务 t1 依赖不存在的任务: missing')
    expect(() =>
      validateTaskPlan(
        plan({
          technicalSolution: { summary: '', approach: ['a'], risks: [] },
        }),
      ),
    ).toThrow('任务包字段 technical_solution.summary 必须是非空字符串')
    expect(() =>
      validateTaskPlan(plan({ technicalSolution: { summary: 's', approach: [], risks: [] } })),
    ).toThrow('任务包字段 technical_solution.approach 不能为空')
    expect(() =>
      validateTaskPlan(
        plan({ technicalSolution: { summary: 's', approach: ['a'], risks: ['r', 'r'] } }),
      ),
    ).toThrow('任务包字段 technical_solution.risks 不能包含重复项')
    expect(() =>
      validateTaskPlan(plan({ technicalSolution: { summary: 's', approach: ['a'], risks: [] } })),
    ).not.toThrow()
  })

  it('aggregates limits and orders work deterministically', () => {
    expect(DEFAULT_TASK_LIMIT_SECONDS).toBe(-1)
    expect(DEFAULT_MAX_FAILURE_ROUNDS).toBe(-1)
    expect(DEFAULT_TASK_LIMITS).toEqual({ limitSeconds: -1, maxFailureRounds: -1 })
    expect(planLimitSeconds([task({ limits: { limitSeconds: 0, maxFailureRounds: 1 } })])).toBe(0)
    expect(
      planLimitSeconds([
        task({ limits: { limitSeconds: 60, maxFailureRounds: 1 } }),
        task({ taskId: 't1', limits: { limitSeconds: 40, maxFailureRounds: 1 } }),
      ]),
    ).toBe(100)
    expect(
      planLimitSeconds([
        task({ limits: { limitSeconds: 60, maxFailureRounds: 1 } }),
        task({ taskId: 't1', limits: { limitSeconds: -1, maxFailureRounds: 1 } }),
      ]),
    ).toBe(-1)
    expect(() =>
      executionOrder({
        tasks: [task({ taskId: 'a', dependsOn: ['b'] }), task({ taskId: 'b', dependsOn: ['a'] })],
      }),
    ).toThrow('任务包依赖存在环，无法形成执行顺序')
    expect(() => requireActionablePlan(plan({ tasks: [task()] }))).toThrow(
      '可批准的任务包至少要包含两个任务',
    )
    expect(() =>
      requireActionablePlan(
        plan({
          tasks: [task({ taskId: 'a', dependsOn: [] }), task({ taskId: 'b', dependsOn: [] })],
        }),
      ),
    ).toThrow('可批准的任务包至少要有一条任务依赖')
    expect(() => findTask(plan(), 'missing')).toThrow('任务包内没有任务 missing')
  })

  it('resolves ancestors once for diamond dependencies', () => {
    const diamond = plan({
      tasks: [
        task({ taskId: 'a' }),
        task({ taskId: 'b', dependsOn: ['a'] }),
        task({ taskId: 'c', dependsOn: ['a'] }),
        task({ taskId: 'd', dependsOn: ['b', 'c'] }),
      ],
    })
    expect(executionOrder(diamond)).toEqual(['a', 'b', 'c', 'd'])
    expect(ancestorTaskIds(diamond, 'd')).toEqual(['a', 'b', 'c'])
    expect(ancestorTaskIds(diamond, 'a')).toEqual([])
    const cyclic = plan({
      tasks: [task({ taskId: 'a', dependsOn: ['b'] }), task({ taskId: 'b', dependsOn: ['a'] })],
    })
    expect(() => ancestorTaskIds(cyclic, 'a')).toThrow('任务包依赖存在环，无法形成执行顺序')
  })

  it('reports plan authorization states with stable reasons', () => {
    expect(authorizePlan(plan(), null)).toEqual({
      status: 'missing',
      approval: null,
      reason: '未找到该需求的任务包批准；未批准不执行',
    })
    expect(
      authorizePlan(plan(), {
        requirementId: 'other',
        planVersion: 1,
        approvedBy: 'owner',
        approvedAt: CONTEXT.now,
        source: 'test',
      }),
    ).toMatchObject({ status: 'stale', reason: '批准不绑定该需求；不能驱动本任务包' })
    expect(
      authorizePlan(plan(), {
        requirementId: 'req-1',
        planVersion: 2,
        approvedBy: 'owner',
        approvedAt: CONTEXT.now,
        source: 'test',
      }),
    ).toMatchObject({
      status: 'stale',
      reason: '批准绑定任务包 v2，当前任务包 v1；旧版本批准不能驱动新任务包',
    })
    expect(
      authorizePlan(plan(), {
        requirementId: 'req-1',
        planVersion: 1,
        approvedBy: 'owner',
        approvedAt: CONTEXT.now,
        source: 'test',
      }),
    ).toEqual({
      status: 'approved',
      approval: {
        requirementId: 'req-1',
        planVersion: 1,
        approvedBy: 'owner',
        approvedAt: CONTEXT.now,
        source: 'test',
      },
      reason: '',
    })
  })
})

describe('task plan draft parsing details', () => {
  it('parses fenced JSON variants and prose-wrapped JSON', () => {
    const payload = JSON.stringify(draft())
    const fence = '```'
    const cases = [
      fence + 'json\n' + payload + '\n' + fence,
      fence + '\n' + payload + '\n' + fence,
      fence + 'JSON\n' + payload + '\n' + fence,
      '说明文字\n' + fence + 'json\n' + payload + '\n' + fence + '\n结束',
      '前缀 ' + payload + ' 后缀',
      fence + 'json' + payload + fence,
      fence + 'json' + payload + fence + ' 说明：尾部还有一个 } 字符',
      fence + 'json\n' + payload + '\n' + fence + '\n说明：尾部还有一个 } 字符',
      fence + '\n' + payload + '\n' + fence + '\n说明：尾部还有一个 } 字符',
    ]
    for (const input of cases) {
      expect(parseTaskPlanDraft(input, CONTEXT).tasks).toHaveLength(2)
    }
    expect(() => parseTaskPlanDraft('not-json', CONTEXT)).toThrow('任务包不是可解析的 JSON')
    expect(() => parseTaskPlanDraft('{broken}', CONTEXT)).toThrow('任务包不是可解析的 JSON')
  })

  it('rejects malformed payload and task shapes with field names', () => {
    expect(() => parseTaskPlanDraft('null', CONTEXT)).toThrow('任务包字段 payload 必须是对象')
    expect(() => parseTaskPlanDraft({}, CONTEXT)).toThrow('任务包必须给出非空 tasks 数组')
    expect(() => parseTaskPlanDraft({ tasks: [] }, CONTEXT)).toThrow(
      '任务包必须给出非空 tasks 数组',
    )
    expect(() => parseTaskPlanDraft({ tasks: [null, draft().tasks[1]] }, CONTEXT)).toThrow(
      '任务包字段 tasks[0] 必须是对象',
    )
    expect(() =>
      parseTaskPlanDraft(
        {
          tasks: [{ ...(draft().tasks[0] as object), authorization_source: 'x' }, draft().tasks[1]],
        },
        CONTEXT,
      ),
    ).toThrow('任务包不得自带 authorization_source')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ goal: 'g', files: ['src/a.ts'], acceptance: 'a', test_command: ['x'] }] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 task_id 必须是非空字符串')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), goal: '' }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 goal 必须是非空字符串')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), files: 'x' }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 files 必须是字符串数组')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), files: [] }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 files 不能为空')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), acceptance: '' }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 acceptance 必须是非空字符串')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), test_command: [] }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 test_command 不能为空')
    expect(() =>
      parseTaskPlanDraft(
        { tasks: [{ ...(draft().tasks[0] as object), depends_on: ['x', 'x'] }, draft().tasks[1]] },
        CONTEXT,
      ),
    ).toThrow('任务包字段 depends_on 不能包含重复项')
  })

  it('parses technical solutions and rejects their malformed forms', () => {
    const solution = { summary: '方案', approach: ['先实现'], risks: [] }
    const parsed = parseTaskPlanDraft(draft({ technical_solution: solution }), CONTEXT)
    expect(parsed.technicalSolution).toEqual(solution)
    expect(
      parseTaskPlanDraft(draft({ technical_solution: { summary: 's', approach: ['a'] } }), CONTEXT)
        .technicalSolution,
    ).toEqual({ summary: 's', approach: ['a'], risks: [] })
    expect(parseTaskPlanDraft(draft(), CONTEXT)).not.toHaveProperty('technicalSolution')
    for (const [value, message] of [
      ['x', '任务包字段 technical_solution 必须是对象'],
      [
        { summary: '', approach: ['a'], risks: [] },
        '任务包字段 technical_solution.summary 必须是非空字符串',
      ],
      [
        { summary: 's', approach: [], risks: [] },
        '任务包字段 technical_solution.approach 不能为空',
      ],
      [
        { summary: 's', approach: ['a'], risks: ['r', 'r'] },
        '任务包字段 technical_solution.risks 不能包含重复项',
      ],
    ] as const) {
      expect(() => parseTaskPlanDraft(draft({ technical_solution: value }), CONTEXT)).toThrow(
        message,
      )
    }
  })

  it('applies default limits and rejects malformed limits', () => {
    const noLimits = parseTaskPlanDraft(draft(), CONTEXT)
    expect(noLimits.tasks[0]?.limits).toEqual({ limitSeconds: -1, maxFailureRounds: -1 })
    const nullLimits = parseTaskPlanDraft(
      { tasks: [{ ...(draft().tasks[0] as object), limits: null }, draft().tasks[1]] },
      CONTEXT,
    )
    expect(nullLimits.tasks[0]?.limits).toEqual({ limitSeconds: -1, maxFailureRounds: -1 })
    const explicitLimits = parseTaskPlanDraft(
      {
        tasks: [
          { ...(draft().tasks[0] as object), limits: { limit_seconds: 60, max_failure_rounds: 2 } },
          draft().tasks[1],
        ],
      },
      CONTEXT,
    )
    expect(explicitLimits.tasks[0]?.limits).toEqual({ limitSeconds: 60, maxFailureRounds: 2 })
    for (const [limits, message] of [
      ['x', '任务包字段 limits 必须是对象'],
      [{ limit_seconds: 'x' }, '任务包字段 limits.limit_seconds 必须为 -1 或正数（-1 表示不限）'],
      [{ limit_seconds: 0 }, '任务包字段 limits.limit_seconds 必须为 -1 或正数（-1 表示不限）'],
      [
        { limit_seconds: Number.POSITIVE_INFINITY },
        '任务包字段 limits.limit_seconds 必须为 -1 或正数（-1 表示不限）',
      ],
      [
        { max_failure_rounds: 1.5 },
        '任务包字段 limits.max_failure_rounds 必须为 -1 或正整数（-1 表示不限）',
      ],
      [
        { max_failure_rounds: 0 },
        '任务包字段 limits.max_failure_rounds 必须为 -1 或正整数（-1 表示不限）',
      ],
    ] as const) {
      expect(() =>
        parseTaskPlanDraft(
          { tasks: [{ ...(draft().tasks[0] as object), limits }, draft().tasks[1]] },
          CONTEXT,
        ),
      ).toThrow(message)
    }
  })

  it('accepts verification tasks without files and rejects non-verification tasks without files', () => {
    const verificationDraft = {
      tasks: [
        {
          task_id: 't0',
          goal: '独立验证',
          files: [],
          verification: true,
          acceptance: '结论可复核',
          test_command: ['npm', 'test'],
        },
        draft().tasks[1],
      ],
    }
    const verification = parseTaskPlanDraft(verificationDraft, CONTEXT)
    expect(verification.tasks[0]).toMatchObject({ taskId: 't0', files: [], verification: true })
    expect(() =>
      parseTaskPlanDraft(
        {
          tasks: [{ ...(draft().tasks[0] as object), files: [] }, draft().tasks[1]],
        },
        CONTEXT,
      ),
    ).toThrow('任务包字段 files 不能为空')
  })
})

describe('deployment contract details', () => {
  it('keeps the declared vocabulary and rejects unknown transition targets', () => {
    expect(DEPLOYMENT_TOOL_VERSION).toBe('deployment-tool-v1')
    expect(DEPLOYMENT_STATES).toEqual([
      'draft',
      'preflight_failed',
      'awaiting_approval',
      'rejected',
      'ready',
      'applying',
      'applied_pending_verify',
      'verifying',
      'verified',
      'failed',
      'verify_failed',
      'rolling_back',
      'rolled_back',
    ])
    expect(DEPLOYMENT_CAPABILITIES).toEqual([
      'preflight',
      'apply',
      'status',
      'rollback',
      'data-rollback',
      'logs',
    ])
    expect(DEPLOYMENT_OPERATIONS).toEqual([
      'preflight',
      'apply',
      'status',
      'rollback',
      'data-rollback',
    ])
    for (const terminal of ['preflight_failed', 'rejected', 'rolled_back'] as const) {
      expect(canTransition(terminal, 'bogus' as never)).toBe(false)
      expect(canTransition(terminal, terminal)).toBe(false)
    }
  })

  it('bounds tool result fields at their exact limits', () => {
    const long = (length: number): string => 'x'.repeat(length)
    const atLimit = parseDeploymentToolResult(
      JSON.stringify({
        ok: true,
        state: long(60),
        version: long(120),
        detail: long(2000),
        steps: [long(300)],
        restorePoint: long(300),
      }),
    )
    expect(atLimit.state).not.toContain('…')
    expect(atLimit.version).not.toContain('…')
    expect(atLimit.detail).not.toContain('…')
    expect(atLimit.steps[0]).not.toContain('…')
    expect(atLimit.restorePoint).not.toContain('…')
    const overLimit = parseDeploymentToolResult(
      JSON.stringify({
        ok: true,
        state: long(61),
        version: long(121),
        detail: long(2001),
        steps: [long(301)],
        restorePoint: long(301),
      }),
    )
    expect(overLimit.state.endsWith('…')).toBe(true)
    expect(overLimit.version.endsWith('…')).toBe(true)
    expect(overLimit.detail.endsWith('…')).toBe(true)
    expect(overLimit.steps[0]?.endsWith('…')).toBe(true)
    expect(overLimit.restorePoint.endsWith('…')).toBe(true)
  })

  it('filters, trims and caps steps and defaults missing fields', () => {
    const parsed = parseDeploymentToolResult(
      JSON.stringify({
        ok: false,
        state: ' failed ',
        steps: [
          '  copy  ',
          7,
          '',
          '   ',
          'restart',
          ...Array.from({ length: 60 }, (_v, i) => `s${i}`),
        ],
        extra: 'ignored',
      }),
    )
    expect(parsed).toEqual({
      ok: false,
      state: 'failed',
      version: '',
      detail: '',
      steps: ['copy', 'restart', ...Array.from({ length: 48 }, (_v, i) => `s${i}`)],
      restorePoint: '',
    })
    expect(parseDeploymentToolResult('{"ok":true,"state":"x","steps":"nope"}').steps).toEqual([])
    expect(
      parseDeploymentToolResult('{"ok":true,"state":"x","version":7,"detail":null}'),
    ).toMatchObject({
      version: '',
      detail: '',
      restorePoint: '',
    })
  })

  it('rejects whitespace-only and malformed tool output with stable messages', () => {
    expect(() => parseDeploymentToolResult('   ')).toThrow('工具没有输出')
    expect(() => parseDeploymentToolResult('not json')).toThrow('工具输出不是 JSON：')
    expect(() => parseDeploymentToolResult('[]')).toThrow('工具输出必须是 JSON 对象')
    expect(() => parseDeploymentToolResult('{"state":"x"}')).toThrow('工具输出缺少布尔 ok')
    expect(() => parseDeploymentToolResult('{"ok":true}')).toThrow('工具输出缺少 state')
    expect(() => parseDeploymentToolResult('{"ok":true,"state":"  "}')).toThrow(
      '工具输出缺少 state',
    )
  })
})

describe('acceptance binding details', () => {
  const artifact = (taskId: string, evidence: string, review: string): TaskArtifact => ({
    requirementId: 'req-1',
    planVersion: 1,
    taskId,
    candidateSha256: 'a'.repeat(64),
    testEvidenceSha256: evidence,
    reviewSha256: review,
    acceptance: 'ok',
    authorizationSource: 'plan-approval:req-1:v1:owner',
    recordedAt: CONTEXT.now,
    baselineCommit: 'b'.repeat(40),
  })

  it('binds every material with the documented hashes', () => {
    const artifacts = [artifact('t0', 'e0', 'r0'), artifact('t1', 'e1', 'r1')]
    const binding = buildAcceptanceBinding({
      plan: plan({
        tasks: [task({ taskId: 't0' }), task({ taskId: 't1', dependsOn: ['t0'] })],
      }),
      artifacts,
      verification: {
        reportSha256: 'v'.repeat(64),
        candidateSha256: 'a'.repeat(64),
      } as VerificationRecord,
      businessReview: { reportSha256: 'b'.repeat(64) } as BusinessReviewRecord,
      candidateSha256: 'c'.repeat(64),
    })
    const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
    expect(binding.testEvidenceSha256).toBe(digest('e0:e1'))
    expect(binding.reviewSha256).toBe(digest('r0:r1'))
    expect(binding.baselineCommit).toBe('b'.repeat(40))
    expect(binding.artifactSha256).toBe('')
    expect(binding).toMatchObject({
      candidateSha256: 'c'.repeat(64),
      verificationSha256: 'v'.repeat(64),
      verificationCandidateSha256: 'a'.repeat(64),
      businessReviewSha256: 'b'.repeat(64),
    })
    const withArtifact = buildAcceptanceBinding({
      plan: plan(),
      artifacts,
      verification: {
        reportSha256: 'v'.repeat(64),
        candidateSha256: 'a'.repeat(64),
      } as VerificationRecord,
      businessReview: { reportSha256: 'b'.repeat(64) } as BusinessReviewRecord,
      artifactSha256: 'd'.repeat(64),
      candidateSha256: 'c'.repeat(64),
    })
    expect(withArtifact.artifactSha256).toBe('d'.repeat(64))
    expect(() =>
      buildAcceptanceBinding({
        plan: plan(),
        artifacts: [artifacts[0] as TaskArtifact],
        verification: {
          reportSha256: 'v'.repeat(64),
          candidateSha256: 'a'.repeat(64),
        } as VerificationRecord,
        businessReview: { reportSha256: 'b'.repeat(64) } as BusinessReviewRecord,
        candidateSha256: 'c'.repeat(64),
      }),
    ).toThrow('任务 t1 缺少交付产物')
  })
})
