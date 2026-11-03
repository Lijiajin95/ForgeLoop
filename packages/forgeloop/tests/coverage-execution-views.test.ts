import { describe, expect, it } from 'vitest'
import {
  buildExecutionAttempts,
  buildExecutionStages,
  sessionRequirementView,
} from '../src/runtime/execution-views.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type { Requirement } from '../src/domain/requirement.js'

const page = {
  events: [],
  total: 0,
  offset: 0,
  limit: 100,
  truncated: false,
  stepCount: 0,
  startedAt: '',
  lastActivity: '',
  sessionIds: [],
}

const header = {
  startedAt: '',
  durationMs: 0,
  timedOut: false,
  aborted: false,
  exitCode: 0,
}

function requirement(): Requirement {
  return {
    reqId: 'req-1',
    project: 'demo',
    status: 'executing',
    source: 'test',
    submittedBy: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    versions: [
      {
        version: 1,
        text: '实现一个改动',
        at: '2026-01-01T00:00:00.000Z',
        revisedBy: 'owner',
        source: 'test',
      },
    ],
  } as never
}

function plan(): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 2,
    requirementVersion: 1,
    tasks: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('execution view fallbacks', () => {
  it('describes a pending attempt when nothing has run', () => {
    const attempts = buildExecutionAttempts({
      plan: plan(),
      task: { taskId: 'a' },
      run: null,
      artifact: null,
      page,
      hasDev: false,
      sessionId: '',
      rounds: [],
    })
    expect(attempts[0]).toMatchObject({
      attemptId: 'recent-recording',
      state: 'pending',
      lastActivity: '',
      available: false,
      reason: '没有找到该任务的执行记录文件 dev.jsonl',
    })
  })

  it('uses the run timestamp when the page has no activity', () => {
    const attempts = buildExecutionAttempts({
      plan: plan(),
      task: { taskId: 'a' },
      run: {
        state: 'delivered',
        updatedAt: '2026-01-01T01:00:00.000Z',
      } as never,
      artifact: null,
      page,
      hasDev: true,
      sessionId: 'session-1',
      rounds: [],
    })
    expect(attempts[0]).toMatchObject({
      state: 'delivered',
      lastActivity: '2026-01-01T01:00:00.000Z',
      reason: '执行记录文件存在，但没有可公开事件',
    })
  })

  it('describes missing review and delivery records', () => {
    const stages = buildExecutionStages({
      run: null,
      artifact: null,
      page,
      sessionId: '',
      review: null,
      reviewSession: '',
      evidence: null as never,
      reviewPath: '',
      testLog: '',
      testLogPath: '',
      testHeader: header,
    })
    expect(stages).toMatchObject([
      { id: 'dev', state: 'pending' },
      { id: 'review', available: false, recordedAt: '', verdict: '' },
      { id: 'formal_test', available: false },
      { id: 'delivery', delivered: false, recordedAt: '', candidateSha256: '' },
    ])
  })

  it('summarizes a requirement without a plan', () => {
    const repository = {
      latestAnalysis: () => null,
      latestTaskPlan: () => null,
      planApproval: () => null,
      taskArtifacts: () => [],
    }
    const view = sessionRequirementView(repository as never, requirement())
    expect(view).toMatchObject({
      reqId: 'req-1',
      version: 1,
      goal: '',
      scenarios: [],
      acceptanceCriteria: [],
      clarifications: [],
      planVersion: null,
      approved: false,
      delivered: 0,
      taskCount: 0,
    })
  })

  it('summarizes a requirement with analysis and a plan', () => {
    const repository = {
      latestAnalysis: () => ({
        goal: '实现改动',
        scenarios: ['完成'],
        acceptanceCriteria: ['通过'],
        clarifications: ['无'],
      }),
      latestTaskPlan: () => plan(),
      planApproval: () => ({ planVersion: 2 }),
      taskArtifacts: () => [{}, {}],
    }
    const view = sessionRequirementView(repository as never, requirement())
    expect(view).toMatchObject({
      goal: '实现改动',
      scenarios: ['完成'],
      acceptanceCriteria: ['通过'],
      clarifications: ['无'],
      planVersion: 2,
      approved: true,
      delivered: 2,
      taskCount: 0,
    })
  })
})
