/**
 * 研发会话持久化：会话、需求与会话绑定、会话总结三张表。
 *
 * 从 Repository 拆出单独一类，避免仓储文件超出上下文与行数预算；
 * Repository 继承本类，对调用方仍是同一组方法。
 */

import { RuleViolationError } from '../domain/errors.js'
import { ReliabilityStore } from './reliability-store.js'
import {
  num,
  text,
  type DevSessionRecord,
  type DevSessionSummaryRecord,
  type RequirementDevSessionRecord,
  type Row,
} from './rows.js'

export class DevSessionStore extends ReliabilityStore {
  // ---------------------------------------------------------------- 研发会话

  /** 登记或更新一个研发会话；会话记录不删除，需求结束后只改忙闲与总结。 */
  upsertDevSession(input: {
    sessionId: string
    project: string
    workspace: string
    now: string
  }): DevSessionRecord {
    this.db
      .prepare(
        `INSERT INTO dev_sessions (session_id, project, workspace, state, created_at, updated_at)
         VALUES (?, ?, ?, 'idle', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           workspace = excluded.workspace,
           updated_at = excluded.updated_at`,
      )
      .run(input.sessionId, input.project, input.workspace, input.now, input.now)
    const session = this.devSession(input.sessionId)
    if (!session) throw new RuleViolationError(`研发会话 ${input.sessionId} 写入后不可读`)
    return session
  }

  devSession(sessionId: string): DevSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM dev_sessions WHERE session_id = ?').get(sessionId)
    return row ? devSessionFromRow(row) : null
  }

  devSessions(project?: string): DevSessionRecord[] {
    const rows = project
      ? this.db
          .prepare('SELECT * FROM dev_sessions WHERE project = ? ORDER BY updated_at DESC')
          .all(project)
      : this.db.prepare('SELECT * FROM dev_sessions ORDER BY updated_at DESC').all()
    return rows.map(devSessionFromRow)
  }

  updateDevSession(
    sessionId: string,
    patch: {
      state?: string
      summary?: string
      summarySha256?: string
      summaryPath?: string
      lastReqId?: string
      leaseRequestId?: string
      updatedAt: string
    },
  ): void {
    const fields: string[] = []
    const values: Array<string> = []
    for (const [column, value] of [
      ['state', patch.state],
      ['summary', patch.summary],
      ['summary_sha256', patch.summarySha256],
      ['summary_path', patch.summaryPath],
      ['last_req_id', patch.lastReqId],
      ['lease_request_id', patch.leaseRequestId],
    ] as const) {
      if (value === undefined) continue
      fields.push(`${column} = ?`)
      values.push(value)
    }
    fields.push('updated_at = ?')
    values.push(patch.updatedAt)
    this.db
      .prepare(`UPDATE dev_sessions SET ${fields.join(', ')} WHERE session_id = ?`)
      .run(...values, sessionId)
  }

  /** 原子地占住空闲会话；已被别的请求占用时返回 false，由调用方等待。 */
  leaseDevSession(sessionId: string, requestId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE dev_sessions SET state = 'busy', lease_request_id = ?, updated_at = ?
         WHERE session_id = ? AND state = 'idle'`,
      )
      .run(requestId, now, sessionId)
    return result.changes > 0
  }

  releaseDevSession(sessionId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE dev_sessions SET state = 'idle', lease_request_id = '', updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId)
  }

  /** 宿主重启后本进程没有任何在途会话：把遗留 busy 释放为空闲，保留绑定与总结。 */
  resetBusyDevSessions(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE dev_sessions SET state = 'idle', lease_request_id = '', updated_at = ?
         WHERE state = 'busy'`,
      )
      .run(now)
    return result.changes
  }

  bindRequirementDevSession(input: {
    reqId: string
    requirementVersion: number
    sessionId: string
    workspace: string
    baselineCommit?: string
    snapshotCommit?: string
    selectedBy: string
    reason: string
    now: string
  }): RequirementDevSessionRecord {
    const existing = this.requirementDevSession(input.reqId, input.requirementVersion)
    const baseline = input.baselineCommit ?? existing?.baselineCommit ?? ''
    const snapshot = input.snapshotCommit ?? existing?.snapshotCommit ?? ''
    this.db
      .prepare(
        `INSERT INTO requirement_dev_sessions
           (req_id, requirement_version, session_id, workspace, baseline_commit, snapshot_commit,
            selected_by, reason, assigned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, requirement_version) DO UPDATE SET
           session_id = excluded.session_id,
           workspace = excluded.workspace,
           baseline_commit = excluded.baseline_commit,
           snapshot_commit = excluded.snapshot_commit,
           selected_by = excluded.selected_by,
           reason = excluded.reason`,
      )
      .run(
        input.reqId,
        input.requirementVersion,
        input.sessionId,
        input.workspace,
        baseline,
        snapshot,
        input.selectedBy,
        input.reason,
        input.now,
      )
    const binding = this.requirementDevSession(input.reqId, input.requirementVersion)
    if (!binding) throw new RuleViolationError(`需求 ${input.reqId} 的研发会话绑定写入后不可读`)
    return binding
  }

  requirementDevSession(
    reqId: string,
    requirementVersion: number,
  ): RequirementDevSessionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM requirement_dev_sessions WHERE req_id = ? AND requirement_version = ?',
      )
      .get(reqId, requirementVersion)
    return row ? requirementDevSessionFromRow(row) : null
  }

  requirementDevSessions(project?: string): RequirementDevSessionRecord[] {
    const rows = project
      ? this.db
          .prepare(
            `SELECT d.* FROM requirement_dev_sessions d
             JOIN requirements r ON r.req_id = d.req_id
             WHERE r.project = ? ORDER BY d.assigned_at DESC`,
          )
          .all(project)
      : this.db.prepare('SELECT * FROM requirement_dev_sessions ORDER BY assigned_at DESC').all()
    return rows.map(requirementDevSessionFromRow)
  }

  releaseRequirementDevSession(reqId: string, requirementVersion: number, now: string): void {
    this.db
      .prepare(
        `UPDATE requirement_dev_sessions SET released_at = ?
         WHERE req_id = ? AND requirement_version = ?`,
      )
      .run(now, reqId, requirementVersion)
  }

  recordDevSessionSummary(input: {
    sessionId: string
    reqId: string
    summary: string
    summarySha256: string
    summaryPath: string
    now: string
  }): DevSessionSummaryRecord {
    this.db
      .prepare(
        `INSERT INTO dev_session_summaries
           (session_id, req_id, summary, summary_sha256, summary_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, req_id) DO UPDATE SET
           summary = excluded.summary,
           summary_sha256 = excluded.summary_sha256,
           summary_path = excluded.summary_path,
           created_at = excluded.created_at`,
      )
      .run(
        input.sessionId,
        input.reqId,
        input.summary,
        input.summarySha256,
        input.summaryPath,
        input.now,
      )
    const summary = this.devSessionSummary(input.sessionId, input.reqId)
    if (!summary) throw new RuleViolationError(`会话 ${input.sessionId} 的总结写入后不可读`)
    return summary
  }

  devSessionSummary(sessionId: string, reqId: string): DevSessionSummaryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM dev_session_summaries WHERE session_id = ? AND req_id = ?')
      .get(sessionId, reqId)
    return row ? devSessionSummaryFromRow(row) : null
  }

  latestDevSessionSummary(sessionId: string): DevSessionSummaryRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM dev_session_summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(sessionId)
    return row ? devSessionSummaryFromRow(row) : null
  }

  devSessionSummaries(sessionId: string): DevSessionSummaryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM dev_session_summaries WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId)
    return rows.map(devSessionSummaryFromRow)
  }
}

