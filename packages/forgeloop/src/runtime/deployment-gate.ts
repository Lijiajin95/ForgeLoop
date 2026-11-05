/**
 * 部署门禁：系统交付判定始终有效；人类验收只对需要 owner 决定的目标必需。
 * 这里只读记录，不执行任何命令；不满足时给出可读原因，调用方不得继续调用部署工具。
 */

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
    const existing = repo.latestCandidateBuild(reqId)
    if (existing && artifact.path !== existing.tarball) {
      return { ok: false, reason: '制品路径与最近候选构建不一致' }
    }
    const readiness = deliveryReadiness(repo, reqId, artifact.sha256)
    if (!readiness.ok) return readiness
    // owner 目标仍要求人类验收；auto 目标由目标配置授权，验收不是系统交付判定的替代品。
    if (target.approval === 'owner') {
      const acceptance = repo.acceptance(reqId)
      if (!acceptance.accepted_at) return { ok: false, reason: '需求尚未验收' }
      // 验收必须绑定当前候选/制品材料：候选、任务包或需求材料变化后旧验收不再有效。
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
