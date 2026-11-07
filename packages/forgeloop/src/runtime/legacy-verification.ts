import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { verificationAttemptDir, verificationPlanDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type { VerificationPlan, VerificationResult } from '../domain/verification.js'
import { judgeVerificationResult } from '../domain/verification.js'
import {
  CONTROLS_FILE,
  parseVerificationControls,
  validateControlCoverage,
} from '../domain/verification-controls.js'
import { classifyVerificationFailure } from '../domain/verification-failure.js'
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
import { VerificationAgent } from '../agents/verification-agent.js'
import type { VerificationSession } from '../agents/verification-agent.js'
import type { AgentOpenRequest, AgentSession } from './agent-runner.js'
import type { CandidateFile } from './integration.js'
import { businessReviewPrompt, verificationExecutionPrompt } from './prompts.js'
import {
  VERIFICATION_CHECK_TOOL,
  VERIFICATION_CONTROL_TOOL,
  VERIFICATION_MATERIAL_TOOL,
  VerificationCheckRegistry,
  verificationMaterialsDigest,
  type VerificationCheckRecord,
  type VerificationCheckSnapshot,
} from './verification-checks.js'
import {
  VERIFICATION_MATERIAL_DIR,
  businessReviewEvidenceWindow,
  workspaceChanges,
} from './service-helpers.js'
import { requireGit, runCommand } from './workspace.js'

export interface LegacyVerificationDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  charge: (reqId: string, started: number) => void
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  /** 验证会话的工具执行上下文；只接受当前候选与当前方案中的命令。 */
  checks: VerificationCheckRegistry
}

export interface LegacyVerifyInput {
  reqId: string
  requirement: Requirement
  analysis: RequirementAnalysis
  plan: TaskPlan
  candidate: CandidateFile
  devWorkspace: string
  signal: AbortSignal
  /** 研发开始前建立的验证会话；方案与业务验收共用它。 */
  verification: LegacyVerificationSession
}

/**
 * 同一验证会话的两段工作：研发交付前生成方案，交付后执行方案并做业务验收。
 * 会话在整条推进请求期间保持打开，方案、命令执行与业务验收共享上下文。
 */
export interface LegacyVerificationSession {
  readonly session: AgentSession
  readonly sessionId: string
  readonly plan: VerificationPlan
  close(): Promise<void>
}

export class LegacyVerification {
  constructor(private readonly deps: LegacyVerificationDeps) {}

