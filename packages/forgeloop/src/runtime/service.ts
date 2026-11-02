/**
 * ForgeLoop 业务运行时：把领域规则、权威记录与 DSH Agent 执行接在一起。
 * 命令与工具都是本类的薄包装；这里不依赖任何交互界面。
 */

import { asRecord } from '../domain/json.js'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import {
  evidenceDir,
  planReviewDir,
  projectDir,
  recordsPath,
  sessionsDir,
  workspaceDir,
} from '../config.js'
import { Database } from '../records/db.js'
import { Repository, type ServiceRequestRecord } from '../records/repository.js'
import { RuleViolationError, errorMessage } from '../domain/errors.js'
import { type Requirement, type RequirementAnalysis } from '../domain/requirement.js'
import {
  authorizationSourceOf,
  authorizePlan,
  bindAuthorization,
  executionOrder,
  validateTaskPlan,
  type PlannedTask,
  type TaskPlan,
} from '../domain/task-plan.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import { candidateIdentityOf, sha256OfText } from '../domain/delivery.js'
import { formatCommitMessage } from '../domain/commit-message.js'
import { retryDecision } from '../domain/retry-policy.js'
import {
  ACCEPTED,
  ACTION_VERIFY,
  APPROVED,
  AWAITING_CLARIFICATION,
  CANCELLED,
  DEVELOPING,
  EXECUTING,
  SPECIFIED,
  VERIFYING,
  isTerminal,
} from '../domain/status.js'
import { AGENT_PRODUCT, AGENT_VERIFY } from '../domain/agents.js'
import { decideAdmission, type AdmissionDecision } from '../domain/admission.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'
import { languageViolations, outsideActiveSource, unknownPackages } from '../domain/language.js'
import { requirementEvidence } from '../domain/requirement-evidence.js'
import { parsePlanReview, validatePlanCoverage, type PlanReview } from '../domain/verification.js'
import type { TaskRun } from '../domain/work.js'
import { buildImpactFacts, type ImpactRequest } from '../domain/impact.js'
import {
  explainImpactFacts,
  type ImpactExplainAgent,
  type ImpactExplainAgentResponse,
} from '../domain/impact-explain.js'
import { RequirementQueue } from '../domain/requirement-queue.js'
import { SqliteRequirementQueueStore } from '../records/requirement-queue.js'
import { IssueStore } from '../records/issues.js'
import { AgentRunner, type AgentOpenRequest, type AgentSession } from './agent-runner.js'
import { OpsRuntime } from './ops.js'
import { buildStatusBoard, requirementTitle, type StatusBoardView } from './board.js'
import { runFormalTest } from './formal-test.js'
import { planReviewPrompt, requirementContext } from './prompts.js'
import { runCommand } from './workspace.js'
import { requestSource } from './execution-views.js'
import { LegacyVerification } from './legacy-verification.js'
import { TaskDelivery, type DeliverInput, type DeliverOutcome } from './task-delivery.js'
import { TaskViews } from './task-views.js'
import { VerificationPipeline } from './verification-pipeline.js'
import { CandidatePipeline } from './candidate-pipeline.js'
import { ExecutionPlan } from './execution-plan.js'
import { ExecutionDev } from './execution-dev.js'
import { AdvancePipeline } from './advance-pipeline.js'
import { fail, ok, type OperationResult } from './operation-result.js'
import { buildRequirementView, deliveryProgress } from './requirement-views.js'
import { BuildMaterialValidator } from './build-materials.js'

/**
 * 单个推进请求内最多尝试的验证次数。验证失败会建问题单并定向修复；
 * 达到上限后请求收口为 blocked，由协调器依据未收口问题单自动排队下一次修复与验证。
 * 跨请求的重试没有轮次上限，attempt 与验证历史持续累积。
 */
export interface AgentLike {
  run(request: Parameters<AgentRunner['run']>[0]): ReturnType<AgentRunner['run']>
  open?(request: AgentOpenRequest): Promise<AgentSession>
}

export interface RuntimeOptions {
  readonly ctx: Record<string, unknown>
  readonly config: ForgeLoopConfig
  readonly now?: () => Date
  /** 测试注入：真实插件使用 AgentRunner；用例可替换为确定性假执行器。 */
  readonly runner?: AgentLike
  readonly formalTest?: typeof runFormalTest
}

import { planReviewBlocking } from './service-helpers.js'

import { AnalysisQueue, analysisModeOf } from './analysis-queue.js'

