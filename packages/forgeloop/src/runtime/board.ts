import { parseJsonObject } from '../domain/json.js'
import { bestEffortValue } from './best-effort.js'
import type { Repository } from '../records/repository.js'
import type { Requirement } from '../domain/requirement.js'
import { authorizePlan, type TaskPlan } from '../domain/task-plan.js'
import { candidateIdentityOf } from '../domain/delivery.js'
import { validateTaskPlan } from '../domain/task-plan.js'
import {
  parsePlanReview,
  parseVerificationReport,
  type PlanReview,
  type VerificationReport,
} from '../domain/verification.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import { retryDecision } from '../domain/retry-policy.js'
import { buildTaskFailureAdvice, type TaskFailureAdvice } from '../domain/failure-advice.js'
import type { AutonomyStats } from '../domain/autonomy.js'
import { buildIdentity, type BuildIdentityView } from './identity.js'
import { buildAutonomyStats } from './autonomy-stats.js'
import {
  ACTION_ANALYZE,
  ACTION_PLAN,
  ACTION_ADVANCE,
  ACTION_VERIFY,
  ANALYSIS_FAILED,
  APPROVED,
  DRAFT,
  EXECUTING,
  REQUEST_FAILED,
  PLAN_PROPOSED,
  isTerminal,
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'

export const BOARD_DEFAULT_LIMIT = 20
export const BOARD_MAX_LIMIT = 100
export const BOARD_MAX_ISSUES = 60

export const BOARD_TASK_DELIVERED = 'delivered'
export const BOARD_TASK_PENDING = 'pending'
export const BOARD_TASK_AWAITING_INPUT = 'awaiting_input'

export type BoardTaskState =
  | typeof BOARD_TASK_DELIVERED
  | typeof BOARD_TASK_PENDING
  | typeof BOARD_TASK_AWAITING_INPUT
  | typeof TASK_RUN_AWAITING_USER
  | typeof TASK_RUN_RUNNING
  | 'failed'
  | 'blocked'

export interface BoardTaskView {
  readonly reqId: string
  readonly planVersion: number
  readonly taskId: string
  readonly goal: string
  readonly state: BoardTaskState
  readonly dependsOn: readonly string[]
  readonly lastActivity: string
  readonly failureReason: string
  readonly failureAdvice: TaskFailureAdvice | null
}

export type BoardRequirementAction =
  | 'plan'
  | 'approve'
  | 'advance'
  | 'verify'
  | 'retry-analysis'
  | 'recover'
  | 'diagnose'
  | 'requeue'
  | 'extend-budget'
  | 'grant-rounds'
  | 'build'
  | 'deploy'
  | 'stop'
  | 'cancel'

export interface BoardPlanReviewView {
  readonly verdict: 'pass' | 'block'
  readonly summary: string
  readonly blocking: readonly string[]
  readonly reviewedAt: string
}

export interface BoardVerificationView {
  readonly verdict: 'pass' | 'block'
  readonly fresh: boolean
  readonly summary: string
  readonly blocking: readonly string[]
  readonly candidateSha256: string
  readonly verifiedAt: string
}

export interface BoardBusinessReviewView {
  readonly verdict: 'pass' | 'block'
  readonly fresh: boolean
  readonly summary: string
  readonly blocking: readonly string[]
  readonly candidateSha256: string
  readonly reviewedAt: string
}

export interface BoardCandidateView {
  readonly candidateSha256: string
  readonly packageVersion: string
  readonly artifactSha256: string
  readonly builtAt: string
  readonly verificationSha256: string
}

export interface BoardDeploymentView {
  readonly state: string
  readonly targetProfile: string
  readonly runtimeVersion: string
  readonly packageVersion: string
  readonly artifactSha256: string
  readonly recordedAt: string
  readonly failedChecks: readonly string[]
}

export interface BoardRequirementView {
  readonly reqId: string
  readonly title: string
  readonly status: string
  readonly version: number
  readonly source: string
  readonly submittedBy: string
  readonly planVersion: number | null
  readonly approval: 'approved' | 'missing' | 'stale' | 'none'
  readonly planReview: BoardPlanReviewView | null
  readonly verification: BoardVerificationView | null
  readonly businessReview: BoardBusinessReviewView | null
  readonly candidate: BoardCandidateView | null
  readonly deployment: BoardDeploymentView | null
  readonly retry: { readonly allowed: boolean; readonly reason: string }
  readonly clarifications: number
  readonly failureRounds: number
  readonly grants: number
  readonly remainingRounds: number | null
  readonly actions: readonly BoardRequirementAction[]
  readonly stopRequested: boolean
  readonly activeRequest: boolean
  readonly progress: {
    readonly total: number
    readonly delivered: number
    readonly failed: number
    readonly awaitingUser: number
    readonly awaitingInput: number
    readonly blocked: number
    readonly running: number
    readonly pending: number
  }
  readonly updatedAt: string
}

export const ISSUE_CLARIFICATION = 'clarification'
export const ISSUE_BLOCKED = 'blocked'
export const ISSUE_FAILURE_ROUND = 'failure_round'
export const ISSUE_REQUEST = 'request'
export const ISSUE_APPROVAL = 'approval'

export type BoardIssueKind =
  | typeof ISSUE_CLARIFICATION
  | typeof ISSUE_BLOCKED
  | typeof ISSUE_FAILURE_ROUND
  | typeof ISSUE_REQUEST
  | typeof ISSUE_APPROVAL

export type BoardIssueSeverity = 'blocking' | 'attention'

export interface BoardIssueView {
  readonly issueId: string
  readonly reqId: string
  readonly taskId?: string
  readonly kind: BoardIssueKind
  readonly severity: BoardIssueSeverity
  readonly title: string
  readonly detail: string
  readonly createdAt: string
}

export interface StatusBoardView {
  readonly project: string
  readonly generatedAt: string
  readonly build: BuildIdentityView
  readonly query: string
  readonly limit: number
  readonly truncated: boolean
  readonly summary: {
    readonly requirements: number
    readonly active: number
    readonly tasks: number
    readonly delivered: number
    readonly issues: number
    readonly blocking: number
  }
  readonly requirements: readonly BoardRequirementView[]
  readonly tasks: readonly BoardTaskView[]
  readonly issues: readonly BoardIssueView[]
  readonly autonomy: AutonomyStats
}

export interface BuildStatusBoardInput {
  readonly repository: Repository
  readonly project: string
  readonly now?: string
  readonly limit?: number | undefined
  readonly query?: string | undefined
  readonly remainingFailureRounds?: ((reqId: string) => number) | undefined
  readonly owner?: string
  readonly build?: BuildIdentityView | undefined
}

export function boardTaskState(input: {
  readonly delivered: boolean
  readonly run?: { readonly state: string; readonly reason: string } | undefined
}): BoardTaskState {
  if (input.delivered) return BOARD_TASK_DELIVERED
  const run = input.run
  if (!run) return BOARD_TASK_PENDING
  if (run.state === TASK_RUN_RUNNING && /ask_user_question/i.test(run.reason)) {
    return BOARD_TASK_AWAITING_INPUT
  }
  if (
    run.state === TASK_RUN_RUNNING ||
    run.state === TASK_RUN_FAILED ||
    run.state === TASK_RUN_BLOCKED ||
    run.state === TASK_RUN_AWAITING_USER
  ) {
    return run.state
  }
  return BOARD_TASK_PENDING
}

export function requirementTitle(requirement: Requirement): string {
  const latest = requirement.versions[requirement.versions.length - 1]
  const firstLine = (latest?.text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return requirement.reqId
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

function updatedAtOf(requirement: Requirement): string {
  return requirement.versions[requirement.versions.length - 1]?.createdAt ?? ''
}

function createdAtOf(requirement: Requirement): string {
  return requirement.versions[0]?.createdAt ?? ''
}

function requestActionLabel(action: string): string {
  if (action === ACTION_ANALYZE) return '分析'
  if (action === ACTION_PLAN) return '规划'
  if (action === ACTION_ADVANCE) return '推进'
  if (action === ACTION_VERIFY) return '独立测试'
  return action
}

export function taskIdOfFailureRound(plan: TaskPlan | null, roundId: string): string | undefined {
  if (!plan) return undefined
  return plan.tasks
    .map((task) => task.taskId)
    .filter((taskId) => roundId.startsWith(`${taskId}-`))
    .sort((left, right) => right.length - left.length)[0]
}

const SEVERITY_RANK: Record<BoardIssueSeverity, number> = { blocking: 0, attention: 1 }

function analysisList(values: readonly string[] | undefined): readonly string[] {
  return values ?? []
}

interface RequirementChunk {
  readonly requirement: Requirement
  readonly view: BoardRequirementView
  readonly tasks: BoardTaskView[]
  readonly issues: BoardIssueView[]
  readonly haystack: string
}

function haystackOf(input: {
  requirement: Requirement
  view: BoardRequirementView
  tasks: readonly BoardTaskView[]
  issues: readonly BoardIssueView[]
  analysis: ReturnType<Repository['latestAnalysis']>
  plan: TaskPlan | null
  runs: ReturnType<Repository['taskRuns']>
  rounds: ReturnType<Repository['failureRounds']>
  requests: ReturnType<Repository['requestsFor']>
}): string {
  const { requirement, view, tasks, issues, analysis, plan, runs, rounds, requests } = input
  const parts: string[] = [
    requirement.reqId,
    requirement.project,
    requirement.status,
    requirement.blockedReason,
    view.title,
    view.status,
  ]
  for (const version of requirement.versions) {
    parts.push(version.text, version.revisedBy, version.source)
  }
  if (analysis) {
    parts.push(
      analysis.goal,
      ...analysis.scenarios,
      ...analysisList(analysis.businessRules),
      ...analysisList(analysis.exceptions),
      ...analysisList(analysis.nonGoals),
      ...analysis.acceptanceCriteria,
      ...analysis.clarifications,
    )
  }
  if (plan) {
    parts.push(plan.taskPlanId, `v${plan.planVersion}`)
    if (plan.technicalSolution) {
      parts.push(
        plan.technicalSolution.summary,
        ...plan.technicalSolution.approach,
        ...plan.technicalSolution.risks,
      )
    }
    for (const task of plan.tasks) {
      parts.push(
        task.taskId,
        task.goal,
        ...task.files,
        task.acceptance,
        ...task.testCommand,
        ...task.dependsOn,
      )
    }
  }
  if (view.planReview) {
    parts.push(view.planReview.summary, ...view.planReview.blocking)
  }
  if (view.verification) {
    parts.push(view.verification.summary, ...view.verification.blocking)
  }
  for (const task of tasks) {
    parts.push(task.taskId, task.goal, task.state, task.failureReason)
  }
  for (const run of runs) {
    parts.push(run.taskId, run.state, run.reason)
  }
  for (const round of rounds) {
    parts.push(round.roundId, round.stage, round.summary)
  }
  for (const request of requests) {
    parts.push(request.action, request.state, request.detail, request.requestedBy, request.source)
  }
  for (const issue of issues) {
    parts.push(issue.kind, issue.title, issue.detail, issue.taskId ?? '')
  }
  return parts.join('\n').toLowerCase()
}

export function buildStatusBoard(input: BuildStatusBoardInput): StatusBoardView {
  const { repository, project } = input
  const now = input.now ?? new Date().toISOString()
  const limit = Math.min(
    BOARD_MAX_LIMIT,
    Math.max(1, Math.trunc(input.limit ?? BOARD_DEFAULT_LIMIT)),
  )
  const query = (input.query ?? '').trim().slice(0, 200)
  const all = repository.listRequirements(project)

  const chunks: RequirementChunk[] = []

  for (const requirement of all) {
    chunks.push(buildRequirementChunk(repository, requirement, input.remainingFailureRounds))
  }

  const needle = query.toLowerCase()
  const matched = needle ? chunks.filter((chunk) => chunk.haystack.includes(needle)) : chunks
  const limited = matched.slice(0, limit)
  const requirements = limited.map((chunk) => chunk.view)
  const tasks = limited.flatMap((chunk) => chunk.tasks)
  const sortedIssues = limited
    .flatMap((chunk) => chunk.issues)
    .sort((left, right) => {
      const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      if (bySeverity !== 0) return bySeverity
      return right.createdAt.localeCompare(left.createdAt)
    })
    .slice(0, BOARD_MAX_ISSUES)

  return {
    project,
    generatedAt: now,
    build: input.build ?? buildIdentity(),
    query,
    limit,
    truncated: matched.length > limited.length,
    summary: {
      requirements: needle ? matched.length : all.length,
      active: (needle ? matched.map((chunk) => chunk.requirement) : all).filter(
        (requirement) => !isTerminal(requirement.status) && requirement.status !== DRAFT,
      ).length,
      tasks: tasks.length,
      delivered: tasks.filter((task) => task.state === BOARD_TASK_DELIVERED).length,
      issues: sortedIssues.length,
      blocking: sortedIssues.filter((issue) => issue.severity === 'blocking').length,
    },
    requirements,
    tasks,
    issues: sortedIssues,
    autonomy: buildAutonomyStats(repository, project, input.owner ?? ''),
  }
}

export const PROJECT_FACTS_DEFAULT_LIMIT = 10
export const PROJECT_FACTS_MAX_TASKS = 8
export const PROJECT_FACTS_RELATED_LIMIT = 3

const HISTORY_STOP_TERMS = new Set([
  '需求',
  '功能',
  '用户',
  '系统',
  '支持',
  '增加',
  '问题',
  '当前',
  '业务',
  '需要',
  '可以',
  '使用',
  '进行',
  'the',
  'and',
  'for',
  'with',
])

export function historyTerms(text: string): string[] {
  const lower = text.toLowerCase()
  const terms = new Set<string>()
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word)
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      terms.add(run.slice(index, index + 2))
    }
  }
  return [...terms].filter((term) => !HISTORY_STOP_TERMS.has(term))
}

