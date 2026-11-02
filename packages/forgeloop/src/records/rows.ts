import type { AdmissionBasis } from '../domain/admission.js'
import type { Requirement } from '../domain/requirement.js'
import type { OpsSeverity } from '../domain/ops.js'

export type Row = Record<string, unknown>

export function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
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
