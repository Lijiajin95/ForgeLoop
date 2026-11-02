import type { AdmissionBasis } from '../domain/admission.js'
import type { Requirement } from '../domain/requirement.js'
import type { OpsSeverity } from '../domain/ops.js'
import { OPS_SEVERITIES } from '../domain/ops.js'
import { ISSUE_STAGES, ISSUE_STATUSES, type IssueStage, type IssueStatus } from '../domain/issue.js'
import { RuleViolationError } from '../domain/errors.js'
import {
  FAILURE_BUSINESS_REVIEW,
  FAILURE_FORMAL_TEST,
  FAILURE_INTERRUPTED,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_PLANNING,
  FAILURE_USER_ACCEPTANCE,
  FAILURE_VERIFICATION,
  type FailureStage,
} from '../domain/counting.js'
import {
  TASK_RUN_AWAITING_USER,
  TASK_RUN_BLOCKED,
  TASK_RUN_DELIVERED,
  TASK_RUN_FAILED,
  TASK_RUN_RUNNING,
  type TaskRunState,
} from '../domain/status.js'

export type Row = Record<string, unknown>

export function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

/** 把记录里的字符串收窄到已知取值；非法值按记录损坏报错，不静默取默认。 */
export function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  const found = allowed.find((item) => item === value)
  if (found === undefined) throw new RuleViolationError(`记录损坏：${label} 取值非法（${value}）`)
  return found
}

export function issueStageOf(row: Row): IssueStage {
  return oneOf(text(row, 'stage'), ISSUE_STAGES, '问题单 stage')
}

export function issueStatusOf(row: Row): IssueStatus {
  return oneOf(text(row, 'status'), ISSUE_STATUSES, '问题单 status')
}

const FAILURE_STAGES: readonly FailureStage[] = [
  FAILURE_FORMAL_TEST,
  FAILURE_PLANNING,
  FAILURE_INTERRUPTED,
  FAILURE_IMPLEMENTATION_REVIEW,
  FAILURE_VERIFICATION,
  FAILURE_BUSINESS_REVIEW,
  FAILURE_USER_ACCEPTANCE,
]

const TASK_RUN_STATES: readonly TaskRunState[] = [
  TASK_RUN_RUNNING,
  TASK_RUN_DELIVERED,
  TASK_RUN_AWAITING_USER,
  TASK_RUN_FAILED,
  TASK_RUN_BLOCKED,
]

export function failureStageOf(row: Row): FailureStage {
  return oneOf(text(row, 'stage'), FAILURE_STAGES, '失败轮次 stage')
}

export function taskRunStateOf(row: Row): TaskRunState {
  return oneOf(text(row, 'state'), TASK_RUN_STATES, '任务运行 state')
}

export function opsSeverityOf(row: Row): OpsSeverity {
  return oneOf(text(row, 'severity'), OPS_SEVERITIES, '运维事件 severity')
}