  /**
   * 研发开始前新开验证会话并生成方案。方案只依据需求说明与已准入任务目标，
   * 不接触候选、diff 或源码；方案失败时不进入研发。
   */
  async openVerification(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    signal: AbortSignal
  }): Promise<
    | { ok: true; value: LegacyVerificationSession }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: null
        }
      }
  > {
    const dir = verificationPlanDir(this.deps.config, input.reqId, input.plan.planVersion)
    mkdirSync(dir, { recursive: true })
    const session = await this.deps.openAgent({
      role: AGENT_VERIFY,
      cwd: this.deps.config.projectPath,
      permission: 'workspace-write',
      allowTools: [VERIFICATION_CHECK_TOOL, VERIFICATION_CONTROL_TOOL, VERIFICATION_MATERIAL_TOOL],
    })
    const started = Date.now()
    let plan: VerificationPlan
    try {
      const agent = new VerificationAgent({
        session: {
          sessionId: session.sessionId,
          send: (turn) => session.send(turn),
        },
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        projectPath: this.deps.config.projectPath,
      })
      plan = await agent.plan({
        requirement: input.requirement,
        analysis: input.analysis,
        plan: input.plan,
        transcriptPath: join(dir, 'verify-plan.jsonl'),
        signal: input.signal,
      })
    } catch (error) {
      await session.close()
      const detail = `验证方案未取得可用结果：${errorMessage(error)}`
      return {
        ok: false,
        result: { state: 'block', detail, blocking: [detail], verification: null },
      }
    } finally {
      this.deps.charge(input.reqId, started)
    }
    writeFileSync(join(dir, 'verification-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      value: {
        session,
        sessionId: session.sessionId,
        plan,
        close: () => session.close(),
      },
    }
  }

  async runLegacyBusinessReview(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    verificationPlan: VerificationPlan
    candidate: CandidateFile
    session: AgentSession
    dir: string
    signal: AbortSignal
    runs: readonly VerificationCheckRecord[]
    verification: VerificationRecord
    attemptId: string
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
    // 业务验收与方案、执行共用同一个会话；证据只取工具实际执行的输出。
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
        verificationPlan: input.verificationPlan,
        candidateSha256: input.candidate.candidateSha256,
        commands: facts,
      }),
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'business-review.jsonl'),
      signal: input.signal,
    })
    this.deps.charge(input.reqId, businessStarted)
    if (businessRun.status !== 'completed') {
      const detail = `业务验收未取得结论：${businessRun.reason}`
      this.recordBusinessReviewError({
        ...input,
        detail,
        kind: 'test_error',
        blocking: [businessRun.reason],
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail,
          blocking: [businessRun.reason],
          verification,
        },
      }
    }
    let review: BusinessReview
    try {
      review = parseBusinessReview(businessRun.text)
    } catch (error) {
      const detail = `业务验收材料畸形：${errorMessage(error)}`
      this.recordBusinessReviewError({
        ...input,
        detail,
        kind: 'insufficient_evidence',
        blocking: [detail],
      })
      return {
        ok: false,
        result: {
          state: 'block',
          detail,
          blocking: [detail],
          verification,
        },
      }
    }
    const issues = validateBusinessReview({
      scenarios: input.analysis.scenarios,
      acceptanceCriteria: input.analysis.acceptanceCriteria,
      businessRules: input.analysis.businessRules,
      exceptions: input.analysis.exceptions,
      businessPoints: input.analysis.businessPoints,
      acceptanceItems: input.analysis.acceptanceItems,
      review,
      runs: runs.map((run) => ({
        label: run.label,
        output: run.output,
        exitCode: run.exitCode,
      })),
    })
    return { ok: true, facts, review, businessRun, issues }
  }

  /** 终审超时或 JSON 畸形：在本次尝试目录留证，并计入业务验收失败。 */
  private recordBusinessReviewError(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    dir: string
    attemptId: string
    verification: VerificationRecord
    detail: string
    kind: string
    blocking: readonly string[]
  }): void {
    const report = {
      kind: 'business-review-error',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      verificationSha256: input.verification.reportSha256,
      attemptId: input.attemptId,
      failureKind: input.kind,
      detail: input.detail,
      blocking: input.blocking,
      at: this.deps.now(),
    }
    writeFileSync(
      join(input.dir, 'business-review-error.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    )
    this.deps.repo.recordFailureRound(input.reqId, {
      roundId: `business-review-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-a${input.attemptId}`,
      stage: FAILURE_BUSINESS_REVIEW,
      summary: input.detail.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
  }

  private recordLegacyBusinessReview(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    verification: VerificationRecord
    review: BusinessReview
    businessRun: Awaited<ReturnType<AgentSession['send']>>
    issues: readonly string[]
    runs: readonly VerificationCheckRecord[]
  }): {
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord
  } {
    const { issues, verification, review, businessRun, runs } = input
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
      businessRules: review.businessRules,
      exceptions: review.exceptions,
      sessionId: businessRun.sessionId,
      at: this.deps.now(),
    }
    const businessJson = `${JSON.stringify(businessReport, null, 2)}\n`
    const businessPath = join(verification.evidenceDir, 'business-review.json')
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

  private legacyConclusion(input: {
    result: VerificationResult
    blocking: readonly string[]
    integrityIssues: readonly string[]
    controlIssues: readonly string[]
  }): {
    verdict: 'pass' | 'block'
    classification: ReturnType<typeof classifyVerificationFailure> | null
  } {
    const passed =
      input.result.verdict === 'passed' &&
      input.integrityIssues.length === 0 &&
      input.controlIssues.length === 0
    if (passed) return { verdict: 'pass', classification: null }
    return {
      verdict: 'block',
      classification: classifyVerificationFailure({
        blocking: input.blocking,
        commandRuns: input.result.scenarios.flatMap((scenario) => scenario.checks),
        failedScenarios: input.result.scenarios
          .filter((scenario) => scenario.status === 'fail')
          .map((scenario) => scenario.scenario),
        integrityIssues: input.integrityIssues,
        controlIssues: input.controlIssues,
      }),
    }
  }

  /** 中止、超时、材料错误等未进入判定的尝试也必须留证，绑定同一次尝试身份。 */
  private recordBlockedAttempt(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    workspaceSha256: string
    dir: string
    attempt: { number: number; id: string; previousAttemptId: string }
    sessionId: string
    detail: string
    blocking: readonly string[]
    failureKind: string
    runs: readonly VerificationCheckRecord[]
  }): {
    state: 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord
    failureKind: string
    repairRecommended: false
  } {
    const canonical = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      candidateVersion: input.candidate.candidateVersion,
      snapshotCommit: input.candidate.snapshotCommit,
      attemptId: input.attempt.id,
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
      workspaceSha256: input.workspaceSha256,
      verdict: 'block',
      failureKind: input.failureKind,
      blocking: input.blocking,
      detail: input.detail,
      commands: input.runs.map((run) => ({
        label: run.label,
        argv: run.argv,
        category: run.category ?? 'acceptance',
        materialsSha256: run.materialsSha256,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        aborted: run.aborted,
        durationMs: run.durationMs,
        logPath: run.logPath,
        logSha256: run.logSha256,
      })),
      sessionId: input.sessionId,
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const reportPath = join(input.dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    const verification: VerificationRecord = {
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256: input.workspaceSha256,
      verdict: 'block',
      failureKind: input.failureKind,
      blocking: input.blocking,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: input.dir,
      sessionId: input.sessionId,
      verifiedAt: this.deps.now(),
      attemptId: input.attempt.id,
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
    }
    this.deps.repo.recordVerification(verification)
    this.deps.repo.recordFailureRound(input.reqId, {
      roundId: `verification-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-a${input.attempt.number}`,
      stage: FAILURE_VERIFICATION,
      summary: `验证未取得结论（${input.failureKind}）：${input.detail}`.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    return {
      state: 'block',
      detail: input.detail,
      blocking: [...input.blocking],
      verification,
      failureKind: input.failureKind,
      repairRecommended: false,
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
    checks: readonly VerificationCheckRecord[]
    integrityIssues: readonly string[]
    afterHead: string
    afterChanges: readonly string[]
    sessionId: string
    controls: readonly {
      label: string
      patch: string
      controlDir: string
      applied: boolean
      exitCode: number | null
      timedOut: boolean
      aborted: boolean
      durationMs: number
      output: string
      logPath: string
      logSha256: string
      issue: string
    }[]
    controlIssues: readonly string[]
    attempt: { number: number; previousAttemptId: string; dir: string }
  }):
    | {
        ok: true
        verification: VerificationRecord
        failureKind: ''
        repairRecommended: false
      }
    | {
        ok: false
        result: {
          state: 'block'
          detail: string
          blocking: string[]
          verification: VerificationRecord
          failureKind: string
          repairRecommended: boolean
        }
      } {
    const { dir, workspaceSha256, result, integrityIssues, afterHead, afterChanges } = input
    const scenarios = result.scenarios.map((scenario) => ({
      scenario: scenario.scenario,
      status: scenario.status,
      evidence: scenario.evidence,
      commands: scenario.checks.map((check) => check.label),
    }))
    const blocking = [...result.failures, ...integrityIssues, ...input.controlIssues]
    const { verdict, classification } = this.legacyConclusion({
      result,
      blocking,
      integrityIssues,
      controlIssues: input.controlIssues,
    })
    const commands = input.checks.map((check) => ({
      label: check.label,
      argv: check.argv,
      category: check.category ?? 'acceptance',
      materialsSha256: check.materialsSha256,
      exitCode: check.exitCode,
      timedOut: check.timedOut,
      aborted: check.aborted,
      durationMs: check.durationMs,
      logPath: check.logPath,
      logSha256: check.logSha256,
    }))
    const kind = classification?.kind ?? 'undetermined'
    const failureGuidance = classification?.guidance ?? ''
    const repairRecommended = classification?.requiresCodeChange ?? false
    const canonical = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidate.candidateSha256,
      candidateVersion: input.candidate.candidateVersion,
      snapshotCommit: input.candidate.snapshotCommit,
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
      workspaceSha256,
      verificationMaterialsSha256: verificationMaterialsDigest(join(input.dir, 'workspace')),
      verificationPlan: input.verificationPlan,
      businessPoints: [
        ...new Set(input.verificationPlan.scenarios.flatMap((scenario) => scenario.pointIds ?? [])),
      ],
      acceptanceItems: [
        ...new Set(
          input.verificationPlan.scenarios.flatMap((scenario) => scenario.acceptanceIds ?? []),
        ),
      ],
      environment: result.environment,
      verdict,
      ...(classification
        ? {
            failureKind: classification.kind,
            failureReasons: classification.reasons,
            failureGuidance: classification.guidance,
          }
        : {}),
      summary: result.summary,
      findings: [],
      blocking,
      scenarios,
      commands,
      checksByCategory: Object.fromEntries(
        ['acceptance', 'regression', 'integration', 'artifact'].map((category) => [
          category,
          commands.filter((command) => command.category === category).length,
        ]),
      ),
      controls: input.controls,
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
      failureKind: classification?.kind ?? '',
      blocking,
      reportJson,
      reportPath: verificationPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: input.sessionId,
      verifiedAt: this.deps.now(),
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
    }
    this.deps.repo.recordVerification(verification)
    if (verdict === 'block') {
      if (repairRecommended) {
        this.deps.repo.recordFailureRound(input.reqId, {
          roundId: `verification-${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-a${input.attempt.number}`,
          stage: FAILURE_VERIFICATION,
          summary: `独立验证阻断（${kind}）：${blocking.join('；') || result.summary}`.slice(
            0,
            1000,
          ),
          occurredAt: this.deps.now(),
        })
      }
      return {
        ok: false,
        result: {
          state: 'block',
          detail: `独立验证阻断（${kind}）：${blocking.join('；') || result.summary}；${failureGuidance}；证据 ${verificationPath}`,
          blocking,
          verification,
          failureKind: kind,
          repairRecommended,
        },
      }
    }
    return { ok: true, verification, failureKind: '', repairRecommended: false }
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
        attempt: { number: number; id: string; previousAttemptId: string; dir: string }
      }
    | {
        ok: false
        result: { state: 'block'; detail: string; blocking: string[]; verification: null }
      } {
    const attempt = this.deps.repo.nextVerificationAttempt(
      input.reqId,
      input.plan.planVersion,
      input.candidate.candidateSha256,
    )
    const dir = verificationAttemptDir(this.deps.config, {
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      attemptNumber: attempt.attemptNumber,
    })
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
    return {
      ok: true,
      dir,
      workspace,
      workspaceSha256,
      workspaceHead,
      attempt: {
        number: attempt.attemptNumber,
        id: `verification-v${input.plan.planVersion}-${input.candidate.candidateSha256.slice(0, 12)}-a${attempt.attemptNumber}`,
        previousAttemptId: attempt.previousAttemptId,
        dir,
      },
    }
  }

  /** 合并工具告警与实际复核：提交变化、候选外的改动都算完整性问题。 */
  private candidateIntegrity(
    workspace: string,
    workspaceHead: string,
    recorded: VerificationCheckSnapshot,
  ): { issues: string[]; head: string; changes: string[] } {
    const head = requireGit(workspace, ['rev-parse', 'HEAD']).trim()
    const issues = [...recorded.integrityIssues]
    if (head !== workspaceHead) {
      const issue = '验证期间候选提交发生变化'
      if (!issues.includes(issue)) issues.push(issue)
    }
    const changes = workspaceChanges(workspace)
    const outside = changes.filter((path) => !path.startsWith(VERIFICATION_MATERIAL_DIR))
    if (outside.length > 0) {
      const issue = `验证命令修改了固定候选：${outside.join('、')}`
      if (!issues.includes(issue)) issues.push(issue)
    }
    return { issues, head, changes }
  }

  /** 方案命令必须真的执行过：只给结论不执行时先补一次明确重试，仍缺失再阻断。 */
  private async ensureCommandsExecuted(input: {
    reqId: string
    dir: string
    plan: VerificationPlan
    token: string
    session: VerificationSession
    signal?: AbortSignal
  }): Promise<{ ok: true } | { ok: false; detail: string }> {
    const planned = input.plan.scenarios.flatMap((scenario) => scenario.checks)
    const before = this.deps.checks.snapshot(input.reqId, input.token)
    const executed = new Set((before?.runs ?? []).map((item) => item.label))
    const missing = planned
      .filter((check) => !executed.has(check.label))
      .map((check) => check.label)
    if (missing.length === 0) return { ok: true }
    const started = Date.now()
    const retry = await input.session.send({
      prompt: [
        '你还没有用验证工具执行下列命令，因此不能给出结论：',
        ...missing.map((label) => `- ${label}`),
        '',
        '请逐条调用验证工具执行它们（不要新写命令、不要只描述结果），执行完再给出结论。',
      ].join('\n'),
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(input.dir, 'verification-execution-retry.jsonl'),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    this.deps.charge(input.reqId, started)
    if (retry.status !== 'completed') {
      return { ok: false, detail: `验证命令补充执行未完成：${retry.reason}` }
    }
    return { ok: true }
  }

  /** 命令未全部执行或被停止：不能进入业务判定，也不构成候选缺陷。 */
  private preJudgeBlock(
    snapshot: VerificationCheckSnapshot,
    plan: VerificationPlan,
  ): { state: 'block'; detail: string; blocking: string[] } | null {
    const byLabel = new Map(snapshot.runs.map((run) => [run.label, run]))
    const missing = plan.scenarios
      .flatMap((scenario) => scenario.checks)
      .filter((check) => !byLabel.has(check.label))
      .map((check) => check.label)
    if (missing.length > 0) {
      const detail = `验证 Agent 没有通过工具执行方案中的命令：${missing.join('、')}`
      return { state: 'block', detail, blocking: [detail] }
    }
    if (snapshot.runs.some((run) => run.aborted)) {
      return {
        state: 'block',
        detail: '独立验证命令被停止；验证工作区可丢弃，可重新验证',
        blocking: ['独立验证命令被停止'],
      }
    }
    return null
  }

  /** 读取并执行验证会话写下的敏感性对照；材料畸形时 fail-closed。 */
  private async runSensitivityControls(input: {
    reqId: string
    workspace: string
    token: string
    plan: VerificationPlan
    caller: { sessionId: string; attemptId: string }
  }): Promise<
    | { ok: true; outcome: Awaited<ReturnType<VerificationCheckRegistry['executeControls']>> }
    | { ok: false; detail: string }
  > {
    const controlsPath = join(input.workspace, CONTROLS_FILE)
    let controls: ReturnType<typeof parseVerificationControls> = []
    try {
      controls = existsSync(controlsPath)
        ? parseVerificationControls(readFileSync(controlsPath, 'utf8'))
        : []
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
    const outcome = await this.deps.checks.executeControls(input.reqId, input.token, {
      commands: input.plan.scenarios.flatMap((scenario) => scenario.checks),
      controls,
      caller: input.caller,
    })
    return { ok: true, outcome }
  }

  // eslint-disable-next-line complexity, max-statements
  async verifyCandidate(input: LegacyVerifyInput): Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord | null
    failureKind?: string
    repairRecommended?: boolean
  }> {
    const prepared = this.prepareLegacyVerificationWorkspace(input)
    if (!prepared.ok) return prepared.result
    const { dir, workspace, workspaceSha256, workspaceHead, attempt } = prepared
    const verificationSession = input.verification
    writeFileSync(
      join(dir, 'verification-plan.json'),
      `${JSON.stringify(verificationSession.plan, null, 2)}\n`,
      'utf8',
    )
    const handle = this.deps.checks.activate({
      reqId: input.reqId,
      candidateSha256: input.candidate.candidateSha256,
      workspace,
      dir,
      head: workspaceHead,
      plan: verificationSession.plan,
      signal: input.signal,
      timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
      sessionId: verificationSession.sessionId,
      attemptId: attempt.id,
    })
    let snapshot: VerificationCheckSnapshot | null = null
    let controlOutcome: Awaited<ReturnType<VerificationCheckRegistry['executeControls']>> = null
    const executionStarted = Date.now()
    try {
      const run = await verificationSession.session.send({
        prompt: verificationExecutionPrompt({
          reqId: input.reqId,
          candidateSha256: input.candidate.candidateSha256,
          plan: verificationSession.plan,
          sessionId: verificationSession.sessionId,
          attemptId: attempt.id,
        }),
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(dir, 'verification-execution.jsonl'),
        signal: input.signal,
      })
      if (run.status !== 'completed') {
        const detail = `验证执行未取得结论：${run.reason}`
        return this.recordBlockedAttempt({
          reqId: input.reqId,
          plan: input.plan,
          candidate: input.candidate,
          workspaceSha256,
          dir,
          attempt,
          sessionId: verificationSession.sessionId,
          detail,
          blocking: [detail],
          failureKind: 'test_error',
          runs: this.deps.checks.snapshot(input.reqId, handle.token)?.runs ?? [],
        })
      }
      const executedRetry = await this.ensureCommandsExecuted({
        reqId: input.reqId,
        dir,
        plan: verificationSession.plan,
        token: handle.token,
        session: verificationSession.session,
        signal: input.signal,
      })
      if (!executedRetry.ok) {
        return this.recordBlockedAttempt({
          reqId: input.reqId,
          plan: input.plan,
          candidate: input.candidate,
          workspaceSha256,
          dir,
          attempt,
          sessionId: verificationSession.sessionId,
          detail: executedRetry.detail,
          blocking: [executedRetry.detail],
          failureKind: 'test_error',
          runs: this.deps.checks.snapshot(input.reqId, handle.token)?.runs ?? [],
        })
      }
      const controlsResult = await this.runSensitivityControls({
        reqId: input.reqId,
        workspace,
        token: handle.token,
        plan: verificationSession.plan,
        caller: { sessionId: verificationSession.sessionId, attemptId: attempt.id },
      })
      if (!controlsResult.ok) {
        const detail = `验证敏感性对照材料畸形：${controlsResult.detail}`
        return this.recordBlockedAttempt({
          reqId: input.reqId,
          plan: input.plan,
          candidate: input.candidate,
          workspaceSha256,
          dir,
          attempt,
          sessionId: verificationSession.sessionId,
          detail,
          blocking: [detail],
          failureKind: 'test_error',
          runs: this.deps.checks.snapshot(input.reqId, handle.token)?.runs ?? [],
        })
      }
      controlOutcome = controlsResult.outcome
    } finally {
      this.deps.charge(input.reqId, executionStarted)
      snapshot = this.deps.checks.snapshot(input.reqId, handle.token)
      handle.release()
    }
    if (!snapshot) {
      const detail = '验证执行上下文在结论前丢失；无法核对命令结果'
      return this.recordBlockedAttempt({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        workspaceSha256,
        dir,
        attempt,
        sessionId: verificationSession.sessionId,
        detail,
        blocking: [detail],
        failureKind: 'undetermined',
        runs: [],
      })
    }
    if (!controlOutcome) {
      const detail = '验证敏感性对照上下文在结论前丢失；无法核对用例有效性'
      return this.recordBlockedAttempt({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        workspaceSha256,
        dir,
        attempt,
        sessionId: verificationSession.sessionId,
        detail,
        blocking: [detail],
        failureKind: 'undetermined',
        runs: snapshot.runs,
      })
    }
    const recorded = snapshot
    const preJudge = this.preJudgeBlock(recorded, verificationSession.plan)
    if (preJudge) {
      return this.recordBlockedAttempt({
        reqId: input.reqId,
        plan: input.plan,
        candidate: input.candidate,
        workspaceSha256,
        dir,
        attempt,
        sessionId: verificationSession.sessionId,
        detail: preJudge.detail,
        blocking: preJudge.blocking,
        failureKind: 'test_error',
        runs: recorded.runs,
      })
    }
    const integrity = this.candidateIntegrity(workspace, workspaceHead, recorded)
    const result = judgeVerificationResult({
      plan: verificationSession.plan,
      artifact: {
        requirementVersion: input.plan.requirementVersion,
        candidateSha256: input.candidate.candidateSha256,
        workspace,
      },
      checks: recorded.runs,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        startedAt: recorded.startedAt,
      },
      finishedAt: this.deps.now(),
    })
    // 验证会话可通过对照工具写补丁；没有覆盖关键必过场景时按证据不足阻断。
    const controlCoverageIssues = validateControlCoverage({
      requiredScenarios: verificationSession.plan.scenarios
        .filter((scenario) => scenario.required)
        .map((scenario) => scenario.scenario),
      reportScenarios: result.scenarios.map((scenario) => ({
        scenario: scenario.scenario,
        status: scenario.status,
        commands: scenario.checks.map((check) => check.label),
      })),
      controls: controlOutcome.results,
    })
    const recordedVerification = this.recordAgentVerification({
      reqId: input.reqId,
      plan: input.plan,
      candidate: input.candidate,
      dir,
      workspaceSha256,
      verificationPlan: verificationSession.plan,
      result,
      checks: recorded.runs,
      integrityIssues: integrity.issues,
      afterHead: integrity.head,
      afterChanges: integrity.changes,
      sessionId: verificationSession.sessionId,
      controls: controlOutcome.results,
      controlIssues: [...controlCoverageIssues, ...controlOutcome.issues],
      attempt,
    })
    if (!recordedVerification.ok) return recordedVerification.result
    const verification = recordedVerification.verification

    // 业务验收复用同一个验证会话；模型看到的证据只来自工具真实执行的输出。
    const business = await this.runLegacyBusinessReview({
      reqId: input.reqId,
      requirement: input.requirement,
      analysis: input.analysis,
      plan: input.plan,
      verificationPlan: verificationSession.plan,
      candidate: input.candidate,
      session: verificationSession.session,
      dir,
      signal: input.signal,
      runs: recorded.runs,
      verification,
      attemptId: attempt.id,
    })
    if (!business.ok) return business.result
    const { review, businessRun, issues } = business
    return this.recordLegacyBusinessReview({
      reqId: input.reqId,
      plan: input.plan,
      candidate: input.candidate,
      verification,
      review,
      businessRun,
      issues,
      runs: recorded.runs,
    })
  }
}
