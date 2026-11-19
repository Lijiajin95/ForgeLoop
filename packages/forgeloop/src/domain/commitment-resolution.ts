import type { CommitmentConflict } from './spec.js'

export type CommitmentDecision = 'revise' | 'replace' | 'reject'

export interface CustomerDecision {
  readonly decisionId: string
  readonly reqId: string
  readonly requirementVersion: number
  readonly existingReqId: string
  readonly decision: CommitmentDecision
  readonly decidedBy: string
  readonly decisionSource: string
  readonly reason: string
  readonly decidedAt: string
}

export interface CommitmentResolution {
  readonly reqId: string
  readonly requirementVersion: number
  readonly existingReqId: string
  readonly decisionId: string
  readonly decisionSource: string
  readonly decision: CommitmentDecision
  readonly reason: string
  readonly decidedAt: string
}

const DECISIONS: readonly CommitmentDecision[] = ['revise', 'replace', 'reject']

export function decisionSourceTrusted(source: string): boolean {
  const value = source.trim()
  return value.startsWith('web-decision:') || value.startsWith('owner:')
}

export interface ResolutionCheck {
  readonly requirementVersion: number
  readonly conflicts: readonly CommitmentConflict[]
  readonly decisions: readonly CustomerDecision[]
  readonly owner: string
}

export function resolutionCovers(
  resolution: CommitmentResolution,
  input: ResolutionCheck,
): { ok: true } | { ok: false; reason: string } {
  if (resolution.requirementVersion !== input.requirementVersion) {
    return {
      ok: false,
      reason: `解除依据绑定需求 v${resolution.requirementVersion}，当前是 v${input.requirementVersion}（已过期）`,
    }
  }
  if (!decisionSourceTrusted(resolution.decisionSource)) {
    return {
      ok: false,
      reason: `解除依据不是客户决定来源：${resolution.decisionSource || '（空）'}`,
    }
  }
  if (!DECISIONS.includes(resolution.decision)) {
    return { ok: false, reason: `解除方式不明确：${resolution.decision}` }
  }
  if (!resolution.reason.trim()) {
    return { ok: false, reason: '解除承诺冲突必须说明理由，便于回查取舍' }
  }
  if (!input.conflicts.some((conflict) => conflict.existingReqId === resolution.existingReqId)) {
    return {
      ok: false,
      reason: `解除依据没有对应到冲突中的已有承诺：${resolution.existingReqId}`,
    }
  }
  const recorded = resolution.decisionId
    ? input.decisions.find((decision) => decision.decisionId === resolution.decisionId)
    : undefined
  return recordedDecisionIssue(recorded, resolution, input)
}

function recordedDecisionIssue(
  recorded: CustomerDecision | undefined,
  resolution: CommitmentResolution,
  input: ResolutionCheck,
): { ok: true } | { ok: false; reason: string } {
  if (!resolution.decisionId) {
    return {
      ok: false,
      reason: `解除依据没有引用已记录的客户决定（需求 ${resolution.reqId}，承诺 ${resolution.existingReqId}）`,
    }
  }
  if (!recorded) {
    return { ok: false, reason: `引用的客户决定不存在：${resolution.decisionId}` }
  }
  if (recorded.reqId !== resolution.reqId) {
    return {
      ok: false,
      reason: `客户决定属于需求 ${recorded.reqId}，不能解除需求 ${resolution.reqId} 的承诺`,
    }
  }
  if (recorded.existingReqId !== resolution.existingReqId) {
    return {
      ok: false,
      reason: `客户决定针对承诺 ${recorded.existingReqId}，与冲突中的 ${resolution.existingReqId} 不一致`,
    }
  }
  if (recorded.requirementVersion !== input.requirementVersion) {
    return {
      ok: false,
      reason: `客户决定绑定需求 v${recorded.requirementVersion}，当前是 v${input.requirementVersion}，已过期`,
    }
  }
  if (!recorded.decidedBy.trim() || recorded.decidedBy !== input.owner) {
    return {
      ok: false,
      reason: `客户决定由 ${recorded.decidedBy || '（空）'} 记录，与配置所有者不一致`,
    }
  }
  if (!decisionSourceTrusted(recorded.decisionSource)) {
    return {
      ok: false,
      reason: `客户决定来源不可信：${recorded.decisionSource || '（空）'}`,
    }
  }
  if (recorded.decision !== resolution.decision) {
    return {
      ok: false,
      reason: `解除方式 ${resolution.decision} 与客户决定 ${recorded.decision} 不一致`,
    }
  }
  return { ok: true }
}

export function resolutionRejections(
  input: ResolutionCheck & {
    readonly resolutions: readonly CommitmentResolution[]
  },
): string[] {
  const reasons: string[] = []
  for (const resolution of input.resolutions) {
    const verdict = resolutionCovers(resolution, input)
    if (!verdict.ok) reasons.push(verdict.reason)
  }
  for (const conflict of input.conflicts) {
    if (
      input.resolutions.some((resolution) => resolution.existingReqId === conflict.existingReqId)
    ) {
      continue
    }
    reasons.push(
      `承诺 ${conflict.existingReqId} 没有引用已记录的客户决定（需要所有者做出修订、替代或拒绝）`,
    )
  }
  return reasons
}

export function unresolvedCommitments(input: {
  readonly previousConflicts: readonly CommitmentConflict[]
  readonly analysisConflicts: readonly CommitmentConflict[]
  readonly resolutions: readonly CommitmentResolution[]
  readonly decisions: readonly CustomerDecision[]
  readonly owner: string
  readonly requirementVersion: number
}): CommitmentConflict[] {
  const merged = new Map<string, CommitmentConflict>()
  for (const conflict of [...input.previousConflicts, ...input.analysisConflicts]) {
    if (!merged.has(conflict.existingReqId)) merged.set(conflict.existingReqId, conflict)
  }
  const all = [...merged.values()]
  const resolved = new Set(
    input.resolutions
      .filter(
        (resolution) =>
          resolutionCovers(resolution, {
            requirementVersion: input.requirementVersion,
            conflicts: all,
            decisions: input.decisions,
            owner: input.owner,
          }).ok,
      )
      .map((resolution) => resolution.existingReqId),
  )
  return all.filter((conflict) => !resolved.has(conflict.existingReqId))
}
