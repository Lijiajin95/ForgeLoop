import type { CommitmentConflict } from './spec.js'
import {
  resolutionRejections,
  unresolvedCommitments,
  type CommitmentResolution,
  type CustomerDecision,
} from './commitment-resolution.js'

/**
 * 系统准入：把“真实需求来源 + 有效授权 + 质量依据”转成可执行的系统决定。
 *
 * 系统准入不是人类批准，也不写入 by=owner / approved=true；它由程序按策略判定、
 * 绑定需求版本与分析版本并单独记录。人类批准仍只用于策略明确列出的例外。
 */

export const ADMISSION_POLICY_VERSION = 'system-admission-v1'

export interface AdmissionPolicy {
  /** 总开关；关闭后所有需求都停在待处理，不自动进入研发。 */
  readonly enabled: boolean
  /** 是否允许系统准入后由主控整合并提交代码；发布/部署仍需独立授权。 */
  readonly allowCodeCommit: boolean
  /** 可信人类入口的来源前缀；allowAnySource=false 时只有这些来源可以触发系统准入。 */
  readonly trustedSources: readonly string[]
  /** 放开来源限制：任何非空来源都可以进入系统准入；来源仍完整记录在案。 */
  readonly allowAnySource: boolean
  /** 是否要求提交者与配置所有者一致；false 时运维/工具提交也可进入。 */
  readonly requireOwner: boolean
}

export interface AdmissionFacts {
  readonly requirementStatus: string
  readonly requirementVersion: number
  readonly project: string
  readonly projectPath: string
  readonly source: string
  readonly submittedBy: string
  readonly owner: string
  readonly analysisVersion: number | null
  readonly analysisRequirementVersion: number | null
  readonly clarifications: number
  /** 与已有承诺的冲突数；非空时暂停准入，等待所有者决定取舍。 */
  readonly conflicts?: number | undefined
  readonly conflictSummaries?: readonly string[] | undefined
  /** 每条解除依据被拒的具体原因；有冲突时拼进阻断文案。 */
  readonly conflictReasons?: readonly string[] | undefined
}

export interface AdmissionBasis {
  readonly policyVersion: string
  readonly source: string
  readonly submittedBy: string
  readonly owner: string
  readonly project: string
  readonly projectPath: string
  readonly requirementVersion: number
  readonly analysisVersion: number | null
  readonly trustedSource: boolean
  readonly allowAnySource: boolean
  readonly requireOwner: boolean
  readonly codeCommitAllowed: boolean
}

export interface AdmissionDecision {
  readonly admit: boolean
  readonly code: string
  readonly reason: string
  readonly basis: AdmissionBasis
}

const TERMINAL = new Set(['accepted', 'rejected', 'cancelled', 'committed'])

function codeCommitAllowed(policy: AdmissionPolicy, trustedSource: boolean): boolean {
  return policy.enabled && policy.allowCodeCommit && trustedSource
}

function admittedReason(allowed: boolean): string {
  return allowed
    ? '可信需求来源、有效授权与需求说明齐备；允许研发、验证并提交代码'
    : '可信需求来源与需求说明齐备；允许研发与验证，代码提交仍需单独授权'
}

/** 来源是否被策略接受：空来源永远不可信；放开后非空来源都可信。 */
export function sourceTrusted(source: string, policy: AdmissionPolicy): boolean {
  const value = source.trim()
  if (!value) return false
  if (policy.allowAnySource) return true
  return policy.trustedSources.some((prefix) => prefix.length > 0 && value.startsWith(prefix))
}

/** 承诺冲突的合并结果：未解除数量、可读摘要与每条解除依据被拒的原因。 */
function commitmentFactsOf(input: {
  readonly requirementVersion: number
  readonly owner: string
  readonly previousConflicts?: readonly CommitmentConflict[] | undefined
  readonly commitmentResolutions?: readonly CommitmentResolution[] | undefined
  readonly customerDecisions?: readonly CustomerDecision[] | undefined
  readonly analysisConflicts?: readonly CommitmentConflict[] | undefined
}): {
  conflicts: number
  conflictSummaries: string[]
  conflictReasons: string[]
} {
  const previousConflicts = input.previousConflicts ?? []
  const analysisConflicts = input.analysisConflicts ?? []
  const resolutions = input.commitmentResolutions ?? []
  const decisions = input.customerDecisions ?? []
  const check = {
    requirementVersion: input.requirementVersion,
    conflicts: [...previousConflicts, ...analysisConflicts],
    decisions,
    owner: input.owner,
  }
  const unresolved = unresolvedCommitments({
    ...check,
    previousConflicts,
    analysisConflicts,
    resolutions,
  })
  const reasons = resolutionRejections({ ...check, resolutions })
  // 没有任何解除依据的冲突也要给出可执行理由，而不是只报数量。
  for (const conflict of unresolved) {
    if (resolutions.some((resolution) => resolution.existingReqId === conflict.existingReqId)) {
      continue
    }
    reasons.push(
      `承诺 ${conflict.existingReqId} 没有引用已记录的客户决定（需要所有者做出修订、替代或拒绝）`,
    )
  }
  return {
    conflicts: unresolved.length,
    conflictSummaries: unresolved.map(
      (conflict) =>
        `${conflict.existingReqId}：${conflict.conflict}（取舍：${conflict.options.join(' / ')}）`,
    ),
    conflictReasons: reasons,
  }
}

