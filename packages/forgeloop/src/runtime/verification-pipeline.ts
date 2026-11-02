import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { businessReviewDir, verificationDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type { PlanReview, VerificationReport } from '../domain/verification.js'
import { validateScenarioEvidence, validateVerificationCoverage } from '../domain/verification.js'
import {
  parseBusinessReview,
  validateBusinessReview,
  type BusinessReview,
} from '../domain/business-review.js'
import { parsePlanReview } from '../domain/verification.js'
import { planReviewBlocking, verificationBlocking } from './service-helpers.js'
import { blockingOf, reviewFacts, runStatusLabel } from './review-facts.js'
import { EXECUTING } from '../domain/status.js'
import { AGENT_VERIFY } from '../domain/agents.js'
import { headCommit, prepareSnapshotWorkspace, requireGit, runCommand } from './workspace.js'
import { sha256OfText } from '../domain/delivery.js'
import { errorMessage } from '../domain/errors.js'
import { FAILURE_BUSINESS_REVIEW, FAILURE_VERIFICATION } from '../domain/counting.js'
import { ExecutionBudget } from '../domain/limits.js'
import type { Repository, VerificationRecord } from '../records/repository.js'
import type { AgentOpenRequest, AgentRunner, AgentSession } from './agent-runner.js'
import type { runFormalTest } from './formal-test.js'
import { businessReviewPrompt, verificationPrompt } from './prompts.js'
import {
  VERIFICATION_MATERIAL_DIR,
  verificationMaterials,
  workspaceChanges,
} from './service-helpers.js'
import { parseVerificationMaterials } from './verification-materials.js'
import { runVerificationCommands, type VerificationCommandRun } from './execution-commands.js'
import { verificationIntegrity, verificationVerdict } from './verification-outcome.js'
import type { OperationResult } from './operation-result.js'

export interface VerificationPipelineDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  charge: (reqId: string, started: number) => void
  runner: { run: AgentRunner['run'] }
  formalTest: typeof runFormalTest
  ctx: NonNullable<Parameters<typeof runFormalTest>[0]['ctx']>
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  candidateIdentity: (plan: TaskPlan, artifacts: ReturnType<Repository['taskArtifacts']>) => string
  requireAuthorizedPlan: (
    reqId: string,
  ) => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  applyDiffFile: (
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ) => { ok: boolean; detail: string }
  reopenDeliveredTasks: (input: {
    reqId: string
    plan: TaskPlan
    identity: string
    reason: string
  }) => Array<{ taskId: string; attempt: number; archivedPath: string }>
  verificationBaseline: (analysis: RequirementAnalysis) => PlanReview
  remainingFailureRounds: (reqId: string) => number
}

export class VerificationPipeline {
  constructor(private readonly deps: VerificationPipelineDeps) {}

