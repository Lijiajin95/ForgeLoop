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
 */

import type { Repository } from '../records/repository.js'
import type { Requirement } from '../domain/requirement.js'
import { authorizePlan } from '../domain/task-plan.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import {
  ACTION_ANALYZE,
  ACTION_PLAN,
  ACTION_ADVANCE,
  REQUEST_UNKNOWN,
  REQUEST_FAILED,
  PLAN_PROPOSED,
  isTerminal,
  TASK_RUN_AWAITING_USER,
} from '../domain/status.js'

/** 页面默认展示的需求条数；更早的历史仍在权威记录中可回查。 */
export const BOARD_DEFAULT_LIMIT = 20
/** 问题列的展示上限，避免一次渲染过长列表。 */
export const BOARD_MAX_ISSUES = 60

export const BOARD_TASK_DELIVERED = 'delivered'
export const BOARD_TASK_PENDING = 'pending'

export type BoardTaskState =
  | typeof BOARD_TASK_DELIVERED
  | typeof BOARD_TASK_PENDING
  | typeof TASK_RUN_AWAITING_USER
  | 'failed'
  | 'blocked'

export interface BoardTaskView {
  readonly reqId: string
  readonly planVersion: number
  readonly taskId: string
  readonly goal: string
  readonly state: BoardTaskState
  readonly dependsOn: readonly string[]
}

export interface BoardRequirementView {
  readonly reqId: string
  readonly title: string
  readonly status: string
  readonly version: number
  readonly planVersion: number | null
  readonly approval: 'approved' | 'missing' | 'stale' | 'none'
  readonly clarifications: number
  readonly failureRounds: number
  readonly grants: number
  readonly remainingRounds: number
  readonly progress: {
    readonly total: number
    readonly delivered: number
    readonly failed: number
    readonly awaitingUser: number
    readonly blocked: number
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
  readonly kind: BoardIssueKind
  readonly severity: BoardIssueSeverity
  readonly title: string
  readonly detail: string
  readonly createdAt: string
}

export interface StatusBoardView {
  readonly project: string
  readonly generatedAt: string
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

function requestActionLabel(action: string): string {
  if (action === ACTION_ANALYZE) return '分析'
  if (action === ACTION_PLAN) return '规划'
  if (action === ACTION_ADVANCE) return '推进'
  return action
}

const SEVERITY_RANK: Record<BoardIssueSeverity, number> = { blocking: 0, attention: 1 }

/**
 * 从一个项目的权威记录生成看板视图。
 * @param input.repository 已打开的记录仓库（调用方负责关闭）。
 * @param input.project 项目标识；只读取该项目的需求。
 * @param input.now ISO 时间，默认当前时刻。
 * @param input.limit 需求条数上限，默认 {@link BOARD_DEFAULT_LIMIT}。
 */
export function buildStatusBoard(input: BuildStatusBoardInput): StatusBoardView {
  const { repository, project } = input
  const now = input.now ?? new Date().toISOString()
  const limit = Math.max(1, Math.trunc(input.limit ?? BOARD_DEFAULT_LIMIT))
  const all = repository.listRequirements(project)
  const selected = all.slice(0, limit)

  const requirements: BoardRequirementView[] = []
  const tasks: BoardTaskView[] = []
  const issues: BoardIssueView[] = []

  for (const requirement of selected) {
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

    const progress = {
      total: plan?.tasks.length ?? 0,
      delivered: 0,
      failed: 0,
      awaitingUser: 0,
      blocked: 0,
      pending: 0,
    }

    for (const task of plan?.tasks ?? []) {
      const run = runByTask.get(task.taskId)
      let state: BoardTaskState
      if (delivered.has(task.taskId)) state = BOARD_TASK_DELIVERED
      else if (run && (run.state === 'failed' || run.state === 'blocked' || run.state === 'awaiting_user')) {
        state = run.state
      } else state = BOARD_TASK_PENDING

      if (state === BOARD_TASK_DELIVERED) progress.delivered += 1
      else if (state === 'failed') progress.failed += 1
      else if (state === 'blocked') progress.blocked += 1
      else if (state === 'awaiting_user') progress.awaitingUser += 1
      else progress.pending += 1

      tasks.push({
        reqId: requirement.reqId,
        planVersion: plan!.planVersion,
        taskId: task.taskId,
        goal: task.goal,
        state,
        dependsOn: task.dependsOn,
      })
    }

    requirements.push({
      reqId: requirement.reqId,
      title: requirementTitle(requirement),
      status: requirement.status,
      version: requirement.versions.length,
      planVersion: plan?.planVersion ?? null,
      approval: authorization?.status ?? 'none',
      clarifications: latestAnalysis?.clarifications.length ?? 0,
      failureRounds: rounds.length,
      grants,
      remainingRounds: Math.max(0, grants * MAX_ROUNDS_PER_GRANT - rounds.length),
      progress,
      updatedAt: updatedAtOf(requirement),
    })

    if (terminal) continue

    const updatedAt = updatedAtOf(requirement)

    for (const [index, clarification] of (latestAnalysis?.clarifications ?? []).entries()) {
      issues.push({
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
      issues.push({
        issueId: `blocked:${requirement.reqId}`,
        reqId: requirement.reqId,
        kind: ISSUE_BLOCKED,
        severity: 'blocking',
        title: requirement.blockedReason || '需求已阻塞，未记录原因',
        detail: '阻塞状态需要人工核对现场后决定下一步；不会自动重试',
        createdAt: updatedAt,
      })
    }

    const latestRound = rounds[rounds.length - 1]
    if (latestRound) {
      const remaining = Math.max(0, grants * MAX_ROUNDS_PER_GRANT - rounds.length)
      issues.push({
        issueId: `failure:${requirement.reqId}:${latestRound.roundId}`,
        reqId: requirement.reqId,
        kind: ISSUE_FAILURE_ROUND,
        severity: remaining === 0 ? 'blocking' : 'attention',
        title: latestRound.summary,
        detail:
          remaining === 0
            ? `失败轮次 ${rounds.length} 已用尽自动处理额度；等待追加授权或人工决定`
            : `失败轮次 ${rounds.length}，额度剩余 ${remaining}；额度未尽时按规则自动重试`,
        createdAt: latestRound.occurredAt,
      })
    }

    for (const request of repository.requestsFor(requirement.reqId)) {
      if (request.state !== REQUEST_UNKNOWN && request.state !== REQUEST_FAILED) continue
      issues.push({
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

    if (plan && requirement.status === PLAN_PROPOSED && authorization && authorization.status !== 'approved') {
      issues.push({
        issueId: `approval:${requirement.reqId}:v${plan.planVersion}`,
        reqId: requirement.reqId,
        kind: ISSUE_APPROVAL,
        severity: 'attention',
        title: `任务包 v${plan.planVersion} 待批准`,
        detail: authorization.reason || '任务包尚未获得批准',
        createdAt: plan.createdAt,
      })
    }
  }

  const sortedIssues = [...issues]
    .sort((left, right) => {
      const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      if (bySeverity !== 0) return bySeverity
      return right.createdAt.localeCompare(left.createdAt)
    })
    .slice(0, BOARD_MAX_ISSUES)

  return {
    project,
    generatedAt: now,
    summary: {
      requirements: all.length,
      active: all.filter((requirement) => !isTerminal(requirement.status)).length,
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
