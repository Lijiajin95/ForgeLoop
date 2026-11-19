import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'

export interface MetricsRequirementRow {
  readonly reqId: string
  readonly project: string
  readonly acceptedAt: string
  readonly status: string
  readonly requirementVersion: number
}

export interface MetricsDeliveryRow {
  readonly reqId: string
  readonly requirementVersion: number
  readonly availableAt: string
}

export interface MetricsInterventionRow {
  readonly reqId: string
  readonly actor: string
  readonly reason: string
  readonly startedAt: string
  readonly endedAt: string
}

export interface HumanInterventionRecord {
  readonly interventionId: string
  readonly reqId: string
  readonly project: string
  readonly actor: string
  readonly reason: string
  readonly startedAt: string
  readonly endedAt: string
  readonly source: string
  readonly recordedAt: string
}

const INTERVENTION_FACTS = `
SELECT req_id, '' AS actor, '人工澄清' AS reason, answered_at AS at, '' AS ended_at
  FROM requirement_clarification_answers
UNION ALL
SELECT req_id, '' AS actor, '业务决定' AS reason, decided_at, '' FROM requirement_commitment_resolutions
UNION ALL
SELECT req_id, granted_by AS actor, '追加授权' AS reason, granted_at, '' FROM requirement_grants
UNION ALL
SELECT req_id, extended_by AS actor, '延长工时' AS reason, extended_at, '' FROM requirement_budget_extensions
UNION ALL
SELECT req_id, requested_by AS actor, '停止需求' AS reason, requested_at, '' FROM requirement_stops
UNION ALL
SELECT req_id, cancelled_by AS actor, '取消需求' AS reason, cancelled_at, '' FROM requirement_cancellations
`

function interventionRow(row: Row): MetricsInterventionRow {
  return {
    reqId: text(row, 'req_id'),
    actor: text(row, 'actor'),
    reason: text(row, 'reason'),
    startedAt: text(row, 'at') || text(row, 'started_at'),
    endedAt: text(row, 'ended_at'),
  }
}

export class MetricsStore {
  constructor(readonly db: Database) {}

  requirements(project: string): MetricsRequirementRow[] {
    return this.db
      .prepare(
        `SELECT r.req_id, r.project, r.created_at AS accepted_at, r.status,
                COALESCE((SELECT MAX(v.version) FROM requirement_versions v WHERE v.req_id = r.req_id), 0)
                  AS requirement_version
           FROM requirements r WHERE r.project = ? ORDER BY r.created_at`,
      )
      .all(project)
      .map((row) => ({
        reqId: text(row, 'req_id'),
        project: text(row, 'project'),
        acceptedAt: text(row, 'accepted_at'),
        status: text(row, 'status'),
        requirementVersion: num(row, 'requirement_version'),
      }))
  }

  deliveries(project: string): MetricsDeliveryRow[] {
    return this.db
      .prepare(
        `SELECT req_id, requirement_version, available_at
           FROM requirement_installable_deliveries WHERE project = ?
          ORDER BY available_at`,
      )
      .all(project)
      .map((row) => ({
        reqId: text(row, 'req_id'),
        requirementVersion: num(row, 'requirement_version'),
        availableAt: text(row, 'available_at'),
      }))
  }

  interventions(): MetricsInterventionRow[] {
    const facts = this.db.prepare(INTERVENTION_FACTS).all().map(interventionRow)
    const recorded = this.db
      .prepare(`SELECT req_id, actor, reason, started_at, ended_at FROM human_interventions`)
      .all()
      .map(interventionRow)
    return [...facts, ...recorded]
  }

  recordIntervention(record: HumanInterventionRecord): void {
    this.db
      .prepare(
        `INSERT INTO human_interventions
          (intervention_id, req_id, project, actor, reason, started_at, ended_at, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.interventionId,
        record.reqId,
        record.project,
        record.actor,
        record.reason,
        record.startedAt,
        record.endedAt,
        record.source,
        record.recordedAt,
      )
  }

  interventionsFor(reqId: string): MetricsInterventionRow[] {
    return this.db
      .prepare(
        `SELECT req_id, actor, reason, started_at, ended_at FROM human_interventions
          WHERE req_id = ? ORDER BY started_at`,
      )
      .all(reqId)
      .map(interventionRow)
  }
}
