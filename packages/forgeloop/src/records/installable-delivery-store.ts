import type { Database } from './db.js'
import { num, text, type Row } from './rows.js'

export interface InstallableDeliveryRecord {
  readonly deliveryId: string
  readonly reqId: string
  readonly deliveryVersion: number
  readonly project: string
  readonly requirementVersion: number
  readonly planVersion: number
  readonly candidateSha256: string
  readonly commitSha: string
  readonly packageVersion: string
  readonly artifactSha256: string
  readonly tarball: string
  readonly instructionsPath: string
  readonly instructionsSha256: string
  readonly instructionsBytes: number
  readonly verificationSha256: string
  readonly businessReviewSha256: string
  readonly trialTarget: string
  readonly trialRuntimeVersion: string
  readonly trialArtifactSha256: string
  readonly availableAt: string
  readonly recordedAt: string
  readonly evidenceDir: string
}

function deliveryRow(row: Row): InstallableDeliveryRecord {
  return {
    deliveryId: text(row, 'delivery_id'),
    reqId: text(row, 'req_id'),
    deliveryVersion: num(row, 'delivery_version'),
    project: text(row, 'project'),
    requirementVersion: num(row, 'requirement_version'),
    planVersion: num(row, 'plan_version'),
    candidateSha256: text(row, 'candidate_sha256'),
    commitSha: text(row, 'commit_sha'),
    packageVersion: text(row, 'package_version'),
    artifactSha256: text(row, 'artifact_sha256'),
    tarball: text(row, 'tarball'),
    instructionsPath: text(row, 'instructions_path'),
    instructionsSha256: text(row, 'instructions_sha256'),
    instructionsBytes: num(row, 'instructions_bytes'),
    verificationSha256: text(row, 'verification_sha256'),
    businessReviewSha256: text(row, 'business_review_sha256'),
    trialTarget: text(row, 'trial_target'),
    trialRuntimeVersion: text(row, 'trial_runtime_version'),
    trialArtifactSha256: text(row, 'trial_artifact_sha256'),
    availableAt: text(row, 'available_at'),
    recordedAt: text(row, 'recorded_at'),
    evidenceDir: text(row, 'evidence_dir'),
  }
}

export class InstallableDeliveryStore {
  constructor(readonly db: Database) {}

  record(record: InstallableDeliveryRecord): void {
    this.db
      .prepare(
        `INSERT INTO requirement_installable_deliveries
          (delivery_id, req_id, delivery_version, project, requirement_version, plan_version,
           candidate_sha256, commit_sha, package_version, artifact_sha256, tarball,
           instructions_path, instructions_sha256, instructions_bytes, verification_sha256,
           business_review_sha256, trial_target, trial_runtime_version, trial_artifact_sha256,
           available_at, recorded_at, evidence_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .run(
        record.deliveryId,
        record.reqId,
        record.deliveryVersion,
        record.project,
        record.requirementVersion,
        record.planVersion,
        record.candidateSha256,
        record.commitSha,
        record.packageVersion,
        record.artifactSha256,
        record.tarball,
        record.instructionsPath,
        record.instructionsSha256,
        record.instructionsBytes,
        record.verificationSha256,
        record.businessReviewSha256,
        record.trialTarget,
        record.trialRuntimeVersion,
        record.trialArtifactSha256,
        record.availableAt,
        record.recordedAt,
        record.evidenceDir,
      )
  }

  latest(reqId: string): InstallableDeliveryRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_installable_deliveries WHERE req_id = ?
          ORDER BY delivery_version DESC, rowid DESC LIMIT 1`,
      )
      .get(reqId)
    return row ? deliveryRow(row) : null
  }

  allFor(reqId: string): InstallableDeliveryRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM requirement_installable_deliveries WHERE req_id = ? ORDER BY delivery_version',
      )
      .all(reqId)
      .map(deliveryRow)
  }

  forCandidate(
    reqId: string,
    planVersion: number,
    candidateSha256: string,
    artifactSha256: string,
  ): InstallableDeliveryRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM requirement_installable_deliveries
          WHERE req_id = ? AND plan_version = ? AND candidate_sha256 = ? AND artifact_sha256 = ?
          ORDER BY delivery_version DESC LIMIT 1`,
      )
      .get(reqId, planVersion, candidateSha256, artifactSha256)
    return row ? deliveryRow(row) : null
  }

  countFor(reqId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM requirement_installable_deliveries WHERE req_id = ?')
      .get(reqId)
    return row ? num(row, 'total') : 0
  }

  all(project?: string): InstallableDeliveryRecord[] {
    const rows = project
      ? this.db
          .prepare(
            `SELECT * FROM requirement_installable_deliveries WHERE project = ?
              ORDER BY available_at, rowid`,
          )
          .all(project)
      : this.db
          .prepare('SELECT * FROM requirement_installable_deliveries ORDER BY available_at, rowid')
          .all()
    return rows.map(deliveryRow)
  }
}
