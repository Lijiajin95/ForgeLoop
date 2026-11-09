/**
 * 承诺冲突的解除依据。
 *
 * 与已有承诺冲突时，系统准入必须暂停。模型返回空冲突列表不能成为解除依据：
 * 解除必须绑定**可信客户身份**、**当前需求版本**与**具体已有承诺**，并且引用一条
 * 已记录的客户决定。只有来源前缀不再视为有效——前缀可以被任何调用方伪造。
 * 未提供有效依据时，上一轮已知的冲突继续阻断，历史承诺与取舍保持可回查。
 */
import type { CommitmentConflict } from './spec.js'

export type CommitmentDecision = 'revise' | 'replace' | 'reject'

/** 已记录的客户决定；与本领域判定共用字段，便于双向回查。 */
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
  /** 该决定针对的需求版本；旧版本的解除不能顺延到新版本。 */
  readonly requirementVersion: number
  /** 被解除的已有承诺对应的需求。 */
  readonly existingReqId: string
  /** 必须引用一条已记录的客户决定；空串表示没有记录。 */
  readonly decisionId: string
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

/** 有效解除的判定输入：当前版本、冲突集合、已记录决定与可信客户身份。 */
export interface ResolutionCheck {
  readonly requirementVersion: number
  readonly conflicts: readonly CommitmentConflict[]
  /** 全部已记录的客户决定；按需求/版本/承诺三维回查。 */
  readonly decisions: readonly CustomerDecision[]
  /** 配置所有者；决定人必须与之一致，否则视为错误身份。 */
  readonly owner: string
}

/**
 * 判断一条解除依据是否有效。
 * 拒绝理由要带具体原因：准入把原因拼进阻断文案，所有者才能知道该补什么。
 */
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

/** 决定记录本身的核验：身份、版本、具体承诺与决定内容必须全部一致。 */
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

/** 收集每条冲突被拒的具体理由；准入用它拼出可执行的阻断文案。 */
export function resolutionRejections(
  input: ResolutionCheck & {
    readonly resolutions: readonly CommitmentResolution[]
  },
): string[] {
  const reasons: string[] = []
  for (const resolution of input.resolutions) {
    // 旧版本的解除依据不能被静默忽略：它正是“过期决定”必须说明的原因。
    const verdict = resolutionCovers(resolution, input)
    if (!verdict.ok) reasons.push(verdict.reason)
  }
  return reasons
}

/**
 * 计算仍未解除的冲突：上一轮已知冲突 + 本轮新报冲突，减去有有效依据的。
 * 模型本轮返回空列表不会清掉已记录冲突。
 */
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
