import type { Database } from './db.js'
import type { VerificationAttemptRecord, VerificationRecord } from './rows.js'
import { num, text, verificationAttemptRow, verificationRow } from './rows.js'

export class VerificationStore {
  constructor(private readonly db: Database) {}

  record(verification: VerificationRecord): void {
    const next = this.nextAttempt(
      verification.requirementId,
      verification.planVersion,
      verification.candidateSha256,
    )
    const attemptNumber = verification.attemptNumber ?? next.attemptNumber
    const previousAttemptId =
      verification.previousAttemptId ??
      (attemptNumber === next.attemptNumber
        ? next.previousAttemptId
        : this.attemptIdBefore(
            verification.requirementId,
            verification.planVersion,
            verification.candidateSha256,
            attemptNumber,
          ))
    const attemptId =
      verification.attemptId ??
      `ver-${verification.requirementId}-v${verification.planVersion}-${verification.candidateSha256}-a${attemptNumber}`
    const blocking = verification.blocking ?? []
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO requirement_verification_attempts
            (attempt_id, req_id, plan_version, candidate_sha256, attempt_number,
             previous_attempt_id, requirement_version, workspace_sha256, verdict,
             failure_kind, blocking_json, reason, report_json, report_path, report_sha256,
             evidence_dir, session_id, verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          verification.requirementId,
          verification.planVersion,
          verification.candidateSha256,
          attemptNumber,
          previousAttemptId,
          verification.requirementVersion,
          verification.workspaceSha256,
          verification.verdict,
          verification.failureKind ?? '',
          JSON.stringify(blocking),
          '',
          verification.reportJson,
          verification.reportPath,
          verification.reportSha256,
          verification.evidenceDir,
          verification.sessionId,
          verification.verifiedAt,
        )
      this.db
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
    })
  }

  nextAttempt(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
  ): { attemptNumber: number; previousAttemptId: string } {
    const row = this.db
      .prepare(
        `SELECT attempt_id, attempt_number FROM requirement_verification_attempts
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?
         ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(reqId, planVersion, candidateSha256)
    if (!row) return { attemptNumber: 1, previousAttemptId: '' }
    return {
      attemptNumber: num(row, 'attempt_number') + 1,
      previousAttemptId: text(row, 'attempt_id'),
    }
  }

  private attemptIdBefore(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
    attemptNumber: number,
  ): string {
    const row = this.db
      .prepare(
        `SELECT attempt_id FROM requirement_verification_attempts
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ? AND attempt_number < ?
         ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(reqId, planVersion, candidateSha256, attemptNumber)
    return row ? text(row, 'attempt_id') : ''
  }

  attemptsForCandidate(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
  ): VerificationAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_verification_attempts
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?
         ORDER BY attempt_number`,
      )
      .all(reqId, planVersion, candidateSha256)
    return rows.map(verificationAttemptRow)
  }

  attempts(reqId: string): VerificationAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_verification_attempts
         WHERE req_id = ? ORDER BY verified_at, candidate_sha256, attempt_number`,
      )
      .all(reqId)
    return rows.map(verificationAttemptRow)
  }

  attempt(attemptId: string): VerificationAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM requirement_verification_attempts WHERE attempt_id = ?')
      .get(attemptId)
    return row ? verificationAttemptRow(row) : null
  }

  latest(reqId: string, planVersion: number): VerificationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_verifications
         WHERE req_id = ? AND plan_version = ?
         ORDER BY verified_at DESC LIMIT 1`,
      )
      .get(reqId, planVersion)
    return row ? verificationRow(row) : null
  }

  forCandidate(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
  ): VerificationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_verifications
         WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ?`,
      )
      .get(reqId, planVersion, candidateSha256)
    return row ? verificationRow(row) : null
  }

  allFor(reqId: string): VerificationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requirement_verifications
         WHERE req_id = ?
         ORDER BY verified_at, candidate_sha256`,
      )
      .all(reqId)
    return rows.map(verificationRow)
  }
}
