import type { Repository } from '../records/repository.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type { VerificationRecord } from '../records/repository.js'
import type { BusinessReviewRecord } from '../records/repository.js'
import { RuleViolationError } from '../domain/errors.js'
import { sha256OfText } from '../domain/delivery.js'

export interface AcceptanceBindingInput {
  readonly plan: TaskPlan
  readonly artifacts: ReturnType<Repository['taskArtifacts']>
  readonly verification: VerificationRecord
  readonly businessReview: BusinessReviewRecord & object
  readonly artifactSha256?: string | undefined
  readonly candidateSha256: string
}

export function buildAcceptanceBinding(input: AcceptanceBindingInput) {
  const { plan, artifacts, verification, businessReview, artifactSha256, candidateSha256 } = input
  const ordered = plan.tasks.map((task) => {
    const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
    if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
    return artifact
  })
  return {
    candidateSha256,
    testEvidenceSha256: sha256OfText(
      ordered.map((artifact) => artifact.testEvidenceSha256).join(':'),
    ),
    reviewSha256: sha256OfText(ordered.map((artifact) => artifact.reviewSha256).join(':')),
    verificationSha256: verification.reportSha256,
    verificationCandidateSha256: verification.candidateSha256,
    businessReviewSha256: businessReview.reportSha256,
    artifactSha256: artifactSha256 ?? '',
    baselineCommit: ordered[0]?.baselineCommit ?? '',
  }
}
