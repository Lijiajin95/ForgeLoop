/**
 * 客户决定入口：所有者对“新需求与已有承诺冲突”做出修订、替代或拒绝。
 *
 * 只由已认证的客户通道（看板/所有者入口）调用；模型工具不能调用。
 * 决定绑定可信客户身份、当前需求版本与具体已有承诺；重复提交复用第一次决定。
 * 单独成文件是为了让 service.ts 保持在上限内，判定仍集中在这里。
 */

import { isTerminal } from '../domain/status.js'
import { decisionSourceTrusted } from '../domain/commitment-resolution.js'
import type { CommitmentConflict } from '../domain/spec.js'
import type { Repository } from '../records/repository.js'
import { fail, ok, type OperationResult } from './operation-result.js'

export interface CommitmentDecisionInput {
  readonly reqId: string
  readonly existingReqId: string
  readonly decision: 'revise' | 'replace' | 'reject'
  readonly reason: string
  readonly by: string
  readonly source: string
  /** 复用一条已记录的决定时必须给编号；跨需求/跨版本/跨承诺都会被拒。 */
  readonly decisionId?: string
}

export interface CommitmentDecisionDeps {
  readonly repo: Repository
  /** 配置所有者；决定人必须与之一致。 */
  readonly owner: string
  /** 记录时间；缺省取当前时间。 */
  readonly now?: () => string
}

/** 当前需求已知的承诺冲突：本轮与历史分析合并，按已有需求去重。 */
function conflictsFor(repo: Repository, reqId: string): CommitmentConflict[] {
  const seen = new Set<string>()
  const conflicts: CommitmentConflict[] = []
  for (const analysis of repo.analyses(reqId)) {
    for (const conflict of analysis.conflicts ?? []) {
      if (seen.has(conflict.existingReqId)) continue
      seen.add(conflict.existingReqId)
      conflicts.push(conflict)
    }
  }
  return conflicts
}

/** 复用已记录决定：必须同需求、同当前版本、同具体承诺且同决定方式。 */
function reuseDecision(
  deps: CommitmentDecisionDeps,
  input: CommitmentDecisionInput,
  version: number,
): OperationResult | null {
  const stored = deps.repo.commitments.customerDecision(input.decisionId ?? '')
  if (!stored) return fail('decision_not_found', `未找到客户决定 ${input.decisionId ?? ''}`)
  if (stored.reqId !== input.reqId) {
    return fail(
      'decision_cross_requirement',
      `客户决定 ${stored.decisionId} 属于需求 ${stored.reqId}，不能复用到 ${input.reqId}`,
    )
  }
  if (stored.existingReqId !== input.existingReqId) {
    return fail(
      'decision_commitment_mismatch',
      `客户决定 ${stored.decisionId} 针对承诺 ${stored.existingReqId}，与 ${input.existingReqId} 不一致`,
    )
  }
  if (stored.requirementVersion !== version) {
    return fail(
      'decision_expired',
      `客户决定 ${stored.decisionId} 绑定需求 v${stored.requirementVersion}，当前是 v${version}`,
    )
  }
  if (stored.decidedBy !== deps.owner) {
    return fail(
      'identity_mismatch',
      `客户决定 ${stored.decisionId} 由 ${stored.decidedBy || '（空）'} 记录，与所有者不一致`,
    )
  }
  if (stored.decision !== input.decision) {
    return fail(
      'decision_mismatch',
      `客户决定 ${stored.decisionId} 是 ${stored.decision}，与 ${input.decision} 不一致`,
    )
  }
  return null
}

export function resolveCommitment(
  deps: CommitmentDecisionDeps,
  input: CommitmentDecisionInput,
): OperationResult {
  const requirement = deps.repo.getRequirement(input.reqId)
  if (!requirement) return fail('not_found', `未找到需求 ${input.reqId}`)
  if (isTerminal(requirement.status)) {
    return fail('terminal', `需求 ${input.reqId} 已处于终态 ${requirement.status}`)
  }
  if (input.by !== deps.owner) {
    return fail(
      'identity_mismatch',
      `客户决定必须由所有者 ${deps.owner} 记录，实际是 ${input.by || '（空）'}`,
    )
  }
  if (!decisionSourceTrusted(input.source)) {
    return fail('untrusted_source', `客户决定来源不可信：${input.source || '（空）'}`)
  }
  if (!input.reason.trim()) {
    return fail('reason_required', '客户决定必须说明理由，便于回查取舍')
  }
  const version = requirement.versions.length
  if (input.decisionId) {
    const reused = reuseDecision(deps, input, version)
    if (reused) return reused
  }
  if (
    !conflictsFor(deps.repo, input.reqId).some((item) => item.existingReqId === input.existingReqId)
  ) {
    return fail(
      'commitment_not_found',
      `需求 ${input.reqId} 没有与 ${input.existingReqId} 的已知承诺冲突`,
    )
  }
  const recorded = deps.repo.commitments.recordCustomerDecision({
    reqId: input.reqId,
    requirementVersion: version,
    existingReqId: input.existingReqId,
    decision: input.decision,
    decidedBy: input.by,
    decisionSource: input.source,
    reason: input.reason,
    decidedAt: deps.now?.() ?? new Date().toISOString(),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
  })
  if (input.decision === 'reject') {
    deps.repo.setStatus(input.reqId, 'rejected', `客户决定拒绝：${input.reason}`)
    return ok(`已记录客户决定 ${recorded.decisionId}：拒绝需求 ${input.reqId}`, {
      decisionId: recorded.decisionId,
      decision: recorded.decision,
      requirementVersion: version,
    })
  }
  // 修订/替代只解除这一条承诺；准入在下一轮按当前版本重新判定。
  return ok(`已记录客户决定 ${recorded.decisionId}：${recorded.decision} ${input.existingReqId}`, {
    decisionId: recorded.decisionId,
    decision: recorded.decision,
    requirementVersion: version,
  })
}