/** 从需求与分析记录组装准入事实；冲突摘要与结构同源，避免展示与判定口径不一致。 */
export function buildAdmissionFacts(input: {
  requirementStatus: string
  requirementVersion: number
  project: string
  projectPath: string
  source: string
  submittedBy: string
  owner: string
  analysis: {
    analysisVersion: number
    requirementVersion: number
    clarifications: readonly string[]
    conflicts?: readonly CommitmentConflict[] | undefined
  } | null
  /** 上一轮已记录、仍待解除的承诺冲突。 */
  previousConflicts?: readonly CommitmentConflict[] | undefined
  /** 客户对冲突的解除依据；必须引用当前需求版本的客户决定。 */
  commitmentResolutions?: readonly CommitmentResolution[] | undefined
  /** 已记录的客户决定；按需求/版本/承诺三维回查。 */
  customerDecisions?: readonly CustomerDecision[] | undefined
}): AdmissionFacts {
  const analysis = input.analysis
  const commitment = commitmentFactsOf({
    requirementVersion: input.requirementVersion,
    owner: input.owner,
    previousConflicts: input.previousConflicts,
    commitmentResolutions: input.commitmentResolutions,
    customerDecisions: input.customerDecisions,
    analysisConflicts: analysis?.conflicts,
  })
  return {
    requirementStatus: input.requirementStatus,
    requirementVersion: input.requirementVersion,
    project: input.project,
    projectPath: input.projectPath,
    source: input.source,
    submittedBy: input.submittedBy,
    owner: input.owner,
    analysisVersion: analysis?.analysisVersion ?? null,
    analysisRequirementVersion: analysis?.requirementVersion ?? null,
    clarifications: analysis?.clarifications.length ?? 0,
    // 本轮新报冲突与上一轮已知冲突合并；只有带有效客户决定的解除才会放行。
    conflicts: commitment.conflicts,
    conflictSummaries: commitment.conflictSummaries,
    conflictReasons: commitment.conflictReasons,
  }
}

export function decideAdmission(facts: AdmissionFacts, policy: AdmissionPolicy): AdmissionDecision {
  const trustedSource = sourceTrusted(facts.source, policy)
  const basis: AdmissionBasis = {
    policyVersion: ADMISSION_POLICY_VERSION,
    source: facts.source,
    submittedBy: facts.submittedBy,
    owner: facts.owner,
    project: facts.project,
    projectPath: facts.projectPath,
    requirementVersion: facts.requirementVersion,
    analysisVersion: facts.analysisVersion,
    trustedSource,
    allowAnySource: policy.allowAnySource,
    requireOwner: policy.requireOwner,
    codeCommitAllowed: codeCommitAllowed(policy, trustedSource),
  }
  const block = (code: string, reason: string): AdmissionDecision => ({
    admit: false,
    code,
    reason,
    basis,
  })
  /** 与已有承诺冲突时暂停准入：理由必须列出具体取舍，不能只给数量。 */
  const conflictBlock = (): AdmissionDecision | null => {
    const count = facts.conflicts ?? 0
    if (count === 0) return null
    const summaries = facts.conflictSummaries ?? []
    const detail = summaries.length > 0 ? `：${summaries.join('；')}` : ''
    const reasons = facts.conflictReasons ?? []
    const rejection = reasons.length > 0 ? `；解除依据未通过：${reasons.join('；')}` : ''
    return block(
      'commitment_conflict',
      `与已有承诺冲突 ${count} 处，需要所有者决定取舍${detail}${rejection}`,
    )
  }

  if (TERMINAL.has(facts.requirementStatus)) {
    return block('terminal', `需求已处于终态 ${facts.requirementStatus}`)
  }
  if (!policy.enabled) return block('autonomy_disabled', '系统准入未启用；需要所有者显式授权')
  if (!facts.project.trim() || !facts.projectPath.trim()) {
    return block('project_missing', '项目或项目路径未配置；不能确定执行边界')
  }
  if (!trustedSource) {
    return block(
      'untrusted_source',
      facts.source.trim()
        ? `需求来源 ${facts.source} 不在可信入口内；不能由系统准入`
        : '需求来源为空；不能由系统准入',
    )
  }
  if (policy.requireOwner && facts.submittedBy !== facts.owner) {
    return block(
      'owner_mismatch',
      `需求提交者 ${facts.submittedBy || '（空）'} 与配置所有者不一致；不能由系统准入`,
    )
  }
  if (facts.analysisVersion === null) {
    return block('analysis_required', '尚无与当前需求版本对应的需求说明；不能进入研发')
  }
  if (facts.analysisRequirementVersion !== facts.requirementVersion) {
    return block(
      'analysis_stale',
      `需求说明依据版本 v${facts.analysisRequirementVersion ?? '?'}，当前是 v${facts.requirementVersion}；需要由产品 Agent 重新澄清`,
    )
  }
  const conflict = conflictBlock()
  if (conflict) return conflict
  if (facts.clarifications > 0) {
    return block('clarification_required', `仍有 ${facts.clarifications} 条业务歧义需要澄清`)
  }
  return {
    admit: true,
    code: 'admitted',
    reason: admittedReason(basis.codeCommitAllowed),
    basis,
  }
}