export interface RelatedRequirementFact {
  readonly reqId: string
  readonly title: string
  readonly status: string
  readonly terminal: boolean
  readonly goal: string
  readonly version: number
  readonly matchedTerms: readonly string[]
  readonly updatedAt: string
}

export function relatedProjectHistory(input: {
  repository: Repository
  project: string
  currentReqId: string
  currentText: string
  limit?: number
}): RelatedRequirementFact[] {
  const terms = historyTerms(input.currentText)
  if (terms.length === 0) return []
  const limit = Math.min(10, Math.max(1, Math.trunc(input.limit ?? PROJECT_FACTS_RELATED_LIMIT)))
  const scored: RelatedRequirementFact[] = []
  for (const requirement of input.repository.listRequirements(input.project)) {
    if (requirement.reqId === input.currentReqId) continue
    const analysis = input.repository.latestAnalysis(requirement.reqId)
    const text = [
      requirementTitle(requirement),
      ...requirement.versions.map((version) => version.text),
      analysis?.goal ?? '',
      ...(analysis?.businessPoints ?? []).map((point) => point.behavior),
    ]
      .join('\n')
      .toLowerCase()
    const matched = terms.filter((term) => text.includes(term))
    if (matched.length === 0) continue
    scored.push({
      reqId: requirement.reqId,
      title: requirementTitle(requirement),
      status: requirement.status,
      terminal: isTerminal(requirement.status),
      goal: analysis?.goal ?? '',
      version: requirement.versions.length,
      matchedTerms: matched.slice(0, 8),
      updatedAt: updatedAtOf(requirement),
    })
  }
  return scored
    .sort(
      (left, right) =>
        right.matchedTerms.length - left.matchedTerms.length ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, limit)
}
const PROJECT_FACTS_LIMIT_CEILING = 50

