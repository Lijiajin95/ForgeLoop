import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForgeLoopConfig } from '../config.js'
import { candidatesDir, devWorkspaceDir, integrationDir, verificationDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import type { PlannedTask, TaskPlan } from '../domain/task-plan.js'
import { authorizationSourceOf, executionOrder } from '../domain/task-plan.js'
import {
  COMMITTED,
  DEVELOPING,
  EXECUTING,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  VERIFYING,
  isTerminal,
  type TaskRunState,
} from '../domain/status.js'
import { ExecutionBudget } from '../domain/limits.js'
import { FAILURE_PLANNING, FAILURE_VERIFICATION } from '../domain/counting.js'
import { RuleViolationError, errorMessage } from '../domain/errors.js'
import type { Repository } from '../records/repository.js'
import type { IssueStore } from '../records/issues.js'
import type { AgentOpenRequest, AgentSession } from './agent-runner.js'
import type { ExecutionDev } from './execution-dev.js'
import type { VerificationPipeline } from './verification-pipeline.js'
import type { LegacyVerification } from './legacy-verification.js'
import type { OperationResult } from './operation-result.js'
import { requirementTitle } from './board.js'
import { AGENT_DEV } from '../domain/agents.js'
import { PLUGIN_VERSION } from './version.js'
import { sha256OfText } from '../domain/delivery.js'
import { exportCandidate, integrateCandidate, type CandidateFile } from './integration.js'
import { git, headCommit, runCommand } from './workspace.js'
import type { LegacyVerifyInput } from './legacy-verification.js'
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
  openAgent: (request: AgentOpenRequest) => Promise<AgentSession>
  currentAdmission: (reqId: string) => ReturnType<Repository['latestAdmission']>
  requireAuthorizedPlan: (
    reqId: string,
  ) => { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult }
  remainingFailureRounds: (reqId: string) => number
}

const VERIFICATION_ATTEMPTS_PER_REQUEST = 3

export class AdvancePipeline {
  constructor(private readonly deps: AdvancePipelineDeps) {}

