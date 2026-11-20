import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'

export type BusinessContextStatus = 'draft' | 'applied' | 'rejected'

export interface BusinessContextChange {
  readonly reqId: string
  readonly analysisVersion: number
  readonly requirementVersion: number
  readonly changed: boolean
  readonly reason: string
  readonly status: BusinessContextStatus
  readonly documentSha256: string
  readonly appliedAt: string
  readonly createdAt: string
}

export class BusinessContextStore {
  constructor(readonly db: Database) {}

  recordDraft(input: {
    reqId: string
    analysisVersion: number
    requirementVersion: number
    document: string
    reason: string
    createdAt: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO requirement_business_context_changes
          (req_id, analysis_version, requirement_version, changed, reason, document, status,
           doc_sha256, applied_at, created_at)
         VALUES (?, ?, ?, 1, ?, ?, 'draft', '', '', ?)
         ON CONFLICT(req_id, analysis_version) DO UPDATE SET
           requirement_version = excluded.requirement_version,
           reason = excluded.reason,
           document = excluded.document,
           status = 'draft',
           doc_sha256 = '',
           applied_at = '',
           created_at = excluded.created_at`,
      )
      .run(
        input.reqId,
        input.analysisVersion,
        input.requirementVersion,
        input.reason,
        input.document,
        input.createdAt,
      )
  }

  markApplied(input: {
    reqId: string
    analysisVersion: number
    docSha256: string
    appliedAt: string
  }): void {
    this.db
      .prepare(
        `UPDATE requirement_business_context_changes
         SET status = 'applied', doc_sha256 = ?, applied_at = ?
         WHERE req_id = ? AND analysis_version = ?`,
      )
      .run(input.docSha256, input.appliedAt, input.reqId, input.analysisVersion)
  }

  changes(reqId: string): BusinessContextChange[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_business_context_changes
         WHERE req_id = ? ORDER BY analysis_version`,
      )
      .all(reqId)
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      analysisVersion: num(row, 'analysis_version'),
      requirementVersion: num(row, 'requirement_version'),
      changed: num(row, 'changed') === 1,
      reason: text(row, 'reason'),
      status: businessContextStatusOf(text(row, 'status')),
      documentSha256: text(row, 'doc_sha256'),
      appliedAt: text(row, 'applied_at'),
      createdAt: text(row, 'created_at'),
    }))
  }

  latestDraft(reqId: string): BusinessContextChange | null {
    const changes = this.changes(reqId).filter((change) => change.status === 'draft')
    return changes.at(-1) ?? null
  }
}

function businessContextStatusOf(value: string): BusinessContextStatus {
  if (value === 'applied' || value === 'rejected' || value === 'draft') return value
  return 'draft'
}
