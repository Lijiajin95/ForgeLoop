import type { Database } from './db.js'
import { num, text } from './rows.js'
import { asRecord } from '../domain/json.js'
import type { RequirementReview, ReviewCheckResult } from '../domain/review.js'
import { REVIEW_CHECKS } from '../domain/review.js'

function parseChecks(raw: string): ReviewCheckResult[] {
  const data: unknown = JSON.parse(raw)
  if (!Array.isArray(data)) return []
  const checks: ReviewCheckResult[] = []
  for (const item of data) {
    const record = asRecord(item)
    if (!record) continue
    const check = REVIEW_CHECKS.find((candidate) => candidate === record.check)
    const status =
      record.status === 'pass' || record.status === 'fail' || record.status === 'na'
        ? record.status
        : undefined
    if (!check || !status) continue
    checks.push({
      check,
      status,
      detail: typeof record.detail === 'string' ? record.detail : '',
    })
  }
  return checks
}

export class ReviewStore {
  constructor(readonly db: Database) {}

  nextVersion(reqId: string): number {
    const row = this.db
      .prepare('SELECT MAX(review_version) AS version FROM requirement_reviews WHERE req_id = ?')
      .get(reqId)
    return num(asRecord(row) ?? {}, 'version') + 1
  }

  record(review: RequirementReview): void {
    this.db
      .prepare(
        `INSERT INTO requirement_reviews
          (req_id, review_version, analysis_version, reviewer, verdict, summary, checks_json,
           prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.reqId,
        review.reviewVersion,
        review.analysisVersion,
        review.reviewer,
        review.verdict,
        review.summary,
        JSON.stringify(review.checks),
        review.promptVersion,
        review.createdAt,
      )
  }

  list(reqId: string): RequirementReview[] {
    const rows = this.db
      .prepare('SELECT * FROM requirement_reviews WHERE req_id = ? ORDER BY review_version')
      .all(reqId)
    return rows
      .map(asRecord)
      .filter((row) => row !== undefined)
      .map((row) => ({
        reqId,
        reviewVersion: num(row, 'review_version'),
        analysisVersion: num(row, 'analysis_version'),
        reviewer: text(row, 'reviewer'),
        verdict: text(row, 'verdict') === 'fail' ? 'fail' : 'pass',
        summary: text(row, 'summary'),
        checks: parseChecks(text(row, 'checks_json')),
        promptVersion: text(row, 'prompt_version'),
        createdAt: text(row, 'created_at'),
      }))
  }

  latest(reqId: string): RequirementReview | null {
    return this.list(reqId).at(-1) ?? null
  }
}
