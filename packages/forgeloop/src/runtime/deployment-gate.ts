/**
 * 部署门禁：候选身份、独立验证、业务终审与验收都必须仍然有效。
 * 这里只读记录，不执行任何命令；不满足时给出可读原因，调用方不得继续调用部署工具。
 */

import type { DeploymentTargetConfig } from '../config.js'
import type { DeploymentArtifact } from '../domain/deployment.js'
import type { Repository } from '../records/repository.js'

export interface DeploymentGateResult {
  readonly ok: boolean
  readonly reason: string
}

export type DeploymentGate = (
  target: DeploymentTargetConfig,
  artifact: DeploymentArtifact,
) => DeploymentGateResult

export function candidateDeploymentGate(repo: Repository): DeploymentGate {
  return (target, artifact) => {
    const reqId = target.requirementId
    if (!repo.getRequirement(reqId)) return { ok: false, reason: `需求不存在：${reqId}` }
    const build = repo.latestCandidateBuild(reqId)
    if (!build) return { ok: false, reason: '没有候选构建' }
    if (artifact.sha256 !== build.artifactSha256) {
      return { ok: false, reason: '制品摘要与最近候选构建不一致' }
    }
    if (artifact.path !== build.tarball) {
      return { ok: false, reason: '制品路径与最近候选构建不一致' }
    }
    const verification = repo.verificationForCandidate(
      reqId,
      build.planVersion,
      build.candidateSha256,
    )
    if (!verification || verification.verdict !== 'pass') {
      return { ok: false, reason: '独立验证未通过' }
    }
    const review = repo.businessReviewForCandidate(reqId, build.planVersion, build.candidateSha256)
    if (!review || review.verdict !== 'pass') {
      return { ok: false, reason: '业务终审未通过' }
    }
    if (!repo.acceptance(reqId).accepted_at) {
      return { ok: false, reason: '需求尚未验收' }
    }
    return { ok: true, reason: '' }
  }
}
