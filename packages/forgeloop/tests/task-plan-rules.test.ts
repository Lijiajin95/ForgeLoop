import { describe, expect, it } from 'vitest'
import {
  executionOrder,
  parseTaskPlanDraft,
  rootTaskIds,
  validateFiles,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
} from '../src/domain/task-plan.js'
import { validateArtifact } from '../src/domain/work.js'

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
    expect(rootTaskIds(plan)).toEqual(['a'])
  })

  it('rejects payloads without a usable task list', () => {
    expect(() => parseTaskPlanDraft({}, context)).toThrow('tasks 数组')
    expect(() => parseTaskPlanDraft({ tasks: [] }, context)).toThrow('tasks 数组')
    expect(() => parseTaskPlanDraft('not json', context)).toThrow('不是可解析的 JSON')
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

describe('artifact validation', () => {
  const draft = {
    candidateSha256: 'c',
    testEvidenceSha256: 't',
    reviewSha256: 'r',
    acceptance: '达成',
    authorizationSource: 'plan-approval:req-1:v1:owner',
    baselineCommit: 'abc',
  }

  it('accepts a complete artifact', () => {
    expect(() => validateArtifact(draft)).not.toThrow()
  })

  it('rejects every missing material digest', () => {
    expect(() => validateArtifact({ ...draft, candidateSha256: '' })).toThrow('缺少候选 diff 摘要')
    expect(() => validateArtifact({ ...draft, testEvidenceSha256: '' })).toThrow('缺少正式测试证据摘要')
    expect(() => validateArtifact({ ...draft, reviewSha256: '' })).toThrow('缺少独立审查结论摘要')
  })

  it('requires an authorization source derived from a real approval', () => {
    expect(() => validateArtifact({ ...draft, authorizationSource: '  ' })).toThrow('缺少任务级授权来源')
  })
})