export interface ProjectTaskFact {
  readonly taskId: string
  readonly goal: string
  readonly state: BoardTaskState
  readonly dependsOn: readonly string[]
  readonly lastActivity: string
}

export interface ProjectRequirementFact {
  readonly reqId: string
  readonly current: boolean
  readonly title: string
  readonly status: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly goal: string
  readonly planVersion: number | null
  readonly approval: 'approved' | 'missing' | 'stale' | 'none'
  readonly taskCount: number
  readonly tasks: readonly ProjectTaskFact[]
}

export interface ProjectFacts {
  readonly project: string
  readonly generatedAt: string
  readonly total: number
  readonly listed: number
  readonly notListed: number
  readonly terminal: number
  readonly requirements: readonly ProjectRequirementFact[]
  readonly relatedHistory?: readonly RelatedRequirementFact[]
}

export interface BuildProjectFactsInput {
  readonly repository: Repository
  readonly project: string
  readonly currentReqId?: string
  readonly now?: string
  readonly limit?: number
  readonly taskLimit?: number
  readonly currentText?: string
}

function clampLimit(value: number | undefined, fallback: number): number {
  const normalized = Math.trunc(value ?? fallback)
  if (!Number.isFinite(normalized)) return fallback
  return Math.min(PROJECT_FACTS_LIMIT_CEILING, Math.max(1, normalized))
}

