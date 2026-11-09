import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Repository } from '../src/records/repository.js'
import { Database } from '../src/records/db.js'
import {
  businessReviewDir,
  resolveConfig,
  verificationAttemptDir,
  type ForgeLoopConfig,
} from '../src/config.js'
import {
  VerificationPipeline,
  type VerificationPipelineDeps,
} from '../src/runtime/verification-pipeline.js'
import { applyDiffFile } from '../src/runtime/diff-apply.js'
import type { TestRunRequest, TestRunResult, runFormalTest } from '../src/runtime/formal-test.js'
import type { AgentRunRequest, AgentRunResult } from '../src/runtime/agent-runner.js'
import type { PlannedTask, TaskPlan } from '../src/domain/task-plan.js'
import { candidateIdentityOf, sha256OfText } from '../src/domain/delivery.js'
import { EXECUTING } from '../src/domain/status.js'
import type { OperationResult } from '../src/runtime/operation-result.js'

/**
 * 覆盖率门禁补充：独立测试与业务终审的门禁行为。
 * 只通过 VerificationPipeline 的公开方法、仓库记录（验证/终审/失败轮次/状态）
 * 与工具执行结果观察结论；覆盖材料缺失或损坏、候选组装失败、命令失败与阻断回修、
 * 候选绑定不一致、业务终审阻断等拒绝路径。
 */

const REQ_ID = 'req-cov-verify'
const NOW = '2026-11-03T00:00:00.000Z'
const SCENARIO = '候选按文档交付'
const CRITERION = '命令输出证明候选可用'
const LABEL = 'smoke'
const OUTPUT = 'verified ok: candidate works'

let project = ''
let repo: Repository

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forgeloop-verify-cov-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, '.gitignore'), '.forgeloop/\n')
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

function configOf(
  overrides: { worktreePrepareCommand?: string[]; formalTestTimeoutSeconds?: number } = {},
): ForgeLoopConfig {
  return resolveConfig(
    {
      project: 'demo',
      projectPath: project,
      recordsRoot: join(project, '.forgeloop'),
      owner: 'owner',
      pollSeconds: 1,
      agent: { provider: 'fake', model: 'fake', timeoutSeconds: 30 },
      formalTestTimeoutSeconds: overrides.formalTestTimeoutSeconds ?? 30,
      maxTaskAttempts: 2,
      failureRoundsPerGrant: 2,
      ...(overrides.worktreePrepareCommand
        ? { worktreePrepareCommand: overrides.worktreePrepareCommand }
        : {}),
    },
    project,
  )
}

function taskOf(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId,
    goal: `写 ${taskId}`,
    files: [`docs/${taskId}.md`],
    acceptance: `${taskId} 存在`,
    testCommand: ['node', '-e', 'process.exit(0)'],
    dependsOn: [],
    limits: { limitSeconds: -1, maxFailureRounds: 2 },
    authorizationSource: 'plan-approval:owner',
    ...overrides,
  }
}

function planOf(tasks: readonly PlannedTask[] = [taskOf('a')]): TaskPlan {
  return {
    taskPlanId: `plan-${REQ_ID}-v1`,
    requirementId: REQ_ID,
    project: 'demo',
    planVersion: 1,
    requirementVersion: 1,
    tasks,
    createdAt: NOW,
  }
}

function planReviewOf(verdict: 'pass' | 'block' = 'pass'): string {
  return JSON.stringify({
    kind: 'plan-review',
    reqId: REQ_ID,
    planVersion: 1,
    requirementVersion: 1,
    planSha256: 'x',
    verdict,
    blocking: verdict === 'block' ? ['任务包缺少正式测试证据'] : [],
    findings: [],
    summary: verdict === 'pass' ? '任务包可进入实现' : '任务包阻断',
    verification_plan: [
      {
        scenario: SCENARIO,
        acceptance_criterion: CRITERION,
        method: '在独立候选上执行测试命令',
        required: true,
      },
    ],
    sessionId: 'session-plan-review',
    at: NOW,
  })
}

function verificationReportOf(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: '候选通过独立测试',
    findings: [],
    blocking: [],
    scenarios: [
      {
        scenario: SCENARIO,
        status: 'pass',
        evidence: OUTPUT,
        commands: [LABEL],
      },
    ],
    ...overrides,
  })
}

function commandsOf(): string {
  return JSON.stringify({ commands: [{ label: LABEL, argv: ['node', '-e', '0'] }] })
}

function agentResult(
  request: AgentRunRequest,
  text: string,
  status: AgentRunResult['status'] = 'completed',
  reason = '',
): AgentRunResult {
  return {
    status,
    text,
    sessionId: `session-fake-${request.role}`,
    reason,
    transcriptPath: request.transcriptPath,
    durationMs: 1,
    toolCalls: [],
  }
}

