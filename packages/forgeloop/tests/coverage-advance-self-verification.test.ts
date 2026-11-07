import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdvancePipeline } from '../src/runtime/advance-pipeline.js'
import {
  candidatesDir,
  integrationDir,
  resolveConfig,
  type ForgeLoopConfig,
} from '../src/config.js'
import { ISSUE_FIXED, type RequirementIssue } from '../src/domain/issue.js'
import type { Requirement, RequirementAnalysis } from '../src/domain/requirement.js'
import type { SelfVerificationReport } from '../src/domain/self-verification.js'
import type { TaskPlan } from '../src/domain/task-plan.js'
import { COMMITTED, DEVELOPING, EXECUTING, VERIFYING } from '../src/domain/status.js'
import type { RequirementDevSessionRecord, VerificationRecord } from '../src/records/rows.js'
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
  repairRecommended?: boolean
  failureKind?: string
}

let root = ''
let config: ForgeLoopConfig
let requirement: Requirement | null
let analysis: RequirementAnalysis | null
let admission: unknown
let budget: { limitSeconds: number; consumedSeconds: number }
let statuses: Array<[string, string, string?]>
let failureRounds: Array<Record<string, unknown>>
let approval: unknown
let remainingRounds: number
let authorizedPlanResult:
  { ok: true; value: { plan: TaskPlan } } | { ok: false; result: { message: string } }
let plan: TaskPlan
let latestPlan: TaskPlan | null
let planOutcome: { ok: true; plan: TaskPlan } | { ok: false; code: string; reason: string }
let planThrows: Error | null
let budgetEnsured: Array<[string, number]>
let artifactsByTask: Map<string, unknown>
let artifactRows: unknown[]
let restoreOutcome: { ok: boolean; reason?: string }
let devOutcomes: Record<
  string,
  {
    state: 'delivered' | 'blocked'
    reason: string
    selfVerification?: SelfVerificationReport
    clarification?: { question: string; context: string }
  }
>
let devCalls: string[]
let verifyQueue: VerifyOutcome[]
let verifyInputs: Array<Record<string, unknown>>
let repairOutcome: { ok: true } | { ok: false; reason: string }
let repairCalls: Array<Parameters<AdvancePipeline['repairCandidate']>[0]>
let finalizeCalls: Array<Parameters<AdvancePipeline['finalizeCandidate']>[0]>
let commitCalls: Array<Parameters<AdvancePipeline['commitCandidate']>[0]>
let commitResult: { ok: true; commitSha: string } | { ok: false; detail: string }
let acquireQueue: AcquireDevSessionResult[]
let acquireCalls: Array<Record<string, unknown>>
let boundSession: RequirementDevSessionRecord | null
let orchestratorChoices: Array<Record<string, unknown>>
let orchestratorCalls: number
let acquireOutcome: AcquireDevSessionResult
let finished: Array<Record<string, unknown>>
let openVerificationOutcome: unknown
let openCalls: number
let closed: string[]
let issueRecords: RequirementIssue[]
let issueUpdates: Array<[string, string, string]>
let issueResolves: Array<[string, string]>
let latestOpenIssue: RequirementIssue | null
let versionAppends: Array<Record<string, unknown>>
let commitRecords: Array<Record<string, unknown>>
let codeCandidates: CandidateFile[]
let codeCandidateRecords: Array<Record<string, unknown>>
let deliverOutcomes: DeliverOutcome[]
let verificationOutcomes: Array<{ state: 'done' | 'failed' | 'repair'; detail: string }>
let verificationCalls: number

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
    inputKind: 'requirement',
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

function selfVerification(overrides: Partial<SelfVerificationReport> = {}): SelfVerificationReport {
  return {
    mode: 'self',
    risk: 'low',
    whiteBox: ['node -e "process.exit(0)"'],
    blackBox: ['核对文档内容'],
    redGreen: {
      required: false,
      failingBefore: false,
      passingAfter: false,
      evidence: '',
    },
    reason: '低风险改动，自验证证据充分',
    ...overrides,
  }
}

