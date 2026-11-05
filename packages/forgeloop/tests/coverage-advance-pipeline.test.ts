import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdvancePipeline } from '../src/runtime/advance-pipeline.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import type { CodeCandidateRecord } from '../src/records/rows.js'

const NOW = '2026-11-03T10:00:00.000Z'

let root = ''
let config: ForgeLoopConfig
let requirement: Requirement | null
let analysis: RequirementAnalysis | null
let admission: unknown
let budget: { limitSeconds: number; consumedSeconds: number }
let statuses: Array<[string, string, string?]>
let failureRounds: unknown[]
let runs: unknown[]
let artifact: unknown
let approval: unknown
let remainingRounds: number
let authorizedPlanResult:
  { ok: true; value: { plan: TaskPlan } } | { ok: false; result: { message: string } }
let verifyResults: Array<{
  state: 'pass' | 'block'
  detail: string
  blocking: string[]
  verification: unknown
}>
let commitResult: { ok: true; commitSha: string } | { ok: false; detail: string }
let finishThrows: boolean
let deliverThrows: boolean
let plan: TaskPlan

function planOf(): TaskPlan {
  return {
    taskPlanId: 'plan-1',
    requirementId: 'req-1',
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks: [
      {
        taskId: 'a',
        goal: '写文档',
        files: ['docs/a.md'],
        acceptance: '存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: [],
        limits: { limitSeconds: 600, maxFailureRounds: 3 },
        authorizationSource: 'plan-approval:req-1:v1:owner',
      },
      {
        taskId: 'b',
        goal: '写示例',
        files: ['docs/b.md'],
        acceptance: '存在',
        testCommand: ['node', '-e', 'process.exit(0)'],
        dependsOn: ['a'],
        limits: { limitSeconds: 600, maxFailureRounds: 3 },
        authorizationSource: 'plan-approval:req-1:v1:owner',
      },
    ],
    createdAt: NOW,
  }
}

function requirementOf(): Requirement {
  return {
    reqId: 'req-1',
    project: 'demo',
    status: 'specified',
    source: 'test',
    submittedBy: 'owner',
    createdAt: NOW,
    versions: [{ version: 1, text: '实现改动', at: NOW, revisedBy: 'owner', source: 'test' }],
  } as never
}

function candidate(): CodeCandidateRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath: join(root, 'candidate.diff'),
    diffSha256: 'd'.repeat(64),
    createdAt: NOW,
  }
}

function makePipeline(): AdvancePipeline {
  const repo = {
    getRequirement: () => requirement,
    latestAnalysis: () => analysis,
    setStatus: (reqId: string, status: string, detail?: string) => {
      statuses.push([reqId, status, detail])
    },
    budget: () => budget,
    ensureBudget: () => undefined,
    recordFailureRound: (value: unknown) => failureRounds.push(value),
    taskArtifact: () => artifact,
    taskArtifacts: () => [],
    planApproval: () => approval,
    recordRun: (...args: unknown[]) => runs.push(args),
    releaseDevSession: () => undefined,
    releaseRequirementDevSession: () => undefined,
  }
  const deps = {
    config,
    repo: repo as never,
    now: () => NOW,
    issues: {
      latestOpen: () => null,
      resolveOpen: () => undefined,
      updateStatus: () => undefined,
    },
    executionDev: {
      restoreDeliveredArtifacts: () => ({ ok: true }),
      developTaskInSession: () => Promise.resolve({ state: 'delivered', reason: '' }),
    },
    recordRun: (...args: unknown[]) => runs.push(args),
    verificationPipeline: {},
    legacyVerification: {},
    deliverTask: () => {
      if (deliverThrows) return Promise.reject(new Error('delivery exploded'))
      return Promise.resolve({
        state: 'delivered',
        reason: '',
        requirementStatus: 'executing',
        interrupted: false,
      })
    },
    devSessions: {
      finish: () => {
        if (finishThrows) return Promise.reject(new Error('summary failed'))
        return Promise.resolve({})
      },
    },
    orchestrator: { choose: () => Promise.resolve(null) },
    currentAdmission: () => admission,
    requireAuthorizedPlan: () => authorizedPlanResult,
    remainingFailureRounds: () => remainingRounds,
  }
  return new AdvancePipeline(deps as never)
}

