/**
 * 系统交付判定：部署执行前复核当前版本、准入、候选、独立验证、业务终审与受控提交。
 * 这是“程序可以继续交付”的事实判定，不是人类验收，也不写 owner 决定。
 */

import { ACCEPTED, COMMITTED } from '../domain/status.js'
import type { Repository } from '../records/repository.js'

export interface DeliveryReadiness {
  readonly ok: boolean
  readonly reason: string
}

function admittedMismatch(
  repo: Repository,
  reqId: string,
  requirementVersion: number,
  build: { readonly planVersion: number },
): string {
  const admission = repo.latestAdmission(reqId)
  if (!admission) return ''
  if (admission.decision !== 'admit') return `系统未准入：${admission.reason}`
  if (admission.requirementVersion !== requirementVersion) {
    return '系统准入所依据的需求版本已过期'
  }
  const plan = repo.latestTaskPlan(reqId)
  if (!plan) return '没有任务包'
  if (plan.requirementVersion !== requirementVersion) {
    return '任务包所依据的需求版本已过期'
  }
  if (build.planVersion !== plan.planVersion) {
    return '候选构建与当前任务包版本不一致'
  }
  return ''
}

export function deliveryReadiness(
  repo: Repository,
  reqId: string,
  artifactSha256?: string,
): DeliveryReadiness {
  const requirement = repo.getRequirement(reqId)
  if (!requirement) return { ok: false, reason: `需求不存在：${reqId}` }
  if (repo.activeStop(reqId)) return { ok: false, reason: '需求已停止，不能继续交付' }
  if (requirement.status !== COMMITTED && requirement.status !== ACCEPTED) {
    return { ok: false, reason: `需求尚未受控提交（当前 ${requirement.status}）` }
  }
  const build = repo.latestCandidateBuild(reqId)
  if (!build) return { ok: false, reason: '没有候选构建' }
  if (artifactSha256 !== undefined && artifactSha256 !== build.artifactSha256) {
    return { ok: false, reason: '制品摘要与最近候选构建不一致' }
  }
  const admitted = admittedMismatch(repo, reqId, requirement.versions.length, build)
  if (admitted) return { ok: false, reason: admitted }
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
  const commit = repo.commitForCandidate(reqId, build.planVersion, build.candidateSha256)
  if (!commit) return { ok: false, reason: '候选尚未受控提交' }
  return { ok: true, reason: '' }
}
