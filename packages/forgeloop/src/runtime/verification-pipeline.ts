import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { verificationAttemptDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { planLimitSeconds } from '../domain/task-plan.js'
import type { PlanReview, VerificationReport } from '../domain/verification.js'
import { validateScenarioEvidence, validateVerificationCoverage } from '../domain/verification.js'
import { validateControlCoverage } from '../domain/verification-controls.js'
import { classifyVerificationFailure } from '../domain/verification-failure.js'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../domain/business-review.js'
import { verificationBlocking } from './service-helpers.js'
import { blockingOf, reviewFacts, runStatusLabel } from './review-facts.js'
import { EXECUTING } from '../domain/status.js'
import { AGENT_VERIFY } from '../domain/agents.js'
import { headCommit, prepareSnapshotWorkspace, requireGit, runCommand } from './workspace.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { FAILURE_BUSINESS_REVIEW, FAILURE_VERIFICATION } from '../domain/counting.js'
import { workLimitSeconds } from '../domain/budget.js'
import { ExecutionBudget } from '../domain/limits.js'
import type { Repository, VerificationRecord } from '../records/repository.js'
import type { AgentRunner } from './agent-runner.js'
import type { runFormalTest } from './formal-test.js'
import { businessReviewPrompt, verificationPrompt } from './prompts.js'
import {
  VERIFICATION_MATERIAL_DIR,
  verificationMaterials,
  workspaceChanges,
} from './service-helpers.js'
import { parseVerificationMaterials } from './verification-materials.js'
import {
  executeVerificationControls,
  type ControlExecutionResult,
} from './verification-controls.js'
import { runVerificationCommands, type VerificationCommandRun } from './execution-commands.js'
import { VERIFICATION_MATERIAL_TOOL } from './verification-checks.js'
import { verificationIntegrity, verificationVerdict } from './verification-outcome.js'
import type { LegacyVerificationSession, LegacyVerifyInput } from './legacy-verification.js'
import type { CandidateFile } from './integration.js'
import type { OperationResult } from './operation-result.js'

export interface VerificationPipelineDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  charge: (reqId: string, started: number) => void
  runner: { run: AgentRunner['run'] }
  formalTest: typeof runFormalTest
  ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  candidateIdentity: (plan: TaskPlan, artifacts: ReturnType<Repository['taskArtifacts']>) => string
  requireAuthorizedPlan: (
    reqId: string,
  ) => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  applyDiffFile: (
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ) => Promise<{ ok: boolean; detail: string }>
  reopenDeliveredTasks: (input: {
    reqId: string
    plan: TaskPlan
    identity: string
    reason: string
  }) => Array<{ taskId: string; attempt: number; archivedPath: string }>
  verificationBaseline: (analysis: RequirementAnalysis) => PlanReview
  remainingFailureRounds: (reqId: string) => number
  openBlackBoxSession: (input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    signal: AbortSignal
  }) => Promise<
    | { ok: true; value: LegacyVerificationSession }
    | { ok: false; result: { state: 'block'; detail: string; blocking: string[] } }
  >
  verifyCandidateBlackBox: (input: LegacyVerifyInput) => Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    repairRecommended?: boolean
  }>
}

export class VerificationPipeline {
  static readonly MAX_SAME_CANDIDATE_ATTEMPTS = 5

  constructor(private readonly deps: VerificationPipelineDeps) {}

  private attemptOf(
    reqId: string,
    plan: TaskPlan,
    candidateSha256: string,
  ): { number: number; previousAttemptId: string; dir: string } {
    const next = this.deps.repo.nextVerificationAttempt(reqId, plan.planVersion, candidateSha256)
    return {
      number: next.attemptNumber,
      previousAttemptId: next.previousAttemptId,
      dir: verificationAttemptDir(this.deps.config, {
        reqId,
        planVersion: plan.planVersion,
        candidateSha256,
        attemptNumber: next.attemptNumber,
      }),
    }
  }

