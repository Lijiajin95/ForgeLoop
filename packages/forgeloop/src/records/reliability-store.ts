import type {
  CandidateBuildFact,
  DeploymentFact,
  FailureRoundFact,
  OpsEventFact,
  ReliabilitySample,
  ReliabilitySamplePayload,
  ReviewFact,
  TaskRunFact,
  VerificationFact,
} from '../domain/reliability.js'
import { RELIABILITY_SAMPLE_HISTORY_LIMIT, parseReliabilitySample } from '../domain/reliability.js'
import { OpsStore } from './ops-store.js'
import { num, text, type Row } from './rows.js'

function parseChecks(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export class ReliabilityStore extends OpsStore {
  reliabilityVerifications(): VerificationFact[] {
    const rows = this.db
      .prepare(
        `SELECT req_id, verdict, verified_at
         FROM requirement_verifications
         ORDER BY verified_at, candidate_sha256`,
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      verdict: text(row, 'verdict') === 'pass' ? 'pass' : 'block',
      verifiedAt: text(row, 'verified_at'),
    }))
  }

  reliabilityBusinessReviews(): ReviewFact[] {
    const rows = this.db
      .prepare(
        `SELECT req_id, verdict, reviewed_at
         FROM requirement_business_reviews
         ORDER BY reviewed_at, candidate_sha256`,
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      verdict: text(row, 'verdict') === 'pass' ? 'pass' : 'block',
      reviewedAt: text(row, 'reviewed_at'),
    }))
  }

  reliabilityDeployments(): DeploymentFact[] {
    const rows = this.db
      .prepare(
        `SELECT req_id, state, recorded_at, checks_json
         FROM requirement_deployments
         ORDER BY recorded_at, candidate_sha256, target_profile`,
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      state: text(row, 'state'),
      recordedAt: text(row, 'recorded_at'),
      checks: parseChecks(text(row, 'checks_json')),
    }))
  }

  reliabilityFailureRounds(): FailureRoundFact[] {
    const rows = this.db
      .prepare(
        `SELECT req_id, stage, occurred_at
         FROM requirement_failure_rounds
         ORDER BY occurred_at, round_id`,
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      stage: text(row, 'stage'),
      occurredAt: text(row, 'occurred_at'),
    }))
  }

  reliabilityTaskRuns(): TaskRunFact[] {
    const rows = this.db
      .prepare(
        `SELECT runs.req_id, runs.state
         FROM requirement_task_runs AS runs
         JOIN (
           SELECT req_id, MAX(plan_version) AS plan_version
           FROM requirement_task_plans
           GROUP BY req_id
         ) AS latest
           ON latest.req_id = runs.req_id AND latest.plan_version = runs.plan_version
         ORDER BY runs.req_id, runs.task_id`,
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      state: text(row, 'state'),
    }))
  }

  reliabilityOpsEvents(project: string): OpsEventFact[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, state, title, opened_at, recovered_at, closed_at, updated_at
         FROM ops_events
         WHERE project = ?
         ORDER BY opened_at, event_id`,
      )
      .all(project)
    return rows.map((row: Row) => ({
      eventId: text(row, 'event_id'),
      state: text(row, 'state'),
      title: text(row, 'title'),
      openedAt: text(row, 'opened_at'),
      recoveredAt: text(row, 'recovered_at'),
      closedAt: text(row, 'closed_at'),
      updatedAt: text(row, 'updated_at'),
    }))
  }

  reliabilityCandidateBuilds(): CandidateBuildFact[] {
    const rows = this.db
      .prepare(
        'SELECT req_id, built_at FROM requirement_candidate_builds ORDER BY built_at, candidate_sha256',
      )
      .all()
    return rows.map((row: Row) => ({
      reqId: text(row, 'req_id'),
      builtAt: text(row, 'built_at'),
    }))
  }

  recordReliabilitySample(input: {
    readonly project: string
    readonly sampledAt: string
    readonly revision: string
    readonly payload: ReliabilitySamplePayload
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO reliability_metric_samples (project, sampled_at, revision, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.project, input.sampledAt, input.revision, JSON.stringify(input.payload))
    return Number(result.lastInsertRowid)
  }

  reliabilitySamples(
    project: string,
    limit = RELIABILITY_SAMPLE_HISTORY_LIMIT,
  ): ReliabilitySample[] {
    const rows = this.db
      .prepare(
        `SELECT sample_id, project, sampled_at, revision, payload_json
           FROM reliability_metric_samples
          WHERE project = ?
          ORDER BY sample_id DESC
          LIMIT ?`,
      )
      .all(project, limit)
    const samples: ReliabilitySample[] = []
    for (const row of rows) {
      try {
        const payload = parseReliabilitySample(JSON.parse(text(row, 'payload_json')))
        samples.push({
          ...payload,
          sampleId: num(row, 'sample_id'),
          project: text(row, 'project'),
          sampledAt: text(row, 'sampled_at'),
          revision: text(row, 'revision'),
        })
      } catch {
        continue
      }
    }
    return samples
  }

  latestReliabilitySample(project: string): ReliabilitySample | null {
    return this.reliabilitySamples(project, 1)[0] ?? null
  }
}