export function buildProjectFacts(input: BuildProjectFactsInput): ProjectFacts {
  const repository = input.repository
  const all = repository.listRequirements(input.project)
  const active = all.filter((requirement) => !isTerminal(requirement.status))
  const limit = clampLimit(input.limit, PROJECT_FACTS_DEFAULT_LIMIT)
  const taskLimit = clampLimit(input.taskLimit, PROJECT_FACTS_MAX_TASKS)
  const ordered = [...active].sort((left, right) =>
    updatedAtOf(right).localeCompare(updatedAtOf(left)),
  )
  const current = input.currentReqId
    ? ordered.find((requirement) => requirement.reqId === input.currentReqId)
    : undefined
  const selected: Requirement[] = current ? [current] : []
  for (const requirement of ordered) {
    if (selected.length >= limit) break
    if (requirement.reqId === current?.reqId) continue
    selected.push(requirement)
  }

  const requirements = selected.map((requirement): ProjectRequirementFact => {
    const plan = repository.latestTaskPlan(requirement.reqId)
    const approval = plan
      ? authorizePlan(
          plan,
          repository.planApproval(requirement.reqId, plan.planVersion) ??
            repository.latestPlanApproval(requirement.reqId),
        )
      : null
    const runs = plan ? repository.taskRuns(requirement.reqId, plan.planVersion) : []
    const artifacts = plan ? repository.taskArtifacts(requirement.reqId, plan.planVersion) : []
    const delivered = new Set(artifacts.map((artifact) => artifact.taskId))
    const runByTask = new Map(runs.map((run) => [run.taskId, run]))
    const analysis = repository.latestAnalysis(requirement.reqId)
    const tasks = (plan?.tasks ?? []).slice(0, taskLimit).map((task): ProjectTaskFact => {
      const run = runByTask.get(task.taskId)
      return {
        taskId: task.taskId,
        goal: task.goal,
        state: boardTaskState({ delivered: delivered.has(task.taskId), run }),
        dependsOn: task.dependsOn,
        lastActivity: run?.updatedAt ?? '',
      }
    })
    return {
      reqId: requirement.reqId,
      current: requirement.reqId === input.currentReqId,
      title: requirementTitle(requirement),
      status: requirement.status,
      version: requirement.versions.length,
      createdAt: createdAtOf(requirement),
      updatedAt: updatedAtOf(requirement),
      goal: analysis?.goal ?? '',
      planVersion: plan?.planVersion ?? null,
      approval: approval?.status ?? 'none',
      taskCount: plan?.tasks.length ?? 0,
      tasks,
    }
  })

  return {
    project: input.project,
    generatedAt: input.now ?? new Date().toISOString(),
    total: active.length,
    listed: requirements.length,
    notListed: Math.max(0, active.length - requirements.length),
    terminal: all.length - active.length,
    requirements,
    relatedHistory: input.currentText
      ? relatedProjectHistory({
          repository,
          project: input.project,
          currentReqId: input.currentReqId ?? '',
          currentText: input.currentText,
        })
      : [],
  }
}

interface IssueContext {
  readonly requirement: Requirement
  readonly terminal: boolean
  readonly latestAnalysis: ReturnType<Repository['latestAnalysis']>
  readonly plan: TaskPlan | null
  readonly authorization: ReturnType<typeof authorizePlan> | null
  readonly planReviewView: BoardPlanReviewView | null
  readonly rounds: ReturnType<Repository['failureRounds']>
  readonly remainingRounds: number
  readonly delivered: ReadonlySet<string>
  readonly requests: ReturnType<Repository['requestsFor']>
  readonly stopRequested: boolean
}

function buildRequirementIssues(context: IssueContext): BoardIssueView[] {
  if (context.terminal) return []
  return [
    ...clarificationIssues(context),
    ...blockedIssue(context),
    ...failureIssue(context),
    ...requestIssues(context),
    ...approvalIssues(context),
  ]
}

function clarificationIssues(context: IssueContext): BoardIssueView[] {
  const { requirement, latestAnalysis, terminal } = context
  if (terminal) return []
  const updatedAt = updatedAtOf(requirement)
  return (latestAnalysis?.clarifications ?? []).map((clarification, index) => ({
    issueId: `clarification:${requirement.reqId}:v${latestAnalysis?.analysisVersion ?? 1}:${index}`,
    reqId: requirement.reqId,
    kind: ISSUE_CLARIFICATION,
    severity: 'blocking',
    title: clarification,
    detail: `分析 v${latestAnalysis?.analysisVersion ?? 1} 有待澄清项；回答前不进入实现`,
    createdAt: latestAnalysis?.createdAt ?? updatedAt,
  }))
}

function blockedIssue(context: IssueContext): BoardIssueView[] {
  const { requirement, terminal, stopRequested } = context
  if (terminal || requirement.status !== 'blocked') return []
  return [
    {
      issueId: `blocked:${requirement.reqId}`,
      reqId: requirement.reqId,
      kind: ISSUE_BLOCKED,
      severity: 'blocking',
      title: requirement.blockedReason || '需求已阻塞，未记录原因',
      detail: stopRequested
        ? '停止请求已记录；在核对工作副本、Git 与证据前，不能认定已经停稳'
        : '阻塞状态会按重新执行规则重排；额度用尽或需要处置时等待人工决定',
      createdAt: updatedAtOf(requirement),
    },
  ]
}

function failureIssue(context: IssueContext): BoardIssueView[] {
  const { requirement, plan, rounds, remainingRounds, delivered } = context
  const latestRound = rounds[rounds.length - 1]
  if (!latestRound) return []
  const latestRoundTaskId = taskIdOfFailureRound(plan, latestRound.roundId)
  if (latestRoundTaskId && delivered.has(latestRoundTaskId)) return []
  return [
    {
      issueId: `failure:${requirement.reqId}:${latestRound.roundId}`,
      reqId: requirement.reqId,
      ...(latestRoundTaskId ? { taskId: latestRoundTaskId } : {}),
      kind: ISSUE_FAILURE_ROUND,
      severity: remainingRounds === 0 ? 'blocking' : 'attention',
      title: latestRound.summary,
      detail:
        remainingRounds === 0
          ? `失败轮次 ${rounds.length} 已用尽自动处理额度；等待追加授权或人工决定`
          : Number.isFinite(remainingRounds)
            ? `失败轮次 ${rounds.length}，额度剩余 ${remainingRounds}；额度未尽时按规则自动重试`
            : `失败轮次 ${rounds.length}，额度 MAX；按规则持续自动重试`,
      createdAt: latestRound.occurredAt,
    },
  ]
}