export function num(row: Row, key: string): number {
  const value = row[key]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

export function businessReviewRow(row: Row): BusinessReviewRecord {
  return {
    requirementId: text(row, 'req_id'),
    planVersion: num(row, 'plan_version'),
    candidateSha256: text(row, 'candidate_sha256'),
    requirementVersion: num(row, 'requirement_version'),
    verificationSha256: text(row, 'verification_sha256'),
    verdict: text(row, 'verdict') === 'pass' ? 'pass' : 'block',
    reportJson: text(row, 'report_json'),
    reportPath: text(row, 'report_path'),
    reportSha256: text(row, 'report_sha256'),
    sessionId: text(row, 'session_id'),
    reviewedAt: text(row, 'reviewed_at'),
  }
}

export function verificationRow(row: Row): VerificationRecord {
  return {
    requirementId: text(row, 'req_id'),
    planVersion: num(row, 'plan_version'),
    candidateSha256: text(row, 'candidate_sha256'),
    requirementVersion: num(row, 'requirement_version'),
    workspaceSha256: text(row, 'workspace_sha256'),
    verdict: text(row, 'verdict') === 'pass' ? 'pass' : 'block',
    reportJson: text(row, 'report_json'),
    reportPath: text(row, 'report_path'),
    reportSha256: text(row, 'report_sha256'),
    evidenceDir: text(row, 'evidence_dir'),
    sessionId: text(row, 'session_id'),
    verifiedAt: text(row, 'verified_at'),
  }
}

export interface RequirementEvidence {
  readonly requirementId: string
  readonly planVersion: number
  readonly taskId: string
  readonly baselineCommit: string
  readonly workspacePath: string
  readonly candidatePath: string
  readonly testLogPath: string
  readonly reviewPath: string
  readonly devSession: string
  readonly reviewSession: string
  readonly recordedAt: string
}

export interface PlanReviewRecord {
  readonly requirementId: string
  readonly planVersion: number
  readonly requirementVersion: number
  readonly planSha256: string
  readonly verdict: 'pass' | 'block'
  readonly reportJson: string
  readonly reportPath: string
  readonly reportSha256: string
  readonly sessionId: string
  readonly reviewedAt: string
}

export interface VerificationRecord {
  readonly requirementId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly requirementVersion: number
  readonly workspaceSha256: string
  readonly verdict: 'pass' | 'block'
  readonly reportJson: string
  readonly reportPath: string
  readonly reportSha256: string
  readonly evidenceDir: string
  readonly sessionId: string
  readonly verifiedAt: string
}

export interface BusinessReviewRecord {
  readonly requirementId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly requirementVersion: number
  readonly verificationSha256: string
  readonly verdict: 'pass' | 'block'
  readonly reportJson: string
  readonly reportPath: string
  readonly reportSha256: string
  readonly sessionId: string
  readonly reviewedAt: string
}

/** 研发会话的权威记录：会话不随需求结束删除，忙闲与最近总结落在这里。 */
export interface DevSessionRecord {
  readonly sessionId: string
  readonly project: string
  readonly workspace: string
  readonly state: string
  readonly summary: string
  readonly summarySha256: string
  readonly summaryPath: string
  readonly lastReqId: string
  readonly leaseRequestId: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RequirementDevSessionRecord {
  readonly reqId: string
  readonly requirementVersion: number
  readonly sessionId: string
  readonly workspace: string
  readonly baselineCommit: string
  readonly snapshotCommit: string
  readonly selectedBy: string
  readonly reason: string
  readonly assignedAt: string
  readonly releasedAt: string
}

export interface DevSessionSummaryRecord {
  readonly sessionId: string
  readonly reqId: string
  readonly summary: string
  readonly summarySha256: string
  readonly summaryPath: string
  readonly createdAt: string
}

export interface ServiceRequestRecord {
  readonly requestId: string
  readonly reqId: string
  readonly project: string
  readonly planVersion: number
  readonly action: string
  readonly state: string
  readonly requestedBy: string
  readonly source: string
  readonly createdAt: string
  readonly resolvedAt: string
  readonly detail: string
  readonly owner: string
  readonly claimedAt: string
  readonly attempts: number
}

export interface ActionRecord {
  readonly actionId: string
  readonly taskId: string
  readonly node: string
  readonly role: string
  readonly state: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly detail: string
  readonly pid: number | null
  readonly heartbeatAt: string
}

export interface OpsEventRecord {
  readonly eventId: string
  readonly project: string
  readonly resourceId: string
  readonly checkId: string
  readonly signature: string
  readonly severity: OpsSeverity
  readonly state: string
  readonly title: string
  readonly impact: string
  readonly openedAt: string
  readonly updatedAt: string
  readonly recoveredAt: string
  readonly closedAt: string
  readonly diagnosisJson: string
  readonly diagnosisPath: string
  readonly diagnosisSession: string
  readonly fixRequirementId: string
  readonly decision: string
  readonly decisionBy: string
  readonly decisionSource: string
  readonly decisionAt: string
  readonly humanInvolved: boolean
  readonly humanReason: string
}

export interface OpsObservationRecord {
  readonly eventId: string
  readonly seq: number
  readonly at: string
  readonly kind: string
  readonly summary: string
  readonly detailJson: string
  readonly evidencePath: string
}

export interface OpsActionAttemptRecord {
  readonly actionId: string
  readonly eventId: string
  readonly actionDefId: string
  readonly paramsJson: string
  readonly state: string
  readonly authorizationSource: string
  readonly detail: string
  readonly exitCode: number | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly evidencePath: string
}

export interface OpsEventPatch {
  state?: string
  title?: string
  impact?: string
  severity?: string
  recoveredAt?: string
  closedAt?: string
  diagnosisJson?: string
  diagnosisPath?: string
  diagnosisSession?: string
  fixRequirementId?: string
  decision?: string
  decisionBy?: string
  decisionSource?: string
  decisionAt?: string
  humanInvolved?: boolean
  humanReason?: string
  updatedAt?: string
}

export interface SubmitResult {
  readonly requirement: Requirement
  readonly created: boolean
}

export interface AdmissionRecord {
  readonly admissionId: string
  readonly requirementId: string
  readonly requirementVersion: number
  readonly decision: 'admit' | 'block'
  readonly code: string
  readonly reason: string
  readonly basis: AdmissionBasis
  readonly policyVersion: string
  readonly decidedBy: string
  readonly createdAt: string
}

export interface StopRecord {
  readonly requirementId: string
  readonly requestedBy: string
  readonly reason: string
  readonly requestedAt: string
  readonly settledAt: string
  readonly resumedBy: string
  readonly resumeReason: string
  readonly resumedAt: string
}

export interface CodeCandidateRecord {
  readonly requirementId: string
  readonly planVersion: number
  readonly candidateVersion: number
  readonly candidateSha256: string
  readonly requirementVersion: number
  readonly baselineCommit: string
  readonly snapshotCommit: string
  readonly diffPath: string
  readonly diffSha256: string
  readonly createdAt: string
}

export interface RequirementCommitRecord {
  readonly requirementId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly commitSha: string
  readonly commitMessage: string
  readonly checkCommand: readonly string[]
  readonly checkLogPath: string
  readonly checkSha256: string
  readonly files: readonly string[]
  readonly committedAt: string
}
