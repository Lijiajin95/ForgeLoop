import type { Database } from './db.js'
import { num, text } from './rows.js'
import { asRecord } from '../domain/json.js'
import type { AssumptionResult } from '../domain/assumption-result.js'

export class AssumptionResultStore {
  constructor(readonly db: Database) {}

  record(result: AssumptionResult): void {
    this.db
      .prepare(
        `INSERT INTO requirement_assumption_results
          (req_id, analysis_version, assumption_id, status, evidence, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(req_id, analysis_version, assumption_id) DO UPDATE SET
           status = excluded.status,
           evidence = excluded.evidence,
           recorded_by = excluded.recorded_by,
           created_at = excluded.created_at`,
      )
      .run(
        result.reqId,
        result.analysisVersion,
        result.assumptionId,
        result.status,
        result.evidence,
        result.recordedBy,
        result.createdAt,
      )
  }

  list(reqId: string): AssumptionResult[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM requirement_assumption_results WHERE req_id = ? ORDER BY analysis_version, assumption_id',
      )
      .all(reqId)
    return rows
      .map(asRecord)
      .filter((row) => row !== undefined)
      .map((row) => ({
        reqId,
        analysisVersion: num(row, 'analysis_version'),
        assumptionId: text(row, 'assumption_id'),
        status: text(row, 'status') === 'invalidated' ? 'invalidated' : 'validated',
        evidence: text(row, 'evidence'),
        recordedBy: text(row, 'recorded_by'),
        createdAt: text(row, 'created_at'),
      }))
  }
}
