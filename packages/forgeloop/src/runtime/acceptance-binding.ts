import type { Repository } from '../records/repository.js'
import type { TaskPlan } from '../domain/task-plan.js'
import type { VerificationRecord } from '../records/repository.js'
import type { BusinessReviewRecord } from '../records/repository.js'
import { RuleViolationError } from '../domain/errors.js'
import { candidateIdentityOf, sha256OfText } from '../domain/delivery.js'

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

/**
 * 复核当前候选的验收材料指纹：验收记录必须绑定当前候选（必要时也绑定当前制品摘要），
 * 不能只凭 `accepted_at` 就认为验收仍然有效。
 *
 * 返回可接受的指纹集合；空数组表示当前候选材料不完整，无法复核。
 * 验收可能发生在构建之前，因此同时给出“不含制品摘要”和“含当前制品摘要”两种绑定。
 */
export function expectedAcceptanceFingerprints(
  repo: Repository,
  reqId: string,
  artifactSha256: string,
): string[] {
  const build = repo.latestCandidateBuild(reqId)
  if (!build) return []
  const plan = repo.taskPlan(reqId, build.planVersion)
  if (!plan) return []
  const artifacts = repo.taskArtifacts(reqId, build.planVersion)
  let candidateSha256: string
  try {
    const ordered = plan.tasks.map((task) => {
      const artifact = artifacts.find((candidate) => candidate.taskId === task.taskId)
      if (!artifact) throw new RuleViolationError(`任务 ${task.taskId} 缺少交付产物`)
      return artifact
    })
    candidateSha256 = candidateIdentityOf({
      planVersion: plan.planVersion,
      requirementVersion: plan.requirementVersion,
      baselineCommit: ordered[0]?.baselineCommit ?? '',
      candidateHashes: ordered.map((artifact) => artifact.candidateSha256),
    })
  } catch {
    return []
  }
  if (candidateSha256 !== build.candidateSha256) return []
  const verification = repo.verificationForCandidate(reqId, build.planVersion, candidateSha256)
  const businessReview = repo.businessReviewForCandidate(reqId, build.planVersion, candidateSha256)
  if (!verification || !businessReview) return []
  const fingerprints = new Set<string>()
  for (const digest of ['', artifactSha256]) {
    try {
      fingerprints.add(
        sha256OfText(
          JSON.stringify(
            buildAcceptanceBinding({
              plan,
              artifacts,
              verification,
              businessReview,
              ...(digest ? { artifactSha256: digest } : {}),
              candidateSha256,
            }),
          ),
        ),
      )
    } catch {
      return []
    }
  }
  return [...fingerprints]
}