function requestIssues(context: IssueContext): BoardIssueView[] {
  const { requirement, requests } = context
  const grouped = new Map<string, { request: (typeof requests)[number]; count: number }>()
  for (const request of requests) {
    if (request.state !== REQUEST_FAILED) continue
    const detail = request.detail || '请求执行失败，等待重新排队或人工处理'
    const key = `${request.action}\n${detail}`
    const existing = grouped.get(key)
    grouped.set(key, { request, count: (existing?.count ?? 0) + 1 })
  }
  return [...grouped.values()].map(({ request, count }) => {
    const detail = request.detail || '请求执行失败，等待重新排队或人工处理'
    return {
      issueId: `request:${request.requestId}`,
      reqId: requirement.reqId,
      kind: ISSUE_REQUEST,
      severity: 'attention',
      title: `${requestActionLabel(request.action)}请求失败${count > 1 ? `（重复 ${count} 次）` : ''}`,
      detail: count > 1 ? `${detail}；同类失败 ${count} 次，最近一次 ${request.createdAt}` : detail,
      createdAt: request.createdAt,
    }
  })
}

function approvalIssues(context: IssueContext): BoardIssueView[] {
  const { requirement, plan, authorization, planReviewView } = context
  if (
    !plan ||
    requirement.status !== PLAN_PROPOSED ||
    !authorization ||
    authorization.status === 'approved'
  ) {
    return []
  }
  if (planReviewView?.verdict === 'block') {
    return [
      {
        issueId: `plan-review:${requirement.reqId}:v${plan.planVersion}`,
        reqId: requirement.reqId,
        kind: ISSUE_APPROVAL,
        severity: 'blocking',
        title: `任务包 v${plan.planVersion} 实现前评审阻断`,
        detail: planReviewView.blocking.join('；') || planReviewView.summary,
        createdAt: planReviewView.reviewedAt,
      },
    ]
  }
  if (planReviewView?.verdict === 'pass') {
    return [
      {
        issueId: `approval:${requirement.reqId}:v${plan.planVersion}`,
        reqId: requirement.reqId,
        kind: ISSUE_APPROVAL,
        severity: 'attention',
        title: `任务包 v${plan.planVersion} 待批准`,
        detail: authorization.reason || '任务包尚未获得批准',
        createdAt: plan.createdAt,
      },
    ]
  }
  return [
    {
      issueId: `plan-review-missing:${requirement.reqId}:v${plan.planVersion}`,
      reqId: requirement.reqId,
      kind: ISSUE_APPROVAL,
      severity: 'attention',
      title: `任务包 v${plan.planVersion} 待实现前评审`,
      detail: '尚未取得测试 Agent 的实现前评审结论；不能批准或进入实现',
      createdAt: plan.createdAt,
    },
  ]
}

type BoardProgress = {
  total: number
  delivered: number
  failed: number
  awaitingUser: number
  awaitingInput: number
  blocked: number
  running: number
  pending: number
}

function buildTaskViews(context: {
  readonly requirement: Requirement
  readonly plan: TaskPlan | null
  readonly runByTask: Map<string, ReturnType<Repository['taskRuns']>[number]>
  readonly delivered: ReadonlySet<string>
  readonly remainingRounds: number
}): { tasks: BoardTaskView[]; progress: BoardProgress } {
  const { requirement, plan, runByTask, delivered, remainingRounds } = context
  const progress: BoardProgress = {
    total: plan?.tasks.length ?? 0,
    delivered: 0,
    failed: 0,
    awaitingUser: 0,
    awaitingInput: 0,
    blocked: 0,
    running: 0,
    pending: 0,
  }
  const tasks: BoardTaskView[] = []
  for (const task of plan?.tasks ?? []) {
    const run = runByTask.get(task.taskId)
    const state = boardTaskState({ delivered: delivered.has(task.taskId), run })
    progress[state === BOARD_TASK_DELIVERED ? 'delivered' : progressKey(state)] += 1
    const failureAdvice = taskAdvice(state, run, task.files, remainingRounds)
    tasks.push({
      reqId: requirement.reqId,
      planVersion: plan?.planVersion ?? 0,
      taskId: task.taskId,
      goal: task.goal,
      state,
      dependsOn: task.dependsOn,
      lastActivity: run?.updatedAt ?? '',
      failureReason: failureAdvice ? (run?.reason ?? '') : '',
      failureAdvice,
    })
  }
  return { tasks, progress }
}

function taskAdvice(
  state: BoardTaskState,
  run: ReturnType<Repository['taskRuns']>[number] | undefined,
  files: readonly string[],
  remainingRounds: number,
): TaskFailureAdvice | null {
  const needsAdvice = state === TASK_RUN_AWAITING_USER || state === 'failed' || state === 'blocked'
  if (!needsAdvice) return null
  return buildTaskFailureAdvice({ state, reason: run?.reason ?? '', files, remainingRounds })
}

function progressKey(state: BoardTaskState): keyof BoardProgress {
  if (state === 'failed') return 'failed'
  if (state === 'blocked') return 'blocked'
  if (state === 'awaiting_user') return 'awaitingUser'
  if (state === BOARD_TASK_AWAITING_INPUT) return 'awaitingInput'
  if (state === 'running') return 'running'
  return 'pending'
}