function verificationRecord(
  verdict: 'pass' | 'block',
  overrides: Partial<VerificationRecord> = {},
): VerificationRecord {
  return {
    requirementId: 'req-1',
    planVersion: 1,
    candidateSha256: 'c'.repeat(64),
    requirementVersion: 1,
    workspaceSha256: 'w'.repeat(64),
    verdict,
    reportJson: JSON.stringify({
      verdict,
      summary: verdict === 'block' ? '独立测试失败' : '独立测试通过',
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
    ...overrides,
  }
}

function passVerify(): VerifyOutcome {
  return {
    state: 'pass',
    detail: '独立测试与业务验收通过',
    blocking: [],
    verification: verificationRecord('pass'),
  }
}

function configWith(
  options: {
    allowCodeCommit?: boolean
    maxVerificationAttempts?: number
    maxTaskAttempts?: number
    projectPath?: string
    recordsRoot?: string
  } = {},
): ForgeLoopConfig {
  return resolveConfig({
    project: 'demo',
    projectPath: options.projectPath ?? root,
    recordsRoot: options.recordsRoot ?? join(root, '.forgeloop'),
    agent: { timeoutSeconds: 10 },
    maxVerificationAttempts: options.maxVerificationAttempts ?? -1,
    maxTaskAttempts: options.maxTaskAttempts ?? -1,
    autonomy: {
      allowCodeCommit: options.allowCodeCommit ?? false,
      commitCheckCommand: ['node', '-e', 'process.exit(0)'],
    },
  })
}

function makePipeline(
  options: { stubCommit?: boolean; stubRepair?: boolean; stubFinalize?: boolean } = {},
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
    recordRun: () => undefined,
    releaseDevSession: () => undefined,
    releaseRequirementDevSession: () => undefined,
    latestTaskPlan: () => latestPlan,
    requirementDevSession: () => boundSession,
    appendVersion: (input: Record<string, unknown>) => {
      versionAppends.push(input)
    },
    codeCandidates: () => codeCandidates,
    recordCodeCandidate: (record: Record<string, unknown>) => {
      codeCandidateRecords.push(record)
    },
    recordCommit: (record: Record<string, unknown>) => {
      commitRecords.push(record)
    },
    activeStop: () => null,
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
      planInDevSession: async () => {
        if (planThrows) throw planThrows
        return planOutcome
      },
      developTaskInSession: async (input: { task: { taskId: string } }) => {
        devCalls.push(input.task.taskId)
        return devOutcomes[input.task.taskId] ?? { state: 'delivered', reason: '' }
      },
    },
    recordRun: () => undefined,
    verificationPipeline: {
      executeVerification: async () => {
        verificationCalls += 1
        return verificationOutcomes.shift() ?? { state: 'done', detail: '测试通过' }
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
    deliverTask: async () => {
      return (
        deliverOutcomes.shift() ?? {
          state: 'delivered',
          reason: '',
          requirementStatus: 'executing',
        }
      )
    },
    devSessions: {
      acquire: async (input: Record<string, unknown>) => {
        acquireCalls.push(input)
        return acquireQueue.shift() ?? acquireOutcome
      },
      finish: async (input: Record<string, unknown>) => {
        finished.push(input)
        return {}
      },
    },
    orchestrator: {
      choose: async (_input: Record<string, unknown>) => {
        orchestratorCalls += 1
        return orchestratorChoices.shift() ?? null
      },
    },
    currentAdmission: () => admission,
    requireAuthorizedPlan: () => authorizedPlanResult,
    remainingFailureRounds: () => remainingRounds,
  }
  const pipeline = new AdvancePipeline(deps as never)
  if (options.stubFinalize !== false) {
    pipeline.finalizeCandidate = (input: Parameters<AdvancePipeline['finalizeCandidate']>[0]) => {
      finalizeCalls.push(input)
      return candidateFor(finalizeCalls.length)
    }
  }
  if (options.stubRepair !== false) {
    pipeline.repairCandidate = (input: Parameters<AdvancePipeline['repairCandidate']>[0]) => {
      repairCalls.push(input)
      return Promise.resolve(repairOutcome)
    }
  }
  if (options.stubCommit !== false) {
    pipeline.commitCandidate = (input: Parameters<AdvancePipeline['commitCandidate']>[0]) => {
      commitCalls.push(input)
      return Promise.resolve(commitResult)
    }
  }
  return pipeline
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeloop-advance-self-'))
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
  planThrows = null
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
  acquireQueue = []
  acquireCalls = []
  boundSession = null
  orchestratorChoices = []
  orchestratorCalls = 0
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
  versionAppends = []
  commitRecords = []
  codeCandidates = []
  codeCandidateRecords = []
  deliverOutcomes = []
  verificationOutcomes = []
  verificationCalls = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('advance pipeline self verification and dev clarification', () => {
  it('records self verification evidence and commits when every task chose self mode', async () => {
    const reportA = selfVerification()
    const reportB = selfVerification({ whiteBox: ['node -e "process.exit(0)"', '检查示例'] })
    devOutcomes = {
      a: { state: 'delivered', reason: '', selfVerification: reportA },
      b: { state: 'delivered', reason: '', selfVerification: reportB },
    }
    // self 模式现在按候选 diff 收紧：只有文档/测试材料改动才算低风险，需要真实 diff 文件。
    writeFileSync(
      join(root, 'candidate-1.diff'),
      [
        'diff --git a/docs/a.md b/docs/a.md',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1 +1 @@',
        '-旧文档',
        '+新文档',
        '',
      ].join('\n'),
    )
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance(
      'req-1',
      new AbortController().signal,
      'request-self',
    )

    const reportPath = join(
      candidatesDir(config, 'req-1', 1),
      `self-verification-${'1'.repeat(16)}.json`,
    )
    expect(outcome).toEqual({
      state: 'done',
      detail: `需求 req-1 已完成研发自验证与提交：${SHA.slice(0, 12)}（研发选择 self）`,
    })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', COMMITTED, `研发自测试通过并已提交 ${SHA.slice(0, 12)}；自验证证据 ${reportPath}`],
    ])
    expect(verifyInputs).toEqual([])
    expect(openCalls).toBe(1)
    expect(closed).toEqual(['verify-1'])
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]?.candidate.candidateSha256).toBe('1'.repeat(64))
    expect(readFileSync(reportPath, 'utf8')).toBe(
      `${JSON.stringify(
        {
          kind: 'dev-self-verification',
          reqId: 'req-1',
          planVersion: 1,
          candidateSha256: '1'.repeat(64),
          reports: [
            { taskId: 'a', report: reportA },
            { taskId: 'b', report: reportB },
          ],
          at: NOW,
        },
        null,
        2,
      )}\n`,
    )
    expect(finished).toHaveLength(1)
    expect(finished[0]?.outcome).toBe(
      `需求 req-1 已完成研发自验证与提交：${SHA.slice(0, 12)}（研发选择 self）`,
    )
  })

  it('falls back to independent verification when the self report lacks evidence', async () => {
    devOutcomes = {
      a: {
        state: 'delivered',
        reason: '',
        selfVerification: selfVerification({ whiteBox: [], blackBox: [] }),
      },
    }
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'done',
      detail: `需求 req-1 已完成研发、独立测试与提交：${SHA.slice(0, 12)}`,
    })
    expect(verifyInputs).toHaveLength(1)
    expect(statuses.map(([, status]) => status)).toEqual([DEVELOPING, VERIFYING, COMMITTED])
    expect(commitCalls).toHaveLength(1)
    expect(
      existsSync(
        join(candidatesDir(config, 'req-1', 1), `self-verification-${'1'.repeat(16)}.json`),
      ),
    ).toBe(false)
  })

  it('requires independent verification when any task reported independent mode', async () => {
    devOutcomes = {
      a: {
        state: 'delivered',
        reason: '',
        selfVerification: selfVerification({ mode: 'independent' }),
      },
      b: { state: 'delivered', reason: '', selfVerification: selfVerification() },
    }
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toMatchObject({ state: 'done', detail: expect.stringContaining('独立测试') })
    expect(verifyInputs).toHaveLength(1)
    expect(commitCalls).toHaveLength(1)
  })

  it('adds a requirement version and waits when development asks for clarification', async () => {
    devOutcomes = {
      a: {
        state: 'blocked',
        reason: '研发需要产品澄清：选 A 还是 B？',
        clarification: { question: '选 A 还是 B？', context: '已核对现有配置' },
      },
    }
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '研发需要产品澄清：选 A 还是 B？；已追加需求版本，等待回答后重新分析',
    })
    expect(statuses).toEqual([
      ['req-1', DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验'],
      ['req-1', 'blocked', '研发需要产品澄清：选 A 还是 B？'],
      ['req-1', 'awaiting_clarification', '研发请求产品澄清：选 A 还是 B？'],
    ])
    expect(versionAppends).toEqual([
      {
        reqId: 'req-1',
        text: '实现改动\n\n研发澄清请求：选 A 还是 B？\n已调查事实与无法确认之处：已核对现有配置',
        revisedBy: 'dev',
        source: 'dev-clarification:req-1',
        now: NOW,
      },
    ])
    expect(finalizeCalls).toEqual([])
    expect(verifyInputs).toEqual([])
    expect(closed).toEqual(['verify-1'])
    expect(finished[0]?.outcome).toBe(
      '研发需要产品澄清：选 A 还是 B？；已追加需求版本，等待回答后重新分析',
    )
  })

  it('marks missing clarification context as not provided', async () => {
    devOutcomes = {
      a: {
        state: 'blocked',
        reason: '研发需要产品澄清：目标平台？',
        clarification: { question: '目标平台？', context: '' },
      },
    }
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '研发需要产品澄清：目标平台？；已追加需求版本，等待回答后重新分析',
    })
    expect(versionAppends[0]).toMatchObject({
      text: '实现改动\n\n研发澄清请求：目标平台？\n已调查事实与无法确认之处：未提供',
      revisedBy: 'dev',
      source: 'dev-clarification:req-1',
    })
  })

  it('records a blocking issue from a malformed report with no blocking items', async () => {
    config = configWith({ maxVerificationAttempts: 1 })
    verifyQueue = [
      {
        state: 'block',
        detail: '测试阻断但未给出条目',
        blocking: [],
        verification: verificationRecord('block', { reportJson: '{broken' }),
      },
    ]
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(issueRecords).toHaveLength(1)
    const issue = issueRecords[0]!
    expect(issue.summary).toBe(
      '独立测试阻断（attempt 1）：独立测试判定为阻断，但测试报告没有给出具体阻断项',
    )
    expect(issue.evidence.blocking).toEqual(['独立测试判定为阻断，但测试报告没有给出具体阻断项'])
    expect(issue.evidence.summary).toBe('')
    expect(issue.evidence.commands).toEqual([])
    expect(issue.evidence.logs).toEqual(['/tmp/report.json'])
    expect(outcome).toEqual({
      state: 'failed',
      detail: `测试未通过：测试阻断但未给出条目；问题单 ${issue.issueId}（attempt 1）已加入研发队列`,
    })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      `测试未通过，已创建问题单 ${issue.issueId}（attempt 1）：测试阻断但未给出条目；问题单已加入研发队列，将自动重新验证`,
    ])
    expect(repairCalls).toEqual([])
    expect(issueUpdates).toEqual([])
  })

  it('keeps a block without asking development to fix non-code failures', async () => {
    verifyQueue = [
      {
        state: 'block',
        detail: '环境缺少依赖',
        blocking: [],
        verification: { verdict: 'block' },
        repairRecommended: false,
      },
    ]
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '测试未通过（undetermined）：环境缺少依赖；未要求研发修改代码',
    })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      '测试未通过（undetermined）：环境缺少依赖；环境缺少依赖',
    ])
    expect(issueRecords).toEqual([])
    expect(repairCalls).toEqual([])
    expect(commitCalls).toEqual([])
    expect(verifyInputs).toHaveLength(1)
  })

  it('reports the failure kind and blocking list when repair is not recommended', async () => {
    verifyQueue = [
      {
        state: 'block',
        detail: '依赖缺失导致验证无法运行',
        blocking: ['依赖缺失'],
        verification: { verdict: 'block' },
        repairRecommended: false,
        failureKind: 'environment',
      },
    ]
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '测试未通过（environment）：依赖缺失；未要求研发修改代码',
    })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      '测试未通过（environment）：依赖缺失；依赖缺失导致验证无法运行',
    ])
    expect(issueRecords).toEqual([])
    expect(repairCalls).toEqual([])
  })

  it('blocks a business-review failure with no blocking items when quota is exhausted', async () => {
    remainingRounds = 0
    verifyQueue = [
      {
        state: 'block',
        detail: '业务验收未给出具体项',
        blocking: [],
        verification: verificationRecord('pass'),
      },
    ]
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome).toEqual({
      state: 'failed',
      detail: '测试未通过且失败额度已用尽：业务验收未给出具体项',
    })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      '测试未通过且失败额度已用尽：业务验收未给出具体项',
    ])
    expect(issueRecords).toEqual([])
    expect(repairCalls).toEqual([])
  })

  it('keeps an open issue on failed repair and fixes it on a later success', async () => {
    latestOpenIssue = {
      issueId: 'issue-open-1',
      attempt: 2,
      candidateSha256: '9'.repeat(64),
      evidence: { blocking: ['缺陷仍在'] },
    } as never
    repairOutcome = { ok: false, reason: '没有可用改动' }
    const pipeline = makePipeline()

    const failed = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(failed).toEqual({ state: 'failed', detail: '定向修复未完成：没有可用改动' })
    expect(statuses.at(-1)).toEqual([
      'req-1',
      'blocked',
      '定向修复未完成：没有可用改动；问题单 issue-open-1 保留在研发队列',
    ])
    expect(repairCalls[0]).toMatchObject({
      blocking: ['缺陷仍在'],
      round: 2,
      candidate: { candidateSha256: '9'.repeat(64) },
    })
    expect(issueUpdates).toEqual([])

    statuses = []
    repairCalls = []
    repairOutcome = { ok: true }
    verifyQueue = [passVerify()]

    const fixed = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(fixed).toEqual({
      state: 'done',
      detail: `需求 req-1 已完成研发、独立测试与提交：${SHA.slice(0, 12)}`,
    })
    expect(issueUpdates).toEqual([['issue-open-1', ISSUE_FIXED, NOW]])
    expect(commitCalls).toHaveLength(1)
    expect(closed).toEqual(['verify-1', 'verify-1'])
  })

  it('routes to an alternative session when the chosen one is unavailable', async () => {
    orchestratorChoices = [
      {
        sessionId: 'session-model',
        reason: '同模块',
        source: 'model',
        alternatives: ['session-alt'],
      },
    ]
    acquireQueue = [
      { ok: false, state: 'unavailable', sessionId: 'session-model', detail: '工作区已删除' },
      {
        ok: true,
        session: { sessionId: 'session-alt' } as never,
        sessionId: 'session-alt',
        workspace: root,
        baselineCommit: 'b'.repeat(40),
        snapshotCommit: 's'.repeat(40),
        selectedBy: 'orchestrator',
        reason: '同模块',
        fresh: false,
      },
    ]
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome.state).toBe('done')
    expect(orchestratorCalls).toBe(1)
    expect(acquireCalls).toHaveLength(2)
    expect(acquireCalls[0]).toMatchObject({
      selectedSessionId: 'session-model',
      selectedBy: 'orchestrator',
      selectionReason: '同模块',
    })
    expect(acquireCalls[1]).toMatchObject({
      selectedSessionId: 'session-alt',
      selectedBy: 'orchestrator',
      selectionReason: '同模块；选中的会话不可用（工作区已删除），改用备选会话',
    })
  })

  it('uses the bound requirement session without asking the orchestrator', async () => {
    boundSession = {
      reqId: 'req-1',
      requirementVersion: 1,
      sessionId: 'session-bound',
      reason: '已绑定同一任务包',
      selectedBy: 'requirement-binding',
    } as never
    acquireOutcome = {
      ok: true,
      session: { sessionId: 'session-bound' } as never,
      sessionId: 'session-bound',
      workspace: root,
      baselineCommit: 'b'.repeat(40),
      snapshotCommit: 's'.repeat(40),
      selectedBy: 'requirement-binding',
      reason: '已绑定同一任务包',
      fresh: false,
    }
    const pipeline = makePipeline()

    const outcome = await pipeline.executeContinuousAdvance('req-1', new AbortController().signal)

    expect(outcome.state).toBe('done')
    expect(orchestratorCalls).toBe(0)
    expect(acquireCalls[0]).toMatchObject({
      selectedSessionId: 'session-bound',
      selectedBy: 'requirement-binding',
      selectionReason: '已绑定同一任务包',
    })
  })

  it('rethrows an unexpected development error and still finishes the session', async () => {
    latestPlan = null
    planThrows = new Error('planning exploded')
    const pipeline = makePipeline()

    await expect(
      pipeline.executeContinuousAdvance('req-1', new AbortController().signal),
    ).rejects.toThrow('planning exploded')

    expect(finished).toHaveLength(1)
    expect(finished[0]?.outcome).toBe('研发请求异常：planning exploded')
    expect(openCalls).toBe(0)
  })

  it('finalizes a candidate and commits it through controlled integration', async () => {
    const projectPath = join(root, 'project')
    const workspace = join(root, 'workspace')
    mkdirSync(projectPath, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: projectPath })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath })
    writeFileSync(join(projectPath, '.gitignore'), '.forgeloop/\n')
    mkdirSync(join(projectPath, 'docs'), { recursive: true })
    writeFileSync(join(projectPath, 'docs', 'a.md'), 'base\n')
    execFileSync('git', ['add', '-A'], { cwd: projectPath })
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: projectPath })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf8',
    }).trim()
    execFileSync('git', ['clone', '-q', projectPath, workspace])
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace })

    config = configWith({
      allowCodeCommit: true,
      projectPath,
      recordsRoot: join(root, 'records'),
    })
    const pipeline = makePipeline({ stubFinalize: false, stubCommit: false })
    writeFileSync(join(workspace, 'docs', 'a.md'), 'candidate change\n')

    const candidate = pipeline.finalizeCandidate({
      reqId: 'req-1',
      plan,
      workspace,
      baselineCommit: base,
      snapshotCommit: base,
    })

    expect(candidate).toMatchObject({
      reqId: 'req-1',
      planVersion: 1,
      candidateVersion: 1,
      requirementVersion: 1,
      baselineCommit: base,
      snapshotCommit: base,
      createdAt: NOW,
    })
    expect(candidate.candidateSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(candidate.diffPath).toBe(join(candidatesDir(config, 'req-1', 1), 'candidate-1.diff'))
    expect(readFileSync(candidate.diffPath, 'utf8')).toContain('candidate change')
    expect(codeCandidateRecords).toHaveLength(1)
    expect(codeCandidateRecords[0]).toMatchObject({ requirementId: 'req-1', ...candidate })
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }),
    ).toBe('')
    expect(
      execFileSync('git', ['log', '-1', '--pretty=%s'], {
        cwd: workspace,
        encoding: 'utf8',
      }).trim(),
    ).toBe('forgeloop: candidate checkpoint')

    const committed = await pipeline.commitCandidate({
      reqId: 'req-1',
      plan,
      candidate,
      requirementTitle: '实现改动',
    })

    expect(committed).toEqual({ ok: true, commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    const commitSha = (committed as { ok: true; commitSha: string }).commitSha
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim(),
    ).toBe(commitSha)
    const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: projectPath,
      encoding: 'utf8',
    })
    expect(message).toContain('feat: 实现改动')
    expect(message).toContain('ForgeLoop requirement: req-1')
    expect(message).toContain('Plan: v1')
    expect(message).toContain(`Candidate: ${candidate.candidateSha256}`)
    expect(message).toContain('Requirement version: v1')
    expect(commitRecords).toHaveLength(1)
    expect(commitRecords[0]).toMatchObject({
      requirementId: 'req-1',
      planVersion: 1,
      candidateSha256: candidate.candidateSha256,
      commitSha,
      commitMessage: '实现改动',
      checkCommand: ['node', '-e', 'process.exit(0)'],
    })
    const commitRecordPath = join(
      integrationDir(config, 'req-1', candidate.candidateSha256),
      'commit.json',
    )
    expect(JSON.parse(readFileSync(commitRecordPath, 'utf8'))).toMatchObject({
      reqId: 'req-1',
      planVersion: 1,
      candidateSha256: candidate.candidateSha256,
      commitSha,
      at: NOW,
    })
  })

  it('reports missing requirements and succeeds when every artifact is already authorized', async () => {
    const pipeline = makePipeline()

    requirement = null
    expect(
      await pipeline.executeAdvance('req-1', new AbortController().signal, 'request-advance'),
    ).toEqual({ state: 'failed', detail: '未找到需求 req-1' })

    requirement = requirementOf()
    artifactsByTask.set('a', { authorizationSource: 'plan-approval:req-1:v1:owner' })
    artifactsByTask.set('b', { authorizationSource: 'plan-approval:req-1:v1:owner' })
    verificationOutcomes = [{ state: 'done', detail: '测试通过' }]

    expect(
      await pipeline.executeAdvance('req-1', new AbortController().signal, 'request-advance'),
    ).toEqual({
      state: 'done',
      detail: '任务包 v1 的 2 个任务已交付，测试通过',
    })
    expect(statuses).toEqual([['req-1', EXECUTING, undefined]])
    expect(verificationCalls).toBe(1)
  })
})