function testResult(
  request: TestRunRequest,
  overrides: Partial<TestRunResult> = {},
): TestRunResult {
  const output = overrides.output ?? OUTPUT
  mkdirSync(dirname(request.logPath), { recursive: true })
  writeFileSync(request.logPath, output, 'utf8')
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    logPath: request.logPath,
    logSha256: sha256OfText(output),
    durationMs: 1,
    output,
    ...overrides,
  }
}

function identityOf(plan: TaskPlan, artifacts: ReturnType<Repository['taskArtifacts']>): string {
  const ordered = plan.tasks.map((task) => {
    const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
    if (!artifact) throw new Error(`任务 ${task.taskId} 缺少交付产物`)
    return artifact
  })
  return candidateIdentityOf({
    planVersion: plan.planVersion,
    requirementVersion: plan.requirementVersion,
    baselineCommit: ordered[0]?.baselineCommit ?? '',
    candidateHashes: ordered.map((artifact) => artifact.candidateSha256),
  })
}

interface SetupOptions {
  plan?: TaskPlan
  artifacts?: boolean
  /** 只给这些任务登记交付产物；缺省为计划里的全部任务。 */
  artifactTasks?: readonly string[]
  evidence?: readonly string[]
  planReview?: { verdict: 'pass' | 'block'; reportJson: string } | null
  authorize?: () => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  remainingRounds?: number
  reopen?: (input: { reqId: string; plan: TaskPlan; identity: string; reason: string }) => Array<{
    taskId: string
    attempt: number
    archivedPath: string
  }>
  verify?: (request: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult
  business?: (request: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult
  formalTest?: (request: TestRunRequest, call: number) => TestRunResult
  worktreePrepareCommand?: string[]
  analyze?: boolean
  candidatePath?: string
}

function setup(options: SetupOptions = {}) {
  const config = configOf({ worktreePrepareCommand: options.worktreePrepareCommand })
  const plan = options.plan ?? planOf()

  if (!repo.getRequirement(REQ_ID)) {
    repo.submit({
      reqId: REQ_ID,
      project: 'demo',
      text: '交付两份文档',
      submittedBy: 'owner',
      source: 'test',
      now: NOW,
    })
  }
  if (options.analyze !== false) {
    repo.recordAnalysis({
      reqId: REQ_ID,
      analysisVersion: 1,
      requirementVersion: 1,
      goal: '交付两份文档',
      scenarios: [SCENARIO],
      businessRules: [],
      exceptions: [],
      nonGoals: [],
      acceptanceCriteria: [CRITERION],
      clarifications: [],
      model: 'fake',
      promptVersion: 'v1',
      transcriptPath: '',
      toolCalls: [],
      createdAt: NOW,
    })
  }

  if (options.artifacts !== false) {
    for (const task of plan.tasks.filter(
      (candidate) => !options.artifactTasks || options.artifactTasks.includes(candidate.taskId),
    )) {
      repo.recordTaskArtifact({
        requirementId: REQ_ID,
        planVersion: plan.planVersion,
        taskId: task.taskId,
        candidateSha256: `candidate-${task.taskId}`,
        testEvidenceSha256: `test-${task.taskId}`,
        reviewSha256: `review-${task.taskId}`,
        acceptance: task.acceptance,
        authorizationSource: 'plan-approval:owner',
        recordedAt: NOW,
        baselineCommit: 'base',
      })
    }
  }

  if (options.planReview !== null) {
    const reportJson = options.planReview?.reportJson ?? planReviewOf()
    const reportPath = join(project, '.forgeloop', 'reviews', REQ_ID, 'plan-review.json')
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, reportJson, 'utf8')
    repo.recordPlanReview({
      requirementId: REQ_ID,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      planSha256: sha256OfText(reportJson),
      verdict: options.planReview?.verdict ?? 'pass',
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: 'session-plan-review',
      reviewedAt: NOW,
    })
  }

  const evidenceTasks = options.evidence ?? plan.tasks.map((task) => task.taskId)
  for (const taskId of evidenceTasks) {
    const candidatePath =
      options.candidatePath ?? join(project, '.forgeloop', 'diffs', `${taskId}.diff`)
    if (!existsSync(candidatePath)) {
      mkdirSync(dirname(candidatePath), { recursive: true })
      writeFileSync(candidatePath, '', 'utf8')
    }
    repo.recordEvidence({
      requirementId: REQ_ID,
      planVersion: plan.planVersion,
      taskId,
      baselineCommit: 'base',
      workspacePath: '/tmp/nowhere',
      candidatePath,
      testLogPath: '/tmp/nowhere.log',
      reviewPath: '/tmp/nowhere.json',
      devSession: 'dev-session',
      reviewSession: 'review-session',
      recordedAt: NOW,
    })
  }

  const charges: number[] = []
  const reopened: Array<{ reqId: string; identity: string; reason: string; plan: TaskPlan }> = []
  const verifyPrompts: string[] = []
  const businessPrompts: string[] = []
  let testCalls = 0

  const runner = {
    async run(request: AgentRunRequest): Promise<AgentRunResult> {
      if (request.prompt.includes('独立测试 Agent')) {
        verifyPrompts.push(request.prompt)
        if (options.verify) return options.verify(request)
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), commandsOf(), 'utf8')
        writeFileSync(join(verification, 'report.json'), verificationReportOf(), 'utf8')
        mkdirSync(join(verification, 'controls'), { recursive: true })
        writeFileSync(
          join(verification, 'controls.json'),
          JSON.stringify({
            controls: [
              {
                label: LABEL,
                patch: 'verification/controls/fault.patch',
                expected_failure_output: 'target rule broken',
              },
            ],
          }),
          'utf8',
        )
        writeFileSync(
          join(verification, 'controls', 'fault.patch'),
          'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+broken\n',
          'utf8',
        )
        return agentResult(request, verificationReportOf())
      }
      businessPrompts.push(request.prompt)
      if (options.business) return options.business(request)
      return agentResult(
        request,
        JSON.stringify({
          verdict: 'pass',
          summary: '业务终审通过',
          findings: [],
          blocking: [],
          scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: OUTPUT, commands: [LABEL] }],
          acceptance: [
            { criterion: CRITERION, status: 'pass', evidence: OUTPUT, commands: [LABEL] },
          ],
        }),
      )
    },
  }

  const formalTest = async (request: TestRunRequest): Promise<TestRunResult> => {
    testCalls += 1
    // 对照副本中的命令按已知错误实现失败；正式候选结果仍由测试给定。
    if (request.cwd.replaceAll('\\', '/').includes('/controls/')) {
      return testResult(request, {
        exitCode: 1,
        output: 'target rule broken: expected fixture, got broken',
      })
    }
    return options.formalTest ? options.formalTest(request, testCalls) : testResult(request)
  }

  const deps: VerificationPipelineDeps = {
    config,
    repo,
    now: () => NOW,
    charge: (_reqId, started) => {
      charges.push(started)
    },
    runner,
    formalTest: formalTest as unknown as typeof runFormalTest,
    ctx: {} as never,
    openAgent: async () => {
      throw new Error('验证流水线不应打开多轮会话')
    },
    candidateIdentity: identityOf,
    requireAuthorizedPlan: options.authorize ?? (() => ({ ok: true, value: { plan } }) as const),
    applyDiffFile,
    reopenDeliveredTasks: (input) => {
      reopened.push(input)
      return options.reopen
        ? options.reopen(input)
        : [{ taskId: 'a', attempt: 1, archivedPath: '/tmp/archived' }]
    },
    verificationBaseline: () => planReviewOf() as never,
    remainingFailureRounds: () => options.remainingRounds ?? 2,
  }

  return {
    pipeline: new VerificationPipeline(deps),
    config,
    plan,
    charges,
    reopened,
    verifyPrompts,
    businessPrompts,
    testCalls: () => testCalls,
    identity: () => identityOf(plan, repo.taskArtifacts(REQ_ID, plan.planVersion)),
  }
}