interface ActionContext {
  readonly requirement: Requirement
  readonly terminal: boolean
  readonly plan: TaskPlan | null
  readonly authorization: ReturnType<typeof authorizePlan> | null
  readonly planReviewView: BoardPlanReviewView | null
  readonly planValid: boolean
  readonly progress: BoardProgress
  readonly retry: ReturnType<typeof retryDecision>
  readonly remainingRounds: number
  readonly activeRequest: boolean
  readonly verificationFresh: boolean
  readonly verificationView: BoardVerificationView | null
  readonly candidateView: BoardCandidateView | null
  readonly deploymentView: BoardDeploymentView | null
  readonly businessReviewView: BoardBusinessReviewView | null
}

function buildRequirementActions(context: ActionContext): BoardRequirementAction[] {
  const flow = context.terminal ? [] : buildFlowActions(context)
  return [...flow, ...buildReleaseActions(context)]
}

function buildFlowActions(context: ActionContext): BoardRequirementAction[] {
  const { progress, retry } = context
  const actions: BoardRequirementAction[] = []
  applyPlanAction(actions, context)
  if (context.requirement.status === ANALYSIS_FAILED && !context.activeRequest) {
    actions.push('retry-analysis')
  }
  if (canAdvance(context)) actions.push('advance')
  if (retry.allowed) actions.push('requeue')
  if (context.requirement.blockedReason.includes('工时已用尽')) {
    actions.push('extend-budget')
  }
  if (
    context.requirement.blockedReason.includes('额度已用尽') ||
    context.requirement.blockedReason.includes('需要追加授权')
  ) {
    actions.push('grant-rounds')
  }
  if (canVerify(context)) actions.push('verify')
  if (context.activeRequest || progress.running > 0 || progress.awaitingInput > 0) {
    actions.push('stop')
  }
  actions.push('cancel')
  return actions
}

function applyPlanAction(actions: BoardRequirementAction[], context: ActionContext): void {
  const { requirement, plan, authorization, planReviewView, planValid, progress } = context
  const pendingPlan =
    requirement.status === PLAN_PROPOSED &&
    plan !== null &&
    authorization !== null &&
    authorization.status !== 'approved'
  if (!pendingPlan) return
  if (planReviewView?.verdict === 'pass' && planValid) actions.push('approve')
  else if (!context.activeRequest && progress.running === 0) actions.push('plan')
}

function canAdvance(context: ActionContext): boolean {
  const { requirement, authorization, progress, remainingRounds } = context
  return (
    authorization?.status === 'approved' &&
    (requirement.status === APPROVED || requirement.status === EXECUTING) &&
    progress.delivered < progress.total &&
    remainingRounds !== 0 &&
    progress.running === 0 &&
    progress.awaitingInput === 0 &&
    !context.activeRequest
  )
}

function canVerify(context: ActionContext): boolean {
  const { requirement, authorization, progress, remainingRounds, verificationFresh } = context
  return (
    authorization?.status === 'approved' &&
    (requirement.status === APPROVED || requirement.status === EXECUTING) &&
    progress.total > 0 &&
    progress.delivered === progress.total &&
    remainingRounds !== 0 &&
    context.planReviewView?.verdict === 'pass' &&
    progress.running === 0 &&
    progress.awaitingInput === 0 &&
    !context.activeRequest &&
    !(verificationFresh && context.verificationView !== null)
  )
}

function buildReleaseActions(context: ActionContext): BoardRequirementAction[] {
  return [...committedActions(context), ...acceptedActions(context)]
}

function committedActions(context: ActionContext): BoardRequirementAction[] {
  const { requirement, candidateView, deploymentView, verificationView } = context
  if (requirement.status !== 'committed') return []
  const actions: BoardRequirementAction[] = []
  if (candidateView === null && verificationView?.verdict === 'pass') actions.push('build')
  if (candidateView !== null && deploymentView?.state !== 'verified') actions.push('deploy')
  return actions
}

function acceptedActions(context: ActionContext): BoardRequirementAction[] {
  const { requirement, candidateView, deploymentView, verificationFresh, verificationView } =
    context
  if (requirement.status !== 'accepted') return []
  const actions: BoardRequirementAction[] = []
  const verified = verificationFresh && verificationView?.verdict === 'pass'
  const reviewed =
    verified &&
    context.businessReviewView?.fresh === true &&
    context.businessReviewView.verdict === 'pass'
  if (reviewed && candidateView === null) actions.push('build')
  if (candidateView !== null && deploymentView?.state !== 'verified') actions.push('deploy')
  return actions
}

function candidateSha256Of(
  plan: TaskPlan | null,
  artifacts: ReturnType<Repository['taskArtifacts']>,
): string {
  if (!plan || artifacts.length !== plan.tasks.length) return ''
  const ordered = plan.tasks.map((task) =>
    artifacts.find((artifact) => artifact.taskId === task.taskId),
  )
  const first = ordered[0]
  if (!first) return ''
  return candidateIdentityOf({
    planVersion: plan.planVersion,
    requirementVersion: plan.requirementVersion,
    baselineCommit: first.baselineCommit,
    candidateHashes: ordered.map((artifact) => artifact?.candidateSha256 ?? ''),
  })
}

function verificationIsFresh(
  verificationRecord: ReturnType<Repository['verification']>,
  candidateSha256: string,
  requirementVersions: number,
): boolean {
  return (
    verificationRecord !== null &&
    candidateSha256 !== '' &&
    verificationRecord.candidateSha256 === candidateSha256 &&
    verificationRecord.requirementVersion === requirementVersions
  )
}

function planIsValid(plan: TaskPlan | null): boolean {
  if (!plan) return false
  try {
    validateTaskPlan(plan)
    return true
  } catch {
    return false
  }
}

