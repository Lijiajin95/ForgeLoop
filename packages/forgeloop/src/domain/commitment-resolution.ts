/**
 * 承诺冲突的解除依据。
 *
 * 与已有承诺冲突时，系统准入必须暂停。模型返回空冲突列表不能成为解除依据：
 * 解除必须绑定**当前需求版本**和**真实客户决定来源**，并且只对同一条已有承诺生效。
 * 未提供有效依据时，上一轮已知的冲突继续阻断，历史承诺与取舍保持可回查。
 */
import type { CommitmentConflict } from './spec.js'

export type CommitmentDecision = 'revise' | 'replace' | 'reject'

export interface CommitmentResolution {
  readonly reqId: string
  /** 该决定针对的需求版本；旧版本的解除不能顺延到新版本。 */
  readonly requirementVersion: number
  /** 被解除的已有承诺对应的需求。 */
  readonly existingReqId: string
  /** 客户决定来源，例如 `web-decision:<id>` 或 `owner:<id>`；模型/协调器不算。 */
  readonly decisionSource: string
  readonly decision: CommitmentDecision
  readonly reason: string
  readonly decidedAt: string
}

const DECISIONS: readonly CommitmentDecision[] = ['revise', 'replace', 'reject']

/** 只有客户决定入口能解除承诺；模型、协调器与自动推进都不行。 */
export function decisionSourceTrusted(source: string): boolean {
  const value = source.trim()
  return value.startsWith('web-decision:') || value.startsWith('owner:')
}

export function resolutionCovers(
  resolution: CommitmentResolution,
  input: {
    readonly requirementVersion: number
    readonly conflicts: readonly CommitmentConflict[]
  },
): { ok: true } | { ok: false; reason: string } {
  if (resolution.requirementVersion !== input.requirementVersion) {
    return {
      ok: false,
      reason: `解除依据绑定需求 v${resolution.requirementVersion}，当前是 v${input.requirementVersion}`,
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
  return { ok: true }
}

/**
 * 计算仍未解除的冲突：上一轮已知冲突 + 本轮新报冲突，减去有有效依据的。
 * 模型本轮返回空列表不会清掉已know冲突。
 */
export function unresolvedCommitments(input: {
  readonly previousConflicts: readonly CommitmentConflict[]
  readonly analysisConflicts: readonly CommitmentConflict[]
  readonly resolutions: readonly CommitmentResolution[]
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
          }).ok,
      )
      .map((resolution) => resolution.existingReqId),
  )
  return all.filter((conflict) => !resolved.has(conflict.existingReqId))
}
