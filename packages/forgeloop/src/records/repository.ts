/**
 * 权威业务记录（TypeScript）：需求与版本、分析、任务包与批准、任务运行与产物、
 * 持久操作请求、动作身份、失败轮次/授权与工时。
 *
 * 只读写当前实现建立的权威表；不读取或修补旧业务库。
 */

import { Database, isoNow } from './db.js'
import { RuleViolationError } from '../domain/errors.js'
import type { Requirement, RequirementAnalysis, RequirementVersion } from '../domain/requirement.js'
import { validateAnalysis, validateRequirement } from '../domain/requirement.js'
import type { TaskPlan, TaskPlanApproval } from '../domain/task-plan.js'
import { validateTaskPlan } from '../domain/task-plan.js'
import type { FailureRound } from '../domain/counting.js'
import type { TaskArtifact, TaskRun } from '../domain/work.js'
import type { TaskRunState } from '../domain/status.js'
import type { OpsSeverity } from '../domain/ops.js'

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function num(row: Row, key: string): number {
  const value = row[key]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function businessReviewRow(row: Row): BusinessReviewRecord {
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

function verificationRow(row: Row): VerificationRecord {
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
  readonly resultUnknown: boolean
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
  resultUnknown?: boolean
  updatedAt?: string
}

export interface SubmitResult {
  readonly requirement: Requirement
  readonly created: boolean
}

export class Repository {
  constructor(readonly db: Database) {}

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- 需求

  submit(input: {
    reqId: string
    project: string
    text: string
    submittedBy: string
    source: string
    clientKey?: string
    now: string
  }): SubmitResult {
    const clientKey = input.clientKey ?? ''
    if (clientKey) {
      const existing = this.requirementByClientKey(clientKey)
      if (existing) {
        const latest = existing.versions[existing.versions.length - 1]
        if (latest && latest.text.trim() !== input.text.trim()) {
          throw new RuleViolationError(
            `客户端幂等键 ${clientKey} 已用于不同内容的需求 ${existing.reqId}；拒绝猜用户想改哪一条`,
          )
        }
        return { requirement: existing, created: false }
      }
    }
    this.db.transaction(() => {
      this.db.handle
        .prepare(
          `INSERT INTO requirements (req_id, project, created_at, status, submitted_by, source, client_key)
           VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(input.reqId, input.project, input.now, input.submittedBy, input.source, clientKey)
      this.db.handle
        .prepare(
          `INSERT INTO requirement_versions (req_id, version, text, created_at, revised_by, source)
           VALUES (?, 1, ?, ?, ?, ?)`,
        )
        .run(input.reqId, input.text.trim(), input.now, input.submittedBy, input.source)
    })
    const requirement = this.getRequirement(input.reqId)
    if (!requirement) throw new RuleViolationError(`需求 ${input.reqId} 写入后不可读`)
    return { requirement, created: true }
  }

  requirementByClientKey(clientKey: string): Requirement | null {
    const row = this.db.handle
      .prepare('SELECT req_id FROM requirements WHERE client_key = ? ORDER BY created_at LIMIT 1')
      .get(clientKey) as Row | undefined
    return row ? this.getRequirement(text(row, 'req_id')) : null
  }

  getRequirement(reqId: string): Requirement | null {
    const row = this.db.handle.prepare('SELECT * FROM requirements WHERE req_id = ?').get(reqId) as
      | Row
      | undefined
    if (!row) return null
    const versions = this.versions(reqId)
    const requirement: Requirement = {
      reqId,
      project: text(row, 'project'),
      status: text(row, 'status') || 'draft',
      blockedReason: text(row, 'blocked_reason'),
      versions,
      submittedBy: text(row, 'submitted_by'),
      source: text(row, 'source'),
    }
    validateRequirement(requirement)
    return requirement
  }

  versions(reqId: string): RequirementVersion[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_versions WHERE req_id = ? ORDER BY version')
      .all(reqId) as Row[]
    return rows.map((row) => ({
      version: num(row, 'version'),
      text: text(row, 'text'),
      createdAt: text(row, 'created_at'),
      revisedBy: text(row, 'revised_by'),
      source: text(row, 'source'),
    }))
  }

  latestVersionNumber(reqId: string): number {
    const row = this.db.handle
      .prepare('SELECT MAX(version) AS version FROM requirement_versions WHERE req_id = ?')
      .get(reqId) as Row | undefined
    return row ? num(row, 'version') : 0
  }

  appendVersion(input: {
    reqId: string
    text: string
    revisedBy: string
    source: string
    now: string
  }): Requirement {
    const requirement = this.getRequirement(input.reqId)
    if (!requirement) throw new RuleViolationError(`未找到需求 ${input.reqId}`)
    if (!input.text.trim()) throw new RuleViolationError('需求修订原文不能为空')
    const next = this.latestVersionNumber(input.reqId) + 1
    this.db.transaction(() => {
      this.db.handle
        .prepare(
          `INSERT INTO requirement_versions (req_id, version, text, created_at, revised_by, source)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.reqId, next, input.text.trim(), input.now, input.revisedBy, input.source)
      // 修订使既有任务包与其批准对当前版本过期：状态回到 draft，历史不回写。
      this.db.handle
        .prepare("UPDATE requirements SET status = 'draft', blocked_reason = '' WHERE req_id = ?")
        .run(input.reqId)
    })
    const updated = this.getRequirement(input.reqId)
    if (!updated) throw new RuleViolationError(`需求 ${input.reqId} 修订后不可读`)
    return updated
  }

  listRequirements(project?: string): Requirement[] {
    const rows = (
      project
        ? this.db.handle
            .prepare('SELECT req_id FROM requirements WHERE project = ? ORDER BY created_at DESC')
            .all(project)
        : this.db.handle.prepare('SELECT req_id FROM requirements ORDER BY created_at DESC').all()
    ) as Row[]
    return rows
      .map((row) => this.getRequirement(text(row, 'req_id')))
      .filter((requirement): requirement is Requirement => requirement !== null)
  }

  setStatus(reqId: string, status: string, reason = ''): void {
    const result = this.db.handle
      .prepare('UPDATE requirements SET status = ?, blocked_reason = ? WHERE req_id = ?')
      .run(status, reason, reqId)
    if (result.changes === 0) throw new RuleViolationError(`未找到需求 ${reqId}`)
  }

  recordAcceptance(input: {
    reqId: string
    acceptedBy: string
    source: string
    fingerprint: string
    now: string
  }): void {
    const result = this.db.handle
      .prepare(
        `UPDATE requirements SET status = 'accepted', accepted_at = ?, accepted_by = ?,
           acceptance_source = ?, acceptance_fingerprint = ?
         WHERE req_id = ?`,
      )
      .run(input.now, input.acceptedBy, input.source, input.fingerprint, input.reqId)
    if (result.changes === 0) throw new RuleViolationError(`未找到需求 ${input.reqId}`)
  }

  acceptance(reqId: string): Record<string, string> {
    const row = this.db.handle
      .prepare(
        'SELECT accepted_at, accepted_by, acceptance_source, acceptance_fingerprint FROM requirements WHERE req_id = ?',
      )
      .get(reqId) as Row | undefined
    if (!row) return {}
    return {
      accepted_at: text(row, 'accepted_at'),
      accepted_by: text(row, 'accepted_by'),
      acceptance_source: text(row, 'acceptance_source'),
      acceptance_fingerprint: text(row, 'acceptance_fingerprint'),
    }
  }

  recordCancellation(input: {
    reqId: string
    cancelledBy: string
    reason: string
    now: string
  }): void {
    this.db.transaction(() => {
      this.db.handle
        .prepare(
          `INSERT INTO requirement_cancellations (req_id, cancelled_by, reason, cancelled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(req_id) DO UPDATE SET cancelled_by = excluded.cancelled_by,
             reason = excluded.reason, cancelled_at = excluded.cancelled_at`,
        )
        .run(input.reqId, input.cancelledBy, input.reason, input.now)
      this.db.handle
        .prepare("UPDATE requirements SET status = 'cancelled' WHERE req_id = ?")
        .run(input.reqId)
    })
  }

  cancellation(reqId: string): { cancelledBy: string; reason: string; cancelledAt: string } | null {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_cancellations WHERE req_id = ?')
      .get(reqId) as Row | undefined
    if (!row) return null
    return {
      cancelledBy: text(row, 'cancelled_by'),
      reason: text(row, 'reason'),
      cancelledAt: text(row, 'cancelled_at'),
    }
  }

  // ---------------------------------------------------------------- 分析

  nextAnalysisVersion(reqId: string): number {
    const row = this.db.handle
      .prepare('SELECT MAX(analysis_version) AS version FROM requirement_analyses WHERE req_id = ?')
      .get(reqId) as Row | undefined
    return (row ? num(row, 'version') : 0) + 1
  }

  recordAnalysis(analysis: RequirementAnalysis & { reqId: string }): void {
    const requirement = this.getRequirement(analysis.reqId)
    if (!requirement) throw new RuleViolationError(`未找到需求 ${analysis.reqId}`)
    validateAnalysis(analysis, requirement.versions.length)
    this.db.handle
      .prepare(
        `INSERT INTO requirement_analyses
          (req_id, analysis_version, requirement_version, goal, scenarios, acceptance_criteria, clarifications, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        analysis.reqId,
        analysis.analysisVersion,
        analysis.requirementVersion,
        analysis.goal,
        JSON.stringify(analysis.scenarios),
        JSON.stringify(analysis.acceptanceCriteria),
        JSON.stringify(analysis.clarifications),
        analysis.createdAt,
      )
  }

  analyses(reqId: string): RequirementAnalysis[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_analyses WHERE req_id = ? ORDER BY analysis_version')
      .all(reqId) as Row[]
    return rows.map((row) => ({
      analysisVersion: num(row, 'analysis_version'),
      requirementVersion: num(row, 'requirement_version'),
      goal: text(row, 'goal'),
      scenarios: parseStringList(text(row, 'scenarios')),
      acceptanceCriteria: parseStringList(text(row, 'acceptance_criteria')),
      clarifications: parseStringList(text(row, 'clarifications')),
      createdAt: text(row, 'created_at'),
    }))
  }

  latestAnalysis(reqId: string): RequirementAnalysis | null {
    const all = this.analyses(reqId)
    return all.length > 0 ? all[all.length - 1]! : null
  }

  // ---------------------------------------------------------------- 任务包

  nextPlanVersion(reqId: string): number {
    const row = this.db.handle
      .prepare('SELECT MAX(plan_version) AS version FROM requirement_task_plans WHERE req_id = ?')
      .get(reqId) as Row | undefined
    return (row ? num(row, 'version') : 0) + 1
  }

  recordTaskPlan(plan: TaskPlan): void {
    validateTaskPlan(plan)
    this.db.handle
      .prepare(
        `INSERT INTO requirement_task_plans (req_id, plan_version, task_plan_id, plan, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        plan.requirementId,
        plan.planVersion,
        plan.taskPlanId,
        JSON.stringify(planToPayload(plan)),
        plan.createdAt,
      )
  }

  taskPlan(reqId: string, planVersion: number): TaskPlan | null {
    const row = this.db.handle
      .prepare(
        'SELECT * FROM requirement_task_plans WHERE req_id = ? AND plan_version = ?',
      )
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    return planFromPayload(JSON.parse(text(row, 'plan')) as unknown, {
      requirementId: reqId,
      taskPlanId: text(row, 'task_plan_id'),
      planVersion,
      createdAt: text(row, 'created_at'),
    })
  }

  taskPlans(reqId: string): TaskPlan[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_task_plans WHERE req_id = ? ORDER BY plan_version')
      .all(reqId) as Row[]
    return rows.map((row) =>
      planFromPayload(JSON.parse(text(row, 'plan')) as unknown, {
        requirementId: reqId,
        taskPlanId: text(row, 'task_plan_id'),
        planVersion: num(row, 'plan_version'),
        createdAt: text(row, 'created_at'),
      }),
    )
  }

  latestTaskPlan(reqId: string): TaskPlan | null {
    const plans = this.taskPlans(reqId)
    return plans.length > 0 ? plans[plans.length - 1]! : null
  }

  recordPlanApproval(approval: TaskPlanApproval): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_plan_approvals (req_id, plan_version, approved_by, source, approved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version) DO UPDATE SET approved_by = excluded.approved_by,
           source = excluded.source, approved_at = excluded.approved_at`,
      )
      .run(
        approval.requirementId,
        approval.planVersion,
        approval.approvedBy,
        approval.source,
        approval.approvedAt,
      )
  }

  planApproval(reqId: string, planVersion: number): TaskPlanApproval | null {
    const row = this.db.handle
      .prepare(
        'SELECT * FROM requirement_plan_approvals WHERE req_id = ? AND plan_version = ?',
      )
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    return {
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      approvedBy: text(row, 'approved_by'),
      source: text(row, 'source'),
      approvedAt: text(row, 'approved_at'),
    }
  }

  latestPlanApproval(reqId: string): TaskPlanApproval | null {
    const row = this.db.handle
      .prepare(
        'SELECT * FROM requirement_plan_approvals WHERE req_id = ? ORDER BY plan_version DESC LIMIT 1',
      )
      .get(reqId) as Row | undefined
    if (!row) return null
    return {
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      approvedBy: text(row, 'approved_by'),
      source: text(row, 'source'),
      approvedAt: text(row, 'approved_at'),
    }
  }

  // ---------------------------------------------------------------- 验证 Agent

  recordPlanReview(review: PlanReviewRecord): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_plan_reviews
          (req_id, plan_version, requirement_version, plan_sha256, verdict, report_json,
           report_path, report_sha256, session_id, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version) DO UPDATE SET
           requirement_version = excluded.requirement_version,
           plan_sha256 = excluded.plan_sha256, verdict = excluded.verdict,
           report_json = excluded.report_json, report_path = excluded.report_path,
           report_sha256 = excluded.report_sha256, session_id = excluded.session_id,
           reviewed_at = excluded.reviewed_at`,
      )
      .run(
        review.requirementId,
        review.planVersion,
        review.requirementVersion,
        review.planSha256,
        review.verdict,
        review.reportJson,
        review.reportPath,
        review.reportSha256,
        review.sessionId,
        review.reviewedAt,
      )
  }

  planReview(reqId: string, planVersion: number): PlanReviewRecord | null {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_plan_reviews WHERE req_id = ? AND plan_version = ?')
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    return {
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      requirementVersion: num(row, 'requirement_version'),
      planSha256: text(row, 'plan_sha256'),
      verdict: text(row, 'verdict') === 'pass' ? 'pass' : 'block',
      reportJson: text(row, 'report_json'),
      reportPath: text(row, 'report_path'),
      reportSha256: text(row, 'report_sha256'),
      sessionId: text(row, 'session_id'),
      reviewedAt: text(row, 'reviewed_at'),
    }
  }

  recordVerification(verification: VerificationRecord): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_verifications
          (req_id, plan_version, candidate_sha256, requirement_version, workspace_sha256,
           verdict, report_json, report_path, report_sha256, evidence_dir, session_id, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, candidate_sha256) DO UPDATE SET
           requirement_version = excluded.requirement_version,
           workspace_sha256 = excluded.workspace_sha256, verdict = excluded.verdict,
           report_json = excluded.report_json, report_path = excluded.report_path,
           report_sha256 = excluded.report_sha256, evidence_dir = excluded.evidence_dir,
           session_id = excluded.session_id, verified_at = excluded.verified_at`,
      )
      .run(
        verification.requirementId,
        verification.planVersion,
        verification.candidateSha256,
        verification.requirementVersion,
        verification.workspaceSha256,
        verification.verdict,
        verification.reportJson,
        verification.reportPath,
        verification.reportSha256,
        verification.evidenceDir,
        verification.sessionId,
        verification.verifiedAt,
      )
  }

  verification(reqId: string, planVersion: number): VerificationRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_verifications
         WHERE req_id = ? AND plan_version = ?
         ORDER BY verified_at DESC LIMIT 1`,
      )
      .get(reqId, planVersion) as Row | undefined
    return row ? verificationRow(row) : null
  }

  verificationForCandidate(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
  ): VerificationRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_verifications
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?`,
      )
      .get(reqId, planVersion, candidateSha256) as Row | undefined
    return row ? verificationRow(row) : null
  }

  recordBusinessReview(review: BusinessReviewRecord): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_business_reviews
          (req_id, plan_version, candidate_sha256, requirement_version, verification_sha256,
           verdict, report_json, report_path, report_sha256, session_id, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, candidate_sha256) DO UPDATE SET
           requirement_version = excluded.requirement_version,
           verification_sha256 = excluded.verification_sha256,
           verdict = excluded.verdict, report_json = excluded.report_json,
           report_path = excluded.report_path, report_sha256 = excluded.report_sha256,
           session_id = excluded.session_id, reviewed_at = excluded.reviewed_at`,
      )
      .run(
        review.requirementId,
        review.planVersion,
        review.candidateSha256,
        review.requirementVersion,
        review.verificationSha256,
        review.verdict,
        review.reportJson,
        review.reportPath,
        review.reportSha256,
        review.sessionId,
        review.reviewedAt,
      )
  }

  businessReview(reqId: string, planVersion: number): BusinessReviewRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_business_reviews
         WHERE req_id = ? AND plan_version = ?
         ORDER BY reviewed_at DESC LIMIT 1`,
      )
      .get(reqId, planVersion) as Row | undefined
    return row ? businessReviewRow(row) : null
  }

  businessReviewForCandidate(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
  ): BusinessReviewRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_business_reviews
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?`,
      )
      .get(reqId, planVersion, candidateSha256) as Row | undefined
    return row ? businessReviewRow(row) : null
  }

  // ---------------------------------------------------------------- 任务运行与产物

  recordTaskRun(run: TaskRun): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_task_runs
          (req_id, plan_version, task_id, state, reason, executed_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, task_id) DO UPDATE SET
           state = excluded.state, reason = excluded.reason,
           executed_seconds = requirement_task_runs.executed_seconds + excluded.executed_seconds,
           updated_at = excluded.updated_at`,
      )
      .run(
        run.requirementId,
        run.planVersion,
        run.taskId,
        run.state,
        run.reason,
        run.executedSeconds,
        run.updatedAt,
      )
  }

  /** 只刷新运行中心跳，不增加执行秒数；任务尚未开始时不做隐式插入。 */
  heartbeatTaskRun(input: {
    requirementId: string
    planVersion: number
    taskId: string
    reason: string
    updatedAt: string
  }): void {
    this.db.handle
      .prepare(
        `UPDATE requirement_task_runs
         SET state = 'running', reason = ?, updated_at = ?
         WHERE req_id = ? AND plan_version = ? AND task_id = ?`,
      )
      .run(input.reason, input.updatedAt, input.requirementId, input.planVersion, input.taskId)
  }

  taskRuns(reqId: string, planVersion: number): TaskRun[] {
    const rows = this.db.handle
      .prepare(
        'SELECT * FROM requirement_task_runs WHERE req_id = ? AND plan_version = ? ORDER BY task_id',
      )
      .all(reqId, planVersion) as Row[]
    return rows.map((row) => ({
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      taskId: text(row, 'task_id'),
      state: text(row, 'state') as TaskRunState,
      reason: text(row, 'reason'),
      executedSeconds: num(row, 'executed_seconds'),
      updatedAt: text(row, 'updated_at'),
    }))
  }

  recordTaskArtifact(artifact: TaskArtifact): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_task_artifacts
          (req_id, plan_version, task_id, candidate_sha256, test_evidence_sha256, review_sha256,
           acceptance, authorization_source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, task_id) DO UPDATE SET
           candidate_sha256 = excluded.candidate_sha256,
           test_evidence_sha256 = excluded.test_evidence_sha256,
           review_sha256 = excluded.review_sha256,
           acceptance = excluded.acceptance,
           authorization_source = excluded.authorization_source,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        artifact.requirementId,
        artifact.planVersion,
        artifact.taskId,
        artifact.candidateSha256,
        artifact.testEvidenceSha256,
        artifact.reviewSha256,
        artifact.acceptance,
        artifact.authorizationSource,
        artifact.recordedAt,
      )
  }

  taskArtifact(reqId: string, planVersion: number, taskId: string): TaskArtifact | null {
    const row = this.db.handle
      .prepare(
        'SELECT * FROM requirement_task_artifacts WHERE req_id = ? AND plan_version = ? AND task_id = ?',
      )
      .get(reqId, planVersion, taskId) as Row | undefined
    if (!row) return null
    return {
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      taskId: text(row, 'task_id'),
      candidateSha256: text(row, 'candidate_sha256'),
      testEvidenceSha256: text(row, 'test_evidence_sha256'),
      reviewSha256: text(row, 'review_sha256'),
      acceptance: text(row, 'acceptance'),
      authorizationSource: text(row, 'authorization_source'),
      recordedAt: text(row, 'recorded_at'),
      baselineCommit: this.evidence(reqId, planVersion, taskId)?.baselineCommit ?? '',
    }
  }

  taskArtifacts(reqId: string, planVersion: number): TaskArtifact[] {
    const rows = this.db.handle
      .prepare(
        'SELECT task_id FROM requirement_task_artifacts WHERE req_id = ? AND plan_version = ? ORDER BY task_id',
      )
      .all(reqId, planVersion) as Row[]
    return rows
      .map((row) => this.taskArtifact(reqId, planVersion, text(row, 'task_id')))
      .filter((artifact): artifact is TaskArtifact => artifact !== null)
  }

  recordEvidence(evidence: RequirementEvidence): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_task_evidence
          (req_id, plan_version, task_id, baseline_commit, workspace_path, candidate_path,
           test_log_path, review_path, dev_session, review_session, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, task_id) DO UPDATE SET
           baseline_commit = excluded.baseline_commit, workspace_path = excluded.workspace_path,
           candidate_path = excluded.candidate_path, test_log_path = excluded.test_log_path,
           review_path = excluded.review_path, dev_session = excluded.dev_session,
           review_session = excluded.review_session, recorded_at = excluded.recorded_at`,
      )
      .run(
        evidence.requirementId,
        evidence.planVersion,
        evidence.taskId,
        evidence.baselineCommit,
        evidence.workspacePath,
        evidence.candidatePath,
        evidence.testLogPath,
        evidence.reviewPath,
        evidence.devSession,
        evidence.reviewSession,
        evidence.recordedAt,
      )
  }

  evidence(reqId: string, planVersion: number, taskId: string): RequirementEvidence | null {
    const row = this.db.handle
      .prepare(
        'SELECT * FROM requirement_task_evidence WHERE req_id = ? AND plan_version = ? AND task_id = ?',
      )
      .get(reqId, planVersion, taskId) as Row | undefined
    if (!row) return null
    return {
      requirementId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      taskId: text(row, 'task_id'),
      baselineCommit: text(row, 'baseline_commit'),
      workspacePath: text(row, 'workspace_path'),
      candidatePath: text(row, 'candidate_path'),
      testLogPath: text(row, 'test_log_path'),
      reviewPath: text(row, 'review_path'),
      devSession: text(row, 'dev_session'),
      reviewSession: text(row, 'review_session'),
      recordedAt: text(row, 'recorded_at'),
    }
  }

  /**
   * 宿主启动时把上一次仍在 running 的任务运行标为 blocked：
   * 执行结果没有收口、工作副本可能有改动，只记录中断，不自动重放。
   */
  markRunningTaskRunsInterrupted(now: string): number {
    const result = this.db.handle
      .prepare(
        "UPDATE requirement_task_runs SET state = 'blocked', reason = ?, updated_at = ? WHERE state = 'running'",
      )
      .run(
        `宿主中断：上一次执行结果未收口，工作副本可能有改动，需核对后重试（${now}）；不会自动重放`,
        now,
      )
    return Number(result.changes)
  }

  // ---------------------------------------------------------------- 失败轮次与授权

  /**
   * 归档一次已交付产物：重新研发前保留旧候选、材料与授权来源，
   * 新尝试按 attempt 递增，不覆盖历史。
   */
  recordArchivedArtifact(input: {
    artifact: TaskArtifact
    attempt: number
    archivedAt: string
    archivedPath: string
    reason: string
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_task_artifact_history
          (req_id, plan_version, task_id, attempt, candidate_sha256, test_evidence_sha256,
           review_sha256, acceptance, authorization_source, recorded_at, archived_at, archived_path, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, task_id, attempt) DO UPDATE SET
           candidate_sha256 = excluded.candidate_sha256,
           test_evidence_sha256 = excluded.test_evidence_sha256,
           review_sha256 = excluded.review_sha256,
           acceptance = excluded.acceptance,
           authorization_source = excluded.authorization_source,
           recorded_at = excluded.recorded_at,
           archived_at = excluded.archived_at,
           archived_path = excluded.archived_path,
           reason = excluded.reason`,
      )
      .run(
        input.artifact.requirementId,
        input.artifact.planVersion,
        input.artifact.taskId,
        input.attempt,
        input.artifact.candidateSha256,
        input.artifact.testEvidenceSha256,
        input.artifact.reviewSha256,
        input.artifact.acceptance,
        input.artifact.authorizationSource,
        input.artifact.recordedAt,
        input.archivedAt,
        input.archivedPath,
        input.reason,
      )
  }

  archivedArtifacts(
    reqId: string,
    planVersion: number,
    taskId: string,
  ): Array<{ attempt: number; candidateSha256: string; archivedAt: string; archivedPath: string; reason: string }> {
    const rows = this.db.handle
      .prepare(
        `SELECT * FROM requirement_task_artifact_history
         WHERE req_id = ? AND plan_version = ? AND task_id = ? ORDER BY attempt`,
      )
      .all(reqId, planVersion, taskId) as Row[]
    return rows.map((row) => ({
      attempt: num(row, 'attempt'),
      candidateSha256: text(row, 'candidate_sha256'),
      archivedAt: text(row, 'archived_at'),
      archivedPath: text(row, 'archived_path'),
      reason: text(row, 'reason'),
    }))
  }

  /** 重新研发：清掉“已交付”标记，让 advance 按原批准任务包重新执行。 */
  clearTaskDelivery(reqId: string, planVersion: number, taskId: string): void {
    this.db.handle
      .prepare('DELETE FROM requirement_task_artifacts WHERE req_id = ? AND plan_version = ? AND task_id = ?')
      .run(reqId, planVersion, taskId)
    this.db.handle
      .prepare('DELETE FROM requirement_task_evidence WHERE req_id = ? AND plan_version = ? AND task_id = ?')
      .run(reqId, planVersion, taskId)
  }

  failureRounds(reqId: string): FailureRound[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM requirement_failure_rounds WHERE req_id = ? ORDER BY occurred_at')
      .all(reqId) as Row[]
    return rows.map((row) => ({
      roundId: text(row, 'round_id'),
      stage: text(row, 'stage') as FailureRound['stage'],
      summary: text(row, 'summary'),
      occurredAt: text(row, 'occurred_at'),
    }))
  }

  recordFailureRound(reqId: string, round: FailureRound): boolean {
    const result = this.db.handle
      .prepare(
        `INSERT OR IGNORE INTO requirement_failure_rounds (req_id, round_id, stage, summary, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(reqId, round.roundId, round.stage, round.summary, round.occurredAt)
    return result.changes > 0
  }

  grantCount(reqId: string): number {
    const row = this.db.handle
      .prepare('SELECT COUNT(*) AS count FROM requirement_grants WHERE req_id = ?')
      .get(reqId) as Row | undefined
    return 1 + (row ? num(row, 'count') : 0)
  }

  appendGrant(reqId: string, grantedBy: string, now: string): number {
    const current = this.grantCount(reqId)
    this.db.handle
      .prepare(
        'INSERT INTO requirement_grants (req_id, grant_index, granted_at, granted_by) VALUES (?, ?, ?, ?)',
      )
      .run(reqId, current, now, grantedBy)
    return current + 1
  }

  // ---------------------------------------------------------------- 工时

  ensureBudget(reqId: string, limitSeconds: number): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_budget (req_id, limit_seconds, consumed_seconds)
         VALUES (?, ?, 0) ON CONFLICT(req_id) DO NOTHING`,
      )
      .run(reqId, limitSeconds)
  }

  budget(reqId: string): { limitSeconds: number; consumedSeconds: number } {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_budget WHERE req_id = ?')
      .get(reqId) as Row | undefined
    if (!row) return { limitSeconds: 7200, consumedSeconds: 0 }
    return { limitSeconds: num(row, 'limit_seconds'), consumedSeconds: num(row, 'consumed_seconds') }
  }

  chargeBudget(reqId: string, seconds: number): void {
    this.db.handle
      .prepare(
        'UPDATE requirement_budget SET consumed_seconds = consumed_seconds + ? WHERE req_id = ?',
      )
      .run(Math.max(0, seconds), reqId)
  }

  // ---------------------------------------------------------------- 操作请求

  /** 受理前落库：同需求同动作的待执行请求复用，不同动作拒绝，已有在跑请求拒绝。 */
  recordRequest(input: {
    requestId: string
    reqId: string
    project: string
    planVersion: number
    action: string
    requestedBy: string
    source: string
    now: string
  }): { request: ServiceRequestRecord; created: boolean } {
    return this.db.transaction(() => {
      const active = this.db.handle
        .prepare(
          "SELECT * FROM service_requests WHERE req_id = ? AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1",
        )
        .get(input.reqId) as Row | undefined
      if (active) {
        const existingAction = text(active, 'action')
        if (existingAction !== input.action) {
          throw new RuleViolationError(
            `需求 ${input.reqId} 已有待执行的 ${existingAction} 请求；不能同时排队 ${input.action}`,
          )
        }
        return { request: requestFromRow(active), created: false }
      }
      this.db.handle
        .prepare(
          `INSERT INTO service_requests
            (request_id, req_id, project, plan_version, action, state, requested_by, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          input.requestId,
          input.reqId,
          input.project,
          input.planVersion,
          input.action,
          input.requestedBy,
          input.source,
          input.now,
        )
      const request = this.request(input.requestId)
      if (!request) throw new RuleViolationError(`请求 ${input.requestId} 写入后不可读`)
      return { request, created: true }
    })
  }

  request(requestId: string): ServiceRequestRecord | null {
    const row = this.db.handle
      .prepare('SELECT * FROM service_requests WHERE request_id = ?')
      .get(requestId) as Row | undefined
    return row ? requestFromRow(row) : null
  }

  requestsFor(reqId: string): ServiceRequestRecord[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM service_requests WHERE req_id = ? ORDER BY created_at DESC')
      .all(reqId) as Row[]
    return rows.map(requestFromRow)
  }

  pendingRequests(project?: string): ServiceRequestRecord[] {
    const rows = (
      project
        ? this.db.handle
            .prepare(
              "SELECT * FROM service_requests WHERE state = 'pending' AND project = ? ORDER BY created_at",
            )
            .all(project)
        : this.db.handle
            .prepare("SELECT * FROM service_requests WHERE state = 'pending' ORDER BY created_at")
            .all()
    ) as Row[]
    return rows.map(requestFromRow)
  }

  /** 原子领取一条待执行请求；返回 null 表示没有可领取工作。 */
  claimNextRequest(owner: string, now: string, project?: string): ServiceRequestRecord | null {
    return this.db.transaction(() => {
      const candidate = (
        project
          ? this.db.handle
              .prepare(
                "SELECT request_id FROM service_requests WHERE state = 'pending' AND project = ? ORDER BY created_at LIMIT 1",
              )
              .get(project)
          : this.db.handle
              .prepare("SELECT request_id FROM service_requests WHERE state = 'pending' ORDER BY created_at LIMIT 1")
              .get()
      ) as Row | undefined
      if (!candidate) return null
      const requestId = text(candidate, 'request_id')
      const result = this.db.handle
        .prepare(
          `UPDATE service_requests SET state = 'claimed', owner = ?, claimed_at = ?,
             attempts = attempts + 1 WHERE request_id = ? AND state = 'pending'`,
        )
        .run(owner, now, requestId)
      if (result.changes === 0) return null
      return this.request(requestId)
    })
  }

  resolveRequest(requestId: string, state: string, detail: string, now: string): void {
    this.db.handle
      .prepare(
        'UPDATE service_requests SET state = ?, detail = ?, resolved_at = ? WHERE request_id = ?',
      )
      .run(state, detail, now, requestId)
  }

  /** 宿主启动时把上次未收口的 claimed 标为 unknown：先核对，不自动重放。 */
  markClaimedUnknown(now: string): ServiceRequestRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.handle
        .prepare("SELECT * FROM service_requests WHERE state = 'claimed'")
        .all() as Row[]
      if (rows.length === 0) return []
      this.db.handle
        .prepare(
          "UPDATE service_requests SET state = 'unknown', detail = ?, resolved_at = ? WHERE state = 'claimed'",
        )
        .run(`宿主重启时该请求仍在执行中，无法确认外部副作用是否已发生（${now}）；需先核对再决定`, now)
      return rows.map(requestFromRow)
    })
  }

  dismissPendingFor(reqId: string, detail: string, now: string): number {
    const result = this.db.handle
      .prepare(
        "UPDATE service_requests SET state = 'dismissed', detail = ?, resolved_at = ? WHERE req_id = ? AND state = 'pending'",
      )
      .run(detail, now, reqId)
    return Number(result.changes)
  }

  // ---------------------------------------------------------------- 动作身份

  startAction(input: {
    actionId: string
    taskId: string
    node: string
    role: string
    detail?: string
    now: string
    pid?: number | null
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO actions (action_id, task_id, node, role, state, started_at, detail, pid, heartbeat_at)
         VALUES (?, ?, ?, ?, 'started', ?, ?, ?, ?)`,
      )
      .run(
        input.actionId,
        input.taskId,
        input.node,
        input.role,
        input.now,
        input.detail ?? '',
        input.pid ?? null,
        input.now,
      )
  }

  finishAction(actionId: string, state: string, detail: string, now: string): void {
    this.db.handle
      .prepare('UPDATE actions SET state = ?, detail = ?, finished_at = ? WHERE action_id = ?')
      .run(state, detail, now, actionId)
  }

  action(actionId: string): ActionRecord | null {
    const row = this.db.handle
      .prepare('SELECT * FROM actions WHERE action_id = ?')
      .get(actionId) as Row | undefined
    return row ? actionFromRow(row) : null
  }

  startedActions(taskId: string): ActionRecord[] {
    const rows = this.db.handle
      .prepare("SELECT * FROM actions WHERE task_id = ? AND state = 'started' ORDER BY started_at")
      .all(taskId) as Row[]
    return rows.map(actionFromRow)
  }

  /** 启动时把未收口的 started 动作标为 interrupted；不删除证据。 */
  markStartedActionsInterrupted(now: string): number {
    const result = this.db.handle
      .prepare(
        "UPDATE actions SET state = 'interrupted', finished_at = ?, detail = detail || ? WHERE state = 'started'",
      )
      .run(now, `\n宿主重启：动作结果未收口，已标记 interrupted（${now}）`)
    return Number(result.changes)
  }

  // ---------------------------------------------------------------- 候选包

  recordCandidate(candidate: {
    reqId: string
    planVersion: number
    sha256: string
    tarball: string
    files: readonly string[]
    gitHead: string
    builtAt: string
    evidenceDir: string
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_candidates
          (req_id, plan_version, sha256, tarball, files_json, git_head, built_at, evidence_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version) DO UPDATE SET
           sha256 = excluded.sha256, tarball = excluded.tarball, files_json = excluded.files_json,
           git_head = excluded.git_head, built_at = excluded.built_at, evidence_dir = excluded.evidence_dir`,
      )
      .run(
        candidate.reqId,
        candidate.planVersion,
        candidate.sha256,
        candidate.tarball,
        JSON.stringify(candidate.files),
        candidate.gitHead,
        candidate.builtAt,
        candidate.evidenceDir,
      )
  }

  candidate(reqId: string, planVersion: number): {
    reqId: string
    planVersion: number
    sha256: string
    tarball: string
    files: string[]
    gitHead: string
    builtAt: string
    evidenceDir: string
  } | null {
    const row = this.db.handle
      .prepare('SELECT * FROM requirement_candidates WHERE req_id = ? AND plan_version = ?')
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    return {
      reqId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      sha256: text(row, 'sha256'),
      tarball: text(row, 'tarball'),
      files: parseStringList(text(row, 'files_json')),
      gitHead: text(row, 'git_head'),
      builtAt: text(row, 'built_at'),
      evidenceDir: text(row, 'evidence_dir'),
    }
  }

  recordCandidateBuild(build: {
    reqId: string
    planVersion: number
    candidateSha256: string
    verificationSha256: string
    packageVersion: string
    artifactSha256: string
    tarball: string
    files: readonly string[]
    gitHead: string
    builtAt: string
    evidenceDir: string
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_candidate_builds
          (req_id, plan_version, candidate_sha256, verification_sha256, package_version,
           artifact_sha256, tarball, files_json, git_head, built_at, evidence_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, candidate_sha256) DO UPDATE SET
           verification_sha256 = excluded.verification_sha256,
           package_version = excluded.package_version,
           artifact_sha256 = excluded.artifact_sha256, tarball = excluded.tarball,
           files_json = excluded.files_json, git_head = excluded.git_head,
           built_at = excluded.built_at, evidence_dir = excluded.evidence_dir`,
      )
      .run(
        build.reqId,
        build.planVersion,
        build.candidateSha256,
        build.verificationSha256,
        build.packageVersion,
        build.artifactSha256,
        build.tarball,
        JSON.stringify(build.files),
        build.gitHead,
        build.builtAt,
        build.evidenceDir,
      )
  }

  candidateBuild(reqId: string, planVersion: number): {
    reqId: string
    planVersion: number
    candidateSha256: string
    verificationSha256: string
    packageVersion: string
    artifactSha256: string
    tarball: string
    files: string[]
    gitHead: string
    builtAt: string
    evidenceDir: string
  } | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_candidate_builds
         WHERE req_id = ? AND plan_version = ? ORDER BY built_at DESC LIMIT 1`,
      )
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    return {
      reqId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      candidateSha256: text(row, 'candidate_sha256'),
      verificationSha256: text(row, 'verification_sha256'),
      packageVersion: text(row, 'package_version'),
      artifactSha256: text(row, 'artifact_sha256'),
      tarball: text(row, 'tarball'),
      files: parseStringList(text(row, 'files_json')),
      gitHead: text(row, 'git_head'),
      builtAt: text(row, 'built_at'),
      evidenceDir: text(row, 'evidence_dir'),
    }
  }

  recordDeployment(deployment: {
    reqId: string
    planVersion: number
    candidateSha256: string
    packageVersion: string
    targetProfile: string
    artifactSha256: string
    runtimeVersion: string
    state: string
    checks: readonly unknown[]
    evidenceDir: string
    recordedBy: string
    source: string
    recordedAt: string
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO requirement_deployments
          (req_id, plan_version, candidate_sha256, package_version, target_profile,
           artifact_sha256, runtime_version, state, checks_json, evidence_dir,
           recorded_by, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, plan_version, candidate_sha256, target_profile) DO UPDATE SET
           package_version = excluded.package_version, artifact_sha256 = excluded.artifact_sha256,
           runtime_version = excluded.runtime_version, state = excluded.state,
           checks_json = excluded.checks_json, evidence_dir = excluded.evidence_dir,
           recorded_by = excluded.recorded_by, source = excluded.source,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        deployment.reqId,
        deployment.planVersion,
        deployment.candidateSha256,
        deployment.packageVersion,
        deployment.targetProfile,
        deployment.artifactSha256,
        deployment.runtimeVersion,
        deployment.state,
        JSON.stringify(deployment.checks),
        deployment.evidenceDir,
        deployment.recordedBy,
        deployment.source,
        deployment.recordedAt,
      )
  }

  deployment(reqId: string, planVersion: number): {
    reqId: string
    planVersion: number
    candidateSha256: string
    packageVersion: string
    targetProfile: string
    artifactSha256: string
    runtimeVersion: string
    state: string
    checks: unknown[]
    evidenceDir: string
    recordedBy: string
    source: string
    recordedAt: string
  } | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM requirement_deployments
         WHERE req_id = ? AND plan_version = ? ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(reqId, planVersion) as Row | undefined
    if (!row) return null
    let checks: unknown[] = []
    try {
      const parsed: unknown = JSON.parse(text(row, 'checks_json'))
      if (Array.isArray(parsed)) checks = parsed
    } catch {
      checks = []
    }
    return {
      reqId: text(row, 'req_id'),
      planVersion: num(row, 'plan_version'),
      candidateSha256: text(row, 'candidate_sha256'),
      packageVersion: text(row, 'package_version'),
      targetProfile: text(row, 'target_profile'),
      artifactSha256: text(row, 'artifact_sha256'),
      runtimeVersion: text(row, 'runtime_version'),
      state: text(row, 'state'),
      checks,
      evidenceDir: text(row, 'evidence_dir'),
      recordedBy: text(row, 'recorded_by'),
      source: text(row, 'source'),
      recordedAt: text(row, 'recorded_at'),
    }
  }

  // ---------------------------------------------------------------- 运维事件

  createOpsEvent(input: {
    eventId: string
    project: string
    resourceId: string
    checkId: string
    signature: string
    severity: string
    state: string
    title: string
    impact?: string
    openedAt: string
    updatedAt: string
  }): OpsEventRecord {
    this.db.handle
      .prepare(
        `INSERT INTO ops_events
           (event_id, project, resource_id, check_id, signature, severity, state, title, impact, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.project,
        input.resourceId,
        input.checkId,
        input.signature,
        input.severity,
        input.state,
        input.title,
        input.impact ?? '',
        input.openedAt,
        input.updatedAt,
      )
    const record = this.opsEvent(input.eventId)
    if (!record) throw new RuleViolationError(`运维事件 ${input.eventId} 写入后不可读`)
    return record
  }

  opsEvent(eventId: string): OpsEventRecord | null {
    const row = this.db.handle.prepare('SELECT * FROM ops_events WHERE event_id = ?').get(eventId) as
      | Row
      | undefined
    return row ? opsEventFromRow(row) : null
  }

  /** 同一项目内按失败签名查找仍在处理中的事件；终态事件不吸收新告警。 */
  findActiveOpsEvent(project: string, signature: string): OpsEventRecord | null {
    const row = this.db.handle
      .prepare(
        `SELECT * FROM ops_events
          WHERE project = ? AND signature = ?
            AND state IN ('open', 'diagnosed', 'awaiting_decision', 'recovering', 'unresolved', 'unknown')
          ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(project, signature) as Row | undefined
    return row ? opsEventFromRow(row) : null
  }

  listOpsEvents(project: string, limit = 200): OpsEventRecord[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM ops_events WHERE project = ? ORDER BY opened_at DESC LIMIT ?')
      .all(project, limit) as Row[]
    return rows.map(opsEventFromRow)
  }

  /** 按白名单列更新事件；未知字段直接拒绝，避免把任意键拼进 SQL。 */
  updateOpsEvent(eventId: string, patch: OpsEventPatch): OpsEventRecord {
    const columns: Record<keyof OpsEventPatch, string> = {
      state: 'state',
      title: 'title',
      impact: 'impact',
      severity: 'severity',
      recoveredAt: 'recovered_at',
      closedAt: 'closed_at',
      diagnosisJson: 'diagnosis_json',
      diagnosisPath: 'diagnosis_path',
      diagnosisSession: 'diagnosis_session',
      fixRequirementId: 'fix_requirement_id',
      decision: 'decision',
      decisionBy: 'decision_by',
      decisionSource: 'decision_source',
      decisionAt: 'decision_at',
      humanInvolved: 'human_involved',
      humanReason: 'human_reason',
      resultUnknown: 'result_unknown',
      updatedAt: 'updated_at',
    }
    const assignments: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as Array<[keyof OpsEventPatch, unknown]>) {
      const column = columns[key]
      if (!column) throw new RuleViolationError(`运维事件不支持更新字段 ${String(key)}`)
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (assignments.length === 0) throw new RuleViolationError('运维事件更新至少需要一个字段')
    this.db.handle
      .prepare(`UPDATE ops_events SET ${assignments.join(', ')} WHERE event_id = ?`)
      .run(...(values as Array<string | number>), eventId)
    const record = this.opsEvent(eventId)
    if (!record) throw new RuleViolationError(`未找到运维事件 ${eventId}`)
    return record
  }

  linkOpsFixRequirement(eventId: string, reqId: string, now: string): void {
    const event = this.opsEvent(eventId)
    if (!event) throw new RuleViolationError(`未找到运维事件 ${eventId}`)
    if (event.fixRequirementId && event.fixRequirementId !== reqId) {
      throw new RuleViolationError(`运维事件 ${eventId} 已经关联修复需求 ${event.fixRequirementId}`)
    }
    this.updateOpsEvent(eventId, { fixRequirementId: reqId, updatedAt: now })
  }

  appendOpsObservation(input: {
    eventId: string
    at: string
    kind: string
    summary: string
    detailJson?: string
    evidencePath?: string
  }): OpsObservationRecord {
    const seq = this.db.transaction(() => {
      const row = this.db.handle
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM ops_observations WHERE event_id = ?')
        .get(input.eventId) as Row | undefined
      const next = (row ? num(row, 'seq') : 0) + 1
      this.db.handle
        .prepare(
          `INSERT INTO ops_observations (event_id, seq, at, kind, summary, detail_json, evidence_path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.eventId, next, input.at, input.kind, input.summary, input.detailJson ?? '', input.evidencePath ?? '')
      return next
    })
    return {
      eventId: input.eventId,
      seq,
      at: input.at,
      kind: input.kind,
      summary: input.summary,
      detailJson: input.detailJson ?? '',
      evidencePath: input.evidencePath ?? '',
    }
  }

  opsObservations(eventId: string): OpsObservationRecord[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM ops_observations WHERE event_id = ? ORDER BY seq')
      .all(eventId) as Row[]
    return rows.map((row) => ({
      eventId: text(row, 'event_id'),
      seq: num(row, 'seq'),
      at: text(row, 'at'),
      kind: text(row, 'kind'),
      summary: text(row, 'summary'),
      detailJson: text(row, 'detail_json'),
      evidencePath: text(row, 'evidence_path'),
    }))
  }

  recordOpsActionAttempt(input: {
    actionId: string
    eventId: string
    actionDefId: string
    paramsJson?: string
    state: string
    authorizationSource: string
    detail?: string
    exitCode?: number | null
    startedAt: string
    evidencePath?: string
  }): void {
    this.db.handle
      .prepare(
        `INSERT INTO ops_action_attempts
           (action_id, event_id, action_def_id, params_json, state, authorization_source, detail, exit_code, started_at, evidence_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actionId,
        input.eventId,
        input.actionDefId,
        input.paramsJson ?? '{}',
        input.state,
        input.authorizationSource,
        input.detail ?? '',
        input.exitCode ?? null,
        input.startedAt,
        input.evidencePath ?? '',
      )
  }

  finishOpsActionAttempt(
    actionId: string,
    patch: {
      state: string
      detail: string
      exitCode: number | null
      finishedAt: string
      evidencePath?: string
    },
  ): void {
    this.db.handle
      .prepare(
        `UPDATE ops_action_attempts
            SET state = ?, detail = ?, exit_code = ?, finished_at = ?, evidence_path = ?
          WHERE action_id = ?`,
      )
      .run(patch.state, patch.detail, patch.exitCode, patch.finishedAt, patch.evidencePath ?? '', actionId)
  }

  opsActionAttempts(eventId: string): OpsActionAttemptRecord[] {
    const rows = this.db.handle
      .prepare('SELECT * FROM ops_action_attempts WHERE event_id = ? ORDER BY started_at, action_id')
      .all(eventId) as Row[]
    return rows.map(opsActionAttemptFromRow)
  }

  latestOpsActionAttempt(eventId: string): OpsActionAttemptRecord | null {
    const row = this.db.handle
      .prepare('SELECT * FROM ops_action_attempts WHERE event_id = ? ORDER BY started_at DESC, action_id DESC LIMIT 1')
      .get(eventId) as Row | undefined
    return row ? opsActionAttemptFromRow(row) : null
  }

  /**
   * 宿主启动时把未收口的动作标为 unknown：外部副作用无法确认，不能自动重放。
   * 返回被标记的动作，供启动记录引用。
   */
  markRunningOpsActionsUnknown(now: string): Array<{ actionId: string; eventId: string }> {
    const rows = this.db.handle
      .prepare("SELECT * FROM ops_action_attempts WHERE state = 'running' ORDER BY started_at")
      .all() as Row[]
    const marked: Array<{ actionId: string; eventId: string }> = []
    for (const row of rows) {
      const actionId = text(row, 'action_id')
      const eventId = text(row, 'event_id')
      this.db.handle
        .prepare(
          `UPDATE ops_action_attempts
              SET state = 'unknown', detail = ?, finished_at = ?
            WHERE action_id = ?`,
        )
        .run('宿主中断：动作结果未知，需核对外部副作用后再收口；不自动重放', now, actionId)
      const event = this.opsEvent(eventId)
      if (event && event.state !== 'closed') {
        this.updateOpsEvent(eventId, { state: 'unknown', resultUnknown: true, updatedAt: now })
      }
      marked.push({ actionId, eventId })
    }
    return marked
  }

  // ---------------------------------------------------------------- 元信息

  setMeta(key: string, value: string, now = isoNow()): void {
    this.db.handle
      .prepare(
        `INSERT INTO runtime_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now)
  }

  getMeta(key: string): string | null {
    const row = this.db.handle.prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key) as
      | Row
      | undefined
    return row ? text(row, 'value') : null
  }
}

function requestFromRow(row: Row): ServiceRequestRecord {
  return {
    requestId: text(row, 'request_id'),
    reqId: text(row, 'req_id'),
    project: text(row, 'project'),
    planVersion: num(row, 'plan_version'),
    action: text(row, 'action') || 'advance',
    state: text(row, 'state'),
    requestedBy: text(row, 'requested_by'),
    source: text(row, 'source'),
    createdAt: text(row, 'created_at'),
    resolvedAt: text(row, 'resolved_at'),
    detail: text(row, 'detail'),
    owner: text(row, 'owner'),
    claimedAt: text(row, 'claimed_at'),
    attempts: num(row, 'attempts'),
  }
}

function actionFromRow(row: Row): ActionRecord {
  return {
    actionId: text(row, 'action_id'),
    taskId: text(row, 'task_id'),
    node: text(row, 'node'),
    role: text(row, 'role'),
    state: text(row, 'state'),
    startedAt: text(row, 'started_at'),
    finishedAt: text(row, 'finished_at'),
    detail: text(row, 'detail'),
    pid: row.pid === null || row.pid === undefined ? null : num(row, 'pid'),
    heartbeatAt: text(row, 'heartbeat_at'),
  }
}

function opsEventFromRow(row: Row): OpsEventRecord {
  return {
    eventId: text(row, 'event_id'),
    project: text(row, 'project'),
    resourceId: text(row, 'resource_id'),
    checkId: text(row, 'check_id'),
    signature: text(row, 'signature'),
    severity: text(row, 'severity') as OpsSeverity,
    state: text(row, 'state'),
    title: text(row, 'title'),
    impact: text(row, 'impact'),
    openedAt: text(row, 'opened_at'),
    updatedAt: text(row, 'updated_at'),
    recoveredAt: text(row, 'recovered_at'),
    closedAt: text(row, 'closed_at'),
    diagnosisJson: text(row, 'diagnosis_json'),
    diagnosisPath: text(row, 'diagnosis_path'),
    diagnosisSession: text(row, 'diagnosis_session'),
    fixRequirementId: text(row, 'fix_requirement_id'),
    decision: text(row, 'decision'),
    decisionBy: text(row, 'decision_by'),
    decisionSource: text(row, 'decision_source'),
    decisionAt: text(row, 'decision_at'),
    humanInvolved: num(row, 'human_involved') === 1,
    humanReason: text(row, 'human_reason'),
    resultUnknown: num(row, 'result_unknown') === 1,
  }
}

function opsActionAttemptFromRow(row: Row): OpsActionAttemptRecord {
  const exitCode = row.exit_code
  return {
    actionId: text(row, 'action_id'),
    eventId: text(row, 'event_id'),
    actionDefId: text(row, 'action_def_id'),
    paramsJson: text(row, 'params_json'),
    state: text(row, 'state'),
    authorizationSource: text(row, 'authorization_source'),
    detail: text(row, 'detail'),
    exitCode: exitCode === null || exitCode === undefined ? null : num(row, 'exit_code'),
    startedAt: text(row, 'started_at'),
    finishedAt: text(row, 'finished_at'),
    evidencePath: text(row, 'evidence_path'),
  }
}

function parseStringList(raw: string): string[] {
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data) || data.some((item) => typeof item !== 'string')) {
    throw new RuleViolationError('记录损坏：期望字符串数组')
  }
  return data as string[]
}

function planToPayload(plan: TaskPlan): unknown {
  return {
    task_plan_id: plan.taskPlanId,
    requirement_id: plan.requirementId,
    project: plan.project,
    plan_version: plan.planVersion,
    requirement_version: plan.requirementVersion,
    created_at: plan.createdAt,
    technical_solution: plan.technicalSolution
      ? {
          summary: plan.technicalSolution.summary,
          approach: plan.technicalSolution.approach,
          risks: plan.technicalSolution.risks,
        }
      : undefined,
    tasks: plan.tasks.map((task) => ({
      task_id: task.taskId,
      goal: task.goal,
      files: task.files,
      acceptance: task.acceptance,
      test_command: task.testCommand,
      depends_on: task.dependsOn,
      limits: {
        limit_seconds: task.limits.limitSeconds,
        max_failure_rounds: task.limits.maxFailureRounds,
      },
      authorization_source: task.authorizationSource,
      ...(task.verification === true ? { verification: true } : {}),
    })),
  }
}

function planFromPayload(
  payload: unknown,
  context: { requirementId: string; taskPlanId: string; planVersion: number; createdAt: string },
): TaskPlan {
  const data = payload as Record<string, unknown>
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : []
  const rawSolution = data.technical_solution
  const technicalSolution = rawSolution && typeof rawSolution === 'object'
    ? {
        summary: String((rawSolution as Record<string, unknown>).summary ?? ''),
        approach: stringArray((rawSolution as Record<string, unknown>).approach),
        risks: stringArray((rawSolution as Record<string, unknown>).risks),
      }
    : undefined
  return {
    taskPlanId: context.taskPlanId,
    requirementId: context.requirementId,
    project: String(data.project ?? ''),
    planVersion: context.planVersion,
    requirementVersion: Number(data.requirement_version ?? 1),
    ...(technicalSolution === undefined ? {} : { technicalSolution }),
    createdAt: context.createdAt,
    tasks: rawTasks.map((raw) => {
      const task = raw as Record<string, unknown>
      const limits = (task.limits ?? {}) as Record<string, unknown>
      return {
        taskId: String(task.task_id ?? ''),
        goal: String(task.goal ?? ''),
        files: stringArray(task.files),
        acceptance: String(task.acceptance ?? ''),
        testCommand: stringArray(task.test_command),
        dependsOn: stringArray(task.depends_on),
        limits: {
          limitSeconds: Number(limits.limit_seconds ?? 7200),
          maxFailureRounds: Number(limits.max_failure_rounds ?? 3),
        },
        authorizationSource: String(task.authorization_source ?? ''),
        ...(task.verification === true ? { verification: true } : {}),
      }
    }),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}