import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { sessionsDir } from '../config.js'
import type { AnalysisDraft, Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { parseAnalysisDraft, statusForAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { parseTaskPlanDraft } from '../domain/task-plan.js'
import { AGENT_DEV, AGENT_PRODUCT } from '../domain/agents.js'
import { PLAN_PROPOSED, SPECIFIED, ANALYSIS_FAILED, isTerminal } from '../domain/status.js'
import {
  ANALYSIS_PROMPT_VERSION,
  BUSINESS_CONTEXT_DOC,
  PRODUCT_TOOL_ALLOWLIST,
  type AnalysisAttempt,
  type AnalysisMode,
  type ClarificationQuestion,
  type ClarificationUpdate,
} from '../domain/analysis.js'
import { readProjectDoc, writeProjectDoc } from './project-docs.js'
import { sha256OfText } from '../domain/delivery.js'
import {
  languageRulesFor,
  languageViolations,
  outsideActiveSource,
  unknownPackages,
} from '../domain/language.js'
import { MalformedError, errorMessage } from '../domain/errors.js'
import type { PlanReview } from '../domain/verification.js'
import type { Repository } from '../records/repository.js'
import type { AgentRunner } from './agent-runner.js'
import {
  analysisHistoryContext,
  analysisPrompt,
  analysisSpecContext,
  clarificationContext,
  devPlanningPrompt,
} from './prompts.js'
import { buildProjectFacts } from './board.js'
import { sourceTrusted, type AdmissionDecision } from '../domain/admission.js'
import { analysisSpecOf, planCoverageIssues, validateSpec } from '../domain/spec.js'

type RecordedAnalysis = Omit<AnalysisAttempt, 'outcome' | 'detail'>

/** 研发拆解的格式重试上限：畸形输出重试有限次，不随执行限额放开。 */
const MAX_PLANNING_ATTEMPTS = 3

function describeViolation(violation: {
  taskId: string
  field: string
  value: string
  reason: string
}): string {
  return `${violation.taskId}.${violation.field}=${violation.value}（${violation.reason}）`
}

/**
 * 把模型对旧问题的处置落到程序事实：必须覆盖每个未解决问题且引用真实编号。
 * 未解决项由程序原样保留，不依赖模型把它们重新抄进 clarifications。
 */
function applyClarificationUpdates(
  open: readonly ClarificationQuestion[],
  updates: readonly ClarificationUpdate[],
): { remaining: readonly ClarificationQuestion[]; resolved: readonly ClarificationUpdate[] } {
  const byId = new Map(open.map((question) => [question.questionId, question]))
  for (const update of updates) {
    if (!byId.has(update.questionId)) {
      throw new MalformedError(
        `clarification_updates 引用了不存在或已解决的问题 ${update.questionId}；只能处置上面列出的未解决问题`,
      )
    }
  }
  const byQuestion = new Map(updates.map((update) => [update.questionId, update]))
  const missing = open.filter((question) => !byQuestion.has(question.questionId))
  if (missing.length > 0) {
    throw new MalformedError(
      `clarification_updates 遗漏了未解决问题：${missing
        .map((question) => `${question.questionId}（${question.text}）`)
        .join('；')}`,
    )
  }
  return {
    remaining: open.filter((question) => byQuestion.get(question.questionId)?.status === 'open'),
    resolved: updates.filter((update) => update.status === 'resolved'),
  }
}

export interface ExecutionPlanDeps {
  config: ForgeLoopConfig
  repo: Repository
  now: () => string
  charge: (reqId: string, started: number) => void
  runner: { run: AgentRunner['run'] }
  existingPackages: () => string[]
  admitRequirement: (
    reqId: string,
  ) => { ok: true; admitted: boolean; decision: AdmissionDecision } | { ok: false; message: string }
  reviewPlan: (
    requirement: Requirement,
    analysis: RequirementAnalysis,
    plan: TaskPlan,
    signal: AbortSignal,
  ) => Promise<{ state: 'done'; review: PlanReview } | { state: 'failed'; detail: string }>
}

export interface ExecuteAnalysisResult {
  readonly state: 'done' | 'failed'
  readonly detail: string
  /** 结果返回时需求已修订/停止/取消：只保留审计，调用方不得把它当成分析结论。 */
  readonly stale?: boolean
}

export class ExecutionPlan {
  /** 同一需求版本只允许一次真实模型调用；并发调用共享同一结果。 */
  private readonly inflight = new Map<string, Promise<ExecuteAnalysisResult>>()

  constructor(private readonly deps: ExecutionPlanDeps) {}

  async executeAnalysis(
    reqId: string,
    signal: AbortSignal,
    mode: AnalysisMode = 'initial',
  ): Promise<ExecuteAnalysisResult> {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const version = requirement.versions.length
    // 单次分析：当前需求版本已有结论时直接复用，不重复调用模型。
    const existing = this.deps.repo.latestAnalysis(reqId)
    if (existing && existing.requirementVersion === version) {
      return {
        state: 'done',
        detail: `需求 ${reqId} 已有 v${existing.analysisVersion} 分析，未重复调用模型`,
      }
    }
    const key = `${reqId}:${version}`
    const running = this.inflight.get(key)
    if (running) return running
    const task = this.runAnalysis({ reqId, requirement, version, signal, mode }).finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key)
    })
    this.inflight.set(key, task)
    return task
  }

  private async runAnalysis(input: {
    reqId: string
    requirement: Requirement
    version: number
    signal: AbortSignal
    mode: AnalysisMode
  }): Promise<ExecuteAnalysisResult> {
    const { reqId, requirement, version, signal, mode } = input
    const previousAnalysis = this.deps.repo.latestAnalysis(reqId)
    const attempt = this.deps.repo.analysisAttempts(reqId, version).length + 1
    const started = Date.now()
    // 每个需求版本、每次尝试一个独立轨迹文件：attempt 按版本重新计数，
    // 不带版本号会让 v2/a1 覆盖 v1/a1 的历史证据。
    const transcript = join(
      sessionsDir(this.deps.config),
      `${reqId}-v${version}-analyze-a${attempt}.jsonl`,
    )
    const openQuestions = this.deps.repo.openClarifications(reqId)
    const result = await this.deps.runner.run({
      role: AGENT_PRODUCT,
      cwd: this.deps.config.projectPath,
      prompt: this.analysisPromptFor(reqId, requirement),
      // 产品 Agent 允许写项目文档，但只拿到文档读写与联网检索工具，没有任何编码工具。
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: transcript,
      signal,
      tools: 'default',
      allowTools: PRODUCT_TOOL_ALLOWLIST,
    })
    this.deps.charge(reqId, started)
    const recorded = {
      reqId,
      requirementVersion: version,
      attempt,
      kind: mode,
      model: this.deps.config.agent.model,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      transcriptPath: transcript,
      toolCalls: result.toolCalls,
      createdAt: this.deps.now(),
    }
    // 模型返回时先核对需求是否仍是发起时的版本与状态：迟到结果只留审计，
    // 不能更新需求状态、系统准入或业务背景。
    const stale = this.stalenessOf(reqId, version)
    if (stale) return this.recordStale(recorded, stale)
    if (result.status !== 'completed') {
      return this.failAnalysis(recorded, result.reason)
    }
    let draft: AnalysisDraft
    let updates: ReturnType<typeof applyClarificationUpdates>
    try {
      draft = this.analysisFromResult(result.text)
      updates = applyClarificationUpdates(openQuestions, draft.clarificationUpdates)
    } catch (error) {
      return this.failAnalysis(recorded, errorMessage(error))
    }
    // 未解决的旧问题由程序保留；本轮新增问题按本次分析版本获得稳定编号。
    const analysisVersion = this.deps.repo.nextAnalysisVersion(reqId)
    const openAfter = [
      ...updates.remaining.map((question) => question.text),
      ...draft.clarifications,
    ]
    // 背景变化先落草稿：即使本次分析随后校验失败或仍待澄清，也只保留草稿，不写正式文档。
    if (draft.businessContext.changed) {
      this.deps.repo.recordBusinessContextDraft({
        reqId,
        analysisVersion,
        requirementVersion: version,
        document: draft.businessContext.document,
        reason: draft.businessContext.reason,
        createdAt: this.deps.now(),
      })
    }
    try {
      validateSpec({
        spec: {
          points: draft.businessPoints,
          acceptance: draft.acceptanceItems,
          assumptions: draft.assumptions,
        },
        complete: openAfter.length === 0,
        inputKind: draft.inputKind,
        previous: previousAnalysis ? analysisSpecOf(previousAnalysis) : null,
      })
    } catch (error) {
      return this.failAnalysis(recorded, errorMessage(error))
    }
    const analysis: RequirementAnalysis & { reqId: string } = {
      reqId,
      analysisVersion,
      requirementVersion: version,
      inputKind: draft.inputKind,
      goal: draft.goal,
      scenarios: draft.scenarios,
      businessRules: draft.businessRules,
      exceptions: draft.exceptions,
      nonGoals: draft.nonGoals,
      acceptanceCriteria: draft.acceptanceCriteria,
      businessPoints: draft.businessPoints,
      acceptanceItems: draft.acceptanceItems,
      assumptions: draft.assumptions,
      clarifications: openAfter,
      model: recorded.model,
      promptVersion: recorded.promptVersion,
      transcriptPath: recorded.transcriptPath,
      toolCalls: recorded.toolCalls,
      createdAt: this.deps.now(),
    }
    return this.settleAnalysis({
      requirement,
      analysis,
      attempt: recorded,
      newQuestions: draft.clarifications,
      updates: draft.clarificationUpdates,
      businessContext: draft.businessContext,
    })
  }

  /**
   * 结果是否已经过期：需求被修订、取消或停止后，旧版本的模型调用即使成功也不得写回。
   * 只读当前记录，不依赖调用方传入的状态。
   */
  private stalenessOf(reqId: string, version: number): string {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return '需求已不存在'
    if (this.deps.repo.cancellation(reqId)) return '需求已取消'
    if (isTerminal(requirement.status)) return `需求已处于终态 ${requirement.status}`
    if (requirement.versions.length !== version) {
      return `需求已从 v${version} 修订为 v${requirement.versions.length}`
    }
    if (this.deps.repo.activeStop(reqId)) return '需求已请求停止'
    const recorded = this.deps.repo.latestAnalysis(reqId)
    if (recorded && recorded.requirementVersion === version) {
      return `需求 v${version} 已有分析结论`
    }
    return ''
  }

  /** 迟到结果只写一条审计尝试；不改需求状态，也不进入准入与业务背景。 */
  private recordStale(recorded: RecordedAnalysis, reason: string): ExecuteAnalysisResult {
    this.deps.repo.recordAnalysisAttempt({
      ...recorded,
      outcome: 'stale',
      detail: `结果迟到已丢弃：${reason}`,
    })
    return {
      state: 'failed',
      detail: `分析结果已过期，只保留审计记录：${reason}`,
      stale: true,
    }
  }

  /** 分析提示词只在这里组装：需求原文、项目事实、业务背景与完整澄清问答。 */
  private analysisPromptFor(reqId: string, requirement: Requirement): string {
    const open = this.deps.repo.openClarifications(reqId)
    const history = this.deps.repo.clarificationQuestions(reqId)
    const answers = this.deps.repo.clarificationAnswers(reqId)
    const facts = buildProjectFacts({
      repository: this.deps.repo,
      project: this.deps.config.project,
      currentReqId: reqId,
      now: this.deps.now(),
      currentText: requirement.versions.map((version) => version.text).join('\n'),
    })
    const business = readProjectDoc(this.deps.config.projectPath, BUSINESS_CONTEXT_DOC)
    return analysisPrompt(
      requirement,
      facts,
      business.ok ? business.content : '',
      analysisHistoryContext({
        clarifications: clarificationContext({
          questions: history.length > 0 ? history : open,
          answers,
        }),
        previousSpec: analysisSpecContext(this.deps.repo.latestAnalysis(reqId)),
      }),
    )
  }

  /** 落库成功结论并决定下一步：仍有待澄清则等待，否则进入系统准入与研发。 */
  private settleAnalysis(input: {
    requirement: Requirement
    analysis: RequirementAnalysis & { reqId: string }
    attempt: RecordedAnalysis
    newQuestions: readonly string[]
    updates: readonly ClarificationUpdate[]
    businessContext: AnalysisDraft['businessContext']
  }): { state: 'done' | 'failed'; detail: string } {
    const { requirement, analysis } = input
    const reqId = analysis.reqId
    if (analysis.clarifications.length > 0) {
      this.deps.repo.recordAnalysis(analysis, {
        questions: input.newQuestions,
        updates: input.updates,
      })
      this.deps.repo.recordAnalysisAttempt({ ...input.attempt, outcome: 'done', detail: '' })
      this.deps.repo.setStatus(
        reqId,
        statusForAnalysis(analysis),
        `待澄清：${analysis.clarifications.join('；')}`,
      )
      return {
        state: 'done',
        detail: `分析 v${analysis.analysisVersion} 完成，有 ${analysis.clarifications.length} 条待澄清；等待人工回答后修订需求`,
      }
    }
    // 校验通过且没有待澄清后才同步正式业务背景；失败时草稿保留，分析按失败收口。
    const applied = this.applyBusinessContext({
      requirementVersion: analysis.requirementVersion,
      analysisVersion: analysis.analysisVersion,
      businessContext: input.businessContext,
    })
    if (!applied.ok) return this.failAnalysis(input.attempt, applied.reason)
    this.deps.repo.recordAnalysis(analysis, {
      questions: input.newQuestions,
      updates: input.updates,
    })
    this.deps.repo.recordAnalysisAttempt({ ...input.attempt, outcome: 'done', detail: '' })
    if (applied.sha256) {
      this.deps.repo.markBusinessContextApplied({
        reqId,
        analysisVersion: analysis.analysisVersion,
        docSha256: applied.sha256,
        appliedAt: this.deps.now(),
      })
    }
    this.deps.repo.setStatus(reqId, statusForAnalysis(analysis), '')
    const trusted =
      this.deps.config.autonomy.enabled &&
      sourceTrusted(requirement.source, this.deps.config.autonomy)
    if (!trusted) {
      return {
        state: 'done',
        detail: `分析 v${analysis.analysisVersion} 完成；需求来源 ${requirement.source || '（空）'} 不在系统准入范围，等待所有者决定`,
      }
    }
    const admission = this.deps.admitRequirement(reqId)
    if (!admission.ok) return { state: 'failed', detail: admission.message }
    if (!admission.admitted) {
      this.deps.repo.setStatus(reqId, 'blocked', `系统准入未通过：${admission.decision.reason}`)
      return {
        state: 'done',
        detail: `分析 v${analysis.analysisVersion} 完成；系统准入未通过：${admission.decision.reason}`,
      }
    }
    this.deps.repo.setStatus(reqId, SPECIFIED, admission.decision.reason)
    return {
      state: 'done',
      detail: `分析 v${analysis.analysisVersion} 完成；系统准入通过，等待协调器自动排入研发`,
    }
  }

  /** 解析模型返回的分析结果；背景变化只算草稿，正式文档在 settle 校验通过后才同步。 */
  private analysisFromResult(text: string): AnalysisDraft {
    try {
      return parseAnalysisDraft(text)
    } catch (error) {
      throw new MalformedError(`分析结果畸形：${errorMessage(error)}`)
    }
  }

  /**
   * 把已通过校验的背景草稿写成正式项目文档。
   * 写入失败按分析失败处理：草稿保留，正式文档不被半截内容覆盖。
   */
  private applyBusinessContext(input: {
    requirementVersion: number
    analysisVersion: number
    businessContext: AnalysisDraft['businessContext']
  }): { ok: true; sha256: string } | { ok: false; reason: string } {
    if (!input.businessContext.changed) return { ok: true, sha256: '' }
    const written = writeProjectDoc(
      this.deps.config.projectPath,
      BUSINESS_CONTEXT_DOC,
      input.businessContext.document,
    )
    if (!written.ok) {
      return { ok: false, reason: `业务背景文档同步失败：${written.reason}` }
    }
    return { ok: true, sha256: sha256OfText(input.businessContext.document) }
  }

  /** 失败尝试同样落库并进入失败状态；自动/人工重试由主控另行排队。 */
  private failAnalysis(
    recorded: RecordedAnalysis,
    detail: string,
  ): { state: 'failed'; detail: string } {
    this.deps.repo.recordAnalysisAttempt({ ...recorded, outcome: 'failed', detail })
    this.deps.repo.setStatus(
      recorded.reqId,
      ANALYSIS_FAILED,
      `产品分析失败（第 ${recorded.attempt} 次）：${detail}`,
    )
    return { state: 'failed', detail }
  }

  private planningInputs(
    reqId: string,
    permittedPlanChange: boolean,
  ):
    | {
        ok: true
        requirement: Requirement
        analysis: RequirementAnalysis
      }
    | { ok: false; outcome: { state: 'failed'; detail: string } } {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) {
      return { ok: false, outcome: { state: 'failed', detail: `未找到需求 ${reqId}` } }
    }
    // 入队时未批准、执行时已批准：仍必须拒绝，避免旧请求悄悄覆盖已冻结的任务包。
    const latestPlan = this.deps.repo.latestTaskPlan(reqId)
    if (
      latestPlan &&
      this.deps.repo.planApproval(reqId, latestPlan.planVersion) &&
      !permittedPlanChange
    ) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `任务包 v${latestPlan.planVersion} 已批准并冻结；修改任务包需要所有者显式许可并说明原因`,
        },
      }
    }
    const analysis = this.deps.repo.latestAnalysis(reqId)
    if (!analysis) {
      return { ok: false, outcome: { state: 'failed', detail: '尚无分析结论，不能规划' } }
    }
    if (analysis.requirementVersion !== requirement.versions.length) {
      return {
        ok: false,
        outcome: {
          state: 'failed',
          detail: `最新分析依据需求 v${analysis.requirementVersion}，当前是 v${requirement.versions.length}；请重新分析`,
        },
      }
    }
    if (analysis.clarifications.length > 0) {
      return {
        ok: false,
        outcome: { state: 'failed', detail: '分析仍有待澄清项；回答后修订需求并重新分析' },
      }
    }
    return { ok: true, requirement, analysis }
  }

  async executeDevPlanning(
    reqId: string,
    signal: AbortSignal,
    permittedPlanChange = false,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const inputs = this.planningInputs(reqId, permittedPlanChange)
    if (!inputs.ok) return inputs.outcome
    const { requirement, analysis } = inputs
    let feedback = ''
    let lastError = ''
    let lastPlan: TaskPlan | undefined
    for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
      const transcript = join(sessionsDir(this.deps.config), `${reqId}-plan-a${attempt}.jsonl`)
      const started = Date.now()
      const result = await this.deps.runner.run({
        role: AGENT_DEV,
        cwd: this.deps.config.projectPath,
        prompt: devPlanningPrompt(requirement, analysis) + feedback,
        permission: 'workspace-write',
        timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
        transcriptPath: transcript,
        signal,
        tools: 'none',
      })
      this.deps.charge(reqId, started)
      if (result.status !== 'completed') {
        return { state: 'failed', detail: result.reason }
      }
      let plan: TaskPlan
      try {
        plan = parseTaskPlanDraft(result.text, {
          requirementId: reqId,
          project: requirement.project,
          planVersion: this.deps.repo.nextPlanVersion(reqId),
          requirementVersion: requirement.versions.length,
          now: this.deps.now(),
        })
      } catch (error) {
        lastError = `任务包不合规：${errorMessage(error)}`
        feedback = `\n\n上一次输出的任务包被程序拒绝：${errorMessage(error)}。请修正后重新输出完整 JSON。`
        continue
      }
      const violations = [
        ...languageViolations(plan, languageRulesFor(this.deps.config.activeRoots)),
        ...outsideActiveSource(plan, this.deps.config.activeRoots),
        ...unknownPackages(plan, this.deps.existingPackages()),
        ...planCoverageIssues(analysis, plan).map((issue) => ({
          taskId: 'plan',
          field: 'covers',
          value: issue.code,
          reason: issue.detail,
        })),
      ]
      if (violations.length > 0) {
        lastError = `任务包越过 TypeScript 语言/工程边界：${violations
          .map(describeViolation)
          .join('；')}`
        feedback = `\n\n上一次输出的任务包被程序拒绝：${lastError}。不得使用 Python、旧 .venv 或旧 forgeloop CLI；请只修改 TypeScript 工程并给出 npm/node 测试命令。重新输出完整 JSON。`
        continue
      }
      this.deps.repo.recordTaskPlan(plan)
      lastPlan = plan
      const reviewOutcome = await this.deps.reviewPlan(requirement, analysis, plan, signal)
      if (reviewOutcome.state !== 'done') {
        this.deps.repo.setStatus(
          reqId,
          PLAN_PROPOSED,
          '任务包已生成，但验证 Agent 的实现前评审未完成；不能批准',
        )
        return { state: reviewOutcome.state, detail: reviewOutcome.detail }
      }
      if (reviewOutcome.review.verdict === 'block') {
        lastError = `实现前评审阻断：${reviewOutcome.review.blocking.join('；')}`
        feedback = `\n\n上一次任务包被验证 Agent 的实现前评审阻断：\n- ${reviewOutcome.review.blocking.join('\n- ')}\n请修正技术方案、任务文件范围或测试命令后重新输出完整 JSON。`
        continue
      }
      this.deps.repo.setStatus(reqId, PLAN_PROPOSED)
      return {
        state: 'done',
        detail: `已生成任务包 v${plan.planVersion}（${plan.tasks.length} 个任务）并通过实现前评审；等待批准`,
      }
    }
    if (lastPlan) {
      this.deps.repo.setStatus(reqId, PLAN_PROPOSED, lastError)
    } else {
      this.deps.repo.setStatus(reqId, 'blocked', lastError)
    }
    return { state: 'failed', detail: lastError }
  }

  /**
   * 实现前评审：验证 Agent 只读任务包与分析，产出验证计划。
   * 评审通过才允许批准；阻断原因会反馈给规划 Agent 重新生成任务包。
   */
}
