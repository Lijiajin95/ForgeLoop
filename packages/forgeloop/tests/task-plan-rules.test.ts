import { describe, expect, it } from 'vitest'
import {
  executionOrder,
  parseTaskPlanDraft,
  validateFiles,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
} from '../src/domain/task-plan.js'

const context = {
  requirementId: 'req-1',
  project: 'forgeloop',
  planVersion: 1,
  requirementVersion: 1,
  now: '2026-10-23T00:00:00.000Z',
}

function rawTask(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: taskId,
    goal: `完成 ${taskId}`,
    files: [`docs/${taskId}.md`],
    acceptance: `${taskId} 存在`,
    test_command: ['node', '-e', 'process.exit(0)'],
    depends_on: [],
    ...overrides,
  }
}

function rawPlan(tasks: Record<string, unknown>[]): unknown {
  return { tasks }
}

describe('task plan parsing and validation', () => {
  it('parses an actionable plan and keeps dependency order', () => {
    const plan = parseTaskPlanDraft(
      rawPlan([rawTask('a'), rawTask('b', { depends_on: ['a'] })]),
      context,
    )
    expect(plan.taskPlanId).toBe('plan-req-1-1')
    expect(plan.tasks.map((task) => task.taskId)).toEqual(['a', 'b'])
    expect(executionOrder(plan)).toEqual(['a', 'b'])
  })

  it('rejects payloads without a usable task list', () => {
    expect(() => parseTaskPlanDraft({}, context)).toThrow('tasks 数组')
    expect(() => parseTaskPlanDraft({ tasks: [] }, context)).toThrow('tasks 数组')
    expect(() => parseTaskPlanDraft('not json', context)).toThrow('不是可解析的 JSON')
  })

  it('parses a technical solution with the task package', () => {
    const plan = parseTaskPlanDraft(
      {
        technical_solution: {
          summary: '复用现有插件注册一个只读视图',
          approach: ['先增加查询端点', '再注册会话末尾组件'],
          risks: ['不要改变现有看板默认行为'],
        },
        tasks: [rawTask('a'), rawTask('b', { depends_on: ['a'] })],
      },
      context,
    )
    expect(plan.technicalSolution).toEqual({
      summary: '复用现有插件注册一个只读视图',
      approach: ['先增加查询端点', '再注册会话末尾组件'],
      risks: ['不要改变现有看板默认行为'],
    })
  })

  it('rejects an incomplete technical solution', () => {
    expect(() =>
      parseTaskPlanDraft(
        {
          technical_solution: { summary: ' ', approach: ['步骤'], risks: [] },
          tasks: [rawTask('a'), rawTask('b', { depends_on: ['a'] })],
        },
        context,
      ),
    ).toThrow('technical_solution.summary')
    expect(() =>
      parseTaskPlanDraft(
        {
          technical_solution: { summary: '方案', approach: [], risks: [] },
          tasks: [rawTask('a'), rawTask('b', { depends_on: ['a'] })],
        },
        context,
      ),
    ).toThrow('technical_solution.approach')
  })

  it('accepts a verification task only with no writable files', () => {
    const plan = parseTaskPlanDraft(
      {
        tasks: [
          rawTask('a'),
          {
            ...rawTask('verify'),
            files: [],
            verification: true,
            depends_on: ['a'],
          },
        ],
      },
      context,
    )
    expect(plan.tasks[1]!.verification).toBe(true)
    expect(plan.tasks[1]!.files).toEqual([])
  })

  it('rejects a verification task that declares writable files', () => {
    expect(() =>
      parseTaskPlanDraft(
        {
          tasks: [
            rawTask('a'),
            { ...rawTask('verify'), verification: true, depends_on: ['a'] },
          ],
        },
        context,
      ),
    ).toThrow('验证任务不得声明准修改文件')
  })

  it('refuses model-supplied authorization sources', () => {
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([rawTask('a', { authorization_source: 'plan-approval:req-1:v1:owner' }), rawTask('b', { depends_on: ['a'] })]),
        context,
      ),
    ).toThrow('授权来源由真实批准绑定')
  })

  it('rejects files outside the project and duplicate entries', () => {
    expect(() => validateFiles(['/etc/passwd'])).toThrow('相对路径')
    expect(() => validateFiles(['docs/../secret.md'])).toThrow('不得越出项目根')
    expect(() => validateFiles([])).toThrow('不能为空')
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([rawTask('a', { files: ['docs/a.md', 'docs/a.md'] }), rawTask('b', { depends_on: ['a'] })]),
        context,
      ),
    ).toThrow('不能包含重复项')
  })

  it('requires a real test argv', () => {
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([rawTask('a', { test_command: [] }), rawTask('b', { depends_on: ['a'] })]),
        context,
      ),
    ).toThrow('test_command 不能为空')
  })

  it('rejects duplicate, self-referencing and unknown dependencies', () => {
    expect(() => parseTaskPlanDraft(rawPlan([rawTask('a'), rawTask('a')]), context)).toThrow('task_id 必须唯一')
    expect(() =>
      parseTaskPlanDraft(rawPlan([rawTask('a', { depends_on: ['a'] }), rawTask('b', { depends_on: ['a'] })]), context),
    ).toThrow('不能依赖自身')
    expect(() =>
      parseTaskPlanDraft(rawPlan([rawTask('a'), rawTask('b', { depends_on: ['missing'] })]), context),
    ).toThrow('依赖不存在的任务')
  })

  it('rejects invalid limits', () => {
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([rawTask('a', { limits: { limit_seconds: 0 } }), rawTask('b', { depends_on: ['a'] })]),
        context,
      ),
    ).toThrow('执行限额必须为正数')
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([
          rawTask('a', { limits: { max_failure_rounds: 0 } }),
          rawTask('b', { depends_on: ['a'] }),
        ]),
        context,
      ),
    ).toThrow('失败轮次上限必须为正整数')
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([rawTask('a', { limits: { limit_seconds: '60' } }), rawTask('b', { depends_on: ['a'] })]),
        context,
      ),
    ).toThrow('limit_seconds 必须是数字')
  })

  it('requires test files cited by the formal test command to be in the task file scope', () => {
    expect(() =>
      parseTaskPlanDraft(
        rawPlan([
          rawTask('a', {
            test_command: ['npx', 'vitest', 'run', 'packages/forgeloop/tests/queue-a.test.ts'],
          }),
          rawTask('b', { depends_on: ['a'] }),
        ]),
        context,
      ),
    ).toThrow('正式测试命令引用了不在允许文件内的测试文件：packages/forgeloop/tests/queue-a.test.ts')

    const plan = parseTaskPlanDraft(
      rawPlan([
        rawTask('a', {
          files: ['packages/forgeloop/src/queue.ts', 'packages/forgeloop/tests/queue-a.test.ts'],
          test_command: ['npx', 'vitest', 'run', 'packages/forgeloop/tests/queue-a.test.ts'],
        }),
        rawTask('b', { depends_on: ['a'] }),
      ]),
      context,
    )
    expect(plan.tasks[0]?.files).toContain('packages/forgeloop/tests/queue-a.test.ts')
  })

  it('does not require test paths for verification-only tasks', () => {
    const plan = parseTaskPlanDraft(
      rawPlan([
        rawTask('a'),
        rawTask('verify', {
          files: [],
          verification: true,
          test_command: ['npx', 'vitest', 'run', 'packages/forgeloop/tests/any.test.ts'],
          depends_on: ['a'],
        }),
      ]),
      context,
    )
    expect(plan.tasks[1]?.verification).toBe(true)
  })

  it('requires actionable plans with at least two tasks and one dependency', () => {
    expect(() => parseTaskPlanDraft(rawPlan([rawTask('a')]), context)).toThrow('至少要包含两个任务')
    expect(() => parseTaskPlanDraft(rawPlan([rawTask('a'), rawTask('b')]), context)).toThrow('至少要有一条任务依赖')
  })

  it('rejects dependency cycles', () => {
    const cyclic: TaskPlan = {
      taskPlanId: 'plan-req-1-1',
      requirementId: 'req-1',
      project: 'forgeloop',
      planVersion: 1,
      requirementVersion: 1,
      createdAt: context.now,
      tasks: [
        { ...baseTask('a'), dependsOn: ['b'] },
        { ...baseTask('b'), dependsOn: ['a'] },
      ] as PlannedTask[],
    }
    expect(() => validateTaskPlan(cyclic)).toThrow('依赖存在环')
  })
})

function baseTask(taskId: string): PlannedTask {
  return {
    taskId,
    goal: `完成 ${taskId}`,
    files: [`docs/${taskId}.md`],
    acceptance: `${taskId} 存在`,
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: 60, maxFailureRounds: 2 },
    authorizationSource: '',
  }
}