export class ForgeLoopRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly runner: AgentLike
  readonly ops: OpsRuntime
  /** 需求队列：只在研发空闲时领取队首需求，同一时间最多一个在研。 */
  readonly requirementQueue: RequirementQueue
  readonly analysisQueue: AnalysisQueue
  /** 验证失败自动创建的内建问题单；按需求累积 attempt 与证据。 */
  readonly issues: IssueStore
  private readonly advancePipeline: AdvancePipeline
  private readonly executionDev: ExecutionDev
  private readonly executionPlan: ExecutionPlan
  private readonly candidatePipeline: CandidatePipeline
  private readonly verificationPipeline: VerificationPipeline
  private readonly taskViews: TaskViews
  private readonly taskDelivery: TaskDelivery
  private readonly legacyVerification: LegacyVerification
  private readonly buildMaterials: BuildMaterialValidator
  private readonly formalTest: typeof runFormalTest
  private readonly ctx: Record<string, unknown>
  private readonly clock: () => Date

  constructor(options: RuntimeOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.clock = options.now ?? (() => new Date())
    this.repo = new Repository(Database.open(recordsPath(this.config)))
    this.requirementQueue = new RequirementQueue(
      new SqliteRequirementQueueStore(this.repo.db),
      () => this.clock(),
    )
    this.analysisQueue = new AnalysisQueue({
      config: this.config,
      repo: this.repo,
      queue: this.requirementQueue,
      now: () => this.now(),
      requestOperation: (input) => this.requestOperation(input),
      intakeQueuedRequirement: () => this.intakeQueuedRequirement(),
    })
    this.issues = new IssueStore(this.repo.db)
    this.runner = options.runner ?? new AgentRunner({ ctx: options.ctx, agent: this.config.agent })
    this.ops = new OpsRuntime({
      config: this.config,
      repo: this.repo,
      runner: this.runner,
      now: () => this.clock(),
    })
    this.formalTest = options.formalTest ?? runFormalTest
    this.buildMaterials = new BuildMaterialValidator(this.config.projectPath)
    this.executionDev = new ExecutionDev({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      recordRun: (reqId, plan, task, outcome) => {
        this.recordRun(reqId, plan, task, outcome)
      },
      runner: this.runner,
      previousTaskFailure: (reqId, planVersion, taskId) =>
        this.previousTaskFailure(reqId, planVersion, taskId),
      formalTest: this.formalTest,
      existingPackages: () => this.existingPackages(),
      ctx: this.ctx,
      authorizedPlan: (plan, source) => this.authorizedPlan(plan, source),
      applyDiffFile: (dir, diffPath, label, suffix) =>
        this.applyDiffFile(dir, diffPath, label, suffix),
    })
    this.verificationPipeline = new VerificationPipeline({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      charge: (reqId, started) => {
        this.charge(reqId, started)
      },
      runner: this.runner,
      formalTest: this.formalTest,
      ctx: this.ctx,
      openAgent: (request) => this.openAgent(request),
      candidateIdentity: (plan, artifacts) => this.candidateIdentity(plan, artifacts),
      requireAuthorizedPlan: (reqId) => this.requireAuthorizedPlan(reqId),
      applyDiffFile: (dir, diffPath, label, suffix) =>
        this.applyDiffFile(dir, diffPath, label, suffix),
      reopenDeliveredTasks: (input) => this.reopenDeliveredTasks(input),
      verificationBaseline: (analysis) => this.verificationBaseline(analysis),
      remainingFailureRounds: (reqId) => this.remainingFailureRounds(reqId),
    })
    this.taskViews = new TaskViews({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      remainingFailureRounds: (reqId) => this.remainingFailureRounds(reqId),
      retryEligibility: (reqId, planVersion, taskId) =>
        this.retryEligibility(reqId, planVersion, taskId),
    })
    this.taskDelivery = new TaskDelivery({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      charge: (reqId, started) => {
        this.charge(reqId, started)
      },
      runner: this.runner,
      formalTest: this.formalTest,
      ctx: this.ctx,
      recordRun: (reqId, plan, task, outcome) => {
        this.recordRun(reqId, plan, task, outcome)
      },
      previousTaskFailure: (reqId, planVersion, taskId) =>
        this.previousTaskFailure(reqId, planVersion, taskId),
      applyDiffFile: (dir, diffPath, label, suffix) =>
        this.applyDiffFile(dir, diffPath, label, suffix),
    })
    this.legacyVerification = new LegacyVerification({
      config: this.config,
      repo: this.repo,
      ctx: this.ctx,
      now: () => this.now(),
      charge: (reqId, started) => {
        this.charge(reqId, started)
      },
      formalTest: this.formalTest,
      openAgent: (request) => this.openAgent(request),
      runner: (request) => this.runner.run(request),
    })
    this.advancePipeline = new AdvancePipeline({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      issues: this.issues,
      executionDev: this.executionDev,
      recordRun: (reqId, plan, task, outcome) => {
        this.recordRun(reqId, plan, task, outcome)
      },
      verificationPipeline: this.verificationPipeline,
      legacyVerification: this.legacyVerification,
      deliverTask: (input) => this.deliverTask(input),
      openAgent: (request) => this.openAgent(request),
      currentAdmission: (reqId) => this.currentAdmission(reqId),
      requireAuthorizedPlan: (reqId) => this.requireAuthorizedPlan(reqId),
      remainingFailureRounds: (reqId) => this.remainingFailureRounds(reqId),
    })
    this.executionPlan = new ExecutionPlan({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      charge: (reqId, started) => {
        this.charge(reqId, started)
      },
      runner: this.runner,
      existingPackages: () => this.existingPackages(),
      reviewPlan: (requirement, analysis, plan, signal) =>
        this.reviewPlan(requirement, analysis, plan, signal),
      admitRequirement: (reqId) => this.admitRequirement(reqId),
    })
    this.candidatePipeline = new CandidatePipeline({
      config: this.config,
      repo: this.repo,
      now: () => this.now(),
      validateBuildMaterials: (input) => this.buildMaterials.validateBuildMaterials(input),
      requireAuthorizedPlan: (reqId) => this.requireAuthorizedPlan(reqId),
      currentAdmission: (reqId) => this.currentAdmission(reqId),
      candidateIdentity: (plan, artifacts) => this.candidateIdentity(plan, artifacts),
      statusBoard: (limit, query) => this.statusBoard(limit, query),
    })
  }

  close(): void {
    this.repo.close()
  }

  private now(): string {
    return this.clock().toISOString()
  }

  // 需求队列

  /**
   * 研发空闲时领取队首需求并排入分析；研发忙、已有在研需求或队列为空时返回 null。
   * 入队本身立即返回，只有协调器在确认没有未收口请求后才让需求真正进入研发。
   */
  intakeQueuedRequirement(): string | null {
    const claimed = this.requirementQueue.inFlight()
    if (claimed) {
      const requirement = this.repo.getRequirement(claimed.requirementId)
      if (!requirement || !this.queueSlotActive(requirement)) {
        this.completeQueueEntry(claimed.requirementId)
      }
    }
    if (this.requirementQueue.inFlight()) return null
    // 有未收口请求时不算空闲，避免新需求与在途分析/研发并发启动。
    // 已是终态需求遗留的请求无法再执行，不占用研发位。
    const busy = this.repo.activeRequests(this.config.project).some((request) => {
      const requirement = this.repo.getRequirement(request.reqId)
      return requirement !== null && !isTerminal(requirement.status)
    })
    if (busy) return null
    for (;;) {
      const entry = this.requirementQueue.claimNext()
      if (!entry) return null
      const requirement = this.repo.getRequirement(entry.requirementId)
      if (!requirement || isTerminal(requirement.status)) {
        this.completeQueueEntry(entry.requirementId)
        continue
      }
      if (!this.startQueuedRequirement(requirement)) {
        this.completeQueueEntry(entry.requirementId)
        continue
      }
      return requirement.reqId
    }
  }

  /** 队列占用是否仍对应研发位：有在途请求、未收口问题单或需求仍处于自动研发链路时为真。 */
  private queueSlotActive(requirement: Requirement): boolean {
    if (isTerminal(requirement.status)) return false
    const active = this.repo
      .activeRequests(this.config.project)
      .some((request) => request.reqId === requirement.reqId)
    if (active) return true
    // 验证失败待修复/待复验的需求仍占用研发位，避免其它需求插队。
    if (this.issues.latestOpen(requirement.reqId)) return true
    // 没有自动推进时，分析收口即让出研发位；后续执行仍可由显式请求驱动。
    if (!this.config.autoAdvance) return false
    if (requirement.status === SPECIFIED) return this.currentAdmission(requirement.reqId) !== null
    return [DEVELOPING, VERIFYING, APPROVED, EXECUTING].includes(requirement.status)
  }

  /** 让领取到的需求进入分析；当前版本已有分析时不重复调用分析 Agent。 */
  private startQueuedRequirement(requirement: Requirement): boolean {
    const analysis = this.repo.latestAnalysis(requirement.reqId)
    if (analysis && analysis.requirementVersion === requirement.versions.length) return true
    const queued = this.requestOperation({
      reqId: requirement.reqId,
      action: 'analyze',
      by: 'system:intake',
      source: 'system:intake',
    })
    return queued.ok
  }

  private completeQueueEntry(requirementId: string): void {
    try {
      this.requirementQueue.complete(requirementId)
    } catch {
      // 已完成或被并发收口：队列状态以记录为准，不重复报错。
    }
  }

  // 受理与修订

  submit(input: {
    text: string
    by: string
    source: string
    clientKey?: string
    /** 是否把首次分析排进队列；业务会话先同步分析一次，因此传 false。 */
    analyze?: boolean
  }): OperationResult {
    const text = input.text.trim()
    if (!text) return fail('empty_text', '需求原文不能为空')
    const reqId = `req-${this.now()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14)}-${randomUUID().slice(0, 6)}`
    const { requirement, created } = this.repo.submit({
      reqId,
      project: this.config.project,
      text,
      submittedBy: input.by,
      source: input.source,
      clientKey: input.clientKey ?? '',
      now: this.now(),
    })
    // 首次分析只入队一次；已有分析则不再调用模型。
    const handoff = this.analysisQueue.accepted(requirement, {
      created,
      source: input.source,
      analyze: input.analyze ?? true,
    })
    return ok(
      created
        ? `已受理需求 ${requirement.reqId}（版本 1）${handoff}`
        : `同一客户端幂等键已受理为需求 ${requirement.reqId}，未重复创建`,
      this.requirementView(requirement),
    )
  }

  /**
   * 读取一个业务会话关联的待澄清需求。会话关系来自需求受理 source：
   * `dsh-session:<sessionId>:<messageId>`；只返回当前需求版本已有待澄清分析的需求。
   */
  pendingClarifications(sessionId: string): Array<{
    reqId: string
    title: string
    requirementVersion: number
    analysisVersion: number
    questions: readonly string[]
    updatedAt: string
  }> {
    const prefix = `dsh-session:${sessionId}:`
    const result: Array<{
      reqId: string
      title: string
      requirementVersion: number
      analysisVersion: number
      questions: readonly string[]
      updatedAt: string
    }> = []
    for (const requirement of this.repo.listRequirements(this.config.project)) {
      if (!requirement.source.startsWith(prefix)) continue
      if (requirement.status !== AWAITING_CLARIFICATION) continue
      const analysis = this.repo.latestAnalysis(requirement.reqId)
      if (!analysis) continue
      if (analysis.requirementVersion !== requirement.versions.length) continue
      if (analysis.clarifications.length === 0) continue
      const latest = requirement.versions[requirement.versions.length - 1]
      result.push({
        reqId: requirement.reqId,
        title: requirementTitle(requirement),
        requirementVersion: requirement.versions.length,
        analysisVersion: analysis.analysisVersion,
        questions: analysis.clarifications,
        updatedAt: latest?.createdAt ?? '',
      })
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * 回答一个待澄清需求：追加需求版本（保留原文与历史），再让产品 Agent 重新分析。
   * 只有会话输入接管或未来可信入口调用；模型工具不能调用。
   */
  async answerClarifications(input: {
    reqId: string
    answer: string
    by: string
    source: string
    signal?: AbortSignal | undefined
  }): Promise<{
    ok: boolean
    code: string
    message: string
    reqId: string
    requirementVersion?: number | undefined
    analysis?: RequirementAnalysis | undefined
  }> {
    const answer = input.answer.trim()
    if (!answer)
      return { ok: false, code: 'empty_answer', message: '澄清回答不能为空', reqId: input.reqId }
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement)
      return {
        ok: false,
        code: 'not_found',
        message: `未找到需求 ${input.reqId}`,
        reqId: input.reqId,
      }
    if (requirement.status !== AWAITING_CLARIFICATION) {
      return {
        ok: false,
        code: 'no_clarification',
        message: `需求 ${input.reqId} 当前不在待澄清状态`,
        reqId: input.reqId,
      }
    }
    const analysis = this.repo.latestAnalysis(input.reqId)
    if (
      !analysis ||
      analysis.requirementVersion !== requirement.versions.length ||
      analysis.clarifications.length === 0
    ) {
      return {
        ok: false,
        code: 'no_clarification',
        message: `需求 ${input.reqId} 没有与当前版本对应的待澄清项`,
        reqId: input.reqId,
      }
    }
    const latest = requirement.versions[requirement.versions.length - 1]
    if (!latest)
      return {
        ok: false,
        code: 'not_found',
        message: `需求 ${input.reqId} 没有可修订版本`,
        reqId: input.reqId,
      }
    const text = `${latest.text}

澄清回答（针对分析 v${analysis.analysisVersion}）：
${answer}`
    const revised = this.revise({ reqId: input.reqId, text, by: input.by, source: input.source })
    if (!revised.ok) return { ...revised, reqId: input.reqId }
    const refreshed = this.repo.getRequirement(input.reqId)
    const next = await this.analyzeRequirement(input.reqId, input.signal)
    if (!next.ok) {
      return {
        ok: false,
        code: next.code,
        message: next.message,
        reqId: input.reqId,
        requirementVersion: refreshed?.versions.length,
      }
    }
    return {
      ok: true,
      code: 'ok',
      message: next.message,
      reqId: input.reqId,
      requirementVersion: refreshed?.versions.length,
      analysis: next.analysis,
    }
  }

  /**
   * 研发 Agent 的技术方案与任务拆解入口：产品 Agent 只产出分析结论，任务由研发 Agent
   * 依据分析全文（目标、场景、验收标准）拆解；校验任务包并落库。规划不等于批准或执行。
   */
  async planDevTasks(
    reqId: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    code: string
    message: string
    plan?: TaskPlan | undefined
    analysis?: RequirementAnalysis | undefined
  }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, code: 'not_found', message: `未找到需求 ${reqId}` }
    const analysis = this.repo.latestAnalysis(reqId) ?? undefined
    const outcome = await this.executionPlan.executeDevPlanning(
      reqId,
      signal ?? new AbortController().signal,
    )
    const plan = this.repo.latestTaskPlan(reqId)
    if (outcome.state !== 'done' || !plan) {
      return { ok: false, code: 'plan_failed', message: outcome.detail || '任务包未生成', analysis }
    }
    return {
      ok: true,
      code: 'ok',
      message: outcome.detail,
      plan,
      analysis,
    }
  }

  /** 一个业务会话已经受理并拆解的需求，用于会话末尾摘要。 */
  sessionSummary(sessionId: string) {
    return this.taskViews.sessionSummary(sessionId)
  }

  taskDetail(reqId: string, taskId: string, planVersion?: number) {
    return this.taskViews.taskDetail(reqId, taskId, planVersion)
  }

  taskExecution(input: {
    reqId: string
    taskId: string
    planVersion?: number | undefined
    offset?: number | undefined
    limit?: number | undefined
  }) {
    return this.taskViews.taskExecution(input)
  }

  async analyzeRequirement(
    reqId: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    code: string
    message: string
    requirement?: unknown
    analysis?: RequirementAnalysis
  }> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${reqId} 已处于终态 ${requirement.status}，不能再分析`)
    }
    const existing = this.repo.latestAnalysis(reqId)
    if (existing && existing.requirementVersion === requirement.versions.length) {
      return {
        ok: true,
        code: 'ok',
        message: `需求 ${reqId} 已有 v${existing.analysisVersion} 分析，未重复调用模型`,
        requirement: this.requirementView(requirement),
        analysis: existing,
      }
    }
    const outcome = await this.executionPlan.executeAnalysis(
      reqId,
      signal ?? new AbortController().signal,
    )
    const refreshed = this.repo.getRequirement(reqId)
    const analysis = this.repo.latestAnalysis(reqId)
    if (outcome.state !== 'done' || !analysis) {
      return {
        ...fail('analysis_failed', outcome.detail || '需求分析未完成'),
        requirement: refreshed ? this.requirementView(refreshed) : null,
      }
    }
    return {
      ok: true,
      code: 'ok',
      message: outcome.detail,
      requirement: refreshed ? this.requirementView(refreshed) : null,
      analysis,
    }
  }

  revise(input: { reqId: string; text: string; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能修订`)
    }
    const updated = this.repo.appendVersion({
      reqId: input.reqId,
      text: input.text,
      revisedBy: input.by,
      source: input.source,
      now: this.now(),
    })
    this.repo.dismissPendingFor(input.reqId, '需求修订：旧请求所依据的版本已过期', this.now())
    return ok(
      `已追加需求 ${input.reqId} 版本 ${updated.versions.length}；既有任务包与批准对该版本过期，需重新分析与规划`,
      this.requirementView(updated),
    )
  }

  cancel(input: { reqId: string; by: string; reason: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}`)
    }
    this.repo.dismissPendingFor(input.reqId, '需求已取消', this.now())
    this.repo.recordCancellation({
      reqId: input.reqId,
      cancelledBy: input.by,
      reason: input.reason,
      now: this.now(),
    })
    return ok(`已取消需求 ${input.reqId}；身份、版本、批准与交付记录保留`)
  }

  stop(input: { reqId: string; by: string; reason: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}`)
    }
    const now = this.now()
    this.repo.recordStop({
      requirementId: input.reqId,
      requestedBy: input.by,
      reason: input.reason || '未说明',
      requestedAt: now,
    })
    this.repo.dismissPendingFor(input.reqId, `停止请求（${input.by}）`, now)
    this.repo.setStatus(
      input.reqId,
      'blocked',
      `停止请求：${input.reason || '未说明'}（${input.by}）`,
    )
    this.settleStopIfQuiet(input.reqId)
    const settled = this.repo.stop(input.reqId)?.settledAt || ''
    return ok(`已请求停止需求 ${input.reqId}；待执行请求已撤销，在途 Agent 会被取消`, {
      settled: Boolean(settled),
      settledAt: settled,
    })
  }

  /** 没有在途请求/运行任务时，把停止请求收口为“实际停稳”；不自动恢复。 */
  settleStopIfQuiet(reqId: string): void {
    if (!this.repo.activeStop(reqId)) return
    if (
      this.repo.requestsFor(reqId).some((request) => ['pending', 'claimed'].includes(request.state))
    )
      return
    const plan = this.repo.latestTaskPlan(reqId)
    if (plan && this.repo.taskRuns(reqId, plan.planVersion).some((run) => run.state === 'running'))
      return
    this.repo.markStopSettled(reqId, this.now())
  }

  /** 排队一个持久操作请求：先落库，再返回受理身份。 */
  private resumeStoppedAdvance(input: {
    reqId: string
    action: 'analyze' | 'plan' | 'advance' | 'verify'
    by: string
    reason?: string
  }): void {
    if (input.action !== 'advance' || !this.repo.activeStop(input.reqId)) return
    this.repo.resumeStop({
      requirementId: input.reqId,
      resumedBy: input.by,
      reason: input.reason || '显式恢复执行',
      resumedAt: this.now(),
    })
  }

  private planChangeGuard(input: {
    reqId: string
    action: 'analyze' | 'plan' | 'advance' | 'verify'
    confirmPlanChange?: boolean
    reason?: string
  }): OperationResult | null {
    if (input.action !== 'plan') return null
    const latestPlan = this.repo.latestTaskPlan(input.reqId)
    const frozen = latestPlan ? this.repo.planApproval(input.reqId, latestPlan.planVersion) : null
    if (!frozen) return null
    if (input.confirmPlanChange !== true) {
      return fail(
        'plan_frozen',
        `需求 ${input.reqId} 的任务包 v${latestPlan?.planVersion ?? 0} 已批准并冻结；修改任务包需要所有者显式许可并说明原因`,
      )
    }
    if (!input.reason?.trim()) {
      return fail('reason_required', '修改已批准任务包必须说明原因，便于审计')
    }
    return null
  }

  private resolveAdvanceOperation(
    input: { reqId: string; action: 'analyze' | 'plan' | 'advance' | 'verify' },
    requirement: Requirement,
  ): { ok: true; planVersion: number } | { ok: false; result: OperationResult } {
    const latestPlan = this.repo.latestTaskPlan(input.reqId)
    const admission = this.currentAdmission(input.reqId)
    const legacyApproval = latestPlan
      ? this.repo.planApproval(input.reqId, latestPlan.planVersion)
      : null
    if (!admission && !legacyApproval) {
      return {
        ok: false,
        result: fail(
          'admission_required',
          `需求 ${input.reqId} 尚未获得系统准入或人类批准；不能自动进入研发`,
        ),
      }
    }
    if (latestPlan && latestPlan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        result: fail(
          'stale_requirement',
          `任务包 v${latestPlan.planVersion} 依据需求 v${latestPlan.requirementVersion}，当前是 ${requirement.versions.length}；需要重新生成任务包`,
        ),
      }
    }
    if (!latestPlan && input.action === ACTION_VERIFY) {
      return {
        ok: false,
        result: fail('plan_missing', `需求 ${input.reqId} 尚无任务包，不能开始验证`),
      }
    }
    if (this.remainingFailureRounds(input.reqId) === 0) {
      return {
        ok: false,
        result: fail(
          'grant_required',
          `需求 ${input.reqId} 的失败轮次额度已用尽；需要追加授权后才能继续${input.action === ACTION_VERIFY ? '验证' : '推进'}`,
        ),
      }
    }
    if (input.action === ACTION_VERIFY && latestPlan) {
      const missing = this.missingDeliveryTasks(input.reqId, latestPlan)
      if (missing.length > 0) {
        return {
          ok: false,
          result: fail('not_delivered', `仍有任务未交付，不能开始独立验证：${missing.join('、')}`),
        }
      }
    }
    return { ok: true, planVersion: latestPlan?.planVersion ?? 0 }
  }

  private missingDeliveryTasks(reqId: string, plan: TaskPlan): string[] {
    const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
    return plan.tasks
      .filter((task) => !artifacts.some((artifact) => artifact.taskId === task.taskId))
      .map((task) => task.taskId)
  }

  requestOperation(input: {
    reqId: string
    action: 'analyze' | 'plan' | 'advance' | 'verify'
    by: string
    source: string
    /** 已批准任务包默认冻结；只有所有者显式许可并说明原因才能重新生成。 */
    confirmPlanChange?: boolean
    reason?: string
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status)) {
      return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}，不能再排队`)
    }
    // 主动停止只能由显式恢复动作解除；自动扫描永远不会走到这里。
    this.resumeStoppedAdvance(input)
    const frozen = this.planChangeGuard(input)
    if (frozen) return frozen
    let planVersion = 0
    if (input.action === 'advance' || input.action === ACTION_VERIFY) {
      const resolved = this.resolveAdvanceOperation(input, requirement)
      if (!resolved.ok) return resolved.result
      planVersion = resolved.planVersion
    } else if (input.action === 'plan' && this.repo.latestAnalysis(input.reqId) === null) {
      return fail('analysis_missing', `需求 ${input.reqId} 尚无分析结论`)
    }
    try {
      const source = requestSource(input)
      const { request, created } = this.repo.recordRequest({
        requestId: `rq-${randomUUID()}`,
        reqId: input.reqId,
        project: this.config.project,
        planVersion,
        action: input.action,
        requestedBy: input.by,
        source,
        now: this.now(),
      })
      return ok(
        created
          ? `已受理${input.action}请求 ${request.requestId}（需求 ${input.reqId}）；宿主会持久推进`
          : `需求 ${input.reqId} 已有待执行的 ${request.action} 请求 ${request.requestId}，未重复排队`,
        requestView(request),
      )
    } catch (error) {
      const code = error instanceof RuleViolationError ? error.code : 'rule_violation'
      return fail(code, errorMessage(error))
    }
  }

  // ------------------------------------------------------------ 决定

  /**
   * 任务重试：只重新排队一次 advance，不新建任务包、不清零失败轮次。
   * 结果未知的请求必须在明确确认后再核对关闭，避免把中断当成可直接重放。
   */
  retryTask(input: {
    reqId: string
    planVersion: number
    taskId: string
    by: string
    source: string
  }): OperationResult {
    const eligibility = this.retryEligibility(input.reqId, input.planVersion, input.taskId)
    if (!eligibility.ok) return fail(eligibility.code, eligibility.message)
    const queued = this.requestOperation({
      reqId: input.reqId,
      action: 'advance',
      by: input.by,
      source: `${input.source}:retry:${input.taskId}`,
    })
    if (!queued.ok) return queued
    return ok(`已受理任务 ${input.taskId} 的重试：${queued.message}`, {
      ...(asRecord(queued.data) ?? {}),
      taskId: input.taskId,
    })
  }

  /**
   * 需求级重新执行：失败停在 blocked 后，不再要求人工逐个任务重试。
   * 与 retryTask 共用同一份判定（额度、在途请求、批准、终态），
   * 只排队一次 advance；不新建任务包、不清零失败轮次。
   */
  requeue(input: { reqId: string; by: string; source: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const decision = this.retryDecisionFor(input.reqId)
    if (!decision.allowed) return fail('retry_not_allowed', decision.reason)
    const queued = this.requestOperation({
      reqId: input.reqId,
      action: 'advance',
      by: input.by,
      source: `${input.source}:requeue`,
    })
    if (!queued.ok) return queued
    return ok(`已重新排队执行需求 ${input.reqId}：${queued.message}`, queued.data)
  }

  /** 需求级“是否还能再来一次”的只读判定；看板与 requeue 共用。 */
  retryDecisionFor(reqId: string): { allowed: boolean; reason: string } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { allowed: false, reason: `未找到需求 ${reqId}` }
    if (this.repo.activeStop(reqId)) {
      return { allowed: false, reason: '需求已被主动停止；恢复需要显式决定' }
    }
    const plan = this.repo.latestTaskPlan(reqId)
    const requests = this.repo.requestsFor(reqId)
    const runs = plan ? this.repo.taskRuns(reqId, plan.planVersion) : []
    const delivered = plan ? this.repo.taskArtifacts(reqId, plan.planVersion).length : 0
    return retryDecision({
      status: requirement.status,
      blockedReason: requirement.blockedReason,
      remainingRounds: this.remainingFailureRounds(reqId),
      activeRequest: requests.some(
        (request) => request.state === 'pending' || request.state === 'claimed',
      ),
      runningTasks: runs.filter((run) => run.state === TASK_RUN_RUNNING).length,
      awaitingInputTasks: runs.filter((run) => run.state === TASK_RUN_AWAITING_USER).length,
      planApproved:
        plan !== null &&
        authorizePlan(plan, this.repo.planApproval(reqId, plan.planVersion)).status === 'approved',
      delivered,
      total: plan?.tasks.length ?? 0,
    })
  }

  /**
   * 把已交付任务退回执行角色修复：归档旧产物与材料、清交付标记、记录修复原因。
   * 任务包版本不变；新一次执行会产生新的候选身份。
   */
  private reopenDeliveredTasks(input: {
    reqId: string
    plan: TaskPlan
    identity: string
    reason: string
  }): Array<{ taskId: string; attempt: number; archivedPath: string }> {
    const archived: Array<{ taskId: string; attempt: number; archivedPath: string }> = []
    for (const task of input.plan.tasks) {
      if (task.verification === true) continue
      const artifact = this.repo.taskArtifact(input.reqId, input.plan.planVersion, task.taskId)
      if (!artifact) continue
      const evidence = this.repo.evidence(input.reqId, input.plan.planVersion, task.taskId)
      const taskDir = evidence
        ? dirname(evidence.candidatePath)
        : evidenceDir(this.config, input.reqId, input.plan.planVersion, task.taskId)
      const attempt =
        this.repo.archivedArtifacts(input.reqId, input.plan.planVersion, task.taskId).length + 1
      const archiveRoot = join(dirname(taskDir), `${task.taskId}.history`)
      const archivedPath = join(
        archiveRoot,
        `attempt-${attempt}-${artifact.candidateSha256.slice(0, 12) || 'empty'}`,
      )
      if (existsSync(taskDir)) {
        mkdirSync(archiveRoot, { recursive: true })
        cpSync(taskDir, archivedPath, { recursive: true })
      }
      this.repo.recordArchivedArtifact({
        artifact,
        attempt,
        archivedAt: this.now(),
        archivedPath,
        reason: input.reason,
      })
      this.repo.clearTaskDelivery(input.reqId, input.plan.planVersion, task.taskId)
      this.recordRun(input.reqId, input.plan, task, {
        state: TASK_RUN_BLOCKED,
        reason: `${input.reason}（旧候选 ${artifact.candidateSha256.slice(0, 12)}… 与材料已归档）`,
      })
      archived.push({ taskId: task.taskId, attempt, archivedPath })
    }
    return archived
  }

  /** 判断一个失败任务能否人工重试；只读，供任务详情与 retryTask 共用。 */
  private retryEligibility(
    reqId: string,
    planVersion: number,
    taskId: string,
  ):
    | { ok: true; plan: TaskPlan; task: PlannedTask; run: TaskRun; remainingRounds: number }
    | { ok: false; code: string; message: string } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, code: 'not_found', message: `未找到需求 ${reqId}` }
    if (isTerminal(requirement.status)) {
      return {
        ok: false,
        code: 'terminal',
        message: `需求 ${reqId} 已处于终态 ${requirement.status}`,
      }
    }
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return { ok: false, code: 'plan_missing', message: `需求 ${reqId} 尚无任务包` }
    if (plan.planVersion !== planVersion) {
      return {
        ok: false,
        code: 'stale_plan',
        message: `任务包 v${planVersion} 不是最新版本（最新 v${plan.planVersion}）；刷新后再重试`,
      }
    }
    if (plan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        code: 'stale_requirement',
        message: `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前是 v${requirement.versions.length}；需重新规划与批准`,
      }
    }
    const authorization = authorizePlan(plan, this.repo.planApproval(reqId, plan.planVersion))
    if (authorization.status !== 'approved') {
      return {
        ok: false,
        code: 'plan_not_approved',
        message: `${authorization.reason}；任务包尚未获得批准`,
      }
    }
    const task = plan.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) return { ok: false, code: 'task_missing', message: `任务包内没有任务 ${taskId}` }
    if (this.repo.taskArtifact(reqId, plan.planVersion, taskId)) {
      return {
        ok: false,
        code: 'already_delivered',
        message: `任务 ${taskId} 已有交付产物，不能重试`,
      }
    }
    const run = this.repo
      .taskRuns(reqId, plan.planVersion)
      .find((candidate) => candidate.taskId === taskId)
    if (!run) {
      return { ok: false, code: 'not_failed', message: `任务 ${taskId} 尚未运行，不能重试` }
    }
    if (![TASK_RUN_FAILED, TASK_RUN_BLOCKED, TASK_RUN_AWAITING_USER].includes(run.state)) {
      return {
        ok: false,
        code: 'not_failed',
        message: `任务 ${taskId} 当前状态是 ${run.state}，不是失败状态`,
      }
    }
    const active = this.repo
      .requestsFor(reqId)
      .find((request) => request.state === 'pending' || request.state === 'claimed')
    if (active) {
      return {
        ok: false,
        code: 'busy',
        message: `需求 ${reqId} 已有待执行或执行中的 ${active.action} 请求 ${active.requestId}；等待结束后再重试`,
      }
    }
    const remainingRounds = this.remainingFailureRounds(reqId)
    if (remainingRounds === 0) {
      return {
        ok: false,
        code: 'grant_required',
        message: `需求 ${reqId} 的失败轮次额度已用尽；需要追加授权或重新规划后再重试`,
      }
    }
    const next = executionOrder(plan).find(
      (candidate) => !this.repo.taskArtifact(reqId, plan.planVersion, candidate),
    )
    if (next !== taskId) {
      return {
        ok: false,
        code: 'predecessor_pending',
        message: `任务 ${next ?? '（无）'} 尚未交付，不能重试后续任务 ${taskId}`,
      }
    }
    return { ok: true, plan, task, run, remainingRounds }
  }

  private remainingFailureRounds(reqId: string): number {
    const used = this.repo.failureRounds(reqId).length
    return Math.max(0, this.repo.grantCount(reqId) * MAX_ROUNDS_PER_GRANT - used)
  }

  /**
   * 系统准入：按真实来源、所有者、授权策略与当前需求说明判定。
   * 结果单独写 requirement_admissions；不写 plan approval，也不伪造 by=owner。
   */
  private admitRequirement(
    reqId: string,
  ): { ok: true; admitted: boolean; decision: AdmissionDecision } | { ok: false; message: string } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, message: `未找到需求 ${reqId}` }
    const analysis = this.repo.latestAnalysis(reqId)
    const decision = decideAdmission(
      {
        requirementStatus: requirement.status,
        requirementVersion: requirement.versions.length,
        project: this.config.project,
        projectPath: this.config.projectPath,
        source: requirement.source,
        submittedBy: requirement.submittedBy,
        owner: this.config.owner,
        analysisVersion: analysis?.analysisVersion ?? null,
        analysisRequirementVersion: analysis?.requirementVersion ?? null,
        clarifications: analysis?.clarifications.length ?? 0,
      },
      this.config.autonomy,
    )
    const latest = this.repo.latestAdmission(reqId, requirement.versions.length)
    const decisionName = decision.admit ? 'admit' : 'block'
    if (!latest || latest.decision !== decisionName || latest.code !== decision.code) {
      this.repo.recordAdmission({
        requirementId: reqId,
        requirementVersion: requirement.versions.length,
        decision,
        decidedBy: 'system:admission',
        createdAt: this.now(),
      })
    }
    return { ok: true, admitted: decision.admit, decision }
  }

  /** 当前需求版本是否已有系统准入；不把旧的准入沿用到新版本。 */
  private currentAdmission(reqId: string): ReturnType<Repository['latestAdmission']> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return null
    const admission = this.repo.latestAdmission(reqId, requirement.versions.length)
    return admission?.decision === 'admit' ? admission : null
  }

  /**
   * 确定性的自动推进队列：只排一次 advance，具体动作仍由协调器领取执行。
   * 系统准入覆盖普通需求；旧的显式批准只作为兼容路径，不成为新的常规门禁。
   */
  autoAdvanceRequests(now = this.now()): string[] {
    const queued: string[] = []
    for (const requirement of this.repo.listRequirements(this.config.project)) {
      if (!this.autoQueueCandidate(requirement)) continue
      const admission = this.currentAdmission(requirement.reqId)
      const plan = this.repo.latestTaskPlan(requirement.reqId)
      const approval = plan ? this.repo.planApproval(requirement.reqId, plan.planVersion) : null
      if (!admission && !approval) continue
      if (plan && plan.requirementVersion !== requirement.versions.length) continue
      if (!this.advanceAllowed(requirement, admission, plan)) continue
      if (this.recordAutoAdvance(requirement, plan, now)) queued.push(requirement.reqId)
    }
    return queued
  }

  private autoQueueCandidate(requirement: Requirement): boolean {
    if (isTerminal(requirement.status)) return false
    // 主动停止是明确决定：扫描、重启和重复唤醒都不能把它变成自动恢复。
    if (this.repo.activeStop(requirement.reqId)) return false
    return !this.repo
      .requestsFor(requirement.reqId)
      .some((request) => ['pending', 'claimed'].includes(request.state))
  }

  private advanceAllowed(
    requirement: Requirement,
    admission: ReturnType<ForgeLoopRuntime['currentAdmission']>,
    plan: TaskPlan | null,
  ): boolean {
    if (requirement.status !== 'blocked') {
      return ['specified', 'developing', 'verifying', 'approved', 'executing'].includes(
        requirement.status,
      )
    }
    if (!admission) return this.retryDecisionFor(requirement.reqId).allowed
    return (
      plan !== null &&
      (this.remainingFailureRounds(requirement.reqId) > 0 ||
        this.issues.latestOpen(requirement.reqId) !== null)
    )
  }

  private recordAutoAdvance(requirement: Requirement, plan: TaskPlan | null, now: string): boolean {
    try {
      this.repo.recordRequest({
        requestId: `rq-${randomUUID()}`,
        reqId: requirement.reqId,
        project: this.config.project,
        planVersion: plan?.planVersion ?? 0,
        action: 'advance',
        requestedBy: 'coordinator:auto-advance',
        source: 'auto-advance',
        now,
      })
      return true
    } catch {
      // 并发扫描或已有的在途请求：留给下一轮，不制造第二套状态。
      return false
    }
  }

  /**
   * 打开连续 Agent 会话；测试可注入只实现 run 的假执行器，
   * 此时退化为每轮独立执行（业务状态与证据仍由主控收口）。
   */
  private async openAgent(request: AgentOpenRequest): Promise<AgentSession> {
    if (typeof this.runner.open === 'function') return this.runner.open(request)
    const runner = this.runner
    let closed = false
    return {
      sessionId: `session-fl-${request.role}-fallback`,
      async send(turn) {
        if (closed) {
          return {
            status: 'error',
            text: '',
            sessionId: `session-fl-${request.role}-fallback`,
            reason: '会话已关闭',
            transcriptPath: turn.transcriptPath,
            durationMs: 0,
            toolCalls: [],
          }
        }
        return runner.run({
          role: request.role,
          cwd: request.cwd,
          prompt: turn.prompt,
          permission: request.permission,
          timeoutMs: turn.timeoutMs,
          transcriptPath: turn.transcriptPath,
          ...(turn.signal ? { signal: turn.signal } : {}),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(turn.onActivity ? { onActivity: turn.onActivity } : {}),
        })
      },
      async close() {
        closed = true
      },
    }
  }

  approvePlan(input: {
    reqId: string
    planVersion: number
    by: string
    source: string
  }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    if (isTerminal(requirement.status))
      return fail('terminal', `需求已处于终态 ${requirement.status}`)
    const plan = this.repo.taskPlan(input.reqId, input.planVersion)
    if (!plan) return fail('plan_missing', `需求 ${input.reqId} 没有任务包 v${input.planVersion}`)
    // 存储的旧任务包可能早于当前硬性规则；批准前按现行规则再校验一次，
    // 不能因为“当时能落库”就放行一个现在明确不合规的任务包。
    try {
      validateTaskPlan(plan)
    } catch (error) {
      return fail(
        'plan_invalid',
        `任务包 v${plan.planVersion} 不满足当前硬性规则：${errorMessage(error)}`,
      )
    }
    const boundary = [
      ...languageViolations(plan),
      ...outsideActiveSource(plan),
      ...unknownPackages(plan, this.existingPackages()),
    ]
    if (boundary.length > 0) {
      return fail(
        'plan_out_of_boundary',
        `任务包越过 TypeScript 语言/工程边界，不能批准：${boundary
          .map((violation) => `${violation.taskId}.${violation.field}=${violation.value}`)
          .join('；')}`,
      )
    }
    const latestVersion = requirement.versions.length
    if (plan.requirementVersion !== latestVersion) {
      return fail(
        'stale_requirement',
        `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前需求是 v${latestVersion}；请重新规划后再批准`,
      )
    }
    const review = this.repo.planReview(input.reqId, plan.planVersion)
    if (!review) {
      return fail(
        'plan_review_required',
        `任务包 v${plan.planVersion} 尚未通过验证 Agent 的实现前评审；不能批准进入实现`,
      )
    }
    const planSha = sha256OfText(JSON.stringify(plan))
    if (review.planSha256 !== planSha || review.requirementVersion !== latestVersion) {
      return fail(
        'plan_review_stale',
        `任务包 v${plan.planVersion} 的实现前评审已过期（任务包或需求版本发生变化）；请重新生成任务包并评审`,
      )
    }
    if (
      !existsSync(review.reportPath) ||
      sha256OfText(readFileSync(review.reportPath, 'utf8')) !== review.reportSha256
    ) {
      return fail('plan_review_invalid', '实现前评审证据文件缺失或摘要不一致；不能批准')
    }
    if (review.verdict !== 'pass') {
      return fail('plan_review_blocked', `实现前评审阻断：${planReviewBlocking(review.reportJson)}`)
    }
    const approval = {
      requirementId: input.reqId,
      planVersion: input.planVersion,
      approvedBy: input.by,
      approvedAt: this.now(),
      source: input.source,
    }
    // 授权来源由批准行派生；任务包正文不改写，回查时按批准版本判定。
    bindAuthorization(plan, approval)
    this.repo.recordPlanApproval(approval)
    this.repo.setStatus(input.reqId, APPROVED)
    return ok(
      `已记录需求 ${input.reqId} 的任务包 v${input.planVersion} 批准（依据需求 v${plan.requirementVersion}）`,
      {
        authorizationSource: authorizationSourceOf(approval),
        tasks: plan.tasks.map((task) => task.taskId),
      },
    )
  }

  grant(input: { reqId: string; by: string }): OperationResult {
    const requirement = this.repo.getRequirement(input.reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
    const count = this.repo.appendGrant(input.reqId, input.by, this.now())
    return ok(`已为需求 ${input.reqId} 追加第 ${count} 次失败轮次授权（累计不清零）`, {
      grants: count,
    })
  }

  /**
   * 宿主启动时的确定性收口：执行者已经不在了，工作副本是运行时建的一次性快照，
   * 直接判失败并丢弃快照，随后可重新执行。没有“无法判定”的中间状态。
   */
  recoverInterrupted(now = this.now()): {
    interruptedRequests: string[]
    migratedUnknown: number
    discardedWorkspaces: string[]
  } {
    const migratedUnknown = this.repo.migrateLegacyUnknown(now)
    const requests = this.repo.failClaimedOnRestart(now)
    const discarded: string[] = []
    for (const request of requests) {
      const plan = this.repo.latestTaskPlan(request.reqId)
      if (!plan) continue
      for (const task of plan.tasks) {
        const dir = workspaceDir(this.config, request.reqId, plan.planVersion, task.taskId)
        if (!existsSync(dir)) continue
        rmSync(dir, { recursive: true, force: true })
        discarded.push(dir)
      }
      this.repo.setStatus(
        request.reqId,
        'blocked',
        `上一次执行被宿主中断（${now}）：一次性工作副本已丢弃，可重新执行`,
      )
    }
    return {
      interruptedRequests: requests.map((request) => request.requestId),
      migratedUnknown,
      discardedWorkspaces: discarded,
    }
  }

  /**
   * 候选包：只从“已通过独立验证的那一份工作区”构建，保证安装的就是被验证的候选。
   * 构建前后核对候选内容、产物摘要与包版本，并记录验证绑定。
   */
  /** 新链路：最近的系统准入候选及其验证、业务验收和本地提交。 */
  buildCandidate(input: { reqId: string; by: string; version?: string }): OperationResult {
    return this.candidatePipeline.buildCandidate(input)
  }

  accept(input: {
    reqId: string
    by: string
    source: string
    artifactSha256?: string
  }): OperationResult {
    return this.candidatePipeline.accept(input)
  }

  verifyDeployment(input: {
    reqId: string
    targetProfile: string
    by: string
    source: string
  }): OperationResult {
    return this.candidatePipeline.verifyDeployment(input)
  }

  /** 一次交付的候选身份；验证与验收必须绑定同一摘要。 */
  private candidateIdentity(
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
  ): string {
    const ordered = plan.tasks.map((task) => {
      const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
      if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
      return artifact
    })
    return candidateIdentityOf({
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      baselineCommit: ordered[0]?.baselineCommit ?? '',
      candidateHashes: ordered.map((artifact) => artifact.candidateSha256),
    })
  }

  // ------------------------------------------------------------ 查询

  requirementView(requirement: Requirement): unknown {
    return buildRequirementView(this.repo, {
      candidateIdentityOf: this.candidateIdentity.bind(this),
      requestView,
      requirement,
    })
  }

  /**
   * 需求修订影响摘要：命令与模型工具共用同一事实计算链。
   * 默认零模型调用；只有显式 explain 才把事实交给无工具 Agent，推断与事实分区返回。
   * 只读：不写记录，也不提供批准、推进或验收路径。
   */
  async impact(reqId: string, options: { explain?: boolean } = {}): Promise<OperationResult> {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)

    const plans = this.repo.taskPlans(reqId)
    const approvals = plans.flatMap((plan) => {
      const approval = this.repo.planApproval(reqId, plan.planVersion)
      return approval === null ? [] : [approval]
    })
    const deliveries = plans.flatMap((plan) => this.repo.taskArtifacts(reqId, plan.planVersion))
    const requests: ImpactRequest[] = this.repo.requestsFor(reqId).map((request) => ({
      requestId: request.requestId,
      action: request.action,
      state: request.state,
      planVersion: request.planVersion,
      createdAt: request.createdAt,
    }))

    const facts = buildImpactFacts({
      requirement,
      analyses: this.repo.analyses(reqId),
      plans,
      approvals,
      deliveries,
      requests,
    })
    const explain = options.explain === true
    const result = await explainImpactFacts(
      facts,
      explain ? { explain: true, agent: this.impactExplainAgent(reqId) } : {},
    )
    return ok(
      `需求 ${reqId} 影响摘要：${facts.state}（已过期 ${facts.summary.staleItems} 项，待核对 ${facts.summary.pendingItems} 项）；${result.notice}`,
      result,
    )
  }

  /** 仅当显式请求推断时调用；Agent 固定无工具，且只读事实快照。 */
  private impactExplainAgent(reqId: string): ImpactExplainAgent {
    return {
      run: async (request): Promise<ImpactExplainAgentResponse> => {
        const result = await this.runner.run({
          role: AGENT_PRODUCT,
          cwd: this.config.projectPath,
          prompt: request.prompt,
          permission: 'workspace-write',
          timeoutMs: this.config.agent.timeoutSeconds * 1000,
          transcriptPath: join(sessionsDir(this.config), `${reqId}-impact-${randomUUID()}.jsonl`),
          tools: 'none',
        })
        return {
          status: result.status,
          text: result.text,
          reason: result.reason,
          sessionId: result.sessionId,
          toolCalls: result.toolCalls,
        }
      },
    }
  }

  status(reqId?: string): OperationResult {
    if (!reqId) {
      const requirements = this.repo.listRequirements(this.config.project)
      return ok(`项目 ${this.config.project} 共 ${requirements.length} 条需求`, {
        requirements: requirements.map((requirement) => ({
          reqId: requirement.reqId,
          status: requirement.status,
          versions: requirement.versions.length,
          title: requirement.versions[requirement.versions.length - 1]?.text.slice(0, 60) ?? '',
        })),
      })
    }
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    return ok(`需求 ${reqId} 状态：${requirement.status}`, this.requirementView(requirement))
  }

  /**
   * 只读状态看板：需求、任务与待处理问题的事实视图。
   * 供 Web 客户端页面与测试共用；不写记录，也不提供批准、推进或验收入口。
   * @param limit 需求条数上限；搜索时仍受同一上限约束。
   * @param query 搜索词；匹配范围见 runtime/board.ts。
   */
  statusBoard(limit?: number, query?: string): StatusBoardView {
    return buildStatusBoard({ repository: this.repo, project: this.config.project, limit, query })
  }

  // ------------------------------------------------------------ 运维

  /** 供协调器周期调用；不直接暴露给模型或页面动作。 */
  async opsTick(signal?: AbortSignal): Promise<Awaited<ReturnType<OpsRuntime['tick']>>> {
    return this.ops.tick(signal)
  }

  opsStatus(eventId?: string): OperationResult {
    if (eventId) {
      const detail = this.ops.detail(eventId)
      if (!detail) return fail('not_found', `未找到运维事件 ${eventId}`)
      return ok(`运维事件 ${eventId}`, detail)
    }
    return ok('运维事件与统计', {
      summary: this.ops.summary(),
      events: this.ops.list(),
    })
  }

  opsDecide(input: {
    eventId: string
    decision: 'approve' | 'decline'
    by: string
    source: string
    reason?: string
  }): OperationResult {
    return this.ops.decide(input)
  }

  opsClose(input: { eventId: string; by: string; reason: string }): OperationResult {
    return this.ops.close(input)
  }

  opsRequestFix(input: { eventId: string; by: string; source: string }): OperationResult {
    return this.ops.requestFix(input)
  }

  /**
   * 单条需求的完整只读详情：在 status 视图之上补充最新任务包正文、
   * 交付产物、验收记录、进度，以及最近一次系统准入与受控提交的只读证据
   * （无记录时为 null），供工作台展开需求后展示。
   */
  requirementDetail(reqId: string): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const view = asRecord(this.requirementView(requirement)) ?? {}
    const plan = this.repo.latestTaskPlan(reqId)
    const artifacts = plan ? this.repo.taskArtifacts(reqId, plan.planVersion) : []
    const runs = plan ? this.repo.taskRuns(reqId, plan.planVersion) : []
    const delivered = new Set(artifacts.map((artifact) => artifact.taskId))
    const progress = deliveryProgress(plan, delivered, runs)
    const requests = this.repo.requestsFor(reqId)
    const evidence = requirementEvidence({
      admissions: this.repo.admissionsFor(reqId),
      commits: this.repo.commitsFor(reqId),
    })
    return ok(`需求 ${reqId} 详情`, {
      ...view,
      latestPlan: plan,
      artifacts,
      admission: evidence.admission,
      commit: evidence.commit
        ? {
            ...evidence.commit,
            commitMessage: formatCommitMessage(evidence.commit.commitMessage),
          }
        : null,
      acceptanceRecord: this.repo.acceptance(reqId),
      businessReview: plan
        ? this.repo.businessReviewForCandidate(
            reqId,
            plan.planVersion,
            plan.tasks.every((task) => delivered.has(task.taskId))
              ? this.candidateIdentity(plan, artifacts)
              : '',
          )
        : null,
      candidateBuild: plan ? this.repo.candidateBuild(reqId, plan.planVersion) : null,
      deployment: plan ? this.repo.deployment(reqId, plan.planVersion) : null,
      archivedDeliveries: plan
        ? plan.tasks.flatMap((task) =>
            this.repo.archivedArtifacts(reqId, plan.planVersion, task.taskId).map((entry) => ({
              taskId: task.taskId,
              ...entry,
            })),
          )
        : [],
      progress,
      activeRequests: requests.filter(
        (request) => request.state === 'pending' || request.state === 'claimed',
      ).length,
      stopRequested: Boolean(this.repo.activeStop(requirement.reqId)),
    })
  }

  showPlan(reqId: string, planVersion?: number): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan =
      planVersion === undefined
        ? this.repo.latestTaskPlan(reqId)
        : this.repo.taskPlan(reqId, planVersion)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有对应任务包`)
    const approval = this.repo.planApproval(reqId, plan.planVersion)
    return ok(`需求 ${reqId} 任务包 v${plan.planVersion}`, {
      plan,
      authorization: authorizePlan(plan, approval),
      analysis: this.repo.latestAnalysis(reqId),
    })
  }

  evidence(reqId: string): OperationResult {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return fail('not_found', `未找到需求 ${reqId}`)
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return fail('plan_missing', `需求 ${reqId} 没有任务包`)
    const artifacts = this.repo.taskArtifacts(reqId, plan.planVersion)
    const evidence = plan.tasks.map((task) => ({
      taskId: task.taskId,
      artifact: artifacts.find((artifact) => artifact.taskId === task.taskId) ?? null,
      files: this.repo.evidence(reqId, plan.planVersion, task.taskId),
    }))
    return ok(`需求 ${reqId} 交付证据（任务包 v${plan.planVersion}）`, {
      planVersion: plan.planVersion,
      evidence,
      acceptance: this.repo.acceptance(reqId),
      candidate: this.repo.candidate(reqId, plan.planVersion),
    })
  }

  listRequests(reqId?: string): OperationResult {
    const requests = reqId
      ? this.repo.requestsFor(reqId)
      : this.repo.pendingRequests(this.config.project)
    return ok(`共 ${requests.length} 条操作请求`, { requests: requests.map(requestView) })
  }

  // ------------------------------------------------------------ 执行流水线

  /**
   * 执行一条已领取的请求；返回结局文本。调用方负责请求状态落库。
   * 只有“已交付”和“未交付（失败）”两种结局：中断/超时也按失败收口，
   * 执行者已不在，一次性工作副本可丢弃，随后重新执行。
   */
  async executeRequest(
    request: ServiceRequestRecord,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const outcome = await this.dispatchRequest(request, signal)
    return { state: outcome.state, detail: outcome.detail }
  }

  private async dispatchRequest(
    request: ServiceRequestRecord,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const requirement = this.repo.getRequirement(request.reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${request.reqId}` }
    if (isTerminal(requirement.status)) {
      return { state: 'failed', detail: `需求已处于终态 ${requirement.status}` }
    }
    if (request.action === 'analyze') {
      return this.executionPlan.executeAnalysis(
        request.reqId,
        signal,
        analysisModeOf(request.source),
      )
    }
    if (request.action === 'plan') {
      return this.executionPlan.executeDevPlanning(
        request.reqId,
        signal,
        request.source.includes(':plan-change:'),
      )
    }
    if (request.action === ACTION_VERIFY) {
      const verification = await this.verificationPipeline.executeVerification(
        request.reqId,
        signal,
      )
      if (verification.state === 'repair') {
        return this.currentAdmission(request.reqId)
          ? this.advancePipeline.executeContinuousAdvance(request.reqId, signal)
          : this.advancePipeline.executeAdvance(request.reqId, signal, request.requestId)
      }
      return verification.state === 'done'
        ? { state: 'done' as const, detail: verification.detail }
        : { state: verification.state, detail: verification.detail }
    }
    return this.currentAdmission(request.reqId)
      ? this.advancePipeline.executeContinuousAdvance(request.reqId, signal)
      : this.advancePipeline.executeAdvance(request.reqId, signal, request.requestId)
  }

  private async reviewPlan(
    requirement: Requirement,
    analysis: RequirementAnalysis,
    plan: TaskPlan,
    signal: AbortSignal,
  ): Promise<{ state: 'done'; review: PlanReview } | { state: 'failed'; detail: string }> {
    let feedback = ''
    let lastMalformed = ''
    let review: PlanReview | null = null
    let lastSession = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now()
      const transcript = join(
        sessionsDir(this.config),
        `${requirement.reqId}-plan-review-v${plan.planVersion}-r${attempt}.jsonl`,
      )
      const result = await this.runner.run({
        role: AGENT_VERIFY,
        cwd: this.config.projectPath,
        prompt: planReviewPrompt({ requirement, analysis, plan }) + feedback,
        permission: 'workspace-write',
        timeoutMs: this.config.agent.timeoutSeconds * 1000,
        transcriptPath: transcript,
        signal,
        tools: 'none',
      })
      this.charge(requirement.reqId, started)
      if (result.status !== 'completed') {
        return {
          state: 'failed',
          detail: `实现前评审未取得可用结论：${result.reason}`,
        }
      }
      lastSession = result.sessionId
      let parsed: PlanReview
      try {
        parsed = parsePlanReview(result.text)
      } catch (error) {
        // 评审材料畸形属于可修正的评审输出问题：带着明确的 JSON 结构要求重试一次，
        // 仍失败则 fail-closed，不伪造通过，也不占用研发重新规划的次数。
        lastMalformed = errorMessage(error)
        feedback = `\n\n上一次输出无法解析：${lastMalformed}。请重新只输出一个完整 JSON 对象，字段与上面要求一致，scenarios 不得重复。`
        continue
      }
      // 评审模型自报通过还不够：验证计划必须覆盖分析中的每个场景与验收标准。
      // 缺项先带着精确缺项重试评审；仍缺项才按阻断记录，交回研发重新规划。
      if (parsed.verdict === 'pass') {
        const coverage = validatePlanCoverage(analysis, parsed)
        if (coverage.length > 0) {
          feedback = `\n\n上一次验证计划没有覆盖以下分析原文，请逐字引用（可附加说明，但不能改写）后重新输出：\n- ${coverage.join('\n- ')}`
          if (attempt < 2) continue
          parsed = { ...parsed, verdict: 'block', blocking: coverage }
        }
      }
      review = parsed
      break
    }
    if (!review) {
      return {
        state: 'failed',
        detail: `实现前评审结果畸形（fail-closed）：${lastMalformed || '连续两次未取得可用结论'}`,
      }
    }
    const result = { sessionId: lastSession }
    const dir = planReviewDir(this.config, requirement.reqId, plan.planVersion)
    mkdirSync(dir, { recursive: true })
    const reportPath = join(dir, 'plan-review.json')
    // 摘要必须绑定“已落库的任务包”：内存对象与恢复对象的字段顺序不同，
    // 若按内存对象计算，批准时重新加载后再核对会永远判为过期。
    const planSha256 = sha256OfText(
      JSON.stringify(this.repo.taskPlan(requirement.reqId, plan.planVersion) ?? plan),
    )
    const report = {
      kind: 'plan-review',
      reqId: requirement.reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      planSha256,
      verdict: review.verdict,
      blocking: review.blocking,
      findings: review.findings,
      summary: review.summary,
      verification_plan: review.verificationPlan,
      sessionId: result.sessionId,
      at: this.now(),
    }
    const reportJson = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(reportPath, reportJson, 'utf8')
    this.repo.recordPlanReview({
      requirementId: requirement.reqId,
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      planSha256,
      verdict: review.verdict,
      reportJson,
      reportPath,
      reportSha256: sha256OfText(reportJson),
      sessionId: result.sessionId,
      reviewedAt: this.now(),
    })
    return { state: 'done', review }
  }

  /**
   * 候选在验证开始前就无法组装（例如交付 diff 与当前基线冲突）：
   * 如实记录一次阻断验证与失败轮次，让“回到研发修复”有据可依。
   */
  private requireAuthorizedPlan(
    reqId: string,
  ): { ok: true; value: { plan: TaskPlan } } | { ok: false; result: OperationResult } {
    const requirement = this.repo.getRequirement(reqId)
    if (!requirement) return { ok: false, result: fail('not_found', `未找到需求 ${reqId}`) }
    const plan = this.repo.latestTaskPlan(reqId)
    if (!plan) return { ok: false, result: fail('plan_missing', `需求 ${reqId} 尚无任务包`) }
    if (plan.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        result: fail(
          'stale_requirement',
          `任务包 v${plan.planVersion} 依据需求 v${plan.requirementVersion}，当前是 v${requirement.versions.length}；需重新规划与批准`,
        ),
      }
    }
    const approval = this.repo.planApproval(reqId, plan.planVersion)
    const authorization = authorizePlan(plan, approval)
    if (authorization.status !== 'approved') {
      return {
        ok: false,
        result: fail('plan_not_approved', `${authorization.reason}；任务包尚未获得批准`),
      }
    }
    return { ok: true, value: { plan } }
  }

  /** 从需求说明生成确定性验证基线；不再依赖单独的实现前评审门禁。 */
  private verificationBaseline(analysis: RequirementAnalysis): PlanReview {
    const criteria = analysis.acceptanceCriteria
    const scenarios = analysis.scenarios.map((scenario, index) => ({
      scenario,
      acceptanceCriterion: criteria[index] ?? criteria[0] ?? scenario,
      method: '验证 Agent 在独立候选上设计并执行自动化测试，逐项核对业务结果与证据',
      required: true,
    }))
    return {
      verdict: 'pass',
      blocking: [],
      findings: [],
      summary: '由产品 Agent 的需求说明生成验证基线；不构成对人类批准的替代',
      verificationPlan: scenarios,
    }
  }

  private authorizedPlan(plan: TaskPlan, source: string): TaskPlan {
    return {
      ...plan,
      tasks: plan.tasks.map((task) => ({ ...task, authorizationSource: source })),
    }
  }

  /** 需求级研发现场；需求版本变化时重建，旧现场保留在目录中不再复用。 */
  private async deliverTask(input: DeliverInput): Promise<DeliverOutcome> {
    return this.taskDelivery.deliver(input)
  }

  private previousTaskFailure(reqId: string, planVersion: number, taskId: string): string {
    const run = this.repo
      .taskRuns(reqId, planVersion)
      .find((candidate) => candidate.taskId === taskId)
    if (!run || ![TASK_RUN_FAILED, TASK_RUN_BLOCKED, TASK_RUN_AWAITING_USER].includes(run.state)) {
      return ''
    }
    const parts = [`上一次任务运行（${run.state}）：${run.reason || '未记录原因'}`]
    const rounds = this.repo.failureRounds(reqId).slice(-2)
    if (rounds.length > 0) {
      parts.push(
        `已记录失败轮次：${rounds.map((round) => `${round.roundId} ${round.summary}`).join('；')}`,
      )
    }
    const logPath = join(evidenceDir(this.config, reqId, planVersion, taskId), 'formal-test.log')
    if (existsSync(logPath)) {
      const tail = readFileSync(logPath, 'utf8').slice(-2000).trim()
      if (tail) parts.push(`上一次正式测试日志尾部：\n${tail}`)
    }
    return `\n\n${parts.join('\n')}\n请先针对上述失败修复，不要重复同样的失败。`
  }

  private recordRun(
    reqId: string,
    plan: TaskPlan,
    task: PlannedTask,
    outcome: {
      state:
        | typeof TASK_RUN_RUNNING
        | typeof TASK_RUN_DELIVERED
        | typeof TASK_RUN_FAILED
        | typeof TASK_RUN_BLOCKED
        | typeof TASK_RUN_AWAITING_USER
      reason: string
    },
  ): void {
    const { state, reason } = outcome
    this.repo.recordTaskRun({
      requirementId: reqId,
      planVersion: plan.planVersion,
      taskId: task.taskId,
      state,
      reason,
      executedSeconds: 0,
      updatedAt: this.now(),
    })
  }

  /** 应用一个候选 diff：先 git apply，失败后用受控 fuzz；不修改证据原文。 */
  private applyDiffFile(
    dir: string,
    diffPath: string,
    label: string,
    suffix: string,
  ): { ok: boolean; detail: string } {
    const rawDiff = readFileSync(diffPath, 'utf8')
    if (rawDiff.trim() === '') return { ok: true, detail: '' }
    const normalized = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`
    const applyPath = join(dir, `.apply-${suffix}-${label}.diff`)
    writeFileSync(applyPath, normalized, 'utf8')
    let applied = runCommand('git', ['apply', '--whitespace=nowarn', applyPath], dir, 120_000)
    if (applied.code !== 0) {
      applied = runCommand(
        'patch',
        ['-p1', '--forward', '--fuzz=3', '--no-backup-if-mismatch', '-i', applyPath],
        dir,
        120_000,
      )
    }
    if (applied.code === 0) rmSync(applyPath, { force: true })
    return { ok: applied.code === 0, detail: applied.stderr.trim() || applied.stdout.trim() }
  }

  private existingPackages(): string[] {
    try {
      return readdirSync(join(this.config.projectPath, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private charge(reqId: string, startedAt: number): void {
    this.repo.chargeBudget(reqId, Math.max(0, (Date.now() - startedAt) / 1000))
  }

  directorySummary(): unknown {
    return {
      recordsRoot: this.config.recordsRoot,
      projectDir: projectDir(this.config),
      database: recordsPath(this.config),
      projectPath: this.config.projectPath,
      agent:
        this.runner instanceof AgentRunner
          ? this.runner.resolveSelection()
          : { provider: this.config.agent.provider, model: this.config.agent.model },
      autoAdvance: this.config.autoAdvance,
    }
  }
}

export function requestView(request: ServiceRequestRecord): Record<string, unknown> {
  return {
    requestId: request.requestId,
    reqId: request.reqId,
    action: request.action,
    state: request.state,
    planVersion: request.planVersion,
    requestedBy: request.requestedBy,
    source: request.source,
    createdAt: request.createdAt,
    detail: request.detail,
    owner: request.owner,
    claimedAt: request.claimedAt,
    attempts: request.attempts,
  }
}

export { ACCEPTED, CANCELLED, requirementContext, APPROVED }
