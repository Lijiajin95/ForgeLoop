import type { Database } from './db.js'
import { RuleViolationError } from '../domain/errors.js'
import type { OpsSeverity } from '../domain/ops.js'
import {
  num,
  text,
  type OpsActionAttemptRecord,
  type OpsEventPatch,
  type OpsEventRecord,
  type OpsObservationRecord,
  type Row,
} from './rows.js'

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

export class OpsStore {
  constructor(readonly db: Database) {}

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
    this.db
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
    const row = this.db.prepare('SELECT * FROM ops_events WHERE event_id = ?').get(eventId)
    return row ? opsEventFromRow(row) : null
  }

  /** 同一项目内按失败签名查找仍在处理中的事件；终态事件不吸收新告警。 */
  findActiveOpsEvent(project: string, signature: string): OpsEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ops_events
          WHERE project = ? AND signature = ?
            AND state IN ('open', 'diagnosed', 'awaiting_decision', 'recovering', 'unresolved')
          ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(project, signature)
    return row ? opsEventFromRow(row) : null
  }

  listOpsEvents(project: string, limit = 200): OpsEventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM ops_events WHERE project = ? ORDER BY opened_at DESC LIMIT ?')
      .all(project, limit)
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
      updatedAt: 'updated_at',
    }
    const assignments: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as Array<[keyof OpsEventPatch, unknown]>) {
      const column = columns[key]
      if (!column) throw new RuleViolationError(`运维事件不支持更新字段 ${key}`)
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (assignments.length === 0) throw new RuleViolationError('运维事件更新至少需要一个字段')
    this.db
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
        .get(input.eventId)
      const next = (row ? num(row, 'seq') : 0) + 1
      this.db.handle
        .prepare(
          `INSERT INTO ops_observations (event_id, seq, at, kind, summary, detail_json, evidence_path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.eventId,
          next,
          input.at,
          input.kind,
          input.summary,
          input.detailJson ?? '',
          input.evidencePath ?? '',
        )
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
    const rows = this.db
      .prepare('SELECT * FROM ops_observations WHERE event_id = ? ORDER BY seq')
      .all(eventId)
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
    this.db
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
    this.db
      .prepare(
        `UPDATE ops_action_attempts
            SET state = ?, detail = ?, exit_code = ?, finished_at = ?, evidence_path = ?
          WHERE action_id = ?`,
      )
      .run(
        patch.state,
        patch.detail,
        patch.exitCode,
        patch.finishedAt,
        patch.evidencePath ?? '',
        actionId,
      )
  }

  opsActionAttempts(eventId: string): OpsActionAttemptRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM ops_action_attempts WHERE event_id = ? ORDER BY started_at, action_id',
      )
      .all(eventId)
    return rows.map(opsActionAttemptFromRow)
  }

  latestOpsActionAttempt(eventId: string): OpsActionAttemptRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM ops_action_attempts WHERE event_id = ? ORDER BY started_at DESC, action_id DESC LIMIT 1',
      )
      .get(eventId)
    return row ? opsActionAttemptFromRow(row) : null
  }

  /**
   * 宿主启动时收口上次未完成的处置动作：动作已经不在，但退出码没有落库。
   * 记录为 `interrupted`（事实：没有结果记录），事件按“未解决”收口，
   * 由运维 Agent 分析根因后上报；不自动重放动作。
   */
  markRunningOpsActionsInterrupted(now: string): Array<{ actionId: string; eventId: string }> {
    const rows = this.db
      .prepare("SELECT * FROM ops_action_attempts WHERE state = 'running' ORDER BY started_at")
      .all()
    const marked: Array<{ actionId: string; eventId: string }> = []
    for (const row of rows) {
      const actionId = text(row, 'action_id')
      const eventId = text(row, 'event_id')
      this.db.handle
        .prepare(
          `UPDATE ops_action_attempts
              SET state = 'interrupted', detail = ?, finished_at = ?
            WHERE action_id = ?`,
        )
        .run('宿主中断：没有退出码或结果记录；事件按未解决收口，不自动重放', now, actionId)
      const event = this.opsEvent(eventId)
      if (event && event.state !== 'closed' && event.state !== 'recovered') {
        this.updateOpsEvent(eventId, { state: 'unresolved', updatedAt: now })
      }
      marked.push({ actionId, eventId })
    }
    return marked
  }

  /**
   * 旧库里的运维 unknown 收口：事件改为未解决，动作尝试改为 interrupted。
   * 只做一次迁移；新库不会写入 unknown。
   */
  migrateLegacyOpsUnknown(now: string): number {
    return this.db.transaction(() => {
      const attempts = this.db.handle
        .prepare(
          `UPDATE ops_action_attempts
              SET state = 'interrupted', detail = detail || ?
            WHERE state = 'unknown'`,
        )
        .run(`（旧 unknown 已改为 interrupted：${now}）`)
      const events = this.db.handle
        .prepare(
          `UPDATE ops_events SET state = 'unresolved', updated_at = ?
            WHERE state = 'unknown'`,
        )
        .run(now)
      return Number(attempts.changes) + Number(events.changes)
    })
  }

  // ---------------------------------------------------------------- 元信息
}
