import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.js'
import { TaskViews } from '../src/runtime/task-views.js'
import {
  buildExecutionAttempts,
  buildExecutionStages,
  loadExecutionPage,
  sessionRequirementView,
} from '../src/runtime/execution-views.js'

const plan = {
  taskPlanId: 'plan-1',
  requirementId: 'req-1',
  project: 'testproj',
  planVersion: 1,
  requirementVersion: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  tasks: [
    {
      taskId: 't1',
      goal: '目标',
      files: [],
      acceptance: '完成',
      testCommand: ['node', '-e', '0'],
      dependsOn: [],
      authorizationSource: '',
      limits: { limitSeconds: 60, maxFailureRounds: 2 },
    },
  ],
}

const requirement = {
  reqId: 'req-1',
  project: 'testproj',
  status: 'executing',
  blockedReason: '',
  versions: [{ version: 1, text: '需求', createdAt: '2026-11-01T00:00:00.000Z' }],
  submittedBy: 'owner',
  source: 'test',
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forgeloop-task-views-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function config() {
  return resolveConfig(
    {
      project: 'testproj',
      projectPath: dir,
      recordsRoot: join(dir, '.forgeloop'),
      pollSeconds: 3600,
      owner: 'owner',
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: 30,
      maxTaskAttempts: 2,
    },
    dir,
  )
}

function views(repo: Record<string, unknown>, retry?: Record<string, unknown>) {
  return new TaskViews({
    config: config(),
    repo: repo as never,
    now: () => '2026-11-01T00:00:00.000Z',
    remainingFailureRounds: () => 0,
    retryEligibility: () =>
      (retry ?? {
        ok: false,
        code: 'not_ready',
        message: 'not ready',
      }) as never,
  })
}

function repo(overrides: Record<string, unknown> = {}) {
  return {
    getRequirement: () => requirement,
    latestTaskPlan: () => plan,
    taskPlan: () => plan,
    taskRuns: () => [],
    taskArtifact: () => null,
    evidence: () => null,
    failureRounds: () => [],
    activeStop: () => null,
    requestsFor: () => [],
    ...overrides,
  }
}

describe('task views fallbacks', () => {
  it('uses the latest plan when the execution request omits a plan version', () => {
    const outcome = views(repo()).taskExecution({ reqId: 'req-1', taskId: 't1' })
    expect(outcome.ok).toBe(true)
    expect((outcome.data as { planVersion: number }).planVersion).toBe(1)
  })

  it('reports missing requirements, plans and tasks', () => {
    expect(
      views(repo({ getRequirement: () => undefined })).taskExecution({
        reqId: 'req-1',
        taskId: 't1',
      }).ok,
    ).toBe(false)
    expect(
      views(repo({ latestTaskPlan: () => null })).taskExecution({
        reqId: 'req-1',
        taskId: 't1',
      }).ok,
    ).toBe(false)
    expect(views(repo()).taskExecution({ reqId: 'req-1', taskId: 'missing' }).ok).toBe(false)
  })

  it('describes a pending task, a delivered task and a waiting task', () => {
    const pending = views(repo()).taskDetail('req-1', 't1')
    expect(pending.ok).toBe(true)
    expect((pending.data as { run: unknown }).run).toBeNull()
    expect((pending.data as { advice: unknown }).advice).toBeNull()

    expect(
      views(
        repo({
          taskArtifact: () => ({ taskId: 't1', recordedAt: '2026-11-01T00:00:00.000Z' }),
        }),
      ).taskDetail('req-1', 't1', 1).ok,
    ).toBe(true)

    const waiting = views(
      repo({
        taskRuns: () => [
          { taskId: 't1', state: 'running', reason: 'ask_user_question: confirm', updatedAt: 'x' },
        ],
      }),
    ).taskDetail('req-1', 't1', 1)
    expect((waiting.data as { waitingForInput: boolean }).waitingForInput).toBe(true)
  })

  it('uses the latest plan in the task detail when no version is given', () => {
    const outcome = views(repo()).taskDetail('req-1', 't1')
    expect(outcome.ok).toBe(true)
    expect((outcome.data as { planVersion: number }).planVersion).toBe(1)
  })
})

describe('execution views fallbacks', () => {
  it('defaults paging when no dev log exists', () => {
    const page = loadExecutionPage({}, join(dir, 'missing.jsonl'), false)
    expect(page).toMatchObject({ total: 0, offset: 0, limit: 100, truncated: false })
  })

  it('explains an available but empty dev log and a missing one', () => {
    const page = loadExecutionPage({ offset: 2, limit: 5 }, join(dir, 'missing.jsonl'), false)
    expect(page.offset).toBe(2)
    expect(page.limit).toBe(5)
    const attempts = buildExecutionAttempts({
      plan: plan as never,
      task: { taskId: 't1' },
      run: null,
      artifact: null,
      page: { ...page, total: 0 },
      hasDev: true,
      sessionId: '',
      rounds: [],
    })
    expect(attempts[0]).toMatchObject({
      attemptId: 'recent-recording',
      state: 'pending',
      reason: '执行记录文件存在，但没有可公开事件',
    })
    const missing = buildExecutionAttempts({
      plan: plan as never,
      task: { taskId: 't1' },
      run: { taskId: 't1', state: 'running', reason: '', updatedAt: '2026-11-01T01:00:00.000Z' },
      artifact: null,
      page: { ...page, total: 0 },
      hasDev: false,
      sessionId: 'session-1',
      rounds: [],
    })
    expect(missing[0]).toMatchObject({
      attemptId: 'session:session-1',
      lastActivity: '2026-11-01T01:00:00.000Z',
      reason: '没有找到该任务的执行记录文件 dev.jsonl',
    })
  })

  it('keeps stage fallbacks empty when no run, review or evidence exists', () => {
    const stages = buildExecutionStages({
      run: null,
      artifact: null,
      page: { total: 0, stepCount: 0, startedAt: '', lastActivity: '' } as never,
      sessionId: '',
      review: null,
      reviewSession: '',
      evidence: null,
      reviewPath: '/tmp/review.json',
      testLog: '',
      testLogPath: '/tmp/test.log',
      testHeader: {
        startedAt: '',
        durationMs: null,
        timedOut: null,
        aborted: null,
        exitCode: null,
      },
    })
    expect(stages[0]).toMatchObject({ state: 'pending', lastActivity: '' })
    expect(stages[1]).toMatchObject({ available: false, recordedAt: '', verdict: '' })
    expect(stages[3]).toMatchObject({ delivered: false, recordedAt: '', candidateSha256: '' })
  })

  it('summarises a requirement without versions or a plan', () => {
    const view = sessionRequirementView(
      {
        latestAnalysis: () => null,
        latestTaskPlan: () => null,
        planApproval: () => null,
        taskArtifacts: () => [],
      } as never,
      {
        reqId: 'req-empty',
        project: 'testproj',
        status: 'draft',
        blockedReason: '',
        versions: [],
        submittedBy: 'owner',
        source: 'test',
      } as never,
    )
    expect(view).toMatchObject({
      version: 0,
      updatedAt: '',
      goal: '',
      planVersion: null,
      approved: false,
      delivered: 0,
      taskCount: 0,
    })
  })
})