  private recordPreflightBlock(input: {
    reqId: string
    plan: TaskPlan
    candidateSha256: string
    baselineSha256: string
    blocking: readonly string[]
    attempt: { number: number; previousAttemptId: string; dir: string }
  }): string {
    const dir = input.attempt.dir
    mkdirSync(dir, { recursive: true })
    const classification = classifyVerificationFailure({
      blocking: input.blocking,
      commandRuns: [],
      materialIssues: input.blocking,
    })
    const report = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidateSha256,
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
      workspaceSha256: '',
      verificationBaselineSha256: input.baselineSha256,
      verdict: 'block',
      failureKind: classification.kind,
      summary: '候选无法在当前基线组装，未执行测试命令',
      findings: [],
      blocking: [...classification.reasons],
      scenarios: [],
      commands: [],
      controls: [],
      candidateIntegrity: null,
      materials: [],
      sessionId: '',
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.deps.repo.recordVerification({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256: '',
      verdict: 'block',
      failureKind: classification.kind,
      blocking: classification.reasons,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: '',
      verifiedAt: this.deps.now(),
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
    })
    this.deps.repo.recordFailureRound(input.reqId, {
      roundId: `verification-${input.plan.planVersion}-${input.candidateSha256.slice(0, 12)}-a${input.attempt.number}-preflight`,
      stage: FAILURE_VERIFICATION,
      summary: `独立测试无法组装候选：${classification.reasons.join('；')}`.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    this.deps.repo.setStatus(
      input.reqId,
      'blocked',
      `独立测试无法组装候选（候选 ${input.candidateSha256.slice(0, 16)}…，尝试 ${input.attempt.number}）：${classification.reasons.join('；')}`,
    )
    return reportPath
  }

  private existingVerificationOutcome(
    reqId: string,
    plan: TaskPlan,
    candidateSha256: string,
  ): { state: 'done' | 'failed'; detail: string } | null {
    const attempts = this.deps.repo.verificationAttemptsForCandidate(
      reqId,
      plan.planVersion,
      candidateSha256,
    )
    const latest = attempts[attempts.length - 1]
    if (!latest) return null
    if (latest.verdict === 'pass') {
      if (!this.verificationMaterialValid(latest)) {
        return { state: 'failed', detail: '独立测试报告文件缺失或摘要不一致；需重新验证' }
      }
      return {
        state: 'done',
        detail: `候选 ${candidateSha256.slice(0, 16)}… 已通过独立测试；等待验收`,
      }
    }
    const retryableKinds = ['environment_error', 'test_error', 'insufficient_evidence']
    const retryable =
      retryableKinds.includes(latest.failureKind) &&
      attempts.length < VerificationPipeline.MAX_SAME_CANDIDATE_ATTEMPTS
    if (retryable) return null
    return {
      state: 'failed',
      detail: `候选 ${candidateSha256.slice(0, 16)}… 的独立测试已阻断（尝试 ${latest.attemptNumber}，${latest.failureKind || '未分类'}）：${verificationBlocking(latest.reportJson)}；需修复后产生新候选再验证`,
    }
  }

  private skipVerificationOutcome(
    reqId: string,
    plan: TaskPlan,
    candidateSha256: string,
  ): { state: 'done' | 'failed'; detail: string } | null {
    return (
      this.existingVerificationOutcome(reqId, plan, candidateSha256) ??
      this.verificationBudgetGuard(reqId, plan)
    )
  }

  private verificationBudgetGuard(
    reqId: string,
    plan: TaskPlan,
  ): { state: 'failed'; detail: string } | null {
    this.deps.repo.ensureBudget(reqId, planLimitSeconds(plan.tasks))
    const budget = new ExecutionBudget(
      workLimitSeconds(this.deps.repo.budget(reqId).limit),
      this.deps.repo.budget(reqId).consumedSeconds,
    )
    if (budget.canStartAction()) return null
    this.deps.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需显式延长或拆分任务')
    return { state: 'failed', detail: '执行工时已用尽；需显式延长或拆分任务' }
  }

  private async prepareVerificationWorkspace(input: {
    reqId: string
    plan: TaskPlan
    candidateSha256: string
    baselineSha256: string
    attempt: { number: number; previousAttemptId: string; dir: string }
  }): Promise<
    | {
        ok: true
        dir: string
        workspace: string
        diffs: string[]
        baseline: string
        snapshot: Awaited<ReturnType<typeof prepareSnapshotWorkspace>>
      }
    | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, plan, candidateSha256, baselineSha256, attempt } = input
    const dir = attempt.dir
    const workspace = join(dir, 'workspace')
    mkdirSync(dir, { recursive: true })
    const baseline = await headCommit(this.deps.config.projectPath)
    const snapshot = await prepareSnapshotWorkspace({
      projectPath: this.deps.config.projectPath,
      workspacePath: workspace,
      baselineCommit: baseline,
    })
    const diffs: string[] = []
    for (const task of plan.tasks) {
      const evidence = this.deps.repo.evidence(reqId, plan.planVersion, task.taskId)
      if (!evidence) {
        return {
          ok: false,
          outcome: { state: 'failed', detail: `任务 ${task.taskId} 缺少交付证据；不能验证` },
        }
      }
      const applied = await this.deps.applyDiffFile(
        workspace,
        evidence.candidatePath,
        task.taskId,
        task.taskId,
      )
      if (!applied.ok) {
        const blocking = [`任务 ${task.taskId} 的候选 diff 无法应用到验证副本：${applied.detail}`]
        const reportPath = this.recordPreflightBlock({
          reqId,
          plan,
          candidateSha256,
          baselineSha256,
          blocking,
          attempt,
        })
        return {
          ok: false,
          outcome: {
            state: 'failed',
            detail: `任务 ${task.taskId} 的候选 diff 无法应用到验证副本：${applied.detail}；证据 ${reportPath}；需修复后产生新候选再验证`,
          },
        }
      }
      const diff = readFileSync(evidence.candidatePath, 'utf8')
      if (diff.trim()) diffs.push(diff)
    }
    return { ok: true, dir, workspace, diffs, baseline, snapshot }
  }

