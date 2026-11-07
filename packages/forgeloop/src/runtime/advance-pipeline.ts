import { parseJsonObject } from '../domain/json.js'
import { asRecord } from '../domain/json.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopConfig } from '../config.js'
import { candidatesDir, evidenceDir, integrationDir, verificationDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { inputKindOf } from '../domain/requirement.js'
import {
  candidateSelfVerification,
  changedPathsFromDiff,
  parseSelfVerificationReport,
  selfModeAllowedByDiff,
  type SelfVerificationReport,
} from '../domain/self-verification.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import { authorizationSourceOf, executionOrder, planLimitSeconds } from '../domain/task-plan.js'
import {
  AWAITING_DEV_SESSION,
  CANCELLED,
  COMMITTED,
  DEVELOPING,
  EXECUTING,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  VERIFYING,
  isTerminal,
  type TaskRunState,
} from '../domain/status.js'
import { attemptAllowed, ExecutionBudget } from '../domain/limits.js'
import { FAILURE_PLANNING, FAILURE_VERIFICATION } from '../domain/counting.js'
import { RuleViolationError, errorMessage } from '../domain/errors.js'
import type { Repository } from '../records/repository.js'
import type { IssueStore } from '../records/issues.js'
import type { RequirementDevSessionRecord } from '../records/rows.js'
import type { AgentSession } from './agent-runner.js'
import type { ExecutionDev } from './execution-dev.js'
import type { VerificationPipeline } from './verification-pipeline.js'
import type {
  LegacyVerification,
  LegacyVerificationSession,
  LegacyVerifyInput,
} from './legacy-verification.js'
import type { OperationResult } from './operation-result.js'
import { changedFilesFromDiff, outsideActiveFiles } from '../domain/language.js'
import { requirementTitle } from './board.js'
import type { AcquireDevSessionResult, DevSessionRegistry } from './dev-sessions.js'
import type { OrchestratorChoice, SessionOrchestrator } from './orchestrator.js'
import { PLUGIN_VERSION } from './version.js'
import { sha256OfText } from '../domain/delivery.js'
import { exportCandidate, integrateCandidate, type CandidateFile } from './integration.js'
import { git, headCommit, runCommand } from './workspace.js'
import type { DeliverInput, DeliverOutcome } from './task-delivery.js'
import type { VerificationRecord } from '../records/repository.js'
import {
  buildRequirementIssue,
  nextIssueAttempt,
  ISSUE_FIXED,
  ISSUE_OPEN,
  ISSUE_STAGE_VERIFICATION,
  type IssueCommandEvidence,
  type IssueEnvironment,
  type RequirementIssue,
  type RequirementIssueEvidence,
} from '../domain/issue.js'
import { parseVerificationReport } from '../domain/verification.js'

function commandEvidence(raw: unknown): IssueCommandEvidence | null {
  const item = asRecord(raw)
  if (!item) return null
  const label = typeof item.label === 'string' ? item.label : ''
  if (!label) return null
  return {
    label,
    argv: Array.isArray(item.argv)
      ? item.argv.filter((value): value is string => typeof value === 'string')
      : [],
    exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
    timedOut: item.timedOut === true,
    aborted: item.aborted === true,
    logPath: typeof item.logPath === 'string' ? item.logPath : '',
    logSha256: typeof item.logSha256 === 'string' ? item.logSha256 : '',
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : 0,
  }
}

export interface AdvancePipelineDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  issues: IssueStore
  executionDev: ExecutionDev
  recordRun: (
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    outcome: { state: TaskRunState; reason: string },
  ) => void
  verificationPipeline: VerificationPipeline
  legacyVerification: LegacyVerification
  deliverTask: (input: DeliverInput) => Promise<DeliverOutcome>
  devSessions: DevSessionRegistry
  orchestrator: SessionOrchestrator
  currentAdmission: (reqId: string) => ReturnType<Repository['latestAdmission']>
  requireAuthorizedPlan: (
    reqId: string,
  ) => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  remainingFailureRounds: (reqId: string) => number
}

export class AdvancePipeline {
  constructor(private readonly deps: AdvancePipelineDeps) {}

