/** 非代码缺陷的验证异常（环境/测试/证据），单独留档，不计入正式失败轮次。 */
import type { Database } from './db.js'
import { text } from './rows.js'

export interface ExecutionAnomalyInput {
  readonly anomalyId: string
  readonly requirementId: string
  readonly planVersion: number
  readonly candidateSha256: string
  readonly kind: string
  readonly stage: string
  readonly detail: string
  readonly evidence: unknown
  readonly createdAt: string
}

export interface ExecutionAnomalyRecord {
  readonly anomalyId: string
  readonly kind: string
  readonly stage: string
  readonly detail: string
  readonly evidenceJson: string
  readonly createdAt: string
}

export class AnomalyStore {
  constructor(private readonly db: Database) {}

  record(input: ExecutionAnomalyInput): void {
    this.db
      .prepare(
        `INSERT INTO requirement_execution_anomalies
          (anomaly_id, req_id, plan_version, candidate_sha256, kind, stage, detail, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.anomalyId,
        input.requirementId,
        input.planVersion,
        input.candidateSha256,
        input.kind,
        input.stage,
        input.detail,
        JSON.stringify(input.evidence),
        input.createdAt,
      )
  }

  list(requirementId: string): ExecutionAnomalyRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM requirement_execution_anomalies WHERE req_id = ? ORDER BY created_at, anomaly_id',
      )
      .all(requirementId)
      .map((row) => ({
        anomalyId: text(row, 'anomaly_id'),
        kind: text(row, 'kind'),
        stage: text(row, 'stage'),
        detail: text(row, 'detail'),
        evidenceJson: text(row, 'evidence_json'),
        createdAt: text(row, 'created_at'),
      }))
  }
}
