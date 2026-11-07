import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdvancePipeline } from '../src/runtime/advance-pipeline.js'
import { resolveConfig, type ForgeLoopConfig } from '../src/config.js'
import { FAILURE_PLANNING, FAILURE_VERIFICATION } from '../src/domain/counting.js'
import {
  ISSUE_FIXED,
  ISSUE_OPEN,
  ISSUE_STAGE_VERIFICATION,
  type RequirementIssue,
} from '../src/domain/issue.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import {
  AWAITING_DEV_SESSION,
  COMMITTED,
  DEVELOPING,
  EXECUTING,
  VERIFYING,
} from '../src/domain/status.js'
import type { VerificationRecord } from '../src/records/rows.js'
import type { AgentRunResult } from '../src/runtime/agent-runner.js'
import type { AcquireDevSessionResult } from '../src/runtime/dev-sessions.js'
import type { CandidateFile } from '../src/runtime/integration.js'
import type { DeliverOutcome } from '../src/runtime/task-delivery.js'

const NOW = '2026-11-03T10:00:00.000Z'
const SHA = 'a'.repeat(40)

interface VerifyOutcome {
  state: 'pass' | 'block'
  detail: string
  blocking: string[]
  verification: unknown
}

let root = ''
let config: ForgeLoopConfig
let requirement: Requirement | null
let analysis: RequirementAnalysis | null
let admission: unknown
let budget: { limitSeconds: number; consumedSeconds: number }
let statuses: Array<[string, string, string?]>
let failureRounds: Array<Record<string, unknown>>
let runs: unknown[]
let approval: unknown
let remainingRounds: number
let authorizedPlanResult:
  { ok: true; value: { plan: TaskPlan } } | { ok: false; result: { message: string } }
let plan: TaskPlan
let latestPlan: TaskPlan | null
let planOutcome: { ok: true; plan: TaskPlan } | { ok: false; code: string; reason: string }
let budgetEnsured: Array<[string, number]>
let artifactsByTask: Map<string, unknown>
let artifactRows: unknown[]
let restoreOutcome: { ok: boolean; reason?: string }
let devOutcomes: Record<string, { state: 'delivered' | 'blocked'; reason: string }>
let devCalls: string[]
let verifyQueue: VerifyOutcome[]
let verifyInputs: Array<Record<string, unknown>>
let repairOutcome: { ok: true } | { ok: false; reason: string }
let repairCalls: Array<Parameters<AdvancePipeline['repairCandidate']>[0]>
let finalizeCalls: Array<Parameters<AdvancePipeline['finalizeCandidate']>[0]>
let commitCalls: Array<Parameters<AdvancePipeline['commitCandidate']>[0]>
let commitResult: { ok: true; commitSha: string } | { ok: false; detail: string }
let acquireOutcome: AcquireDevSessionResult
let acquireCalls: unknown[]
let finished: Array<Record<string, unknown>>
let openVerificationOutcome: unknown
let openCalls: number
let closed: string[]
let issueRecords: RequirementIssue[]
let issueUpdates: Array<[string, string, string]>
let issueResolves: Array<[string, string]>
let latestOpenIssue: RequirementIssue | null
let deliverOutcomeQueue: DeliverOutcome[]
let deliverThrows: boolean
let deliverCalls: unknown[]
let verificationOutcomes: Array<{ state: 'done' | 'failed' | 'repair'; detail: string }>
let verificationCalls: number
let repairSend: (turn: { transcriptPath?: string }) => Promise<AgentRunResult>
let repairSends: number

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

function analysisOf(): RequirementAnalysis {
  return {
    reqId: 'req-1',
    analysisVersion: 1,
    requirementVersion: 1,
    goal: '实现改动',
    scenarios: ['完成'],
    acceptanceCriteria: ['通过'],
    clarifications: [],
    at: NOW,
  } as never
}

function candidateFor(version: number): CandidateFile {
  return {
    reqId: 'req-1',
    planVersion: 1,
    candidateVersion: version,
    candidateSha256: String(version).repeat(64),
    requirementVersion: 1,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    diffPath: join(root, `candidate-${version}.diff`),
    diffSha256: 'd'.repeat(64),
    createdAt: NOW,
  }
}

