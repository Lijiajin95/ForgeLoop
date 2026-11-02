import { join } from 'node:path'
import type { ForgeLoopConfig } from '../config.js'
import { sessionsDir } from '../config.js'
import type { Requirement, RequirementAnalysis } from '../domain/requirement.js'
import { parseAnalysisDraft, statusForAnalysis } from '../domain/requirement.js'
import type { TaskPlan } from '../domain/task-plan.js'
import { parseTaskPlanDraft } from '../domain/task-plan.js'
import { AGENT_DEV, AGENT_PRODUCT } from '../domain/agents.js'
import { PLAN_PROPOSED, SPECIFIED } from '../domain/status.js'
import { languageViolations, outsideActiveSource, unknownPackages } from '../domain/language.js'
import { errorMessage } from '../domain/errors.js'
import type { PlanReview } from '../domain/verification.js'
import type { Repository } from '../records/repository.js'
import type { AgentRunner } from './agent-runner.js'
import { analysisPrompt, devPlanningPrompt } from './prompts.js'
import { buildProjectFacts } from './board.js'
import type { AdmissionDecision } from '../domain/admission.js'

function describeViolation(violation: {
  taskId: string
  field: string
  value: string
  reason: string
}): string {
  return `${violation.taskId}.${violation.field}=${violation.value}（${violation.reason}）`
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

export class ExecutionPlan {
  constructor(private readonly deps: ExecutionPlanDeps) {}

  async executeAnalysis(
    reqId: string,
    signal: AbortSignal,
  ): Promise<{ state: 'done' | 'failed'; detail: string }> {
    const requirement = this.deps.repo.getRequirement(reqId)
    if (!requirement) return { state: 'failed', detail: `未找到需求 ${reqId}` }
    const started = Date.now()
    const transcript = join(sessionsDir(this.deps.config), `${reqId}-analyze.jsonl`)
    // 需求 Agent 只读项目事实：活动需求、任务、时间与状态；不开放工具，也不写记录。
    const facts = buildProjectFacts({
      repository: this.deps.repo,
      project: this.deps.config.project,
      currentReqId: reqId,
      now: this.deps.now(),
    })
    const result = await this.deps.runner.run({
      role: AGENT_PRODUCT,
      cwd: this.deps.config.projectPath,
      prompt: analysisPrompt(requirement, facts),
      permission: 'workspace-write',
      timeoutMs: this.deps.config.agent.timeoutSeconds * 1000,
      transcriptPath: transcript,
      signal,
      tools: 'none',
    })
    this.deps.charge(reqId, started)
    if (result.status !== 'completed') return { state: 'failed', detail: result.reason }
    let draft
    try {
      draft = parseAnalysisDraft(result.text)
    } catch (error) {
      this.deps.repo.setStatus(reqId, 'blocked', `分析结果畸形：${errorMessage(error)}`)
      return { state: 'failed', detail: errorMessage(error) }
    }
    const analysis: RequirementAnalysis & { reqId: string } = {
      reqId,
      analysisVersion: this.deps.repo.nextAnalysisVersion(reqId),
      requirementVersion: requirement.versions.length,
      goal: draft.goal,
      scenarios: draft.scenarios,
      acceptanceCriteria: draft.acceptanceCriteria,
      clarifications: draft.clarifications,
      createdAt: this.deps.now(),
    }
    this.deps.repo.recordAnalysis(analysis)
    const status = statusForAnalysis(analysis)
    this.deps.repo.setStatus(
      reqId,
      status,
      analysis.clarifications.length > 0 ? `待澄清：${analysis.clarifications.join('；')}` : '',
    )
    if (analysis.clarifications.length > 0) {
      return {
        state: 'done',
        detail: `分析 v${analysis.analysisVersion} 完成，有 ${analysis.clarifications.length} 条待澄清；等待人工回答后修订需求`,
      }
    }
    const trusted =
      this.deps.config.autonomy.enabled &&
      this.deps.config.autonomy.trustedSources.some(
        (prefix) => prefix.length > 0 && requirement.source.startsWith(prefix),
      )
    if (!trusted) {
      return {
        state: 'done',
        detail: `分析 v${analysis.analysisVersion} 完成；需求来源不在系统准入范围，等待所有者决定`,
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
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
        ...languageViolations(plan),
        ...outsideActiveSource(plan),
        ...unknownPackages(plan, this.deps.existingPackages()),
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
