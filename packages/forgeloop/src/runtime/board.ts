/**
 * 只读状态看板：把需求、任务与待处理问题的当前状态整理成页面直接渲染的事实视图。
 *
 * 约束：
 * - 只读记录，不批准、不推进、不验收，也不写任何行；
 * - 每个条目都能回查到权威记录（需求、任务包、产物、运行、请求、失败轮次），
 *   缺失与未知如实显示，不用推测补齐；
 * - 需求只取最新任务包：旧任务包的未交付任务已由影响摘要单独标注为 pending，
 *   看板不把它重复算成当前任务；
 * - 终态需求不再产生待处理问题，但仍在需求列中显示其最终状态。
 * - 搜索只扫描权威记录中的文字事实，不读取日志内容，也不虚构结果。
 */

import type { Repository } from '../records/repository.js'
import type { Requirement } from '../domain/requirement.js'
import { authorizePlan, type TaskPlan } from '../domain/task-plan.js'
import { candidateIdentityOf } from '../domain/delivery.js'
import { validateTaskPlan } from '../domain/task-plan.js'
import { parsePlanReview, parseVerificationReport, type PlanReview, type VerificationReport } from '../domain/verification.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import { buildTaskFailureAdvice, type TaskFailureAdvice } from '../domain/failure-advice.js'
import {
  ACTION_ANALYZE,
  ACTION_PLAN,
  ACTION_ADVANCE,
  ACTION_VERIFY,
  APPROVED,
  EXECUTING,
  REQUEST_UNKNOWN,
  REQUEST_FAILED,
  PLAN_PROPOSED,
  isTerminal,
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'

/** 页面默认展示的需求条数；更早的历史仍在权威记录中可回查。 */
export const BOARD_DEFAULT_LIMIT = 20
/** 一次看板请求允许的最大需求条数，避免页面一次渲染过多记录。 */
export const BOARD_MAX_LIMIT = 100
/** 问题列的展示上限，避免一次渲染过长列表。 */
export const BOARD_MAX_ISSUES = 60

export const BOARD_TASK_DELIVERED = 'delivered'
export const BOARD_TASK_PENDING = 'pending'
/** 运行中且最近活动显示 Agent 正在等待人工输入（不是自动推进的证明）。 */
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
  /** 最近一次心跳/状态更新时间；待执行任务为空。 */
  readonly lastActivity: string
  /** 失败/阻塞/待决定时记录的原因；其他状态为空。 */
  readonly failureReason: string
  /** 依据记录与原因给出的下一步建议；非失败状态为 null。 */
  readonly failureAdvice: TaskFailureAdvice | null
  /** 该需求是否存在结果未知（unknown）请求；有则任务结果不能当作已收口。 */
  readonly resultUnknown: boolean
}

export type BoardRequirementAction =
  | 'plan'
  | 'approve'
  | 'advance'
  | 'verify'
  | 'recover'
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
  readonly planVersion: number | null
  readonly approval: 'approved' | 'missing' | 'stale' | 'none'
  readonly planReview: BoardPlanReviewView | null
  readonly verification: BoardVerificationView | null
  readonly businessReview: BoardBusinessReviewView | null
  readonly candidate: BoardCandidateView | null
  readonly deployment: BoardDeploymentView | null
  readonly clarifications: number
  readonly failureRounds: number
  readonly grants: number
  readonly remainingRounds: number
  /** 服务端按当前记录判定可用的需求级动作；页面只展示，不自行放行。 */
  readonly actions: readonly BoardRequirementAction[]
  /** 需求处于“停止请求”阻塞原因下；不等于已经停稳。 */
  readonly stopRequested: boolean
  readonly unknownRequests: number
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
  /** 能可靠关联到任务时才给出；失败轮次按任务身份前缀匹配。 */
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
  /** 本次搜索词；空字符串表示未搜索。 */
  readonly query: string
  readonly limit: number
  /** 是否因条数上限截断了匹配结果。 */
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
}

export interface BuildStatusBoardInput {
  readonly repository: Repository
  readonly project: string
  /** 生成时间；测试传入固定值以保持结果确定。 */
  readonly now?: string
  readonly limit?: number
  /**
   * 搜索词。匹配范围：需求身份/状态/原文与版本、分析结论、最新任务包与任务字段、
   * 任务运行原因、失败轮次、请求说明与看板问题文字；不读取 Agent 日志文件。
   */
  readonly query?: string
}