function verificationRecord(verdict: 'pass' | 'block'): VerificationRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict,
    reportJson: JSON.stringify({
      verdict,
      summary: verdict === 'block' ? '独立验证失败' : '独立验证通过',
      findings: [],
      blocking: verdict === 'block' ? ['命令失败'] : [],
      scenarios: [
        {
          scenario: '完成',
          status: verdict === 'block' ? 'fail' : 'pass',
          evidence: '命令输出',
          commands: ['smoke'],
        },
      ],
      commands: [
        {
          label: 'smoke',
          argv: ['node', '-e', 'process.exit(1)'],
          exitCode: verdict === 'block' ? 1 : 0,
          timedOut: false,
          aborted: false,
          logPath: '/tmp/smoke.log',
          logSha256: 'l'.repeat(64),
          durationMs: 12,
        },
      ],
    }),
    reportPath: '/tmp/report.json',
    reportSha256: 'r'.repeat(64),
    evidenceDir: '/tmp/evidence',
    sessionId: 'verify-1',
    verifiedAt: NOW,
  }
}

function passVerify(): VerifyOutcome {
  return {
    state: 'pass',
    detail: '独立验证与业务验收通过',
    blocking: [],
    verification: verificationRecord('pass'),
  }
}

function completedResult(text = '已修复'): AgentRunResult {
  return {
    status: 'completed',
    text,
    sessionId: 'session-1',
    reason: '',
    transcriptPath: '',
    durationMs: 1,
    toolCalls: [],
  }
}

function configWith(
  options: {
    allowCodeCommit?: boolean
    maxVerificationAttempts?: number
    maxTaskAttempts?: number
  } = {},
): ForgeLoopConfig {
  return resolveConfig({
    project: 'demo',
    projectPath: root,
    recordsRoot: join(root, '.forgeloop'),
    agent: { timeoutSeconds: 10 },
    maxVerificationAttempts: options.maxVerificationAttempts ?? -1,
    maxTaskAttempts: options.maxTaskAttempts ?? -1,
    autonomy: { allowCodeCommit: options.allowCodeCommit ?? false },
  })
}

