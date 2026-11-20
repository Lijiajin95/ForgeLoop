import { RuleViolationError } from './errors.js'

export const ISSUE_OPEN = 'open'
export const ISSUE_FIXED = 'fixed'
export const ISSUE_RESOLVED = 'resolved'

export type IssueStatus = typeof ISSUE_OPEN | typeof ISSUE_FIXED | typeof ISSUE_RESOLVED

export const ISSUE_STAGE_VERIFICATION = 'verification'
export type IssueStage = typeof ISSUE_STAGE_VERIFICATION

export const ISSUE_STATUSES: readonly IssueStatus[] = [ISSUE_OPEN, ISSUE_FIXED, ISSUE_RESOLVED]
export const ISSUE_STAGES: readonly IssueStage[] = [ISSUE_STAGE_VERIFICATION]

export interface IssueCommandEvidence {
  readonly label: string
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly logPath: string
  readonly logSha256: string
  readonly durationMs: number
}

export interface IssueEnvironment {
  readonly project: string
  readonly projectPath: string
  readonly platform: string
  readonly nodeVersion: string
  readonly pid: number
  readonly hostname: string
  readonly pluginVersion: string
  readonly requirementStatus: string
  readonly requirementVersion: number
  readonly planVersion: number
  readonly candidateSha256: string
  readonly candidateVersion: number
  readonly candidateDiffPath: string
  readonly verificationReportPath: string
  readonly verificationReportSha256: string
  readonly verificationEvidenceDir: string
  readonly devWorkspace: string
}

export interface RequirementIssueEvidence {
  readonly blocking: readonly string[]
  readonly summary: string
  readonly commands: readonly IssueCommandEvidence[]
  readonly logs: readonly string[]
  readonly environment: IssueEnvironment
  readonly state: {
    readonly attempt: number
    readonly stage: IssueStage
    readonly verificationVerdict: string
  }
}

export interface RequirementIssue {
  readonly issueId: string
  readonly requirementId: string
  readonly project: string
  readonly attempt: number
  readonly stage: IssueStage
  readonly status: IssueStatus
  readonly summary: string
  readonly evidence: RequirementIssueEvidence
  readonly verificationSha256: string
  readonly candidateSha256: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt: string
}

export type NewRequirementIssue = RequirementIssue

function nonEmpty(value: string, field: string): string {
  const text = value.trim()
  if (!text) throw new RuleViolationError(`问题单字段 ${field} 不能为空`)
  return text
}

export function buildRequirementIssue(input: NewRequirementIssue): RequirementIssue {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new RuleViolationError(`问题单 attempt 必须是正整数，实际 ${input.attempt}`)
  }
  if (!ISSUE_STATUSES.includes(input.status)) {
    throw new RuleViolationError(`问题单状态未知：${input.status}`)
  }
  if (!ISSUE_STAGES.includes(input.stage)) {
    throw new RuleViolationError(`问题单阶段未知：${input.stage}`)
  }
  const blocking = input.evidence.blocking
  if (
    !Array.isArray(blocking) ||
    blocking.some((item: unknown) => typeof item !== 'string' || !item.trim())
  ) {
    throw new RuleViolationError('问题单阻断项必须是非空字符串数组')
  }
  return {
    issueId: nonEmpty(input.issueId, 'issueId'),
    requirementId: nonEmpty(input.requirementId, 'requirementId'),
    project: nonEmpty(input.project, 'project'),
    attempt: input.attempt,
    stage: input.stage,
    status: input.status,
    summary: nonEmpty(input.summary, 'summary'),
    evidence: input.evidence,
    verificationSha256: input.verificationSha256,
    candidateSha256: input.candidateSha256,
    createdAt: nonEmpty(input.createdAt, 'createdAt'),
    updatedAt: nonEmpty(input.updatedAt, 'updatedAt'),
    resolvedAt: input.resolvedAt,
  }
}

export function nextIssueAttempt(issues: readonly RequirementIssue[]): number {
  return issues.reduce((max, issue) => Math.max(max, issue.attempt), 0) + 1
}