  injectCandidateFault(reqId: string, planVersion: number, workspace: string): void {
    const raw = process.env.FORGELOOP_FAULT_INJECT?.trim()
    if (!raw) return
    const dir = candidatesDir(this.deps.config, reqId, planVersion)
    const marker = join(dir, 'fault-injection.json')
    if (existsSync(marker)) return
    const spec = parseJsonObject(raw)
    if (typeof spec.file !== 'string' || spec.file.trim() === '') {
      throw new RuleViolationError('FORGELOOP_FAULT_INJECT 需要 file')
    }
    const root = resolve(workspace)
    const target = resolve(root, spec.file)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new RuleViolationError('FORGELOOP_FAULT_INJECT 只能写需求工作区')
    }
    if (!existsSync(target)) throw new RuleViolationError(`故障注入目标不存在：${spec.file}`)
    const before = readFileSync(target, 'utf8')
    let after = before
    if (typeof spec.replaceFrom === 'string' && typeof spec.replaceTo === 'string') {
      after = after.replace(spec.replaceFrom, spec.replaceTo)
    }
    if (typeof spec.append === 'string') after += spec.append
    if (after === before) throw new RuleViolationError('故障注入没有改变工作区内容')
    writeFileSync(target, after, 'utf8')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      marker,
      `${JSON.stringify(
        {
          kind: 'isolated-fault-injection',
          reqId,
          planVersion,
          file: spec.file,
          beforeSha256: sha256OfText(before),
          afterSha256: sha256OfText(after),
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  finalizeCandidate(input: {
    reqId: string
    plan: TaskPlan
    workspace: string
    baselineCommit: string
    snapshotCommit: string
  }): CandidateFile {
    this.injectCandidateFault(input.reqId, input.plan.planVersion, input.workspace)
    const status = git(input.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.code === 0 && status.stdout.trim()) {
      runCommand('git', ['add', '-A'], input.workspace)
      runCommand('git', ['commit', '-qm', 'forgeloop: candidate checkpoint'], input.workspace)
    }
    const candidateVersion =
      this.deps.repo.codeCandidates(input.reqId, input.plan.planVersion).length + 1
    const outputPath = join(
      candidatesDir(this.deps.config, input.reqId, input.plan.planVersion),
      `candidate-${candidateVersion}.diff`,
    )
    const candidate = exportCandidate({
      workspace: input.workspace,
      snapshotCommit: input.snapshotCommit,
      baselineCommit: input.baselineCommit,
      reqId: input.reqId,
      planVersion: input.plan.planVersion,
      requirementVersion: input.plan.requirementVersion,
      candidateVersion,
      outputPath,
      now: this.deps.now(),
    })
    this.deps.repo.recordCodeCandidate({ requirementId: candidate.reqId, ...candidate })
    return candidate
  }

  /**
   * 测试 Agent 在同一会话里完成独立测试与业务验收：先设计并执行验证，再依据
   * 实际命令输出核对业务场景；不修改候选，不降低需求标准。
   */
  private async verifyCandidate(input: LegacyVerifyInput): Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord | null
    failureKind?: string
    repairRecommended?: boolean
  }> {
    return this.deps.legacyVerification.verifyCandidate(input)
  }

  /** 取消/停止/终态必须在动作入口复核，迟到的在途结果不能写提交或修复。 */
  private inactiveReason(reqId: string): string | null {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return `未找到需求 ${reqId}`
    if (requirement.status === CANCELLED) {
      return `需求 ${reqId} 已取消；不再产生新请求、修复或提交`
    }
    if (isTerminal(requirement.status)) {
      return `需求 ${reqId} 已处于终态 ${requirement.status}；不再推进`
    }
    if (this.deps.repo.activeStop(reqId)) {
      return `需求 ${reqId} 已收到停止请求；不再产生新提交`
    }
    return null
  }

  async commitCandidate(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    requirementTitle: string
  }): Promise<{ ok: true; commitSha: string } | { ok: false; detail: string }> {
    const inactive = this.inactiveReason(input.reqId)
    if (inactive) return { ok: false, detail: inactive }
    if (!this.deps.config.autonomy.allowCodeCommit) {
      return { ok: false, detail: '系统授权不允许代码提交；等待所有者授权' }
    }
    if (!existsSync(input.candidate.diffPath)) {
      return { ok: false, detail: `候选 diff 不存在：${input.candidate.diffPath}` }
    }
    const outside = outsideActiveFiles(
      changedFilesFromDiff(readFileSync(input.candidate.diffPath, 'utf8')),
      this.deps.config.activeRoots,
    )
    if (outside.length > 0) {
      return { ok: false, detail: `候选越过活动工程范围：${outside.join('、')}` }
    }
    const commit = integrateCandidate({
      projectPath: this.deps.config.projectPath,
      candidateDiffPath: input.candidate.diffPath,
      candidateBaseline: input.candidate.baselineCommit,
      expectedDiffSha256: input.candidate.diffSha256,
      checkCommand: this.deps.config.autonomy.commitCheckCommand,
      commitMessage: [
        `feat: ${input.requirementTitle}`.slice(0, 120),
        '',
        `ForgeLoop requirement: ${input.reqId}`,
        `Plan: v${input.plan.planVersion}`,
        `Candidate: ${input.candidate.candidateSha256}`,
        `Requirement version: v${input.candidate.requirementVersion}`,
      ].join('\n'),
      evidenceDir: integrationDir(this.deps.config, input.reqId, input.candidate.candidateSha256),
      timeoutMs: this.deps.config.formalTestTimeoutSeconds * 1000,
    })
    if (!commit.ok) return { ok: false, detail: commit.detail }
    this.deps.repo.recordCommit({
      requirementId: input.reqId,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      commitSha: commit.commitSha,
      commitMessage: input.requirementTitle,
      checkCommand: this.deps.config.autonomy.commitCheckCommand,
      checkLogPath: commit.checkLogPath,
      checkSha256: commit.checkSha256,
      files: commit.files,
      committedAt: this.deps.now(),
    })
    writeFileSync(
      join(
        integrationDir(this.deps.config, input.reqId, input.candidate.candidateSha256),
        'commit.json',
      ),
      `${JSON.stringify(
        {
          reqId: input.reqId,
          planVersion: input.plan.planVersion,
          candidateSha256: input.candidate.candidateSha256,
          commitSha: commit.commitSha,
          files: commit.files,
          checkCommand: this.deps.config.autonomy.commitCheckCommand,
          checkLogPath: commit.checkLogPath,
          checkSha256: commit.checkSha256,
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return { ok: true, commitSha: commit.commitSha }
  }

  /**
   * 把一次测试阻断固化为内建问题单：绑定需求、测试报告与候选，
   * 并保存实际执行的命令日志、运行环境与状态，供研发复现和后续反查。
   */
  recordVerificationIssue(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    candidate: CandidateFile
    verification: VerificationRecord
    blocking: readonly string[]
    devWorkspace: string
  }): RequirementIssue {
    const attempt = nextIssueAttempt(this.deps.issues.issuesFor(input.reqId))
    const now = this.deps.now()
    const blocking =
      input.blocking.length > 0
        ? [...input.blocking]
        : ['独立测试判定为阻断，但测试报告没有给出具体阻断项']
    const commands = this.issueCommands(input.verification.reportJson)
    let verificationSummary = ''
    try {
      verificationSummary = parseVerificationReport(input.verification.reportJson).summary
    } catch {
      verificationSummary = ''
    }
    const environment: IssueEnvironment = {
      project: this.deps.config.project,
      projectPath: this.deps.config.projectPath,
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      hostname: hostname(),
      pluginVersion: PLUGIN_VERSION,
      requirementStatus: input.requirement.status,
      requirementVersion: input.requirement.versions.length,
      planVersion: input.plan.planVersion,
      candidateSha256: input.candidate.candidateSha256,
      candidateVersion: input.candidate.candidateVersion,
      candidateDiffPath: input.candidate.diffPath,
      verificationReportPath: input.verification.reportPath,
      verificationReportSha256: input.verification.reportSha256,
      verificationEvidenceDir: input.verification.evidenceDir,
      devWorkspace: input.devWorkspace,
    }
    const evidence: RequirementIssueEvidence = {
      blocking,
      summary: verificationSummary,
      commands,
      logs: [
        ...commands.map((command) => command.logPath).filter((path) => path !== ''),
        input.verification.reportPath,
      ],
      environment,
      state: {
        attempt,
        stage: ISSUE_STAGE_VERIFICATION,
        verificationVerdict: input.verification.verdict,
      },
    }
    const issue = buildRequirementIssue({
      issueId: `issue-${now.replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`,
      requirementId: input.reqId,
      project: this.deps.config.project,
      attempt,
      stage: ISSUE_STAGE_VERIFICATION,
      status: ISSUE_OPEN,
      summary: `独立测试阻断（attempt ${attempt}）：${blocking.join('；')}`.slice(0, 1000),
      evidence,
      verificationSha256: input.verification.reportSha256,
      candidateSha256: input.candidate.candidateSha256,
      createdAt: now,
      updatedAt: now,
      resolvedAt: '',
    })
    this.deps.issues.record(issue)
    return issue
  }

  /** 从测试报告提取实际执行过的命令；报告畸形时保留空清单，报告路径仍作为证据。 */
  private issueCommands(reportJson: string): IssueCommandEvidence[] {
    let data: unknown
    try {
      data = JSON.parse(reportJson)
    } catch {
      return []
    }
    if (typeof data !== 'object' || data === null) return []
    const commands = asRecord(data)?.commands
    if (!Array.isArray(commands)) return []
    const collected: IssueCommandEvidence[] = []
    for (const raw of commands) {
      const command = commandEvidence(raw)
      if (command) collected.push(command)
    }
    return collected
  }

  /** 测试阻断后的定向修复：同一研发会话与工作区，只处理缺陷，不重建全部任务。 */
  async repairCandidate(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    workspace: string
    session: AgentSession
    blocking: readonly string[]
    candidate: { readonly candidateSha256: string }
    signal: AbortSignal
    round: number
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const inactive = this.inactiveReason(input.reqId)
    if (inactive) return { ok: false, reason: inactive }
    const reportDir = join(
      verificationDir(
        this.deps.config,
        input.reqId,
        input.plan.planVersion,
        input.candidate.candidateSha256,
      ),
      'repair',
    )
    mkdirSync(reportDir, { recursive: true })
    const prompt = `你是 ForgeLoop 的研发 Agent。测试 Agent 在候选 ${input.candidate.candidateSha256.slice(0, 16)}… 上发现缺陷。
当前工作区就是候选的工作现场，已有成果必须保留；只修复下面列出的缺陷，不要重做全部任务，不要修改需求或验收标准，不要改版本号。

需求：${requirementTitle(input.requirement)}

缺陷与阻断证据：
${input.blocking.map((item) => `- ${item}`).join('\n') || '- 测试 Agent 未给出具体阻断项'}

请在同一工作区定位并修复，完成后用简短文本说明改了什么、如何验证。不要执行 git commit/push，程序会采集并固定新候选。`
    for (let attempt = 1; attemptAllowed(attempt, this.deps.config.maxTaskAttempts); attempt += 1) {
      if (input.signal.aborted) return { ok: false, reason: '停止请求：修复未完成，现场保留' }
      const result = await input.session.send({
        prompt,
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: join(reportDir, `dev-${input.round}-a${attempt}.jsonl`),
        signal: input.signal,
      })
      if (result.status === 'aborted' || result.status === 'timeout') {
        return {
          ok: false,
          reason: `修复回合${result.status === 'aborted' ? '被停止' : '超时'}：${result.reason}`,
        }
      }
      if (result.status !== 'completed') continue
      const status = git(input.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
      if (status.code !== 0 || status.stdout.trim() === '') {
        continue
      }
      runCommand('git', ['add', '-A'], input.workspace)
      runCommand(
        'git',
        ['commit', '-qm', `forgeloop: repair round ${input.round}`],
        input.workspace,
      )
      return { ok: true }
    }
    return { ok: false, reason: '修复回合没有产生可用改动' }
  }

  /**
   * 连续研发：系统准入后由同一个推进请求完成方案、实现、自验、独立测试、
   * 定向修复和受控提交；例外（越界、额度用尽、提交检查失败）才停下等待决定。
   */
  private continuousInputs(reqId: string):
    | {
        ok: true
        requirement: Requirement
        analysis: RequirementAnalysis
        admission: NonNullable<ReturnType<Repository['latestAdmission']>>
      }
    | { ok: false; outcome: { state: 'failed'; detail: string } } {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) {
      return { ok: false, outcome: { state: 'failed', detail: `未找到需求 ${reqId}` } }
    }
    if (isTerminal(requirement.status)) {
      return {
        ok: false,
        outcome: { state: 'failed', detail: `需求已处于终态 ${requirement.status}` },
      }
    }
    const admission = this.deps.currentAdmission(reqId)
    if (!admission) {
      return { ok: false, outcome: { state: 'failed', detail: '需求没有系统准入，不能自动研发' } }
    }
    const analysis = this.deps.repo.latestAnalysis(reqId)
    if (!analysis || analysis.requirementVersion !== requirement.versions.length) {
      this.deps.repo.setStatus(reqId, 'blocked', '需求说明缺失或已过期；需要产品 Agent 重新澄清')
      return { ok: false, outcome: { state: 'failed', detail: '需求说明缺失或已过期' } }
    }
    const budget = this.deps.repo.budget(reqId)
    if (budget.limitSeconds > 0 && budget.limitSeconds <= budget.consumedSeconds) {
      this.deps.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需要显式延长或拆分需求')
      return { ok: false, outcome: { state: 'failed', detail: '执行工时已用尽' } }
    }
    return { ok: true, requirement, analysis, admission }
  }

  private async ensureContinuousPlan(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    session: AgentSession
    authorizationSource: string
    signal: AbortSignal
  }): Promise<
    { ok: true; plan: TaskPlan } | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, requirement, analysis, session, authorizationSource, signal } = input
    const existing = this.deps.repo.latestTaskPlan(reqId)
    if (existing && existing.requirementVersion === requirement.versions.length) {
      return { ok: true, plan: existing }
    }
    const planned = await this.deps.executionDev.planInDevSession({
      reqId,
      requirement,
      analysis,
      session,
      authorizationSource,
      signal,
    })
    if (planned.ok) return { ok: true, plan: planned.plan }
    // 方案格式/模型异常已在研发会话内重试；仍失败时计一轮并停在 blocked，
    // 不自动整轮重放，避免同样的畸形输出无限循环。
    this.deps.repo.recordFailureRound(reqId, {
      roundId: `planning-${randomUUID()}`,
      stage: FAILURE_PLANNING,
      summary: `技术方案未形成：${planned.reason}`.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    this.deps.repo.setStatus(reqId, 'blocked', `技术方案未形成：${planned.reason}`)
    return {
      ok: false,
      outcome: { state: 'failed', detail: `技术方案未形成：${planned.reason}` },
    }
  }

  private async developContinuousTasks(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    workspace: string
    session: AgentSession
    authorizationSource: string
    signal: AbortSignal
  }): Promise<
    | { ok: true; reports: Array<{ taskId: string; report: SelfVerificationReport | null }> }
    | { ok: false; detail: string; clarification?: { question: string; context: string } }
  > {
    const { reqId, requirement, analysis, plan, workspace, session, authorizationSource, signal } =
      input
    const reports: Array<{ taskId: string; report: SelfVerificationReport | null }> = []
    for (const taskId of executionOrder(plan)) {
      const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
      if (!task) continue
      if (this.deps.repo.taskArtifact(reqId, plan.planVersion, taskId)) {
        reports.push({ taskId, report: this.readSelfVerification(reqId, plan, taskId) })
        continue
      }
      const outcome = await this.deps.executionDev.developTaskInSession({
        reqId,
        requirement,
        plan,
        task,
        workspace,
        session,
        authorizationSource,
        inputKind: inputKindOf(analysis),
        signal,
      })
      reports.push({ taskId, report: outcome.selfVerification ?? null })
      if (outcome.state !== 'delivered') {
        this.deps.repo.setStatus(reqId, 'blocked', outcome.reason)
        return {
          ok: false,
          detail: outcome.reason,
          ...(outcome.clarification ? { clarification: outcome.clarification } : {}),
        }
      }
    }
    return { ok: true, reports }
  }

  private async repairOpenIssue(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    workspace: string
    session: AgentSession
    signal: AbortSignal
  }): Promise<{ ok: true } | { ok: false; detail: string }> {
    const { reqId, requirement, plan, workspace, session, signal } = input
    const openIssue = this.deps.issues.latestOpen(reqId)
    if (!openIssue) return { ok: true }
    this.deps.repo.setStatus(
      reqId,
      DEVELOPING,
      `按问题单 ${openIssue.issueId}（attempt ${openIssue.attempt}）定向修复`,
    )
    const repaired = await this.repairCandidate({
      reqId,
      requirement,
      plan,
      workspace,
      session,
      blocking: openIssue.evidence.blocking,
      candidate: { candidateSha256: openIssue.candidateSha256 },
      signal,
      round: openIssue.attempt,
    })
    if (!repaired.ok) {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `定向修复未完成：${repaired.reason}；问题单 ${openIssue.issueId} 保留在研发队列`,
      )
      return { ok: false, detail: `定向修复未完成：${repaired.reason}` }
    }
    this.deps.issues.updateStatus(openIssue.issueId, ISSUE_FIXED, this.deps.now())
    return { ok: true }
  }

  /** 无法建立测试材料也是真实的失败尝试；计入失败轮次，避免协调器原地重排。 */
  private recordVerificationPrepFailure(
    reqId: string,
    detail: string,
  ): { state: 'failed'; detail: string } {
    this.deps.repo.recordFailureRound(reqId, {
      roundId: `verification-prep-${randomUUID()}`,
      stage: FAILURE_VERIFICATION,
      summary: detail.slice(0, 1000),
      occurredAt: this.deps.now(),
    })
    this.deps.repo.setStatus(reqId, 'blocked', detail)
    return { state: 'failed', detail }
  }

  /** 测试阻断后的问题单、定向修复与候选重建；只有实现缺陷会进入这里。 */
  private async handleBlockedVerification(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    workspace: string
    workspaceInfo: {
      workspace: string
      baselineCommit: string
      snapshotCommit: string
      fresh: boolean
    }
    session: AgentSession
    signal: AbortSignal
    candidate: ReturnType<AdvancePipeline['finalizeCandidate']>
    round: number
    recorded: VerificationRecord
    verification: {
      detail: string
      blocking: string[]
      verification: VerificationRecord | null
      failureKind?: string
      repairRecommended?: boolean
    }
  }): Promise<
    | { stop: true; result: { state: 'failed'; detail: string } }
    | { stop: false; candidate: ReturnType<AdvancePipeline['finalizeCandidate']> }
  > {
    const { reqId, requirement, plan, workspace, workspaceInfo, session, signal, round } = input
    const { verification } = input
    if (verification.repairRecommended === false) {
      return { stop: true, result: this.verificationWithoutRepair(reqId, verification) }
    }
    const { recorded } = input
    const issue = this.recordVerificationIssue({
      reqId,
      requirement,
      plan,
      candidate: input.candidate,
      verification: recorded,
      blocking: verification.blocking,
      devWorkspace: workspace,
    })
    if (this.deps.remainingFailureRounds(reqId) <= 0) {
      const blocking = verification.blocking.join('；') || verification.detail
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `测试未通过，已创建问题单 ${issue.issueId}（attempt ${issue.attempt}）：${blocking}；失败轮次额度已用尽，需有效追加授权后才能继续修复或再次送验`,
      )
      return {
        stop: true,
        result: {
          state: 'failed',
          detail: `测试未通过：${blocking}；已保留问题单 ${issue.issueId}，等待追加授权`,
        },
      }
    }
    const maxVerificationAttempts = this.deps.config.maxVerificationAttempts
    if (maxVerificationAttempts > 0 && round >= maxVerificationAttempts) {
      const blocking = verification.blocking.join('；') || verification.detail
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `测试未通过，已创建问题单 ${issue.issueId}（attempt ${issue.attempt}）：${blocking}；问题单已加入研发队列，将自动重新验证`,
      )
      return {
        stop: true,
        result: {
          state: 'failed',
          detail: `测试未通过：${blocking}；问题单 ${issue.issueId}（attempt ${issue.attempt}）已加入研发队列`,
        },
      }
    }
    const repaired = await this.repairCandidate({
      reqId,
      requirement,
      plan,
      workspace,
      session,
      blocking: verification.blocking,
      candidate: input.candidate,
      signal,
      round,
    })
    if (!repaired.ok) {
      this.deps.repo.setStatus(
        reqId,
        'blocked',
        `定向修复未完成：${repaired.reason}；问题单 ${issue.issueId} 保留在研发队列`,
      )
      return {
        stop: true,
        result: { state: 'failed', detail: `定向修复未完成：${repaired.reason}` },
      }
    }
    this.deps.issues.updateStatus(issue.issueId, ISSUE_FIXED, this.deps.now())
    return {
      stop: false,
      candidate: this.finalizeCandidate({
        reqId,
        plan,
        workspace,
        baselineCommit: workspaceInfo.baselineCommit,
        snapshotCommit: workspaceInfo.snapshotCommit,
      }),
    }
  }

  /** 用例、环境、证据、需求争议或原因未明：保留阻断，不把问题当成实现缺陷交给研发。 */
  private verificationWithoutRepair(
    reqId: string,
    verification: {
      detail: string
      blocking: string[]
      verification: { verdict: 'pass' | 'block' } | null
      failureKind?: string
    },
  ): { state: 'failed'; detail: string } {
    const blocking = verification.blocking.join('；') || verification.detail
    const kind = verification.failureKind ?? 'undetermined'
    this.deps.repo.setStatus(
      reqId,
      'blocked',
      `测试未通过（${kind}）：${blocking}；${verification.detail}`,
    )
    return {
      state: 'failed',
      detail: `测试未通过（${kind}）：${blocking}；未要求研发修改代码`,
    }
  }

  /** 读取已交付任务持久化的自验报告；缺失时返回 null，整份候选转独立测试。 */
  private readSelfVerification(
    reqId: string,
    plan: TaskPlan,
    taskId: string,
  ): SelfVerificationReport | null {
    const path = join(
      evidenceDir(this.deps.config, reqId, plan.planVersion, taskId),
      'self-verification.json',
    )
    if (!existsSync(path)) return null
    try {
      return parseSelfVerificationReport(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }

  /** 研发自验证 self 模式：按候选身份保存报告，供提交与审计复核。 */
  private recordSelfVerification(
    reqId: string,
    plan: TaskPlan,
    candidate: CandidateFile,
    reports: ReadonlyArray<{ taskId: string; report: SelfVerificationReport | null }>,
  ): string {
    const dir = candidatesDir(this.deps.config, reqId, plan.planVersion)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `self-verification-${candidate.candidateSha256.slice(0, 16)}.json`)
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          kind: 'dev-self-verification',
          reqId,
          planVersion: plan.planVersion,
          candidateSha256: candidate.candidateSha256,
          reports,
          at: this.deps.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return path
  }

  /** 问题输入遇到无法确认的业务预期：追加需求版本并等待产品澄清，不冒充代码缺陷。 */
  private async requestDevClarification(input: {
    reqId: string
    requirement: Requirement
    clarification: { question: string; context: string }
  }): Promise<{ state: 'failed'; detail: string }> {
    const versions = input.requirement.versions
    const latest = versions[versions.length - 1]
    this.deps.repo.appendVersion({
      reqId: input.reqId,
      text: `${latest?.text ?? ''}\n\n研发澄清请求：${input.clarification.question}\n已调查事实与无法确认之处：${input.clarification.context || '未提供'}`,
      revisedBy: 'dev',
      source: `dev-clarification:${input.reqId}`,
      now: this.deps.now(),
    })
    this.deps.repo.setStatus(
      input.reqId,
      'awaiting_clarification',
      `研发请求产品澄清：${input.clarification.question}`,
    )
    return {
      state: 'failed',
      detail: `研发需要产品澄清：${input.clarification.question}；已追加需求版本，等待回答后重新分析`,
    }
  }

  // 取消/额度/自验/验证/修复/提交的入口都在同一候选生命周期内复核；拆分只会
  // 把同一组判定分散到多个方法，更难审计。
  // eslint-disable-next-line complexity
  private async verifyContinuousCandidate(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: ReturnType<AdvancePipeline['finalizeCandidate']>
    workspace: string
    workspaceInfo: {
      workspace: string
      baselineCommit: string
      snapshotCommit: string
      fresh: boolean
    }
    session: AgentSession
    verification: LegacyVerificationSession
    signal: AbortSignal
  }): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const {
      reqId,
      requirement,
      analysis,
      plan,
      workspace,
      workspaceInfo,
      session,
      verification: verificationSession,
      signal,
    } = input
    let candidate = input.candidate
    for (let round = 1; ; round += 1) {
      const inactive = this.inactiveReason(reqId)
      if (inactive) return { state: 'failed', detail: inactive }
      this.deps.repo.setStatus(
        reqId,
        VERIFYING,
        `测试 Agent 正在验证候选 v${candidate.candidateVersion}`,
      )
      const verification = await this.verifyCandidate({
        reqId,
        requirement,
        analysis,
        plan,
        candidate,
        devWorkspace: workspace,
        signal,
        verification: verificationSession,
      })
      const afterVerifyInactive = this.inactiveReason(reqId)
      if (afterVerifyInactive) return { state: 'failed', detail: afterVerifyInactive }
      if (verification.verification === null && verification.state === 'block') {
        return this.recordVerificationPrepFailure(reqId, verification.detail)
      }
      if (verification.state === 'pass') {
        this.deps.issues.resolveOpen(reqId, this.deps.now())
        const commit = await this.commitCandidate({
          reqId,
          plan,
          candidate,
          requirementTitle: requirementTitle(requirement),
        })
        if (!commit.ok) {
          if (this.deps.repo.getRequirement(reqId)?.status !== CANCELLED) {
            this.deps.repo.setStatus(reqId, 'blocked', `受控提交未完成：${commit.detail}`)
          }
          return { state: 'failed', detail: `受控提交未完成：${commit.detail}` }
        }
        this.deps.repo.setStatus(reqId, COMMITTED, `已提交 ${commit.commitSha.slice(0, 12)}`)
        return {
          state: 'done',
          detail: `需求 ${reqId} 已完成研发、独立测试与提交：${commit.commitSha.slice(0, 12)}`,
        }
      }
      const recorded = verification.verification
      if (recorded && recorded.verdict === 'block') {
        const handled = await this.handleBlockedVerification({
          reqId,
          requirement,
          plan,
          workspace,
          workspaceInfo,
          session,
          signal,
          candidate,
          round,
          recorded,
          verification,
        })
        if (handled.stop) return handled.result
        candidate = handled.candidate
        continue
      }
      // 业务验收阻断（独立测试本身已通过）仍受失败额度约束。
      if (this.deps.remainingFailureRounds(reqId) === 0) {
        this.deps.repo.setStatus(
          reqId,
          'blocked',
          `测试未通过且失败额度已用尽：${verification.blocking.join('；') || verification.detail}`,
        )
        return { state: 'failed', detail: `测试未通过且失败额度已用尽：${verification.detail}` }
      }
      const repaired = await this.repairCandidate({
        reqId,
        requirement,
        plan,
        workspace,
        session,
        blocking: verification.blocking,
        candidate,
        signal,
        round,
      })
      if (!repaired.ok) {
        this.deps.repo.setStatus(reqId, 'blocked', `定向修复未完成：${repaired.reason}`)
        return { state: 'failed', detail: `定向修复未完成：${repaired.reason}` }
      }
      candidate = this.finalizeCandidate({
        reqId,
        plan,
        workspace,
        baselineCommit: workspaceInfo.baselineCommit,
        snapshotCommit: workspaceInfo.snapshotCommit,
      })
    }
  }

  /** 需求结束只释放会话并写总结；研发会话本身不 dispose，现场与上下文保留。 */
  private async finishDevSession(input: {
    reqId: string
    requirementVersion: number
    sessionId: string
    session: AgentSession
    requirement: Requirement
    plan: TaskPlan | null
    outcome: string
  }): Promise<void> {
    try {
      await this.deps.devSessions.finish(input)
    } catch {
      // 总结写入失败也必须释放占用；否则需求会永远停在等待会话空闲。
      this.deps.repo.releaseDevSession(input.sessionId, this.deps.now())
      this.deps.repo.releaseRequirementDevSession(
        input.reqId,
        input.requirementVersion,
        this.deps.now(),
      )
    }
  }

  private async developInDevSession(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    authorizationSource: string
    workspaceInfo: {
      workspace: string
      baselineCommit: string
      snapshotCommit: string
      fresh: boolean
    }
    session: AgentSession
    planRef: { plan: TaskPlan | null }
    signal: AbortSignal
  }): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const { reqId, requirement, analysis, workspaceInfo, session, authorizationSource, signal } =
      input
    const planned = await this.ensureContinuousPlan({
      reqId,
      requirement,
      analysis,
      session,
      authorizationSource,
      signal,
    })
    if (!planned.ok) return planned.outcome
    const plan = planned.plan
    input.planRef.plan = plan
    this.deps.repo.ensureBudget(reqId, planLimitSeconds(plan.tasks))
    // 测试 Agent 在研发开始前新开会话并生成方案；产物交付后由同一会话执行与验收。
    const opened = await this.deps.legacyVerification.openVerification({
      reqId,
      requirement,
      analysis,
      plan,
      signal,
    })
    if (!opened.ok) {
      this.deps.repo.recordFailureRound(reqId, {
        roundId: `verification-plan-${randomUUID()}`,
        stage: FAILURE_VERIFICATION,
        summary: opened.result.detail.slice(0, 1000),
        occurredAt: this.deps.now(),
      })
      this.deps.repo.setStatus(reqId, 'blocked', opened.result.detail)
      return { state: 'failed', detail: opened.result.detail }
    }
    try {
      return await this.developUnderVerification({
        reqId,
        requirement,
        analysis,
        plan,
        authorizationSource,
        workspaceInfo,
        session,
        verification: opened.value,
        signal,
      })
    } finally {
      // 测试会话只服务本次推进请求；研发会话保留，不在这里关闭。
      await opened.value.close()
    }
  }

  /** 在已选定的研发会话里实现、修复与采集候选，再把测试会话交给独立测试与业务验收。 */
  private async developUnderVerification(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    authorizationSource: string
    workspaceInfo: {
      workspace: string
      baselineCommit: string
      snapshotCommit: string
      fresh: boolean
    }
    session: AgentSession
    verification: LegacyVerificationSession
    signal: AbortSignal
  }): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const { reqId, requirement, analysis, plan, workspaceInfo, session, authorizationSource } =
      input
    const { verification } = input
    const { signal } = input
    const workspace = workspaceInfo.workspace
    this.deps.repo.setStatus(reqId, DEVELOPING, '研发 Agent 在同一会话与工作区实现并自验')
    if (workspaceInfo.fresh) {
      const restored = this.deps.executionDev.restoreDeliveredArtifacts(
        reqId,
        plan,
        workspace,
        workspaceInfo.baselineCommit,
      )
      if (!restored.ok) {
        this.deps.repo.setStatus(reqId, 'blocked', restored.reason)
        return { state: 'failed', detail: restored.reason }
      }
    }
    const developed = await this.developContinuousTasks({
      reqId,
      requirement,
      analysis,
      plan,
      workspace,
      session,
      authorizationSource,
      signal,
    })
    if (!developed.ok) {
      if (developed.clarification) {
        return await this.requestDevClarification({
          reqId,
          requirement,
          clarification: developed.clarification,
        })
      }
      return { state: 'failed', detail: developed.detail }
    }
    const repairedIssue = await this.repairOpenIssue({
      reqId,
      requirement,
      plan,
      workspace,
      session,
      signal,
    })
    if (!repairedIssue.ok) return { state: 'failed', detail: repairedIssue.detail }
    const candidate = this.finalizeCandidate({
      reqId,
      plan,
      workspace,
      baselineCommit: workspaceInfo.baselineCommit,
      snapshotCommit: workspaceInfo.snapshotCommit,
    })
    const inputKind = inputKindOf(analysis)
    const diffAvailable = existsSync(candidate.diffPath)
    const diff = diffAvailable ? readFileSync(candidate.diffPath, 'utf8') : ''
    const diffGate = selfModeAllowedByDiff({
      paths: changedPathsFromDiff(diff),
      reports: developed.reports.flatMap((item) => (item.report ? [item.report] : [])),
    })
    const selfMode =
      diffAvailable &&
      diffGate.ok &&
      developed.reports.length === plan.tasks.length &&
      candidateSelfVerification({ inputKind, reports: developed.reports }).ok
    if (selfMode) {
      const reportPath = this.recordSelfVerification(reqId, plan, candidate, developed.reports)
      const commit = await this.commitCandidate({
        reqId,
        plan,
        candidate,
        requirementTitle: requirementTitle(requirement),
      })
      if (!commit.ok) {
        if (this.deps.repo.getRequirement(reqId)?.status !== CANCELLED) {
          this.deps.repo.setStatus(reqId, 'blocked', `受控提交未完成：${commit.detail}`)
        }
        return { state: 'failed', detail: `受控提交未完成：${commit.detail}` }
      }
      this.deps.repo.setStatus(
        reqId,
        COMMITTED,
        `研发自测试通过并已提交 ${commit.commitSha.slice(0, 12)}；自验证证据 ${reportPath}`,
      )
      return {
        state: 'done',
        detail: `需求 ${reqId} 已完成研发自验证与提交：${commit.commitSha.slice(0, 12)}（研发选择 self）`,
      }
    }
    return await this.verifyContinuousCandidate({
      reqId,
      requirement,
      analysis,
      plan,
      candidate,
      workspace,
      workspaceInfo,
      session,
      verification,
      signal,
    })
  }

  /**
   * 连续研发：先由主控 Agent 选择或新建研发会话，再在同一会话里完成方案、实现、
   * 自验、独立测试、定向修复和受控提交；会话忙时需求排队等待，不算失败。
   */
  async executeContinuousAdvance(
    reqId: string,
    signal: AbortSignal,
    requestId = '',
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const inputs = this.continuousInputs(reqId)
    if (!inputs.ok) return inputs.outcome
    const { requirement, analysis, admission } = inputs
    const authorizationSource = `system-admission:${admission.admissionId}`
    const requirementVersion = requirement.versions.length
    const acquired = await this.resolveDevSession({
      reqId,
      requirement,
      analysis,
      requirementVersion,
      requestKey: requestId || `advance-${randomUUID()}`,
      signal,
    })
    if (!acquired.ok) {
      if (acquired.state === 'busy') {
        this.deps.repo.setStatus(reqId, AWAITING_DEV_SESSION, acquired.detail)
        return { state: 'done', detail: acquired.detail }
      }
      const detail = `研发会话不可用：${acquired.detail}`
      this.deps.repo.setStatus(reqId, 'blocked', detail)
      return { state: 'failed', detail }
    }
    const workspaceInfo = {
      workspace: acquired.workspace,
      baselineCommit: acquired.baselineCommit,
      snapshotCommit: acquired.snapshotCommit,
      fresh: acquired.fresh,
    }
    const planRef: { plan: TaskPlan | null } = { plan: null }
    let outcome = '研发请求未正常结束'
    try {
      const result = await this.developInDevSession({
        reqId,
        requirement,
        analysis,
        authorizationSource,
        workspaceInfo,
        session: acquired.session,
        planRef,
        signal,
      })
      outcome = result.detail
      return result
    } catch (error) {
      outcome = `研发请求异常：${errorMessage(error)}`
      throw error
    } finally {
      await this.finishDevSession({
        reqId,
        requirementVersion,
        sessionId: acquired.sessionId,
        session: acquired.session,
        requirement,
        plan: planRef.plan,
        outcome,
      })
    }
  }

  /** 绑定优先、否则采用主控结果；两种来源各自记录是谁选的与理由。 */
  private routingSelection(
    bound: RequirementDevSessionRecord | null,
    choice: OrchestratorChoice | null,
  ): { selectedSessionId: string | null; selectionReason: string; selectedBy: string } {
    if (choice) {
      const source = choice.source === 'model' ? 'orchestrator' : 'orchestrator:new'
      return {
        selectedSessionId: choice.sessionId,
        selectionReason: choice.reason,
        selectedBy: source,
      }
    }
    return {
      selectedSessionId: bound?.sessionId ?? null,
      selectionReason: bound?.reason ?? '',
      selectedBy: bound?.selectedBy ?? 'requirement-binding',
    }
  }

  /**
   * 取得需求要用的研发会话：已有绑定直接复用；否则由主控 Agent 选择。
   * 主控选中的会话在真正占用时失效（工作区被删、宿主恢复失败等）时，按主控给的备选
   * 顺序再试，全部不可用才改派新会话并更新绑定；会话忙仍按等待处理，不换会话。
   */
  private async resolveDevSession(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    requirementVersion: number
    requestKey: string
    signal: AbortSignal
  }): Promise<AcquireDevSessionResult> {
    const { reqId, requirement, analysis, requirementVersion, requestKey, signal } = input
    const bound = this.deps.repo.requirementDevSession(reqId, requirementVersion)
    const choice =
      bound === null
        ? await this.deps.orchestrator.choose({
            requirement,
            analysis,
            signal,
          })
        : null
    const selection = this.routingSelection(bound, choice)
    const acquire = (
      sessionId: string | null,
      overrides: { reason?: string; allowRebind?: boolean } = {},
    ) =>
      this.deps.devSessions.acquire({
        reqId,
        requirementVersion,
        ...selection,
        selectedSessionId: sessionId,
        selectionReason: overrides.reason ?? selection.selectionReason,
        requestId: requestKey,
        signal,
        allowRebind: overrides.allowRebind === true,
      })
    const first = await acquire(selection.selectedSessionId)
    if (first.ok || first.state === 'busy') return first
    for (const alternative of choice?.alternatives ?? []) {
      const retried = await acquire(alternative, {
        reason: `${selection.selectionReason}；选中的会话不可用（${first.detail}），改用备选会话`,
      })
      if (retried.ok || retried.state === 'busy') return retried
    }
    return acquire(null, { allowRebind: true })
  }

  private advanceBudgetGuard(
    reqId: string,
    plan: TaskPlan,
  ): { state: 'failed'; detail: string } | null {
    this.deps.repo.ensureBudget(reqId, planLimitSeconds(plan.tasks))
    const budget = new ExecutionBudget(
      this.deps.repo.budget(reqId).limitSeconds,
      this.deps.repo.budget(reqId).consumedSeconds,
    )
    if (budget.canStartAction()) return null
    this.deps.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需显式延长或拆分任务')
    return { state: 'failed', detail: '执行工时已用尽；需显式延长或拆分任务' }
  }

  private async deliverTaskSafely(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    taskId: string
    baseline: string
    authorizationSource: string
    signal: AbortSignal
    requestId: string
  }): Promise<{ ok: true; outcome: Awaited<DeliverOutcome> } | { ok: false; detail: string }> {
    const { reqId, requirement, plan, taskId, baseline, authorizationSource, signal, requestId } =
      input
    let outcome: Awaited<DeliverOutcome>
    try {
      outcome = await this.deps.deliverTask({
        requirement,
        plan,
        taskId,
        baseline,
        authorizationSource,
        signal,
        requestId,
      })
    } catch (error) {
      // 未预期异常也必须写出终态：否则运行记录会停在 running，看板无法区分
      // “还在跑”和“已经崩溃”。已落产物说明交付实际完成，不能改判失败。
      const reason = `任务执行异常：${errorMessage(error)}；任务未交付，可重新执行`
      const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
      const artifact = this.deps.repo.taskArtifact(reqId, plan.planVersion, taskId)
      if (artifact && task) {
        this.deps.recordRun(reqId, plan, task, { state: TASK_RUN_DELIVERED, reason: '' })
        outcome = { state: 'delivered', reason: '', requirementStatus: EXECUTING }
      } else if (task) {
        this.deps.recordRun(reqId, plan, task, { state: TASK_RUN_FAILED, reason: reason })
        this.deps.repo.setStatus(reqId, 'blocked', reason)
        return { ok: false, detail: reason }
      } else {
        this.deps.repo.setStatus(reqId, 'blocked', reason)
        return { ok: false, detail: reason }
      }
    }
    return { ok: true, outcome }
  }

  private existingArtifactGuard(
    reqId: string,
    plan: TaskPlan,
    taskId: string,
    authorizationSource: string,
  ): { ok: true } | { ok: false; detail: string } | null {
    const existing = this.deps.repo.taskArtifact(reqId, plan.planVersion, taskId)
    if (!existing) return null
    if (existing.authorizationSource === authorizationSource) return { ok: true }
    return {
      ok: false,
      detail: `任务 ${taskId} 的既有交付绑定的是 ${existing.authorizationSource || '未知授权'}，与当前批准不一致；需人工核对`,
    }
  }

  private advanceStopOutcome(
    reqId: string,
    signal: AbortSignal,
  ): { state: 'failed'; detail: string } | null {
    if (!signal.aborted) return null
    this.deps.repo.setStatus(
      reqId,
      'blocked',
      '收到停止请求：任务未交付，一次性工作副本会在下次执行时重建',
    )
    return {
      state: 'failed',
      detail: '收到停止请求：任务未交付，一次性工作副本会在下次执行时重建；可重新执行',
    }
  }

  private undeliveredOutcome(
    reqId: string,
    requestId: string,
    taskId: string,
    outcome: Awaited<DeliverOutcome>,
  ): { state: 'done' | 'failed'; detail: string } {
    // 中断/超时也计一轮失败：否则 autoAdvance 会无穷重试同一条 30 分钟上限的任务。
    if (outcome.interrupted) {
      this.deps.repo.recordFailureRound(reqId, {
        roundId: `interrupted-${requestId}-${taskId}`,
        stage: 'interrupted',
        summary: outcome.reason.slice(0, 200),
        occurredAt: this.deps.now(),
      })
    }
    this.deps.repo.setStatus(reqId, outcome.requirementStatus, outcome.reason)
    return {
      state: outcome.state === 'awaiting_user' ? 'done' : 'failed',
      detail: outcome.reason,
    }
  }

  private advanceInputs(reqId: string):
    | {
        ok: true
        requirement: Requirement
        plan: TaskPlan
        authorizationSource: string
        baseline: string
      }
    | { ok: false; detail: string } {
    const authorized = this.authorizedPlanOf(reqId)
    if (!authorized.ok) return authorized
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, detail: `未找到需求 ${reqId}` }
    const context = this.advanceContext(reqId, authorized.plan)
    if (!context.ok) return context
    return {
      ok: true,
      requirement,
      plan: authorized.plan,
      authorizationSource: context.authorizationSource,
      baseline: context.baseline,
    }
  }

  private authorizedPlanOf(
    reqId: string,
  ): { ok: true; plan: TaskPlan } | { ok: false; detail: string } {
    const authorized = this.deps.requireAuthorizedPlan(reqId)
    return authorized.ok
      ? { ok: true, plan: authorized.value.plan }
      : { ok: false, detail: authorized.result.message }
  }

  private advanceContext(
    reqId: string,
    plan: TaskPlan,
  ): { ok: true; authorizationSource: string; baseline: string } | { ok: false; detail: string } {
    const approval = this.deps.repo.planApproval(reqId, plan.planVersion)
    if (!approval) return { ok: false, detail: `需求 ${reqId} 缺少计划批准记录` }
    return {
      ok: true,
      authorizationSource: authorizationSourceOf(approval),
      baseline: headCommit(this.deps.config.projectPath),
    }
  }

  async executeAdvance(
    reqId: string,
    signal: AbortSignal,
    requestId: string,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const inputs = this.advanceInputs(reqId)
    if (!inputs.ok) return { state: 'failed', detail: inputs.detail }
    const { requirement, plan, authorizationSource, baseline } = inputs

    const budgetOutcome = this.advanceBudgetGuard(reqId, plan)
    if (budgetOutcome) return budgetOutcome
    this.deps.repo.setStatus(reqId, EXECUTING)

    // 任务包冻结：测试阻断时把问题交回同一任务包的执行角色修复，然后重新验证；
    // 修复额度由失败轮次控制，用尽后停在 blocked，不再自动循环。
    for (;;) {
      for (const taskId of executionOrder(plan)) {
        const stopped = this.advanceStopOutcome(reqId, signal)
        if (stopped) return stopped
        const existing = this.existingArtifactGuard(reqId, plan, taskId, authorizationSource)
        if (existing && !existing.ok) {
          return { state: 'failed', detail: existing.detail }
        }
        if (existing?.ok) continue
        const delivered = await this.deliverTaskSafely({
          reqId,
          requirement,
          plan,
          taskId,
          baseline,
          authorizationSource,
          signal,
          requestId,
        })
        if (!delivered.ok) return { state: 'failed', detail: delivered.detail }
        const outcome = delivered.outcome
        if (outcome.state !== 'delivered') {
          return this.undeliveredOutcome(reqId, requestId, taskId, outcome)
        }
      }
      const artifacts = this.deps.repo.taskArtifacts(reqId, plan.planVersion)
      const verification = await this.deps.verificationPipeline.executeVerification(reqId, signal)
      if (verification.state === 'repair') continue
      if (verification.state !== 'done') {
        return { state: 'failed', detail: verification.detail }
      }
      return {
        state: 'done',
        detail: `任务包 v${plan.planVersion} 的 ${artifacts.length} 个任务已交付，${verification.detail}`,
      }
    }
  }
}