  private recordPreflightBlock(input: {
    reqId: string
    plan: TaskPlan
    candidateSha256: string
    planReviewSha256: string
    blocking: readonly string[]
  }): string {
    const dir = verificationDir(
      this.deps.config,
      input.reqId,
      input.plan.planVersion,
      input.candidateSha256,
    )
    mkdirSync(dir, { recursive: true })
    const report = {
      kind: 'verification',
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateSha256: input.candidateSha256,
      workspaceSha256: '',
      planReviewSha256: input.planReviewSha256,
      verdict: 'block',
      summary: '候选无法在当前基线组装，未执行验证命令',
      findings: [],
      blocking: [...input.blocking],
      scenarios: [],
      commands: [],
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
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: '',
      verifiedAt: this.deps.now(),
    })
    this.deps.repo.recordFailureRound(input.reqId, {
      roundId: `verification-${input.plan.planVersion}-${input.candidateSha256.slice(0, 12)}-preflight`,
      stage: FAILURE_VERIFICATION,
      summary: `独立验证无法组装候选：${input.blocking.join('；')}`.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    this.deps.repo.setStatus(
      input.reqId,
      'blocked',
      `独立验证无法组装候选（候选 ${input.candidateSha256.slice(0, 16)}…）：${input.blocking.join('；')}`,
    )
    return reportPath
  }

  /**
   * 独立验证：把已交付任务的全部 diff 应用成固定候选，交给验证 Agent 在独立目录
   * 编写验证测试并产出命令清单与逐场景报告；程序随后实际执行命令并只看退出码、
   * 日志与必过场景覆盖，模型自述不构成通过。
   */
  private existingVerificationOutcome(
    reqId: string,
    plan: TaskPlan,
    candidateSha256: string,
  ): { state: 'done' | 'failed'; detail: string } | null {
    const existing = this.deps.repo.verificationForCandidate(
      reqId,
      plan.planVersion,
      candidateSha256,
    )
    if (!existing) return null
    if (existing.verdict === 'block') {
      return {
        state: 'failed',
        detail: `候选 ${candidateSha256.slice(0, 16)}… 的独立验证已阻断：${verificationBlocking(existing.reportJson)}；需修复后产生新候选再验证`,
      }
    }
    if (!this.verificationMaterialValid(existing)) {
      return { state: 'failed', detail: '独立验证报告文件缺失或摘要不一致；需重新验证' }
    }
    return {
      state: 'done',
      detail: `候选 ${candidateSha256.slice(0, 16)}… 已通过独立验证；等待验收`,
    }
  }

  private verificationBudgetGuard(
    reqId: string,
    plan: TaskPlan,
  ): { state: 'failed'; detail: string } | null {
    this.deps.repo.ensureBudget(
      reqId,
      plan.tasks.reduce((sum, task) => sum + task.limits.limitSeconds, 0),
    )
    const budget = new ExecutionBudget(
      this.deps.repo.budget(reqId).limitSeconds,
      this.deps.repo.budget(reqId).consumedSeconds,
    )
    if (budget.canStartAction()) return null
    this.deps.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需显式延长或拆分任务')
    return { state: 'failed', detail: '执行工时已用尽；需显式延长或拆分任务' }
  }

  private prepareVerificationWorkspace(
    reqId: string,
    plan: TaskPlan,
    reviewRecord: NonNullable<ReturnType<Repository['planReview']>>,
    candidateSha256: string,
  ):
    | {
        ok: true
        dir: string
        workspace: string
        diffs: string[]
        baseline: string
        snapshot: ReturnType<typeof prepareSnapshotWorkspace>
      }
    | { ok: false; outcome: { state: 'failed'; detail: string } } {
    const dir = verificationDir(this.deps.config, reqId, plan.planVersion, candidateSha256)
    const workspace = join(dir, 'workspace')
    mkdirSync(dir, { recursive: true })
    const baseline = headCommit(this.deps.config.projectPath)
    const snapshot = prepareSnapshotWorkspace({
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
      const applied = this.deps.applyDiffFile(
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
          planReviewSha256: reviewRecord.reportSha256,
          blocking,
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

  private finalizeVerificationWorkspace(input: {
    reqId: string
    plan: TaskPlan
    dir: string
    workspace: string
    diffs: readonly string[]
    candidateSha256: string
    baseline: string
    snapshot: ReturnType<typeof prepareSnapshotWorkspace>
    artifacts: ReturnType<Repository['taskArtifacts']>
  }):
    | { ok: true; workspaceSha256: string; workspaceHead: string; candidateDiff: string }
    | { ok: false; outcome: { state: 'failed'; detail: string } } {
    const { reqId, plan, dir, workspace, diffs, candidateSha256, baseline, snapshot, artifacts } =
      input
    runCommand('git', ['add', '-A'], workspace)
    runCommand('git', ['commit', '-qm', 'forgeloop: verification candidate'], workspace)
    if (this.deps.config.worktreePrepareCommand.length > 0) {
      const prepare = runCommand(
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
      runCommand('git', ['reset', '--hard', 'HEAD'], workspace)
      runCommand('git', ['clean', '-fd'], workspace)
    }
    const workspaceSha256 = requireGit(workspace, ['rev-parse', 'HEAD^{tree}'])
    const workspaceHead = requireGit(workspace, ['rev-parse', 'HEAD'])
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
        reviewRecord: NonNullable<ReturnType<Repository['planReview']>>
        planReview: PlanReview
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
    const artifacts = this.deps.repo.taskArtifacts(reqId, plan.planVersion)
    const missing = plan.tasks.filter(
      (task) => !artifacts.some((artifact) => artifact.taskId === task.taskId),
    )
    if (missing.length > 0) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `仍有任务未交付，不能开始独立验证：${missing.map((task) => task.taskId).join('、')}`,
        },
      }
    }
    const reviewRecord = this.deps.repo.planReview(reqId, plan.planVersion)
    if (!reviewRecord) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `任务包 v${plan.planVersion} 尚未通过实现前评审；不能开始独立验证`,
        },
      }
    }
    if (reviewRecord.verdict !== 'pass') {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `任务包 v${plan.planVersion} 的实现前评审未通过：${planReviewBlocking(reviewRecord.reportJson)}`,
        },
      }
    }
    let planReview: PlanReview
    try {
      planReview = parsePlanReview(reviewRecord.reportJson)
    } catch (error) {
      return {
        ok: false,
        outcome: { state: 'failed', detail: `实现前评审证据畸形：${errorMessage(error)}` },
      }
    }
    return {
      ok: true,
      requirement,
      analysis,
      plan,
      artifacts,
      reviewRecord,
      planReview,
      candidateSha256: this.deps.candidateIdentity(plan, artifacts),
    }
  }

  private async completeVerification(input: {
    reqId: string
    signal: AbortSignal
    plan: TaskPlan
    reviewRecord: NonNullable<ReturnType<Repository['planReview']>>
    planReview: PlanReview
    candidateSha256: string
    workspaceSha256: string
    run: Awaited<ReturnType<AgentRunner['run']>>
    report: VerificationReport
    commandRuns: VerificationCommandRun[]
    failedCommands: readonly string[]
    integrityIssues: readonly string[]
    dir: string
    workspace: string
    afterHead: string
    afterChanges: readonly string[]
    candidateContentSha256: string
    materials: ReturnType<typeof verificationMaterials>
  }): Promise<{ state: 'done' | 'failed' | 'repair'; detail: string }> {
    const { reqId, signal, plan, reviewRecord, planReview, candidateSha256 } = input
    const { workspaceSha256, run, report } = input
    const { commandRuns, failedCommands, integrityIssues, dir, afterHead, afterChanges } = input
    const { candidateContentSha256, materials } = input
    const coverageIssues = validateVerificationCoverage(planReview.verificationPlan, report)
    const evidenceIssues = validateScenarioEvidence(
      planReview.verificationPlan,
      report,
      commandRuns,
    )
    const { verdict, blocking } = verificationVerdict({
      report,
      failedCommands,
      coverageIssues,
      evidenceIssues,
      integrityIssues,
    })
    const canonical = {
      kind: 'verification',
      reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      candidateSha256,
      workspaceSha256,
      planReviewSha256: reviewRecord.reportSha256,
      verdict,
      summary: report.summary,
      findings: report.findings,
      blocking,
      scenarios: report.scenarios,
      commands: commandRuns.map(({ output: _output, ...rest }) => rest),
      candidateIntegrity: {
        head: afterHead,
        candidateContentSha256,
        changes: afterChanges,
        allowedPaths: [VERIFICATION_MATERIAL_DIR],
        ignoredBuildOutputsExcluded: true,
      },
      materials,
      sessionId: run.sessionId,
      at: this.deps.now(),
    }
    const reportJson = `${JSON.stringify(canonical, null, 2)}\n`
    const reportPath = join(dir, 'verification.json')
    writeFileSync(reportPath, reportJson, 'utf8')
    this.deps.repo.recordVerification({
      requirementId: reqId,
      planVersion: plan.planVersion,
      candidateSha256,
      requirementVersion: plan.requirementVersion,
      workspaceSha256,
      verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      evidenceDir: dir,
      sessionId: run.sessionId,
      verifiedAt: this.deps.now(),
    })

    if (verdict === 'block') {
      const roundId = `verification-${plan.planVersion}-${candidateSha256.slice(0, 12)}`
      const recorded = this.deps.repo.recordFailureRound(reqId, {
        roundId,
        stage: FAILURE_VERIFICATION,
        summary: `独立验证阻断：${blocking.join('；') || report.summary}`.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      const budgetLeft = this.deps.remainingFailureRounds(reqId)
      const blockingText = blocking.join('；') || report.summary
      const rounds = this.deps.repo.failureRounds(reqId).length
      // 任务包冻结：验证提出的问题交回研发执行角色修复，不重新规划。
      // 修复额度用尽时停在 blocked，等待追加授权或所有者决定。
      if (budgetLeft > 0) {
        const repairReason = `独立验证阻断，返回研发修复：${blockingText}`.slice(0, 900)
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
            `独立验证阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blockingText}；已返回研发修复（失败轮次 ${rounds}，剩余 ${budgetLeft}）`,
          )
          return {
            state: 'repair',
            detail: `独立验证阻断：${blockingText}；已返回研发修复，任务包 v${plan.planVersion} 不变；证据 ${reportPath}`,
          }
        }
      }
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `独立验证阻断（候选 ${candidateSha256.slice(0, 16)}…）：${blockingText}${
          recorded ? `；失败轮次 ${rounds}` : ''
        }${budgetLeft === 0 ? '；失败轮次额度已用尽' : ''}`,
      )
      return {
        state: 'failed',
        detail: `独立验证阻断：${blockingText}；证据 ${reportPath}`,
      }
    }

    const businessReview = await this.executeBusinessReview(reqId, signal)
    if (businessReview.state !== 'done') return businessReview
    this.deps.repo.setStatus(reqId, EXECUTING)
    return {
      state: 'done',
      detail: `候选 ${candidateSha256.slice(0, 16)}… 已通过独立验证（${report.scenarios.length} 个场景，${commandRuns.length} 条命令）；${businessReview.detail}`,
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
    candidateDiff: string
    signal: AbortSignal
  }): Promise<
    | { ok: true; run: Awaited<ReturnType<AgentRunner['run']>> }
    | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, requirement, analysis, plan, planReview, candidateSha256 } = input
    const { workspaceSha256, workspace, dir, candidateDiff, signal } = input
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
        diff: candidateDiff,
      }),
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: join(dir, 'verify.jsonl'),
      signal,
      tools: 'default',
    })
    this.deps.charge(reqId, started)
    if (run.status !== 'completed') {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `独立验证 Agent ${run.status === 'aborted' ? '被停止' : run.status === 'timeout' ? '超时' : '未完成'}：${run.reason}`,
      )
      return {
        ok: false,
        outcome: { state: 'failed', detail: `独立验证未取得可用结论：${run.reason}` },
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
    const { requirement, analysis, plan, artifacts, reviewRecord, planReview, candidateSha256 } =
      inputs
    const existingOutcome = this.existingVerificationOutcome(reqId, plan, candidateSha256)
    if (existingOutcome) return existingOutcome
    const budgetOutcome = this.verificationBudgetGuard(reqId, plan)
    if (budgetOutcome) return budgetOutcome
    const prepared = this.prepareVerificationWorkspace(reqId, plan, reviewRecord, candidateSha256)
    if (!prepared.ok) return prepared.outcome
    const { dir, workspace, diffs, baseline, snapshot } = prepared
    const finalized = this.finalizeVerificationWorkspace({
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
    const { workspaceSha256, workspaceHead, candidateDiff } = finalized
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
      candidateDiff,
      signal,
    })
    if (!agent.ok) return agent.outcome
    const run = agent.run
    const parsed = parseVerificationMaterials(workspace)
    if (!parsed.ok) {
      this.deps.repo.setStatus(reqId, 'blocked', parsed.detail)
      return { state: 'failed', detail: parsed.detail }
    }
    const { commands, report } = parsed
    const changed = workspaceChanges(workspace)
    const currentHead = requireGit(workspace, ['rev-parse', 'HEAD'])
    if (currentHead !== workspaceHead) {
      this.deps.repo.setStatus(reqId, 'blocked', '独立验证期间候选提交发生变化；需重新验证')
      return { state: 'failed', detail: '独立验证期间候选提交发生变化（fail-closed）；需重新验证' }
    }
    const outsideVerification = changed.filter(
      (path) => !path.startsWith(VERIFICATION_MATERIAL_DIR),
    )
    if (outsideVerification.length > 0) {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `独立验证修改了 verification/ 之外的文件：${outsideVerification.join('、')}`,
      )
      return {
        state: 'failed',
        detail: `独立验证越出独立验证目录（fail-closed）：${outsideVerification.join('、')}`,
      }
    }

    const ran = await runVerificationCommands({
      reqId,
      dir,
      commands,
      run: async (argv, logPath) =>
        this.deps.formalTest({
          ctx: this.deps.ctx,
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
    // 验证命令本身也可能改坏候选：执行后重新核对 HEAD 与受保护内容。
    // 合法材料只有 verification/；Git 忽略的构建输出不属于候选。
    const integrity = verificationIntegrity(workspace, workspaceHead)
    if (!integrity.ok) return { state: 'failed', detail: integrity.detail }
    const { integrityIssues, afterHead, afterChanges, candidateContentSha256 } = integrity
    const materials = verificationMaterials(dir)

    return this.completeVerification({
      reqId,
      signal,
      plan,
      reviewRecord,
      planReview,
      candidateSha256,
      workspaceSha256,
      run,
      report,
      commandRuns,
      failedCommands,
      integrityIssues,
      dir,
      workspace,
      afterHead,
      afterChanges,
      candidateContentSha256,
      materials,
    })
  }

  /** 业务终审报告文件与摘要是否仍一致。 */
  private businessReviewMaterialValid(record: {
    reportPath: string
    reportSha256: string
  }): boolean {
    return (
      existsSync(record.reportPath) &&
      sha256OfText(readFileSync(record.reportPath, 'utf8')) === record.reportSha256
    )
  }

  /**
   * 业务终审：验证 Agent 在新会话里按原始需求复核业务场景与验收标准。
   * 证据必须来自独立验证实际执行的命令输出，不能只复述验证报告。
   */
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
      return { ok: false, detail: '独立验证未通过；不能做业务终审' }
    }
    const candidateSha256 = this.deps.candidateIdentity(plan, artifacts)
    if (verification.candidateSha256 !== candidateSha256) {
      return {
        ok: false,
        detail: '独立验证绑定的候选与当前材料不一致；需重新验证后再终审',
      }
    }
    if (!this.verificationMaterialValid(verification)) {
      return { ok: false, detail: '独立验证报告文件缺失或摘要不一致；不能做业务终审' }
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
      detail: '业务终审报告缺失、摘要不一致或未绑定当前独立验证；需重新终审',
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

    const dir = businessReviewDir(this.deps.config, reqId, plan.planVersion)
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
      review,
      runs: facts.map((fact) => ({ label: fact.label, output: fact.logTail })),
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