function continuousInput(input: Parameters<AdvancePipeline['verifyContinuousCandidate']>[0]) {
  return input
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-advance-branch-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root })
  config = resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    agent: { timeoutSeconds: 10 },
    maxVerificationAttempts: -1,
    autonomy: { allowCodeCommit: false },
  })
  requirement = requirementOf()
  analysis = {
    reqId: 'req-1',
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '实现改动',
    scenarios: ['完成'],
    acceptanceCriteria: ['通过'],
    clarifications: [],
    at: NOW,
  } as never
  admission = { admissionId: 'admission-1' }
  budget = { limitSeconds: -1, consumedSeconds: 0 }
  statuses = []
  failureRounds = []
  runs = []
  artifact = null
  approval = { planVersion: 1, approvedBy: 'owner', approvedAt: NOW, source: 'test' }
  remainingRounds = 3
  authorizedPlanResult = { ok: true, value: { plan } }
  verifyResults = []
  commitResult = { ok: true, commitSha: 'a'.repeat(40) }
  finishThrows = false
  deliverThrows = false
  plan = planOf()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('advance pipeline branch boundaries', () => {
  it('rejects missing, terminal, unadmitted, stale and over-budget requirements', async () => {
    const pipeline = makePipeline()
    requirement = null
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({
      ok: false,
      outcome: { state: 'failed' },
    })

    requirement = { ...requirementOf(), status: 'committed' }
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({
      ok: false,
      outcome: { state: 'failed' },
    })

    requirement = requirementOf()
    admission = null
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({
      ok: false,
      outcome: { detail: '需求没有系统准入，不能自动研发' },
    })

    admission = { admissionId: 'admission-1' }
    analysis = { ...analysis, requirementVersion: 0 } as never
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({
      ok: false,
      outcome: { detail: '需求说明缺失或已过期' },
    })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      '需求说明缺失或已过期；需要产品 Agent 重新澄清',
    ])

    analysis = { ...analysis, requirementVersion: 1 } as never
    budget = { limitSeconds: 10, consumedSeconds: 10 }
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({
      ok: false,
      outcome: { detail: '执行工时已用尽' },
    })

    budget = { limitSeconds: -1, consumedSeconds: 100 }
    expect(await pipeline['continuousInputs']('req-1')).toMatchObject({ ok: true })
  })

  it('stops before delivery and records a budget failure', async () => {
    const pipeline = makePipeline()
    budget = { limitSeconds: 1, consumedSeconds: 1 }
    expect(pipeline['advanceBudgetGuard']('req-1', plan)).toEqual({
      state: 'failed',
      detail: '执行工时已用尽；需显式延长或拆分任务',
    })
    expect(statuses.at(-1)?.[1]).toBe('blocked')

    budget = { limitSeconds: -1, consumedSeconds: 100 }
    expect(pipeline['advanceBudgetGuard']('req-1', plan)).toBeNull()
  })

  it('guards existing artifacts by authorization source', () => {
    const pipeline = makePipeline()
    expect(pipeline['existingArtifactGuard']('req-1', plan, 'a', 'source-1')).toBeNull()

    artifact = { authorizationSource: 'source-1' }
    expect(pipeline['existingArtifactGuard']('req-1', plan, 'a', 'source-1')).toEqual({ ok: true })

    artifact = { authorizationSource: 'source-2' }
    expect(pipeline['existingArtifactGuard']('req-1', plan, 'a', 'source-1')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('需人工核对'),
    })
  })

  it('turns a stop request into a blocked outcome', () => {
    const pipeline = makePipeline()
    expect(pipeline['advanceStopOutcome']('req-1', new AbortController().signal)).toBeNull()
    expect(pipeline['advanceStopOutcome']('req-1', AbortSignal.abort())).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('收到停止请求'),
    })
    expect(statuses.at(-1)?.[1]).toBe('blocked')
  })

  it('resolves routing from the model choice or the requirement binding', () => {
    const pipeline = makePipeline()
    expect(
      pipeline['routingSelection'](null, {
        sessionId: 'session-model',
        reason: '同模块',
        source: 'model',
      }),
    ).toEqual({
      selectedSessionId: 'session-model',
      selectionReason: '同模块',
      selectedBy: 'orchestrator',
    })
    expect(
      pipeline['routingSelection'](null, {
        sessionId: null,
        reason: '新建',
        source: 'new',
      }),
    ).toMatchObject({ selectedBy: 'orchestrator:new' })
    expect(pipeline['routingSelection'](null, null)).toEqual({
      selectedSessionId: null,
      selectionReason: '',
      selectedBy: 'requirement-binding',
    })
  })

  it('reports missing authorization context', () => {
    const pipeline = makePipeline()
    approval = null
    expect(pipeline['advanceInputs']('req-1')).toMatchObject({
      ok: false,
      detail: '需求 req-1 缺少计划批准记录',
    })
    approval = { planVersion: 1, approvedBy: 'owner', approvedAt: NOW, source: 'test' }
    expect(pipeline['advanceInputs']('req-1')).toMatchObject({ ok: true })
  })

  it('records a failed task when delivery throws without an artifact', async () => {
    const pipeline = makePipeline()
    deliverThrows = true
    const outcome = await pipeline['deliverTaskSafely']({
      reqId: 'req-1',
      requirement: requirementOf(),
      plan,
      taskId: 'a',
      baseline: 'base',
      authorizationSource: 'source-1',
      signal: new AbortController().signal,
      requestId: 'request-1',
    })
    expect(outcome).toMatchObject({
      ok: false,
      detail: expect.stringContaining('任务执行异常'),
    })
    expect(runs.at(-1)).toEqual([
      'req-1',
      plan,
      plan.tasks[0],
      { state: 'failed', reason: expect.stringContaining('任务执行异常') },
    ])
  })

  it('keeps a delivered artifact when delivery throws after recording it', async () => {
    const pipeline = makePipeline()
    deliverThrows = true
    artifact = { state: 'delivered' }
    const outcome = await pipeline['deliverTaskSafely']({
      reqId: 'req-1',
      requirement: requirementOf(),
      plan,
      taskId: 'a',
      baseline: 'base',
      authorizationSource: 'source-1',
      signal: new AbortController().signal,
      requestId: 'request-1',
    })
    expect(outcome).toEqual({
      ok: true,
      outcome: { state: 'delivered', reason: '', requirementStatus: 'executing' },
    })
  })

  it('releases the dev session when the summary write fails', async () => {
    const pipeline = makePipeline()
    finishThrows = true
    await pipeline['finishDevSession']({
      reqId: 'req-1',
      requirementVersion: 1,
      sessionId: 'session-1',
      session: { sessionId: 'session-1' } as never,
      requirement: requirementOf(),
      plan,
      outcome: '完成',
    })
    expect(statuses).toEqual([])
  })

  it('reports verification preparation failures as a real failed round', async () => {
    const pipeline = makePipeline()
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({ state: 'block', detail: 'no report', blocking: [], verification: null })
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toEqual({ state: 'failed', detail: 'no report' })
    expect(failureRounds).toHaveLength(1)
  })

  it('returns a failed commit as a failed advance', async () => {
    const pipeline = makePipeline()
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({
        state: 'pass',
        detail: 'ok',
        blocking: [],
        verification: { verdict: 'pass' },
      })
    pipeline['commitCandidate'] = () => Promise.resolve({ ok: false, detail: 'not allowed' })
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toEqual({ state: 'failed', detail: '受控提交未完成：not allowed' })
  })

  it('stops after the configured verification attempts', async () => {
    config = resolveConfig({
      project: 'demo',
      projectPath: root,
      recordsRoot: join(root, '.forgeloop'),
      agent: { timeoutSeconds: 10 },
      maxVerificationAttempts: 1,
      autonomy: { allowCodeCommit: false },
    })
    const pipeline = makePipeline()
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({
        state: 'block',
        detail: 'verification failed',
        blocking: ['命令失败'],
        verification: { verdict: 'block' },
      })
    pipeline['recordVerificationIssue'] = () => ({ issueId: 'issue-1', attempt: 1 }) as never
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('验证未通过'),
    })
    expect(statuses.at(-1)?.[1]).toBe('blocked')
  })

  it('repairs a verified defect and re-verifies the new candidate', async () => {
    const pipeline = makePipeline()
    verifyResults = [
      { state: 'block', detail: 'failed', blocking: ['缺陷'], verification: { verdict: 'block' } },
      { state: 'pass', detail: 'ok', blocking: [], verification: { verdict: 'pass' } },
    ]
    pipeline['verifyCandidate'] = () => Promise.resolve(verifyResults.shift() as never)
    pipeline['recordVerificationIssue'] = () => ({ issueId: 'issue-1', attempt: 1 }) as never
    pipeline['repairCandidate'] = () => Promise.resolve({ ok: true })
    pipeline['finalizeCandidate'] = () => candidate()
    pipeline['commitCandidate'] = () => Promise.resolve(commitResult)
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome.state).toBe('done')
    expect(statuses.at(-1)?.[1]).toBe('committed')
  })

  it('blocks when a verified defect cannot be repaired', async () => {
    const pipeline = makePipeline()
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({
        state: 'block',
        detail: 'failed',
        blocking: ['缺陷'],
        verification: { verdict: 'block' },
      })
    pipeline['recordVerificationIssue'] = () => ({ issueId: 'issue-1', attempt: 1 }) as never
    pipeline['repairCandidate'] = () => Promise.resolve({ ok: false, reason: '没有改动' })
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toEqual({
      state: 'failed',
      detail: '定向修复未完成：没有改动',
    })
  })

  it('blocks a business review when the failure quota is exhausted', async () => {
    const pipeline = makePipeline()
    remainingRounds = 0
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({
        state: 'block',
        detail: 'business failed',
        blocking: ['业务验收未过'],
        verification: { verdict: 'pass' },
      })
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('失败额度已用尽'),
    })
  })

  it('fails a repair when there is no usable change', async () => {
    const pipeline = makePipeline()
    const issue = {
      issueId: 'issue-9',
      attempt: 1,
      candidateSha256: 'c'.repeat(64),
      evidence: { blocking: ['缺陷'] },
    }
    ;(pipeline as never as { deps: { issues: Record<string, unknown> } }).deps.issues.latestOpen =
      () => issue
    pipeline['repairCandidate'] = () => Promise.resolve({ ok: false, reason: '没有改动' })
    const outcome = await pipeline['repairOpenIssue']({
      reqId: 'req-1',
      requirement: requirementOf(),
      plan,
      workspace: root,
      session: { sessionId: 'session-1' } as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ ok: false, detail: '定向修复未完成：没有改动' })
    expect(statuses.at(-1)?.[1]).toBe('blocked')
  })

  it('fails development when a fresh workspace cannot restore artifacts', async () => {
    const pipeline = makePipeline()
    ;(
      pipeline as never as { deps: { executionDev: Record<string, unknown> } }
    ).deps.executionDev.restoreDeliveredArtifacts = () => ({ ok: false, reason: 'artifacts lost' })
    const outcome = await pipeline['developUnderVerification']({
      reqId: 'req-1',
      requirement: requirementOf(),
      analysis: analysis as never,
      authorizationSource: 'source-1',
      workspaceInfo: {
        workspace: root,
        baselineCommit: 'b'.repeat(40),
        snapshotCommit: 's'.repeat(40),
        fresh: true,
      },
      session: { sessionId: 'session-1' } as never,
      planRef: { plan },
      verification: {
        session: { sessionId: 'v' },
        sessionId: 'v',
        plan: { scenarios: [] },
      } as never,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ state: 'failed', detail: 'artifacts lost' })
  })

  it('blocks and waits according to the acquired dev session state', async () => {
    const pipeline = makePipeline()
    pipeline['resolveDevSession'] = () =>
      Promise.resolve({
        ok: false,
        state: 'unavailable',
        sessionId: 'session-x',
        detail: 'host lost',
      })
    expect(
      await pipeline['executeContinuousAdvance']('req-1', new AbortController().signal),
    ).toEqual({
      state: 'failed',
      detail: '研发会话不可用：host lost',
    })
    expect(statuses.at(-1)?.[1]).toBe('blocked')

    pipeline['resolveDevSession'] = () =>
      Promise.resolve({
        ok: false,
        state: 'busy',
        sessionId: 'session-x',
        detail: 'session busy',
      })
    expect(
      await pipeline['executeContinuousAdvance']('req-1', new AbortController().signal),
    ).toEqual({
      state: 'done',
      detail: 'session busy',
    })
  })

  it('reports a failed task even when the plan no longer contains it', async () => {
    const pipeline = makePipeline()
    deliverThrows = true
    artifact = null
    const outcome = await pipeline['deliverTaskSafely']({
      reqId: 'req-1',
      requirement: requirementOf(),
      plan,
      taskId: 'missing-task',
      baseline: 'base',
      authorizationSource: 'source-1',
      signal: new AbortController().signal,
      requestId: 'request-1',
    })
    expect(outcome).toMatchObject({ ok: false, detail: expect.stringContaining('任务执行异常') })
    expect(runs).toHaveLength(0)
  })

  it('blocks a failed business review repair', async () => {
    const pipeline = makePipeline()
    remainingRounds = 3
    pipeline['verifyCandidate'] = () =>
      Promise.resolve({
        state: 'block',
        detail: 'business failed',
        blocking: ['业务验收未过'],
        verification: { verdict: 'pass' },
      })
    pipeline['repairCandidate'] = () => Promise.resolve({ ok: false, reason: '没有改动' })
    const outcome = await pipeline['verifyContinuousCandidate'](
      continuousInput({
        reqId: 'req-1',
        requirement: requirementOf(),
        analysis: analysis as never,
        plan,
        candidate: candidate(),
        workspace: root,
        workspaceInfo: {
          workspace: root,
          baselineCommit: 'b'.repeat(40),
          snapshotCommit: 's'.repeat(40),
          fresh: false,
        },
        session: { sessionId: 'session-1' } as never,
        verification: {
          session: { sessionId: 'v' },
          sessionId: 'v',
          plan: { scenarios: [] },
        } as never,
        signal: new AbortController().signal,
      }),
    )
    expect(outcome).toEqual({ state: 'failed', detail: '定向修复未完成：没有改动' })
  })

  it('reports an unauthorized plan message', () => {
    const pipeline = makePipeline()
    authorizedPlanResult = { ok: false, result: { message: 'plan not approved' } }
    expect(pipeline['authorizedPlanOf']('req-1')).toEqual({
      ok: false,
      detail: 'plan not approved',
    })
  })

  it('reads command evidence defensively from malformed verification reports', () => {
    const pipeline = makePipeline()
    expect(
      pipeline['issueCommands'](
        JSON.stringify({
          commands: [
            null,
            {},
            { label: 'ok' },
            {
              label: 'x',
              argv: ['a', 1],
              exitCode: 'bad',
              timedOut: true,
              aborted: true,
              logPath: 1,
              logSha256: 2,
              durationMs: 'bad',
            },
          ],
        }),
      ),
    ).toEqual([
      {
        label: 'ok',
        argv: [],
        exitCode: null,
        timedOut: false,
        aborted: false,
        logPath: '',
        logSha256: '',
        durationMs: 0,
      },
      {
        label: 'x',
        argv: ['a'],
        exitCode: null,
        timedOut: true,
        aborted: true,
        logPath: '',
        logSha256: '',
        durationMs: 0,
      },
    ])
    expect(pipeline['issueCommands']('{')).toEqual([])
    expect(pipeline['issueCommands']('null')).toEqual([])
    expect(pipeline['issueCommands']('{"commands":{}}')).toEqual([])
  })
})