function makePipeline(
  options: { stubCommit?: boolean; stubRepair?: boolean } = {},
): AdvancePipeline {
  const repo = {
    getRequirement: () => requirement,
    latestAnalysis: () => analysis,
    setStatus: (reqId: string, status: string, detail?: string) => {
      statuses.push([reqId, status, detail])
    },
    budget: () => budget,
    ensureBudget: (reqId: string, limitSeconds: number) => {
      budgetEnsured.push([reqId, limitSeconds])
    },
    recordFailureRound: (_reqId: string, round: Record<string, unknown>) => {
      failureRounds.push(round)
    },
    taskArtifact: (_reqId: string, _planVersion: number, taskId: string) =>
      artifactsByTask.get(taskId) ?? null,
    taskArtifacts: () => artifactRows,
    planApproval: () => approval,
    recordRun: (...args: unknown[]) => {
      runs.push(args)
    },
    releaseDevSession: () => undefined,
    releaseRequirementDevSession: () => undefined,
    latestTaskPlan: () => latestPlan,
    requirementDevSession: () => null,
    codeCandidates: () => [],
    recordCodeCandidate: () => undefined,
    nextPlanVersion: () => 1,
    recordCommit: () => undefined,
    activeStop: () => false,
    cancellation: () => null,
  }
  const deps = {
    config,
    repo,
    now: () => NOW,
    issues: {
      issuesFor: (reqId: string) => issueRecords.filter((issue) => issue.requirementId === reqId),
      record: (issue: RequirementIssue) => {
        issueRecords.push(issue)
      },
      latestOpen: () => latestOpenIssue,
      resolveOpen: (reqId: string, now: string) => {
        issueResolves.push([reqId, now])
        return 0
      },
      updateStatus: (issueId: string, status: string, now: string) => {
        issueUpdates.push([issueId, status, now])
        return true
      },
    },
    executionDev: {
      restoreDeliveredArtifacts: () => restoreOutcome,
      planInDevSession: async () => planOutcome,
      developTaskInSession: async (input: { task: { taskId: string } }) => {
        devCalls.push(input.task.taskId)
        return devOutcomes[input.task.taskId] ?? { state: 'delivered', reason: '' }
      },
    },
    recordRun: (...args: unknown[]) => {
      runs.push(args)
    },
    verificationPipeline: {
      executeVerification: async () => {
        verificationCalls += 1
        return verificationOutcomes.shift() ?? { state: 'done', detail: '验证通过' }
      },
    },
    legacyVerification: {
      openVerification: async () => {
        openCalls += 1
        return openVerificationOutcome
      },
      verifyCandidate: async (input: unknown) => {
        verifyInputs.push(input as Record<string, unknown>)
        return verifyQueue.shift() ?? passVerify()
      },
    },
    deliverTask: async (input: unknown) => {
      deliverCalls.push(input)
      if (deliverThrows) throw new Error('delivery exploded')
      return (
        deliverOutcomeQueue.shift() ?? {
          state: 'delivered',
          reason: '',
          requirementStatus: 'executing',
        }
      )
    },
    devSessions: {
      acquire: async (input: unknown) => {
        acquireCalls.push(input)
        return acquireOutcome
      },
      finish: async (input: unknown) => {
        finished.push(input as Record<string, unknown>)
        return {}
      },
    },
    orchestrator: { choose: () => Promise.resolve(null) },
    currentAdmission: () => admission,
    requireAuthorizedPlan: () => authorizedPlanResult,
    remainingFailureRounds: () => remainingRounds,
  }
  const pipeline = new AdvancePipeline(deps as never)
  pipeline['finalizeCandidate'] = (input: Parameters<AdvancePipeline['finalizeCandidate']>[0]) => {
    finalizeCalls.push(input)
    return candidateFor(finalizeCalls.length)
  }
  if (options.stubRepair !== false) {
    pipeline['repairCandidate'] = (input: Parameters<AdvancePipeline['repairCandidate']>[0]) => {
      repairCalls.push(input)
      return Promise.resolve(repairOutcome)
    }
  }
  if (options.stubCommit !== false) {
    pipeline['commitCandidate'] = (input: Parameters<AdvancePipeline['commitCandidate']>[0]) => {
      commitCalls.push(input)
      return Promise.resolve(commitResult)
    }
  }
  return pipeline
}

