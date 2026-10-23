/**
 * 权威业务记录（TypeScript）：需求与版本、分析、任务包与批准、任务运行与产物、
 * 持久操作请求、动作身份、失败轮次/授权与工时。
 *
 * 旧 Python 记录库可被直接打开：表名与列保持兼容，只补新列；新运行时表独立。
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

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function num(row: Row, key: string): number {
  const value = row[key]
  return typeof value === 'number' ? value : Number(value ?? 0)
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

  // ---------------------------------------------------------------- 失败轮次与授权

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
    })),
  }
}

function planFromPayload(
  payload: unknown,
  context: { requirementId: string; taskPlanId: string; planVersion: number; createdAt: string },
): TaskPlan {
  const data = payload as Record<string, unknown>
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : []
  return {
    taskPlanId: context.taskPlanId,
    requirementId: context.requirementId,
    project: String(data.project ?? ''),
    planVersion: context.planVersion,
    requirementVersion: Number(data.requirement_version ?? 1),
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
      }
    }),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}