import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { verificationDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type {
  VerificationCheckRun,
  VerificationPlan,
  VerificationResult,
} from '../domain/verification.js'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../domain/business-review.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { FAILURE_BUSINESS_REVIEW, FAILURE_VERIFICATION } from '../domain/counting.js'
import { AGENT_VERIFY } from '../domain/agents.js'
import type { Repository, VerificationRecord } from '../records/repository.js'
import {
  VerificationAgent,
  type VerificationPlannerRequest,
  type VerificationPlannerResult,
} from '../agents/verification-agent.js'
import type { AgentOpenRequest, AgentSession } from './agent-runner.js'
import type { CandidateFile } from './integration.js'
import type { runFormalTest } from './formal-test.js'
import { businessReviewPrompt } from './prompts.js'
import {
  VERIFICATION_MATERIAL_DIR,
  businessReviewEvidenceWindow,
  workspaceChanges,
} from './service-helpers.js'
import { requireGit, runCommand } from './workspace.js'

export interface LegacyVerificationDeps {
  config: ForgeLoopConfig
  repo: Repository
  ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  now: () => string
  charge: (reqId: string, started: number) => void
  formalTest: typeof runFormalTest
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  /** 验证方案阶段的新会话执行器；不传候选、代码或任务包，只投需求说明。 */
  runner: (
    request: VerificationPlannerRequest,
  ) => Promise<VerificationPlannerResult & { readonly sessionId?: string }>
}

export interface LegacyVerifyInput {
  reqId: string
  requirement: Requirement
  analysis: RequirementAnalysis
  plan: TaskPlan
  candidate: CandidateFile
  devWorkspace: string
  signal: AbortSignal
}

export class LegacyVerification {
  constructor(private readonly deps: LegacyVerificationDeps) {}

  async runLegacyBusinessReview(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: CandidateFile
    session: AgentSession
    dir: string
    signal: AbortSignal
    runs: readonly {
      label: string
      argv: readonly string[]
      exitCode: number | null
      logPath: string
      logSha256: string
      durationMs: number
      output: string
      timedOut: boolean
      aborted: boolean
    }[]
    verification: VerificationRecord
  }): Promise<
    | {
        ok: true
        facts: Array<{
          label: string
          argv: readonly string[]
          exitCode: number | null
          logTail: string
        }>
        review: BusinessReview
        businessRun: Awaited<ReturnType<AgentSession['send']>>
        issues: readonly string[]
      }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: VerificationRecord
        }
      }
  > {
    // 业务验收使用新开的无工具会话；证据只取程序实际重跑的命令输出。
    const { runs, session, dir, verification } = input
    const facts = runs.map((item) => ({
      label: item.label,
      argv: item.argv,
      exitCode: item.exitCode,
      logTail: businessReviewEvidenceWindow(item.output),
    }))
    const businessStarted = Date.now()
    const businessRun = await session.send({
      prompt: businessReviewPrompt({
        requirement: input.requirement,
        analysis: input.analysis,
        plan: input.plan,
        candidateSha256: input.candidate.candidateSha256,
        commands: facts,
      }),
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'business-review.jsonl'),
      signal: input.signal,
    })
    this.deps.charge(input.reqId, businessStarted)
    if (businessRun.status !== 'completed') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-${randomUUID()}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收未取得结论：${businessRun.reason}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `业务验收未取得结论：${businessRun.reason}`,
          blocking: [businessRun.reason],
          verification,
        },
      }
    }
    let review: BusinessReview
    try {
      review = parseBusinessReview(businessRun.text)
    } catch (error) {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-${randomUUID()}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收材料畸形：${errorMessage(error)}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `业务验收材料畸形：${errorMessage(error)}`,
          blocking: [`业务验收材料畸形：${errorMessage(error)}`],
          verification,
        },
      }
    }
    const issues = validateBusinessReview({
      scenarios: input.analysis.scenarios,
      acceptanceCriteria: input.analysis.acceptanceCriteria,
      review,
      runs: facts.map((fact) => ({ label: fact.label, output: fact.logTail })),
    })
    return { ok: true, facts, review, businessRun, issues }
  }

  private recordLegacyBusinessReview(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    analysis: RequirementAnalysis
    dir: string
    verification: VerificationRecord
    review: BusinessReview
    facts: Array<{
      label: string
      argv: readonly string[]
      exitCode: number | null
      logTail: string
    }>
    businessRun: Awaited<ReturnType<AgentSession['send']>>
    issues: readonly string[]
    runs: readonly unknown[]
  }): {
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord
  } {
    const { issues, verification, review, businessRun, dir, runs } = input
    const businessVerdict: 'pass' | 'block' =
      review.verdict === 'pass' && issues.length === 0 ? 'pass' : 'block'
    const businessBlocking =
      businessVerdict === 'block' ? (issues.length > 0 ? issues : review.blocking) : []
    const businessReport = {
      kind: 'business-review',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      verificationSha256: verification.reportSha256,
      verdict: businessVerdict,
      summary: review.summary,
      findings: review.findings,
      blocking: [...businessBlocking],
      scenarios: review.scenarios,
      acceptance: review.acceptance,
      sessionId: businessRun.sessionId,
      at: this.deps.now(),
    }
    const businessJson = `${JSON.stringify(businessReport, null, 2)}\n`
    const businessPath = join(dir, 'business-review.json')
    writeFileSync(businessPath, businessJson, 'utf8')
    this.deps.repo.recordBusinessReview({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      verificationSha256: verification.reportSha256,
      verdict: businessVerdict,
      reportJson: businessJson,
      reportPath: businessPath,
      reportSha256: sha256OfText(businessJson),
      sessionId: businessRun.sessionId,
      reviewedAt: this.deps.now(),
    })
    if (businessVerdict === 'block') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务验收阻断：${businessBlocking.join('；') || review.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        state: 'block',
        detail: `业务验收阻断：${businessBlocking.join('；') || review.summary}；证据 ${businessPath}`,
        blocking: [...businessBlocking],
        verification,
      }
    }
    return {
      state: 'pass',
      detail: `候选 ${input.candidate.candidateSha256.slice(0, 16)}… 通过独立验证与业务验收（${runs.length} 条命令）`,
      blocking: [],
      verification,
    }
  }

  private recordAgentVerification(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    dir: string
    workspaceSha256: string
    verificationPlan: VerificationPlan
    result: VerificationResult
    checks: readonly VerificationCheckRun[]
    checkLogs: readonly { readonly path: string; readonly sha256: string }[]
    integrityIssues: readonly string[]
    afterHead: string
    afterChanges: readonly string[]
    sessionId: string
  }):
    | { ok: true; verification: VerificationRecord }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: VerificationRecord
        }
      } {
    const { dir, workspaceSha256, result, integrityIssues, afterHead, afterChanges } = input
    const scenarios = result.scenarios.map((scenario) => ({
      scenario: scenario.scenario,
      status: scenario.status,
      evidence: scenario.evidence,
      commands: scenario.checks.map((check) => check.label),
    }))
    const blocking = [...result.failures, ...integrityIssues]
    const verdict: 'pass' | 'block' =
      result.verdict === 'passed' && integrityIssues.length === 0 ? 'pass' : 'block'
    const commands = input.checks.map((check, index) => ({
      label: check.label,
      argv: check.argv,
      exitCode: check.exitCode,
      timedOut: check.timedOut,
      aborted: check.aborted,
      durationMs: check.durationMs,
      logPath: input.checkLogs[index]?.path ?? '',
      logSha256: input.checkLogs[index]?.sha256 ?? '',
    }))
    const canonical = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      candidateVersion: input.candidate.candidateVersion,
      snapshotCommit: input.candidate.snapshotCommit,
      workspaceSha256,
      verificationPlan: input.verificationPlan,
      environment: result.environment,
      verdict,
      summary: result.summary,
      findings: [],
      blocking,
      scenarios,
      commands,
      candidateIntegrity: {
        head: afterHead,
        changes: afterChanges,
        allowedPaths: [VERIFICATION_MATERIAL_DIR],
      },
      sessionId: input.sessionId,
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const verificationPath = join(dir, 'verification.json')
    writeFileSync(verificationPath, reportJson, 'utf8')
    const verification: VerificationRecord = {
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256,
      verdict,
      reportJson,
      reportPath: verificationPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: input.sessionId,
      verifiedAt: this.deps.now(),
    }
    this.deps.repo.recordVerification(verification)
    if (verdict === 'block') {
      this.deps.repo.recordFailureRound(input.reqId, {
        roundId: `verification-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}`,
        stage: FAILURE_VERIFICATION,
        summary: `独立验证阻断：${blocking.join('；') || result.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `独立验证阻断：${blocking.join('；') || result.summary}；证据 ${verificationPath}`,
          blocking,
          verification,
        },
      }
    }
    return { ok: true, verification }
  }

  private prepareLegacyVerificationWorkspace(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    devWorkspace: string
  }):
    | {
        ok: true
        dir: string
        workspace: string
        workspaceSha256: string
        workspaceHead: string
      }
    | {
        ok: false
        result: { state: 'block'; detail: string; blocking: string[]; verification: null }
      } {
    const dir = verificationDir(
      this.deps.config,
      input.reqId,
      input.plan.planVersion,
      input.candidate.candidateSha256,
    )
    const workspace = join(dir, 'workspace')
    mkdirSync(dir, { recursive: true })
    rmSync(workspace, { recursive: true, force: true })
    // 旧候选的验证 worktree 可能已登记但目录被清理；先移除登记再创建，
    // 否则重试验证会永久卡在“丢失但已注册的工作区”。
    runCommand('git', ['worktree', 'remove', '--force', workspace], input.devWorkspace, 30_000)
    runCommand('git', ['worktree', 'prune'], input.devWorkspace, 30_000)
    const added = runCommand(
      'git',
      ['worktree', 'add', '--detach', workspace, input.candidate.snapshotCommit],
      input.devWorkspace,
      60_000,
    )
    if (added.code !== 0) {
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `无法从研发现场创建独立验证工作区：${added.stderr.trim() || added.stdout.trim()}`,
          blocking: ['独立验证工作区创建失败'],
          verification: null,
        },
      }
    }
    const applied = runCommand(
      'git',
      ['apply', '--binary', input.candidate.diffPath],
      workspace,
      60_000,
    )
    if (applied.code !== 0) {
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `候选 diff 无法应用到独立验证工作区：${applied.stderr.trim() || applied.stdout.trim()}`,
          blocking: ['候选 diff 无法应用'],
          verification: null,
        },
      }
    }
    runCommand('git', ['add', '-A'], workspace)
    runCommand('git', ['commit', '-qm', 'forgeloop: verification candidate'], workspace)
    if (this.deps.config.worktreePrepareCommand.length > 0) {
      const prepare = runCommand(
        this.deps.config.worktreePrepareCommand[0] ?? '',
        this.deps.config.worktreePrepareCommand.slice(1),
        workspace,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      if (prepare.code !== 0) {
        return {
          ok: false,
          result: {
            state: 'block',
            detail: `验证工作区准备命令失败（退出码 ${prepare.code}）`,
            blocking: [`验证工作区准备命令失败（退出码 ${prepare.code}）`],
            verification: null,
          },
        }
      }
      runCommand('git', ['reset', '--hard', 'HEAD'], workspace)
      runCommand('git', ['clean', '-fd'], workspace)
    }
    const workspaceSha256 = requireGit(workspace, ['rev-parse', 'HEAD^{tree}']).trim()
    const workspaceHead = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    const diff = readFileSync(input.candidate.diffPath, 'utf8')
    writeFileSync(join(dir, 'candidate.diff'), diff, 'utf8')
    writeFileSync(
      join(dir, 'candidate.json'),
      `${JSON.stringify(
        {
          reqId: input.reqId,
          planVersion: input.plan.planVersion,
          requirementVersion: input.plan.requirementVersion,
          candidateSha256: input.candidate.candidateSha256,
          candidateVersion: input.candidate.candidateVersion,
          baselineCommit: input.candidate.baselineCommit,
          snapshotCommit: input.candidate.snapshotCommit,
          workspaceSha256,
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return { ok: true, dir, workspace, workspaceSha256, workspaceHead }
  }

  async verifyCandidate(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: CandidateFile
    devWorkspace: string
    signal: AbortSignal
  }): Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord | null
  }> {
    const prepared = this.prepareLegacyVerificationWorkspace(input)
    if (!prepared.ok) return prepared.result
    const { dir, workspace, workspaceSha256, workspaceHead } = prepared
    const logs: Array<{ path: string; sha256: string }> = []
    let planSessionId = ''
    const agent = new VerificationAgent({
      runner: {
        run: async (request) => {
          const outcome = await this.deps.runner(request)
          planSessionId = outcome.sessionId ?? ''
          return outcome
        },
      },
      executeCheck: async ({ cwd, argv, timeoutMs, signal }) => {
        const index = logs.length + 1
        const test = await this.deps.formalTest({
          ctx: this.deps.ctx,
          cwd,
          argv,
          timeoutMs,
          logPath: join(dir, `verification-${index}.log`),
          ...(signal ? { signal } : {}),
        })
        logs.push({ path: test.logPath, sha256: test.logSha256 })
        return {
          exitCode: test.exitCode,
          output: test.output,
          timedOut: test.timedOut,
          aborted: test.aborted,
          durationMs: test.durationMs,
        }
      },
      projectPath: this.deps.config.projectPath,
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
    })

    // 方案阶段只读取需求原文与分析，不接触任务包、候选 diff、源码或工作区。
    const planStarted = Date.now()
    let plan: VerificationPlan
    try {
      plan = await agent.plan({
        requirement: input.requirement,
        analysis: input.analysis,
        transcriptPath: join(dir, 'verify-plan.jsonl'),
        signal: input.signal,
      })
    } catch (error) {
      const detail = `验证方案未取得可用结果：${errorMessage(error)}`
      return { state: 'block', detail, blocking: [detail], verification: null }
    } finally {
      this.deps.charge(input.reqId, planStarted)
    }
    writeFileSync(join(dir, 'verification-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

    // 执行阶段由程序在固定候选上逐条重跑命令，模型不再看得到候选内容。
    let result: VerificationResult
    try {
      result = await agent.execute({
        plan,
        artifact: {
          requirementVersion: input.plan.requirementVersion,
          candidateSha256: input.candidate.candidateSha256,
          workspace,
        },
        signal: input.signal,
      })
    } catch (error) {
      const detail = `验证方案执行未取得结果：${errorMessage(error)}`
      return { state: 'block', detail, blocking: [detail], verification: null }
    }
    if (result.checks.some((check) => check.aborted)) {
      return {
        state: 'block',
        detail: '独立验证命令被停止；验证工作区可丢弃，可重新验证',
        blocking: ['独立验证命令被停止'],
        verification: null,
      }
    }
    const afterHead = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    if (afterHead !== workspaceHead) {
      return {
        state: 'block',
        detail: '验证期间候选提交发生变化',
        blocking: ['验证期间候选提交发生变化'],
        verification: null,
      }
    }
    const afterChanges = workspaceChanges(workspace)
    const outside = afterChanges.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
    const integrityIssues =
      outside.length > 0 ? [`验证命令修改了固定候选：${outside.join('、')}`] : []
    const recorded = this.recordAgentVerification({
      reqId: input.reqId,
      plan: input.plan,
      candidate: input.candidate,
      dir,
      workspaceSha256,
      verificationPlan: plan,
      result,
      checks: result.checks,
      checkLogs: logs,
      integrityIssues,
      afterHead,
      afterChanges,
      sessionId: planSessionId,
    })
    if (!recorded.ok) return recorded.result
    const verification = recorded.verification
    const runs = result.checks.map((check, index) => ({
      ...check,
      logPath: logs[index]?.path ?? '',
      logSha256: logs[index]?.sha256 ?? '',
    }))

    // 业务验收新开一个无工具会话：只给需求、任务验收与程序重跑出的命令输出。
    const reviewSession = await this.deps.openAgent({
      role: AGENT_VERIFY,
      cwd: dir,
      permission: 'workspace-write',
      tools: 'none',
    })
    try {
      const business = await this.runLegacyBusinessReview({
        reqId: input.reqId,
        requirement: input.requirement,
        analysis: input.analysis,
        plan: input.plan,
        candidate: input.candidate,
        session: reviewSession,
        dir,
        signal: input.signal,
        runs,
        verification,
      })
      if (!business.ok) return business.result
      const { facts, review, businessRun, issues } = business
      return this.recordLegacyBusinessReview({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        analysis: input.analysis,
        dir,
        verification,
        review,
        facts,
        businessRun,
        issues,
        runs,
      })
    } finally {
      await reviewSession.close()
    }
  }
}
