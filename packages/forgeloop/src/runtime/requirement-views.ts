import type { Requirement } from '../domain/requirement.js'
import type { Repository, ServiceRequestRecord } from '../records/repository.js'
import type { TaskPlan } from '../domain/task-plan.js'
import {
  parsePlanReview,
  parseVerificationReport,
  type PlanReview,
  type VerificationReport,
} from '../domain/verification.js'
import { taskIdOfFailureRound } from './board.js'
import { MAX_ROUNDS_PER_GRANT } from '../domain/counting.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
} from '../domain/status.js'

export function planReviewView(repo: Repository, reqId: string, planVersion: number): unknown {
  const record = repo.planReview(reqId, planVersion)
  if (!record) return null
  let review: PlanReview | null = null
  try {
    review = parsePlanReview(record.reportJson)
  } catch {
    review = null
  }
  return {
    verdict: record.verdict,
    summary: review?.summary ?? '',
    blocking: review?.blocking ?? [],
    findings: review?.findings ?? [],
    verificationPlan: review?.verificationPlan ?? [],
    reportPath: record.reportPath,
    reportSha256: record.reportSha256,
    sessionId: record.sessionId,
    reviewedAt: record.reviewedAt,
  }
}

export function verificationView(
  repo: Repository,
  candidateIdentityOf: (
    plan: TaskPlan,
    artifacts: ReturnType<Repository['taskArtifacts']>,
  ) => string,
  input: {
    reqId: string
    plan: TaskPlan
    artifacts: ReturnType<Repository['taskArtifacts']>
  },
): unknown {
  const { reqId, plan, artifacts } = input
  const record = repo.verification(reqId, plan.planVersion)
  if (!record) return null
  let report: VerificationReport | null = null
  try {
    report = parseVerificationReport(record.reportJson)
  } catch {
    report = null
  }
  const currentIdentity = (() => {
    try {
      return candidateIdentityOf(plan, artifacts)
    } catch {
      return ''
    }
  })()
  return {
    verdict: record.verdict,
    summary: report?.summary ?? '',
    blocking: report?.blocking ?? [],
    findings: report?.findings ?? [],
    scenarios: report?.scenarios ?? [],
    candidateSha256: record.candidateSha256,
    workspaceSha256: record.workspaceSha256,
    reportPath: record.reportPath,
    reportSha256: record.reportSha256,
    sessionId: record.sessionId,
    verifiedAt: record.verifiedAt,
    fresh: currentIdentity !== '' && currentIdentity === record.candidateSha256,
  }
}

export function buildRequirementView(
  repo: Repository,
  hooks: {
    requirement: Requirement
    candidateIdentityOf: (
      plan: TaskPlan,
      artifacts: ReturnType<Repository['taskArtifacts']>,
    ) => string
    requestView: (request: ServiceRequestRecord) => Record<string, unknown>
  },
): unknown {
  const { requirement } = hooks
  const requestView = hooks.requestView
  const latestAnalysis = repo.latestAnalysis(requirement.reqId)
  const plans = repo.taskPlans(requirement.reqId)
  const latestPlan = plans[plans.length - 1]
  const approval = latestPlan ? repo.planApproval(requirement.reqId, latestPlan.planVersion) : null
  const artifacts = latestPlan ? repo.taskArtifacts(requirement.reqId, latestPlan.planVersion) : []
  const runs = latestPlan ? repo.taskRuns(requirement.reqId, latestPlan.planVersion) : []
  const recordedFailures = repo.failureRounds(requirement.reqId)
  const grants = repo.grantCount(requirement.reqId)
  return {
    reqId: requirement.reqId,
    project: requirement.project,
    status: requirement.status,
    blockedReason: requirement.blockedReason,
    versions: requirement.versions.map((version) => ({
      version: version.version,
      text: version.text,
      createdAt: version.createdAt,
      revisedBy: version.revisedBy,
    })),
    analysis: latestAnalysis,
    plans: plans.map((plan) => ({
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      tasks: plan.tasks.map((task) => task.taskId),
      createdAt: plan.createdAt,
    })),
    approval: approval
      ? {
          planVersion: approval.planVersion,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        }
      : null,
    planReview: latestPlan ? planReviewView(repo, requirement.reqId, latestPlan.planVersion) : null,
    verification: latestPlan
      ? verificationView(repo, hooks.candidateIdentityOf, {
          reqId: requirement.reqId,
          plan: latestPlan,
          artifacts,
        })
      : null,
    candidate: latestPlan ? repo.candidate(requirement.reqId, latestPlan.planVersion) : null,
    delivered: artifacts.map((artifact) => artifact.taskId),
    runs: runs.map((run) => ({ taskId: run.taskId, state: run.state, reason: run.reason })),
    failureRounds: recordedFailures.length,
    grants,
    failureRoundDetails: recordedFailures.map((round) => ({
      roundId: round.roundId,
      stage: round.stage,
      summary: round.summary,
      occurredAt: round.occurredAt,
      ...(taskIdOfFailureRound(latestPlan ?? null, round.roundId)
        ? { taskId: taskIdOfFailureRound(latestPlan ?? null, round.roundId) }
        : {}),
    })),
    grantQuota: {
      grants,
      used: recordedFailures.length,
      remaining: Math.max(0, grants * MAX_ROUNDS_PER_GRANT - recordedFailures.length),
    },
    pendingRequests: repo
      .requestsFor(requirement.reqId)
      .filter((request) => ['pending', 'claimed'].includes(request.state))
      .map(requestView),
  }
}

export interface DeliveryProgress {
  total: number
  delivered: number
  failed: number
  awaitingUser: number
  awaitingInput: number
  blocked: number
  running: number
  pending: number
}

export function deliveryProgress(
  plan: TaskPlan | null,
  delivered: ReadonlySet<string>,
  runs: ReturnType<Repository['taskRuns']>,
): DeliveryProgress {
  const runByTask = new Map(runs.map((run) => [run.taskId, run]))
  const progress: DeliveryProgress = {
    total: plan?.tasks.length ?? 0,
    delivered: 0,
    failed: 0,
    awaitingUser: 0,
    awaitingInput: 0,
    blocked: 0,
    running: 0,
    pending: 0,
  }
  for (const task of plan?.tasks ?? []) {
    const run = runByTask.get(task.taskId)
    if (delivered.has(task.taskId)) {
      progress.delivered += 1
      continue
    }
    progress[classifyRun(run?.state, run?.reason ?? '')] += 1
  }
  return progress
}

function classifyRun(
  state: string | undefined,
  reason: string,
): keyof Omit<DeliveryProgress, 'total' | 'delivered'> {
  if (state === TASK_RUN_RUNNING && /ask_user_question/i.test(reason)) return 'awaitingInput'
  if (state === TASK_RUN_RUNNING) return 'running'
  if (state === TASK_RUN_FAILED) return 'failed'
  if (state === TASK_RUN_BLOCKED) return 'blocked'
  if (state === TASK_RUN_AWAITING_USER) return 'awaitingUser'
  return 'pending'
}