function statusOf(): string {
  return repo.getRequirement(REQ_ID)?.status ?? ''
}

function blockedReasonOf(): string {
  return repo.getRequirement(REQ_ID)?.blockedReason ?? ''
}

const signal = new AbortController().signal

beforeEach(() => {
  project = makeProject()
  repo = new Repository(Database.open(join(project, '.forgeloop', 'records.sqlite')))
})

afterEach(() => {
  repo.close()
  rmSync(project, { recursive: true, force: true })
})

describe('executeVerification input gates', () => {
  it('refuses to verify when the plan is not authorized', async () => {
    const built = setup({
      authorize: () => ({
        ok: false,
        result: { ok: false, code: 'blocked', message: '任务包尚未批准' },
      }),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({ state: 'failed', detail: '任务包尚未批准' })
  })

  it('refuses to verify an unknown requirement', async () => {
    const built = setup()
    const outcome = await built.pipeline.executeVerification('req-missing', signal)
    expect(outcome).toEqual({ state: 'failed', detail: '未找到需求 req-missing' })
  })

  it('refuses to verify without an analysis conclusion', async () => {
    const built = setup({ analyze: false })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: `需求 ${REQ_ID} 尚无分析结论；不能验证`,
    })
  })

  it('refuses to verify while a task still has no delivery artifact', async () => {
    const built = setup({
      plan: planOf([taskOf('a'), taskOf('b')]),
      artifactTasks: ['a'],
      evidence: ['a'],
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '仍有任务未交付，不能开始独立测试：b',
    })
  })

  it('refuses a task whose artifact exists but whose delivery evidence is missing', async () => {
    // 产物齐全但 b 没有交付证据：候选组装阶段就要挡住，不能靠模型自述补齐。
    const built = setup({ plan: planOf([taskOf('a'), taskOf('b')]), evidence: ['a'] })
    expect(repo.taskArtifacts(REQ_ID, 1).map((artifact) => artifact.taskId)).toEqual(['a', 'b'])
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toBe('任务 b 缺少交付证据；不能验证')
  })

  it('refuses to verify before the plan review happened', async () => {
    const built = setup({ planReview: null })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toBe('任务包 v1 尚未通过实现前评审；不能开始独立测试')
  })

  it('refuses to verify a plan whose review was a block', async () => {
    const built = setup({ planReview: { verdict: 'block', reportJson: planReviewOf('block') } })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('实现前评审未通过：任务包缺少正式测试证据')
  })

  it('fails closed when the plan review evidence is malformed', async () => {
    const built = setup({ planReview: { verdict: 'pass', reportJson: 'not json' } })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('实现前评审证据畸形')
  })

  it('refuses to verify a candidate that already has a blocking verification', async () => {
    const built = setup()
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, verificationReportOf({ verdict: 'block', blocking: ['缺文档'] }))
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'block',
      reportJson: verificationReportOf({ verdict: 'block', blocking: ['缺文档'] }),
      reportPath,
      reportSha256: sha256OfText(verificationReportOf({ verdict: 'block', blocking: ['缺文档'] })),
      evidenceDir: dir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('的独立测试已阻断（尝试 1，未分类）：缺文档')
    expect(outcome.detail).toContain('需修复后产生新候选再验证')
    expect(built.testCalls()).toBe(0)
  })

  it('refuses to reuse a passing verification whose report file is gone', async () => {
    const built = setup()
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'verification.json')
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: verificationReportOf(),
      reportPath,
      reportSha256: sha256OfText(verificationReportOf()),
      evidenceDir: dir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试报告文件缺失或摘要不一致；需重新验证',
    })
  })

  it('reuses a passing verification that still matches its evidence', async () => {
    const built = setup()
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, verificationReportOf(), 'utf8')
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: verificationReportOf(),
      reportPath,
      reportSha256: sha256OfText(verificationReportOf()),
      evidenceDir: dir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('done')
    expect(outcome.detail).toBe(`候选 ${identity.slice(0, 16)}… 已通过独立测试；等待验收`)
    expect(built.testCalls()).toBe(0)
  })

  it('refuses to start verification when the execution budget is spent', async () => {
    const built = setup({
      plan: planOf([taskOf('a', { limits: { limitSeconds: 1, maxFailureRounds: 2 } })]),
    })
    repo.ensureBudget(REQ_ID, 1)
    repo.chargeBudget(REQ_ID, 5)
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '执行工时已用尽；需显式延长或拆分任务',
    })
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toBe('执行工时已用尽；需显式延长或拆分任务')
  })
})