function repairInput(
  signal: AbortSignal,
  round = 1,
): Parameters<AdvancePipeline['repairCandidate']>[0] {
  return {
    reqId: 'req-1',
    requirement: requirementOf(),
    plan,
    workspace: root,
    session: {
      sessionId: 'session-1',
      send: async (turn: { transcriptPath?: string }) => {
        repairSends += 1
        return repairSend(turn)
      },
    } as never,
    blocking: ['缺陷'],
    candidate: { candidateSha256: 'c'.repeat(64) },
    signal,
    round,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-advance-gap-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '.forgeloop/\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root })

  config = configWith()
  requirement = requirementOf()
  analysis = analysisOf()
  admission = { admissionId: 'admission-1' }
  budget = { limitSeconds: -1, consumedSeconds: 100 }
  statuses = []
  failureRounds = []
  runs = []
  approval = {
    requirementId: 'req-1',
    planVersion: 1,
    approvedBy: 'owner',
    approvedAt: NOW,
    source: 'test',
  }
  remainingRounds = 3
  authorizedPlanResult = { ok: true, value: { plan: planOf() } }
  plan = planOf()
  latestPlan = plan
  planOutcome = { ok: true, plan }
  budgetEnsured = []
  artifactsByTask = new Map()
  artifactRows = [{ taskId: 'a' }, { taskId: 'b' }]
  restoreOutcome = { ok: true }
  devOutcomes = {}
  devCalls = []
  verifyQueue = []
  verifyInputs = []
  repairOutcome = { ok: true }
  repairCalls = []
  finalizeCalls = []
  commitCalls = []
  commitResult = { ok: true, commitSha: SHA }
  acquireOutcome = {
    ok: true,
    session: { sessionId: 'session-1' } as never,
    sessionId: 'session-1',
    workspace: root,
    baselineCommit: 'b'.repeat(40),
    snapshotCommit: 's'.repeat(40),
    selectedBy: 'test',
    reason: '',
    fresh: false,
  }
  acquireCalls = []
  finished = []
  openCalls = 0
  closed = []
  openVerificationOutcome = {
    ok: true,
    value: {
      session: { sessionId: 'verify-1' },
      sessionId: 'verify-1',
      plan: { scenarios: [] },
      close: async () => {
        closed.push('verify-1')
      },
    },
  }
  issueRecords = []
  issueUpdates = []
  issueResolves = []
  latestOpenIssue = null
  deliverOutcomeQueue = []
  deliverThrows = false
  deliverCalls = []
  verificationOutcomes = []
  verificationCalls = 0
  repairSend = async () => completedResult()
  repairSends = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('advance pipeline mutation gaps', () => {
  it('rejects missing, terminal and unadmitted requirements before acquiring a session', async () => {
    const pipeline = makePipeline()

    requirement = null
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '未找到需求 req-1',
    })

    requirement = { ...requirementOf(), status: COMMITTED }
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: `需求已处于终态 ${COMMITTED}`,
    })

    requirement = requirementOf()
    admission = null
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '需求没有系统准入，不能自动研发',
    })

    expect(statuses).toEqual([])
    expect(acquireCalls).toEqual([])
    expect(finished).toEqual([])
  })

  it('blocks stale requirements and exhausted continuous budgets with recorded status', async () => {
    const pipeline = makePipeline()

    analysis = { ...analysisOf(), requirementVersion: 2 } as never
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '需求说明缺失或已过期',
    })
    expect(statuses).toEqual([
      ['req-1', 'blocked', '需求说明缺失或已过期；需要产品 Agent 重新澄清'],
    ])

    statuses = []
    analysis = analysisOf()
    budget = { limitSeconds: 10, consumedSeconds: 10 }
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '执行工时已用尽',
    })
    expect(statuses).toEqual([['req-1', 'blocked', '执行工时已用尽；需要显式延长或拆分需求']])
    expect(acquireCalls).toEqual([])
  })

  it('waits on a busy session and fails on an unavailable one', async () => {
    const pipeline = makePipeline()

    acquireOutcome = {
      ok: false,
      state: 'busy',
      sessionId: 'session-x',
      detail: '研发会话 session-x 正忙；需求进入队列等待会话空闲',
    }
    expect(
      await pipeline.executeContinuousAdvance('req-1', new AbortController().signal, 'request-9'),
    ).toEqual({
      state: 'done',
      detail: '研发会话 session-x 正忙；需求进入队列等待会话空闲',
    })
    expect(statuses).toEqual([
      ['req-1', AWAITING_DEV_SESSION, '研发会话 session-x 正忙；需求进入队列等待会话空闲'],
    ])
    expect(finished).toEqual([])

    statuses = []
    acquireOutcome = {
      ok: false,
      state: 'unavailable',
      sessionId: 'session-x',
      detail: '宿主恢复失败',
    }
    expect(await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)).toEqual({
      state: 'failed',
      detail: '研发会话不可用：宿主恢复失败',
    })
    expect(statuses).toEqual([['req-1', 'blocked', '研发会话不可用：宿主恢复失败']])
    expect(acquireCalls).toHaveLength(3)
  })

  it('records a planning failure round and blocks when no plan is produced', async () => {
    const pipeline = makePipeline()
    latestPlan = null
    planOutcome = { ok: false, code: 'malformed', reason: '任务包缺少 task_id' }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({ state: 'failed', detail: '技术方案未形成：任务包缺少 task_id' })
    expect(statuses).toEqual([['req-1', 'blocked', '技术方案未形成：任务包缺少 task_id']])
    expect(failureRounds).toHaveLength(1)
    expect(failureRounds[0]).toMatchObject({
      stage: FAILURE_PLANNING,
      summary: '技术方案未形成：任务包缺少 task_id',
      occurredAt: NOW,
    })
    expect(String(failureRounds[0]?.roundId)).toMatch(/^planning-/)
    expect(openCalls).toBe(0)
    expect(devCalls).toEqual([])
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({
      reqId: 'req-1',
      plan: null,
      outcome: '技术方案未形成：任务包缺少 task_id',
    })
  })

  it('records a verification setup failure round and blocks when the verifier cannot open', async () => {
    const pipeline = makePipeline()
    openVerificationOutcome = {
      ok: false,
      result: {
        state: 'block',
        detail: '验证方案未取得可用结果：验证 Agent 超时',
        blocking: ['验证方案未取得可用结果：验证 Agent 超时'],
        verification: null,
      },
    }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({ state: 'failed', detail: '验证方案未取得可用结果：验证 Agent 超时' })
    expect(statuses).toEqual([['req-1', 'blocked', '验证方案未取得可用结果：验证 Agent 超时']])
    expect(failureRounds).toHaveLength(1)
    expect(failureRounds[0]).toMatchObject({
      stage: FAILURE_VERIFICATION,
      summary: '验证方案未取得可用结果：验证 Agent 超时',
    })
    expect(String(failureRounds[0]?.roundId)).toMatch(/^verification-plan-/)
    expect(budgetEnsured).toEqual([['req-1', 1200]])
    expect(openCalls).toBe(1)
    expect(devCalls).toEqual([])
    expect(finished).toHaveLength(1)
  })

  it('blocks a failed task development and closes the verification session', async () => {
    const pipeline = makePipeline()
    devOutcomes = {
      a: { state: 'delivered', reason: '' },
      b: { state: 'blocked', reason: '自验命令失败' },
    }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({ state: 'failed', detail: '自验命令失败' })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', 'blocked', '自验命令失败'],
    ])
    expect(devCalls).toEqual(['a', 'b'])
    expect(openCalls).toBe(1)
    expect(closed).toEqual(['verify-1'])
    expect(finalizeCalls).toEqual([])
    expect(verifyInputs).toEqual([])
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ outcome: '自验命令失败' })
  })

  it('records a failed verification round when no verification material is produced', async () => {
    const pipeline = makePipeline()
    verifyQueue = [
      { state: 'block', detail: '独立验证报告无法生成', blocking: [], verification: null },
    ]

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({ state: 'failed', detail: '独立验证报告无法生成' })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', VERIFYING, '验证 Agent 正在验证候选 v1'],
      ['req-1', 'blocked', '独立验证报告无法生成'],
    ])
    expect(failureRounds).toHaveLength(1)
    expect(failureRounds[0]).toMatchObject({
      stage: 'verification',
      summary: '独立验证报告无法生成',
      occurredAt: NOW,
    })
    expect(String(failureRounds[0]?.roundId)).toMatch(/^verification-prep-/)
    expect(finalizeCalls).toHaveLength(1)
    expect(issueRecords).toEqual([])
    expect(finished).toHaveLength(1)
  })

  it('creates an open issue and blocks when the verification attempt limit is reached', async () => {
    config = configWith({ maxVerificationAttempts: 1 })
    const pipeline = makePipeline()
    verifyQueue = [
      {
        state: 'block',
        detail: '验证命令失败',
        blocking: ['命令失败', '缺少证据'],
        verification: verificationRecord('block'),
      },
    ]

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(issueRecords).toHaveLength(1)
    const issue = issueRecords[0]!
    expect(issue).toMatchObject({
      requirementId: 'req-1',
      project: 'demo',
      attempt: 1,
      stage: ISSUE_STAGE_VERIFICATION,
      status: ISSUE_OPEN,
      candidateSha256: '1'.repeat(64),
      verificationSha256: 'r'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: '',
    })
    expect(issue.issueId).toMatch(/^issue-20261103100000-[0-9a-f]{6}$/)
    expect(issue.summary).toBe('独立验证阻断（attempt 1）：命令失败；缺少证据')
    expect(issue.evidence.blocking).toEqual(['命令失败', '缺少证据'])
    expect(issue.evidence.summary).toBe('独立验证失败')
    expect(issue.evidence.commands).toHaveLength(1)
    expect(issue.evidence.commands[0]).toMatchObject({
      label: 'smoke',
      argv: ['node', '-e', 'process.exit(1)'],
      exitCode: 1,
      logPath: '/tmp/smoke.log',
    })
    expect(issue.evidence.logs).toEqual(['/tmp/smoke.log', '/tmp/report.json'])
    expect(issue.evidence.environment).toMatchObject({
      project: 'demo',
      projectPath: root,
      planVersion: 1,
      devWorkspace: root,
    })
    expect(issue.evidence.state).toEqual({
      attempt: 1,
      stage: ISSUE_STAGE_VERIFICATION,
      verificationVerdict: 'block',
    })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', VERIFYING, '验证 Agent 正在验证候选 v1'],
      [
        'req-1',
        'blocked',
        `验证未通过，已创建问题单 ${issue.issueId}（attempt 1）：命令失败；缺少证据；问题单已加入研发队列，将自动重新验证`,
      ],
    ])
    expect(outcome).toEqual({
      state: 'failed',
      detail: `验证未通过：命令失败；缺少证据；问题单 ${issue.issueId}（attempt 1）已加入研发队列`,
    })
    expect(repairCalls).toEqual([])
    expect(issueUpdates).toEqual([])
    expect(issueResolves).toEqual([])
    expect(finished).toHaveLength(1)
  })

  it('keeps the issue open and blocks when the targeted repair has no result', async () => {
    const pipeline = makePipeline()
    verifyQueue = [
      {
        state: 'block',
        detail: '验证命令失败',
        blocking: ['命令失败', '缺少证据'],
        verification: verificationRecord('block'),
      },
    ]
    repairOutcome = { ok: false, reason: '没有可用改动' }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(issueRecords).toHaveLength(1)
    const issue = issueRecords[0]!
    expect(outcome).toEqual({ state: 'failed', detail: '定向修复未完成：没有可用改动' })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      `定向修复未完成：没有可用改动；问题单 ${issue.issueId} 保留在研发队列`,
    ])
    expect(repairCalls).toHaveLength(1)
    expect(repairCalls[0]).toMatchObject({
      reqId: 'req-1',
      blocking: ['命令失败', '缺少证据'],
      round: 1,
      workspace: root,
    })
    expect(repairCalls[0]?.candidate.candidateSha256).toBe('1'.repeat(64))
    expect(issueUpdates).toEqual([])
    expect(issueResolves).toEqual([])
    expect(finalizeCalls).toHaveLength(1)
    expect(finished).toHaveLength(1)
  })

  it('re-verifies a repaired candidate, fixes the issue and commits', async () => {
    const pipeline = makePipeline()
    verifyQueue = [
      {
        state: 'block',
        detail: '验证命令失败',
        blocking: ['命令失败'],
        verification: verificationRecord('block'),
      },
      passVerify(),
    ]
    repairOutcome = { ok: true }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    const issue = issueRecords[0]!
    expect(outcome).toEqual({
      state: 'done',
      detail: `需求 req-1 已完成研发、独立验证与提交：${SHA.slice(0, 12)}`,
    })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', VERIFYING, '验证 Agent 正在验证候选 v1'],
      ['req-1', VERIFYING, '验证 Agent 正在验证候选 v2'],
      ['req-1', COMMITTED, `已提交 ${SHA.slice(0, 12)}`],
    ])
    expect(repairCalls).toHaveLength(1)
    expect(repairCalls[0]).toMatchObject({ round: 1 })
    expect(verifyInputs).toHaveLength(2)
    expect((verifyInputs[1]?.candidate as { candidateVersion: number }).candidateVersion).toBe(2)
    expect(finalizeCalls).toHaveLength(2)
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]?.candidate.candidateVersion).toBe(2)
    expect(commitCalls[0]?.candidate.candidateSha256).toBe('2'.repeat(64))
    expect(issueUpdates).toEqual([[issue.issueId, ISSUE_FIXED, NOW]])
    expect(issueResolves).toEqual([['req-1', NOW]])
    expect(finished).toHaveLength(1)
  })

  it('blocks a business review when the failure quota is exhausted', async () => {
    const pipeline = makePipeline()
    remainingRounds = 0
    verifyQueue = [
      {
        state: 'block',
        detail: '业务场景未通过',
        blocking: ['场景失败'],
        verification: verificationRecord('pass'),
      },
    ]

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '验证未通过且失败额度已用尽：业务场景未通过',
    })
    expect(statuses.at(-1)).toEqual(['req-1', 'blocked', '验证未通过且失败额度已用尽：场景失败'])
    expect(issueRecords).toEqual([])
    expect(repairCalls).toEqual([])
    expect(failureRounds).toEqual([])
    expect(finished).toHaveLength(1)
  })

  it('repairs a failed business review and commits the new candidate', async () => {
    const pipeline = makePipeline()
    remainingRounds = 2
    verifyQueue = [
      {
        state: 'block',
        detail: '业务场景未通过',
        blocking: ['场景失败'],
        verification: verificationRecord('pass'),
      },
      passVerify(),
    ]
    repairOutcome = { ok: true }

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'done',
      detail: `需求 req-1 已完成研发、独立验证与提交：${SHA.slice(0, 12)}`,
    })
    expect(repairCalls).toHaveLength(1)
    expect(repairCalls[0]).toMatchObject({ blocking: ['场景失败'], round: 1 })
    expect(finalizeCalls).toHaveLength(2)
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]?.candidate.candidateVersion).toBe(2)
    expect(issueRecords).toEqual([])
    expect(issueUpdates).toEqual([])
    expect(issueResolves).toEqual([['req-1', NOW]])
    expect(statuses.map(([, status]) => status)).toEqual([
      DEVELOPING,
      VERIFYING,
      VERIFYING,
      COMMITTED,
    ])
  })

  it('blocks when the controlled commit is not authorized', async () => {
    const pipeline = makePipeline({ stubCommit: false })
    verifyQueue = [passVerify()]

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    const detail = '受控提交未完成：系统授权不允许代码提交；等待所有者授权'
    expect(outcome).toEqual({ state: 'failed', detail })
    expect(statuses.at(-1)).toEqual(['req-1', 'blocked', detail])
    expect(statuses.map(([, status]) => status)).toEqual([DEVELOPING, VERIFYING, 'blocked'])
    expect(issueResolves).toEqual([['req-1', NOW]])
    expect(commitCalls).toEqual([])
    expect(finished).toHaveLength(1)
  })

  it('rejects an exhausted execution budget before dispatching tasks', async () => {
    const pipeline = makePipeline()
    budget = { limitSeconds: 10, consumedSeconds: 10 }

    const outcome = await pipeline.executeAdvance(
      'req-1',
      new AbortController().signal,
      'request-1',
    )

    expect(outcome).toEqual({
      state: 'failed',
      detail: '执行工时已用尽；需显式延长或拆分任务',
    })
    expect(statuses).toEqual([['req-1', 'blocked', '执行工时已用尽；需显式延长或拆分任务']])
    expect(budgetEnsured).toEqual([['req-1', 1200]])
    expect(deliverCalls).toEqual([])
    expect(verificationCalls).toBe(0)
  })

  it('turns a stop request into a blocked outcome before delivery', async () => {
    const pipeline = makePipeline()

    const outcome = await pipeline.executeAdvance('req-1', AbortSignal.abort(), 'request-1')

    expect(outcome).toEqual({
      state: 'failed',
      detail: '收到停止请求：任务未交付，一次性工作副本会在下次执行时重建；可重新执行',
    })
    expect(statuses).toEqual([
      ['req-1', EXECUTING, undefined],
      ['req-1', 'blocked', '收到停止请求：任务未交付，一次性工作副本会在下次执行时重建'],
    ])
    expect(deliverCalls).toEqual([])
    expect(budgetEnsured).toEqual([['req-1', 1200]])
  })

  it('fails an existing artifact whose authorization differs from the current approval', async () => {
    const pipeline = makePipeline()
    artifactsByTask.set('a', { authorizationSource: 'plan-approval:req-2:v1:owner' })

    const outcome = await pipeline.executeAdvance(
      'req-1',
      new AbortController().signal,
      'request-1',
    )

    expect(outcome).toEqual({
      state: 'failed',
      detail:
        '任务 a 的既有交付绑定的是 plan-approval:req-2:v1:owner，与当前批准不一致；需人工核对',
    })
    expect(statuses).toEqual([['req-1', EXECUTING, undefined]])
    expect(deliverCalls).toEqual([])
  })

  it('records a failed task run when delivery throws without an artifact', async () => {
    const pipeline = makePipeline()
    deliverThrows = true

    const outcome = await pipeline.executeAdvance(
      'req-1',
      new AbortController().signal,
      'request-1',
    )

    const reason = '任务执行异常：delivery exploded；任务未交付，可重新执行'
    expect(outcome).toEqual({ state: 'failed', detail: reason })
    expect(runs).toEqual([['req-1', plan, plan.tasks[0], { state: 'failed', reason }]])
    expect(statuses).toEqual([
      ['req-1', EXECUTING, undefined],
      ['req-1', 'blocked', reason],
    ])
    expect(verificationCalls).toBe(0)
  })

  it('records an interrupted delivery round and returns an awaiting-user outcome', async () => {
    const pipeline = makePipeline()
    deliverOutcomeQueue = [
      {
        state: 'awaiting_user',
        reason: '需要用户确认方案',
        requirementStatus: 'awaiting_user',
        interrupted: true,
      },
    ]

    const outcome = await pipeline.executeAdvance(
      'req-1',
      new AbortController().signal,
      'request-7',
    )

    expect(outcome).toEqual({ state: 'done', detail: '需要用户确认方案' })
    expect(failureRounds).toEqual([
      {
        roundId: 'interrupted-request-7-a',
        stage: 'interrupted',
        summary: '需要用户确认方案',
        occurredAt: NOW,
      },
    ])
    expect(statuses).toEqual([
      ['req-1', EXECUTING, undefined],
      ['req-1', 'awaiting_user', '需要用户确认方案'],
    ])
    expect(deliverCalls).toHaveLength(1)
    expect(verificationCalls).toBe(0)
  })

  it('reruns the verification loop on repair and then reports a failed verification', async () => {
    const pipeline = makePipeline()
    verificationOutcomes = [
      { state: 'repair', detail: '需要再次验证' },
      { state: 'failed', detail: '独立验证未通过' },
    ]

    const outcome = await pipeline.executeAdvance(
      'req-1',
      new AbortController().signal,
      'request-1',
    )

    expect(outcome).toEqual({ state: 'failed', detail: '独立验证未通过' })
    expect(verificationCalls).toBe(2)
    expect(deliverCalls).toHaveLength(4)
    expect(statuses).toEqual([['req-1', EXECUTING, undefined]])
  })

  it('retries repairCandidate and stops on stop, timeout, no change or success', async () => {
    config = configWith({ maxTaskAttempts: 1 })
    const pipeline = makePipeline({ stubRepair: false })

    expect(await pipeline.repairCandidate(repairInput(AbortSignal.abort()))).toEqual({
      ok: false,
      reason: '停止请求：修复未完成，现场保留',
    })
    expect(repairSends).toBe(0)

    repairSend = async () => ({ ...completedResult(), status: 'timeout', reason: '模型超时' })
    expect(await pipeline.repairCandidate(repairInput(new AbortController().signal))).toEqual({
      ok: false,
      reason: '修复回合超时：模型超时',
    })
    expect(repairSends).toBe(1)

    repairSend = async () => ({ ...completedResult(), status: 'aborted', reason: '用户停止' })
    expect(await pipeline.repairCandidate(repairInput(new AbortController().signal))).toEqual({
      ok: false,
      reason: '修复回合被停止：用户停止',
    })
    expect(repairSends).toBe(2)

    repairSend = async () => completedResult()
    expect(await pipeline.repairCandidate(repairInput(new AbortController().signal))).toEqual({
      ok: false,
      reason: '修复回合没有产生可用改动',
    })
    expect(repairSends).toBe(3)

    repairSend = async () => {
      writeFileSync(join(root, 'fixed.txt'), 'fixed in repair\n')
      return completedResult('已修复缺陷')
    }
    expect(await pipeline.repairCandidate(repairInput(new AbortController().signal, 2))).toEqual({
      ok: true,
    })
    expect(repairSends).toBe(4)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
    expect(
      execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('forgeloop: repair round 2')
  })
})