interface RecordViewsInput {
  readonly repository: Repository
  readonly requirement: Requirement
  readonly plan: TaskPlan | null
  readonly reviewRecord: ReturnType<Repository['planReview']>
  readonly reviewReport: PlanReview | null
  readonly verificationRecord: ReturnType<Repository['verification']>
  readonly verificationReport: VerificationReport | null
  readonly verificationFresh: boolean
  readonly currentCandidateSha256: string
}

function buildRecordViews(input: RecordViewsInput): {
  planReviewView: BoardPlanReviewView | null
  verificationView: BoardVerificationView | null
  businessReviewView: BoardBusinessReviewView | null
  candidateView: BoardCandidateView | null
  deploymentView: BoardDeploymentView | null
} {
  const { repository, requirement, plan, reviewRecord, reviewReport } = input
  const { verificationRecord, verificationReport, verificationFresh, currentCandidateSha256 } =
    input
  const planReviewView: BoardPlanReviewView | null = reviewRecord
    ? {
        verdict: reviewRecord.verdict,
        summary: reviewReport?.summary ?? '',
        blocking: reviewReport?.blocking ?? [],
        reviewedAt: reviewRecord.reviewedAt,
      }
    : null
  const verificationView: BoardVerificationView | null = verificationRecord
    ? {
        verdict: verificationRecord.verdict,
        fresh: verificationFresh,
        summary: verificationReport?.summary ?? '',
        blocking: verificationReport?.blocking ?? [],
        candidateSha256: verificationRecord.candidateSha256,
        verifiedAt: verificationRecord.verifiedAt,
      }
    : null
  const businessReviewRecord = plan
    ? currentCandidateSha256
      ? repository.businessReviewForCandidate(
          requirement.reqId,
          plan.planVersion,
          currentCandidateSha256,
        )
      : repository.businessReview(requirement.reqId, plan.planVersion)
    : null
  return {
    planReviewView,
    verificationView,
    businessReviewView: buildBusinessReviewView(
      businessReviewRecord,
      currentCandidateSha256,
      verificationRecord,
    ),
    candidateView: buildCandidateView(
      plan ? repository.candidateBuild(requirement.reqId, plan.planVersion) : null,
    ),
    deploymentView: buildDeploymentView(
      plan ? repository.deployment(requirement.reqId, plan.planVersion) : null,
    ),
  }
}

function buildBusinessReviewView(
  record: ReturnType<Repository['businessReview']>,
  candidateSha256: string,
  verificationRecord: ReturnType<Repository['verification']>,
): BoardBusinessReviewView | null {
  if (!record) return null
  let summary = ''
  let blocking: string[] = []
  const parsed = bestEffortValue(() => parseJsonObject(record.reportJson), {})
  summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  blocking = Array.isArray(parsed.blocking) ? parsed.blocking.map(String) : []
  return {
    verdict: record.verdict,
    fresh:
      candidateSha256 !== '' &&
      record.candidateSha256 === candidateSha256 &&
      verificationRecord !== null &&
      record.verificationSha256 === verificationRecord.reportSha256,
    summary,
    blocking,
    candidateSha256: record.candidateSha256,
    reviewedAt: record.reviewedAt,
  }
}

function buildCandidateView(
  record: ReturnType<Repository['candidateBuild']>,
): BoardCandidateView | null {
  if (!record) return null
  return {
    candidateSha256: record.candidateSha256,
    packageVersion: record.packageVersion,
    artifactSha256: record.artifactSha256,
    builtAt: record.builtAt,
    verificationSha256: record.verificationSha256,
  }
}

function buildDeploymentView(
  record: ReturnType<Repository['deployment']>,
): BoardDeploymentView | null {
  if (!record) return null
  return {
    state: record.state,
    targetProfile: record.targetProfile,
    runtimeVersion: record.runtimeVersion,
    packageVersion: record.packageVersion,
    artifactSha256: record.artifactSha256,
    recordedAt: record.recordedAt,
    failedChecks: record.checks
      .filter(
        (check): check is { id: string; ok: boolean; detail: string } =>
          typeof check === 'object' && check !== null,
      )
      .filter((check) => !check.ok)
      .map((check) => `${check.id}：${check.detail}`),
  }
}

function remainingRoundsOf(
  reqId: string,
  grants: number,
  used: number,
  resolve?: (reqId: string) => number,
): number {
  if (resolve) return resolve(reqId)
  return Math.max(0, grants * MAX_ROUNDS_PER_GRANT - used)
}