/**
 * 任务当前状态：交付产物优先，其次最近一次运行状态；没有运行记录即待执行。
 * 运行中且最近活动显示等待人工输入时单独标出，不能当作普通执行中。
 */
export function boardTaskState(input: {
  readonly delivered: boolean
  readonly run?: { readonly state: string; readonly reason: string }
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

/** 需求标题：最新版本原文的首个非空行，超长截断；不反写原文。 */
export function requirementTitle(requirement: Requirement): string {
  const latest = requirement.versions[requirement.versions.length - 1]
  const firstLine = (latest?.text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return requirement.reqId
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/** 最新版本时间：用于需求列排序与问题时间，不改变记录顺序。 */
function updatedAtOf(requirement: Requirement): string {
  return requirement.versions[requirement.versions.length - 1]?.createdAt ?? ''
}

/** 需求首次受理时间。 */
function createdAtOf(requirement: Requirement): string {
  return requirement.versions[0]?.createdAt ?? ''
}

function requestActionLabel(action: string): string {
  if (action === ACTION_ANALYZE) return '分析'
  if (action === ACTION_PLAN) return '规划'
  if (action === ACTION_ADVANCE) return '推进'
  if (action === ACTION_VERIFY) return '独立验证'
  return action
}

/** 从失败轮次 ID 前缀找出对应任务；找不到时不猜测。 */
export function taskIdOfFailureRound(plan: TaskPlan | null, roundId: string): string | undefined {
  if (!plan) return undefined
  return plan.tasks
    .map((task) => task.taskId)
    .filter((taskId) => roundId.startsWith(`${taskId}-`))
    .sort((left, right) => right.length - left.length)[0]
}

const SEVERITY_RANK: Record<BoardIssueSeverity, number> = { blocking: 0, attention: 1 }

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
    parts.push(analysis.goal, ...analysis.scenarios, ...analysis.acceptanceCriteria, ...analysis.clarifications)
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

/**
 * 从一个项目的权威记录生成看板视图。
 * @param input.repository 已打开的记录仓库（调用方负责关闭）。
 * @param input.project 项目标识；只读取该项目的需求。
 * @param input.now ISO 时间，默认当前时刻。
 * @param input.limit 需求条数上限，默认 {@link BOARD_DEFAULT_LIMIT}，最大 {@link BOARD_MAX_LIMIT}。
 * @param input.query 搜索词；空字符串表示不搜索。
 */
export function buildStatusBoard(input: BuildStatusBoardInput): StatusBoardView {
  const { repository, project } = input
  const now = input.now ?? new Date().toISOString()
  const limit = Math.min(BOARD_MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? BOARD_DEFAULT_LIMIT)))
  const query = (input.query ?? '').trim().slice(0, 200)
  const all = repository.listRequirements(project)

  const chunks: RequirementChunk[] = []

  for (const requirement of all) {
    const terminal = isTerminal(requirement.status)
    const latestAnalysis = repository.latestAnalysis(requirement.reqId)
    const plan = repository.latestTaskPlan(requirement.reqId)
    // 精确批准优先；只有旧版本批准时仍判为 stale，不能驱动当前任务包。
    const approvalRecord = plan
      ? repository.planApproval(requirement.reqId, plan.planVersion) ??
        repository.latestPlanApproval(requirement.reqId)
      : null
    const authorization = plan ? authorizePlan(plan, approvalRecord) : null
    const artifacts = plan ? repository.taskArtifacts(requirement.reqId, plan.planVersion) : []
    const runs = plan ? repository.taskRuns(requirement.reqId, plan.planVersion) : []
    const delivered = new Set(artifacts.map((artifact) => artifact.taskId))
    const runByTask = new Map(runs.map((run) => [run.taskId, run]))
    const rounds = repository.failureRounds(requirement.reqId)
    const grants = repository.grantCount(requirement.reqId)
    const remainingRounds = Math.max(0, grants * MAX_ROUNDS_PER_GRANT - rounds.length)
    const requests = repository.requestsFor(requirement.reqId)
    const unknownRequests = requests.filter((request) => request.state === REQUEST_UNKNOWN).length
    const activeRequest = requests.some(
      (request) => request.state === 'pending' || request.state === 'claimed',
    )
    const stopRequested = requirement.blockedReason.startsWith('停止请求')
    const reviewRecord = plan ? repository.planReview(requirement.reqId, plan.planVersion) : null
    const reviewReport: PlanReview | null = (() => {
      if (!reviewRecord) return null
      try {
        return parsePlanReview(reviewRecord.reportJson)
      } catch {
        return null
      }
    })()
    const verificationRecord = plan ? repository.verification(requirement.reqId, plan.planVersion) : null
    const verificationReport: VerificationReport | null = (() => {
      if (!verificationRecord) return null
      try {
        return parseVerificationReport(verificationRecord.reportJson)
      } catch {
        return null
      }
    })()
    const currentCandidateSha256 = (() => {
      if (!plan || artifacts.length !== plan.tasks.length) return ''
      const ordered = plan.tasks.map((task) => artifacts.find((artifact) => artifact.taskId === task.taskId))
      if (ordered.some((artifact) => !artifact)) return ''
      return candidateIdentityOf({
        planVersion: plan.planVersion,
        requirementVersion: plan.requirementVersion,
        baselineCommit: ordered[0]!.baselineCommit,
        candidateHashes: ordered.map((artifact) => artifact!.candidateSha256),
      })
    })()
    const verificationFresh =
      verificationRecord !== null &&
      currentCandidateSha256 !== '' &&
      verificationRecord.candidateSha256 === currentCandidateSha256 &&
      verificationRecord.requirementVersion === requirement.versions.length
    const planValid = (() => {
      if (!plan) return false
      try {
        validateTaskPlan(plan)
        return true
      } catch {
        return false
      }
    })()
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

    const businessReviewRecord = repository.businessReview(requirement.reqId, plan?.planVersion ?? 0)
    const businessReviewView: BoardBusinessReviewView | null = businessReviewRecord
      ? {
          verdict: businessReviewRecord.verdict,
          fresh:
            currentCandidateSha256 !== '' &&
            businessReviewRecord.candidateSha256 === currentCandidateSha256 &&
            verificationRecord !== null &&
            businessReviewRecord.verificationSha256 === verificationRecord.reportSha256,
          summary: (() => {
            try {
              return (JSON.parse(businessReviewRecord.reportJson) as { summary?: string }).summary ?? ''
            } catch {
              return ''
            }
          })(),
          blocking: (() => {
            try {
              const parsed = JSON.parse(businessReviewRecord.reportJson) as { blocking?: unknown }
              return Array.isArray(parsed.blocking) ? parsed.blocking.map(String) : []
            } catch {
              return []
            }
          })(),
          candidateSha256: businessReviewRecord.candidateSha256,
          reviewedAt: businessReviewRecord.reviewedAt,
        }
      : null
    const buildRecord = plan ? repository.candidateBuild(requirement.reqId, plan.planVersion) : null
    const candidateView: BoardCandidateView | null = buildRecord
      ? {
          candidateSha256: buildRecord.candidateSha256,
          packageVersion: buildRecord.packageVersion,
          artifactSha256: buildRecord.artifactSha256,
          builtAt: buildRecord.builtAt,
          verificationSha256: buildRecord.verificationSha256,
        }
      : null
    const deploymentRecord = plan ? repository.deployment(requirement.reqId, plan.planVersion) : null
    const deploymentView: BoardDeploymentView | null = deploymentRecord
      ? {
          state: deploymentRecord.state,
          targetProfile: deploymentRecord.targetProfile,
          runtimeVersion: deploymentRecord.runtimeVersion,
          packageVersion: deploymentRecord.packageVersion,
          artifactSha256: deploymentRecord.artifactSha256,
          recordedAt: deploymentRecord.recordedAt,
          failedChecks: deploymentRecord.checks
            .filter((check): check is { id: string; ok: boolean; detail: string } => typeof check === 'object' && check !== null)
            .filter((check) => check.ok === false)
            .map((check) => `${check.id}：${check.detail}`),
        }
      : null

    const progress = {
      total: plan?.tasks.length ?? 0,
      delivered: 0,
      failed: 0,
      awaitingUser: 0,
      awaitingInput: 0,
      blocked: 0,
      running: 0,
      pending: 0,
    }
    const requirementTasks: BoardTaskView[] = []

    for (const task of plan?.tasks ?? []) {
      const run = runByTask.get(task.taskId)
      const state = boardTaskState({ delivered: delivered.has(task.taskId), run })

      if (state === BOARD_TASK_DELIVERED) progress.delivered += 1
      else if (state === 'failed') progress.failed += 1
      else if (state === 'blocked') progress.blocked += 1
      else if (state === 'awaiting_user') progress.awaitingUser += 1
      else if (state === BOARD_TASK_AWAITING_INPUT) progress.awaitingInput += 1
      else if (state === 'running') progress.running += 1
      else progress.pending += 1

      const failureAdvice =
        state === TASK_RUN_AWAITING_USER || state === 'failed' || state === 'blocked'
          ? buildTaskFailureAdvice({
              state,
              reason: run?.reason ?? '',
              files: task.files,
              remainingRounds,
            })
          : null

      requirementTasks.push({
        reqId: requirement.reqId,
        planVersion: plan!.planVersion,
        taskId: task.taskId,
        goal: task.goal,
        state,
        dependsOn: task.dependsOn,
        lastActivity: run?.updatedAt ?? '',
        failureReason: failureAdvice ? (run?.reason ?? '') : '',
        failureAdvice,
        resultUnknown: unknownRequests > 0 && state !== BOARD_TASK_DELIVERED,
      })
    }

    const actions: BoardRequirementAction[] = []
    if (!terminal) {
      if (
        requirement.status === PLAN_PROPOSED &&
        plan !== null &&
        authorization !== null &&
        authorization.status !== 'approved'
      ) {
        if (planReviewView?.verdict === 'pass' && planValid) {
          actions.push('approve')
        } else if (!activeRequest && progress.running === 0) {
          actions.push('plan')
        }
      }
      if (
        authorization?.status === 'approved' &&
        (requirement.status === APPROVED || requirement.status === EXECUTING) &&
        progress.delivered < progress.total &&
        remainingRounds > 0 &&
        progress.running === 0 &&
        progress.awaitingInput === 0 &&
        !activeRequest
      ) {
        actions.push('advance')
      }
      if (
        authorization?.status === 'approved' &&
        (requirement.status === APPROVED || requirement.status === EXECUTING) &&
        progress.total > 0 &&
        progress.delivered === progress.total &&
        remainingRounds > 0 &&
        planReviewView?.verdict === 'pass' &&
        progress.running === 0 &&
        progress.awaitingInput === 0 &&
        !activeRequest &&
        !(verificationFresh && verificationView !== null)
      ) {
        actions.push('verify')
      }
      if (unknownRequests > 0 && progress.running === 0 && progress.awaitingInput === 0 && !activeRequest) {
        actions.push('recover')
      }
      if (activeRequest || progress.running > 0 || progress.awaitingInput > 0) actions.push('stop')
      actions.push('cancel')
    }
    // 验收后（终态）仍可构建与上线核对：它们绑定已验收材料，不重新推进需求。
    if (
      requirement.status === 'accepted' &&
      verificationFresh &&
      verificationView?.verdict === 'pass' &&
      businessReviewView?.fresh === true &&
      businessReviewView.verdict === 'pass' &&
      candidateView === null
    ) {
      actions.push('build')
    }
    if (
      requirement.status === 'accepted' &&
      candidateView !== null &&
      deploymentView?.state !== 'verified'
    ) {
      actions.push('deploy')
    }

    const view: BoardRequirementView = {
      reqId: requirement.reqId,
      title: requirementTitle(requirement),
      status: requirement.status,
      version: requirement.versions.length,
      planVersion: plan?.planVersion ?? null,
      approval: authorization?.status ?? 'none',
      planReview: planReviewView,
      verification: verificationView,
      businessReview: businessReviewView,
      candidate: candidateView,
      deployment: deploymentView,
      clarifications: latestAnalysis?.clarifications.length ?? 0,
      failureRounds: rounds.length,
      grants,
      remainingRounds,
      actions,
      stopRequested,
      unknownRequests,
      activeRequest,
      progress,
      updatedAt: updatedAtOf(requirement),
    }

    const requirementIssues: BoardIssueView[] = []
    if (!terminal) {
      const updatedAt = updatedAtOf(requirement)

      for (const [index, clarification] of (latestAnalysis?.clarifications ?? []).entries()) {
        requirementIssues.push({
          issueId: `clarification:${requirement.reqId}:v${latestAnalysis?.analysisVersion ?? 1}:${index}`,
          reqId: requirement.reqId,
          kind: ISSUE_CLARIFICATION,
          severity: 'blocking',
          title: clarification,
          detail: `分析 v${latestAnalysis?.analysisVersion ?? 1} 有待澄清项；回答前不进入实现`,
          createdAt: latestAnalysis?.createdAt ?? updatedAt,
        })
      }

      if (requirement.status === 'blocked') {
        requirementIssues.push({
          issueId: `blocked:${requirement.reqId}`,
          reqId: requirement.reqId,
          kind: ISSUE_BLOCKED,
          severity: 'blocking',
          title: requirement.blockedReason || '需求已阻塞，未记录原因',
          detail:
            stopRequested || unknownRequests > 0
              ? '停止请求或中断已记录；在核对工作副本、Git 与证据前，不能认定已经停稳或没有副作用'
              : '阻塞状态需要人工核对现场后决定下一步；不会自动重试',
          createdAt: updatedAt,
        })
      }

      const latestRound = rounds[rounds.length - 1]
      const latestRoundTaskId = latestRound ? taskIdOfFailureRound(plan, latestRound.roundId) : undefined
      // 已交付任务的旧失败轮次是历史证据，不再作为待处理问题占据首屏。
      if (latestRound && !(latestRoundTaskId && delivered.has(latestRoundTaskId))) {
        const taskId = latestRoundTaskId
        requirementIssues.push({
          issueId: `failure:${requirement.reqId}:${latestRound.roundId}`,
          reqId: requirement.reqId,
          ...(taskId ? { taskId } : {}),
          kind: ISSUE_FAILURE_ROUND,
          severity: remainingRounds === 0 ? 'blocking' : 'attention',
          title: latestRound.summary,
          detail:
            remainingRounds === 0
              ? `失败轮次 ${rounds.length} 已用尽自动处理额度；等待追加授权或人工决定`
              : `失败轮次 ${rounds.length}，额度剩余 ${remainingRounds}；额度未尽时按规则自动重试`,
          createdAt: latestRound.occurredAt,
        })
      }

      for (const request of requests) {
        if (request.state !== REQUEST_UNKNOWN && request.state !== REQUEST_FAILED) continue
        requirementIssues.push({
          issueId: `request:${request.requestId}`,
          reqId: requirement.reqId,
          kind: ISSUE_REQUEST,
          severity: request.state === REQUEST_UNKNOWN ? 'blocking' : 'attention',
          title: `${requestActionLabel(request.action)}请求${request.state === REQUEST_UNKNOWN ? '结果未知' : '失败'}`,
          detail:
            request.state === REQUEST_UNKNOWN
              ? `${request.detail ? `${request.detail}；` : ''}结果未知：先核对工作副本、Git 与产物，不盲目重放`
              : request.detail || '请求执行失败，等待重新排队或人工处理',
          createdAt: request.createdAt,
        })
      }

      if (
        plan &&
        requirement.status === PLAN_PROPOSED &&
        authorization &&
        authorization.status !== 'approved'
      ) {
        if (planReviewView?.verdict === 'block') {
          requirementIssues.push({
            issueId: `plan-review:${requirement.reqId}:v${plan.planVersion}`,
            reqId: requirement.reqId,
            kind: ISSUE_APPROVAL,
            severity: 'blocking',
            title: `任务包 v${plan.planVersion} 实现前评审阻断`,
            detail: planReviewView.blocking.join('；') || planReviewView.summary,
            createdAt: planReviewView.reviewedAt,
          })
        } else if (planReviewView?.verdict === 'pass') {
          requirementIssues.push({
            issueId: `approval:${requirement.reqId}:v${plan.planVersion}`,
            reqId: requirement.reqId,
            kind: ISSUE_APPROVAL,
            severity: 'attention',
            title: `任务包 v${plan.planVersion} 待批准`,
            detail: authorization.reason || '任务包尚未获得批准',
            createdAt: plan.createdAt,
          })
        } else {
          requirementIssues.push({
            issueId: `plan-review-missing:${requirement.reqId}:v${plan.planVersion}`,
            reqId: requirement.reqId,
            kind: ISSUE_APPROVAL,
            severity: 'attention',
            title: `任务包 v${plan.planVersion} 待实现前评审`,
            detail: '尚未取得验证 Agent 的实现前评审结论；不能批准或进入实现',
            createdAt: plan.createdAt,
          })
        }
      }
    }

    chunks.push({
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
    })
  }

  const needle = query.toLowerCase()
  const matched = needle
    ? chunks.filter((chunk) => chunk.haystack.includes(needle))
    : chunks
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
    query,
    limit,
    truncated: matched.length > limited.length,
    summary: {
      requirements: needle ? matched.length : all.length,
      active: (needle ? matched.map((chunk) => chunk.requirement) : all).filter(
        (requirement) => !isTerminal(requirement.status),
      ).length,
      tasks: tasks.length,
      delivered: tasks.filter((task) => task.state === BOARD_TASK_DELIVERED).length,
      issues: sortedIssues.length,
      blocking: sortedIssues.filter((issue) => issue.severity === 'blocking').length,
    },
    requirements,
    tasks,
    issues: sortedIssues,
  }
}

/** 需求 Agent 一次最多读取的活动需求条数；避免把整个项目历史塞进提示词。 */
export const PROJECT_FACTS_DEFAULT_LIMIT = 10
/** 单个需求在提示词中最多列出的任务数；超出时只报任务总数。 */
export const PROJECT_FACTS_MAX_TASKS = 8
/** 事实读取上限的硬边界，防止调用方传入过大的值。 */
const PROJECT_FACTS_LIMIT_CEILING = 50

export interface ProjectTaskFact {
  readonly taskId: string
  readonly goal: string
  readonly state: BoardTaskState
  readonly dependsOn: readonly string[]
  /** 最近一次运行/心跳时间；待执行任务为空。 */
  readonly lastActivity: string
}

export interface ProjectRequirementFact {
  readonly reqId: string
  /** 是否是本次分析的当前需求。 */
  readonly current: boolean
  readonly title: string
  readonly status: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
  /** 最新一次分析的目标；尚未分析时为空。 */
  readonly goal: string
  readonly planVersion: number | null
  readonly approval: 'approved' | 'missing' | 'stale' | 'none'
  readonly taskCount: number
  readonly tasks: readonly ProjectTaskFact[]
}

/** 需求 Agent 分析时读取的项目事实：活动需求、任务、时间与状态；历史只计数。 */
export interface ProjectFacts {
  readonly project: string
  readonly generatedAt: string
  /** 活动需求总数（不含已结束需求）。 */
  readonly total: number
  readonly listed: number
  readonly notListed: number
  /** 已结束需求数量：只给计数，不展开历史。 */
  readonly terminal: number
  readonly requirements: readonly ProjectRequirementFact[]
}

export interface BuildProjectFactsInput {
  readonly repository: Repository
  readonly project: string
  /** 当前正在分析的需求；始终排在第一条并标记，即使它不在最新若干条里。 */
  readonly currentReqId?: string
  /** 生成时间；测试传入固定值以保持结果确定。 */
  readonly now?: string
  readonly limit?: number
  readonly taskLimit?: number
}

function clampLimit(value: number | undefined, fallback: number): number {
  const normalized = Math.trunc(value ?? fallback)
  if (!Number.isFinite(normalized)) return fallback
  return Math.min(PROJECT_FACTS_LIMIT_CEILING, Math.max(1, normalized))
}

/**
 * 生成需求 Agent 读取的项目事实：只读记录、不写行，也不读取 Agent 日志。
 * 活动需求按最新版本时间倒序；当前需求固定第一条。已结束需求只给数量，
 * 避免把历史候选和结论混进分析提示词。
 */
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
  }
}