  private async finalizeVerificationWorkspace(input: {
    reqId: string
    plan: TaskPlan
    dir: string
    workspace: string
    diffs: readonly string[]
    candidateSha256: string
    baseline: string
    snapshot: Awaited<ReturnType<typeof prepareSnapshotWorkspace>>
    artifacts: ReturnType<Repository['taskArtifacts']>
  }): Promise<
    | { ok: true; workspaceSha256: string; workspaceHead: string; candidateDiff: string }
    | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, plan, dir, workspace, diffs, candidateSha256, baseline, snapshot, artifacts } =
      input
    await runCommand('git', ['add', '-A'], workspace)
    await runCommand('git', ['commit', '-qm', 'forgeloop: verification candidate'], workspace)
    if (this.deps.config.worktreePrepareCommand.length > 0) {
      const prepare = await runCommand(
        this.deps.config.worktreePrepareCommand[0] ?? '',
        this.deps.config.worktreePrepareCommand.slice(1),
        workspace,
        this.deps.config.formalTestTimeoutSeconds * 1000,
      )
      writeFileSync(
        join(dir, 'workspace-prepare.log'),
        `${JSON.stringify(this.deps.config.worktreePrepareCommand)}\nexit_code: ${prepare.code}\n${prepare.stdout}\n${prepare.stderr}\n`,
        'utf8',
      )
      if (prepare.code !== 0) {
        this.deps.repo.setStatus(
          reqId,
          'blocked',
          `验证工作副本准备命令失败（退出码 ${prepare.code}）；这是环境问题，候选未被判定失败`,
        )
        return {
          ok: false,
          outcome: {
            state: 'failed',
            detail: `验证工作副本准备命令失败（退出码 ${prepare.code}）；需修复依赖或环境后重新验证`,
          },
        }
      }
      await runCommand('git', ['reset', '--hard', 'HEAD'], workspace)
      await runCommand('git', ['clean', '-fd'], workspace)
    }
    const workspaceSha256 = await requireGit(workspace, ['rev-parse', 'HEAD^{tree}'])
    const workspaceHead = await requireGit(workspace, ['rev-parse', 'HEAD'])
    const candidateDiff = diffs.join('\n')
    writeFileSync(join(dir, 'candidate.diff'), candidateDiff, 'utf8')
    writeFileSync(
      join(dir, 'candidate.json'),
      `${JSON.stringify(
        {
          reqId,
          planVersion: plan.planVersion,
          requirementVersion: plan.requirementVersion,
          candidateSha256,
          workspaceSha256,
          baselineCommit: baseline,
          snapshot,
          tasks: plan.tasks.map((task) => ({
            taskId: task.taskId,
            candidateSha256:
              artifacts.find((artifact) => artifact.taskId === task.taskId)?.candidateSha256 ?? '',
          })),
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return { ok: true, workspaceSha256, workspaceHead, candidateDiff }
  }

  private verificationInputs(reqId: string):
    | {
        ok: true
        requirement: Requirement
        analysis: RequirementAnalysis
        plan: TaskPlan
        artifacts: ReturnType<Repository['taskArtifacts']>
        candidateSha256: string
      }
    | { ok: false; outcome: { state: 'failed'; detail: string } } {
    const authorized = this.deps.requireAuthorizedPlan(reqId)
    if (!authorized.ok) {
      return { ok: false, outcome: { state: 'failed', detail: authorized.result.message } }
    }
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) {
      return { ok: false, outcome: { state: 'failed', detail: `未找到需求 ${reqId}` } }
    }
    const analysis = this.deps.repo.latestAnalysis(reqId)
    if (!analysis) {
      return {
        ok: false,
        outcome: { state: 'failed', detail: `需求 ${reqId} 尚无分析结论；不能验证` },
      }
    }
    const plan = authorized.value.plan
    if (analysis.requirementVersion !== plan.requirementVersion) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `最新分析依据需求 v${analysis.requirementVersion}，任务包依据 v${plan.requirementVersion}；版本不一致，不能开始独立测试`,
        },
      }
    }
    if (analysis.clarifications.length > 0) {
      return {
        ok: false,
        outcome: { state: 'failed', detail: '需求仍有待澄清项；不能开始独立测试' },
      }
    }
    const artifacts = this.deps.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `仍有任务未交付，不能开始独立测试：${missing.map((task) => task.taskId).join('、')}`,
        },
      }
    }
    return {
      ok: true,
      requirement,
      analysis,
      plan,
      artifacts,
      candidateSha256: this.deps.candidateIdentity(plan, artifacts),
    }
  }

  private async completeVerification(input: {
    reqId: string
    signal: AbortSignal
    plan: TaskPlan
    planReview: PlanReview
    baselineSha256: string
    candidateSha256: string
    workspaceSha256: string
    run: Awaited<ReturnType<AgentRunner['run']>>
    report: VerificationReport
    commandRuns: VerificationCommandRun[]
    failedCommands: readonly string[]
    integrityIssues: readonly string[]
    dir: string
    afterHead: string
    afterChanges: readonly string[]
    candidateContentSha256: string
    materials: ReturnType<typeof verificationMaterials>
    attempt: { number: number; previousAttemptId: string; dir: string }
    controls: readonly { label: string; patch: string; expectedFailureOutput: string }[]
    controlRuns: readonly ControlExecutionResult[]
    controlIssues: readonly string[]
  }): Promise<{ state: 'done' | 'failed' | 'repair'; detail: string }> {
    const { verdict, blocking, classification } = this.verificationConclusion(input)
    const canonical = this.verificationCanonical(input, { verdict, blocking, classification })
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const reportPath = join(input.dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.deps.repo.recordVerification({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidateSha256,
      requirementVersion: input.plan.requirementVersion,
      workspaceSha256: input.workspaceSha256,
      verdict,
      failureKind: classification?.kind ?? '',
      blocking,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: input.dir,
      sessionId: input.run.sessionId,
      verifiedAt: this.deps.now(),
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
    })

    if (verdict === 'block') {
      return this.blockedVerificationOutcome({ ...input, blocking, classification, reportPath })
    }

    const businessReview = await this.executeBusinessReview(input.reqId, input.signal)
    if (businessReview.state !== 'done') return businessReview
    this.deps.repo.setStatus(input.reqId, EXECUTING)
    return {
      state: 'done',
      detail: `候选 ${input.candidateSha256.slice(0, 16)}… 已通过独立测试（${input.report.scenarios.length} 个场景，${input.commandRuns.length} 条命令）；${businessReview.detail}`,
    }
  }

  private verificationConclusion(input: {
    planReview: PlanReview
    report: VerificationReport
    commandRuns: VerificationCommandRun[]
    failedCommands: readonly string[]
    integrityIssues: readonly string[]
    controls: readonly { label: string }[]
    controlIssues: readonly string[]
  }): {
    verdict: 'pass' | 'block'
    blocking: string[]
    classification: ReturnType<typeof classifyVerificationFailure> | null
  } {
    const coverageIssues = validateVerificationCoverage(
      input.planReview.verificationPlan,
      input.report,
    )
    const evidenceIssues = validateScenarioEvidence(
      input.planReview.verificationPlan,
      input.report,
      input.commandRuns,
    )
    const controlCoverageIssues = validateControlCoverage({
      requiredScenarios: input.planReview.verificationPlan
        .filter((scenario) => scenario.required)
        .map((scenario) => scenario.scenario),
      reportScenarios: input.report.scenarios,
      controls: input.controls,
    })
    const controlIssues = [...controlCoverageIssues, ...input.controlIssues]
    const { verdict, blocking } = verificationVerdict({
      report: input.report,
      failedCommands: input.failedCommands,
      coverageIssues,
      evidenceIssues,
      integrityIssues: input.integrityIssues,
      controlIssues,
    })
    const classification =
      verdict === 'block'
        ? classifyVerificationFailure({
            blocking,
            commandRuns: input.commandRuns,
            failedScenarios: input.report.scenarios
              .filter((scenario) => scenario.status === 'fail')
              .map((scenario) => scenario.scenario),
            coverageIssues,
            evidenceIssues,
            integrityIssues: input.integrityIssues,
            controlIssues,
          })
        : null
    return { verdict, blocking, classification }
  }

  private verificationCanonical(
    input: {
      reqId: string
      plan: TaskPlan
      candidateSha256: string
      baselineSha256: string
      workspaceSha256: string
      run: Awaited<ReturnType<AgentRunner['run']>>
      report: VerificationReport
      commandRuns: VerificationCommandRun[]
      afterHead: string
      afterChanges: readonly string[]
      candidateContentSha256: string
      materials: ReturnType<typeof verificationMaterials>
      attempt: { number: number; previousAttemptId: string }
      controlRuns: readonly ControlExecutionResult[]
    },
    conclusion: {
      verdict: 'pass' | 'block'
      blocking: readonly string[]
      classification: ReturnType<typeof classifyVerificationFailure> | null
    },
  ): Record<string, unknown> {
    const { classification } = conclusion
    return {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidateSha256,
      attemptNumber: input.attempt.number,
      previousAttemptId: input.attempt.previousAttemptId,
      workspaceSha256: input.workspaceSha256,
      verificationBaselineSha256: input.baselineSha256,
      verdict: conclusion.verdict,
      ...(classification
        ? {
            failureKind: classification.kind,
            failureReasons: classification.reasons,
            failureGuidance: classification.guidance,
          }
        : {}),
      summary: input.report.summary,
      findings: input.report.findings,
      blocking: conclusion.blocking,
      scenarios: input.report.scenarios,
      commands: input.commandRuns.map(({ output: _output, ...rest }) => rest),
      controls: input.controlRuns,
      candidateIntegrity: {
        head: input.afterHead,
        candidateContentSha256: input.candidateContentSha256,
        changes: input.afterChanges,
        allowedPaths: [VERIFICATION_MATERIAL_DIR],
        ignoredBuildOutputsExcluded: true,
      },
      materials: input.materials,
      sessionId: input.run.sessionId,
      at: this.deps.now(),
    }
  }

  private blockedVerificationOutcome(input: {
    reqId: string
    plan: TaskPlan
    planReview: PlanReview
    candidateSha256: string
    commandRuns: VerificationCommandRun[]
    report: VerificationReport
    attempt: { number: number; previousAttemptId: string }
    blocking: readonly string[]
    classification: ReturnType<typeof classifyVerificationFailure> | null
    reportPath: string
  }): { state: 'failed' | 'repair'; detail: string } {
    const { reqId, plan, candidateSha256, attempt, classification } = input
    const blockingText = input.blocking.join('；') || input.report.summary
    const kind = classification?.kind ?? 'undetermined'
    this.deps.repo.recordFailureRound(reqId, {
      roundId: `verification-${plan.planVersion}-${candidateSha256.slice(0, 12)}-a${attempt.number}`,
      stage: FAILURE_VERIFICATION,
      summary: `独立测试阻断（${kind}）：${blockingText}`.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    const budgetLeft = this.deps.remainingFailureRounds(reqId)
    const rounds = this.deps.repo.failureRounds(reqId).length
    if (classification?.requiresCodeChange === true && budgetLeft > 0) {
      const logs = input.commandRuns
        .filter((command) => command.exitCode !== 0 || command.timedOut)
        .map((command) => `${command.label}:${command.logPath}`)
        .join('、')
      const repairReason = [
        `候选 ${candidateSha256.slice(0, 16)}…（尝试 ${attempt.number}）实现缺陷`,
        `失败场景：${classification.reasons.join('；')}`,
        `预期与用例：${input.planReview.verificationPlan
          .filter((scenario) => scenario.required)
          .map((scenario) => `${scenario.scenario}（${scenario.method}）`)
          .join('；')}`,
        `实际与证据：${blockingText}`,
        logs ? `日志：${logs}` : '',
      ]
        .filter(Boolean)
        .join('；')
        .slice(0, 900)
      const reopened = this.deps.reopenDeliveredTasks({
        reqId,
        plan,
        identity: candidateSha256,
        reason: repairReason,
      })
      if (reopened.length > 0) {
        this.deps.repo.setStatus(
          reqId,
          'blocked',
          `独立测试阻断（实现缺陷，候选 ${candidateSha256.slice(0, 16)}…，尝试 ${attempt.number}）：${blockingText}；已返回研发修复（失败轮次 ${rounds}，剩余 ${budgetLeft}）`,
        )
        return {
          state: 'repair',
          detail: `独立测试阻断（实现缺陷）：${blockingText}；已返回研发修复，任务包 v${plan.planVersion} 不变；证据 ${input.reportPath}`,
        }
      }
    }
    this.deps.repo.setStatus(
      reqId,
      'blocked',
      `独立测试阻断（${kind}，候选 ${candidateSha256.slice(0, 16)}…，尝试 ${attempt.number}）：${blockingText}；失败轮次 ${rounds}${budgetLeft === 0 ? '；失败轮次额度已用尽' : ''}；${classification?.guidance ?? ''}`,
    )
    return {
      state: 'failed',
      detail: `独立测试阻断（${kind}）：${blockingText}；${classification?.guidance ?? ''}；证据 ${input.reportPath}`,
    }
  }

  private async runVerificationAgent(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    planReview: PlanReview
    candidateSha256: string
    workspaceSha256: string
    workspace: string
    dir: string
    signal: AbortSignal
  }): Promise<
    | { ok: true; run: Awaited<ReturnType<AgentRunner['run']>> }
    | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, requirement, analysis, plan, planReview, candidateSha256 } = input
    const { workspaceSha256, workspace, dir, signal } = input
    const started = Date.now()
    const run = await this.deps.runner.run({
      role: AGENT_VERIFY,
      cwd: workspace,
      prompt: verificationPrompt({
        requirement,
        analysis,
        plan,
        planReview,
        candidateSha256,
        workspaceSha256,
        workspacePath: workspace,
      }),
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'verify.jsonl'),
      signal,
      allowTools: [VERIFICATION_MATERIAL_TOOL],
    })
    this.deps.charge(reqId, started)
    if (run.status !== 'completed') {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `独立测试 Agent ${run.status === 'aborted' ? '被停止' : run.status === 'timeout' ? '超时' : '未完成'}：${run.reason}`,
      )
      return {
        ok: false,
        outcome: { state: 'failed', detail: `独立测试未取得可用结论：${run.reason}` },
      }
    }
    return { ok: true, run }
  }

  async executeVerification(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'repair'; detail: string }> {
    const inputs = this.verificationInputs(reqId)
    if (!inputs.ok) return inputs.outcome
    const { requirement, analysis, plan, artifacts, candidateSha256 } = inputs
    const skip = this.skipVerificationOutcome(reqId, plan, candidateSha256)
    if (skip) return skip
    const planReview = this.deps.verificationBaseline(analysis)
    const baselineSha256 = sha256OfText(JSON.stringify(planReview))
    const attempt = this.attemptOf(reqId, plan, candidateSha256)
    const prepared = await this.prepareVerificationWorkspace({
      reqId,
      plan,
      candidateSha256,
      baselineSha256,
      attempt,
    })
    if (!prepared.ok) return prepared.outcome
    const { dir, workspace, diffs, baseline, snapshot } = prepared
    const finalized = await this.finalizeVerificationWorkspace({
      reqId,
      plan,
      dir,
      workspace,
      diffs,
      candidateSha256,
      baseline,
      snapshot,
      artifacts,
    })
    if (!finalized.ok) return finalized.outcome
    const { workspaceSha256, workspaceHead } = finalized
    const agent = await this.runVerificationAgent({
      reqId,
      requirement,
      analysis,
      plan,
      planReview,
      candidateSha256,
      workspaceSha256,
      workspace,
      dir,
      signal,
    })
    if (!agent.ok) return agent.outcome
    const run = agent.run
    const parsed = parseVerificationMaterials(workspace)
    if (!parsed.ok) {
      this.deps.repo.setStatus(reqId, 'blocked', parsed.detail)
      return { state: 'failed', detail: parsed.detail }
    }
    const { commands, report, controls } = parsed
    const changed = await workspaceChanges(workspace)
    const currentHead = await requireGit(workspace, ['rev-parse', 'HEAD'])
    if (currentHead !== workspaceHead) {
      this.deps.repo.setStatus(reqId, 'blocked', '独立测试期间候选提交发生变化；需重新验证')
      return { state: 'failed', detail: '独立测试期间候选提交发生变化（fail-closed）；需重新验证' }
    }
    const outsideVerification = changed.filter(
      (path) => !path.startsWith(VERIFICATION_MATERIAL_DIR),
    )
    if (outsideVerification.length > 0) {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `独立测试修改了 verification/ 之外的文件：${outsideVerification.join('、')}`,
      )
      return {
        state: 'failed',
        detail: `独立测试越出独立测试目录（fail-closed）：${outsideVerification.join('、')}`,
      }
    }

    const ran = await runVerificationCommands({
      reqId,
      dir,
      commands,
      run: async (argv, logPath) =>
        this.deps.formalTest({
          ctx: this.deps.ctx,
          config: this.deps.config,
          cwd: workspace,
          argv,
          timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
          logPath,
          signal,
        }),
      setBlocked: (message) => {
        this.deps.repo.setStatus(reqId, 'blocked', message)
      },
    })
    if (!ran.ok) return { state: 'failed', detail: ran.detail }
    const { commandRuns, failedCommands } = ran
    const controlOutcome = await executeVerificationControls({
      workspace,
      dir,
      commands,
      controls,
      dependencyRoot: this.deps.config.projectPath,
      run: async ({ argv, cwd, logPath }) => {
        const test = await this.deps.formalTest({
          ctx: this.deps.ctx,
          config: this.deps.config,
          cwd,
          argv,
          timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
          logPath,
          signal,
        })
        return {
          exitCode: test.exitCode,
          timedOut: test.timedOut,
          aborted: test.aborted,
          durationMs: test.durationMs,
          output: test.output,
          logPath: test.logPath,
          logSha256: test.logSha256,
        }
      },
    })
    const integrity = await verificationIntegrity(workspace, workspaceHead)
    if (!integrity.ok) return { state: 'failed', detail: integrity.detail }
    const { integrityIssues, afterHead, afterChanges, candidateContentSha256 } = integrity
    const materials = verificationMaterials(dir)

    return await this.completeVerification({
      reqId,
      signal,
      plan,
      planReview,
      baselineSha256,
      candidateSha256,
      workspaceSha256,
      run,
      report,
      commandRuns,
      failedCommands,
      integrityIssues,
      dir,
      afterHead,
      afterChanges,
      candidateContentSha256,
      materials,
      attempt,
      controls,
      controlRuns: controlOutcome.results,
      controlIssues: controlOutcome.issues,
    })
  }

  async executeVerificationBlackBox(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed' | 'repair'; detail: string }> {
    const inputs = this.verificationInputs(reqId)
    if (!inputs.ok) return inputs.outcome
    const { requirement, analysis, plan, artifacts, candidateSha256 } = inputs
    const skip = this.skipVerificationOutcome(reqId, plan, candidateSha256)
    if (skip) return skip
    const attempt = this.attemptOf(reqId, plan, candidateSha256)
    const prepared = await this.prepareVerificationWorkspace({
      reqId,
      plan,
      candidateSha256,
      baselineSha256: '',
      attempt,
    })
    if (!prepared.ok) return prepared.outcome
    const { dir, workspace, diffs, baseline, snapshot } = prepared
    const finalized = await this.finalizeVerificationWorkspace({
      reqId,
      plan,
      dir,
      workspace,
      diffs,
      candidateSha256,
      baseline,
      snapshot,
      artifacts,
    })
    if (!finalized.ok) return finalized.outcome
    const diffPath = join(dir, 'candidate-in-snapshot.diff')
    writeFileSync(diffPath, '', 'utf8')
    const candidate: CandidateFile = {
      reqId,
      planVersion: plan.planVersion,
      candidateVersion: attempt.number,
      candidateSha256,
      requirementVersion: plan.requirementVersion,
      baselineCommit: baseline,
      snapshotCommit: finalized.workspaceHead,
      diffPath,
      diffSha256: sha256OfText(''),
      createdAt: this.deps.now(),
    }
    const opened = await this.deps.openBlackBoxSession({
      reqId,
      requirement,
      analysis,
      plan,
      signal,
    })
    if (!opened.ok) {
      this.deps.repo.setStatus(reqId, 'blocked', opened.result.detail)
      return { state: 'failed', detail: opened.result.detail }
    }
    try {
      const result = await this.deps.verifyCandidateBlackBox({
        reqId,
        requirement,
        analysis,
        plan,
        candidate,
        devWorkspace: workspace,
        signal,
        verification: opened.value,
      })
      if (result.state === 'pass') return { state: 'done', detail: result.detail }
      return result.repairRecommended === true
        ? { state: 'repair', detail: result.detail }
        : { state: 'failed', detail: result.detail }
    } finally {
      await opened.value.close()
    }
  }

  private businessReviewMaterialValid(record: {
    reportPath: string
    reportSha256: string
  }): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }

  private businessReviewInputs(reqId: string):
    | {
        ok: true
        requirement: Requirement
        analysis: RequirementAnalysis
        plan: TaskPlan
        verification: VerificationRecord
        candidateSha256: string
      }
    | { ok: false; detail: string } {
    const authorized = this.deps.requireAuthorizedPlan(reqId)
    if (!authorized.ok) return { ok: false, detail: authorized.result.message }
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, detail: `未找到需求 ${reqId}` }
    const analysis = this.deps.repo.latestAnalysis(reqId)
    if (!analysis) {
      return { ok: false, detail: `需求 ${reqId} 尚无分析结论；不能做业务终审` }
    }
    const plan = authorized.value.plan
    if (analysis.requirementVersion !== plan.requirementVersion) {
      return {
        ok: false,
        detail: `最新分析依据需求 v${analysis.requirementVersion}，任务包依据 v${plan.requirementVersion}；版本不一致，不能做业务终审`,
      }
    }
    if (analysis.clarifications.length > 0) {
      return { ok: false, detail: '需求仍有待澄清项；不能做业务终审' }
    }
    const artifacts = this.deps.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `仍有任务未交付，不能做业务终审：${missing.map((task) => task.taskId).join('、')}`,
      }
    }
    const verification = this.deps.repo.verification(reqId, plan.planVersion)
    if (!verification || verification.verdict !== 'pass') {
      return { ok: false, detail: '独立测试未通过；不能做业务终审' }
    }
    const candidateSha256 = this.deps.candidateIdentity(plan, artifacts)
    if (verification.candidateSha256 !== candidateSha256) {
      return {
        ok: false,
        detail: '独立测试绑定的候选与当前材料不一致；需重新验证后再终审',
      }
    }
    if (!this.verificationMaterialValid(verification)) {
      return { ok: false, detail: '独立测试报告文件缺失或摘要不一致；不能做业务终审' }
    }
    return { ok: true, requirement, analysis, plan, verification, candidateSha256 }
  }

  private existingReviewOutcome(
    reqId: string,
    plan: TaskPlan,
    candidateSha256: string,
    verification: VerificationRecord,
  ): { state: 'done' | 'failed'; detail: string } | null {
    const existing = this.deps.repo.businessReviewForCandidate(
      reqId,
      plan.planVersion,
      candidateSha256,
    )
    if (!existing) return null
    if (existing.verdict === 'block') {
      return {
        state: 'failed',
        detail: `候选 ${candidateSha256.slice(0, 16)}… 的业务终审已阻断；需修复后产生新候选`,
      }
    }
    if (
      existing.verificationSha256 === verification.reportSha256 &&
      this.businessReviewMaterialValid(existing)
    ) {
      return { state: 'done', detail: '业务终审已通过；等待验收' }
    }
    return {
      state: 'failed',
      detail: '业务终审报告缺失、摘要不一致或未绑定当前独立测试；需重新终审',
    }
  }

  async executeBusinessReview(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const inputs = this.businessReviewInputs(reqId)
    if (!inputs.ok) return { state: 'failed', detail: inputs.detail }
    const { requirement, analysis, plan, verification, candidateSha256 } = inputs
    const existing = this.existingReviewOutcome(reqId, plan, candidateSha256, verification)
    if (existing) return existing
    const factsResult = reviewFacts(verification.reportPath)
    if (!factsResult.ok) return { state: 'failed', detail: factsResult.detail }
    const facts = factsResult.facts

    const dir = join(verification.evidenceDir, 'business-review')
    mkdirSync(dir, { recursive: true })
    const started = Date.now()
    const run = await this.deps.runner.run({
      role: AGENT_VERIFY,
      cwd: dir,
      prompt: businessReviewPrompt({
        requirement,
        analysis,
        plan,
        candidateSha256,
        commands: facts,
      }),
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'business-review.jsonl'),
      signal,
      tools: 'none',
    })
    this.deps.charge(reqId, started)
    if (run.status !== 'completed') {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `业务终审 Agent ${runStatusLabel(run.status)}：${run.reason}`,
      )
      return {
        state: 'failed',
        detail: `业务终审未取得结论：${run.reason}`,
      }
    }
    let review: BusinessReview
    try {
      review = parseBusinessReview(run.text)
    } catch (error) {
      this.deps.repo.setStatus(reqId, 'blocked', `业务终审材料畸形：${errorMessage(error)}`)
      return {
        state: 'failed',
        detail: `业务终审材料畸形（fail-closed）：${errorMessage(error)}`,
      }
    }
    const issues = validateBusinessReview({
      scenarios: analysis.scenarios,
      acceptanceCriteria: analysis.acceptanceCriteria,
      businessRules: analysis.businessRules,
      exceptions: analysis.exceptions,
      businessPoints: analysis.businessPoints,
      acceptanceItems: analysis.acceptanceItems,
      review,
      runs: facts.map((fact) => ({
        label: fact.label,
        output: fact.logTail,
        exitCode: fact.exitCode,
      })),
      requireControls: false,
    })
    const verdict: 'pass' | 'block' =
      review.verdict === 'pass' && issues.length === 0 ? 'pass' : 'block'
    const blocking = blockingOf(verdict, issues, review.blocking)
    const report = {
      kind: 'business-review',
      reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      candidateSha256,
      verificationSha256: verification.reportSha256,
      verdict,
      summary: review.summary,
      findings: review.findings,
      blocking,
      scenarios: review.scenarios,
      acceptance: review.acceptance,
      businessRules: review.businessRules,
      exceptions: review.exceptions,
      points: review.points,
      sessionId: run.sessionId,
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    const reportPath = join(dir, 'business-review.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.deps.repo.recordBusinessReview({
      requirementId: reqId,
      planVersion: plan.planVersion,
      candidateSha256,
      requirementVersion: plan.requirementVersion,
      verificationSha256: verification.reportSha256,
      verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: run.sessionId,
      reviewedAt: this.deps.now(),
    })
    if (verdict === 'block') {
      this.deps.repo.recordFailureRound(reqId, {
        roundId: `business-review-${plan.planVersion}-${candidateSha256.slice(0, 12)}`,
        stage: FAILURE_BUSINESS_REVIEW,
        summary: `业务终审阻断：${blocking.join('；') || review.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `业务终审阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blocking.join('；') || review.summary}`,
      )
      return {
        state: 'failed',
        detail: `业务终审阻断：${blocking.join('；') || review.summary}；证据 ${reportPath}`,
      }
    }
    this.deps.repo.setStatus(reqId, EXECUTING)
    return {
      state: 'done',
      detail: `业务终审通过（候选 ${candidateSha256.slice(0, 16)}…，${review.scenarios.length} 个业务场景）`,
    }
  }

  private verificationMaterialValid(record: VerificationRecord): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }
}