function devSessionFromRow(row: Row): DevSessionRecord {
  return {
    sessionId: text(row, 'session_id'),
    project: text(row, 'project'),
    workspace: text(row, 'workspace'),
    state: text(row, 'state'),
    summary: text(row, 'summary'),
    summarySha256: text(row, 'summary_sha256'),
    summaryPath: text(row, 'summary_path'),
    lastReqId: text(row, 'last_req_id'),
    leaseRequestId: text(row, 'lease_request_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  }
}

function requirementDevSessionFromRow(row: Row): RequirementDevSessionRecord {
  return {
    reqId: text(row, 'req_id'),
    requirementVersion: num(row, 'requirement_version'),
    sessionId: text(row, 'session_id'),
    workspace: text(row, 'workspace'),
    baselineCommit: text(row, 'baseline_commit'),
    snapshotCommit: text(row, 'snapshot_commit'),
    selectedBy: text(row, 'selected_by'),
    reason: text(row, 'reason'),
    assignedAt: text(row, 'assigned_at'),
    releasedAt: text(row, 'released_at'),
  }
}

function devSessionSummaryFromRow(row: Row): DevSessionSummaryRecord {
  return {
    sessionId: text(row, 'session_id'),
    reqId: text(row, 'req_id'),
    summary: text(row, 'summary'),
    summarySha256: text(row, 'summary_sha256'),
    summaryPath: text(row, 'summary_path'),
    createdAt: text(row, 'created_at'),
  }
}