describe('executeVerification candidate assembly', () => {
  it('blocks with a recorded preflight report when a task diff cannot be applied', async () => {
    const brokenDiff = join(project, '.forgeloop', 'diffs', 'broken.diff')
    mkdirSync(dirname(brokenDiff), { recursive: true })
    writeFileSync(
      brokenDiff,
      [
        'diff --git a/docs/a.md b/docs/a.md',
        'index 1111111..2222222 100644',
        '--- a/docs/a.md',
        '+++ b/docs/a.md',
        '@@ -1,2 +1,2 @@',
        ' missing context line',
        '-old line',
        '+new line',
        '',
      ].join('\n'),
    )
    const built = setup({ candidatePath: brokenDiff })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('的候选 diff 无法应用到验证副本')
    expect(outcome.detail).toContain('证据 ')
    // 前置阻断也留下可回查的测试报告、失败轮次与需求状态。
    const record = repo.verificationForCandidate(REQ_ID, 1, built.identity())
    expect(record?.verdict).toBe('block')
    expect(existsSync(record!.reportPath)).toBe(true)
    expect(JSON.parse(readFileSync(record!.reportPath, 'utf8')).summary).toBe(
      '候选无法在当前基线组装，未执行测试命令',
    )
    expect(repo.failureRounds(REQ_ID)).toHaveLength(1)
    expect(repo.failureRounds(REQ_ID)[0]?.stage).toBe('verification')
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toContain('独立测试无法组装候选')
  })

  it('fails the verification when the workspace prepare command fails', async () => {
    const built = setup({
      worktreePrepareCommand: [process.execPath, '-e', 'process.exit(4)'],
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '验证工作副本准备命令失败（退出码 4）；需修复依赖或环境后重新验证',
    })
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toContain('这是环境问题，候选未被判定失败')
  })

  it('runs the prepare command without turning its changes into candidate content', async () => {
    const built = setup({
      worktreePrepareCommand: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('.prepare-marker', 'prepared\\n')",
      ],
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('done')
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    expect(readFileSync(join(dir, 'workspace-prepare.log'), 'utf8')).toContain('exit_code: 0')
    expect(readFileSync(join(dir, 'candidate.diff'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(join(dir, 'candidate.json'), 'utf8')).candidateSha256).toBe(
      identity,
    )
  })
})

describe('executeVerification agent and materials', () => {
  it('reports a verification agent that did not finish', async () => {
    const built = setup({
      verify: (request) => agentResult(request, '', 'error', 'model unavailable'),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试未取得可用结论：model unavailable',
    })
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toBe('独立测试 Agent 未完成：model unavailable')
  })

  it('labels a stopped verification agent as stopped', async () => {
    const aborted = setup({ verify: (request) => agentResult(request, '', 'aborted', 'stopped') })
    expect((await aborted.pipeline.executeVerification(REQ_ID, signal)).state).toBe('failed')
    expect(blockedReasonOf()).toBe('独立测试 Agent 被停止：stopped')
  })

  it('labels a verification agent that timed out as timed out', async () => {
    const timedOut = setup({
      verify: (request) => agentResult(request, '', 'timeout', 'no output'),
    })
    expect((await timedOut.pipeline.executeVerification(REQ_ID, signal)).state).toBe('failed')
    expect(blockedReasonOf()).toBe('独立测试 Agent 超时：no output')
  })

  it('fails when the verification agent produced no materials', async () => {
    const built = setup({ verify: (request) => agentResult(request, '{}') })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试未产出命令清单或逐场景报告；需重新验证',
    })
    expect(statusOf()).toBe('blocked')
  })

  it('fails closed when the verification materials cannot be parsed', async () => {
    const built = setup({
      verify: (request) => {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), 'not json', 'utf8')
        writeFileSync(join(verification, 'report.json'), verificationReportOf(), 'utf8')
        return agentResult(request, '{}')
      },
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('独立测试材料畸形（fail-closed）')
    expect(statusOf()).toBe('blocked')
  })

  it('fails closed when the agent moved the candidate commit', async () => {
    const built = setup({
      verify: (request) => {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), commandsOf(), 'utf8')
        writeFileSync(join(verification, 'report.json'), verificationReportOf(), 'utf8')
        git(request.cwd, ['commit', '-qm', 'agent moved head', '--allow-empty'])
        return agentResult(request, verificationReportOf())
      },
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toBe('独立测试期间候选提交发生变化（fail-closed）；需重新验证')
    expect(blockedReasonOf()).toBe('独立测试期间候选提交发生变化；需重新验证')
  })

  it('fails closed when the agent wrote outside the verification directory', async () => {
    const built = setup({
      verify: (request) => {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), commandsOf(), 'utf8')
        writeFileSync(join(verification, 'report.json'), verificationReportOf(), 'utf8')
        writeFileSync(join(request.cwd, 'docs.outside.md'), '越界改动\n', 'utf8')
        return agentResult(request, verificationReportOf())
      },
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toBe('独立测试越出独立测试目录（fail-closed）：docs.outside.md')
    expect(statusOf()).toBe('blocked')
  })

  it('stops verification when a verification command was aborted', async () => {
    const built = setup({
      formalTest: (request) => testResult(request, { aborted: true, exitCode: null }),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试命令被停止：测试工作区可丢弃，候选未被判定失败；可重新验证',
    })
    expect(blockedReasonOf()).toBe('独立测试命令被停止；测试工作区可丢弃，可重新验证')
  })
})

