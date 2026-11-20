import type { DeploymentTargetConfig } from '../config.js'
import type { DeploymentArtifact } from '../domain/deployment.js'
import type { Repository } from '../records/repository.js'
import { expectedAcceptanceFingerprints } from './acceptance-binding.js'
import { deliveryReadiness } from './delivery-readiness.js'

export interface DeploymentGateResult {
  readonly ok: boolean
  readonly reason: string
}

export type DeploymentGate = (
  target: DeploymentTargetConfig,
  artifact: DeploymentArtifact,
  requirementId?: string,
) => DeploymentGateResult

export function candidateDeploymentGate(repo: Repository): DeploymentGate {
  return (target, artifact, requirementId) => {
    const reqId = requirementId?.trim() || target.requirementId
    if (!reqId) return { ok: false, reason: '需求不存在或未指定所属需求，不能继续部署' }
    if (!repo.getRequirement(reqId)) {
      return { ok: false, reason: `需求不存在或不属于当前项目/工作区：${reqId}` }
    }
    const existing = repo.latestCandidateBuild(reqId)
    if (existing && artifact.path !== existing.tarball) {
      return { ok: false, reason: '制品路径与最近候选构建不一致' }
    }
    const readiness = deliveryReadiness(repo, reqId, artifact.sha256)
    if (!readiness.ok) return readiness
    if (target.approval === 'owner') {
      const acceptance = repo.acceptance(reqId)
      if (!acceptance.accepted_at) return { ok: false, reason: '需求尚未验收' }
      const fingerprints = expectedAcceptanceFingerprints(repo, reqId, artifact.sha256)
      if (fingerprints.length === 0) {
        return { ok: false, reason: '无法复核验收所绑定的候选材料，不能继续部署' }
      }
      if (!fingerprints.includes(acceptance.acceptance_fingerprint ?? '')) {
        return { ok: false, reason: '验收所绑定的候选材料已变化，旧验收不能用于本次部署' }
      }
    }
    return { ok: true, reason: '' }
  }
}