  injectCandidateFault(reqId: string, planVersion: number, workspace: string): void {
    const raw = process.env.FORGELOOP_FAULT_INJECT?.trim()
    if (!raw) return
    const dir = candidatesDir(this.deps.config, reqId, planVersion)
    const marker = join(dir, 'fault-injection.json')
    if (existsSync(marker)) return
    const spec = JSON.parse(raw) as {
      file?: unknown
      append?: unknown
      replaceFrom?: unknown
      replaceTo?: unknown
    }
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
   * 验证 Agent 在同一会话里完成独立验证与业务验收：先设计并执行验证，再依据
   * 实际命令输出核对业务场景；不修改候选，不降低需求标准。
   */
  private async verifyCandidate(input: LegacyVerifyInput): Promise<{
    state: 'pass' | 'block'
    detail: string
    blocking: string[]
    verification: VerificationRecord | null
  }> {
    return this.deps.legacyVerification.verifyCandidate(input)
  }

  async commitCandidate(input: {
    reqId: string
    plan: TaskPlan
    candidate: CandidateFile
    requirementTitle: string
  }): Promise<{ ok: true; commitSha: string } | { ok: false; detail: string }> {
    if (!this.deps.config.autonomy.allowCodeCommit) {
      return { ok: false, detail: '系统授权不允许代码提交；等待所有者授权' }
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
   * 把一次验证阻断固化为内建问题单：绑定需求、验证报告与候选，
   * 并保存实际执行的命令日志、运行环境与状态，供研发复现和后续反查。
   */
  recordVerificationIssue(input: {
    reqId: string
    requirement: Requirement
    plan: TaskPlan
    candidate: CandidateFile
    verification: VerificationRecord
    blocking: readonly string[]
  }): RequirementIssue {
    const attempt = nextIssueAttempt(this.deps.issues.issuesFor(input.reqId))
    const now = this.deps.now()
    const blocking =
      input.blocking.length > 0
        ? [...input.blocking]
        : ['独立验证判定为阻断，但验证报告没有给出具体阻断项']
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
      devWorkspace: devWorkspaceDir(this.deps.config, input.reqId),
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
      summary: `独立验证阻断（attempt ${attempt}）：${blocking.join('；')}`.slice(0, 1000),
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

  /** 从验证报告提取实际执行过的命令；报告畸形时保留空清单，报告路径仍作为证据。 */
  private issueCommands(reportJson: string): IssueCommandEvidence[] {
    let data: unknown
    try {
      data = JSON.parse(reportJson)
    } catch {
      return []
    }
    if (typeof data !== 'object' || data === null) return []
    const commands = (data as { commands?: unknown }).commands
    if (!Array.isArray(commands)) return []
    const collected: IssueCommandEvidence[] = []
    for (const raw of commands) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const label = typeof item.label === 'string' ? item.label : ''
      if (!label) continue
      collected.push({
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
      })
    }
    return collected
  }

  /** 验证阻断后的定向修复：同一研发会话与工作区，只处理缺陷，不重建全部任务。 */
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
    const prompt = `你是 ForgeLoop 的研发 Agent。验证 Agent 在候选 ${input.candidate.candidateSha256.slice(0, 16)}… 上发现缺陷。
当前工作区就是候选的工作现场，已有成果必须保留；只修复下面列出的缺陷，不要重做全部任务，不要修改需求或验收标准，不要改版本号。

需求：${requirementTitle(input.requirement)}

缺陷与阻断证据：
${input.blocking.map((item) => `- ${item}`).join('\n') || '- 验证 Agent 未给出具体阻断项'}

请在同一工作区定位并修复，完成后用简短文本说明改了什么、如何验证。不要执行 git commit/push，程序会采集并固定新候选。`
    for (let attempt = 1; attempt <= this.deps.config.maxTaskAttempts; attempt += 1) {
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
   * 连续研发：系统准入后由同一个推进请求完成方案、实现、自验、独立验证、
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
    if (budget.limitSeconds <= budget.consumedSeconds) {
      this.deps.repo.setStatus(reqId, 'blocked', '执行工时已用尽；需要显式延长或拆分需求')
      return { ok: false, outcome: { state: 'failed', detail: '执行工时已用尽' } }
    }
    return { ok: true, requirement, analysis, admission }
  }

  private async ensureContinuousPlan(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    workspace: string
    authorizationSource: string
    signal: AbortSignal
  }): Promise<
    { ok: true; plan: TaskPlan } | { ok: false; outcome: { state: 'failed'; detail: string } }
  > {
    const { reqId, requirement, analysis, workspace, authorizationSource, signal } = input
    const existing = this.deps.repo.latestTaskPlan(reqId)
    if (existing && existing.requirementVersion === requirement.versions.length) {
      return { ok: true, plan: existing }
    }
    const planned = await this.deps.executionDev.planInSession({
      reqId,
      requirement,
      analysis,
      workspace,
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
    plan: TaskPlan
    workspace: string
    session: AgentSession
    authorizationSource: string
    signal: AbortSignal
  }): Promise<{ ok: true } | { ok: false; detail: string }> {
    const { reqId, requirement, plan, workspace, session, authorizationSource, signal } = input
    for (const taskId of executionOrder(plan)) {
      const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
      if (!task) continue
      if (this.deps.repo.taskArtifact(reqId, plan.planVersion, taskId)) continue
      const outcome = await this.deps.executionDev.developTaskInSession({
        reqId,
        requirement,
        plan,
        task,
        workspace,
        session,
        authorizationSource,
        signal,
      })
      if (outcome.state !== 'delivered') {
        this.deps.repo.setStatus(reqId, 'blocked', outcome.reason)
        return { ok: false, detail: outcome.reason }
      }
    }
    return { ok: true }
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

  private async verifyContinuousCandidate(input: {
    reqId: string
    requirement: Requirement
    analysis: RequirementAnalysis
    plan: TaskPlan
    candidate: ReturnType<AdvancePipeline['finalizeCandidate']>
    workspace: string
    workspaceInfo: ReturnType<ExecutionDev['ensureDevWorkspace']>
    session: AgentSession
    signal: AbortSignal
  }): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const { reqId, requirement, analysis, plan, workspace, workspaceInfo, session, signal } = input
    let candidate = input.candidate
    for (let round = 1; ; round += 1) {
      this.deps.repo.setStatus(
        reqId,
        VERIFYING,
        `验证 Agent 正在验证候选 v${candidate.candidateVersion}`,
      )
      const verification = await this.verifyCandidate({
        reqId,
        requirement,
        analysis,
        plan,
        candidate,
        devWorkspace: workspace,
        signal,
      })
      if (verification.verification === null && verification.state === 'block') {
        // 无法建立验证材料也是真实的失败尝试；计入失败轮次，避免协调器原地重排。
        this.deps.repo.recordFailureRound(reqId, {
          roundId: `verification-prep-${randomUUID()}`,
          stage: FAILURE_VERIFICATION,
          summary: verification.detail.slice(0, 1000),
          occurredAt: this.deps.now(),
        })
        this.deps.repo.setStatus(reqId, 'blocked', verification.detail)
        return { state: 'failed', detail: verification.detail }
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
          this.deps.repo.setStatus(reqId, 'blocked', `受控提交未完成：${commit.detail}`)
          return { state: 'failed', detail: `受控提交未完成：${commit.detail}` }
        }
        this.deps.repo.setStatus(reqId, COMMITTED, `已提交 ${commit.commitSha.slice(0, 12)}`)
        return {
          state: 'done',
          detail: `需求 ${reqId} 已完成研发、独立验证与提交：${commit.commitSha.slice(0, 12)}`,
        }
      }
      const recorded = verification.verification
      if (recorded && recorded.verdict === 'block') {
        // 验证执行后判定失败：建内建问题单并定向修复；跨请求重试没有轮次上限。
        const issue = this.recordVerificationIssue({
          reqId,
          requirement,
          plan,
          candidate,
          verification: recorded,
          blocking: verification.blocking,
        })
        if (round >= VERIFICATION_ATTEMPTS_PER_REQUEST) {
          const blocking = verification.blocking.join('；') || verification.detail
          this.deps.repo.setStatus(
            reqId,
            'blocked',
            `验证未通过，已创建问题单 ${issue.issueId}（attempt ${issue.attempt}）：${blocking}；问题单已加入研发队列，将自动重新验证`,
          )
          return {
            state: 'failed',
            detail: `验证未通过：${blocking}；问题单 ${issue.issueId}（attempt ${issue.attempt}）已加入研发队列`,
          }
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
          this.deps.repo.setStatus(
            reqId,
            'blocked',
            `定向修复未完成：${repaired.reason}；问题单 ${issue.issueId} 保留在研发队列`,
          )
          return { state: 'failed', detail: `定向修复未完成：${repaired.reason}` }
        }
        this.deps.issues.updateStatus(issue.issueId, ISSUE_FIXED, this.deps.now())
        candidate = this.finalizeCandidate({
          reqId,
          plan,
          workspace,
          baselineCommit: workspaceInfo.baselineCommit,
          snapshotCommit: workspaceInfo.snapshotCommit,
        })
        continue
      }
      // 业务验收阻断（独立验证本身已通过）仍受失败额度约束。
      if (this.deps.remainingFailureRounds(reqId) === 0) {
        this.deps.repo.setStatus(
          reqId,
          'blocked',
          `验证未通过且失败额度已用尽：${verification.blocking.join('；') || verification.detail}`,
        )
        return { state: 'failed', detail: `验证未通过且失败额度已用尽：${verification.detail}` }
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

  async executeContinuousAdvance(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const inputs = this.continuousInputs(reqId)
    if (!inputs.ok) return inputs.outcome
    const { requirement, analysis, admission } = inputs
    const authorizationSource = `system-admission:${admission.admissionId}`
    const workspaceInfo = this.deps.executionDev.ensureDevWorkspace(
      reqId,
      requirement.versions.length,
    )
    const workspace = workspaceInfo.workspace
    const planned = await this.ensureContinuousPlan({
      reqId,
      requirement,
      analysis,
      workspace,
      authorizationSource,
      signal,
    })
    if (!planned.ok) return planned.outcome
    const plan = planned.plan
    const session = await this.deps.openAgent({
      role: AGENT_DEV,
      cwd: workspace,
      permission: 'workspace-write',
      tools: 'default',
    })
    try {
      this.deps.repo.ensureBudget(
        reqId,
        plan.tasks.reduce((sum, task) => sum + task.limits.limitSeconds, 0),
      )
      this.deps.repo.setStatus(reqId, DEVELOPING, '研发 Agent 在同一工作区实现并自验')
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
        plan,
        workspace,
        session,
        authorizationSource,
        signal,
      })
      if (!developed.ok) return { state: 'failed', detail: developed.detail }
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
      return await this.verifyContinuousCandidate({
        reqId,
        requirement,
        analysis,
        plan,
        candidate,
        workspace,
        workspaceInfo,
        session,
        signal,
      })
    } finally {
      await session.close()
    }
  }

  private advanceBudgetGuard(
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

  async executeAdvance(
    reqId: string,
    signal: AbortSignal,
    requestId: string,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const authorized = this.deps.requireAuthorizedPlan(reqId)
    if (!authorized.ok) return { state: 'failed', detail: authorized.result.message }
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const plan = authorized.value.plan
    const approval = this.deps.repo.planApproval(reqId, plan.planVersion)!
    const authorizationSource = authorizationSourceOf(approval)
    const baseline = headCommit(this.deps.config.projectPath)

    const budgetOutcome = this.advanceBudgetGuard(reqId, plan)
    if (budgetOutcome) return budgetOutcome
    this.deps.repo.setStatus(reqId, EXECUTING)

    // 任务包冻结：验证阻断时把问题交回同一任务包的执行角色修复，然后重新验证；
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