describe('completeVerification outcomes', () => {
  it('passes a candidate whose scenario evidence matches the executed command output', async () => {
    const built = setup()
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state, outcome.detail).toBe('done')
    expect(outcome.detail).toContain('已通过独立测试（1 个场景，1 条命令）')

    const verification = repo.verification(REQ_ID, 1)
    expect(verification?.verdict).toBe('pass')
    expect(JSON.parse(verification!.reportJson).commands[0].label).toBe(LABEL)
    expect(
      JSON.parse(verification!.reportJson).candidateIntegrity.ignoredBuildOutputsExcluded,
    ).toBe(true)
    expect(repo.failureRounds(REQ_ID)).toEqual([])
    expect(reqStatus()).toBe(EXECUTING)

    const review = repo.businessReview(REQ_ID, 1)
    expect(review?.verdict).toBe('pass')
    expect(built.businessPrompts[0]).toContain(LABEL)
    // 独立测试与业务终审各计一次工时。
    expect(built.charges).toHaveLength(2)
  })

  it('returns a blocking candidate to development and keeps the plan version frozen', async () => {
    const built = setup({
      remainingRounds: 2,
      formalTest: (request) =>
        testResult(request, {
          exitCode: 1,
          output: 'AssertionError: expected fixture, got broken candidate',
        }),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('repair')
    expect(outcome.detail).toContain('已返回研发修复，任务包 v1 不变')
    expect(built.reopened).toHaveLength(1)
    expect(built.reopened[0]?.identity).toBe(built.identity())
    expect(built.reopened[0]?.reason).toContain('测试命令失败')
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toContain('已返回研发修复')
    expect(repo.failureRounds(REQ_ID)).toHaveLength(1)
  })

  it('stays blocked when the failure budget is spent', async () => {
    const built = setup({
      remainingRounds: 0,
      formalTest: (request) =>
        testResult(request, {
          exitCode: 1,
          output: 'AssertionError: expected fixture, got broken candidate',
        }),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain(`测试命令失败：${LABEL} 退出码 1`)
    expect(outcome.detail).toContain(
      `证据 ${join(
        verificationAttemptDir(built.config, {
          reqId: REQ_ID,
          planVersion: 1,
          candidateSha256: built.identity(),
          attemptNumber: 1,
        }),
        'verification.json',
      )}`,
    )
    expect(built.reopened).toEqual([])
    expect(blockedReasonOf()).toContain('失败轮次额度已用尽')
  })

  it('keeps environment failures out of code repair and appends a same-candidate retry', async () => {
    let mainRuns = 0
    const built = setup({
      formalTest: (request) => {
        mainRuns += 1
        if (mainRuns === 1) {
          return testResult(request, { exitCode: null, output: 'spawn node ENOENT' })
        }
        return testResult(request)
      },
    })
    const first = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(first.state).toBe('failed')
    expect(first.detail).toContain('environment_error')
    expect(built.reopened).toEqual([])
    expect(statusOf()).toBe('blocked')
    const candidate = built.identity()
    const firstAttempt = repo.verificationAttemptsForCandidate(REQ_ID, 1, candidate)[0]
    expect(firstAttempt?.failureKind).toBe('environment_error')

    const second = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(second.state, second.detail).toBe('done')
    const attempts = repo.verificationAttemptsForCandidate(REQ_ID, 1, candidate)
    expect(attempts.map((attempt) => attempt.verdict)).toEqual(['block', 'pass'])
    // 旧尝试的报告文件与原始证据仍然存在，没有被第二次验证覆盖。
    expect(existsSync(firstAttempt!.reportPath)).toBe(true)
    expect(firstAttempt!.evidenceDir).not.toBe(attempts[1]?.evidenceDir)
  })

  it('keeps test/evidence failures out of code repair', async () => {
    const built = setup({
      verify: (request) => {
        const verification = join(request.cwd, 'verification')
        mkdirSync(verification, { recursive: true })
        writeFileSync(join(verification, 'commands.json'), commandsOf(), 'utf8')
        writeFileSync(join(verification, 'report.json'), verificationReportOf(), 'utf8')
        return agentResult(request, verificationReportOf())
      },
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('test_error')
    expect(built.reopened).toEqual([])
    expect(repo.verificationAttemptsForCandidate(REQ_ID, 1, built.identity())[0]?.failureKind).toBe(
      'test_error',
    )
  })

  it('stays blocked when reopening the delivered tasks changed nothing', async () => {
    const built = setup({
      remainingRounds: 2,
      reopen: () => [],
      formalTest: (request) =>
        testResult(request, {
          exitCode: 1,
          output: 'AssertionError: expected fixture, got broken candidate',
        }),
    })
    const outcome = await built.pipeline.executeVerification(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(blockedReasonOf()).not.toContain('已返回研发修复')
    expect(blockedReasonOf()).not.toContain('失败轮次额度已用尽')
  })
})

function reqStatus(): string {
  return repo.getRequirement(REQ_ID)?.status ?? ''
}

describe('executeBusinessReview', () => {
  function seedPassingVerification(built: ReturnType<typeof setup>): {
    reportPath: string
    verificationSha256: string
  } {
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'verification-1-smoke.log')
    writeFileSync(logPath, OUTPUT, 'utf8')
    const reportPath = join(dir, 'verification.json')
    const reportJson = `${JSON.stringify(
      {
        kind: 'verification',
        reqId: REQ_ID,
        planVersion: 1,
        requirementVersion: 1,
        candidateSha256: identity,
        workspaceSha256: 'tree',
        verdict: 'pass',
        summary: '候选通过独立测试',
        blocking: [],
        scenarios: [{ scenario: SCENARIO, status: 'pass', evidence: OUTPUT, commands: [LABEL] }],
        commands: [
          {
            label: LABEL,
            argv: ['node', '-e', '0'],
            exitCode: 0,
            timedOut: false,
            aborted: false,
            logPath,
            logSha256: sha256OfText(OUTPUT),
            durationMs: 1,
          },
        ],
      },
      null,
      2,
    )}\n`
    writeFileSync(reportPath, reportJson, 'utf8')
    const reportSha256 = sha256OfText(reportJson)
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson,
      reportPath,
      reportSha256,
      evidenceDir: dir,
      sessionId: 'session-verify',
      verifiedAt: NOW,
    })
    return { reportPath, verificationSha256: reportSha256 }
  }

  it('refuses the business review when the independent verification did not pass', async () => {
    const built = setup()
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({ state: 'failed', detail: '独立测试未通过；不能做业务终审' })
  })

  it('refuses the business review while a task still has no delivery artifact', async () => {
    const built = setup({
      plan: planOf([taskOf('a'), taskOf('b')]),
      artifactTasks: ['a'],
      evidence: ['a'],
    })
    expect(await built.pipeline.executeBusinessReview(REQ_ID, signal)).toEqual({
      state: 'failed',
      detail: '仍有任务未交付，不能做业务终审：b',
    })
  })

  it('refuses the business review when the candidate binding changed', async () => {
    const built = setup()
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, verificationReportOf(), 'utf8')
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: 'stale-candidate',
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: verificationReportOf(),
      reportPath,
      reportSha256: sha256OfText(verificationReportOf()),
      evidenceDir: dir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试绑定的候选与当前材料不一致；需重新验证后再终审',
    })
  })

  it('refuses the business review when the verification report file is missing', async () => {
    const built = setup()
    const identity = built.identity()
    const dir = verificationAttemptDir(built.config, {
      reqId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      attemptNumber: 1,
    })
    mkdirSync(dir, { recursive: true })
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: identity,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: verificationReportOf(),
      reportPath: join(dir, 'missing.json'),
      reportSha256: sha256OfText(verificationReportOf()),
      evidenceDir: dir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试报告文件缺失或摘要不一致；不能做业务终审',
    })
  })

  it('refuses the business review without an authorized plan', async () => {
    const unauthorized = setup({
      authorize: () => ({
        ok: false,
        result: { ok: false, code: 'blocked', message: '任务包尚未批准' },
      }),
    })
    expect(await unauthorized.pipeline.executeBusinessReview(REQ_ID, signal)).toEqual({
      state: 'failed',
      detail: '任务包尚未批准',
    })
  })

  it('refuses the business review when the analysis conclusion is missing', async () => {
    const noAnalysis = setup({ analyze: false })
    expect(await noAnalysis.pipeline.executeBusinessReview(REQ_ID, signal)).toEqual({
      state: 'failed',
      detail: `需求 ${REQ_ID} 尚无分析结论；不能做业务终审`,
    })
  })

  it('passes the business review and reuses it on the next attempt', async () => {
    const built = setup()
    const { verificationSha256 } = seedPassingVerification(built)
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome.state).toBe('done')
    expect(outcome.detail).toContain('业务终审通过')
    const review = repo.businessReview(REQ_ID, 1)
    expect(review?.verdict).toBe('pass')
    expect(review?.verificationSha256).toBe(verificationSha256)
    expect(existsSync(review!.reportPath)).toBe(true)
    expect(reqStatus()).toBe(EXECUTING)

    const again = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(again).toEqual({ state: 'done', detail: '业务终审已通过；等待验收' })
  })

  it('refuses a stored business review whose report was tampered with', async () => {
    const built = setup()
    const { verificationSha256 } = seedPassingVerification(built)
    const dir = businessReviewDir(built.config, REQ_ID, 1)
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'business-review.json')
    writeFileSync(reportPath, '{"verdict":"pass"}\n', 'utf8')
    repo.recordBusinessReview({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: built.identity(),
      requirementVersion: 1,
      verificationSha256,
      verdict: 'pass',
      reportJson: '{"verdict":"pass"}\n',
      reportPath,
      reportSha256: sha256OfText('original report\n'),
      sessionId: 'session',
      reviewedAt: NOW,
    })
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '业务终审报告缺失、摘要不一致或未绑定当前独立测试；需重新终审',
    })
  })

  it('refuses a candidate whose business review already blocked', async () => {
    const built = setup()
    const { verificationSha256 } = seedPassingVerification(built)
    const dir = businessReviewDir(built.config, REQ_ID, 1)
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'business-review.json')
    writeFileSync(reportPath, verificationReportOf(), 'utf8')
    repo.recordBusinessReview({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: built.identity(),
      requirementVersion: 1,
      verificationSha256,
      verdict: 'block',
      reportJson: verificationReportOf(),
      reportPath,
      reportSha256: sha256OfText(verificationReportOf()),
      sessionId: 'session',
      reviewedAt: NOW,
    })
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('的业务终审已阻断；需修复后产生新候选')
  })

  it('refuses to review when the verification facts cannot be read', async () => {
    const built = setup()
    const { reportPath } = seedPassingVerification(built)
    writeFileSync(reportPath, '{not json', 'utf8')
    // 摘要同步更新，否则会先被材料校验拦住。
    const record = repo.verification(REQ_ID, 1)!
    repo.recordVerification({
      requirementId: REQ_ID,
      planVersion: 1,
      candidateSha256: record.candidateSha256,
      requirementVersion: 1,
      workspaceSha256: 'tree',
      verdict: 'pass',
      reportJson: '{not json',
      reportPath,
      reportSha256: sha256OfText('{not json'),
      evidenceDir: record.evidenceDir,
      sessionId: 'session',
      verifiedAt: NOW,
    })
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({
      state: 'failed',
      detail: '独立测试报告无法解析；不能做业务终审',
    })
  })

  it('reports a business review agent that did not finish', async () => {
    const built = setup({
      business: (request) => agentResult(request, '', 'timeout', 'no output'),
    })
    seedPassingVerification(built)
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome).toEqual({ state: 'failed', detail: '业务终审未取得结论：no output' })
    expect(blockedReasonOf()).toBe('业务终审 Agent 超时：no output')
  })

  it('fails closed when the business review answer is malformed', async () => {
    const built = setup({ business: (request) => agentResult(request, 'not json') })
    seedPassingVerification(built)
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('业务终审材料畸形（fail-closed）')
    expect(blockedReasonOf()).toContain('业务终审材料畸形')
  })

  it('blocks the delivery when the business review verdict is block', async () => {
    const built = setup({
      business: (request) =>
        agentResult(
          request,
          JSON.stringify({
            verdict: 'block',
            summary: '业务不达标',
            findings: [],
            blocking: ['缺少对账结果'],
            scenarios: [
              { scenario: SCENARIO, status: 'fail', evidence: OUTPUT, commands: [LABEL] },
            ],
            acceptance: [
              { criterion: CRITERION, status: 'fail', evidence: OUTPUT, commands: [LABEL] },
            ],
          }),
        ),
    })
    seedPassingVerification(built)
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('业务终审阻断')
    expect(outcome.detail).toContain('缺少对账结果')
    const review = repo.businessReview(REQ_ID, 1)
    expect(review?.verdict).toBe('block')
    expect(repo.failureRounds(REQ_ID).map((round) => round.stage)).toEqual(['business_review'])
    expect(statusOf()).toBe('blocked')
    expect(blockedReasonOf()).toContain('业务终审阻断')
  })

  it('blocks the delivery when the review evidence cannot be checked against the command output', async () => {
    const built = setup({
      business: (request) =>
        agentResult(
          request,
          JSON.stringify({
            verdict: 'pass',
            summary: '看起来通过',
            findings: [],
            blocking: [],
            scenarios: [
              {
                scenario: SCENARIO,
                status: 'pass',
                evidence: 'unverifiable evidence',
                commands: [LABEL],
              },
            ],
            acceptance: [
              {
                criterion: CRITERION,
                status: 'pass',
                evidence: 'unverifiable evidence',
                commands: [LABEL],
              },
            ],
          }),
        ),
    })
    seedPassingVerification(built)
    const outcome = await built.pipeline.executeBusinessReview(REQ_ID, signal)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('证据无法在验证输出中核对')
    expect(repo.businessReview(REQ_ID, 1)?.verdict).toBe('block')
  })
})