function collectRequirementFacts(
  repository: Repository,
  requirement: Requirement,
  remainingFailureRounds?: (reqId: string) => number,
): {
  terminal: boolean
  latestAnalysis: ReturnType<Repository['latestAnalysis']>
  plan: ReturnType<Repository['latestTaskPlan']>
  approvalRecord: ReturnType<Repository['planApproval']>
  authorization: ReturnType<typeof authorizePlan> | null
  artifacts: ReturnType<Repository['taskArtifacts']>
  runs: ReturnType<Repository['taskRuns']>
  delivered: Set<string>
  runByTask: Map<string, ReturnType<Repository['taskRuns']>[number]>
  rounds: ReturnType<Repository['failureRounds']>
  grants: number
  remainingRounds: number
  requests: ReturnType<Repository['requestsFor']>
  activeRequest: boolean
  stopRequested: boolean
  reviewRecord: ReturnType<Repository['planReview']>
  reviewReport: PlanReview | null
  verificationRecord: ReturnType<Repository['verification']>
  verificationReport: VerificationReport | null
  currentCandidateSha256: string
  verificationFresh: boolean
  planValid: boolean
  planReviewView: BoardPlanReviewView | null
  verificationView: BoardVerificationView | null
  businessReviewView: BoardBusinessReviewView | null
  candidateView: BoardCandidateView | null
  deploymentView: BoardDeploymentView | null
} {
  const terminal = isTerminal(requirement.status)
  const latestAnalysis = repository.latestAnalysis(requirement.reqId)
  const plan = repository.latestTaskPlan(requirement.reqId)
  const commitRecord = repository.latestCommit(requirement.reqId)
  const approvalRecord = plan
    ? (repository.planApproval(requirement.reqId, plan.planVersion) ??
      repository.latestPlanApproval(requirement.reqId))
    : null
  const authorization = plan ? authorizePlan(plan, approvalRecord) : null
  const artifacts = plan ? repository.taskArtifacts(requirement.reqId, plan.planVersion) : []
  const runs = plan ? repository.taskRuns(requirement.reqId, plan.planVersion) : []
  const delivered = new Set(artifacts.map((artifact) => artifact.taskId))
  const runByTask = new Map(runs.map((run) => [run.taskId, run]))
  const rounds = repository.failureRounds(requirement.reqId)
  const grants = repository.grantCount(requirement.reqId)
  const remainingRounds = remainingRoundsOf(
    requirement.reqId,
    grants,
    rounds.length,
    remainingFailureRounds,
  )
  const requests = repository.requestsFor(requirement.reqId)
  const activeRequest = requests.some(
    (request) => request.state === 'pending' || request.state === 'claimed',
  )
  const stopRequested = repository.activeStop(requirement.reqId) !== null
  const reviewRecord = plan ? repository.planReview(requirement.reqId, plan.planVersion) : null
  const reviewReport: PlanReview | null = (() => {
    if (!reviewRecord) return null
    try {
      return parsePlanReview(reviewRecord.reportJson)
    } catch {
      return null
    }
  })()
  const verificationRecord = plan
    ? commitRecord
      ? repository.verificationForCandidate(
          requirement.reqId,
          plan.planVersion,
          commitRecord.candidateSha256,
        )
      : repository.verification(requirement.reqId, plan.planVersion)
    : null
  const verificationReport: VerificationReport | null = (() => {
    if (!verificationRecord) return null
    try {
      return parseVerificationReport(verificationRecord.reportJson)
    } catch {
      return null
    }
  })()
  const currentCandidateSha256 = commitRecord?.candidateSha256 || candidateSha256Of(plan, artifacts)
  const verificationFresh = verificationIsFresh(
    verificationRecord,
    currentCandidateSha256,
    requirement.versions.length,
  )
  const planValid = planIsValid(plan)
  const { planReviewView, verificationView, businessReviewView, candidateView, deploymentView } =
    buildRecordViews({
      repository,
      requirement,
      plan,
      reviewRecord,
      reviewReport,
      verificationRecord,
      verificationReport,
      verificationFresh,
      currentCandidateSha256,
    })
  return {
    terminal,
    latestAnalysis,
    plan,
    approvalRecord,
    artifacts,
    authorization,
    runs,
    delivered,
    runByTask,
    rounds,
    grants,
    remainingRounds,
    requests,
    activeRequest,
    stopRequested,
    currentCandidateSha256,
    verificationFresh,
    reviewRecord,
    reviewReport,
    verificationRecord,
    verificationReport,
    planValid,
    planReviewView,
    verificationView,
    businessReviewView,
    candidateView,
    deploymentView,
  }
}

function buildRequirementChunk(
  repository: Repository,
  requirement: Requirement,
  remainingFailureRounds?: (reqId: string) => number,
): RequirementChunk {
  const {
    terminal,
    latestAnalysis,
    plan,
    authorization,
    runs,
    delivered,
    runByTask,
    rounds,
    grants,
    remainingRounds,
    requests,
    activeRequest,
    stopRequested,
    verificationFresh,
    planValid,
    planReviewView,
    verificationView,
    businessReviewView,
    candidateView,
    deploymentView,
  } = collectRequirementFacts(repository, requirement, remainingFailureRounds)

  const { tasks: requirementTasks, progress } = buildTaskViews({
    requirement,
    plan,
    runByTask,
    delivered,
    remainingRounds,
  })

  const retry = retryDecision({
    status: requirement.status,
    blockedReason: requirement.blockedReason,
    remainingRounds,
    activeRequest,
    runningTasks: progress.running,
    awaitingInputTasks: progress.awaitingInput,
    planApproved: authorization?.status === 'approved',
    delivered: progress.delivered,
    total: progress.total,
  })

  const actions = buildRequirementActions({
    requirement,
    terminal,
    plan,
    authorization,
    planReviewView,
    planValid,
    progress,
    retry,
    remainingRounds,
    activeRequest,
    verificationFresh,
    verificationView,
    candidateView,
    deploymentView,
    businessReviewView,
  })

  const view: BoardRequirementView = {
    reqId: requirement.reqId,
    title: requirementTitle(requirement),
    status: requirement.status,
    version: requirement.versions.length,
    planVersion: plan?.planVersion ?? null,
    approval: authorization?.status ?? 'none',
    source: requirement.source,
    submittedBy: requirement.submittedBy,
    planReview: planReviewView,
    verification: verificationView,
    businessReview: businessReviewView,
    retry,
    candidate: candidateView,
    deployment: deploymentView,
    clarifications: latestAnalysis?.clarifications.length ?? 0,
    failureRounds: rounds.length,
    grants,
    remainingRounds: Number.isFinite(remainingRounds) ? remainingRounds : null,
    actions,
    stopRequested,
    activeRequest,
    progress,
    updatedAt: updatedAtOf(requirement),
  }

  const requirementIssues = buildRequirementIssues({
    requirement,
    terminal,
    latestAnalysis,
    plan,
    authorization,
    planReviewView,
    rounds,
    remainingRounds,
    delivered,
    requests,
    stopRequested,
  })

  return {
    requirement,
    view,
    tasks: requirementTasks,
    issues: requirementIssues,
    haystack: haystackOf({
      requirement,
      view,
      tasks: requirementTasks,
      issues: requirementIssues,
      analysis: latestAnalysis,
      plan,
      runs,
      rounds,
      requests,
    }),
  }
}
